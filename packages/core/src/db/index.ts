import Database from 'better-sqlite3';
import { DB_PATH, ensureDirs } from '../paths.js';

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_dir TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    harness TEXT,
    title TEXT NOT NULL,
    cwd TEXT,
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    w REAL NOT NULL DEFAULT 520,
    h REAL NOT NULL DEFAULT 340,
    state TEXT NOT NULL DEFAULT 'idle',
    session_ref TEXT,
    yolo INTEGER NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL DEFAULT '{}',
    summary TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX nodes_ws ON nodes(workspace_id);
  CREATE TABLE edges (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    from_node TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    to_node TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'link'
  );
  CREATE INDEX edges_ws ON edges(workspace_id);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    from_node TEXT NOT NULL,
    to_node TEXT NOT NULL,
    intent TEXT NOT NULL CHECK (intent IN ('notify','request','response')),
    response_to TEXT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    expires_at INTEGER
  );
  CREATE INDEX messages_to ON messages(to_node, delivered_at);
  CREATE INDEX messages_resp ON messages(response_to);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','done')),
    owner_node TEXT,
    created_by TEXT,
    depends_on_json TEXT NOT NULL DEFAULT '[]',
    result TEXT,
    position REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tasks_ws ON tasks(workspace_id);
  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    text TEXT NOT NULL,
    answer TEXT,
    created_at INTEGER NOT NULL,
    answered_at INTEGER
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_json TEXT,
    cwd TEXT NOT NULL,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE run_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    step_key TEXT NOT NULL,
    agent_node TEXT,
    harness TEXT NOT NULL,
    role TEXT NOT NULL,
    instruction TEXT NOT NULL,
    depends_on_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    output TEXT,
    evidence_json TEXT,
    log_json TEXT NOT NULL DEFAULT '[]',
    round INTEGER NOT NULL DEFAULT 0,
    session_ref TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // F9: per-turn usage (cost/tokens) so node cards and run results can show what a turn spent.
  `
  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    harness TEXT NOT NULL,
    node_id TEXT,
    run_id TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX usage_node ON usage (node_id);
  CREATE INDEX usage_run ON usage (run_id);
  `,
  // F9: which run step a turn belonged to, so step rows can show their own usage.
  `ALTER TABLE usage ADD COLUMN step_id TEXT;`,
  // API-key chat harnesses: their APIs are stateless, so each session's prior turns live here (capped in harness/api.ts).
  `CREATE TABLE api_history (
    session_ref TEXT PRIMARY KEY,
    messages_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
];

export function openDb(path: string = DB_PATH): Db {
  if (path !== ':memory:') ensureDirs();
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  return db;
}

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}
