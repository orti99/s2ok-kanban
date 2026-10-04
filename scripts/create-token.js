// Usage: npm run token:create -- <username> [token name]
import { openDb, getDb } from '../src/db.js';
import { createApiToken } from '../src/auth.js';

const [username, name = 'claude'] = process.argv.slice(2);
if (!username) {
  console.error('Usage: npm run token:create -- <username> [token name]');
  process.exit(1);
}
openDb();
const user = getDb().prepare('SELECT id FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`No such user: ${username}`);
  process.exit(1);
}
const token = createApiToken(user.id, name);
console.log(`API token for ${username} (${name}) — shown once, store it safely:\n\n  ${token}\n`);
