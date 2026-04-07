import { Telegraf, Markup } from "telegraf";
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

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const POLL_INTERVAL_MS = 5000;

if (!BOT_TOKEN || !OWNER_CHAT_ID) {
  // When launched via CLI, config is already validated. This guard is for
  // direct `node dist/bot/index.js` invocations (legacy .env workflow).
  const missing = [
    !BOT_TOKEN && "BOT_TOKEN",
    !OWNER_CHAT_ID && "OWNER_CHAT_ID",
  ].filter(Boolean);
  console.error(
    `ERROR: Missing required environment variable(s): ${missing.join(", ")}\n` +
    `CAUSE: Neither config.json nor env vars provide these values\n` +
    `FIX:   Run 'conductor-telegram setup' or set ${missing.join(" and ")} in your environment`
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

          let msg = `✅ Agent <b>${escHtml(name)}</b> finished.`;
          if (result) {
            const parts: string[] = [];
            if (result.costUsd) parts.push(`$${result.costUsd.toFixed(2)}`);
            if (result.numTurns) parts.push(`${result.numTurns} turns`);
            if (result.durationMs) parts.push(`${Math.round(result.durationMs / 1000)}s`);
            if (parts.length) msg += `\n${parts.join(" · ")}`;
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
              `🔴 Agent <b>${escHtml(name)}</b> encountered an error.`,
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

          let text = `❓ <b>${escHtml(wsName)}</b> asks:\n\n${escHtml(payload.question)}`;
          if (!payload.options?.length) {
            text += `\n\n<i>Reply to this message with text, a photo, or a voice message.</i>`;
          }

          const buttons = payload.options?.length
            ? Markup.inlineKeyboard(
                payload.options.map((opt, i) => [
                  Markup.button.callback(opt, `decide:${payload.decisionId}:${i}`),
                ])
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

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  return `🤖 <b>${escHtml(workspaceName)}</b>\n\n${escHtml(truncate(text, 1200))}`;
}

function extractAssistantText(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.type === "result") {
      return null;
    }
    return extractTextParts(parsed?.message?.content) || null;
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

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen - 3)}...` : s;
}

// ── Start ───────────────────────────────────────────────────

async function main(): Promise<void> {
  bot.catch((err: any) => {
    console.error("[bot] error:", err);
  });

  await syncTelegramCommands();
  bot.launch();
  startSessionPoller();
  startEventPoller();
  console.log("  Status: Connected · Polling every 5s");

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
