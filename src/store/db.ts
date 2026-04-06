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
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
