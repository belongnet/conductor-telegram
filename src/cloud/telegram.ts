import type { GatewayStore, QueueRow } from "./store.js";
import { linkTelegramMessage, updateWorkspaceThreadId, getWorkspace } from "../store/queries.js";
import { createReadStream } from "node:fs";
import { escHtml } from "../bot/format.js";
import {ConductorApiError} from "../integrations/conductor-api.js";

export type TelegramCall = (method: string, payload: Record<string, any>) => Promise<any>;
export interface TelegramJob {
  method: string;
  payload: Record<string, any>;
  workspaceId?: string;
  sessionId?: string;
  decisionId?: number;
  filePath?: string;
}

export function telegramFailure(error: unknown): { delayMs: number; permanent: boolean; unchanged: boolean; conflict: boolean; description: string } {
  const e = error as any;
  const response = e?.response ?? e;
  const description = String(response?.description ?? e?.message ?? "Telegram request failed");
  const code = response?.error_code;
  const seconds = Number(response?.parameters?.retry_after);
  return {
    delayMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 + 250 : 5000,
    permanent: code === 400 || code === 401 || code === 403,
    unchanged: /TOPIC_NOT_MODIFIED|message is not modified|topic.*already (?:closed|open)/i.test(description),
    conflict: code === 409,
    description: description.replace(/bot\d+:[\w-]+/g, "bot[redacted]"),
  };
}

export function enqueueTelegram(store: GatewayStore, id: string, job: TelegramJob, priority = 10): void {
  const p = job.payload;
  const topicOperation = /ForumTopic/.test(job.method);
  if (job.method === "editForumTopic" && !store.row(id)) {
    store.assertWriter?.();
    const edits = store.db.prepare("SELECT id,payload FROM gateway_queue WHERE kind='telegram' AND state='pending'").all() as Array<{id: string; payload: string}>;
    for (const edit of edits) {
      const prior = JSON.parse(edit.payload) as TelegramJob;
      if (prior.method === job.method && prior.payload.chat_id === p.chat_id && prior.payload.message_thread_id === p.message_thread_id) store.finish(edit.id, { supersededBy: id });
    }
  }
  store.enqueue("telegram", `${p.chat_id}:${p.message_thread_id ?? 0}${topicOperation ? ":topics" : priority === 0 ? ":control" : ""}`, job, id, priority);
}

/** Chunk raw text before HTML escaping so no entity/tag is split and no text is lost. */
export function enqueueText(store: GatewayStore, id: string, chatId: string, text: string,
  options: { threadId?: number | null; workspaceId?: string; sessionId?: string; decisionId?: number; replyMarkup?: unknown; priority?: number } = {}): void {
  const chunks: string[] = []; let current = "", escapedSize = 0;
  for (const character of text || "(empty message)") {
    const length = escHtml(character).length;
    if (escapedSize + length > 3900) { chunks.push(current); current = ""; escapedSize = 0; }
    current += character; escapedSize += length;
  }
  if (current) chunks.push(current);
  chunks.forEach((chunk, i) => enqueueTelegram(store, `${id}:${i}`, {
    method: "sendMessage",
    payload: { chat_id: chatId, text: escHtml(chunk), parse_mode: "HTML",
      ...(options.threadId ? { message_thread_id: options.threadId } : {}),
      ...(i === chunks.length - 1 && options.replyMarkup ? { reply_markup: options.replyMarkup } : {}) },
    workspaceId: options.workspaceId, sessionId: options.sessionId, decisionId: options.decisionId,
  }, options.priority));
}

/** Single paced sender; receipts and routing links commit in the same SQLite transaction. */
export class TelegramDelivery {
  constructor(private readonly store: GatewayStore, private readonly call: TelegramCall) {}

  async tick(now = Date.now()): Promise<void> {
    if ((this.store.get<number>("telegram-not-before") ?? 0) > now) return;
    const row = this.store.claim(["telegram"], 1, now)[0];
    if (!row) { this.store.set("delivery-last-success", now); return; }
    const job = JSON.parse(row.payload) as TelegramJob;
    const chatKey = `telegram-chat-after:${job.payload.chat_id}`;
    const wait = (this.store.get<number>(chatKey) ?? 0) - now;
    if (wait > 0) { this.store.retry(row.id, "paced", wait); return; }
    try {
      const payload = { ...job.payload };
      if (job.workspaceId && !/ForumTopic/.test(job.method)) {
        const workspace = getWorkspace(job.workspaceId);
        if (job.decisionId && (workspace?.archivedAt || ["done", "stopped", "failed", "archived"].includes(workspace?.status ?? ""))) {
          this.store.finish(row.id, {suppressed: "Question belongs to terminal work; retained in decision history"}); return;
        }
        if (this.store.get(`topic-required:${job.workspaceId}`) && !workspace?.telegramThreadId) {
          this.store.retry(row.id, "Waiting for workspace topic", 1000); return;
        }
        if (workspace?.telegramThreadId) payload.message_thread_id = workspace.telegramThreadId;
      }
      if (job.filePath) payload.document = { source: createReadStream(job.filePath), filename: payload.filename };
      delete payload.filename;
      const result = await this.call(job.method, payload);
      this.store.db.transaction(() => {
        this.store.finish(row.id, result);
        if (result?.message_id && job.workspaceId) linkTelegramMessage(String(payload.chat_id), String(result.message_id), job.workspaceId, job.sessionId);
        if (result?.message_id && job.decisionId) this.store.linkDecision(String(payload.chat_id), result.message_id, job.decisionId);
        if (result?.message_thread_id && job.method === "createForumTopic" && job.workspaceId) updateWorkspaceThreadId(job.workspaceId, result.message_thread_id);
        this.store.set("delivery-last-success", Date.now());
        this.store.set(chatKey, Date.now() + (String(payload.chat_id).startsWith("-") ? 3100 : 1100));
      })();
    } catch (error) {
      const failure = telegramFailure(error);
      if (failure.unchanged) { this.store.finish(row.id, true); return; }
      if (/message thread not found|message_thread_not_found|topic_deleted|TOPIC_CLOSED/i.test(failure.description) && job.workspaceId) {
        // Recover through the same durable topic-operation queue. Do not leak into General.
        const ws = getWorkspace(job.workspaceId);
        if (ws && !ws.archivedAt && ws.status !== "archived") {
          enqueueTelegram(this.store, `topic-recover:${row.id}`, {
            method: /TOPIC_CLOSED/i.test(failure.description) ? "reopenForumTopic" : "createForumTopic",
            payload: { chat_id: ws.telegramChatId, name: (ws.conductorWorkspaceName ?? ws.name).slice(0, 128),
              ...(/TOPIC_CLOSED/i.test(failure.description) ? { message_thread_id: ws.telegramThreadId } : {}) }, workspaceId: ws.id,
          }, 0);
          this.store.retry(row.id, failure.description, 5000, row.attempts > 5);
          return;
        }
      }
      this.store.retry(row.id, failure.description, failure.delayMs, failure.permanent);
      if (!failure.permanent) this.store.set("telegram-not-before", Date.now() + failure.delayMs);
    }
  }
}

/** Telegram ingestion never waits for a Conductor operation or media conversion. */
export async function ingestTelegram(store: GatewayStore, call: TelegramCall, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const updates = await call("getUpdates", { offset: store.get<number>("telegram-offset") ?? 0, timeout: 30,
        allowed_updates: ["message", "callback_query"] });
      store.ingest(updates);
      store.set("ingestion-last-success", Date.now());
    } catch (error) {
      const failure = telegramFailure(error);
      // A shutdown aborts every fenced write at once, so recording why ingestion stopped
      // would itself throw, out of the handler, and turn a clean stop into a failure.
      if (!signal.aborted) store.set("ingestion-error", failure.description);
      // A second poller must be contained rather than repeatedly stealing the token.
      if (failure.conflict || failure.permanent) throw new Error(failure.description);
      await pause(failure.delayMs, signal);
    }
  }
}

export async function processQueue(store: GatewayStore, kinds: string[], handler: (row: QueueRow) => Promise<void>, limit = 4): Promise<void> {
  await Promise.all(store.claim(kinds, limit).map(row => processClaimedRow(store, row, handler)));
}

/** Independent workers keep an unrelated slow command from owning a whole batch. */
export class QueueDispatcher {
  private readonly running = new Set<Promise<void>>();
  constructor(private readonly store: GatewayStore, private readonly kinds: string[],
    private readonly handler: (row: QueueRow) => Promise<void>, private readonly concurrency = 4) {}

  tick(): void {
    const remaining = Math.max(0, this.concurrency - this.running.size);
    if (!remaining) return;
    for (const row of this.store.claim(this.kinds, remaining)) {
      const task = Promise.resolve().then(() => processClaimedRow(this.store, row, this.handler))
        // Lost leases fence persistence; the runtime owns lease failure handling.
        .catch(() => {})
        .finally(() => this.running.delete(task));
      this.running.add(task);
    }
  }

  async settled(): Promise<void> { await Promise.all(this.running); }
}

async function processClaimedRow(store: GatewayStore, row: QueueRow, handler: (row: QueueRow) => Promise<void>): Promise<void> {
    try { await handler(row); if (store.row(row.id)?.state === "running") store.finish(row.id); }
    catch (error) {
      if ((error as any)?.response?.error_code === 429) {
        const failure = telegramFailure(error);
        store.set("telegram-not-before", Date.now() + failure.delayMs);
        store.retry(row.id, failure.description, failure.delayMs); return;
      }
      if (error instanceof ConductorApiError && error.retryable) {
        store.retry(row.id, error.message, Math.max(error.retryAfterMs, Math.min(60_000, row.attempts * 5000))); return;
      }
      const previous = store.get<number>(`queue-failures:${row.id}`) ?? 0;
      store.set(`queue-failures:${row.id}`, previous + 1);
      store.retry(row.id, error instanceof Error ? error.message.replace(/bot\d+:[\w-]+/g, "bot[redacted]") : "Operation failed", Math.min(60_000, (previous + 1) * 5000), previous >= 4);
    }
}

export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
