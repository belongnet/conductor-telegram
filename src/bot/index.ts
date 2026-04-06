import { Telegraf } from "telegraf";
import { getDb } from "../store/db.js";
import { authGuard } from "./middleware.js";
import { registerCommands } from "./commands.js";
import {
  getMaxSessionMessageRowId,
  getSessionMessagesAfter,
  getSessionResult,
  getWorkspaceSessionInfo,
  type SessionMessage,
} from "./launcher.js";
import {
  getAllWorkspaces,
  linkTelegramMessage,
  updateWorkspaceConductorSession,
  updateWorkspaceForwardCursor,
  updateWorkspaceStatus,
} from "../store/queries.js";

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
  console.log(`[update] type=${ctx.updateType} chat=${ctx.chat?.id} text=${(ctx.message as any)?.text?.slice(0, 50)}`);
  return next();
});

// Auth: only respond to the owner
bot.use(authGuard(OWNER_CHAT_ID));

// Register commands
registerCommands(bot);

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
            if (result.resultText) {
              const summary = result.resultText.length > 500
                ? result.resultText.slice(0, 497) + "..."
                : result.resultText;
              msg += `\n\n<i>${escHtml(summary)}</i>`;
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

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatForwardedMessage(
  workspaceName: string,
  message: SessionMessage
): string | null {
  if (message.role === "user") {
    const text = extractUserText(message.content);
    if (!text) return null;
    return `💬 <b>${escHtml(workspaceName)}</b>\n\n<i>${escHtml(
      truncate(text, 1200)
    )}</i>`;
  }

  if (message.role !== "assistant") {
    return null;
  }

  const text = extractAssistantText(message.content);
  if (!text) return null;

  return `🤖 <b>${escHtml(workspaceName)}</b>\n\n${escHtml(truncate(text, 1200))}`;
}

function extractUserText(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith("{")) {
    return trimmed;
  }

  try {
    const parsed = JSON.parse(trimmed);
    const text = extractTextParts(parsed?.message?.content);
    return text || null;
  } catch {
    return trimmed;
  }
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
  console.log("Starting Conductor Telegram bot...");

  bot.catch((err: any) => {
    console.error("[bot] error:", err);
  });

  bot.launch();
  startSessionPoller();
  console.log("Bot is running. Listening for messages...");

  // Graceful shutdown
  const shutdown = () => {
    console.log("Shutting down...");
    if (pollTimer) clearInterval(pollTimer);
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
