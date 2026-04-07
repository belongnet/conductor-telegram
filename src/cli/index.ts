#!/usr/bin/env node
/**
 * conductor-telegram CLI entry point.
 * Built by Belong.net — conductor.build
 */

import { getVersionString, printBanner } from "./banner.js";
import { exitWithConfigError } from "./errors.js";
import type { CLIFlags } from "./config.js";

function parseFlags(args: string[]): { command: string; flags: CLIFlags } {
  let command = "start";
  const flags: CLIFlags = {};

  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--token" && i + 1 < args.length) {
      flags.token = args[++i];
    } else if (arg === "--chat-id" && i + 1 < args.length) {
      flags.chatId = args[++i];
    } else if (arg === "--db-path" && i + 1 < args.length) {
      flags.dbPath = args[++i];
    } else if (arg === "--version" || arg === "-v") {
      console.log(getVersionString());
      process.exit(0);
    } else if (arg === "--help" || arg === "-h") {
      positionals.push("help");
    } else if (arg === "--quiet" || arg === "--no-color") {
      // Handled globally by banner.ts and errors.ts
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }

  if (positionals.length > 0) {
    command = positionals[0];
  }

  return { command, flags };
}

function printHelp(): void {
  console.log(`
  conductor-telegram — Remote oversight for Conductor workspaces

  Usage: conductor-telegram [command] [flags]

  Commands:
    start            Start the bot in foreground (default)
    setup            Interactive first-run configuration wizard
    doctor           Validate configuration and connectivity
    status           Show configuration health
    install-plugin   Install MCP server plugin into Claude Code
    help             Show this help message

  Flags:
    --token TOKEN    Telegram bot token (overrides config)
    --chat-id ID     Owner chat ID (overrides config)
    --db-path PATH   Database path (overrides config)
    --quiet          Suppress startup banner
    --no-color       Disable colored output (also respects NO_COLOR env)
    --version, -v    Show version

  Config precedence: CLI flags > env vars > ~/.conductor-telegram/config.json > defaults

  Built by Belong.net — https://belong.net
  https://conductor.build
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, flags } = parseFlags(args);

  switch (command) {
    case "help":
      printHelp();
      break;

    case "setup": {
      const { runSetup } = await import("./setup.js");
      await runSetup(flags);
      break;
    }

    case "doctor": {
      const { runDoctor } = await import("./doctor.js");
      await runDoctor(flags);
      break;
    }

    case "status": {
      // Status is a lightweight doctor
      const { runDoctor } = await import("./doctor.js");
      await runDoctor(flags);
      break;
    }

    case "install-plugin": {
      const { runInstallPlugin } = await import("./install-plugin.js");
      await runInstallPlugin();
      break;
    }

    case "start": {
      const { loadConfig, configExists } = await import("./config.js");

      if (!configExists() && !flags.token) {
        // Check env vars as fallback
        if (!process.env.BOT_TOKEN) {
          exitWithConfigError(
            "No configuration found",
            "Neither config.json nor BOT_TOKEN env var is set",
            "Run 'conductor-telegram setup' to configure, or pass --token and --chat-id"
          );
        }
      }

      let config;
      try {
        config = loadConfig(flags);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        exitWithConfigError(
          "Invalid configuration",
          msg,
          "Run 'conductor-telegram setup' to reconfigure, or 'conductor-telegram doctor' to diagnose"
        );
      }

      // Inject config into process.env for the existing bot code
      process.env.BOT_TOKEN = config.botToken;
      process.env.OWNER_CHAT_ID = config.ownerChatId;
      if (config.dbPath) process.env.DB_PATH = config.dbPath;
      if (config.conductorDbPath)
        process.env.CONDUCTOR_DB_PATH = config.conductorDbPath;
      if (config.conductorWorkspacesDir)
        process.env.CONDUCTOR_WORKSPACES_DIR = config.conductorWorkspacesDir;
      if (config.conductorReposDir)
        process.env.CONDUCTOR_REPOS_DIR = config.conductorReposDir;
      if (config.downloadsDir)
        process.env.TELEGRAM_DOWNLOADS_DIR = config.downloadsDir;
      if (config.claudeBin) process.env.CLAUDE_BIN = config.claudeBin;
      if (config.codexBin) process.env.CODEX_BIN = config.codexBin;
      if (config.permissionMode)
        process.env.TELEGRAM_AGENT_PERMISSION_MODE = config.permissionMode;
      if (config.defaultAgentType)
        process.env.TELEGRAM_DEFAULT_AGENT_TYPE = config.defaultAgentType;
      if (config.defaultModel)
        process.env.TELEGRAM_DEFAULT_MODEL = config.defaultModel;
      if (config.reviewAgentType)
        process.env.TELEGRAM_REVIEW_AGENT_TYPE = config.reviewAgentType;
      if (config.reviewModel)
        process.env.TELEGRAM_REVIEW_MODEL = config.reviewModel;

      // Print banner
      printBanner("Starting...");

      // Import and start the bot
      await import("../bot/index.js");
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run 'conductor-telegram help' for available commands.");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
