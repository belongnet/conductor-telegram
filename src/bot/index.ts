import { Telegraf } from "telegraf";
import { getDb } from "../store/db.js";
import { authGuard } from "./middleware.js";
import { registerCommands } from "./commands.js";
import { getSessionStatus, getSessionResult } from "./launcher.js";
import { getActiveWorkspaces, updateWorkspaceStatus } from "../store/queries.js";

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
      const active = getActiveWorkspaces();
      for (const ws of active) {
        if (!ws.conductorWorkspaceName) continue;
        const sessionStatus = getSessionStatus(ws.conductorWorkspaceName);
        if (!sessionStatus) continue;

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
        } else if (sessionStatus === "error" && ws.status === "running") {
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
