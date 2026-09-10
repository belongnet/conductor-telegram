import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface QueueRow {
  id: string;
  conversation: string;
  kind: string;
  payload: string;
  state: "pending" | "running" | "done" | "blocked";
  attempts: number;
  available_at: number;
  priority: number;
  result: string | null;
  error: string | null;
  created_at: number;
  completed_at?: number | null;
}

export interface CloudBinding {
  workspaceId: string;
  projectId: string;
  repoUrl: string;
  repoSlug: string;
  branch: string | null;
  prUrl: string | null;
  sessionId: string | null;
  agent: "claude" | "codex" | "cursor";
  model: string;
  effort: string;
  stopped: boolean;
  synced?: boolean;
}

/** Additive gateway state; never replaces the existing workspace/history tables. */
export class GatewayStore {
  assertWriter: (() => void) | undefined;
  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_queue (
        id TEXT PRIMARY KEY, conversation TEXT NOT NULL, kind TEXT NOT NULL,
        payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 10, result TEXT, error TEXT,
        created_at INTEGER NOT NULL, completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS gateway_queue_pending ON gateway_queue(state, available_at, priority, created_at);
      CREATE TABLE IF NOT EXISTS gateway_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gateway_decision_links (
        chat_id TEXT NOT NULL, message_id TEXT NOT NULL, decision_id INTEGER NOT NULL,
        PRIMARY KEY(chat_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS gateway_bindings (workspace_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gateway_credentials (
        token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS gateway_files (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
        path TEXT NOT NULL, size INTEGER NOT NULL, token_hash TEXT, expires_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gateway_file_links (
        token_hash TEXT PRIMARY KEY, file_id TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    const columns = db.prepare("PRAGMA table_info(gateway_queue)").all() as Array<{name: string}>;
    if (!columns.some(c => c.name === "completed_at")) db.exec("ALTER TABLE gateway_queue ADD COLUMN completed_at INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS gateway_queue_completed ON gateway_queue(kind,completed_at)");
  }

  get<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM gateway_state WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }

  set(key: string, value: unknown): void {
    this.assertWriter?.();
    this.db.prepare("INSERT INTO gateway_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, JSON.stringify(value));
  }

  enqueue(kind: string, conversation: string, payload: unknown, id: string = randomUUID(), priority = 10): string {
    this.assertWriter?.();
    this.db.prepare("INSERT OR IGNORE INTO gateway_queue(id,conversation,kind,payload,priority,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, conversation, kind, JSON.stringify(payload), priority, Date.now());
    return id;
  }

  row(id: string): QueueRow | undefined {
    return this.db.prepare("SELECT * FROM gateway_queue WHERE id=?").get(id) as QueueRow | undefined;
  }

  /** Offset and update bytes commit together, before the next getUpdates acknowledges them. */
  ingest(updates: Array<{ update_id: number; [key: string]: unknown }>): void {
    this.db.transaction(() => {
      let offset = this.get<number>("telegram-offset") ?? 0;
      for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
        if (update.update_id < offset) continue;
        const msg = (update.message ?? (update.callback_query as any)?.message) as any;
        const conversation = `${msg?.chat?.id ?? "unknown"}:${msg?.message_thread_id ?? 0}`;
        // A read-only liveness check must not wait for a slow command in its topic.
        const kind = /^\/ping(?:@\w+)?\s*$/i.test(msg?.text ?? "") ? "health-update" : "update";
        this.enqueue(kind, conversation, update, `update:${update.update_id}`);
        offset = Math.max(offset, update.update_id + 1);
      }
      this.set("telegram-offset", offset);
    })();
  }

  claim(kinds: string[], limit = 4, now = Date.now()): QueueRow[] {
    this.assertWriter?.();
    if (!kinds.length) return [];
    return this.db.transaction(() => {
      const placeholders = kinds.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT q.* FROM gateway_queue q
        WHERE q.kind IN (${placeholders}) AND q.state='pending' AND q.available_at<=?
        AND NOT EXISTS (SELECT 1 FROM gateway_queue p WHERE p.conversation=q.conversation
          AND p.kind=q.kind AND p.state IN ('pending','running')
          AND p.rowid<q.rowid)
        ORDER BY priority,rowid LIMIT ?`).all(...kinds, now, limit) as QueueRow[];
      for (const row of rows) this.db.prepare("UPDATE gateway_queue SET state='running',attempts=attempts+1 WHERE id=?").run(row.id);
      return rows.map(row => ({ ...row, state: "running" as const, attempts: row.attempts + 1 }));
    })();
  }

  finish(id: string, result: unknown = null): void {
    this.assertWriter?.();
    this.db.prepare("UPDATE gateway_queue SET state='done',result=?,error=NULL,completed_at=? WHERE id=?")
      .run(JSON.stringify(result), Date.now(), id);
  }

  retry(id: string, error: string, delayMs: number, blocked = false): void {
    this.assertWriter?.();
    this.db.prepare("UPDATE gateway_queue SET state=?,error=?,available_at=? WHERE id=?")
      .run(blocked ? "blocked" : "pending", error.slice(0, 500), Date.now() + delayMs, id);
  }

  /** Called only while holding the process lock, so another consumer cannot own these rows. */
  recover(): void {
    this.db.prepare("UPDATE gateway_queue SET state='pending' WHERE state='running'").run();
  }

  bind(id: string, binding: CloudBinding): void {
    this.assertWriter?.();
    this.db.prepare("INSERT INTO gateway_bindings VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET payload=excluded.payload")
      .run(id, JSON.stringify(binding));
  }

  binding(id: string): CloudBinding | undefined {
    const row = this.db.prepare("SELECT payload FROM gateway_bindings WHERE workspace_id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as CloudBinding : undefined;
  }

  bindings(): Array<{ id: string; binding: CloudBinding }> {
    return (this.db.prepare("SELECT workspace_id,payload FROM gateway_bindings").all() as any[])
      .map(row => ({ id: row.workspace_id, binding: JSON.parse(row.payload) }));
  }

  linkDecision(chatId: string, messageId: string | number, decisionId: number): void {
    this.assertWriter?.();
    this.db.prepare("INSERT OR REPLACE INTO gateway_decision_links VALUES(?,?,?)").run(chatId, String(messageId), decisionId);
  }

  decisionForMessage(chatId: string, messageId: string | number): number | undefined {
    return (this.db.prepare("SELECT decision_id FROM gateway_decision_links WHERE chat_id=? AND message_id=?")
      .get(chatId, String(messageId)) as { decision_id: number } | undefined)?.decision_id;
  }

  backlog(): { pending: number; blocked: number; oldestMs: number } {
    const row = this.db.prepare(`SELECT sum(state IN ('pending','running')) AS pending,
      sum(state='blocked') AS blocked,min(CASE WHEN state IN ('pending','running') THEN created_at END) AS oldest
      FROM gateway_queue WHERE kind='telegram'`).get() as any;
    return { pending: row.pending ?? 0, blocked: row.blocked ?? 0, oldestMs: row.oldest ? Date.now() - row.oldest : 0 };
  }
}
