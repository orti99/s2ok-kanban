// Domain operations shared by the REST API and the MCP server.
import { getDb, now, LANE_IDS } from './db.js';

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const CLAUDE = 'claude';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

// ---------- Projects ----------

export function listProjects({ includeArchived = false } = {}) {
  const sql = includeArchived
    ? 'SELECT * FROM projects ORDER BY name'
    : 'SELECT * FROM projects WHERE archived = 0 ORDER BY name';
  return getDb().prepare(sql).all().map(rowProject);
}

export function getProject(idOrSlug) {
  const db = getDb();
  const row = /^\d+$/.test(String(idOrSlug))
    ? db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(idOrSlug))
    : db.prepare('SELECT * FROM projects WHERE slug = ?').get(String(idOrSlug));
  if (!row) throw new HttpError(404, `Project not found: ${idOrSlug}`);
  return rowProject(row);
}

export function createProject({ name, slug, description, github_repo, local_path }) {
  if (!name || !name.trim()) throw new HttpError(400, 'name is required');
  slug = slug ? slugify(slug) : slugify(name);
  if (!slug) throw new HttpError(400, 'could not derive slug');
  validateRepo(github_repo);
  try {
    const info = getDb()
      .prepare(
        'INSERT INTO projects (slug, name, description, github_repo, local_path) VALUES (?, ?, ?, ?, ?)',
      )
      .run(slug, name.trim(), description ?? '', github_repo || null, local_path || null);
    return getProject(info.lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, `Project slug already exists: ${slug}`);
    throw e;
  }
}

export function updateProject(idOrSlug, patch) {
  const p = getProject(idOrSlug);
  const next = { ...p, ...pick(patch, ['name', 'description', 'github_repo', 'local_path', 'archived']) };
  validateRepo(next.github_repo);
  getDb()
    .prepare(
      'UPDATE projects SET name = ?, description = ?, github_repo = ?, local_path = ?, archived = ? WHERE id = ?',
    )
    .run(next.name, next.description ?? '', next.github_repo || null, next.local_path || null, next.archived ? 1 : 0, p.id);
  return getProject(p.id);
}

function validateRepo(repo) {
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new HttpError(400, 'github_repo must look like owner/name');
}

function rowProject(r) {
  return { ...r, archived: !!r.archived };
}

// ---------- Tasks ----------

export function listTasks({ project, lane, assignee, includeDone = true } = {}) {
  const where = [];
  const args = [];
  if (project !== undefined && project !== null && project !== '') {
    where.push('t.project_id = ?');
    args.push(getProject(project).id);
  }
  if (lane) {
    where.push('t.lane = ?');
    args.push(lane);
  }
  if (assignee) {
    where.push('t.assignee = ?');
    args.push(assignee);
  }
  if (!includeDone) where.push("t.lane != 'done'");
  const sql = `SELECT t.*, p.slug AS project_slug, p.name AS project_name,
      (SELECT COUNT(*) FROM task_links l WHERE l.task_id = t.id) AS link_count,
      (SELECT COUNT(*) FROM worklog w WHERE w.task_id = t.id) AS worklog_count
    FROM tasks t JOIN projects p ON p.id = t.project_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.lane, t.position, t.id`;
  const rows = getDb().prepare(sql).all(...args);
  const links = linksForTasks(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, links: links.get(r.id) ?? [] }));
}

export function getTask(id) {
  const row = getDb()
    .prepare(
      `SELECT t.*, p.slug AS project_slug, p.name AS project_name, p.github_repo, p.local_path
       FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`,
    )
    .get(Number(id));
  if (!row) throw new HttpError(404, `Task not found: ${id}`);
  return {
    ...row,
    links: linksForTasks([row.id]).get(row.id) ?? [],
    worklog: getDb().prepare('SELECT * FROM worklog WHERE task_id = ? ORDER BY created_at, id').all(row.id),
  };
}

export function createTask({ project, title, description, lane, priority, assignee, branch }, user) {
  if (!title || !title.trim()) throw new HttpError(400, 'title is required');
  const p = getProject(project);
  lane = lane || 'backlog';
  assertLane(lane);
  priority = priority || 'normal';
  assertPriority(priority);
  const db = getDb();
  const pos = nextPosition(p.id, lane);
  const info = db
    .prepare(
      `INSERT INTO tasks (project_id, title, description, lane, position, priority, assignee, branch, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(p.id, title.trim(), description ?? '', lane, pos, priority, assignee || null, branch || null, user?.id ?? null);
  return getTask(info.lastInsertRowid);
}

export function updateTask(id, patch, user) {
  const t = getTask(id);
  const fields = pick(patch, ['title', 'description', 'priority', 'assignee', 'branch', 'project']);
  const next = { ...t, ...fields };
  if (!next.title || !String(next.title).trim()) throw new HttpError(400, 'title cannot be empty');
  assertPriority(next.priority);
  let projectId = t.project_id;
  if (fields.project !== undefined) projectId = getProject(fields.project).id;
  getDb()
    .prepare(
      `UPDATE tasks SET title = ?, description = ?, priority = ?, assignee = ?, branch = ?, project_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      String(next.title).trim(),
      next.description ?? '',
      next.priority,
      next.assignee || null,
      next.branch || null,
      projectId,
      now(),
      t.id,
    );
  if (fields.assignee !== undefined && fields.assignee !== t.assignee) {
    addWorklog(t.id, { author: user?.username ?? 'system', kind: 'status', body: `Assigned to ${fields.assignee || 'nobody'}` });
  }
  return getTask(t.id);
}

/**
 * Move a task to a lane and position. `before`/`after` are task ids within the target lane
 * used to compute a fractional position; omitting both appends to the end.
 */
export function moveTask(id, { lane, before, after }, user) {
  const t = getTask(id);
  lane = lane || t.lane;
  assertLane(lane);
  const db = getDb();
  let position;
  const posOf = (tid) => {
    const r = db.prepare('SELECT position, lane FROM tasks WHERE id = ?').get(Number(tid));
    if (!r || r.lane !== lane) throw new HttpError(400, 'before/after must reference a task in the target lane');
    return r.position;
  };
  if (before === undefined && after === undefined) position = nextPosition(t.project_id, lane);
  else if (before !== undefined && after !== undefined) position = (posOf(after) + posOf(before)) / 2;
  else if (before !== undefined) position = posOf(before) - 1;
  else position = posOf(after) + 1;

  const completed = lane === 'done' ? now() : null;
  db.prepare('UPDATE tasks SET lane = ?, position = ?, updated_at = ?, completed_at = ? WHERE id = ?').run(
    lane,
    position,
    now(),
    completed,
    t.id,
  );
  if (lane !== t.lane) {
    addWorklog(t.id, { author: user?.username ?? 'system', kind: 'status', body: `Moved ${t.lane} → ${lane}` });
  }
  return getTask(t.id);
}

export function deleteTask(id) {
  const res = getDb().prepare('DELETE FROM tasks WHERE id = ?').run(Number(id));
  if (!res.changes) throw new HttpError(404, `Task not found: ${id}`);
}

function nextPosition(projectId, lane) {
  const r = getDb()
    .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE project_id = ? AND lane = ?')
    .get(projectId, lane);
  return r.p;
}

function assertLane(lane) {
  if (!LANE_IDS.includes(lane)) throw new HttpError(400, `lane must be one of ${LANE_IDS.join(', ')}`);
}
function assertPriority(p) {
  if (!PRIORITIES.includes(p)) throw new HttpError(400, `priority must be one of ${PRIORITIES.join(', ')}`);
}

// ---------- Links (PRs, issues, URLs) ----------

const GH_RE = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/i;

/** Accepts a full GitHub URL, or "#123" / "123" / "owner/repo#123" when the task's project has a github_repo. */
export function parseLink(input, projectRepo) {
  const s = String(input ?? '').trim();
  let m = s.match(GH_RE);
  if (m) {
    const kind = m[3] === 'pull' ? 'pr' : 'issue';
    return { kind, url: `https://github.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`, repo: `${m[1]}/${m[2]}`, number: Number(m[4]) };
  }
  m = s.match(/^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/);
  if (m) {
    const repo = m[1] || projectRepo;
    if (!repo) throw new HttpError(400, 'Project has no github_repo configured; use a full URL');
    // Kind unknown from a bare number: GitHub serves /issues/N for PRs too, and we resolve the kind later.
    return { kind: 'issue', url: `https://github.com/${repo}/issues/${m[2]}`, repo, number: Number(m[2]), unresolved: true };
  }
  if (/^https?:\/\//i.test(s)) return { kind: 'url', url: s, repo: null, number: null };
  throw new HttpError(400, 'Link must be a URL, "#123", or "owner/repo#123"');
}

export function addLink(taskId, { url, kind, title }, user) {
  const t = getTask(taskId);
  const parsed = parseLink(url, t.github_repo);
  if (kind && ['pr', 'issue', 'url'].includes(kind)) parsed.kind = kind;
  if (parsed.kind === 'pr' && parsed.unresolved) parsed.url = parsed.url.replace('/issues/', '/pull/');
  const db = getDb();
  try {
    db.prepare('INSERT INTO task_links (task_id, kind, url, repo, number, title) VALUES (?, ?, ?, ?, ?, ?)').run(
      t.id,
      parsed.kind,
      parsed.url,
      parsed.repo,
      parsed.number,
      title || null,
    );
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Link already attached');
    throw e;
  }
  addWorklog(t.id, {
    author: user?.username ?? 'system',
    kind: 'status',
    body: `Linked ${parsed.kind === 'pr' ? 'PR' : parsed.kind === 'issue' ? 'issue' : 'URL'} ${parsed.number ? '#' + parsed.number : parsed.url}`,
  });
  return getTask(t.id);
}

export function removeLink(taskId, linkId) {
  const res = getDb().prepare('DELETE FROM task_links WHERE task_id = ? AND id = ?').run(Number(taskId), Number(linkId));
  if (!res.changes) throw new HttpError(404, 'Link not found');
}

export function updateLinkState(linkId, { kind, title, state }) {
  getDb()
    .prepare('UPDATE task_links SET kind = COALESCE(?, kind), title = COALESCE(?, title), state = ?, state_checked_at = ? WHERE id = ?')
    .run(kind ?? null, title ?? null, state ?? null, now(), linkId);
}

export function listGithubLinks({ staleMinutes = 0 } = {}) {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  return getDb()
    .prepare(
      `SELECT l.* FROM task_links l JOIN tasks t ON t.id = l.task_id
       WHERE l.repo IS NOT NULL AND (l.state_checked_at IS NULL OR l.state_checked_at < ?)
       ORDER BY l.state_checked_at NULLS FIRST LIMIT 50`,
    )
    .all(cutoff);
}

function linksForTasks(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = getDb()
    .prepare(`SELECT * FROM task_links WHERE task_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
    .all(...ids);
  for (const r of rows) {
    if (!map.has(r.task_id)) map.set(r.task_id, []);
    map.get(r.task_id).push(r);
  }
  return map;
}

// ---------- Worklog ----------

export function addWorklog(taskId, { author, kind = 'note', body }) {
  if (!body || !String(body).trim()) throw new HttpError(400, 'body is required');
  getDb()
    .prepare('INSERT INTO worklog (task_id, author, kind, body) VALUES (?, ?, ?, ?)')
    .run(Number(taskId), author, kind, String(body).trim());
  getDb().prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), Number(taskId));
}

// ---------- Claude workflow helpers ----------

/** Hand a task to Claude: assignee=claude, lane at least 'todo'. */
export function assignToClaude(taskId, user) {
  const t = getTask(taskId);
  updateTask(t.id, { assignee: CLAUDE }, user);
  if (t.lane === 'backlog') moveTask(t.id, { lane: 'todo' }, user);
  return getTask(t.id);
}

/** Claude picks up a task: moves it to in_progress and records who/when. */
export function claimTask(taskId, user, note) {
  const t = getTask(taskId);
  if (t.assignee !== CLAUDE) updateTask(t.id, { assignee: CLAUDE }, user);
  if (t.lane !== 'in_progress') moveTask(t.id, { lane: 'in_progress' }, user);
  addWorklog(t.id, { author: CLAUDE, kind: 'claude', body: note || `Started working on this task (via ${user?.username ?? 'mcp'})` });
  return getTask(t.id);
}

/** Claude reports back: documents the result, optionally links a PR, and moves the task to review. */
export function completeTask(taskId, { summary, pr_url, branch, lane = 'review' }, user) {
  const t = getTask(taskId);
  if (!summary || !summary.trim()) throw new HttpError(400, 'summary is required');
  addWorklog(t.id, { author: CLAUDE, kind: 'claude', body: summary.trim() });
  if (branch) updateTask(t.id, { branch }, user);
  if (pr_url) {
    try {
      addLink(t.id, { url: pr_url, kind: 'pr' }, user);
    } catch (e) {
      if (e.status !== 409) throw e;
    }
  }
  assertLane(lane);
  if (t.lane !== lane) moveTask(t.id, { lane }, user);
  return getTask(t.id);
}

/** Tasks waiting for Claude in a project (or all projects): assignee=claude, lane todo/in_progress. */
export function claudeQueue(project) {
  return listTasks({ project, assignee: CLAUDE }).filter((t) => ['todo', 'in_progress'].includes(t.lane));
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}
