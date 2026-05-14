import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import type {
  EventType,
  PrChecksStatus,
  PrRecord,
  PrState,
  Workspace,
  WorkspaceEvent,
  WorkspaceStatus,
  Decision,
} from "../types/index.js";

// ── Workspaces ──────────────────────────────────────────────

export function createWorkspace(opts: {
  name: string;
  prompt: string;
  repoPath: string;
  telegramChatId: string;
}): Workspace {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO workspaces (id, name, prompt, status, repo_path, created_at, telegram_chat_id)
     VALUES (?, ?, ?, 'starting', ?, ?, ?)`
  ).run(id, opts.name, opts.prompt, opts.repoPath, now, opts.telegramChatId);

  return {
    id,
    name: opts.name,
    prompt: opts.prompt,
    status: "starting",
    repoPath: opts.repoPath,
    createdAt: now,
    telegramChatId: opts.telegramChatId,
    telegramMessageId: null,
    conductorWorkspaceName: null,
    conductorSessionId: null,
    lastForwardedMessageRowid: 0,
    telegramThreadId: null,
    archivedAt: null,
  };
}

export function getWorkspace(id: string): Workspace | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM workspaces WHERE id = ?")
    .get(id) as any;
  return row ? mapWorkspaceRow(row) : undefined;
}

export function getWorkspaceByName(
  conductorName: string,
  scope: { repoPath?: string; chatId?: string } = {}
): Workspace | undefined {
  const db = getDb();
  const where = ["conductor_workspace_name = ?", "archived_at IS NULL"];
  const params: any[] = [conductorName];
  if (scope.repoPath) {
    where.push("repo_path = ?");
    params.push(scope.repoPath);
  }
  if (scope.chatId) {
    where.push("telegram_chat_id = ?");
    params.push(scope.chatId);
  }

  const rows = db
    .prepare(
      `SELECT * FROM workspaces WHERE ${where.join(" AND ")} ORDER BY created_at DESC`
    )
    .all(...params) as any[];

  if (rows.length > 1) {
    console.warn(
      `[queries] ambiguous workspace name "${conductorName}" matched ${rows.length} rows (repoPath=${scope.repoPath ?? "unset"} chatId=${scope.chatId ?? "unset"})`
    );
    return undefined;
  }
  return rows[0] ? mapWorkspaceRow(rows[0]) : undefined;
}

export function findActiveWorkspaceByNameAndRepoBasename(
  conductorName: string,
  repoBasename: string
): Workspace | undefined {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM workspaces
       WHERE conductor_workspace_name = ?
         AND (repo_path = ? OR repo_path LIKE '%/' || ?)
         AND archived_at IS NULL
       ORDER BY created_at DESC`
    )
    .all(conductorName, repoBasename, repoBasename) as any[];
  if (rows.length > 1) {
    console.warn(
      `[queries] ambiguous workspace "${conductorName}" in repo basename "${repoBasename}" matched ${rows.length} rows`
    );
    return undefined;
  }
  return rows[0] ? mapWorkspaceRow(rows[0]) : undefined;
}

export function findActiveWorkspacesByNameAndChat(
  conductorName: string,
  chatId: string
): Workspace[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM workspaces
       WHERE conductor_workspace_name = ?
         AND telegram_chat_id = ?
         AND archived_at IS NULL
       ORDER BY created_at DESC`
    )
    .all(conductorName, chatId) as any[];
  return rows.map(mapWorkspaceRow);
}

export function getActiveWorkspaces(): Workspace[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM workspaces WHERE archived_at IS NULL AND status IN ('starting', 'running') ORDER BY created_at DESC"
    )
    .all() as any[];
  return rows.map(mapWorkspaceRow);
}

export function getAllWorkspaces(limit = 10): Workspace[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM workspaces WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT ?"
    )
    .all(limit) as any[];
  return rows.map(mapWorkspaceRow);
}

export function getAllWorkspacesForChat(chatId: string, limit = 50): Workspace[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM workspaces WHERE archived_at IS NULL AND telegram_chat_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(chatId, limit) as any[];
  return rows.map(mapWorkspaceRow);
}

export function getAllThreadedWorkspaces(): Workspace[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM workspaces WHERE archived_at IS NULL AND telegram_thread_id IS NOT NULL ORDER BY created_at DESC"
    )
    .all() as any[];
  return rows.map(mapWorkspaceRow);
}

export function updateWorkspaceStatus(
  id: string,
  status: WorkspaceStatus
): void {
  const db = getDb();
  db.prepare("UPDATE workspaces SET status = ? WHERE id = ?").run(status, id);
}

export function archiveWorkspace(id: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE workspaces SET status = 'archived', archived_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function updateWorkspaceTelegramMessage(
  id: string,
  messageId: string
): void {
  const db = getDb();
  db.prepare("UPDATE workspaces SET telegram_message_id = ? WHERE id = ?").run(
    messageId,
    id
  );
}

export function updateWorkspaceConductorName(
  id: string,
  conductorName: string
): void {
  const db = getDb();
  db.prepare(
    "UPDATE workspaces SET conductor_workspace_name = ? WHERE id = ?"
  ).run(conductorName, id);
}

export function updateWorkspaceConductorSession(
  id: string,
  sessionId: string
): void {
  const db = getDb();
  db.prepare(
    "UPDATE workspaces SET conductor_session_id = ? WHERE id = ?"
  ).run(sessionId, id);
}

export function updateWorkspaceThreadId(
  id: string,
  threadId: number
): void {
  const db = getDb();
  db.prepare(
    "UPDATE workspaces SET telegram_thread_id = ? WHERE id = ?"
  ).run(threadId, id);
}

export function getWorkspaceByThreadId(
  chatId: string,
  threadId: number
): Workspace | undefined {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM workspaces WHERE archived_at IS NULL AND telegram_chat_id = ? AND telegram_thread_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(chatId, threadId) as any;
  return row ? mapWorkspaceRow(row) : undefined;
}

export function updateWorkspaceForwardCursor(
  id: string,
  rowid: number
): void {
  const db = getDb();
  db.prepare(
    "UPDATE workspaces SET last_forwarded_message_rowid = ? WHERE id = ?"
  ).run(rowid, id);
}

export function linkTelegramMessage(
  chatId: string,
  telegramMessageId: string,
  workspaceId: string
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO telegram_message_links
      (chat_id, telegram_message_id, workspace_id)
     VALUES (?, ?, ?)`
  ).run(chatId, telegramMessageId, workspaceId);
}

export function getWorkspaceByTelegramMessage(
  chatId: string,
  telegramMessageId: string
): Workspace | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT w.*
       FROM telegram_message_links tml
       JOIN workspaces w ON w.id = tml.workspace_id
       WHERE tml.chat_id = ? AND tml.telegram_message_id = ? AND w.archived_at IS NULL`
    )
    .get(chatId, telegramMessageId) as any;
  return row ? mapWorkspaceRow(row) : undefined;
}

function mapWorkspaceRow(row: any): Workspace {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    status: row.status as WorkspaceStatus,
    repoPath: row.repo_path,
    createdAt: row.created_at,
    telegramChatId: row.telegram_chat_id,
    telegramMessageId: row.telegram_message_id,
    conductorWorkspaceName: row.conductor_workspace_name,
    conductorSessionId: row.conductor_session_id ?? null,
    lastForwardedMessageRowid: Number(row.last_forwarded_message_rowid ?? 0),
    telegramThreadId: row.telegram_thread_id ?? null,
    archivedAt: row.archived_at ?? null,
  };
}

// ── PR records ──────────────────────────────────────────────

export function upsertPrRecord(input: {
  workspaceId: string;
  repoPath: string;
  branch: string;
  prNumber?: number | null;
  prUrl?: string | null;
  title?: string | null;
  state?: PrState;
  isDraft?: boolean;
  headRef?: string | null;
  baseRef?: string | null;
  reviewDecision?: string | null;
  mergeStateStatus?: string | null;
  mergeable?: string | null;
  checksStatus?: PrChecksStatus;
  checksSummary?: string | null;
  branchExists?: boolean;
  lastCheckedAt?: string | null;
  lastError?: string | null;
}): PrRecord {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO pr_records
      (workspace_id, repo_path, branch, pr_number, pr_url, title, state, is_draft,
       head_ref, base_ref, review_decision, merge_state_status, mergeable,
       checks_status, checks_summary, branch_exists, last_checked_at, last_error,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       repo_path = excluded.repo_path,
       branch = excluded.branch,
       pr_number = excluded.pr_number,
       pr_url = excluded.pr_url,
       title = excluded.title,
       state = excluded.state,
       is_draft = excluded.is_draft,
       head_ref = excluded.head_ref,
       base_ref = excluded.base_ref,
       review_decision = excluded.review_decision,
       merge_state_status = excluded.merge_state_status,
       mergeable = excluded.mergeable,
       checks_status = excluded.checks_status,
       checks_summary = excluded.checks_summary,
       branch_exists = excluded.branch_exists,
       last_checked_at = excluded.last_checked_at,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`
  ).run(
    input.workspaceId,
    input.repoPath,
    input.branch,
    input.prNumber ?? null,
    input.prUrl ?? null,
    input.title ?? null,
    input.state ?? "unknown",
    input.isDraft ? 1 : 0,
    input.headRef ?? null,
    input.baseRef ?? null,
    input.reviewDecision ?? null,
    input.mergeStateStatus ?? null,
    input.mergeable ?? null,
    input.checksStatus ?? "unknown",
    input.checksSummary ?? null,
    input.branchExists ? 1 : 0,
    input.lastCheckedAt ?? now,
    input.lastError ?? null,
    now,
    now
  );

  const record = getPrRecord(input.workspaceId);
  if (!record) {
    throw new Error(`Failed to upsert PR record for workspace ${input.workspaceId}`);
  }
  return record;
}

export function getPrRecord(workspaceId: string): PrRecord | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM pr_records WHERE workspace_id = ?")
    .get(workspaceId) as any;
  return row ? mapPrRecordRow(row) : undefined;
}

export function getPrRecordsForWorkspaces(workspaceIds: string[]): Map<string, PrRecord> {
  const records = new Map<string, PrRecord>();
  if (workspaceIds.length === 0) return records;

  const db = getDb();
  const placeholders = workspaceIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM pr_records WHERE workspace_id IN (${placeholders})`)
    .all(...workspaceIds) as any[];
  for (const row of rows) {
    const record = mapPrRecordRow(row);
    records.set(record.workspaceId, record);
  }
  return records;
}

export function getAllPrRecords(): PrRecord[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM pr_records ORDER BY updated_at DESC")
    .all() as any[];
  return rows.map(mapPrRecordRow);
}

function mapPrRecordRow(row: any): PrRecord {
  return {
    workspaceId: row.workspace_id,
    repoPath: row.repo_path,
    branch: row.branch,
    prNumber: row.pr_number ?? null,
    prUrl: row.pr_url ?? null,
    title: row.title ?? null,
    state: (row.state ?? "unknown") as PrState,
    isDraft: Boolean(row.is_draft),
    headRef: row.head_ref ?? null,
    baseRef: row.base_ref ?? null,
    reviewDecision: row.review_decision ?? null,
    mergeStateStatus: row.merge_state_status ?? null,
    mergeable: row.mergeable ?? null,
    checksStatus: (row.checks_status ?? "unknown") as PrChecksStatus,
    checksSummary: row.checks_summary ?? null,
    branchExists: Boolean(row.branch_exists),
    lastCheckedAt: row.last_checked_at ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Events ──────────────────────────────────────────────────

export function addEvent(
  workspaceId: string,
  type: string,
  payload: string
): number {
  const db = getDb();
  const result = db
    .prepare(
      "INSERT INTO events (workspace_id, type, payload) VALUES (?, ?, ?)"
    )
    .run(workspaceId, type, payload);
  return Number(result.lastInsertRowid);
}

export function getEventsSince(
  workspaceId: string,
  afterId: number
): WorkspaceEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM events WHERE workspace_id = ? AND id > ? ORDER BY id ASC"
    )
    .all(workspaceId, afterId) as any[];
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    type: r.type,
    payload: r.payload,
    createdAt: r.created_at,
  }));
}

export function getMaxEventId(): number {
  const db = getDb();
  const row = db.prepare("SELECT MAX(id) as maxId FROM events").get() as any;
  return row?.maxId ?? 0;
}

export function getNewEvents(afterId: number): WorkspaceEvent[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC")
    .all(afterId) as any[];
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    type: r.type,
    payload: r.payload,
    createdAt: r.created_at,
  }));
}

export function getLatestEventByType(
  workspaceId: string,
  type: EventType
): WorkspaceEvent | undefined {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM events WHERE workspace_id = ? AND type = ? ORDER BY id DESC LIMIT 1"
    )
    .get(workspaceId, type) as any;
  return row
    ? {
        id: row.id,
        workspaceId: row.workspace_id,
        type: row.type,
        payload: row.payload,
        createdAt: row.created_at,
      }
    : undefined;
}

export function getArtifactEvents(workspaceId: string): WorkspaceEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM events WHERE workspace_id = ? AND type = 'artifact' ORDER BY id DESC"
    )
    .all(workspaceId) as any[];
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    type: r.type as EventType,
    payload: r.payload,
    createdAt: r.created_at,
  }));
}

// ── Decisions ───────────────────────────────────────────────

export function createDecision(
  workspaceId: string,
  question: string,
  options: string[] | null
): number {
  const db = getDb();
  const result = db
    .prepare(
      "INSERT INTO decisions (workspace_id, question, options) VALUES (?, ?, ?)"
    )
    .run(workspaceId, question, options ? JSON.stringify(options) : null);
  return Number(result.lastInsertRowid);
}

export function answerDecision(id: number, answer: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE decisions SET answer = ?, answered_at = datetime('now') WHERE id = ?"
  ).run(answer, id);
}

export function getDecision(id: number): Decision | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as any;
  return row ? mapDecisionRow(row) : undefined;
}

export function getPendingDecision(
  workspaceId: string
): Decision | undefined {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM decisions WHERE workspace_id = ? AND answer IS NULL ORDER BY id DESC LIMIT 1"
    )
    .get(workspaceId) as any;
  return row ? mapDecisionRow(row) : undefined;
}

function mapDecisionRow(row: any): Decision {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    question: row.question,
    options: row.options,
    answer: row.answer,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  };
}

// ── Heartbeat ───────────────────────────────────────────────

export interface Heartbeat {
  pid: number;
  version: string | null;
  startedAt: string;
  lastBeatAt: string;
  lastKnownAliveAt: string | null;
  bootCount: number;
  lastExitReason: string | null;
}

export function getHeartbeat(): Heartbeat | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM bot_heartbeat WHERE id = 1")
    .get() as any;
  if (!row) return undefined;
  return {
    pid: row.pid,
    version: row.version,
    startedAt: row.started_at,
    lastBeatAt: row.last_beat_at,
    lastKnownAliveAt: row.last_known_alive_at,
    bootCount: row.boot_count,
    lastExitReason: row.last_exit_reason,
  };
}

export function initHeartbeat(opts: {
  pid: number;
  version: string | null;
}): { previous: Heartbeat | undefined; bootCount: number } {
  const db = getDb();
  const previous = getHeartbeat();
  const now = new Date().toISOString();
  const bootCount = (previous?.bootCount ?? 0) + 1;

  if (previous) {
    db.prepare(
      `UPDATE bot_heartbeat
       SET pid = ?, version = ?, started_at = ?, last_beat_at = ?,
           last_known_alive_at = ?, boot_count = ?
       WHERE id = 1`
    ).run(
      opts.pid,
      opts.version,
      now,
      now,
      previous.lastBeatAt,
      bootCount
    );
  } else {
    db.prepare(
      `INSERT INTO bot_heartbeat
         (id, pid, version, started_at, last_beat_at, last_known_alive_at, boot_count, last_exit_reason)
       VALUES (1, ?, ?, ?, ?, NULL, 1, NULL)`
    ).run(opts.pid, opts.version, now, now);
  }

  return { previous, bootCount };
}

export function touchHeartbeat(): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE bot_heartbeat SET last_beat_at = ?, last_known_alive_at = ? WHERE id = 1"
  ).run(now, now);
}

export function recordExitReason(reason: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE bot_heartbeat SET last_exit_reason = ? WHERE id = 1"
  ).run(reason);
}
