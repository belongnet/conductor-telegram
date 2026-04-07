/**
 * Doctor command: validates all components and gives exact fix commands.
 * Built by Belong.net — conductor.build
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CONFIG_PATH, tryLoadConfig, type CLIFlags } from "./config.js";
import { EXIT_GENERAL } from "./errors.js";

const noColor =
  process.env.NO_COLOR !== undefined || process.argv.includes("--no-color");

function green(s: string): string {
  return noColor ? s : `\x1b[32m${s}\x1b[0m`;
}
function red(s: string): string {
  return noColor ? s : `\x1b[31m${s}\x1b[0m`;
}
function dim(s: string): string {
  return noColor ? s : `\x1b[2m${s}\x1b[0m`;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

function checkNode(): CheckResult {
  const version = process.versions.node;
  const major = parseInt(version.split(".")[0], 10);
  if (major >= 22) {
    return {
      name: "Node.js",
      ok: true,
      detail: `v${version} (required >=22)`,
    };
  }
  return {
    name: "Node.js",
    ok: false,
    detail: `v${version} (required >=22)`,
    fix: "Install Node.js 22+: https://nodejs.org/",
  };
}

function checkConfig(hasUsableConfig: boolean): CheckResult {
  if (!fs.existsSync(CONFIG_PATH)) {
    if (hasUsableConfig) {
      return {
        name: "Config",
        ok: true,
        detail: "Using environment variables or CLI flags (no config.json)",
      };
    }
    return {
      name: "Config",
      ok: false,
      detail: `${CONFIG_PATH} not found`,
      fix: "Run 'conductor-telegram setup' to create config",
    };
  }

  try {
    const stat = fs.statSync(CONFIG_PATH);
    const mode = (stat.mode & 0o777).toString(8);
    if (mode !== "600") {
      return {
        name: "Config",
        ok: false,
        detail: `${CONFIG_PATH} (mode ${mode}, should be 600)`,
        fix: `Run: chmod 600 ${CONFIG_PATH}`,
      };
    }
    return { name: "Config", ok: true, detail: `${CONFIG_PATH} (0600)` };
  } catch {
    return {
      name: "Config",
      ok: false,
      detail: `Cannot stat ${CONFIG_PATH}`,
      fix: "Run 'conductor-telegram setup' to recreate config",
    };
  }
}

async function checkBotToken(
  token: string | undefined
): Promise<CheckResult> {
  if (!token) {
    return {
      name: "Bot token",
      ok: false,
      detail: "Not configured",
      fix: "Run 'conductor-telegram setup' or pass --token",
    };
  }

  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${token}/getMe`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!resp.ok) {
      return {
        name: "Bot token",
        ok: false,
        detail: `HTTP ${resp.status} from Telegram API`,
        fix: "Token may be revoked. Run 'conductor-telegram setup' to reconfigure",
      };
    }
    const data = (await resp.json()) as {
      ok: boolean;
      result?: { username?: string };
    };
    const username = data.result?.username ?? "unknown";
    return {
      name: "Bot token",
      ok: true,
      detail: `@${username} connected`,
    };
  } catch (err) {
    return {
      name: "Bot token",
      ok: false,
      detail: `Network error: ${err instanceof Error ? err.message : String(err)}`,
      fix: "Check your internet connection and try again",
    };
  }
}

function checkDatabase(dbPath: string | undefined): CheckResult {
  const p =
    dbPath ??
    path.join(os.homedir(), ".conductor-telegram/conductor-telegram.db");
  if (!fs.existsSync(p)) {
    return {
      name: "Database",
      ok: false,
      detail: `${p} not found`,
      fix: "Database will be created on first bot start",
    };
  }
  return { name: "Database", ok: true, detail: p };
}

function checkConductor(conductorDbPath: string | undefined): CheckResult {
  const p =
    conductorDbPath ??
    path.join(
      os.homedir(),
      "Library/Application Support/com.conductor.app/conductor.db"
    );
  if (!fs.existsSync(p)) {
    return {
      name: "Conductor",
      ok: false,
      detail: `${p} not found`,
      fix: "Install Conductor from https://conductor.build or set conductorDbPath in config",
    };
  }
  return { name: "Conductor", ok: true, detail: p };
}

function checkPlugin(): CheckResult {
  const pluginDir = path.join(
    os.homedir(),
    ".claude/plugins/conductor-telegram-mcp"
  );
  const mcpJson = path.join(pluginDir, ".mcp.json");
  if (!fs.existsSync(mcpJson)) {
    return {
      name: "MCP Plugin",
      ok: false,
      detail: "Not installed",
      fix: "Run 'conductor-telegram install-plugin'",
    };
  }
  return { name: "MCP Plugin", ok: true, detail: `${pluginDir} installed` };
}

function checkRepos(reposDir: string | undefined): CheckResult {
  const p = reposDir ?? path.join(os.homedir(), "conductor/repos");
  if (!fs.existsSync(p)) {
    return {
      name: "Repos",
      ok: false,
      detail: `${p} not found`,
      fix: `Create directory: mkdir -p ${p}`,
    };
  }
  try {
    const entries = fs.readdirSync(p).filter((e) => {
      const fullPath = path.join(p, e);
      return (
        fs.statSync(fullPath).isDirectory() && !e.startsWith(".")
      );
    });
    return {
      name: "Repos",
      ok: true,
      detail: `${p} (${entries.length} repositories)`,
    };
  } catch {
    return {
      name: "Repos",
      ok: false,
      detail: `Cannot read ${p}`,
      fix: `Check permissions on ${p}`,
    };
  }
}

export async function runDoctor(flags: CLIFlags): Promise<void> {
  const config = tryLoadConfig(flags);

  console.log();

  const checks: CheckResult[] = [
    checkNode(),
    checkConfig(config !== null),
    await checkBotToken(config?.botToken),
    checkDatabase(config?.dbPath),
    checkConductor(config?.conductorDbPath),
    checkPlugin(),
    checkRepos(config?.conductorReposDir),
  ];

  const maxName = Math.max(...checks.map((c) => c.name.length));
  let hasFailures = false;

  for (const check of checks) {
    const pad = " ".repeat(maxName - check.name.length);
    const icon = check.ok ? green("✓") : red("✗");
    console.log(`  ${check.name}${pad}  ${icon} ${check.detail}`);
    if (!check.ok && check.fix) {
      console.log(`  ${" ".repeat(maxName)}    ${dim(check.fix)}`);
      hasFailures = true;
    }
  }

  console.log();

  if (hasFailures) {
    process.exit(EXIT_GENERAL);
  }
}
