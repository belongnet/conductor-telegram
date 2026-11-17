/**
 * Human lane controls (cutover, rollback, archive approval, release, validate)
 * are approved with an emailed code: the standardized Belong OTP flow.
 *
 * A control from the owner with no live grant asks Command Center to email a
 * code, posts a prompt in the owner chat, and waits. Only the owner's reply to
 * that prompt consisting of exactly six digits is relayed for verification. The
 * code message is then deleted (best effort), the grant is kept in memory, and
 * the waiting controls run with the two approval headers. Later controls inside
 * the grant run directly; a 401 asking for a fresh code drops the grant and asks
 * again. Codes and grants are never written to disk or logs.
 */
import { createHash } from "node:crypto";
import type { Context } from "telegraf";
import {
  APPROVAL_CODE_PATTERN,
  ApprovalChannelError,
  approvalChannelFromEnv,
  type ApprovalChallenge,
  type ApprovalChannelClient,
} from "../lanes/approval-channel.js";
import { LaneStateStoreError, type LaneHumanApproval } from "../lanes/state-store.js";

export const APPROVAL_PROMPT_PREFIX = "Approval code sent to ";
/** How many controls may wait behind one emailed code. */
export const MAX_WAITING_CONTROLS = 5;
const DELETE_ATTEMPTS = 3;
const DELETE_RETRY_MS = 500;

/** The chat a control or a code reply came from, as the approval flow needs it. */
export interface ApprovalChat {
  chatId: string;
  /** The Telegram user who sent the message. */
  userId?: string;
  reply(text: string): Promise<void>;
  /** Posts the code prompt as a forced reply to the triggering message; returns its message id. */
  prompt(text: string): Promise<number>;
  deleteMessage(messageId: number): Promise<void>;
}

/** A message that may answer an approval prompt. */
export interface ApprovalMessage {
  messageId: number;
  /** Undefined when withheld text did not survive a restart. */
  text: string | undefined;
  replyToMessageId?: number;
  /** It replies to one of this bot's approval prompts, current or not. */
  repliesToPrompt: boolean;
  /** Durable ingestion kept its text out of storage, so nothing else may handle it. */
  withheld?: boolean;
}

/** A human-gated lane control waiting for a grant. */
export interface HumanLaneControl {
  /** Names the control in messages, such as `cutover growth-v2-…`. */
  label: string;
  /** Submits the control with the human proof and returns the confirmation to show. */
  submit(approval: LaneHumanApproval): Promise<string>;
}

interface Pending {
  chatId: string;
  userId: string;
  promptMessageId: number;
  challengeId: string;
  expiresAt: number;
  controls: HumanLaneControl[];
}

interface Ready {
  ownerChatId: string;
  ownerUserId: string;
  client: ApprovalChannelClient;
}

export interface LaneApprovalsOptions {
  /** Read on every use, so a changed owner or key takes effect without a restart. */
  env?: () => NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Fixed wording, so a refusal never carries provider text. */
export const APPROVAL_TEXT = {
  prompt: (hint: string, minutes: number) =>
    `${APPROVAL_PROMPT_PREFIX}${hint}. Reply to this message with the 6-digit code within ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
  accepted: (until: string) => `Code accepted. Approvals open until ${until} UTC.`,
  waiting:
    "An approval code is already waiting. Reply to the approval prompt with it; this control runs once the code is accepted.",
  queueFull:
    "Too many lane controls are waiting for approval. This control was not queued; reply to the approval prompt first.",
  expiredUnused: (count: number) =>
    `The previous approval code expired unused, so ${count} waiting lane ${count === 1 ? "control was" : "controls were"} not applied.`,
  promptFailed:
    "The approval code was emailed, but the prompt could not be posted. Nothing was applied; send the lane control again.",
  sendWait: (minutes?: number) =>
    `Too many approval codes were requested. ${minutes ? `Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}` : "Try again later"}. Nothing was applied.`,
  sendAttempts: "Approvals are paused after too many wrong codes. Try again later. Nothing was applied.",
  keyRefused: "Command Center refused the approval channel key. Check BELONG_APPROVAL_CHANNEL_KEY. Nothing was applied.",
  sendUnavailable: "The approval code service is unavailable. Nothing was applied; try again shortly.",
  invalid: "That code was not accepted. Reply to the approval prompt with the latest 6-digit code.",
  expired: "That code has expired. Nothing was applied; send the lane control again for a new code.",
  attempts: "Too many wrong codes. Nothing was applied; send the lane control again later for a new code.",
  verifyWait: (minutes?: number) =>
    `Too many tries right now. ${minutes ? `Wait ${minutes} ${minutes === 1 ? "minute" : "minutes"}` : "Wait a little"}, then reply to the approval prompt with the code again.`,
  verifyUnavailable:
    "The approval service did not answer. Nothing was applied yet; reply to the approval prompt with the code again.",
  digitsOnly: "Reply with only the 6-digit code.",
  bareCode: "To approve, reply to the approval prompt with the code. That message was not used.",
  stale: "That approval request is no longer pending. Send the lane control again for a new code.",
  alreadyOpen: (until: string) => `Approvals are already open until ${until} UTC. No code is needed.`,
  deleteFailed: "Telegram did not let me delete your code message. Delete it yourself.",
  ownerOnly: "Only the owner can approve lane controls.",
  ownerChatOnly: "Send lane controls that need approval from the owner chat.",
  needsOwner: "Lane approvals need OWNER_USER_ID so the code is bound to you. Nothing was applied.",
  notSetUp: (problem: string) => `Lane approvals are not set up: ${problem}. Nothing was applied.`,
  controlRefused: (label: string) =>
    `Command Center refused the approval for lane control ${label}. Check BELONG_APPROVAL_CHANNEL_KEY. Nothing was applied.`,
  controlFailed: (label: string, reason: string) => `Lane control ${label} was not applied: ${reason}`,
  freshRefused: (count: number) =>
    `Command Center asked for a fresh code again, so ${count} lane ${count === 1 ? "control was" : "controls were"} not applied. Send the lane control again.`,
  unexpected: "Lane approval stopped on an unexpected error. Check /lanes before trying again.",
} as const;

export class LaneApprovals {
  private pending: Pending | undefined;
  private cached: { key: string; client: ApprovalChannelClient } | undefined;
  private turn: Promise<void> = Promise.resolve();
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: LaneApprovalsOptions = {}) {
    this.env = options.env ?? (() => process.env);
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Runs a human-gated control now with a live grant, or after the owner's emailed code. */
  async submit(chat: ApprovalChat, control: HumanLaneControl): Promise<void> {
    await this.exclusive(async () => {
      const ready = this.ready();
      if ("problem" in ready) return say(chat, ready.problem);
      if (chat.userId !== ready.ownerUserId) return say(chat, APPROVAL_TEXT.ownerOnly);
      if (chat.chatId !== ready.ownerChatId) return say(chat, APPROVAL_TEXT.ownerChatOnly);
      const approval = ready.client.approval();
      if (approval) return this.run(chat, ready, [control], approval, false);
      return this.ask(chat, ready, [control]);
    }, chat);
  }

  /**
   * Whether the approval flow owns this message. When it does, the message is
   * handled here and must not be routed, stored or logged anywhere else.
   */
  claims(chat: Pick<ApprovalChat, "chatId" | "userId">, message: ApprovalMessage): boolean {
    if (message.withheld) return true;
    // A command is never a code, even sent as a reply to the prompt.
    if (message.text?.trimStart().startsWith("/")) return false;
    if (message.repliesToPrompt) return true;
    const pending = this.pending;
    if (!pending || chat.chatId !== pending.chatId) return false;
    if (message.replyToMessageId === pending.promptMessageId) return true;
    // A code typed without replying while one is awaited is still a code.
    return (
      chat.userId === pending.userId &&
      message.text !== undefined &&
      APPROVAL_CODE_PATTERN.test(message.text.trim())
    );
  }

  /** Handles a possible code reply. Returns false when the message is not the flow's. */
  async handleReply(chat: ApprovalChat, message: ApprovalMessage): Promise<boolean> {
    if (!this.claims(chat, message)) return false;
    await this.exclusive(() => this.answer(chat, message), chat);
    return true;
  }

  /** For durable ingestion: whether this raw Telegram message may carry a code. */
  mayCarryCode(message: TelegramMessageLike, botId?: number): boolean {
    const normalized = approvalMessageFrom(message, botId);
    return !!normalized && this.claims({ chatId: String(message.chat?.id), userId: senderOf(message) }, normalized);
  }

  private async answer(chat: ApprovalChat, message: ApprovalMessage): Promise<void> {
    const owner = ownerIdentity(this.env());
    // Only the owner's messages count. Anyone else's reply is dropped unread.
    if (!owner.userId || chat.userId !== owner.userId) return;
    const pending = this.pending;
    const text = message.text?.trim();
    const bound =
      !!pending && chat.chatId === pending.chatId && message.replyToMessageId === pending.promptMessageId;
    if (!pending || !bound || text === undefined) {
      if (mayHoldCode(text)) await this.removeCode(chat, message.messageId);
      // Typed without replying, or as a reply to an older prompt, while a code is awaited.
      if (pending && text !== undefined && this.now() < pending.expiresAt) return say(chat, APPROVAL_TEXT.bareCode);
      const live = this.cached?.client.grantExpiresAt();
      return say(chat, live ? APPROVAL_TEXT.alreadyOpen(clock(live)) : APPROVAL_TEXT.stale);
    }
    if (this.now() >= pending.expiresAt) {
      this.pending = undefined;
      if (mayHoldCode(text)) await this.removeCode(chat, message.messageId);
      return say(chat, APPROVAL_TEXT.expired);
    }
    if (!APPROVAL_CODE_PATTERN.test(text)) {
      // It may still hold the code in some other shape.
      if (mayHoldCode(text)) await this.removeCode(chat, message.messageId);
      return say(chat, APPROVAL_TEXT.digitsOnly);
    }
    const ready = this.ready();
    if ("problem" in ready || this.pending !== pending) {
      // The key or owner changed under this code; it belongs to the old setup.
      await this.removeCode(chat, message.messageId);
      return say(chat, "problem" in ready ? ready.problem : APPROVAL_TEXT.stale);
    }
    let grantExpiresAt: number;
    try {
      ({ expiresAt: grantExpiresAt } = await ready.client.verifyCode(pending.challengeId, text));
    } catch (error) {
      await this.removeCode(chat, message.messageId);
      if (error instanceof ApprovalChannelError && (error.reason === "expired" || error.reason === "attempts")) {
        this.pending = undefined;
      }
      return say(chat, verifyRefusalText(error));
    }
    this.pending = undefined;
    const deleted = await this.removeCode(chat, message.messageId);
    await say(chat, APPROVAL_TEXT.accepted(clock(grantExpiresAt)));
    if (!deleted) await say(chat, APPROVAL_TEXT.deleteFailed);
    const approval = ready.client.approval();
    if (!approval) return say(chat, APPROVAL_TEXT.freshRefused(pending.controls.length));
    await this.run(chat, ready, pending.controls, approval, true);
  }

  /** Emails a code and posts the prompt, or queues behind the code already on its way. */
  private async ask(chat: ApprovalChat, ready: Ready, controls: HumanLaneControl[]): Promise<void> {
    const pending = this.pending;
    if (pending && this.now() < pending.expiresAt) {
      if (pending.controls.length + controls.length > MAX_WAITING_CONTROLS) return say(chat, APPROVAL_TEXT.queueFull);
      pending.controls.push(...controls);
      return say(chat, APPROVAL_TEXT.waiting);
    }
    if (pending) {
      this.pending = undefined;
      if (pending.controls.length) await say(chat, APPROVAL_TEXT.expiredUnused(pending.controls.length));
    }
    let challenge: ApprovalChallenge;
    try {
      challenge = await ready.client.sendCode();
    } catch (error) {
      return say(chat, sendRefusalText(error));
    }
    let promptMessageId: number;
    try {
      promptMessageId = await chat.prompt(
        APPROVAL_TEXT.prompt(challenge.emailHint, Math.max(1, Math.round(challenge.expiresInSeconds / 60)))
      );
      if (!Number.isSafeInteger(promptMessageId) || promptMessageId <= 0) throw new Error("no prompt id");
    } catch {
      return say(chat, APPROVAL_TEXT.promptFailed);
    }
    this.pending = {
      chatId: chat.chatId,
      userId: ready.ownerUserId,
      promptMessageId,
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      controls: [...controls],
    };
  }

  /** Submits controls in order. Each is applied at most once; a stale grant asks for a new code. */
  private async run(
    chat: ApprovalChat,
    ready: Ready,
    controls: HumanLaneControl[],
    approval: LaneHumanApproval,
    freshGrant: boolean
  ): Promise<void> {
    for (let index = 0; index < controls.length; index++) {
      const control = controls[index];
      let confirmation: string;
      try {
        confirmation = await control.submit(approval);
      } catch (error) {
        if (error instanceof LaneStateStoreError && error.freshApprovalRequired) {
          ready.client.dropGrant();
          const rest = controls.slice(index);
          // A grant verified moments ago that is already refused will not get
          // better with another code; asking again would only loop.
          if (freshGrant) return say(chat, APPROVAL_TEXT.freshRefused(rest.length));
          return this.ask(chat, ready, rest);
        }
        await say(
          chat,
          error instanceof LaneStateStoreError && error.status === 401
            ? APPROVAL_TEXT.controlRefused(control.label)
            : APPROVAL_TEXT.controlFailed(
                control.label,
                error instanceof LaneStateStoreError ? error.message : "unexpected error"
              )
        );
        continue;
      }
      await say(chat, confirmation);
    }
  }

  /** Deletes a message that may hold a code: up to three tries, best effort. */
  private async removeCode(chat: ApprovalChat, messageId: number): Promise<boolean> {
    for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt++) {
      try {
        await chat.deleteMessage(messageId);
        return true;
      } catch {
        if (attempt < DELETE_ATTEMPTS) await this.sleep(DELETE_RETRY_MS * attempt);
      }
    }
    return false;
  }

  private ready(): Ready | { problem: string } {
    const env = this.env();
    const owner = ownerIdentity(env);
    if (!owner.chatId || !owner.userId) return { problem: APPROVAL_TEXT.needsOwner };
    const subject = `telegram:${owner.userId}`;
    const cacheKey = createHash("sha256")
      .update([env.COMMAND_CENTER_API_BASE_URL ?? "", env.BELONG_APPROVAL_CHANNEL_KEY ?? "", env.COMMAND_CENTER_API_KEY ?? "", subject].join("\n"))
      .digest("hex");
    if (this.cached?.key !== cacheKey) {
      const setup = approvalChannelFromEnv(env, subject, { fetchImpl: this.fetchImpl, now: this.now });
      if ("problem" in setup) {
        this.cached = undefined;
        return { problem: APPROVAL_TEXT.notSetUp(setup.problem) };
      }
      // A changed key or owner starts over: the old grant belonged to the old setup.
      this.cached = { key: cacheKey, client: setup.client };
      this.pending = undefined;
    }
    return { ownerChatId: owner.chatId, ownerUserId: owner.userId, client: this.cached.client };
  }

  /** One approval step at a time; a code reply never races the send it answers. */
  private exclusive(step: () => Promise<void>, chat: ApprovalChat): Promise<void> {
    const run = this.turn.then(async () => {
      try {
        await step();
      } catch {
        await say(chat, APPROVAL_TEXT.unexpected);
      }
    });
    this.turn = run.catch(() => undefined);
    return run;
  }
}

let shared: LaneApprovals | undefined;

/** The process's one approval flow: grants and the pending code are per process. */
export function laneApprovals(): LaneApprovals {
  return (shared ??= new LaneApprovals());
}

/** Replaces the shared flow; for tests and runtime wiring. */
export function setLaneApprovals(next: LaneApprovals | undefined): void {
  shared = next;
}

export interface TelegramMessageLike {
  message_id?: number;
  text?: unknown;
  chat?: { id?: number | string };
  from?: { id?: number | string; is_bot?: boolean };
  reply_to_message?: TelegramMessageLike;
  [key: string]: unknown;
}

/** One of this bot's approval prompts, recognised even after a restart forgot it. */
export function isApprovalPrompt(message: TelegramMessageLike | undefined, botId?: number): boolean {
  return (
    !!message &&
    message.from?.is_bot === true &&
    (botId === undefined || Number(message.from.id) === botId) &&
    typeof message.text === "string" &&
    message.text.startsWith(APPROVAL_PROMPT_PREFIX)
  );
}

/** The approval view of a Telegram text message, or undefined when it has no id. */
export function approvalMessageFrom(
  message: TelegramMessageLike | undefined,
  botId?: number,
  overrides: Partial<Pick<ApprovalMessage, "text" | "withheld">> = {}
): ApprovalMessage | undefined {
  if (!message || !Number.isSafeInteger(message.message_id)) return undefined;
  const text = "text" in overrides ? overrides.text : typeof message.text === "string" ? message.text : undefined;
  return {
    messageId: message.message_id!,
    text,
    replyToMessageId: Number.isSafeInteger(message.reply_to_message?.message_id)
      ? message.reply_to_message!.message_id
      : undefined,
    repliesToPrompt: isApprovalPrompt(message.reply_to_message, botId),
    withheld: overrides.withheld,
  };
}

/** The approval flow's view of a Telegraf chat. */
export function telegrafApprovalChat(ctx: Context): ApprovalChat {
  const chatId = String(ctx.chat?.id ?? "");
  const messageId = (ctx.message as { message_id?: number } | undefined)?.message_id;
  return {
    chatId,
    userId: ctx.from?.id === undefined ? undefined : String(ctx.from.id),
    reply: async (text) => {
      await ctx.reply(text);
    },
    prompt: async (text) => {
      const sent = await ctx.reply(text, {
        ...(messageId ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {}),
        reply_markup: { force_reply: true, selective: true },
      });
      return sent.message_id;
    },
    deleteMessage: async (id) => {
      await ctx.telegram.deleteMessage(chatId, id);
    },
  };
}

/** Durable ingestion keeps a possible code's text here, in memory only, until it is handled. */
const WITHHELD_TTL_MS = 15 * 60_000;
const WITHHELD_LIMIT = 16;
const WITHHELD_FIELD = "approval_text_withheld";
export const WITHHELD_APPROVAL_TEXT = "[approval reply withheld]";
const withheld = new Map<string, { text: string; at: number }>();

/**
 * Returns the update to persist. A message that may carry an approval code is
 * stored without its text, which stays in this process's memory for its handler.
 */
export function withholdApprovalText<T extends { [key: string]: unknown }>(update: T, botId?: number, now = Date.now()): T {
  const message = update.message as TelegramMessageLike | undefined;
  if (!message || typeof message.text !== "string" || !laneApprovals().mayCarryCode(message, botId)) return update;
  for (const [key, entry] of withheld) if (now - entry.at > WITHHELD_TTL_MS) withheld.delete(key);
  withheld.set(withheldKey(message.chat?.id, message.message_id), { text: message.text, at: now });
  while (withheld.size > WITHHELD_LIMIT) withheld.delete(withheld.keys().next().value!);
  return { ...update, message: { ...message, text: WITHHELD_APPROVAL_TEXT, [WITHHELD_FIELD]: true } };
}

export function isWithheldApprovalMessage(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as Record<string, unknown>)[WITHHELD_FIELD] === true;
}

/** Hands a withheld text to its handler once; undefined after a restart or expiry. */
export function takeWithheldApprovalText(chatId: unknown, messageId: unknown, now = Date.now()): string | undefined {
  const key = withheldKey(chatId, messageId);
  const entry = withheld.get(key);
  withheld.delete(key);
  return entry && now - entry.at <= WITHHELD_TTL_MS ? entry.text : undefined;
}

/** What the update log may show of a message: nothing that could be a code. */
export function loggableMessagePreview(message: TelegramMessageLike | undefined): string {
  if (!message) return "";
  if (typeof message.text === "string") {
    if (/(?:^|\D)\d{6}(?:\D|$)/.test(message.text) || isApprovalPrompt(message.reply_to_message)) {
      return "[text withheld]";
    }
    return message.text.slice(0, 50);
  }
  return message.photo ? "[photo]" : message.voice ? "[voice]" : "";
}

/** Lost text, or any decimal digit in any script, may be a code worth deleting. */
function mayHoldCode(text: string | undefined): boolean {
  return text === undefined || /\p{Nd}/u.test(text);
}

function withheldKey(chatId: unknown, messageId: unknown): string {
  return `${String(chatId)}:${String(messageId)}`;
}

function senderOf(message: TelegramMessageLike): string | undefined {
  return message.from?.id === undefined ? undefined : String(message.from.id);
}

/** OWNER_USER_ID, or the private owner chat, which is the owner's own id. */
function ownerIdentity(env: NodeJS.ProcessEnv): { chatId?: string; userId?: string } {
  const chatId = env.OWNER_CHAT_ID?.trim();
  const userId = env.OWNER_USER_ID?.trim() || (chatId && /^[1-9]\d*$/.test(chatId) ? chatId : undefined);
  return {
    chatId: chatId && chatId !== "0" ? chatId : undefined,
    userId: userId && /^[1-9]\d*$/.test(userId) ? userId : undefined,
  };
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

function minutes(seconds?: number): number | undefined {
  return seconds === undefined ? undefined : Math.max(1, Math.ceil(seconds / 60));
}

function sendRefusalText(error: unknown): string {
  if (!(error instanceof ApprovalChannelError)) return APPROVAL_TEXT.sendUnavailable;
  if (error.reason === "wait") return APPROVAL_TEXT.sendWait(minutes(error.retryAfterSeconds));
  if (error.reason === "attempts") return APPROVAL_TEXT.sendAttempts;
  return error.channelKeyRefused ? APPROVAL_TEXT.keyRefused : APPROVAL_TEXT.sendUnavailable;
}

function verifyRefusalText(error: unknown): string {
  if (!(error instanceof ApprovalChannelError)) return APPROVAL_TEXT.verifyUnavailable;
  switch (error.reason) {
    case "invalid":
      return APPROVAL_TEXT.invalid;
    case "expired":
      return APPROVAL_TEXT.expired;
    case "attempts":
      return APPROVAL_TEXT.attempts;
    case "wait":
      return APPROVAL_TEXT.verifyWait(minutes(error.retryAfterSeconds));
    default:
      return error.channelKeyRefused ? APPROVAL_TEXT.keyRefused : APPROVAL_TEXT.verifyUnavailable;
  }
}

async function say(chat: ApprovalChat, text: string): Promise<void> {
  try {
    await chat.reply(text);
  } catch {
    // A lost acknowledgement must not undo or repeat an approval step.
  }
}
