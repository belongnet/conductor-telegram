/**
 * Interactive setup wizard for conductor-telegram.
 * Uses @clack/prompts for beautiful terminal output.
 * Built by Belong.net — conductor.build
 */

import * as p from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadConfig,
  saveConfig,
  configExists,
  dotenvExists,
  migrateFromDotenv,
  type Config,
  type CLIFlags,
} from "./config.js";
import { runInstallPlugin } from "./install-plugin.js";

async function validateToken(
  token: string
): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${token}/getMe`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status} from Telegram API` };
    }
    const data = (await resp.json()) as {
      ok: boolean;
      result?: { username?: string };
    };
    if (!data.ok) {
      return { ok: false, error: "Telegram API returned ok: false" };
    }
    return { ok: true, username: data.result?.username };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function detectPath(candidate: string): string | undefined {
  const expanded = candidate.replace(/^~/, os.homedir());
  return fs.existsSync(expanded) ? expanded : undefined;
}

export async function runSetup(flags: CLIFlags): Promise<void> {
  // Non-interactive mode: if all required values are provided, skip wizard
  if (flags.token && flags.chatId) {
    const config: Config = {
      version: 1,
      botToken: flags.token,
      ownerChatId: flags.chatId,
      dbPath: flags.dbPath,
    };
    saveConfig(config);
    console.log("  Config saved to ~/.conductor-telegram/config.json");
    return;
  }

  // Pre-flight checks
  const nodeVersion = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeVersion < 22) {
    p.log.error(
      `Node.js ${process.versions.node} detected. conductor-telegram requires Node >= 22.`
    );
    p.log.info("Install Node.js 22+: https://nodejs.org/");
    process.exit(2);
  }

  // Check better-sqlite3
  try {
    await import("better-sqlite3");
  } catch {
    p.log.error(
      "better-sqlite3 native module failed to load. This usually means a build tools issue."
    );
    p.log.info(
      "Try: npm rebuild better-sqlite3, or install Xcode Command Line Tools: xcode-select --install"
    );
    process.exit(2);
  }

  p.intro("conductor-telegram setup · Built by Belong.net");

  // Check for .env migration
  let existingConfig: Partial<Config> = {};
  if (!configExists() && dotenvExists()) {
    const shouldMigrate = await p.confirm({
      message:
        "Found .env file. Import existing settings into config.json?",
      initialValue: true,
    });

    if (p.isCancel(shouldMigrate)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    if (shouldMigrate) {
      existingConfig = migrateFromDotenv();
      p.log.success("Imported settings from .env");
    }
  } else if (configExists()) {
    try {
      existingConfig = loadConfig();
      p.log.info("Loaded existing config. Press Enter to keep current values.");
    } catch {
      // Corrupted config, start fresh
    }
  }

  // Bot token
  const tokenInput = await p.text({
    message: "Telegram bot token",
    placeholder: existingConfig.botToken
      ? "(press Enter to keep current)"
      : "Paste token from @BotFather",
    defaultValue: existingConfig.botToken,
    validate: (val) => {
      if (!val) return "Bot token is required";
      if (!val.includes(":")) return "Token should contain a colon (e.g. 123456:ABC...)";
    },
  });

  if (p.isCancel(tokenInput)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const botToken = (tokenInput as string) || existingConfig.botToken || "";

  // Validate token
  const spinner = p.spinner();
  spinner.start("Validating bot token...");
  const validation = await validateToken(botToken);
  if (!validation.ok) {
    spinner.stop(`Token validation failed: ${validation.error}`);
    p.log.error(
      "Get a valid token from @BotFather on Telegram and try again."
    );
    process.exit(2);
  }
  spinner.stop(`Connected as @${validation.username}`);

  // Chat ID
  const chatIdInput = await p.text({
    message: "Your Telegram chat ID (numeric)",
    placeholder: existingConfig.ownerChatId
      ? "(press Enter to keep current)"
      : "Send /start to @userinfobot to find yours",
    defaultValue: existingConfig.ownerChatId,
    validate: (val) => {
      if (!val) return "Chat ID is required";
      if (!/^-?\d+$/.test(val)) return "Chat ID must be numeric";
    },
  });

  if (p.isCancel(chatIdInput)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const ownerChatId =
    (chatIdInput as string) || existingConfig.ownerChatId || "";

  // Conductor paths
  const defaultWorkspacesDir =
    existingConfig.conductorWorkspacesDir ??
    detectPath("~/conductor/workspaces") ??
    path.join(os.homedir(), "conductor/workspaces");

  const workspacesDir = await p.text({
    message: "Conductor workspaces directory",
    defaultValue: defaultWorkspacesDir,
    placeholder: defaultWorkspacesDir,
  });

  if (p.isCancel(workspacesDir)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const defaultReposDir =
    existingConfig.conductorReposDir ??
    detectPath("~/conductor/repos") ??
    path.join(os.homedir(), "conductor/repos");

  const reposDir = await p.text({
    message: "Repository directory",
    defaultValue: defaultReposDir,
    placeholder: defaultReposDir,
  });

  if (p.isCancel(reposDir)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  // MCP plugin install
  const shouldInstallPlugin = await p.confirm({
    message:
      "Install MCP plugin into Claude Code? (enables report_status, request_human tools)",
    initialValue: true,
  });

  if (p.isCancel(shouldInstallPlugin)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  // Build config
  const config: Config = {
    version: 1,
    botToken,
    ownerChatId,
    dbPath: existingConfig.dbPath,
    conductorDbPath: existingConfig.conductorDbPath,
    conductorWorkspacesDir: (workspacesDir as string) || defaultWorkspacesDir,
    conductorReposDir: (reposDir as string) || defaultReposDir,
    downloadsDir: existingConfig.downloadsDir,
    claudeBin: existingConfig.claudeBin,
    codexBin: existingConfig.codexBin,
    permissionMode: existingConfig.permissionMode,
    defaultAgentType: existingConfig.defaultAgentType,
    defaultModel: existingConfig.defaultModel,
    reviewAgentType: existingConfig.reviewAgentType,
    reviewModel: existingConfig.reviewModel,
  };

  // Summary
  p.log.info(
    [
      "Configuration summary:",
      `  Bot:        @${validation.username}`,
      `  Chat ID:    ${ownerChatId}`,
      `  Workspaces: ${config.conductorWorkspacesDir}`,
      `  Repos:      ${config.conductorReposDir}`,
      `  Config:     ~/.conductor-telegram/config.json`,
    ].join("\n")
  );

  const confirmed = await p.confirm({
    message: "Save this configuration?",
    initialValue: true,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Setup cancelled. No changes made.");
    process.exit(0);
  }

  // Save
  saveConfig(config);
  p.log.success("Config saved to ~/.conductor-telegram/config.json");

  // Plugin install
  if (shouldInstallPlugin) {
    p.log.step("Installing MCP plugin...");
    await runInstallPlugin();
  }

  p.outro(
    "Ready! Run 'conductor-telegram' to start the bot."
  );
}
