import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import type {
  EventType,
  MergeIntent,
  PrChecksStatus,
  PrRecord,
  PrState,
  ThreadCursor,
  Workspace,
  WorkspaceEvent,
  WorkspaceStatus,
  Decision,
  RepoTopic,
  RouteAttemptStatus,
  RouteSource,
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
    conductorWorkspaceId: null,
    conductorSessionId: null,
    conductorBackendKind: null,
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

/** Durable Cloud work must not be starved by the normal workspace list cap. */
export function getWorkspacesWithPendingCloudWork(): Workspace[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT w.*
       FROM workspaces w
       JOIN meta m
         ON m.key IN (
           'pending-cloud-launch:' || w.id,
           'pending-cloud-messages:' || w.id,
           'pending-cloud-notices:' || w.id,
           'pending-cloud-terminal:' || w.id
         )
       ORDER BY w.created_at ASC`
    )
    .all() as any[];
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

/** Fail only a newly starting row; existing/terminal workspaces keep state. */
export function updateWorkspaceStatusUnlessTerminal(
  id: string,
  status: WorkspaceStatus
): boolean {
  const db = getDb();
  const updated = db.prepare(
    `UPDATE workspaces
     SET status = ?
     WHERE id = ?
       AND archived_at IS NULL
       AND status = 'starting'`
  ).run(status, id);
  return updated.changes === 1;
}

export function archiveWorkspace(id: string): void {
  const db = getDb();
  db.transaction(() => {
    const workspace = db.prepare(
      `SELECT conductor_workspace_id,
              conductor_session_id,
              conductor_backend_kind
       FROM workspaces WHERE id = ?`
    ).get(id) as
      | {
          conductor_workspace_id: string | null;
          conductor_session_id: string | null;
          conductor_backend_kind: string | null;
        }
      | undefined;
    db.prepare(
      "UPDATE workspaces SET status = 'archived', archived_at = datetime('now') WHERE id = ?"
    ).run(id);
    const pending = decodePendingCloudLaunch(
      db.prepare("SELECT value FROM meta WHERE key = ?")
        .get(pendingCloudLaunchKey(id)) as { value?: string } | undefined
    );
    if (pending) {
      db.prepare("UPDATE meta SET value = ?, updated_at = ? WHERE key = ?")
        .run(
          JSON.stringify({ ...pending, phase: "cancel" }),
          new Date().toISOString(),
          pendingCloudLaunchKey(id)
        );
    }
    // The terminal action belongs to the binding the user acted on. A stale
    // detached saga cleans up its own resource separately.
    const currentCloudBinding =
      workspace?.conductor_backend_kind === "cloud-api" &&
      workspace.conductor_workspace_id &&
      workspace.conductor_session_id
        ? {
            workspaceId: workspace.conductor_workspace_id,
            sessionId: workspace.conductor_session_id,
          }
        : null;
    const archiveWorkspaceId =
      currentCloudBinding?.workspaceId ?? pending?.workspaceId;
    const archiveSessionId =
      currentCloudBinding?.sessionId ?? pending?.sessionId;
    if (
      (pending || workspace?.conductor_backend_kind === "cloud-api") &&
      archiveWorkspaceId &&
      archiveSessionId
    ) {
      persistPendingCloudTerminalIntentInTransaction(db, id, {
        action: "archive",
        workspaceId: archiveWorkspaceId,
        sessionId: archiveSessionId,
        createdAt: new Date().toISOString(),
      });
    }
    const outboxRow = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(pendingCloudMessagesKey(id)) as { value?: string } | undefined;
    const outbox = decodePendingCloudMessages(outboxRow?.value ?? null);
    recordPendingCloudMessageOutcomesInTransaction(
      db,
      id,
      outbox,
      "suppressed",
      "workspace was archived"
    );
    if (outbox.length > 0) {
      appendPendingCloudNoticeInTransaction(db, id, {
        kind: "messages_suppressed",
        count: outbox.length,
        error: "workspace was archived",
      });
    }
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run(pendingCloudMessagesKey(id));
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run(cloudWorkLeasesKey(id));
  })();
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

export function updateWorkspaceConductorBinding(
  id: string,
  input: {
    workspaceId: string;
    sessionId: string;
    backendKind: "local" | "cloud-api";
  }
): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE workspaces
       SET conductor_workspace_id = ?,
           conductor_session_id = ?,
           conductor_backend_kind = ?
       WHERE id = ?`
    ).run(
      input.workspaceId,
      input.sessionId,
      input.backendKind,
      id
    );
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run(cloudWorkLeasesKey(id));
  })();
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
    `UPDATE workspaces
     SET last_forwarded_message_rowid = MAX(
       COALESCE(last_forwarded_message_rowid, 0),
       ?
     )
     WHERE id = ?`
  ).run(rowid, id);
}

// ── Thread cursors ───────────────────────────────────────────

export function upsertThreadCursor(input: {
  workspaceId: string;
  sessionId: string;
  backendKind: "local" | "cloud-api";
  lastForwardedRowid: number;
  lastMessageId?: string | null;
  title?: string | null;
}): ThreadCursor {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO thread_cursors
      (workspace_id, session_id, backend_kind, last_forwarded_rowid,
       last_message_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, session_id) DO UPDATE SET
       last_forwarded_rowid = CASE
         WHEN thread_cursors.backend_kind = 'cloud-api'
           AND excluded.backend_kind = 'local'
           THEN thread_cursors.last_forwarded_rowid
         WHEN COALESCE(thread_cursors.backend_kind, 'local') <> excluded.backend_kind
           THEN excluded.last_forwarded_rowid
         -- First API id for this cursor: the stored position is a SQLite
         -- rowid, so it must be left behind rather than MAX'd against an
         -- API index that is numbered from zero per session.
         WHEN excluded.backend_kind = 'cloud-api'
           AND excluded.last_message_id IS NOT NULL
           AND thread_cursors.last_message_id IS NULL
           THEN excluded.last_forwarded_rowid
         ELSE MAX(
           thread_cursors.last_forwarded_rowid,
           excluded.last_forwarded_rowid
         )
       END,
       last_message_id = CASE
         WHEN thread_cursors.backend_kind = 'cloud-api'
           AND excluded.backend_kind = 'local'
           THEN thread_cursors.last_message_id
         WHEN COALESCE(thread_cursors.backend_kind, 'local') <> excluded.backend_kind
           THEN excluded.last_message_id
         WHEN excluded.backend_kind = 'cloud-api'
           AND excluded.last_message_id IS NOT NULL
           AND thread_cursors.last_message_id IS NULL
           THEN excluded.last_message_id
         WHEN excluded.backend_kind = 'cloud-api'
           AND excluded.last_message_id IS NOT NULL
           AND excluded.last_forwarded_rowid >= thread_cursors.last_forwarded_rowid
           THEN excluded.last_message_id
         ELSE thread_cursors.last_message_id
       END,
       backend_kind = CASE
         WHEN thread_cursors.backend_kind = 'cloud-api'
           AND excluded.backend_kind = 'local'
           THEN thread_cursors.backend_kind
         ELSE excluded.backend_kind
       END,
       title = COALESCE(excluded.title, thread_cursors.title),
       updated_at = excluded.updated_at`
  ).run(
    input.workspaceId,
    input.sessionId,
    input.backendKind,
    input.lastForwardedRowid,
    input.lastMessageId ?? null,
    input.title ?? null,
    now,
    now
  );

  const cursor = getThreadCursor(input.workspaceId, input.sessionId);
  if (!cursor) {
    throw new Error(`Failed to upsert thread cursor ${input.workspaceId}/${input.sessionId}`);
  }
  return cursor;
}

/**
 * Drop the persisted anchor for a cloud thread so the next forwarded message
 * re-establishes it from scratch. Needed when a transcript rebuild hands out
 * new message ids with LOWER session indexes: upsertThreadCursor deliberately
 * never moves a cloud cursor backwards, so without this reset a re-anchored
 * message would be forwarded without ever replacing the dead cursor.
 */
export function resetCloudThreadCursorAnchors(sessionId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE thread_cursors
     SET last_forwarded_rowid = 0,
         last_message_id = NULL,
         updated_at = ?
     WHERE session_id = ? AND backend_kind = 'cloud-api'`
  ).run(new Date().toISOString(), sessionId);
}

export function getThreadCursor(
  workspaceId: string,
  sessionId: string
): ThreadCursor | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM thread_cursors
       WHERE workspace_id = ? AND session_id = ?`
    )
    .get(workspaceId, sessionId) as any;
  return row ? mapThreadCursorRow(row) : undefined;
}

export function getThreadCursorsForWorkspace(workspaceId: string): ThreadCursor[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM thread_cursors
       WHERE workspace_id = ?
       ORDER BY updated_at DESC`
    )
    .all(workspaceId) as any[];
  return rows.map(mapThreadCursorRow);
}

export function updateThreadCursor(
  workspaceId: string,
  sessionId: string,
  rowid: number,
  title?: string | null,
  lastMessageId?: string | null,
  backendKind: "local" | "cloud-api" = "local"
): void {
  upsertThreadCursor({
    workspaceId,
    sessionId,
    backendKind,
    lastForwardedRowid: rowid,
    lastMessageId,
    title,
  });
}

export function deleteThreadCursorsNotIn(
  workspaceId: string,
  sessionIds: string[]
): void {
  const db = getDb();
  if (sessionIds.length === 0) {
    db.prepare("DELETE FROM thread_cursors WHERE workspace_id = ?").run(workspaceId);
    return;
  }
  const placeholders = sessionIds.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM thread_cursors
     WHERE workspace_id = ? AND session_id NOT IN (${placeholders})`
  ).run(workspaceId, ...sessionIds);
}

export function linkTelegramMessage(
  chatId: string,
  telegramMessageId: string,
  workspaceId: string,
  sessionId?: string | null
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO telegram_message_links
      (chat_id, telegram_message_id, workspace_id, session_id)
     VALUES (?, ?, ?, ?)`
  ).run(chatId, telegramMessageId, workspaceId, sessionId ?? null);
}

export function getWorkspaceByTelegramMessage(
  chatId: string,
  telegramMessageId: string
): Workspace | undefined {
  return getWorkspaceMessageTarget(chatId, telegramMessageId)?.workspace;
}

export function getWorkspaceMessageTarget(
  chatId: string,
  telegramMessageId: string
): { workspace: Workspace; sessionId: string | null } | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT w.*, tml.session_id as linked_session_id
       FROM telegram_message_links tml
       JOIN workspaces w ON w.id = tml.workspace_id
       WHERE tml.chat_id = ? AND tml.telegram_message_id = ? AND w.archived_at IS NULL`
    )
    .get(chatId, telegramMessageId) as any;
  return row
    ? {
        workspace: mapWorkspaceRow(row),
        sessionId: row.linked_session_id ?? null,
      }
    : undefined;
}

// ── Meta ────────────────────────────────────────────────────

export function getMetaValue(key: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

export function setMetaValue(key: string, value: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO meta (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(key, value, now);
}

export type PendingCloudNoticeKind =
  | "launch_queued"
  | "launch_failed"
  | "launch_canceled"
  | "messages_sent"
  | "messages_suppressed"
  | "messages_failed"
  | "stop_confirmed"
  | "archive_confirmed"
  | "stop_failed"
  | "archive_failed";

export interface PendingCloudNotice {
  id: string;
  kind: PendingCloudNoticeKind;
  count?: number;
  error?: string;
  createdAt: string;
}

export interface PendingCloudNoticeInput {
  kind: PendingCloudNoticeKind;
  count?: number;
  error?: string;
}

function pendingCloudNoticesKey(trackedWorkspaceId: string): string {
  return `pending-cloud-notices:${trackedWorkspaceId}`;
}

function decodePendingCloudNotices(raw: string | null): PendingCloudNotice[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (notice): notice is PendingCloudNotice =>
        typeof notice === "object" &&
        notice !== null &&
        typeof (notice as PendingCloudNotice).id === "string" &&
        (notice as PendingCloudNotice).id.length > 0 &&
        [
          "launch_queued",
          "launch_failed",
          "launch_canceled",
          "messages_sent",
          "messages_suppressed",
          "messages_failed",
          "stop_confirmed",
          "archive_confirmed",
          "stop_failed",
          "archive_failed",
        ].includes((notice as PendingCloudNotice).kind) &&
        typeof (notice as PendingCloudNotice).createdAt === "string"
    );
  } catch {
    return [];
  }
}

/** Upper bound on retained recovery notices per workspace. */
const MAX_PENDING_CLOUD_NOTICES = 50;

function appendPendingCloudNoticeInTransaction(
  db: ReturnType<typeof getDb>,
  trackedWorkspaceId: string,
  input: PendingCloudNoticeInput
): PendingCloudNotice {
  const key = pendingCloudNoticesKey(trackedWorkspaceId);
  const now = new Date().toISOString();
  const row = db.prepare("SELECT value FROM meta WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  const notice: PendingCloudNotice = {
    id: randomUUID(),
    ...input,
    createdAt: now,
  };
  const notices = decodePendingCloudNotices(row?.value ?? null);
  // Notices only clear once Telegram accepts them, so a sustained delivery
  // outage would otherwise grow one meta row without bound. Keep the newest:
  // the oldest recovery notice is the least useful one to replay.
  const retained = [...notices, notice].slice(-MAX_PENDING_CLOUD_NOTICES);
  db.prepare(
    `INSERT INTO meta (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(retained), now);
  return notice;
}

export function getPendingCloudNotices(
  trackedWorkspaceId: string
): PendingCloudNotice[] {
  return decodePendingCloudNotices(
    getMetaValue(pendingCloudNoticesKey(trackedWorkspaceId))
  );
}

export function enqueuePendingCloudNotice(
  trackedWorkspaceId: string,
  input: PendingCloudNoticeInput
): PendingCloudNotice {
  const db = getDb();
  return db.transaction(() =>
    appendPendingCloudNoticeInTransaction(db, trackedWorkspaceId, input)
  )();
}

/** Acknowledge only the notice that was actually published. */
export function acknowledgePendingCloudNotice(
  trackedWorkspaceId: string,
  noticeId: string
): boolean {
  const db = getDb();
  return db.transaction(() => {
    const key = pendingCloudNoticesKey(trackedWorkspaceId);
    const row = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    const notices = decodePendingCloudNotices(row?.value ?? null);
    if (!notices.some((notice) => notice.id === noticeId)) return false;
    const remaining = notices.filter((notice) => notice.id !== noticeId);
    if (remaining.length === 0) {
      db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    } else {
      db.prepare("UPDATE meta SET value = ?, updated_at = ? WHERE key = ?")
        .run(JSON.stringify(remaining), new Date().toISOString(), key);
    }
    return true;
  })();
}

export interface PendingCloudLaunch {
  workspaceId: string;
  sessionId: string;
  prompt: string;
  messageId: string;
  /** Resource provisioned by this saga and safe to remove on rollback. */
  cleanupTarget?: "workspace" | "session";
  /** Preserve the existing Cloud workspace name when only a thread changes. */
  conductorWorkspaceName?: string;
  phase?: "provisioned" | "send" | "sent" | "cleanup" | "cancel";
  previousBinding?: {
    conductorWorkspaceName: string | null;
    conductorWorkspaceId: string | null;
    conductorSessionId: string | null;
    conductorBackendKind: "local" | "cloud-api" | null;
    status: WorkspaceStatus;
  };
}

export type PendingCloudLaunchIdentity = Pick<
  PendingCloudLaunch,
  "workspaceId" | "sessionId" | "messageId"
> & { phase?: PendingCloudLaunch["phase"] };

function pendingCloudLaunchMatches(
  pending: PendingCloudLaunch | null,
  expected: PendingCloudLaunchIdentity
): pending is PendingCloudLaunch {
  return Boolean(
    pending &&
      pending.workspaceId === expected.workspaceId &&
      pending.sessionId === expected.sessionId &&
      pending.messageId === expected.messageId &&
      (expected.phase === undefined || pending.phase === expected.phase)
  );
}

export interface PendingCloudTerminalIntent {
  action: "stop" | "archive";
  workspaceId: string;
  sessionId: string;
  createdAt: string;
  /** Cancel even if a status read has not observed the late accepted POST yet. */
  forceCancel?: boolean;
}

function pendingCloudTerminalKey(trackedWorkspaceId: string): string {
  return `pending-cloud-terminal:${trackedWorkspaceId}`;
}

interface CloudWorkLease {
  token: string;
  workspaceId: string;
  createdAt: string;
}

function cloudWorkLeasesKey(trackedWorkspaceId: string): string {
  return `cloud-work-leases:${trackedWorkspaceId}`;
}

/**
 * How long a work lease may be held before another attempt may claim it.
 *
 * A lease is released in a `finally`, so only a crash between acquiring it and
 * reaching that block can strand one — and nothing sweeps `cloud-work-leases`
 * on boot. Without an expiry that workspace would refuse every later send with
 * "retry after its pending Stop or Archive completes" when no such request
 * exists, until the operator manually stopped it. The ceiling sits above the
 * slowest legitimate hold: one API call is bounded at 120s and may retry 5
 * times, so 15 minutes cannot expire a lease that is still doing real work.
 */
const CLOUD_WORK_LEASE_MAX_AGE_MS = 15 * 60_000;

/** Drop leases old enough that only a dead process could still hold them. */
function activeCloudWorkLeases(
  leases: CloudWorkLease[],
  now = Date.now()
): CloudWorkLease[] {
  return leases.filter((lease) => {
    const startedAt = Date.parse(lease.createdAt);
    // An unparsable timestamp cannot be shown to be current, so treat it as
    // expired rather than letting it block the workspace forever.
    return (
      Number.isFinite(startedAt) &&
      now - startedAt < CLOUD_WORK_LEASE_MAX_AGE_MS
    );
  });
}

function decodeCloudWorkLeases(raw: string | null | undefined): CloudWorkLease[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (lease): lease is CloudWorkLease =>
        typeof lease === "object" &&
        lease !== null &&
        typeof (lease as CloudWorkLease).token === "string" &&
        typeof (lease as CloudWorkLease).workspaceId === "string" &&
        typeof (lease as CloudWorkLease).createdAt === "string"
    );
  } catch {
    return [];
  }
}

/** Reserve a send/new-thread attempt so a later stop can revoke it durably. */
export function beginCloudWorkLease(
  trackedWorkspaceId: string,
  workspaceId: string
): string | null {
  const db = getDb();
  return db.transaction(() => {
    const workspace = db.prepare(
      `SELECT status, archived_at, conductor_workspace_id,
              conductor_backend_kind
       FROM workspaces WHERE id = ?`
    ).get(trackedWorkspaceId) as
      | {
          status: string;
          archived_at: string | null;
          conductor_workspace_id: string | null;
          conductor_backend_kind: string | null;
        }
      | undefined;
    const terminalRow = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(pendingCloudTerminalKey(trackedWorkspaceId)) as
      | { value?: string }
      | undefined;
    const launchRow = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(pendingCloudLaunchKey(trackedWorkspaceId)) as
      | { value?: string }
      | undefined;
    if (
      !workspace ||
      workspace.archived_at ||
      workspace.status === "archived" ||
      workspace.conductor_backend_kind !== "cloud-api" ||
      workspace.conductor_workspace_id !== workspaceId ||
      decodePendingCloudTerminalIntent(terminalRow?.value) ||
      decodePendingCloudLaunch(launchRow)
    ) {
      return null;
    }
    const key = cloudWorkLeasesKey(trackedWorkspaceId);
    const existingRow = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    const existingLeases = activeCloudWorkLeases(
      decodeCloudWorkLeases(existingRow?.value)
    );
    const outboxRow = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(pendingCloudMessagesKey(trackedWorkspaceId)) as
      | { value?: string }
      | undefined;
    if (
      existingLeases.length > 0 ||
      decodePendingCloudMessages(outboxRow?.value ?? null).length > 0
    ) {
      return null;
    }
    const now = new Date().toISOString();
    const lease: CloudWorkLease = {
      token: randomUUID(),
      workspaceId,
      createdAt: now,
    };
    const leases = existingLeases;
    db.prepare(
      `INSERT INTO meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    ).run(key, JSON.stringify([...leases, lease]), now);
    return lease.token;
  })();
}

/** Final pre-POST gate: Stop/Archive clears every outstanding lease. */
export function cloudWorkLeaseCanSend(
  trackedWorkspaceId: string,
  workspaceId: string,
  token: string
): boolean {
  const db = getDb();
  return db.transaction(() => {
    const workspace = db.prepare(
      `SELECT status, archived_at, conductor_workspace_id,
              conductor_backend_kind
       FROM workspaces WHERE id = ?`
    ).get(trackedWorkspaceId) as
      | {
          status: string;
          archived_at: string | null;
          conductor_workspace_id: string | null;
          conductor_backend_kind: string | null;
        }
      | undefined;
    const terminalRow = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(pendingCloudTerminalKey(trackedWorkspaceId)) as
      | { value?: string }
      | undefined;
    const leaseRow = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(cloudWorkLeasesKey(trackedWorkspaceId)) as
      | { value?: string }
      | undefined;
    return Boolean(
      workspace &&
        !workspace.archived_at &&
        workspace.status !== "archived" &&
        workspace.conductor_backend_kind === "cloud-api" &&
        workspace.conductor_workspace_id === workspaceId &&
        !decodePendingCloudTerminalIntent(terminalRow?.value) &&
        activeCloudWorkLeases(decodeCloudWorkLeases(leaseRow?.value)).some(
          (lease) => lease.token === token && lease.workspaceId === workspaceId
        )
    );
  })();
}

export function clearCloudWorkLease(
  trackedWorkspaceId: string,
  token: string
): void {
  const db = getDb();
  db.transaction(() => {
    const key = cloudWorkLeasesKey(trackedWorkspaceId);
    const row = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    const remaining = decodeCloudWorkLeases(row?.value).filter(
      (lease) => lease.token !== token
    );
    if (remaining.length === 0) {
      db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    } else {
      db.prepare("UPDATE meta SET value = ?, updated_at = ? WHERE key = ?")
        .run(JSON.stringify(remaining), new Date().toISOString(), key);
    }
  })();
}

/** Commit a Cloud send only if no terminal action revoked its lease. */
export function completeCloudWorkLease(
  trackedWorkspaceId: string,
  workspaceId: string,
  token: string
): boolean {
  const db = getDb();
  return db.transaction(() => {
    const key = cloudWorkLeasesKey(trackedWorkspaceId);
    const leaseRow = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    const leases = activeCloudWorkLeases(
      decodeCloudWorkLeases(leaseRow?.value)
    );
    if (
      !leases.some(
        (lease) => lease.token === token && lease.workspaceId === workspaceId
      ) ||
      !cloudWorkLeaseCanSend(trackedWorkspaceId, workspaceId, token)
    ) {
      return false;
    }
    const updated = db.prepare(
      `UPDATE workspaces
       SET status = 'running'
       WHERE id = ?
         AND conductor_backend_kind = 'cloud-api'
         AND conductor_workspace_id = ?
         AND archived_at IS NULL
         AND status != 'archived'`
    ).run(trackedWorkspaceId, workspaceId);
    if (updated.changes !== 1) return false;
    const remaining = leases.filter((lease) => lease.token !== token);
    if (remaining.length === 0) {
      db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    } else {
      db.prepare("UPDATE meta SET value = ?, updated_at = ? WHERE key = ?")
        .run(JSON.stringify(remaining), new Date().toISOString(), key);
    }
    return true;
  })();
}

/** Re-arm a stop after an in-flight POST may have landed behind cancellation. */
export function ensurePendingCloudStopIntent(
  trackedWorkspaceId: string,
  workspaceId: string,
  sessionId: string
): boolean {
  const db = getDb();
  return db.transaction(() => {
    const workspace = db.prepare(
      `SELECT status, archived_at, conductor_workspace_id,
              conductor_session_id, conductor_backend_kind
       FROM workspaces WHERE id = ?`
    ).get(trackedWorkspaceId) as
      | {
          status: string;
          archived_at: string | null;
          conductor_workspace_id: string | null;
          conductor_session_id: string | null;
          conductor_backend_kind: string | null;
        }
      | undefined;
    if (
      !workspace ||
      workspace.status !== "stopped" ||
      workspace.archived_at ||
      workspace.conductor_backend_kind !== "cloud-api" ||
      workspace.conductor_workspace_id !== workspaceId ||
      workspace.conductor_session_id !== sessionId
    ) {
      return false;
    }
    persistPendingCloudTerminalIntentInTransaction(
      db,
      trackedWorkspaceId,
      {
        action: "stop",
        workspaceId,
        sessionId,
        createdAt: new Date().toISOString(),
        forceCancel: true,
      }
    );
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run(cloudWorkLeasesKey(trackedWorkspaceId));
    return true;
  })();
}

function decodePendingCloudTerminalIntent(
  raw: string | null | undefined
): PendingCloudTerminalIntent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingCloudTerminalIntent>;
    if (
      (parsed.action !== "stop" && parsed.action !== "archive") ||
      typeof parsed.workspaceId !== "string" ||
      !parsed.workspaceId ||
      typeof parsed.sessionId !== "string" ||
      !parsed.sessionId ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return parsed as PendingCloudTerminalIntent;
  } catch {
    return null;
  }
}

function persistPendingCloudTerminalIntentInTransaction(
  db: ReturnType<typeof getDb>,
  trackedWorkspaceId: string,
  intent: PendingCloudTerminalIntent
): void {
  const key = pendingCloudTerminalKey(trackedWorkspaceId);
  const existingRow = db.prepare("SELECT value FROM meta WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  const existing = decodePendingCloudTerminalIntent(existingRow?.value);
  // Archive is stronger than stop and must never be downgraded by a racing
  // callback that captured older UI state.
  const durable =
    existing?.action === "archive" && intent.action === "stop"
      ? existing
      : intent;
  db.prepare(
    `INSERT INTO meta (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(durable), new Date().toISOString());
}

export function getPendingCloudTerminalIntent(
  trackedWorkspaceId: string
): PendingCloudTerminalIntent | null {
  return decodePendingCloudTerminalIntent(
    getMetaValue(pendingCloudTerminalKey(trackedWorkspaceId))
  );
}

/** Clear only the exact terminal request whose remote effect was confirmed. */
export function completePendingCloudTerminalIntent(
  trackedWorkspaceId: string,
  expected: PendingCloudTerminalIntent
): PendingCloudNotice | null {
  const db = getDb();
  return db.transaction(() => {
    const key = pendingCloudTerminalKey(trackedWorkspaceId);
    const row = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    const current = decodePendingCloudTerminalIntent(row?.value);
    if (
      current?.action !== expected.action ||
      current.workspaceId !== expected.workspaceId ||
      current.sessionId !== expected.sessionId ||
      current.createdAt !== expected.createdAt
    ) {
      return null;
    }
    const notice = appendPendingCloudNoticeInTransaction(
      db,
      trackedWorkspaceId,
      {
        kind:
          expected.action === "archive"
            ? "archive_confirmed"
            : "stop_confirmed",
      }
    );
    db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    return notice;
  })();
}

/**
 * How long a stop/archive intent may keep retrying before it gives up.
 *
 * Retryable failures (429s, 5xx, an unreachable API) should survive a long
 * outage, but they must not gate the workspace forever: sends and new threads
 * refuse to run while an intent is pending, so an intent that can never
 * succeed silently retires the workspace.
 */
const PENDING_CLOUD_TERMINAL_MAX_AGE_MS = 60 * 60_000;

/** True once a terminal intent has retried past the point of being useful. */
export function pendingCloudTerminalIntentIsExhausted(
  intent: PendingCloudTerminalIntent,
  now = Date.now()
): boolean {
  const startedAt = Date.parse(intent.createdAt);
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt >= PENDING_CLOUD_TERMINAL_MAX_AGE_MS;
}

/**
 * Retire a stop/archive intent that cannot succeed, leaving a notice behind.
 *
 * The launch saga has always been able to fail out; this one could only ever
 * report "pending", so a deterministic error (a stored id the API rejects, a
 * workspace-identity mismatch) blocked every later send with no way out.
 */
export function failPendingCloudTerminalIntent(
  trackedWorkspaceId: string,
  expected: PendingCloudTerminalIntent,
  error: string
): PendingCloudNotice | null {
  const db = getDb();
  return db.transaction(() => {
    const key = pendingCloudTerminalKey(trackedWorkspaceId);
    const row = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    const current = decodePendingCloudTerminalIntent(row?.value);
    if (
      current?.action !== expected.action ||
      current.workspaceId !== expected.workspaceId ||
      current.sessionId !== expected.sessionId ||
      current.createdAt !== expected.createdAt
    ) {
      return null;
    }
    const notice = appendPendingCloudNoticeInTransaction(
      db,
      trackedWorkspaceId,
      {
        kind: expected.action === "archive" ? "archive_failed" : "stop_failed",
        error,
      }
    );
    db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    return notice;
  })();
}

function pendingCloudLaunchKey(trackedWorkspaceId: string): string {
  return `pending-cloud-launch:${trackedWorkspaceId}`;
}

interface FinalizedCloudLaunchReceipt {
  workspaceId: string;
  sessionId: string;
  messageId: string;
  finalizedAt: string;
}

function finalizedCloudLaunchReceiptKey(trackedWorkspaceId: string): string {
  return `finalized-cloud-launch:${trackedWorkspaceId}`;
}

function decodeFinalizedCloudLaunchReceipt(
  raw: string | null | undefined
): FinalizedCloudLaunchReceipt | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FinalizedCloudLaunchReceipt>;
    if (
      typeof parsed.workspaceId !== "string" ||
      !parsed.workspaceId ||
      typeof parsed.sessionId !== "string" ||
      !parsed.sessionId ||
      typeof parsed.messageId !== "string" ||
      !parsed.messageId ||
      typeof parsed.finalizedAt !== "string"
    ) {
      return null;
    }
    return parsed as FinalizedCloudLaunchReceipt;
  } catch {
    return null;
  }
}

function finalizedCloudLaunchMatchesInTransaction(
  db: ReturnType<typeof getDb>,
  trackedWorkspaceId: string,
  workspaceId: string,
  sessionId: string,
  messageId: string
): boolean {
  const row = db.prepare(
    `SELECT status,
            conductor_workspace_id,
            conductor_session_id,
            conductor_backend_kind
     FROM workspaces WHERE id = ?`
  ).get(trackedWorkspaceId) as
    | {
        status?: string;
        conductor_workspace_id?: string | null;
        conductor_session_id?: string | null;
        conductor_backend_kind?: string | null;
      }
    | undefined;
  const receiptRow = db.prepare("SELECT value FROM meta WHERE key = ?")
    .get(finalizedCloudLaunchReceiptKey(trackedWorkspaceId)) as
    | { value?: string }
    | undefined;
  const receipt = decodeFinalizedCloudLaunchReceipt(receiptRow?.value);
  return (
    (row?.status === "running" ||
      row?.status === "done" ||
      row?.status === "failed") &&
    row.conductor_backend_kind === "cloud-api" &&
    row.conductor_workspace_id === workspaceId &&
    row.conductor_session_id === sessionId &&
    receipt?.workspaceId === workspaceId &&
    receipt.sessionId === sessionId &&
    receipt.messageId === messageId
  );
}

/** Prove that this exact first-message identity already committed durably. */
export function isFinalizedCloudLaunch(input: {
  trackedWorkspaceId: string;
  workspaceId: string;
  sessionId: string;
  messageId: string;
}): boolean {
  const db = getDb();
  return db.transaction(() =>
    finalizedCloudLaunchMatchesInTransaction(
      db,
      input.trackedWorkspaceId,
      input.workspaceId,
      input.sessionId,
      input.messageId
    )
  )();
}

/** Persist the Cloud identity and unsent/uncertain first prompt atomically. */
export function persistPendingCloudLaunch(
  trackedWorkspaceId: string,
  pending: PendingCloudLaunch,
  options: {
    /** Proves a stopped/done/failed Cloud row is intentionally reopening. */
    reopenLeaseToken?: string;
    expectedPreviousSessionId?: string | null;
  } = {}
): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  return db.transaction(() => {
    const previous = db.prepare(
      `SELECT conductor_workspace_name,
              conductor_workspace_id,
              conductor_session_id,
              conductor_backend_kind,
              status
       FROM workspaces
       WHERE id = ?`
    ).get(trackedWorkspaceId) as
      | {
          conductor_workspace_name: string | null;
          conductor_workspace_id: string | null;
          conductor_session_id: string | null;
          conductor_backend_kind: "local" | "cloud-api" | null;
          status: WorkspaceStatus;
        }
      | undefined;
    if (!previous) {
      throw new Error(
        `Cannot persist pending Cloud launch for missing workspace ${trackedWorkspaceId}`
      );
    }
    const existing = decodePendingCloudLaunch(
      db.prepare("SELECT value FROM meta WHERE key = ?")
        .get(pendingCloudLaunchKey(trackedWorkspaceId)) as
        | { value?: string }
        | undefined
    );
    const terminalRow = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(pendingCloudTerminalKey(trackedWorkspaceId)) as
      | { value?: string }
      | undefined;
    const terminalIntent = decodePendingCloudTerminalIntent(
      terminalRow?.value
    );
    const reopenLease = options.reopenLeaseToken
      ? decodeCloudWorkLeases(
          (
            db.prepare("SELECT value FROM meta WHERE key = ?")
              .get(cloudWorkLeasesKey(trackedWorkspaceId)) as
              | { value?: string }
              | undefined
          )?.value
        ).some(
          (lease) =>
            lease.token === options.reopenLeaseToken &&
            lease.workspaceId === pending.workspaceId
        )
      : false;
    if (options.reopenLeaseToken) {
      const expectedSession = options.expectedPreviousSessionId;
      const bindingMatches =
        previous.conductor_backend_kind === "cloud-api" &&
        previous.conductor_workspace_id === pending.workspaceId &&
        (expectedSession === undefined ||
          previous.conductor_session_id === expectedSession);
      const canceledDuringProvisioning = Boolean(
        terminalIntent &&
          terminalIntent.workspaceId === pending.workspaceId &&
          bindingMatches
      );
      if (
        existing ||
        !bindingMatches ||
        (!reopenLease && !canceledDuringProvisioning)
      ) {
        return false;
      }
    }
    const terminalPhase = options.reopenLeaseToken
      ? terminalIntent
        ? "cancel"
        : null
      : previous.status === "stopped" || previous.status === "archived"
        ? "cancel"
        : previous.status === "failed" || previous.status === "done"
          ? "cleanup"
          : null;
    const durablePending: PendingCloudLaunch = {
      ...pending,
      // A terminal status may have been written while Cloud provisioning was
      // in flight. Preserve it atomically instead of resurrecting the launch.
      phase: terminalPhase ?? pending.phase ?? "send",
      previousBinding:
        existing?.previousBinding ?? {
          conductorWorkspaceName: previous.conductor_workspace_name,
          conductorWorkspaceId: previous.conductor_workspace_id,
          conductorSessionId: previous.conductor_session_id,
          conductorBackendKind: previous.conductor_backend_kind,
          status: previous.status,
        },
    };
    const updated = db.prepare(
      `UPDATE workspaces
       SET conductor_workspace_name = ?,
           conductor_workspace_id = ?,
           conductor_session_id = ?,
           conductor_backend_kind = 'cloud-api',
           status = ?
       WHERE id = ?`
    ).run(
      pending.conductorWorkspaceName ?? pending.workspaceId,
      pending.workspaceId,
      pending.sessionId,
      durablePending.phase === "send" || durablePending.phase === "provisioned"
        ? "starting"
        : previous.status,
      trackedWorkspaceId
    );
    if (updated.changes !== 1) {
      throw new Error(
        `Cannot persist pending Cloud launch for missing workspace ${trackedWorkspaceId}`
      );
    }
    db.prepare(
      `INSERT INTO meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    ).run(
      pendingCloudLaunchKey(trackedWorkspaceId),
      JSON.stringify(durablePending),
      now
    );
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run(finalizedCloudLaunchReceiptKey(trackedWorkspaceId));
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run(cloudWorkLeasesKey(trackedWorkspaceId));
    if (durablePending.phase === "cancel") {
      db.prepare("DELETE FROM meta WHERE key = ?")
        .run(pendingCloudMessagesKey(trackedWorkspaceId));
    }
    return true;
  })();
}

export function getPendingCloudLaunch(
  trackedWorkspaceId: string
): PendingCloudLaunch | null {
  return decodePendingCloudLaunch(
    getMetaValue(pendingCloudLaunchKey(trackedWorkspaceId))
  );
}

function decodePendingCloudLaunch(
  source: string | { value?: string } | null | undefined
): PendingCloudLaunch | null {
  const raw = typeof source === "string" ? source : source?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingCloudLaunch>;
    if (
      typeof parsed.workspaceId !== "string" ||
      !parsed.workspaceId ||
      typeof parsed.sessionId !== "string" ||
      !parsed.sessionId ||
      typeof parsed.prompt !== "string" ||
      typeof parsed.messageId !== "string" ||
      !parsed.messageId
    ) {
      return null;
    }
    const phase =
      parsed.phase === "provisioned" ||
      parsed.phase === "sent" ||
      parsed.phase === "cleanup" ||
      parsed.phase === "cancel"
        ? parsed.phase
        : "send";
    const cleanupTarget =
      parsed.cleanupTarget === "session" ? "session" : "workspace";
    return { ...parsed, phase, cleanupTarget } as PendingCloudLaunch;
  } catch {
    return null;
  }
}

/** Restore the binding that existed before Cloud provisioning and clear the saga. */
export function restorePendingCloudLaunchBinding(
  trackedWorkspaceId: string,
  statusOverride?: WorkspaceStatus,
  notice?: PendingCloudNoticeInput,
  expected?: PendingCloudLaunchIdentity
): boolean {
  const db = getDb();
  return db.transaction(() => {
    const pending = decodePendingCloudLaunch(
      db.prepare("SELECT value FROM meta WHERE key = ?")
        .get(pendingCloudLaunchKey(trackedWorkspaceId)) as
        | { value?: string }
        | undefined
    );
    if (expected && !pendingCloudLaunchMatches(pending, expected)) {
      return false;
    }
    const previous = pending?.previousBinding;
    if (!previous) return false;
    const restored = db.prepare(
      `UPDATE workspaces
       SET conductor_workspace_name = ?,
           conductor_workspace_id = ?,
           conductor_session_id = ?,
           conductor_backend_kind = ?,
           status = ?
       WHERE id = ?`
    ).run(
      previous.conductorWorkspaceName,
      previous.conductorWorkspaceId,
      previous.conductorSessionId,
      previous.conductorBackendKind,
      statusOverride ?? previous.status,
      trackedWorkspaceId
    );
    if (restored.changes !== 1) return false;
    if (notice) {
      appendPendingCloudNoticeInTransaction(
        db,
        trackedWorkspaceId,
        notice
      );
    }
    const outboxRow = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(pendingCloudMessagesKey(trackedWorkspaceId)) as
      | { value?: string }
      | undefined;
    const outbox = decodePendingCloudMessages(outboxRow?.value ?? null);
    const outboxOutcome =
      statusOverride === "stopped" || statusOverride === "archived"
        ? "suppressed"
        : "failed";
    recordPendingCloudMessageOutcomesInTransaction(
      db,
      trackedWorkspaceId,
      outbox,
      outboxOutcome,
      notice?.error
    );
    if (outbox.length > 0) {
      appendPendingCloudNoticeInTransaction(db, trackedWorkspaceId, {
        kind:
          outboxOutcome === "suppressed"
            ? "messages_suppressed"
            : "messages_failed",
        count: outbox.length,
        error:
          notice?.error ??
          (outboxOutcome === "suppressed"
            ? "Cloud launch was canceled"
            : "Cloud launch failed"),
      });
    }
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run(pendingCloudLaunchKey(trackedWorkspaceId));
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run(pendingCloudMessagesKey(trackedWorkspaceId));
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run(cloudWorkLeasesKey(trackedWorkspaceId));
    return true;
  })();
}

/** Final send gate, checked after durable persistence and before API delivery. */
export function pendingCloudLaunchCanSend(
  trackedWorkspaceId: string,
  expected: PendingCloudLaunchIdentity
): boolean {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(
      `SELECT status,
              conductor_workspace_id,
              conductor_session_id
       FROM workspaces WHERE id = ?`
    ).get(trackedWorkspaceId) as
      | {
          status?: string;
          conductor_workspace_id?: string | null;
          conductor_session_id?: string | null;
        }
      | undefined;
    const pending = decodePendingCloudLaunch(
      db.prepare("SELECT value FROM meta WHERE key = ?")
        .get(pendingCloudLaunchKey(trackedWorkspaceId)) as
        | { value?: string }
        | undefined
    );
    // promotePendingCloudLaunchToSend only reaches the "send" phase once the
    // row already points at this binding, so re-checking it here costs nothing
    // on the happy path and refuses to POST an old prompt into an old session
    // if anything rebound the row without clearing the saga.
    return (
      row?.status === "starting" &&
      row.conductor_workspace_id === expected.workspaceId &&
      row.conductor_session_id === expected.sessionId &&
      pending?.phase === "send" &&
      pendingCloudLaunchMatches(pending, expected)
    );
  })();
}

/** Promote only the exact freshly provisioned saga after validation succeeds. */
export function promotePendingCloudLaunchToSend(
  trackedWorkspaceId: string,
  expected: PendingCloudLaunchIdentity,
  prompt: string
): boolean {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(
      `SELECT status,
              conductor_workspace_id,
              conductor_session_id,
              conductor_backend_kind
       FROM workspaces WHERE id = ?`
    ).get(trackedWorkspaceId) as
      | {
          status?: string;
          conductor_workspace_id?: string | null;
          conductor_session_id?: string | null;
          conductor_backend_kind?: string | null;
        }
      | undefined;
    const pendingRow = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(pendingCloudLaunchKey(trackedWorkspaceId)) as
      | { value?: string }
      | undefined;
    const pending = decodePendingCloudLaunch(pendingRow);
    if (
      row?.status !== "starting" ||
      row.conductor_backend_kind !== "cloud-api" ||
      row.conductor_workspace_id !== expected.workspaceId ||
      row.conductor_session_id !== expected.sessionId ||
      pending?.phase !== "provisioned" ||
      !pendingCloudLaunchMatches(pending, expected)
    ) {
      return false;
    }
    db.prepare("UPDATE meta SET value = ?, updated_at = ? WHERE key = ?")
      .run(
        JSON.stringify({ ...pending, prompt, phase: "send" }),
        new Date().toISOString(),
        pendingCloudLaunchKey(trackedWorkspaceId)
      );
    return true;
  })();
}

/** Record the API receipt without losing crash-recovery evidence. */
export function markPendingCloudLaunchSent(
  trackedWorkspaceId: string,
  messageId: string,
  workspaceId: string,
  sessionId: string
): boolean {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(
      `SELECT status,
              conductor_workspace_id,
              conductor_session_id,
              conductor_backend_kind
       FROM workspaces WHERE id = ?`
    ).get(trackedWorkspaceId) as
      | {
          status?: string;
          conductor_workspace_id?: string | null;
          conductor_session_id?: string | null;
          conductor_backend_kind?: string | null;
        }
      | undefined;
    const pending = decodePendingCloudLaunch(
      db.prepare("SELECT value FROM meta WHERE key = ?")
        .get(pendingCloudLaunchKey(trackedWorkspaceId)) as
        | { value?: string }
        | undefined
    );
    if (!pending) {
      // A restart poller may have finalized this exact launch while the
      // foreground POST response was still in flight.
      return finalizedCloudLaunchMatchesInTransaction(
        db,
        trackedWorkspaceId,
        workspaceId,
        sessionId,
        messageId
      );
    }
    // The binding columns were already read here but never compared, so a
    // rebound row could mark an old prompt sent against a new session.
    if (
      row?.status !== "starting" ||
      row.conductor_workspace_id !== workspaceId ||
      row.conductor_session_id !== sessionId ||
      pending?.phase !== "send" ||
      pending.messageId !== messageId ||
      pending.workspaceId !== workspaceId ||
      pending.sessionId !== sessionId
    ) {
      return false;
    }
    db.prepare("UPDATE meta SET value = ?, updated_at = ? WHERE key = ?")
      .run(
        JSON.stringify({ ...pending, phase: "sent" }),
        new Date().toISOString(),
        pendingCloudLaunchKey(trackedWorkspaceId)
      );
    return true;
  })();
}

/** Atomically bind, anchor, and activate a first prompt with a durable receipt. */
export function finalizePendingCloudLaunch(input: {
  trackedWorkspaceId: string;
  conductorWorkspaceName: string;
  workspaceId: string;
  sessionId: string;
  messageId: string;
  notice?: PendingCloudNoticeInput;
}): boolean {
  const db = getDb();
  return db.transaction(() => {
    const pending = decodePendingCloudLaunch(
      db.prepare("SELECT value FROM meta WHERE key = ?")
        .get(pendingCloudLaunchKey(input.trackedWorkspaceId)) as
        | { value?: string }
        | undefined
    );
    const row = db.prepare(
      `SELECT status,
              conductor_workspace_id,
              conductor_session_id,
              conductor_backend_kind
       FROM workspaces WHERE id = ?`
    ).get(input.trackedWorkspaceId) as
      | {
          status?: string;
          conductor_workspace_id?: string | null;
          conductor_session_id?: string | null;
          conductor_backend_kind?: string | null;
        }
      | undefined;
    if (!pending) {
      return finalizedCloudLaunchMatchesInTransaction(
        db,
        input.trackedWorkspaceId,
        input.workspaceId,
        input.sessionId,
        input.messageId
      );
    }
    if (
      row?.status !== "starting" ||
      pending?.phase !== "sent" ||
      pending.workspaceId !== input.workspaceId ||
      pending.sessionId !== input.sessionId ||
      pending.messageId !== input.messageId
    ) {
      return false;
    }
    const updated = db.prepare(
      `UPDATE workspaces
       SET conductor_workspace_name = ?,
           conductor_workspace_id = ?,
           conductor_session_id = ?,
           conductor_backend_kind = 'cloud-api',
           status = 'running',
           last_forwarded_message_rowid = MAX(
             COALESCE(last_forwarded_message_rowid, 0), 0
           )
       WHERE id = ? AND status = 'starting'`
    ).run(
      input.conductorWorkspaceName,
      input.workspaceId,
      input.sessionId,
      input.trackedWorkspaceId
    );
    if (updated.changes !== 1) return false;
    upsertThreadCursor({
      workspaceId: input.trackedWorkspaceId,
      sessionId: input.sessionId,
      backendKind: "cloud-api",
      lastForwardedRowid: 0,
      lastMessageId: input.messageId,
    });
    if (input.notice) {
      appendPendingCloudNoticeInTransaction(
        db,
        input.trackedWorkspaceId,
        input.notice
      );
    }
    const finalizedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    ).run(
      finalizedCloudLaunchReceiptKey(input.trackedWorkspaceId),
      JSON.stringify({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        messageId: input.messageId,
        finalizedAt,
      } satisfies FinalizedCloudLaunchReceipt),
      finalizedAt
    );
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run(pendingCloudLaunchKey(input.trackedWorkspaceId));
    return true;
  })();
}

function markPendingCloudLaunchPhase(
  trackedWorkspaceId: string,
  phase: "cleanup" | "cancel",
  expected?: PendingCloudLaunchIdentity
): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  return db.transaction(() => {
    const pending = decodePendingCloudLaunch(
      db.prepare("SELECT value FROM meta WHERE key = ?")
        .get(pendingCloudLaunchKey(trackedWorkspaceId)) as
        | { value?: string }
        | undefined
    );
    if (!pending) return false;
    if (expected && !pendingCloudLaunchMatches(pending, expected)) {
      return false;
    }
    // Cancellation is terminal for prompt delivery. A racing send/cleanup
    // failure must never downgrade it and make reconciliation send again.
    if (pending.phase === "cancel" && phase === "cleanup") return false;
    // A durable API receipt must be finalized/reconciled, never converted
    // back into destructive cleanup by a stale pre-receipt owner.
    if (pending.phase === "sent" && phase === "cleanup") return false;
    db.prepare(
      `UPDATE meta SET value = ?, updated_at = ? WHERE key = ?`
    ).run(
      JSON.stringify({ ...pending, phase }),
      now,
      pendingCloudLaunchKey(trackedWorkspaceId)
    );
    if (phase === "cancel") {
      db.prepare("UPDATE workspaces SET status = 'stopped' WHERE id = ?")
        .run(trackedWorkspaceId);
      db.prepare("DELETE FROM meta WHERE key = ?")
        .run(pendingCloudMessagesKey(trackedWorkspaceId));
    }
    return true;
  })();
}

export function markPendingCloudLaunchForCleanup(
  trackedWorkspaceId: string,
  expected?: PendingCloudLaunchIdentity
): boolean {
  return markPendingCloudLaunchPhase(trackedWorkspaceId, "cleanup", expected);
}

/** Persist stop intent before calling the remote cancellation endpoint. */
export function markPendingCloudLaunchCanceled(
  trackedWorkspaceId: string,
  expected?: PendingCloudLaunchIdentity
): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  return db.transaction(() => {
    const workspace = db.prepare(
      `SELECT status,
              conductor_workspace_id,
              conductor_session_id,
              conductor_backend_kind
       FROM workspaces WHERE id = ?`
    ).get(trackedWorkspaceId) as
      | {
          status: WorkspaceStatus;
          conductor_workspace_id: string | null;
          conductor_session_id: string | null;
          conductor_backend_kind: string | null;
        }
      | undefined;
    const pending = decodePendingCloudLaunch(
      db.prepare("SELECT value FROM meta WHERE key = ?")
        .get(pendingCloudLaunchKey(trackedWorkspaceId)) as
        | { value?: string }
        | undefined
    );
    if (expected && !pendingCloudLaunchMatches(pending, expected)) {
      return false;
    }
    db.prepare(
      `UPDATE workspaces
       SET status = CASE WHEN status = 'archived' THEN status ELSE 'stopped' END
       WHERE id = ?`
    ).run(trackedWorkspaceId);
    if (pending) {
      db.prepare("UPDATE meta SET value = ?, updated_at = ? WHERE key = ?")
        .run(
          JSON.stringify({ ...pending, phase: "cancel" }),
          now,
          pendingCloudLaunchKey(trackedWorkspaceId)
        );
    }
    if (
      workspace?.conductor_backend_kind === "cloud-api" &&
      workspace.conductor_workspace_id &&
      workspace.conductor_session_id
    ) {
      persistPendingCloudTerminalIntentInTransaction(
        db,
        trackedWorkspaceId,
        {
          action: workspace.status === "archived" ? "archive" : "stop",
          workspaceId: workspace.conductor_workspace_id,
          sessionId: workspace.conductor_session_id,
          createdAt: now,
        }
      );
    }
    const outboxRow = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(pendingCloudMessagesKey(trackedWorkspaceId)) as
      | { value?: string }
      | undefined;
    const outbox = decodePendingCloudMessages(outboxRow?.value ?? null);
    recordPendingCloudMessageOutcomesInTransaction(
      db,
      trackedWorkspaceId,
      outbox,
      "suppressed",
      "workspace was stopped"
    );
    if (outbox.length > 0) {
      appendPendingCloudNoticeInTransaction(db, trackedWorkspaceId, {
        kind: "messages_suppressed",
        count: outbox.length,
        error: "workspace was stopped",
      });
    }
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run(pendingCloudMessagesKey(trackedWorkspaceId));
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run(cloudWorkLeasesKey(trackedWorkspaceId));
    return Boolean(
      pending ||
      (workspace?.conductor_backend_kind === "cloud-api" &&
        workspace.conductor_workspace_id &&
        workspace.conductor_session_id)
    );
  })();
}

export interface PendingCloudMessage {
  requestId: string;
  sessionId: string;
  messageId: string;
  prompt: string;
  createdAt: string;
}

export interface PendingCloudMessageOutcome {
  requestId: string;
  outcome: "delivered" | "suppressed" | "failed";
  error?: string;
  recordedAt: string;
}

function pendingCloudMessagesKey(trackedWorkspaceId: string): string {
  return `pending-cloud-messages:${trackedWorkspaceId}`;
}

function pendingCloudMessageOutcomesKey(trackedWorkspaceId: string): string {
  return `pending-cloud-message-outcomes:${trackedWorkspaceId}`;
}

function decodePendingCloudMessages(raw: string | null): PendingCloudMessage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is PendingCloudMessage =>
        entry &&
        typeof entry.requestId === "string" &&
        Boolean(entry.requestId) &&
        typeof entry.sessionId === "string" &&
        Boolean(entry.sessionId) &&
        typeof entry.messageId === "string" &&
        Boolean(entry.messageId) &&
        typeof entry.prompt === "string" &&
        typeof entry.createdAt === "string"
    );
  } catch {
    return [];
  }
}

function decodePendingCloudMessageOutcomes(
  raw: string | null
): PendingCloudMessageOutcome[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is PendingCloudMessageOutcome =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as PendingCloudMessageOutcome).requestId === "string" &&
        ["delivered", "suppressed", "failed"].includes(
          (entry as PendingCloudMessageOutcome).outcome
        ) &&
        typeof (entry as PendingCloudMessageOutcome).recordedAt === "string"
    );
  } catch {
    return [];
  }
}

function recordPendingCloudMessageOutcomesInTransaction(
  db: ReturnType<typeof getDb>,
  trackedWorkspaceId: string,
  messages: PendingCloudMessage[],
  outcome: PendingCloudMessageOutcome["outcome"],
  error?: string
): void {
  if (messages.length === 0) return;
  const key = pendingCloudMessageOutcomesKey(trackedWorkspaceId);
  const row = db.prepare("SELECT value FROM meta WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  const replacedIds = new Set(messages.map((message) => message.requestId));
  const retained = decodePendingCloudMessageOutcomes(
    row?.value ?? null
  ).filter((entry) => !replacedIds.has(entry.requestId));
  const now = new Date().toISOString();
  const recorded = messages.map((message) => ({
    requestId: message.requestId,
    outcome,
    ...(error ? { error } : {}),
    recordedAt: now,
  }));
  const bounded = [...retained, ...recorded].slice(-200);
  db.prepare(
    `INSERT INTO meta (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(bounded), now);
}

export function getPendingCloudMessageOutcome(
  trackedWorkspaceId: string,
  requestId: string
): PendingCloudMessageOutcome | null {
  return (
    decodePendingCloudMessageOutcomes(
      getMetaValue(pendingCloudMessageOutcomesKey(trackedWorkspaceId))
    ).find((entry) => entry.requestId === requestId) ?? null
  );
}

export function getPendingCloudMessages(
  trackedWorkspaceId: string
): PendingCloudMessage[] {
  return decodePendingCloudMessages(
    getMetaValue(pendingCloudMessagesKey(trackedWorkspaceId))
  );
}

/** Append one recovery request before any Cloud network send. */
export function enqueuePendingCloudMessage(
  trackedWorkspaceId: string,
  message: PendingCloudMessage
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction(() => {
    const binding = db.prepare(
      `SELECT conductor_session_id, conductor_backend_kind, status
       FROM workspaces WHERE id = ?`
    ).get(trackedWorkspaceId) as
      | {
          conductor_session_id: string | null;
          conductor_backend_kind: string | null;
          status: string;
        }
      | undefined;
    if (
      !binding ||
      binding.conductor_backend_kind !== "cloud-api" ||
      binding.conductor_session_id !== message.sessionId
    ) {
      throw new Error(
        `Cannot queue Cloud recovery message for an unbound session (${trackedWorkspaceId})`
      );
    }
    const launch = decodePendingCloudLaunch(
      db.prepare("SELECT value FROM meta WHERE key = ?")
        .get(pendingCloudLaunchKey(trackedWorkspaceId)) as
        | { value?: string }
        | undefined
    );
    const workLeaseRow = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(cloudWorkLeasesKey(trackedWorkspaceId)) as
      | { value?: string }
      | undefined;
    if (
      binding.status === "stopped" ||
      binding.status === "archived" ||
      binding.status === "failed" ||
      (!launch && decodeCloudWorkLeases(workLeaseRow?.value).length > 0) ||
      (launch &&
        launch.phase !== "provisioned" &&
        launch.phase !== "send" &&
        launch.phase !== "sent")
    ) {
      throw new Error(
        `Cannot queue Cloud recovery message while workspace is ${binding.status}`
      );
    }
    const existingRaw = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(pendingCloudMessagesKey(trackedWorkspaceId)) as
      | { value?: string }
      | undefined;
    const messages = decodePendingCloudMessages(existingRaw?.value ?? null);
    if (messages.some((entry) => entry.requestId === message.requestId)) return;
    if (messages.length >= 100) {
      throw new Error("Cloud recovery outbox is full");
    }
    db.prepare(
      `INSERT INTO meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    ).run(
      pendingCloudMessagesKey(trackedWorkspaceId),
      JSON.stringify([...messages, message]),
      now
    );
  })();
}

export function clearPendingCloudMessages(trackedWorkspaceId: string): void {
  getDb()
    .prepare("DELETE FROM meta WHERE key = ?")
    .run(pendingCloudMessagesKey(trackedWorkspaceId));
}

export type PendingCloudMessageGate =
  | "send"
  | "suppressed"
  | "mismatch"
  | "missing";

function pendingCloudMessageGateInTransaction(
  db: ReturnType<typeof getDb>,
  trackedWorkspaceId: string,
  requestId: string,
  workspaceId: string,
  sessionId: string
): PendingCloudMessageGate {
  const row = db.prepare(
    `SELECT status, conductor_workspace_id, conductor_session_id,
            conductor_backend_kind
     FROM workspaces WHERE id = ?`
  ).get(trackedWorkspaceId) as
    | {
        status: string;
        conductor_workspace_id: string | null;
        conductor_session_id: string | null;
        conductor_backend_kind: string | null;
      }
    | undefined;
  const outboxRow = db.prepare("SELECT value FROM meta WHERE key = ?")
    .get(pendingCloudMessagesKey(trackedWorkspaceId)) as
    | { value?: string }
    | undefined;
  const messages = decodePendingCloudMessages(outboxRow?.value ?? null);
  const message = messages.find((entry) => entry.requestId === requestId);
  if (!message) return "missing";
  if (
    !row ||
    row.conductor_backend_kind !== "cloud-api" ||
    row.conductor_workspace_id !== workspaceId ||
    row.conductor_session_id !== sessionId ||
    message.sessionId !== sessionId
  ) {
    return "mismatch";
  }
  const launch = decodePendingCloudLaunch(
    db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(pendingCloudLaunchKey(trackedWorkspaceId)) as
      | { value?: string }
      | undefined
  );
  if (
    row.status === "stopped" ||
    row.status === "archived" ||
    row.status === "failed" ||
    (launch && launch.phase !== "send")
  ) {
    return "suppressed";
  }
  return "send";
}

/** Current durable gate, checked immediately before each outbox POST. */
export function pendingCloudMessageCanSend(
  trackedWorkspaceId: string,
  requestId: string,
  workspaceId: string,
  sessionId: string
): PendingCloudMessageGate {
  const db = getDb();
  return db.transaction(() =>
    pendingCloudMessageGateInTransaction(
      db,
      trackedWorkspaceId,
      requestId,
      workspaceId,
      sessionId
    )
  )();
}

/** Remove a delivered entry only if no terminal intent raced its POST. */
export function completePendingCloudMessageDelivery(
  trackedWorkspaceId: string,
  requestId: string,
  workspaceId: string,
  sessionId: string,
  notices: {
    delivered?: PendingCloudNoticeInput;
    suppressed?: PendingCloudNoticeInput;
  } = {}
): PendingCloudMessageGate {
  const db = getDb();
  return db.transaction(() => {
    const gate = pendingCloudMessageGateInTransaction(
      db,
      trackedWorkspaceId,
      requestId,
      workspaceId,
      sessionId
    );
    if (gate === "missing") return gate;
    if (gate === "mismatch") return gate;
    const key = pendingCloudMessagesKey(trackedWorkspaceId);
    const row = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    const messages = decodePendingCloudMessages(row?.value ?? null);
    const delivered = messages.filter(
      (entry) => entry.requestId === requestId
    );
    const remaining = messages.filter(
      (entry) => entry.requestId !== requestId
    );
    if (gate === "suppressed") {
      recordPendingCloudMessageOutcomesInTransaction(
        db,
        trackedWorkspaceId,
        messages,
        "suppressed",
        notices.suppressed?.error
      );
      if (notices.suppressed) {
        appendPendingCloudNoticeInTransaction(
          db,
          trackedWorkspaceId,
          notices.suppressed
        );
      }
      db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    } else if (remaining.length === 0) {
      db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    } else {
      db.prepare("UPDATE meta SET value = ?, updated_at = ? WHERE key = ?")
        .run(JSON.stringify(remaining), new Date().toISOString(), key);
    }
    if (gate === "send" && notices.delivered) {
      appendPendingCloudNoticeInTransaction(
        db,
        trackedWorkspaceId,
        notices.delivered
      );
    }
    if (gate === "send") {
      recordPendingCloudMessageOutcomesInTransaction(
        db,
        trackedWorkspaceId,
        delivered,
        "delivered"
      );
      db.prepare(
        `UPDATE workspaces
         SET status = 'running'
         WHERE id = ?
           AND status NOT IN ('stopped', 'archived', 'failed')`
      ).run(trackedWorkspaceId);
    }
    return gate;
  })();
}

/** Clear recovery messages and persist the reason in the same transaction. */
export function clearPendingCloudMessagesWithNotice(
  trackedWorkspaceId: string,
  notice: PendingCloudNoticeInput,
  expected?: {
    sessionId: string;
    requestIds: readonly string[];
  }
): number {
  const db = getDb();
  return db.transaction(() => {
    const key = pendingCloudMessagesKey(trackedWorkspaceId);
    const row = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    const allMessages = decodePendingCloudMessages(row?.value ?? null);
    const expectedIds = expected ? new Set(expected.requestIds) : null;
    const messages = expected
      ? allMessages.filter(
          (message) =>
            message.sessionId === expected.sessionId &&
            expectedIds!.has(message.requestId)
        )
      : allMessages;
    const remaining = expected
      ? allMessages.filter(
          (message) =>
            message.sessionId !== expected.sessionId ||
            !expectedIds!.has(message.requestId)
        )
      : [];
    const count = messages.length;
    if (count === 0) return 0;
    recordPendingCloudMessageOutcomesInTransaction(
      db,
      trackedWorkspaceId,
      messages,
      notice.kind === "messages_suppressed" ? "suppressed" : "failed",
      notice.error
    );
    appendPendingCloudNoticeInTransaction(db, trackedWorkspaceId, {
      ...notice,
      count,
    });
    if (remaining.length === 0) {
      db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    } else {
      db.prepare("UPDATE meta SET value = ?, updated_at = ? WHERE key = ?")
        .run(JSON.stringify(remaining), new Date().toISOString(), key);
    }
    return count;
  })();
}

export function clearPendingCloudLaunch(
  trackedWorkspaceId: string,
  expected?: PendingCloudLaunchIdentity
): boolean {
  const db = getDb();
  return db.transaction(() => {
    if (expected) {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?")
        .get(pendingCloudLaunchKey(trackedWorkspaceId)) as
        | { value?: string }
        | undefined;
      if (!pendingCloudLaunchMatches(decodePendingCloudLaunch(row), expected)) {
        return false;
      }
    }
    return (
      db.prepare("DELETE FROM meta WHERE key = ?")
        .run(pendingCloudLaunchKey(trackedWorkspaceId)).changes > 0
    );
  })();
}

/** Clear a terminal launch saga only after its user-visible notice is durable. */
export function clearPendingCloudLaunchWithNotice(
  trackedWorkspaceId: string,
  notice: PendingCloudNoticeInput,
  expected?: PendingCloudLaunchIdentity
): boolean {
  const db = getDb();
  return db.transaction(() => {
    if (expected) {
      const pendingRow = db.prepare("SELECT value FROM meta WHERE key = ?")
        .get(pendingCloudLaunchKey(trackedWorkspaceId)) as
        | { value?: string }
        | undefined;
      if (
        !pendingCloudLaunchMatches(
          decodePendingCloudLaunch(pendingRow),
          expected
        )
      ) {
        return false;
      }
    }
    appendPendingCloudNoticeInTransaction(db, trackedWorkspaceId, notice);
    const outboxRow = db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(pendingCloudMessagesKey(trackedWorkspaceId)) as
      | { value?: string }
      | undefined;
    const outbox = decodePendingCloudMessages(outboxRow?.value ?? null);
    const outboxOutcome =
      notice.kind === "launch_canceled" ? "suppressed" : "failed";
    recordPendingCloudMessageOutcomesInTransaction(
      db,
      trackedWorkspaceId,
      outbox,
      outboxOutcome,
      notice.error
    );
    if (outbox.length > 0) {
      appendPendingCloudNoticeInTransaction(db, trackedWorkspaceId, {
        kind:
          outboxOutcome === "suppressed"
            ? "messages_suppressed"
            : "messages_failed",
        count: outbox.length,
        error:
          notice.error ??
          (outboxOutcome === "suppressed"
            ? "Cloud launch was canceled"
            : "Cloud launch failed"),
      });
    }
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run(pendingCloudLaunchKey(trackedWorkspaceId));
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run(pendingCloudMessagesKey(trackedWorkspaceId));
    return true;
  })();
}

// ── Repo Topics ────────────────────────────────────────────────

export function upsertRepoTopic(input: {
  chatId: string;
  repoPath: string;
  repoName: string;
  telegramThreadId: number;
}): RepoTopic {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO repo_topics
      (chat_id, repo_path, repo_name, telegram_thread_id, created_at, updated_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, repo_path) DO UPDATE SET
       repo_name = excluded.repo_name,
       telegram_thread_id = excluded.telegram_thread_id,
       updated_at = excluded.updated_at`
  ).run(
    input.chatId,
    input.repoPath,
    input.repoName,
    input.telegramThreadId,
    now,
    now,
    now
  );

  const topic = getRepoTopic(input.chatId, input.repoPath);
  if (!topic) {
    throw new Error(`Failed to upsert repo topic for ${input.repoPath}`);
  }
  return topic;
}

export function getRepoTopic(
  chatId: string,
  repoPath: string
): RepoTopic | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM repo_topics WHERE chat_id = ? AND repo_path = ?")
    .get(chatId, repoPath) as any;
  return row ? mapRepoTopicRow(row) : undefined;
}

export function getRepoTopicByThreadId(
  chatId: string,
  threadId: number
): RepoTopic | undefined {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM repo_topics WHERE chat_id = ? AND telegram_thread_id = ?"
    )
    .get(chatId, threadId) as any;
  return row ? mapRepoTopicRow(row) : undefined;
}

export function getRepoTopicsForChat(chatId: string): RepoTopic[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM repo_topics WHERE chat_id = ? ORDER BY repo_name ASC"
    )
    .all(chatId) as any[];
  return rows.map(mapRepoTopicRow);
}

export function deleteRepoTopic(chatId: string, repoPath: string): void {
  const db = getDb();
  db.prepare("DELETE FROM repo_topics WHERE chat_id = ? AND repo_path = ?").run(
    chatId,
    repoPath
  );
}

export function touchRepoTopic(chatId: string, repoPath: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE repo_topics
     SET last_used_at = ?, updated_at = ?
     WHERE chat_id = ? AND repo_path = ?`
  ).run(new Date().toISOString(), new Date().toISOString(), chatId, repoPath);
}

function mapRepoTopicRow(row: any): RepoTopic {
  return {
    chatId: row.chat_id,
    repoPath: row.repo_path,
    repoName: row.repo_name,
    telegramThreadId: Number(row.telegram_thread_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? null,
  };
}

// ── Route Attempts ─────────────────────────────────────────────

export function recordRouteAttempt(input: {
  chatId: string;
  source: RouteSource;
  telegramThreadId?: number | null;
  action?: string | null;
  repoPath?: string | null;
  repoName?: string | null;
  workspaceId?: string | null;
  status: RouteAttemptStatus;
  failureReason?: string | null;
}): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO route_attempts
        (chat_id, source, telegram_thread_id, action, repo_path, repo_name,
         workspace_id, status, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.chatId,
      input.source,
      input.telegramThreadId ?? null,
      input.action ?? null,
      input.repoPath ?? null,
      input.repoName ?? null,
      input.workspaceId ?? null,
      input.status,
      input.failureReason ?? null
    );
  return Number(result.lastInsertRowid);
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
    conductorWorkspaceId: row.conductor_workspace_id ?? null,
    conductorSessionId: row.conductor_session_id ?? null,
    conductorBackendKind:
      row.conductor_backend_kind === "local" ||
      row.conductor_backend_kind === "cloud-api"
        ? row.conductor_backend_kind
        : null,
    lastForwardedMessageRowid: Number(row.last_forwarded_message_rowid ?? 0),
    telegramThreadId: row.telegram_thread_id ?? null,
    archivedAt: row.archived_at ?? null,
  };
}

function mapThreadCursorRow(row: any): ThreadCursor {
  return {
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    backendKind:
      row.backend_kind === "cloud-api" ? "cloud-api" : "local",
    lastForwardedRowid: Number(row.last_forwarded_rowid ?? 0),
    lastMessageId: row.last_message_id ?? null,
    title: row.title ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  headSha?: string | null;
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
       head_ref, head_sha, base_ref, review_decision, merge_state_status, mergeable,
       checks_status, checks_summary, branch_exists, last_checked_at, last_error,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       repo_path = excluded.repo_path,
       branch = excluded.branch,
       pr_number = excluded.pr_number,
       pr_url = excluded.pr_url,
       title = excluded.title,
       state = excluded.state,
       is_draft = excluded.is_draft,
       head_ref = excluded.head_ref,
       head_sha = excluded.head_sha,
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
    input.headSha ?? null,
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
    headSha: row.head_sha ?? null,
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

// ── Merge confirmation intents ─────────────────────────────

export function createMergeIntent(input: {
  workspaceId: string;
  prNumber: number;
  headSha: string;
  requestedBy: string;
  ttlSeconds?: number;
}): MergeIntent {
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) {
    throw new Error("Merge intent requires a positive PR number");
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(input.headSha)) {
    throw new Error("Merge intent requires a full Git object ID");
  }
  const db = getDb();
  const now = new Date();
  const intent: MergeIntent = {
    intentId: randomUUID().replaceAll("-", ""),
    workspaceId: input.workspaceId,
    prNumber: input.prNumber,
    headSha: input.headSha.toLowerCase(),
    requestedBy: input.requestedBy,
    expiresAt: new Date(now.getTime() + (input.ttlSeconds ?? 600) * 1000).toISOString(),
    consumedAt: null,
    createdAt: now.toISOString(),
  };
  db.transaction(() => {
    db.prepare(
      `UPDATE merge_intents SET consumed_at = ?
       WHERE workspace_id = ? AND consumed_at IS NULL`
    ).run(intent.createdAt, input.workspaceId);
    db.prepare(
      `INSERT INTO merge_intents
       (intent_id, workspace_id, pr_number, head_sha, requested_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      intent.intentId,
      intent.workspaceId,
      intent.prNumber,
      intent.headSha,
      intent.requestedBy,
      intent.expiresAt,
      intent.createdAt
    );
  })();
  return intent;
}

export function getMergeIntent(intentId: string): MergeIntent | undefined {
  const row = getDb()
    .prepare("SELECT * FROM merge_intents WHERE intent_id = ?")
    .get(intentId) as any;
  return row ? mapMergeIntentRow(row) : undefined;
}

export function consumeMergeIntent(
  intentId: string,
  requestedBy: string,
  now: Date = new Date()
): MergeIntent | undefined {
  const db = getDb();
  const consumedAt = now.toISOString();
  const consume = db.transaction(() => {
    const result = db.prepare(
      `UPDATE merge_intents SET consumed_at = ?
       WHERE intent_id = ? AND requested_by = ? AND consumed_at IS NULL
         AND expires_at > ?`
    ).run(consumedAt, intentId, requestedBy, consumedAt);
    if (result.changes !== 1) return undefined;
    const row = db.prepare("SELECT * FROM merge_intents WHERE intent_id = ?").get(intentId) as any;
    return row ? mapMergeIntentRow(row) : undefined;
  });
  return consume();
}

function mapMergeIntentRow(row: any): MergeIntent {
  return {
    intentId: row.intent_id,
    workspaceId: row.workspace_id,
    prNumber: Number(row.pr_number),
    headSha: row.head_sha,
    requestedBy: row.requested_by,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at ?? null,
    createdAt: row.created_at,
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

export function getPendingDecisionsForChat(
  chatId: string,
  limit = 20
): Decision[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT d.*
       FROM decisions d
       JOIN workspaces w ON w.id = d.workspace_id
       WHERE w.telegram_chat_id = ? AND d.answer IS NULL
       ORDER BY d.id DESC
       LIMIT ?`
    )
    .all(chatId, limit) as any[];
  return rows.map(mapDecisionRow);
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
