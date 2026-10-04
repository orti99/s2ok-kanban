import { Router } from 'express';
import { LANES } from './db.js';
import * as auth from './auth.js';
import * as store from './store.js';
import { refreshGithubLinks } from './github.js';

export const api = Router();

api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ---- Auth ----

api.post('/login', auth.loginRateLimit, (req, res) => {
  const { username, password } = req.body ?? {};
  const user = auth.authenticate(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const s = auth.createSession(user.id);
  res.set('Set-Cookie', auth.sessionCookie(s.id, s.expires));
  res.json({ user });
});

api.post('/logout', (req, res) => {
  auth.destroySession(req.sessionId);
  res.set('Set-Cookie', auth.clearedSessionCookie());
  res.json({ ok: true });
});

api.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: req.user, lanes: LANES, priorities: store.PRIORITIES });
});

// Everything below requires a user (cookie session or Bearer token).
api.use(auth.requireUser);

// ---- Account / user management ----

api.post('/me/password', (req, res) => {
  if (req.user.via === 'token') return res.status(403).json({ error: 'Change passwords from the browser session' });
  const { current, password } = req.body ?? {};
  if (!auth.authenticate(req.user.username, current)) return res.status(400).json({ error: 'Current password is wrong' });
  try {
    auth.setPassword(req.user.id, password);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  // setPassword logs out every session, including this one: issue a fresh one.
  const s = auth.createSession(req.user.id);
  res.set('Set-Cookie', auth.sessionCookie(s.id, s.expires));
  res.json({ ok: true });
});

api.get('/users', auth.requireAdmin, (req, res) => res.json({ users: auth.listUsers() }));
api.post('/users', auth.requireAdmin, (req, res) => {
  const { username, display_name, is_admin } = req.body ?? {};
  const password = auth.generatePassword();
  try {
    const user = auth.createUser({ username, password, displayName: display_name, isAdmin: !!is_admin });
    res.status(201).json({ user, password, users: auth.listUsers() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
api.post('/users/:id/reset-password', auth.requireAdmin, (req, res) => {
  const user = auth.getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = auth.generatePassword();
  auth.setPassword(user.id, password);
  res.json({ user, password });
});
api.delete('/users/:id', auth.requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  auth.deleteUser(id);
  res.json({ users: auth.listUsers() });
});

api.get('/tokens', (req, res) => res.json({ tokens: auth.listApiTokens(req.user.id) }));
api.post('/tokens', (req, res) => {
  if (req.user.via === 'token') return res.status(403).json({ error: 'Create tokens from the browser session' });
  const token = auth.createApiToken(req.user.id, req.body?.name);
  res.status(201).json({ token, tokens: auth.listApiTokens(req.user.id) });
});
api.delete('/tokens/:id', (req, res) => {
  auth.deleteApiToken(req.user.id, Number(req.params.id));
  res.json({ tokens: auth.listApiTokens(req.user.id) });
});

// ---- Projects ----

api.get('/projects', (req, res) => res.json({ projects: store.listProjects({ includeArchived: req.query.all === '1' }) }));
api.post('/projects', (req, res) => res.status(201).json({ project: store.createProject(req.body ?? {}) }));
api.get('/projects/:id', (req, res) => res.json({ project: store.getProject(req.params.id) }));
api.patch('/projects/:id', (req, res) => res.json({ project: store.updateProject(req.params.id, req.body ?? {}) }));

// ---- Tasks ----

api.get('/tasks', (req, res) => {
  const { project, lane, assignee } = req.query;
  res.json({ tasks: store.listTasks({ project, lane, assignee }) });
});
api.post('/tasks', (req, res) => res.status(201).json({ task: store.createTask(req.body ?? {}, req.user) }));
api.get('/tasks/:id', (req, res) => res.json({ task: store.getTask(req.params.id) }));
api.patch('/tasks/:id', (req, res) => res.json({ task: store.updateTask(req.params.id, req.body ?? {}, req.user) }));
api.delete('/tasks/:id', (req, res) => {
  store.deleteTask(req.params.id);
  res.status(204).end();
});
api.post('/tasks/:id/move', (req, res) => res.json({ task: store.moveTask(req.params.id, req.body ?? {}, req.user) }));
api.post('/tasks/:id/assign-claude', (req, res) => res.json({ task: store.assignToClaude(req.params.id, req.user) }));

api.post('/tasks/:id/links', (req, res) => res.status(201).json({ task: store.addLink(req.params.id, req.body ?? {}, req.user) }));
api.delete('/tasks/:id/links/:linkId', (req, res) => {
  store.removeLink(req.params.id, req.params.linkId);
  res.json({ task: store.getTask(req.params.id) });
});

api.post('/tasks/:id/worklog', (req, res) => {
  store.addWorklog(req.params.id, { author: req.user.username, kind: 'note', body: req.body?.body });
  res.status(201).json({ task: store.getTask(req.params.id) });
});

// ---- GitHub state refresh (on demand; the UI calls it when a board loads) ----
api.post('/github/refresh', async (req, res) => {
  const refreshed = await refreshGithubLinks({ staleMinutes: req.body?.force ? 0 : 10 });
  res.json({ refreshed });
});

// ---- Error handler ----
// eslint-disable-next-line no-unused-vars
api.use((err, req, res, _next) => {
  const status = err.status ?? (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message ?? 'Internal error' });
});
