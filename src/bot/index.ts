import { Telegraf } from "telegraf";
import { getDb } from "../store/db.js";
import { authGuard } from "./middleware.js";
import {
  getTelegramCommands,
  registerCommands,
  trackDecisionMessage,
} from "./commands.js";
import {
  installCrashHandlers,
  startHeartbeat,
  supervisedInterval,
  getLogger,
} from "./supervisor.js";
import { initHeartbeat } from "../store/queries.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CONDUCTOR_WORKSPACES_DIR,
  getMaxSessionMessageRowId,
  getSessionMessagesAfter,
  getSessionResult,
  getWorkspaceSessionInfo,
  type SessionMessage,
} from "./launcher.js";
import {
  getAllThreadedWorkspaces,
  getAllWorkspaces,
  getArtifactEvents,
  getMaxEventId,
  getNewEvents,
  getWorkspace,
  linkTelegramMessage,
  updateWorkspaceConductorSession,
  updateWorkspaceForwardCursor,
  updateWorkspaceStatus,
} from "../store/queries.js";
import type {
  ArtifactPayload,
  HumanRequestPayload,
  StatusPayload,
  Workspace,
} from "../types/index.js";
import {
  btn,
  escHtml as esc,
  expandableQuote,
  formatStats,
  markdownToTelegramHtml,
  maybeExpandableQuote,
  styledButtons,
  styledKeyboard,
  TELEGRAM_MAX_TEXT,
  truncate as trunc,
  truncateHtml,
} from "./format.js";
import {
  ensureWorkspaceTopic,
  renameWorkspaceTopics,
  syncWorkspaceTopic,
} from "./forum.js";
import {
  classifyByExtension,
  extractInlineMedia,
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_MEDIA_GROUP_MAX,
  TELEGRAM_MAX_UPLOAD_BYTES,
  type InlineMediaItem,
} from "./media.js";
import { existsSync, statSync } from "node:fs";

const BOT_TOKEN = process.env.BOT_TOKEN;
const POLL_INTERVAL_MS = 5000;

const lifecycleLog = getLogger("bot");
const pollerLog = getLogger("poller");
const eventPollerLog = getLogger("event-poller");
const forumLog = getLogger("forum");

function readBotVersion(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/bot/index.js → ../.. → project root
    const pkgPath = path.resolve(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export const BOT_VERSION = readBotVersion();

function getOwnerChatId(): string | undefined {
  return process.env.OWNER_CHAT_ID;
}

function getOwnerUserId(): string | undefined {
  return process.env.OWNER_USER_ID;
}

if (!BOT_TOKEN || !getOwnerChatId()) {
  // When launched via CLI, config is already validated. This guard is for
  // direct `node dist/bot/index.js` invocations (legacy .env workflow).
  const missing = [
    !BOT_TOKEN && "BOT_TOKEN",
    !getOwnerChatId() && "OWNER_CHAT_ID",
  ].filter(Boolean);
  console.error(
    `ERROR: Missing required environment variable(s): ${missing.join(", ")}\n` +
    `CAUSE: Neither config.json nor env vars provide these values\n` +
    `FIX:   Run 'conductor-telegram setup' or set ${missing.join(" and ")} in your environment\n` +
    `       For manual Telegram bootstrap, you can temporarily set OWNER_CHAT_ID=0 and use /setup to configure the active chat`
  );
  process.exit(2);
}

// Initialize DB
getDb();

// Create bot
const bot = new Telegraf(BOT_TOKEN);

// Debug: log all incoming updates
bot.use((ctx, next) => {
  const msg = ctx.message as any;
  const preview = msg?.text?.slice(0, 50) ?? (msg?.photo ? "[photo]" : msg?.voice ? "[voice]" : "");
  console.log(`[update] type=${ctx.updateType} chat=${ctx.chat?.id} ${preview}`);
  return next();
});

// Auth: only respond to the owner
bot.use(
  authGuard(() => ({
    ownerChatId: getOwnerChatId(),
    ownerUserId: getOwnerUserId(),
  }))
);

// Register commands
registerCommands(bot);

async function syncTelegramCommands(): Promise<void> {
  const commands = getTelegramCommands();

  await bot.telegram.callApi("deleteMyCommands", {});
  await bot.telegram.callApi("deleteMyCommands", {
    scope: { type: "all_private_chats" },
  });
  const ownerChatId = getOwnerChatId();
  // scope: "chat" only accepts private-chat or channel IDs. Supergroup IDs
  // (starting with -100) will 400 here. Best-effort: try it for private
  // chats only, and tolerate any failure so startup is never blocked by a
  // commands-sync hiccup.
  if (ownerChatId && ownerChatId !== "0" && !ownerChatId.startsWith("-")) {
    try {
      await bot.telegram.callApi("deleteMyCommands", {
        scope: { type: "chat", chat_id: ownerChatId },
      });
    } catch (err) {
      lifecycleLog.warn("per-chat deleteMyCommands skipped:", err);
    }
  }
  await bot.telegram.setMyCommands(commands);
}

// ── Topic-safe message sending ───────────────────────────────

/**
 * Send a message to a workspace's topic, recreating the topic if it was deleted.
 */
async function sendToWorkspaceTopic(
  ws: Workspace,
  text: string,
  extra: Record<string, any> = {}
): ReturnType<typeof bot.telegram.sendMessage> {
  const threadOpts = ws.telegramThreadId
    ? { message_thread_id: ws.telegramThreadId }
    : {};
  try {
    return await bot.telegram.sendMessage(ws.telegramChatId, text, {
      ...extra,
      ...threadOpts,
    });
  } catch (err: any) {
    const msg = String(err?.message ?? "").toLowerCase();
    const isDeleted =
      msg.includes("message_thread_not_found") ||
      msg.includes("topic_deleted") ||
      msg.includes("thread not found") ||
      (msg.includes("bad request") && msg.includes("thread"));

    if (!isDeleted || !ws.telegramThreadId) throw err;

    const newThreadId = await ensureWorkspaceTopic(bot.telegram, ws);
    const newThreadOpts = newThreadId ? { message_thread_id: newThreadId } : {};
    return await bot.telegram.sendMessage(ws.telegramChatId, text, {
      ...extra,
      ...newThreadOpts,
    });
  }
}

/**
 * Send agent text plus any inline media items to a workspace's topic.
 *
 * - 0 media: same as `sendToWorkspaceTopic`.
 * - 1 media: singular `sendPhoto`/`sendDocument`/`sendVideo`/`sendAudio`/`sendAnimation`
 *   with the text as caption (or as a follow-up text message when text exceeds the
 *   1024-char Telegram caption cap).
 * - N media (2-10): one `sendMediaGroup` call with the caption attached to the first
 *   item. >10 splits into successive groups; the caption only rides the first group.
 * - HTML mode is forwarded for both the caption (when it fits) and the trailing text.
 * - Topic-recovery semantics mirror `sendToWorkspaceTopic`.
 */
async function sendForwardToWorkspaceTopic(
  ws: Workspace,
  htmlText: string,
  media: InlineMediaItem[]
): Promise<void> {
  if (media.length === 0) {
    await sendToWorkspaceTopic(ws, htmlText, { parse_mode: "HTML" })
      .then((sent) => {
        linkTelegramMessage(ws.telegramChatId, String(sent.message_id), ws.id);
      });
    return;
  }

  const captionFits = htmlText.length > 0 && htmlText.length <= TELEGRAM_CAPTION_MAX;
  const captionForFirst = captionFits ? htmlText : undefined;
  const trailingText = captionFits ? "" : htmlText;

  if (media.length === 1) {
    const item = media[0];
    const sentMessageId = await sendSingleMediaToWorkspaceTopic(
      ws,
      item,
      captionForFirst
    );
    if (sentMessageId !== null) {
      linkTelegramMessage(ws.telegramChatId, String(sentMessageId), ws.id);
    }
  } else {
    // Split into chunks of 10 (Telegram's media-group cap). The caption rides the
    // very first item of the very first group; the rest go captionless.
    let isFirstChunk = true;
    for (let i = 0; i < media.length; i += TELEGRAM_MEDIA_GROUP_MAX) {
      const chunk = media.slice(i, i + TELEGRAM_MEDIA_GROUP_MAX);
      const caption = isFirstChunk ? captionForFirst : undefined;
      isFirstChunk = false;
      const sentMessages = await sendMediaGroupToWorkspaceTopic(ws, chunk, caption);
      for (const sent of sentMessages) {
        linkTelegramMessage(ws.telegramChatId, String(sent.message_id), ws.id);
      }
    }
  }

  if (trailingText) {
    await sendToWorkspaceTopic(ws, trailingText, { parse_mode: "HTML" }).then((sent) => {
      linkTelegramMessage(ws.telegramChatId, String(sent.message_id), ws.id);
    });
  }
}

async function sendSingleMediaToWorkspaceTopic(
  ws: Workspace,
  item: InlineMediaItem,
  captionHtml: string | undefined
): Promise<number | null> {
  const baseExtra: Record<string, any> = captionHtml
    ? { caption: captionHtml, parse_mode: "HTML" }
    : {};
  const send = async (extra: Record<string, any>) => {
    const file = { source: item.filePath, filename: item.filename };
    switch (item.kind) {
      case "photo":
        return bot.telegram.sendPhoto(ws.telegramChatId, file as any, extra);
      case "video":
        return bot.telegram.sendVideo(ws.telegramChatId, file as any, extra);
      case "audio":
        return bot.telegram.sendAudio(ws.telegramChatId, file as any, extra);
      case "animation":
        return bot.telegram.sendAnimation(ws.telegramChatId, file as any, extra);
      case "document":
      default:
        return bot.telegram.sendDocument(ws.telegramChatId, file as any, extra);
    }
  };

  const threadOpts = ws.telegramThreadId ? { message_thread_id: ws.telegramThreadId } : {};
  try {
    const sent = await send({ ...baseExtra, ...threadOpts });
    return sent.message_id;
  } catch (err: any) {
    if (!isDeletedThreadError(err) || !ws.telegramThreadId) {
      eventPollerLog.error("media send error:", err);
      return null;
    }
    const newThreadId = await ensureWorkspaceTopic(bot.telegram, ws);
    const newThreadOpts = newThreadId ? { message_thread_id: newThreadId } : {};
    const sent = await send({ ...baseExtra, ...newThreadOpts });
    return sent.message_id;
  }
}

async function sendMediaGroupToWorkspaceTopic(
  ws: Workspace,
  items: InlineMediaItem[],
  captionHtml: string | undefined
): Promise<{ message_id: number }[]> {
  const group = items.map((item, index) => {
    const base: any = {
      type: item.kind === "animation" ? "document" : item.kind,
      media: { source: item.filePath, filename: item.filename },
    };
    if (index === 0 && captionHtml) {
      base.caption = captionHtml;
      base.parse_mode = "HTML";
    }
    return base;
  });

  const threadOpts = ws.telegramThreadId ? { message_thread_id: ws.telegramThreadId } : {};
  try {
    return await bot.telegram.sendMediaGroup(ws.telegramChatId, group, threadOpts);
  } catch (err: any) {
    if (!isDeletedThreadError(err) || !ws.telegramThreadId) {
      eventPollerLog.error("media group send error:", err);
      return [];
    }
    const newThreadId = await ensureWorkspaceTopic(bot.telegram, ws);
    const newThreadOpts = newThreadId ? { message_thread_id: newThreadId } : {};
    return await bot.telegram.sendMediaGroup(ws.telegramChatId, group, newThreadOpts);
  }
}

function isDeletedThreadError(err: any): boolean {
  const msg = String(err?.message ?? "").toLowerCase();
  return (
    msg.includes("message_thread_not_found") ||
    msg.includes("topic_deleted") ||
    msg.includes("thread not found") ||
    (msg.includes("bad request") && msg.includes("thread"))
  );
}

// ── Conductor session status polling ─────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;

function startSessionPoller(): void {
  pollTimer = supervisedInterval("poller", () => {
      const tracked = getAllWorkspaces(100);
      for (const ws of tracked) {
        if (!ws.conductorWorkspaceName) continue;
        // Scope by repo_path so two repos with the same workspace city name
        // (e.g. both have a "rotterdam") don't get their Conductor sessions
        // and forwarded messages cross-routed into each other's Telegram topics.
        const sessionInfo = getWorkspaceSessionInfo(
          ws.conductorWorkspaceName,
          ws.repoPath
        );
        if (!sessionInfo) continue;

        if (ws.conductorSessionId !== sessionInfo.sessionId) {
          updateWorkspaceConductorSession(ws.id, sessionInfo.sessionId);
          const baselineRowId = getMaxSessionMessageRowId(sessionInfo.sessionId);
          updateWorkspaceForwardCursor(ws.id, baselineRowId);
          continue;
        }

        const newMessages = getSessionMessagesAfter(
          sessionInfo.sessionId,
          ws.lastForwardedMessageRowid
        );
        if (newMessages.length > 0) {
          const wsDir = workspaceDirFor(ws);
          for (const message of newMessages) {
            const forwarded = formatForwardedMessage(
              ws.conductorWorkspaceName,
              message,
              wsDir
            );
            if (!forwarded) continue;
            sendForwardToWorkspaceTopic(ws, forwarded.text, forwarded.media)
              .catch((err) => pollerLog.error("forward error:", err));
          }
          updateWorkspaceForwardCursor(
            ws.id,
            newMessages[newMessages.length - 1].rowid
          );
        }

        const sessionStatus = sessionInfo.status;
        if (sessionStatus === "working" && ws.status !== "running") {
          updateWorkspaceStatus(ws.id, "running");
          if (ws.telegramThreadId) {
            syncWorkspaceTopic(bot.telegram, { ...ws, status: "running" }).catch((err) =>
              forumLog.error(`topic sync error ${ws.telegramThreadId}:`, err)
            );
          }
        }

        if (sessionStatus === "idle" && ws.status === "running") {
          updateWorkspaceStatus(ws.id, "done");
          const name = ws.conductorWorkspaceName ?? ws.name;
          const result = getSessionResult(ws.conductorWorkspaceName!, ws.repoPath);

          let msg = `✅ <b>${esc(name)}</b> finished`;
          if (result) {
            const stats = formatStats(result);
            if (stats) msg += `  <code>${stats}</code>`;
            if (result.resultText) {
              const resultHtml = maybeExpandableQuote(
                markdownToTelegramHtml(trunc(result.resultText, 3200))
              );
              msg += `\n\n${resultHtml}`;
              if (msg.length > TELEGRAM_MAX_TEXT) {
                msg = truncateHtml(msg, TELEGRAM_MAX_TEXT);
              }
            }
          }

          const postDoneButtons = styledKeyboard([
            [
              btn("🔍 Review Changes", `postdone:review:${ws.id}`),
              btn("🔀 Generate PR", `postdone:pr:${ws.id}`),
            ],
            [btn("Archive", `archive:${ws.id}`)],
          ]);

          sendToWorkspaceTopic(ws, msg, {
              parse_mode: "HTML",
              ...postDoneButtons,
            })
            .then(() => {
              if (ws.telegramThreadId) {
                syncWorkspaceTopic(bot.telegram, { ...ws, status: "done" }).catch((err) =>
                  forumLog.error(`topic sync error ${ws.telegramThreadId}:`, err)
                );
              }
            })
            .catch((err) => pollerLog.error("notify error:", err));
        } else if (sessionStatus === "error" && ws.status !== "failed") {
          updateWorkspaceStatus(ws.id, "failed");
          const name = ws.conductorWorkspaceName ?? ws.name;
          sendToWorkspaceTopic(ws, `🔴 <b>${esc(name)}</b> encountered an error.`, {
              parse_mode: "HTML",
              ...styledButtons([btn("Archive", `archive:${ws.id}`)]),
            })
            .then(() => {
              if (ws.telegramThreadId) {
                syncWorkspaceTopic(bot.telegram, { ...ws, status: "failed" }).catch((err) =>
                  forumLog.error(`topic sync error ${ws.telegramThreadId}:`, err)
                );
              }
            })
            .catch((err) => pollerLog.error("notify error:", err));
        }
      }
  }, POLL_INTERVAL_MS);
}

// ── Event polling (human_request → Telegram) ────────────────

let eventPollTimer: ReturnType<typeof setInterval> | null = null;
let lastEventId = 0;

function startEventPoller(): void {
  lastEventId = getMaxEventId();

  eventPollTimer = supervisedInterval("event-poller", () => {
      const events = getNewEvents(lastEventId);
      for (const event of events) {
        lastEventId = event.id;
        const ws = getWorkspace(event.workspaceId);

        if (event.type === "human_request") {
          const payload: HumanRequestPayload = JSON.parse(event.payload);
          const chatId = ws?.telegramChatId ?? getOwnerChatId()!;
          const wsName = ws?.conductorWorkspaceName ?? ws?.name ?? "unknown";

          const questionHtml = esc(payload.question);
          let text = `❓ <b>${esc(wsName)}</b> needs your input\n\n`;
          text += expandableQuote(questionHtml, 300);

          if (!payload.options?.length) {
            text += `\n\n<i>Reply to this message with text, a photo, or a voice message.</i>`;
          }

          const buttons = payload.options?.length
            ? styledButtons(
                payload.options.map((opt, i) =>
                  btn(opt, `decide:${payload.decisionId}:${i}`)
                )
              )
            : {};

          const sendFn = ws
            ? sendToWorkspaceTopic(ws, text, { parse_mode: "HTML", ...buttons })
            : bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML", ...buttons });
          sendFn
            .then((sentMsg) => {
              trackDecisionMessage(sentMsg.message_id, payload.decisionId);
            })
            .catch((err) => eventPollerLog.error("send error:", err));
        }

        // ── PR celebration: fireworks when a merge request is submitted ──
        if (event.type === "artifact" && ws) {
          try {
            const artifact: ArtifactPayload = JSON.parse(event.payload);
            if (artifact.type === "pr") {
              const wsName = ws.conductorWorkspaceName ?? ws.name ?? "unknown";

              const celebrationLines = [
                `🎆🎇🎆🎇🎆🎇🎆🎇`,
                ``,
                `🎉 <b>New PR submitted!</b>`,
                ``,
                `<b>${esc(wsName)}</b> just opened a pull request:`,
                `${esc(artifact.description)}`,
                artifact.url ? `\n🔗 <a href="${esc(artifact.url).replace(/"/g, "&quot;")}">${esc(artifact.url)}</a>` : "",
                ``,
                `🎆🎇🎆🎇🎆🎇🎆🎇`,
              ];
              const celebrationMsg = celebrationLines.filter(Boolean).join("\n");

              sendToWorkspaceTopic(ws, celebrationMsg, { parse_mode: "HTML" })
                .catch((err) => eventPollerLog.error("celebration send error:", err));
            } else if (artifact.type === "file") {
              const wsName = ws.conductorWorkspaceName ?? ws.name ?? "unknown";
              const wsDir = workspaceDirFor(ws);
              const localItem = resolveArtifactFile(artifact, wsDir);
              const captionHtml =
                `📎 <b>${esc(wsName)}</b>: ${esc(artifact.description)}` +
                (artifact.url && /^https?:\/\//i.test(artifact.url)
                  ? `\n🔗 <a href="${esc(artifact.url).replace(/"/g, "&quot;")}">${esc(artifact.url)}</a>`
                  : "");

              if (localItem) {
                sendForwardToWorkspaceTopic(ws, captionHtml, [localItem])
                  .catch((err) => eventPollerLog.error("file artifact send error:", err));
              } else {
                sendToWorkspaceTopic(ws, captionHtml, { parse_mode: "HTML" })
                  .catch((err) => eventPollerLog.error("file artifact send error:", err));
              }
            }
          } catch {
            // Ignore malformed artifact payloads
          }
        }

        // ── Merge congratulation ──────────────────────────────
        if (event.type === "status" && ws) {
          try {
            const payload: StatusPayload = JSON.parse(event.payload);
            const text = `${payload.status} ${payload.message}`.toLowerCase();
            if (
              text.includes("merged") ||
              text.includes("merge complete") ||
              text.includes("successfully merged") ||
              text.includes("pr merged") ||
              text.includes("pull request merged")
            ) {
              const wsName = ws.conductorWorkspaceName ?? ws.name;

              // Find any PR artifact URL for this workspace
              let prLink = "";
              const artifacts = getArtifactEvents(ws.id);
              for (const art of artifacts) {
                try {
                  const artPayload: ArtifactPayload = JSON.parse(art.payload);
                  if (artPayload.type === "pr" && artPayload.url) {
                    prLink = `\n\n🔗 <a href="${esc(artPayload.url)}">${esc(artPayload.description || "View PR")}</a>`;
                    break;
                  }
                } catch { /* skip malformed */ }
              }

              const congratsMsg =
                `🎉🎉🎉\n\n` +
                `<b>${esc(wsName)}</b> — PR merged successfully!` +
                prLink;

              sendToWorkspaceTopic(ws, congratsMsg, { parse_mode: "HTML" })
                .catch((err) => eventPollerLog.error("merge congrats error:", err));
            }
          } catch { /* skip malformed status payload */ }
        }

        if (ws?.telegramThreadId && (
          event.type === "human_request" ||
          event.type === "status" ||
          event.type === "artifact"
        )) {
          syncWorkspaceTopic(bot.telegram, ws).catch((err) =>
            forumLog.error(`topic sync error ${ws.telegramThreadId}:`, err)
          );
        }
      }
  }, POLL_INTERVAL_MS);
}

function formatForwardedMessage(
  workspaceName: string,
  message: SessionMessage,
  workspaceDir: string | null
): { text: string; media: InlineMediaItem[] } | null {
  if (message.role !== "assistant") {
    return null;
  }

  const text = extractAssistantText(message.content);
  if (!text) return null;

  // Strip markdown image/link refs that point at local files in the workspace,
  // and ship them as real Telegram attachments instead.
  const { cleanedText, media } = workspaceDir
    ? extractInlineMedia(text, workspaceDir)
    : { cleanedText: text, media: [] as InlineMediaItem[] };

  const headerLine = `🤖 <b>${esc(workspaceName)}</b>`;
  if (!cleanedText.trim()) {
    // Assistant turn was nothing but file refs. Send media with a bare header
    // (or nothing if there's also no media to ship).
    if (media.length === 0) return null;
    return { text: headerLine, media };
  }

  const formatted = markdownToTelegramHtml(trunc(cleanedText, 3200));
  const body = maybeExpandableQuote(formatted);
  const full = `${headerLine}\n\n${body}`;
  const truncated =
    full.length <= TELEGRAM_MAX_TEXT ? full : truncateHtml(full, TELEGRAM_MAX_TEXT);
  return { text: truncated, media };
}

function workspaceDirFor(ws: Workspace): string | null {
  if (!ws.conductorWorkspaceName) return null;
  const repoName = path.basename(ws.repoPath);
  const dir = path.join(CONDUCTOR_WORKSPACES_DIR, repoName, ws.conductorWorkspaceName);
  return existsSync(dir) ? dir : null;
}

function resolveArtifactFile(
  artifact: ArtifactPayload,
  wsDir: string | null
): InlineMediaItem | null {
  // Reuse the same shape as text-extracted media: only honor local-file refs,
  // skip remote URLs (they keep their <a href> link rendering above).
  const url = artifact.url ?? "";
  if (!url || /^https?:\/\//i.test(url)) return null;

  let p = url.startsWith("file://") ? url.slice("file://".length) : url;
  if (!path.isAbsolute(p) && wsDir) p = path.join(wsDir, p);
  if (!existsSync(p)) return null;
  try {
    const stat = statSync(p);
    if (!stat.isFile() || stat.size > TELEGRAM_MAX_UPLOAD_BYTES) return null;
  } catch {
    return null;
  }
  return {
    kind: classifyByExtension(p),
    filePath: p,
    filename: path.basename(p),
  };
}

function extractAssistantText(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.type === "result") {
      return null;
    }

    const msgContent = parsed?.message?.content;
    // Extract text parts first
    const text = extractTextParts(msgContent);

    // Also check for AskUserQuestion tool_use (question text is forwarded via
    // the decision/event system, so we just skip these to avoid double display)
    if (!text && Array.isArray(msgContent)) {
      const hasOnlyToolUse = msgContent.every(
        (block: any) =>
          block?.type === "tool_use" || block?.type === "thinking"
      );
      if (hasOnlyToolUse) return null;
    }

    return text || null;
  } catch {
    return null;
  }
}

function extractTextParts(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function logSetupHints(): void {
  lifecycleLog.info("Use /setup for guided private-chat and forum-topic configuration.");
  if (getOwnerChatId() === "0") {
    lifecycleLog.info(
      "Bootstrap mode enabled (OWNER_CHAT_ID=0). /start, /help, and /setup are allowed before auth so the bot can configure the active chat."
    );
  }
}

function formatAgo(fromIso: string | null | undefined, nowMs: number): string {
  if (!fromIso) return "never";
  const then = Date.parse(fromIso);
  if (!Number.isFinite(then)) return fromIso;
  const secs = Math.max(0, Math.round((nowMs - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

async function sendBootAnnouncement(
  previous: { lastKnownAliveAt: string | null; lastExitReason: string | null } | undefined,
  bootCount: number
): Promise<void> {
  const ownerChatId = getOwnerChatId();
  if (!ownerChatId || ownerChatId === "0") return;

  const version = BOT_VERSION ?? "unknown";
  const pid = process.pid;
  const now = Date.now();

  const lines = [
    `🟢 <b>conductor-telegram</b> online`,
    `<code>v${esc(version)} · pid ${pid} · boot #${bootCount}</code>`,
  ];

  if (previous?.lastKnownAliveAt) {
    const ago = formatAgo(previous.lastKnownAliveAt, now);
    const reason = previous.lastExitReason
      ? ` (${esc(previous.lastExitReason)})`
      : "";
    lines.push(`Last alive: ${ago}${reason}`);
  }

  try {
    await bot.telegram.sendMessage(ownerChatId, lines.join("\n"), {
      parse_mode: "HTML",
    });
  } catch (err) {
    lifecycleLog.warn("boot announcement failed:", err);
  }
}

// ── Start ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const { previous, bootCount } = initHeartbeat({
    pid: process.pid,
    version: BOT_VERSION,
  });

  const heartbeat = startHeartbeat();

  installCrashHandlers(() => {
    heartbeat.stop();
    if (pollTimer) clearInterval(pollTimer);
    if (eventPollTimer) clearInterval(eventPollTimer);
    try {
      bot.stop("SIGTERM");
    } catch {
      // best-effort
    }
  });

  bot.catch((err: any) => {
    lifecycleLog.error("telegraf error:", err);
  });

  try {
    await syncTelegramCommands();
  } catch (err) {
    lifecycleLog.warn("syncTelegramCommands failed, continuing without it:", err);
  }
  bot.launch();

  // Rename existing forum topics to new "workspace · repo" format
  const topicsWithThreads = getAllThreadedWorkspaces();
  if (topicsWithThreads.length > 0) {
    renameWorkspaceTopics(bot.telegram, topicsWithThreads).catch((err) =>
      lifecycleLog.error("topic rename error:", err)
    );
  }

  startSessionPoller();
  startEventPoller();
  lifecycleLog.info(
    `connected · polling every ${POLL_INTERVAL_MS / 1000}s · v${BOT_VERSION ?? "?"} · pid ${process.pid} · boot #${bootCount}`
  );
  logSetupHints();

  sendBootAnnouncement(previous, bootCount).catch((err) =>
    lifecycleLog.warn("boot announcement error:", err)
  );
}

main().catch((err) => {
  lifecycleLog.error("fatal:", err);
  process.exit(1);
});
