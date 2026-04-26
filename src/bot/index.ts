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
import type { ArtifactPayload, HumanRequestPayload, StatusPayload } from "../types/index.js";
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
  closeWorkspaceTopic,
  renameWorkspaceTopics,
  syncWorkspaceTopic,
} from "./forum.js";

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

// ── Conductor session status polling ─────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;

function startSessionPoller(): void {
  pollTimer = supervisedInterval("poller", () => {
      const tracked = getAllWorkspaces(100);
      for (const ws of tracked) {
        if (!ws.conductorWorkspaceName) continue;
        const sessionInfo = getWorkspaceSessionInfo(ws.conductorWorkspaceName);
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
          for (const message of newMessages) {
            const forwarded = formatForwardedMessage(
              ws.conductorWorkspaceName,
              message
            );
            if (!forwarded) continue;
            bot.telegram
              .sendMessage(ws.telegramChatId, forwarded, {
                parse_mode: "HTML",
                ...(ws.telegramThreadId ? { message_thread_id: ws.telegramThreadId } : {}),
              })
              .then((sent) => {
                linkTelegramMessage(
                  ws.telegramChatId,
                  String(sent.message_id),
                  ws.id
                );
              })
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
          const result = getSessionResult(ws.conductorWorkspaceName!);

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
              btn("🔍 Review Changes", `postdone:review:${ws.id}`, "primary"),
              btn("🔀 Generate PR", `postdone:pr:${ws.id}`, "success"),
            ],
            [btn("Archive", `archive:${ws.id}`, "secondary")],
          ]);

          bot.telegram
            .sendMessage(ws.telegramChatId, msg, {
              parse_mode: "HTML",
              ...postDoneButtons,
              ...(ws.telegramThreadId ? { message_thread_id: ws.telegramThreadId } : {}),
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
          bot.telegram
            .sendMessage(
              ws.telegramChatId,
              `🔴 <b>${esc(name)}</b> encountered an error.`,
              {
                parse_mode: "HTML",
                ...styledButtons([btn("Archive", `archive:${ws.id}`, "secondary")]),
                ...(ws.telegramThreadId ? { message_thread_id: ws.telegramThreadId } : {}),
              }
            )
            .then(() => {
              if (ws.telegramThreadId) {
                syncWorkspaceTopic(bot.telegram, { ...ws, status: "failed" }).catch((err) =>
                  forumLog.error(`topic sync error ${ws.telegramThreadId}:`, err)
                );
                closeWorkspaceTopic(bot.telegram, ws.telegramChatId, ws.telegramThreadId);
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
                  btn(opt, `decide:${payload.decisionId}:${i}`, "primary")
                )
              )
            : {};

          const threadOpts = ws?.telegramThreadId
            ? { message_thread_id: ws.telegramThreadId }
            : {};
          bot.telegram
            .sendMessage(chatId, text, { parse_mode: "HTML", ...buttons, ...threadOpts })
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
              const chatId = ws.telegramChatId ?? getOwnerChatId()!;
              const wsName = ws.conductorWorkspaceName ?? ws.name ?? "unknown";
              const threadOpts = ws.telegramThreadId
                ? { message_thread_id: ws.telegramThreadId }
                : {};

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

              bot.telegram
                .sendMessage(chatId, celebrationMsg, {
                  parse_mode: "HTML",
                  ...threadOpts,
                })
                .catch((err) => eventPollerLog.error("celebration send error:", err));
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
              const chatId = ws.telegramChatId ?? getOwnerChatId()!;

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

              const threadOpts = ws.telegramThreadId
                ? { message_thread_id: ws.telegramThreadId }
                : {};
              bot.telegram
                .sendMessage(chatId, congratsMsg, { parse_mode: "HTML", ...threadOpts })
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
  message: SessionMessage
): string | null {
  if (message.role !== "assistant") {
    return null;
  }

  const text = extractAssistantText(message.content);
  if (!text) return null;

  const header = `🤖 <b>${esc(workspaceName)}</b>\n\n`;
  const formatted = markdownToTelegramHtml(trunc(text, 3200));
  const body = maybeExpandableQuote(formatted);
  const full = header + body;
  return full.length <= TELEGRAM_MAX_TEXT
    ? full
    : truncateHtml(full, TELEGRAM_MAX_TEXT);
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
