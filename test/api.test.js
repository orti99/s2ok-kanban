import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.js';
import { createUser, createApiToken } from '../src/auth.js';
import { createApp } from '../src/server.js';

let server, base, cookie, token;

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookie ?? '', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, data, res };
};

before(async () => {
  openDb(':memory:');
  const u = createUser({ username: 'alice', password: 'password123', displayName: 'Alice' });
  token = createApiToken(u.id, 'test');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  closeDb();
});

test('unauthenticated requests are rejected', async () => {
  assert.equal((await call('GET', '/api/tasks')).status, 401);
  assert.equal((await call('POST', '/mcp', {})).status, 401);
});

test('login with wrong password fails, right password sets a cookie', async () => {
  assert.equal((await call('POST', '/api/login', { username: 'alice', password: 'nope' })).status, 401);
  const r = await call('POST', '/api/login', { username: 'alice', password: 'password123' });
  assert.equal(r.status, 200);
  cookie = r.res.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^kb_session=/);
});

test('seeded projects exist', async () => {
  const r = await call('GET', '/api/projects');
  assert.deepEqual(r.data.projects.map((p) => p.slug).sort(), ['coverup', 'doggl', 's2ok-website']);
});

test('task lifecycle: create, move, link, worklog', async () => {
  await call('PATCH', '/api/projects/doggl', { github_repo: 'orti99/doggl', local_path: '/tmp/doggl' });
  const c = await call('POST', '/api/tasks', { project: 'doggl', title: 'Fix it', priority: 'high' });
  assert.equal(c.status, 201);
  const id = c.data.task.id;
  assert.equal(c.data.task.lane, 'backlog');

  const m = await call('POST', `/api/tasks/${id}/move`, { lane: 'in_progress' });
  assert.equal(m.data.task.lane, 'in_progress');
  assert.equal((await call('POST', `/api/tasks/${id}/move`, { lane: 'nope' })).status, 400);

  const l1 = await call('POST', `/api/tasks/${id}/links`, { url: 'https://github.com/orti99/doggl/pull/7' });
  assert.equal(l1.data.task.links[0].kind, 'pr');
  assert.equal(l1.data.task.links[0].number, 7);
  const l2 = await call('POST', `/api/tasks/${id}/links`, { url: '#8' });
  assert.equal(l2.data.task.links[1].url, 'https://github.com/orti99/doggl/issues/8');
  assert.equal((await call('POST', `/api/tasks/${id}/links`, { url: '#8' })).status, 409);

  const w = await call('POST', `/api/tasks/${id}/worklog`, { body: 'looked at it' });
  const notes = w.data.task.worklog.filter((x) => x.kind === 'note');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].author, 'alice');
});

test('ordering: before/after positions', async () => {
  const a = (await call('POST', '/api/tasks', { project: 'coverup', title: 'A', lane: 'todo' })).data.task;
  const b = (await call('POST', '/api/tasks', { project: 'coverup', title: 'B', lane: 'todo' })).data.task;
  await call('POST', `/api/tasks/${b.id}/move`, { lane: 'todo', before: a.id });
  const list = (await call('GET', '/api/tasks?project=coverup&lane=todo')).data.tasks;
  assert.deepEqual(list.map((t) => t.title), ['B', 'A']);
});

test('give to claude, then claude claims and completes via MCP', async () => {
  const t = (await call('POST', '/api/tasks', { project: 'doggl', title: 'Claude job' })).data.task;
  const g = await call('POST', `/api/tasks/${t.id}/assign-claude`);
  assert.equal(g.data.task.assignee, 'claude');
  assert.equal(g.data.task.lane, 'todo');

  const mcp = async (method, params, id = 1) => {
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const txt = await res.text();
    const line = txt.split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse(line.slice(5));
  };
  const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 's2ok-kanban');

  const tools = await mcp('tools/list', {});
  assert.ok(tools.result.tools.map((x) => x.name).includes('complete_task'));

  const queue = JSON.parse((await mcp('tools/call', { name: 'get_claude_queue', arguments: { project: 'doggl' } })).result.content[0].text);
  assert.ok(queue.some((q) => q.id === t.id));

  const claimed = JSON.parse((await mcp('tools/call', { name: 'claim_task', arguments: { id: t.id, note: 'plan' } })).result.content[0].text);
  assert.equal(claimed.lane, 'in_progress');
  assert.equal(claimed.local_path, '/tmp/doggl');

  const done = JSON.parse(
    (await mcp('tools/call', { name: 'complete_task', arguments: { id: t.id, summary: 'Did the thing', pr_url: 'orti99/doggl#9', branch: 'kanban-1' } })).result.content[0].text,
  );
  assert.equal(done.lane, 'review');
  assert.equal(done.branch, 'kanban-1');
  assert.equal(done.links[0].url, 'https://github.com/orti99/doggl/pull/9');
  assert.ok(done.worklog.some((w) => w.author === 'claude' && w.body === 'Did the thing'));

  const bad = await mcp('tools/call', { name: 'get_task', arguments: { id: 99999 } });
  assert.equal(bad.result.isError, true);
});
