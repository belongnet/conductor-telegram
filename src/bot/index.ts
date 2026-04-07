import { Telegraf } from "telegraf";
import { getDb } from "../store/db.js";
import { authGuard } from "./middleware.js";
import {
  getTelegramCommands,
  registerCommands,
  trackDecisionMessage,
} from "./commands.js";
import {
  getMaxSessionMessageRowId,
  getSessionMessagesAfter,
  getSessionResult,
  getWorkspaceSessionInfo,
  type SessionMessage,
} from "./launcher.js";
import {
  getAllWorkspaces,
  getMaxEventId,
  getNewEvents,
  getWorkspace,
  linkTelegramMessage,
  updateWorkspaceConductorSession,
  updateWorkspaceForwardCursor,
  updateWorkspaceStatus,
} from "../store/queries.js";
import type { HumanRequestPayload } from "../types/index.js";
import {
  btn,
  escHtml as esc,
  expandableQuote,
  formatStats,
  markdownToTelegramHtml,
  maybeExpandableQuote,
  styledButtons,
  truncate as trunc,
} from "./format.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const POLL_INTERVAL_MS = 5000;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN environment variable is required");
  process.exit(1);
}

if (!OWNER_CHAT_ID) {
  console.error("OWNER_CHAT_ID environment variable is required");
  process.exit(1);
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
bot.use(authGuard(OWNER_CHAT_ID));

// Register commands
registerCommands(bot);

async function syncTelegramCommands(): Promise<void> {
  const commands = getTelegramCommands();

  await bot.telegram.callApi("deleteMyCommands", {});
  await bot.telegram.callApi("deleteMyCommands", {
    scope: { type: "all_private_chats" },
  });
  await bot.telegram.callApi("deleteMyCommands", {
    scope: { type: "chat", chat_id: OWNER_CHAT_ID! },
  });
  await bot.telegram.setMyCommands(commands);
}

// ── Conductor session status polling ─────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;

function startSessionPoller(): void {
  pollTimer = setInterval(() => {
    try {
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
              .sendMessage(ws.telegramChatId, forwarded, { parse_mode: "HTML" })
              .then((sent) => {
                linkTelegramMessage(
                  ws.telegramChatId,
                  String(sent.message_id),
                  ws.id
                );
              })
              .catch((err) => console.error(`[poller] forward error:`, err));
          }
          updateWorkspaceForwardCursor(
            ws.id,
            newMessages[newMessages.length - 1].rowid
          );
        }

        const sessionStatus = sessionInfo.status;
        if (sessionStatus === "working" && ws.status !== "running") {
          updateWorkspaceStatus(ws.id, "running");
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
              msg += `\n\n${maybeExpandableQuote(
                markdownToTelegramHtml(trunc(result.resultText, 800))
              )}`;
            }
          }

          bot.telegram
            .sendMessage(ws.telegramChatId, msg, { parse_mode: "HTML" })
            .catch((err) => console.error(`[poller] notify error:`, err));
        } else if (sessionStatus === "error" && ws.status !== "failed") {
          updateWorkspaceStatus(ws.id, "failed");
          const name = ws.conductorWorkspaceName ?? ws.name;
          bot.telegram
            .sendMessage(
              ws.telegramChatId,
              `🔴 <b>${esc(name)}</b> encountered an error.`,
              { parse_mode: "HTML" }
            )
            .catch((err) => console.error(`[poller] notify error:`, err));
        }
      }
    } catch (err) {
      console.error("[poller] error:", err);
    }
  }, POLL_INTERVAL_MS);
}

// ── Event polling (human_request → Telegram) ────────────────

let eventPollTimer: ReturnType<typeof setInterval> | null = null;
let lastEventId = 0;

function startEventPoller(): void {
  lastEventId = getMaxEventId();

  eventPollTimer = setInterval(() => {
    try {
      const events = getNewEvents(lastEventId);
      for (const event of events) {
        lastEventId = event.id;

        if (event.type === "human_request") {
          const payload: HumanRequestPayload = JSON.parse(event.payload);
          const ws = getWorkspace(event.workspaceId);
          const chatId = ws?.telegramChatId ?? OWNER_CHAT_ID!;
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

          bot.telegram
            .sendMessage(chatId, text, { parse_mode: "HTML", ...buttons })
            .then((sentMsg) => {
              trackDecisionMessage(sentMsg.message_id, payload.decisionId);
            })
            .catch((err) => console.error(`[event-poller] send error:`, err));
        }
      }
    } catch (err) {
      console.error("[event-poller] error:", err);
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

  const formatted = markdownToTelegramHtml(trunc(text, 1200));
  return `🤖 <b>${esc(workspaceName)}</b>\n\n${maybeExpandableQuote(formatted)}`;
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

// ── Start ───────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Starting Conductor Telegram bot...");

  bot.catch((err: any) => {
    console.error("[bot] error:", err);
  });

  await syncTelegramCommands();
  bot.launch();
  startSessionPoller();
  startEventPoller();
  console.log("Bot is running. Listening for messages...");

  // Graceful shutdown
  const shutdown = () => {
    console.log("Shutting down...");
    if (pollTimer) clearInterval(pollTimer);
    if (eventPollTimer) clearInterval(eventPollTimer);
    bot.stop("SIGTERM");
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
