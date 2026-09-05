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
    conductor_workspace_name TEXT,
    conductor_workspace_id TEXT,
    conductor_backend_kind TEXT
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

  CREATE TABLE IF NOT EXISTS thread_cursors (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    session_id TEXT NOT NULL,
    backend_kind TEXT NOT NULL DEFAULT 'local',
    last_forwarded_rowid INTEGER NOT NULL DEFAULT 0,
    last_message_id TEXT,
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
    head_sha TEXT,
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

  CREATE TABLE IF NOT EXISTS merge_intents (
    intent_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_merge_intents_workspace_created
    ON merge_intents(workspace_id, created_at DESC);

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

  CREATE TABLE IF NOT EXISTS lane_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lane_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_lane_actions_lane_created
    ON lane_actions(lane_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS lane_delivery_state (
    lane_id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lane_session_health (
    session_id TEXT PRIMARY KEY,
    lane_id TEXT NOT NULL,
    role TEXT NOT NULL,
    last_assistant_at TEXT,
    unanswered_nudges INTEGER NOT NULL DEFAULT 0,
    last_nudge_at TEXT,
    rate_limit_until TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_lane_session_health_lane
    ON lane_session_health(lane_id, role);

  CREATE TABLE IF NOT EXISTS lane_provider_outages (
    provider TEXT PRIMARY KEY,
    unavailable_until TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

let _db: Database.Database | null = null;

const WAL_SWITCH_ATTEMPTS = 10;
const WAL_SWITCH_RETRY_MS = 250;

export interface WalRetryOptions {
  attempts?: number;
  retryMs?: number;
}

/**
 * Switching to WAL needs a moment with no other connection mid-write, which
 * busy_timeout does not fully cover: with several processes opening the same
 * database at once (bot, MCP server, doctor, tests) the pragma can throw
 * SQLITE_BUSY outright. The journal mode is a persistent property of the
 * database file, so once any one process succeeds every later open is a
 * no-op — retry briefly and accept an already-switched file before giving up
 * as loudly as before.
 *
 * @internal exported for WAL-retry unit tests; not part of the public store API.
 */
export function enableWalWithRetry(
  db: Database.Database,
  options: WalRetryOptions = {}
): void {
  const attempts = options.attempts ?? WAL_SWITCH_ATTEMPTS;
  const retryMs = options.retryMs ?? WAL_SWITCH_RETRY_MS;
  // With the connection's normal busy_timeout, each failed switch attempt can
  // also block inside SQLite for seconds, compounding across retries into
  // tens of seconds of synchronous stall. The loop supplies its own pacing,
  // so use a minimal in-SQLite wait during the switch and restore the
  // caller's timeout afterwards.
  const previousBusyTimeout = Number(
    db.pragma("busy_timeout", { simple: true })
  );
  db.pragma(`busy_timeout = ${Math.min(previousBusyTimeout || 250, 250)}`);
  try {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        db.pragma("journal_mode = WAL");
        return;
      } catch (error) {
        lastError = error;
        let mode: unknown = null;
        try {
          mode = db.pragma("journal_mode", { simple: true });
        } catch {
          // Reading the mode can hit the same contention; keep retrying.
        }
        if (mode === "wal") return;
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          retryMs
        );
      }
    }
    throw lastError;
  } finally {
    db.pragma(`busy_timeout = ${previousBusyTimeout}`);
  }
}

export function getDb(dbPath?: string): Database.Database {
  if (_db) return _db;

  const defaultPath = `${process.env.HOME}/.conductor-telegram/conductor-telegram.db`;
  const resolvedPath = dbPath ?? process.env.DB_PATH ?? defaultPath;

  // Ensure parent directory exists
  mkdirSync(path.dirname(resolvedPath), { recursive: true });

  _db = new Database(resolvedPath);

  // WAL mode for concurrent writes from multiple MCP server instances
  _db.pragma("busy_timeout = 5000");
  enableWalWithRetry(_db);

  try {
    _db.exec("BEGIN IMMEDIATE");
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
    ensureColumn(_db, "workspaces", "conductor_workspace_id", "TEXT");
    ensureColumn(_db, "workspaces", "conductor_backend_kind", "TEXT");
    ensureColumn(_db, "telegram_message_links", "session_id", "TEXT");
    ensureColumn(_db, "thread_cursors", "last_message_id", "TEXT");
    ensureColumn(
      _db,
      "thread_cursors",
      "backend_kind",
      "TEXT NOT NULL DEFAULT 'local'"
    );
    // Relabelling a cursor also changes which namespace its position lives in:
    // a local cursor holds a session_messages rowid, a cloud one holds an API
    // message id. Carrying the old rowid across would leave a cloud cursor
    // permanently ahead of every API id it is later compared against, so reset
    // to the unbaselined state and let ensureThreadCursor re-anchor it. The
    // backend_kind predicate also keeps this one-shot per row.
    _db.exec(`
      UPDATE thread_cursors
      SET backend_kind = 'cloud-api',
          last_forwarded_rowid = 0,
          last_message_id = NULL
      WHERE backend_kind <> 'cloud-api'
        AND workspace_id IN (
          SELECT id
          FROM workspaces
          WHERE conductor_backend_kind = 'cloud-api'
        );
    `);
    ensureColumn(_db, "pr_records", "head_sha", "TEXT");
    _db.exec(`
      CREATE INDEX IF NOT EXISTS idx_telegram_message_links_session
        ON telegram_message_links(session_id, created_at);
    `);
    _db.exec("COMMIT");
  } catch (error) {
    if (_db.inTransaction) {
      _db.exec("ROLLBACK");
    }
    _db.close();
    _db = null;
    throw error;
  }
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
