import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const LANES = [
  { id: 'backlog', name: 'Backlog' },
  { id: 'todo', name: 'To Do' },
  { id: 'in_progress', name: 'In Progress' },
  { id: 'review', name: 'Review' },
  { id: 'done', name: 'Done' },
];
export const LANE_IDS = LANES.map((l) => l.id);

export const SEED_PROJECTS = [
  { slug: 'doggl', name: 'Doggl' },
  { slug: 's2ok-website', name: 'S2OK Website' },
  { slug: 'coverup', name: 'CoverUp' },
];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  github_repo TEXT,
  local_path TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  lane TEXT NOT NULL DEFAULT 'backlog',
  position REAL NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'normal',
  assignee TEXT,
  branch TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS tasks_project_lane ON tasks(project_id, lane, position);

CREATE TABLE IF NOT EXISTS task_links (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- 'pr' | 'issue' | 'url'
  url TEXT NOT NULL,
  repo TEXT,                     -- owner/name
  number INTEGER,
  title TEXT,
  state TEXT,                    -- open | closed | merged | draft (from GitHub, if token set)
  state_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(task_id, url)
);

CREATE TABLE IF NOT EXISTS worklog (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT NOT NULL,          -- username or 'claude'
  kind TEXT NOT NULL DEFAULT 'note', -- note | status | claude
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS worklog_task ON worklog(task_id, created_at);
`;

let db;

export function openDb(file = path.join(config.dataDir, 'kanban.sqlite')) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    db = new DatabaseSync(file);
  } catch (e) {
    throw new Error(
      `Cannot open database ${file}: ${e.message}. The process runs as uid ${process.getuid?.()} ` +
        `and needs write access to ${path.dirname(file)} (in Docker: set PUID/PGID to the owner of the mounted data folder).`,
      { cause: e },
    );
  }
  db.exec(SCHEMA);
  seed(db);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not opened');
  return db;
}

/** Test helper: close and drop the cached handle. */
export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}

function seed(d) {
  const insert = d.prepare('INSERT OR IGNORE INTO projects (slug, name) VALUES (?, ?)');
  for (const p of SEED_PROJECTS) insert.run(p.slug, p.name);
}

export function now() {
  return new Date().toISOString();
}
