import type { GatewayStore, QueueRow } from "./store.js";
import { linkTelegramMessage, updateWorkspaceThreadId, getWorkspace, getWorkspaceByThreadId } from "../store/queries.js";
import type { Workspace } from "../types/index.js";
import { createReadStream } from "node:fs";
import { escHtml, markdownToTelegramChunks, telegramReplyText } from "../bot/format.js";
import {ConductorApiError} from "../integrations/conductor-api.js";
import { clip } from "./names.js";

export type TelegramCall = (method: string, payload: Record<string, any>) => Promise<any>;
export interface TelegramJob {
  method: string;
  payload: Record<string, any>;
  workspaceId?: string;
  sessionId?: string;
  decisionId?: number;
  filePath?: string;
  /** Queue row id of the delivered message this edit targets; resolved at delivery time. */
  statusOf?: string;
  /** A replacement message becomes the durable target for later edits to this anchor. */
  replacementOf?: string;
  /** The work this message is about when it is not sent to that work's topic. A reply to it is still about that work. */
  about?: string;
  /** A retirement notice was queued before the workspace became terminal and may finish delivery afterward. */
  allowRetired?: boolean;
}
/** An edit waits this long for its acknowledgement before it is delivered as a message instead. */
const STATUS_ANCHOR_WAIT_MS = 300_000;
/** A card edit is silent. A failure that lands later than this may arrive after the owner stopped watching the card. */
export const ATTENTION_AFTER_MS = 15_000;

/** Retrying cannot change this outcome, so the row blocks at once and the owner reads why. */
export class TerminalError extends Error {
  constructor(message: string) { super(message); this.name = "TerminalError"; }
}

/** Conductor relays raw git and provider output, which can carry credentialed remotes or tokens. */
export function safeDetail(text: unknown, max = 300): string {
  const cleaned = String(text ?? "")
    .replace(/\/\/[^/\s@]+@/g, "//")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,})\b/g, "[redacted]")
    .replace(/bot\d+:[\w-]+/g, "bot[redacted]")
    .replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
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
  const conversation = `${p.chat_id}:${p.message_thread_id ?? 0}${topicOperation ? ":topics" : priority === 0 ? ":control" : ""}`;
  if (job.method === "editForumTopic" && !store.row(id)) {
    store.assertWriter?.();
    // Every edit of a topic waits in that topic's own lane, so the lane alone holds each edit this one replaces.
    const edits = store.db.prepare("SELECT id,payload FROM gateway_queue WHERE conversation=? AND kind='telegram' AND state='pending'").all(conversation) as Array<{id: string; payload: string}>;
    for (const edit of edits) {
      const prior = JSON.parse(edit.payload) as TelegramJob;
      if (prior.method === job.method && prior.payload.chat_id === p.chat_id && prior.payload.message_thread_id === p.message_thread_id) store.finish(edit.id, { supersededBy: id });
    }
  }
  store.enqueue("telegram", conversation, job, id, priority);
}

/** A forum workspace whose own topic is still being opened has no thread id yet, and neither does General. */
export function topicOpening(store: GatewayStore, workspaceId: string, threadId: number | null | undefined): boolean {
  return !!store.get(`topic-required:${workspaceId}`) && !threadId;
}

/**
 * Whether a turn's status card can be seen from its workspace's topic: delivered there rather than wherever the owner
 * wrote, and recent enough not to have scrolled out of view.
 */
export function statusCardSeen(store: GatewayStore, anchor: QueueRow, ws: Workspace, now = Date.now()): boolean {
  const card = JSON.parse(anchor.payload) as TelegramJob;
  const inTopic = card.workspaceId === ws.id || (!topicOpening(store, ws.id, ws.telegramThreadId) &&
    String(card.payload.chat_id) === ws.telegramChatId && (card.payload.message_thread_id ?? null) === (ws.telegramThreadId ?? null));
  return inTopic && now - anchor.created_at <= ATTENTION_AFTER_MS;
}

/** Agent Markdown is rendered before splitting; control messages stay literal. */
export function enqueueText(store: GatewayStore, id: string, chatId: string, text: string,
  options: { threadId?: number | null; workspaceId?: string; sessionId?: string; decisionId?: number; replyMarkup?: unknown; priority?: number; markdown?: boolean; silent?: boolean; about?: string; allowRetired?: boolean } = {}): void {
  const chunks: string[] = [];
  if (options.markdown) {
    text = telegramReplyText(text);
    if (!text) return;
    chunks.push(...markdownToTelegramChunks(text));
  } else {
    let current = "";
    for (const character of text || "(empty message)") {
      const escaped = escHtml(character);
      if (current.length + escaped.length > 3900) { chunks.push(current); current = ""; }
      current += escaped;
    }
    if (current) chunks.push(current);
  }
  chunks.forEach((chunk, i) => enqueueTelegram(store, `${id}:${i}`, {
    method: "sendMessage",
    payload: { chat_id: chatId, text: chunk, parse_mode: "HTML", link_preview_options: {is_disabled: true},
      ...(options.threadId ? { message_thread_id: options.threadId } : {}),
      ...(options.silent ? { disable_notification: true } : {}),
      ...(i === chunks.length - 1 && options.replyMarkup ? { reply_markup: options.replyMarkup } : {}) },
    workspaceId: options.workspaceId, sessionId: options.sessionId, decisionId: options.decisionId, about: options.about, allowRetired: options.allowRetired,
  }, options.priority));
}

/**
 * A turn has one status card: its acknowledgement, edited in place. The edit is queued in the
 * acknowledgement's own delivery lane, so the per-lane FIFO delivers the card before any edit of
 * it, across pacing retries and restarts alike. A newer state replaces an undelivered older one.
 */
export function enqueueStatus(store: GatewayStore, id: string,
  input: { anchorId: string; chatId: string; workspaceId?: string; sessionId?: string; text: string; replyMarkup?: unknown; about?: string }): void {
  enqueueEdit(store, id, {...input, text: escHtml(input.text)}, 0);
}

/** Only renderer-produced HTML reaches this internal helper. */
function enqueueEdit(store: GatewayStore, id: string,
  input: { anchorId: string; chatId: string; workspaceId?: string; sessionId?: string; text: string; replyMarkup?: unknown; about?: string }, priority: number): void {
  store.db.transaction(() => {
    if (store.row(id)) return;
    store.assertWriter?.();
    const anchor = store.row(input.anchorId);
    const chatId = anchor ? (JSON.parse(anchor.payload) as TelegramJob).payload.chat_id ?? input.chatId : input.chatId;
    const pending = store.db.prepare("SELECT id FROM gateway_queue WHERE kind='telegram' AND state='pending' AND json_extract(payload,'$.statusOf')=?")
      .all(input.anchorId) as Array<{ id: string }>;
    for (const prior of pending) store.finish(prior.id, { supersededBy: id });
    const job: TelegramJob = { method: "editMessageText", statusOf: input.anchorId, workspaceId: input.workspaceId, sessionId: input.sessionId, about: input.about,
      payload: { chat_id: chatId, text: input.text, parse_mode: "HTML", link_preview_options: {is_disabled: true},
        ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}) } };
    store.enqueue("telegram", anchor?.conversation ?? `${chatId}:0:control`, job, id, priority);
  })();
}

/** One quiet progress bubble per short turn update, with paced, coalesced edits and durable receipts. */
export function enqueueProgress(store: GatewayStore, id: string, turnKey: string, chatId: string, text: string,
  options: {workspaceId: string; sessionId: string; threadId?: number | null}): void {
  text = telegramReplyText(text);
  if (!text) return;
  const chunks = markdownToTelegramChunks(text);
  // Long progress reports remain complete, using the normal multi-message path.
  if (chunks.length !== 1) { enqueueText(store, id, chatId, text, {...options, markdown: true, silent: true}); return; }
  store.db.transaction(() => {
    const key = `telegram-progress:${turnKey}`;
    const prior = store.get<{anchorId: string; text: string}>(key);
    if (prior?.text === chunks[0]) return;
    if (!prior) {
      enqueueText(store, id, chatId, text, {...options, markdown: true, silent: true});
      store.set(key, {anchorId: `${id}:0`, text: chunks[0], updatedAt: Date.now()});
    } else {
      enqueueEdit(store, `${id}:edit`, {...options, chatId, anchorId: prior.anchorId, text: chunks[0]}, 10);
      store.set(key, {...prior, text: chunks[0], updatedAt: Date.now()});
    }
  })();
}

/** A card that cannot be edited still reports its state: the same text as a silent message, routed like any other. */
function asMessage(job: TelegramJob): TelegramJob {
  const payload: Record<string, any> = { ...job.payload, disable_notification: true };
  delete payload.message_id;
  const message: TelegramJob = { ...job, method: "sendMessage", payload, replacementOf: job.statusOf };
  delete message.statusOf;
  return message;
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
    if (job.statusOf) {
      const anchor = this.store.row(job.statusOf);
      const receipt = this.store.get<{message_id: number}>(`telegram-replacement:${job.statusOf}`) ??
        (anchor?.state === "done" && anchor.result ? JSON.parse(anchor.result) : undefined);
      if (receipt?.message_id) job.payload.message_id = receipt.message_id;
      else if (anchor && ["pending", "running"].includes(anchor.state) && now - row.created_at < STATUS_ANCHOR_WAIT_MS) {
        this.store.retry(row.id, "Waiting for the acknowledgement", 1000); return;
      } else { this.fallback(row, job, "The acknowledgement was not delivered"); return; }
    }
    try {
      if (job.workspaceId && job.payload.message_thread_id !== undefined) {
        const owner = getWorkspaceByThreadId(String(job.payload.chat_id), Number(job.payload.message_thread_id));
        if (owner && owner.id !== job.workspaceId) {
          this.store.finish(row.id, { suppressed: "Topic was adopted by newer work" }); return;
        }
        if (getWorkspace(job.workspaceId)?.archivedAt && job.method !== "closeForumTopic" && !(job.allowRetired && job.method === "sendMessage")) {
          this.store.finish(row.id, { suppressed: "Workspace retired before topic operation" }); return;
        }
      }
      const payload = { ...job.payload };
      if (job.workspaceId && job.method !== "editMessageText" && !/ForumTopic/.test(job.method)) {
        const workspace = getWorkspace(job.workspaceId);
        if (job.decisionId && (workspace?.archivedAt || ["done", "stopped", "failed", "archived"].includes(workspace?.status ?? ""))) {
          this.store.finish(row.id, {suppressed: "Question belongs to terminal work; retained in decision history"}); return;
        }
        // A workspace-targeted message cannot safely fall back to General after the workspace is retired or missing.
        // Owner replies use `about` instead, so they can still fall back when their closed topic refuses delivery.
        if (!workspace || (workspace.archivedAt && !job.allowRetired)) { this.store.finish(row.id, {suppressed: "Workspace retired before delivery"}); return; }
        if (topicOpening(this.store, job.workspaceId, workspace?.telegramThreadId)) {
          this.store.retry(row.id, "Waiting for workspace topic", 1000); return;
        }
        // A retirement notice may have been queued before this workspace got
        // a topic. Do not retarget that stale notice into a topic adopted by
        // newer work; it remains a General message instead.
        if (workspace?.telegramThreadId && !(job.allowRetired && workspace.archivedAt && job.payload.message_thread_id === undefined)) {
          payload.message_thread_id = workspace.telegramThreadId;
          const owner = getWorkspaceByThreadId(String(payload.chat_id), Number(payload.message_thread_id));
          if (owner && owner.id !== job.workspaceId) {
            this.store.finish(row.id, { suppressed: "Topic was adopted by newer work" }); return;
          }
        }
      }
      if (job.filePath) payload.document = { source: createReadStream(job.filePath), filename: payload.filename };
      delete payload.filename;
      const result = await this.call(job.method, payload);
      this.store.db.transaction(() => {
        // Recovery can retarget a notice while its Telegram request is in
        // flight. relinkNotice updates the durable payload; consult it after
        // the network call so this receipt cannot restore the stale session
        // snapshot captured when the row was claimed.
        const durableJob = JSON.parse(
          this.store.row(row.id)?.payload ?? row.payload,
        ) as TelegramJob;
        this.store.finish(row.id, result);
        const linked = durableJob.workspaceId ?? durableJob.about;
        if (result?.message_id && linked) linkTelegramMessage(
          String(payload.chat_id),
          String(result.message_id),
          linked,
          durableJob.sessionId,
        );
        if (result?.message_id && durableJob.replacementOf) this.store.set(`telegram-replacement:${durableJob.replacementOf}`, {
          message_id: result.message_id, anchorId: durableJob.replacementOf, updatedAt: Date.now(),
        });
        if (result?.message_id && job.decisionId) this.store.linkDecision(String(payload.chat_id), result.message_id, job.decisionId);
        if (result?.message_thread_id && job.method === "createForumTopic" && job.workspaceId) {
          updateWorkspaceThreadId(job.workspaceId, result.message_thread_id);
          // The workspace can be retired while its topic creation is in flight. Close what nobody will use.
          if (getWorkspace(job.workspaceId)?.archivedAt) enqueueTelegram(this.store, `retire-topic:${job.workspaceId}`, { method: "closeForumTopic",
            workspaceId: job.workspaceId, payload: { chat_id: payload.chat_id, message_thread_id: result.message_thread_id } }, 20);
        }
        this.store.set("delivery-last-success", Date.now());
        this.store.set(chatKey, Date.now() + (String(payload.chat_id).startsWith("-") ? 3100 : 1100));
      })();
    } catch (error) {
      const failure = telegramFailure(error);
      if (failure.unchanged) {
        this.store.db.transaction(() => {
          const durableJob = JSON.parse(
            this.store.row(row.id)?.payload ?? row.payload,
          ) as TelegramJob;
          this.store.finish(row.id, true);
          // Telegram returns an error rather than the edited Message when the prior attempt already
          // applied the same text. Restore the reply association from the resolved anchor receipt.
          const linked = durableJob.workspaceId ?? durableJob.about;
          if (job.payload.message_id && linked) linkTelegramMessage(
            String(job.payload.chat_id),
            String(job.payload.message_id),
            linked,
            durableJob.sessionId,
          );
        })();
        return;
      }
      // The card was deleted or cannot be edited; its state still has to reach the topic.
      if (job.method === "editMessageText" && failure.permanent) { this.fallback(row, job, failure.description); return; }
      const topicOf = job.workspaceId ?? job.about;
      if (/message thread not found|message_thread_not_found|topic_deleted|TOPIC_ID_INVALID|TOPIC_CLOSED/i.test(failure.description) && topicOf) {
        // A topic that is gone takes no new name. Opening one only to rename it would bring back a topic the owner
        // deleted, and the edit would still point at the old one. A message that needs the topic opens it, under the
        // workspace's current name.
        if (job.method === "editForumTopic" && !/TOPIC_CLOSED/i.test(failure.description)) {
          this.store.finish(row.id, { suppressed: "Topic no longer exists" }); return;
        }
        // Recover through the same durable topic-operation queue. Do not leak into General.
        const ws = getWorkspace(topicOf);
        if (ws && !ws.archivedAt && ws.status !== "archived" && job.workspaceId) {
          enqueueTelegram(this.store, `topic-recover:${row.id}`, {
            method: /TOPIC_CLOSED/i.test(failure.description) ? "reopenForumTopic" : "createForumTopic",
            payload: { chat_id: ws.telegramChatId, name: clip(ws.conductorWorkspaceName ?? ws.name, 128),
              ...(/TOPIC_CLOSED/i.test(failure.description) ? { message_thread_id: ws.telegramThreadId } : {}) }, workspaceId: ws.id,
          }, 0);
          this.store.retry(row.id, failure.description, 5000, row.attempts > 5);
          return;
        }
        // An answer to the owner, written about retired work, reaches them in General when its closed topic
        // refuses it: the owner asked and is owed a reply. Retired work's own late messages keep their history and
        // are dropped, because a permanently blocked delivery row would hold gateway readiness down for good.
        if (ws && !job.workspaceId && job.method === "sendMessage" && job.payload.message_thread_id) {
          this.fallback(row, { ...job, payload: { ...job.payload, message_thread_id: undefined } }, "Topic closed; answering in General"); return;
        }
        if (ws) { this.store.finish(row.id, { suppressed: "Topic closed for retired work" }); return; }
      }
      this.store.retry(row.id, failure.description, failure.delayMs, failure.permanent);
      if (!failure.permanent) this.store.set("telegram-not-before", Date.now() + failure.delayMs);
    }
  }

  /** Rewrite the durable row so a restart delivers the message, not another doomed edit. */
  private fallback(row: QueueRow, job: TelegramJob, reason: string): void {
    this.store.assertWriter?.();
    this.store.db.prepare("UPDATE gateway_queue SET payload=? WHERE id=?").run(JSON.stringify(asMessage(job)), row.id);
    this.store.retry(row.id, reason, 0);
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

/**
 * Blocked work is reported once. The turn's own card says what happened, so it never stays at its
 * acknowledgement. A ringing message follows only when nobody is likely to be watching that card.
 */
export function reportBlocked(store: GatewayStore, ownerChatId: string, now = Date.now()): void {
  const rows = store.db.prepare("SELECT id,kind,error,payload FROM gateway_queue WHERE state='blocked' AND kind!='telegram'")
    .all() as Array<{ id: string; kind: string; error: string | null; payload: string }>;
  for (const row of rows) {
    // The fence key predates the card. Renaming it would report every historical blocked row again.
    if (store.get(`blocked-notified:${row.id}`)) continue;
    const payload = JSON.parse(row.payload);
    const trackedId: string | undefined = payload.trackedId ?? payload.action?.trackedId;
    const anchorId: string | undefined = payload.statusId ?? payload.action?.statusId;
    const anchor = anchorId ? store.row(anchorId) : undefined;
    const ws = trackedId ? getWorkspace(trackedId) : undefined;
    const live = ws && !ws.archivedAt ? ws : undefined;
    const reason = row.error ?? "Operation failed";
    store.db.transaction(() => {
      // Retired work has no topic to follow, yet what is said about it is still about it: a reply is answered as such.
      const about = live ? undefined : ws?.id;
      // A launch that stopped short after Conductor created the workspace still owes the owner the way to it.
      const link = live ? store.get<string>(`created-link:${live.id}`) : undefined;
      if (link) store.clear(`created-link:${live!.id}`);
      if (anchor) enqueueStatus(store, `blocked-card:${row.id}`, { anchorId: anchor.id, chatId: ws?.telegramChatId ?? ownerChatId,
        workspaceId: live?.id, about, text: `Not done: ${reason}${link ? `\n${link}` : ""}` });
      // The anchor's age, not the row's: a system continuation is young when it blocks, yet nobody is watching its card.
      if (!anchor || now - anchor.created_at > ATTENTION_AFTER_MS) {
        // A gateway-built route or media row names the chat it answers. A raw update can come from any chat, so it reports to the owner.
        const chatId = ws?.telegramChatId ?? (row.kind !== "update" && payload.chatId ? String(payload.chatId) : ownerChatId);
        const threadId = ws ? live?.telegramThreadId : row.kind !== "update" && payload.chatId ? payload.threadId : undefined;
        enqueueText(store, `blocked:${row.id}`, chatId, `${ws ? "Operation" : "Telegram operation"} needs attention: ${reason}${!anchor && link ? `\n${link}` : ""}`,
          { workspaceId: live?.id, about, threadId });
      }
      store.set(`blocked-notified:${row.id}`, true);
    })();
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
        const previous = store.get<number>(`retryable-failures:${row.id}`) ?? 0;
        store.set(`retryable-failures:${row.id}`, previous + 1);
        if (previous + 1 === 3) {
          const payload = JSON.parse(row.payload);
          const trackedId: string | undefined = payload.trackedId ?? payload.action?.trackedId;
          const anchorId: string | undefined = payload.statusId ?? payload.action?.statusId;
          const ws = trackedId ? getWorkspace(trackedId) : undefined;
          if (anchorId && ws && store.row(anchorId)) {
            enqueueStatus(store, `slow:${row.id}`, { anchorId, chatId: ws.telegramChatId, workspaceId: ws.id,
              text: "Conductor is not answering yet. Still trying; nothing was lost." });
          }
        }
        store.retry(row.id, error.message, Math.max(error.retryAfterMs, Math.min(60_000, row.attempts * 5000))); return;
      }
      if (error instanceof TerminalError) {
        store.retry(row.id, error.message.replace(/bot\d+:[\w-]+/g, "bot[redacted]"), 0, true); return;
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
