import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'starting',
    repo_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    telegram_chat_id TEXT NOT NULL,
    telegram_message_id TEXT,
    conductor_workspace_name TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_workspace
    ON events(workspace_id, id);

  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    question TEXT NOT NULL,
    options TEXT,
    answer TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    answered_at TEXT
  );

  CREATE TABLE IF NOT EXISTS telegram_message_links (
    chat_id TEXT NOT NULL,
    telegram_message_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, telegram_message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_telegram_message_links_workspace
    ON telegram_message_links(workspace_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_telegram_message_links_session
    ON telegram_message_links(session_id, created_at);

  CREATE TABLE IF NOT EXISTS thread_cursors (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    session_id TEXT NOT NULL,
    last_forwarded_rowid INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_id, session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_thread_cursors_workspace
    ON thread_cursors(workspace_id, updated_at);

  CREATE TABLE IF NOT EXISTS bot_heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pid INTEGER NOT NULL,
    version TEXT,
    started_at TEXT NOT NULL,
    last_beat_at TEXT NOT NULL,
    last_known_alive_at TEXT,
    boot_count INTEGER NOT NULL DEFAULT 1,
    last_exit_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pr_records (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
    repo_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    pr_number INTEGER,
    pr_url TEXT,
    title TEXT,
    state TEXT NOT NULL DEFAULT 'unknown',
    is_draft INTEGER NOT NULL DEFAULT 0,
    head_ref TEXT,
    base_ref TEXT,
    review_decision TEXT,
    merge_state_status TEXT,
    mergeable TEXT,
    checks_status TEXT NOT NULL DEFAULT 'unknown',
    checks_summary TEXT,
    branch_exists INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pr_records_repo_branch
    ON pr_records(repo_path, branch);

  CREATE TABLE IF NOT EXISTS repo_topics (
    chat_id TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    telegram_thread_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    PRIMARY KEY (chat_id, repo_path),
    UNIQUE (chat_id, telegram_thread_id)
  );

  CREATE INDEX IF NOT EXISTS idx_repo_topics_thread
    ON repo_topics(chat_id, telegram_thread_id);

  CREATE TABLE IF NOT EXISTS route_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    source TEXT NOT NULL,
    telegram_thread_id INTEGER,
    action TEXT,
    repo_path TEXT,
    repo_name TEXT,
    workspace_id TEXT,
    status TEXT NOT NULL,
    failure_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_route_attempts_chat_created
    ON route_attempts(chat_id, created_at);
`;

let _db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (_db) return _db;

  const defaultPath = `${process.env.HOME}/.conductor-telegram/conductor-telegram.db`;
  const resolvedPath = dbPath ?? process.env.DB_PATH ?? defaultPath;

  // Ensure parent directory exists
  mkdirSync(path.dirname(resolvedPath), { recursive: true });

  _db = new Database(resolvedPath);

  // WAL mode for concurrent writes from multiple MCP server instances
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");

  _db.exec(SCHEMA);
  ensureColumn(_db, "workspaces", "conductor_session_id", "TEXT");
  ensureColumn(
    _db,
    "workspaces",
    "last_forwarded_message_rowid",
    "INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(_db, "workspaces", "telegram_thread_id", "INTEGER");
  ensureColumn(_db, "workspaces", "archived_at", "TEXT");
  ensureColumn(_db, "telegram_message_links", "session_id", "TEXT");
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
