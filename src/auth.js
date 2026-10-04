import crypto from 'node:crypto';
import { getDb, now } from './db.js';
import { config } from './config.js';

const SCRYPT_N = 16384;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [algo, nStr, saltB64, keyB64] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  const actual = crypto.scryptSync(password, salt, expected.length, { N: Number(nStr) });
  return crypto.timingSafeEqual(actual, expected);
}

export function createUser({ username, password, displayName }) {
  const db = getDb();
  if (!username || !/^[a-z0-9._-]{2,40}$/i.test(username)) {
    throw new Error('Username must be 2-40 chars: letters, digits, . _ -');
  }
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
  const info = db
    .prepare('INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), displayName || username);
  return getUserById(info.lastInsertRowid);
}

export function getUserById(id) {
  return getDb().prepare('SELECT id, username, display_name, created_at FROM users WHERE id = ?').get(id) ?? null;
}

export function authenticate(username, password) {
  const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username ?? '');
  if (!row) {
    // Burn comparable time so username enumeration via timing is harder.
    verifyPassword(password ?? '', hashPassword('x'.repeat(8)));
    return null;
  }
  if (!verifyPassword(password ?? '', row.password_hash)) return null;
  return getUserById(row.id);
}

// ---- Sessions (cookie) ----

export function createSession(userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionTtlMs).toISOString();
  getDb().prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expires);
  return { id, expires };
}

export function getSessionUser(sessionId) {
  if (!sessionId) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(sessionId);
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }
  return { id: row.id, username: row.username, display_name: row.display_name };
}

export function destroySession(sessionId) {
  if (sessionId) getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

// ---- API tokens (for MCP / scripts) ----

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createApiToken(userId, name) {
  const token = 'kb_' + crypto.randomBytes(24).toString('base64url');
  getDb()
    .prepare('INSERT INTO api_tokens (user_id, name, token_hash) VALUES (?, ?, ?)')
    .run(userId, name || 'token', tokenHash(token));
  return token;
}

export function listApiTokens(userId) {
  return getDb()
    .prepare('SELECT id, name, last_used_at, created_at FROM api_tokens WHERE user_id = ? ORDER BY id')
    .all(userId);
}

export function deleteApiToken(userId, id) {
  return getDb().prepare('DELETE FROM api_tokens WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}

export function getTokenUser(token) {
  if (!token || !token.startsWith('kb_')) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, t.id AS token_id FROM api_tokens t
       JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    )
    .get(tokenHash(token));
  if (!row) return null;
  db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.token_id);
  return { id: row.id, username: row.username, display_name: row.display_name, via: 'token' };
}

// ---- Express helpers ----

export const COOKIE_NAME = 'kb_session';

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(id, expires) {
  const attrs = [
    `${COOKIE_NAME}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expires).toUTCString()}`,
  ];
  if (config.behindProxy) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Populates req.user from the session cookie or a Bearer API token. */
export function attachUser(req, _res, next) {
  const auth = req.get('authorization');
  if (auth && auth.startsWith('Bearer ')) {
    req.user = getTokenUser(auth.slice(7).trim());
  } else {
    const cookies = parseCookies(req.get('cookie'));
    req.sessionId = cookies[COOKIE_NAME];
    req.user = getSessionUser(req.sessionId);
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

// Very small in-memory login rate limiter: 10 attempts per IP per 15 minutes.
const attempts = new Map();
export function loginRateLimit(req, res, next) {
  const key = req.ip;
  const nowMs = Date.now();
  const entry = attempts.get(key) ?? { count: 0, reset: nowMs + 15 * 60 * 1000 };
  if (nowMs > entry.reset) {
    entry.count = 0;
    entry.reset = nowMs + 15 * 60 * 1000;
  }
  entry.count += 1;
  attempts.set(key, entry);
  if (entry.count > 10) return res.status(429).json({ error: 'Too many login attempts, try again later' });
  next();
}
