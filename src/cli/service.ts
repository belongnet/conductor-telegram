/**
 * `conductor-telegram service` — manage the launchd LaunchAgent that
 * keeps the bot alive on macOS. Replaces the manual screen-based start
 * flow with a supervised background job.
 *
 * Subcommands:
 *   install          Write plists, bootstrap both agents (bot + watchdog)
 *   uninstall        Bootout and remove plists
 *   start            launchctl kickstart the bot agent
 *   stop             launchctl bootout the bot agent (watchdog keeps running)
 *   restart          stop + start
 *   status           Show loaded state, PID, last heartbeat, boot count
 *   logs             Tail ~/.conductor-telegram/bot.log
 *   watchdog         (internal) invoked by the watchdog plist every 60s
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  configExists,
  loadConfig,
  saveConfig,
  tryLoadConfig,
  type CLIFlags,
} from "./config.js";
import {
  DOPPLER_RUNTIME_SECRET_NAMES,
  buildServiceDopplerEnvironment,
  buildDopplerRunArgs,
  readAvailableDopplerRuntimeSecretNames,
  resolveDopplerRuntime,
  stripDopplerManagedConfig,
  type DopplerRuntime,
} from "./doppler.js";

const LABEL = "net.belong.conductor-telegram";
const WATCHDOG_LABEL = "net.belong.conductor-telegram.watchdog";
const STATE_DIR = path.join(os.homedir(), ".conductor-telegram");
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);
const WATCHDOG_PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${WATCHDOG_LABEL}.plist`);
const BOT_LOG = path.join(STATE_DIR, "bot.log");
const WATCHDOG_LOG = path.join(STATE_DIR, "watchdog.log");

const WATCHDOG_STALE_SECONDS = 120;
const WATCHDOG_INTERVAL_SECONDS = 60;

function here(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function findCliEntrypoint(): string {
  return path.resolve(here(), "index.js");
}

function getUid(): number {
  return process.getuid?.() ?? 0;
}

function domainTarget(label: string): string {
  return `gui/${getUid()}/${label}`;
}

function launchctl(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function isLoaded(label: string): boolean {
  const { stdout } = launchctl(["print", domainTarget(label)]);
  return stdout.trim().length > 0;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface BotPlistOptions {
  doppler?: DopplerRuntime | null;
  nodePath?: string;
  cliPath?: string;
}

export function buildBotProgramArguments(
  options: BotPlistOptions = {}
): string[] {
  const directCommand = [
    options.nodePath ?? process.execPath,
    options.cliPath ?? findCliEntrypoint(),
    "start",
    "--quiet",
    "--no-color",
  ];
  if (!options.doppler) return directCommand;
  return [
    options.doppler.executable,
    ...buildDopplerRunArgs(options.doppler, directCommand),
  ];
}

export function buildBotPlist(options: BotPlistOptions = {}): string {
  const programArguments = buildBotProgramArguments(options)
    .map((argument) => `    <string>${xmlEscape(argument)}</string>`)
    .join("\n");
  const logPath = xmlEscape(BOT_LOG);
  const stateDir = xmlEscape(STATE_DIR);
  const pathEnv = xmlEscape(
    [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      path.join(os.homedir(), ".local", "bin"),
    ].join(":")
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>WorkingDirectory</key>
  <string>${stateDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
    <key>HOME</key>
    <string>${xmlEscape(os.homedir())}</string>
  </dict>
</dict>
</plist>
`;
}

function buildWatchdogPlist(): string {
  const nodePath = xmlEscape(process.execPath);
  const cliPath = xmlEscape(findCliEntrypoint());
  const logPath = xmlEscape(WATCHDOG_LOG);
  const pathEnv = xmlEscape(
    [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":")
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WATCHDOG_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
    <string>service</string>
    <string>watchdog</string>
    <string>--no-color</string>
  </array>
  <key>StartInterval</key>
  <integer>${WATCHDOG_INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
    <key>HOME</key>
    <string>${xmlEscape(os.homedir())}</string>
  </dict>
</dict>
</plist>
`;
}

function writePlist(plistPath: string, contents: string): void {
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, contents, { mode: 0o644 });
}

function bootstrap(label: string, plistPath: string): { ok: boolean; detail: string } {
  if (isLoaded(label)) {
    launchctl(["bootout", domainTarget(label)]);
  }
  const { code, stderr, stdout } = launchctl([
    "bootstrap",
    `gui/${getUid()}`,
    plistPath,
  ]);
  if (code !== 0) {
    return { ok: false, detail: (stderr || stdout || "bootstrap failed").trim() };
  }
  return { ok: true, detail: "bootstrapped" };
}

function bootout(label: string): { ok: boolean; detail: string } {
  if (!isLoaded(label)) {
    return { ok: true, detail: "not loaded" };
  }
  const { code, stderr, stdout } = launchctl(["bootout", domainTarget(label)]);
  if (code !== 0) {
    return { ok: false, detail: (stderr || stdout || "bootout failed").trim() };
  }
  return { ok: true, detail: "booted out" };
}

function kickstart(label: string, kill = false): { ok: boolean; detail: string } {
  const args = kill
    ? ["kickstart", "-k", domainTarget(label)]
    : ["kickstart", domainTarget(label)];
  const { code, stderr, stdout } = launchctl(args);
  if (code !== 0) {
    return { ok: false, detail: (stderr || stdout || "kickstart failed").trim() };
  }
  return { ok: true, detail: "kickstarted" };
}

async function cmdInstall(flags: CLIFlags): Promise<void> {
  if (
    Boolean(flags.dopplerProject) !== Boolean(flags.dopplerConfig)
  ) {
    console.error(
      "Both --doppler-project and --doppler-config are required together."
    );
    process.exit(1);
  }
  if (
    !configExists() &&
    !flags.token &&
    !(flags.dopplerProject && flags.dopplerConfig)
  ) {
    console.error("No config.json found.");
    console.error(
      "Run 'conductor-telegram setup' first, or install with both Doppler flags."
    );
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig(flags);
  } catch (error) {
    console.error(
      `Invalid service configuration: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }

  let doppler: DopplerRuntime | null = null;
  try {
    doppler = resolveDopplerRuntime(config);
    if (doppler) {
      const names = readAvailableDopplerRuntimeSecretNames(
        doppler,
        buildServiceDopplerEnvironment()
      );
      const scopedSecretNames = DOPPLER_RUNTIME_SECRET_NAMES.filter((name) =>
        names.has(name)
      );
      doppler = {
        ...doppler,
        secretNames: scopedSecretNames,
      };
      if (scopedSecretNames.length === 0) {
        throw new Error(
          "Doppler contains none of conductor-telegram's allowed runtime keys"
        );
      }
      const missingRuntimeKeys = [
        !config.botToken && !names.has("BOT_TOKEN") ? "BOT_TOKEN" : null,
        !config.ownerChatId && !names.has("OWNER_CHAT_ID")
          ? "OWNER_CHAT_ID"
          : null,
      ].filter(Boolean);
      if (missingRuntimeKeys.length > 0) {
        throw new Error(
          `Doppler is missing required runtime keys: ${missingRuntimeKeys.join(", ")}`
        );
      }
      const optionalCloudKeys = ["CONDUCTOR_API_KEY"];
      const availableCloudKeys = optionalCloudKeys.filter((name) =>
        names.has(name)
      );
      console.log(
        `Doppler: configured runtime accessible ` +
          `(${availableCloudKeys.length}/${optionalCloudKeys.length} optional cloud keys present)`
      );
      config = stripDopplerManagedConfig(config, names);
    }
  } catch (error) {
    console.error(
      `Doppler runtime validation failed: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }

  const shouldSaveConfig =
    !configExists() ||
    flags.dopplerProject ||
    flags.dopplerConfig ||
    Boolean(doppler);

  fs.mkdirSync(STATE_DIR, { recursive: true });

  const botPlist = buildBotPlist({ doppler });
  const watchdogPlist = buildWatchdogPlist();

  writePlist(PLIST_PATH, botPlist);
  writePlist(WATCHDOG_PLIST_PATH, watchdogPlist);

  console.log(`  wrote ${PLIST_PATH}`);
  console.log(`  wrote ${WATCHDOG_PLIST_PATH}`);

  const bot = bootstrap(LABEL, PLIST_PATH);
  if (!bot.ok) {
    console.error(`  bot: FAIL — ${bot.detail}`);
    process.exit(1);
  }
  console.log(`  bot: ${bot.detail}`);

  const watchdog = bootstrap(WATCHDOG_LABEL, WATCHDOG_PLIST_PATH);
  if (!watchdog.ok) {
    console.error(`  watchdog: FAIL — ${watchdog.detail}`);
    process.exit(1);
  }
  console.log(`  watchdog: ${watchdog.detail}`);

  if (shouldSaveConfig) {
    saveConfig(config);
    console.log(`  saved runtime configuration to ${STATE_DIR}/config.json`);
  }

  console.log();
  console.log("Bot will restart automatically on crash, logout, and reboot.");
  console.log(`Logs: ${BOT_LOG}`);
  console.log(`Run 'conductor-telegram service status' to verify.`);
}

async function cmdUninstall(): Promise<void> {
  const bot = bootout(LABEL);
  console.log(`  bot: ${bot.detail}`);
  const watchdog = bootout(WATCHDOG_LABEL);
  console.log(`  watchdog: ${watchdog.detail}`);

  for (const p of [PLIST_PATH, WATCHDOG_PLIST_PATH]) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`  removed ${p}`);
    }
  }
}

async function cmdStart(): Promise<void> {
  if (!fs.existsSync(PLIST_PATH)) {
    console.error("Bot plist not installed. Run 'conductor-telegram service install' first.");
    process.exit(1);
  }
  if (!isLoaded(LABEL)) {
    const bot = bootstrap(LABEL, PLIST_PATH);
    console.log(`  bot: ${bot.detail}`);
  } else {
    const k = kickstart(LABEL);
    console.log(`  bot: ${k.detail}`);
  }
}

async function cmdStop(): Promise<void> {
  const bot = bootout(LABEL);
  console.log(`  bot: ${bot.detail}`);
}

async function cmdRestart(): Promise<void> {
  if (isLoaded(LABEL)) {
    const k = kickstart(LABEL, true);
    console.log(`  bot: ${k.detail}`);
  } else {
    await cmdStart();
  }
}

function formatAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

async function cmdStatus(): Promise<void> {
  const { getDb } = await import("../store/db.js");
  const { getHeartbeat } = await import("../store/queries.js");

  const botLoaded = isLoaded(LABEL);
  const watchdogLoaded = isLoaded(WATCHDOG_LABEL);
  console.log();
  console.log(`  bot agent        ${botLoaded ? "✓ loaded" : "✗ not loaded"}`);
  console.log(`  watchdog agent   ${watchdogLoaded ? "✓ loaded" : "✗ not loaded"}`);
  console.log(`  plist (bot)      ${fs.existsSync(PLIST_PATH) ? PLIST_PATH : "not installed"}`);
  console.log(`  plist (wd)       ${fs.existsSync(WATCHDOG_PLIST_PATH) ? WATCHDOG_PLIST_PATH : "not installed"}`);
  console.log(`  log              ${BOT_LOG}`);
  const config = tryLoadConfig();
  if (config?.dopplerProject && config.dopplerConfig) {
    console.log("  runtime secrets  Doppler configured");
  } else {
    console.log("  runtime secrets  config.json / process environment");
  }

  try {
    getDb();
    const hb = getHeartbeat();
    if (hb) {
      console.log();
      console.log(`  last heartbeat   ${formatAgo(hb.lastBeatAt)} (${hb.lastBeatAt})`);
      console.log(`  started          ${formatAgo(hb.startedAt)} (${hb.startedAt})`);
      console.log(`  boot count       ${hb.bootCount}`);
      console.log(`  recorded pid     ${hb.pid}`);
      if (hb.lastExitReason) {
        console.log(`  last exit        ${hb.lastExitReason}`);
      }
    } else {
      console.log(`  heartbeat        none (bot has never started under this version)`);
    }
  } catch (err) {
    console.log(`  heartbeat        unavailable (${err instanceof Error ? err.message : err})`);
  }

  console.log();
}

async function cmdLogs(): Promise<void> {
  if (!fs.existsSync(BOT_LOG)) {
    console.error(`No log file yet: ${BOT_LOG}`);
    process.exit(1);
  }
  const tail = spawnSync("tail", ["-n", "200", "-f", BOT_LOG], {
    stdio: "inherit",
  });
  process.exit(tail.status ?? 0);
}

/**
 * Watchdog entry point. Invoked by the watchdog LaunchAgent every 60 seconds.
 * Reads the heartbeat row; if it's stale and the bot agent is loaded, force
 * a kickstart. Writes a one-line status for the watchdog log.
 */
async function cmdWatchdog(): Promise<void> {
  const stamp = new Date().toISOString();
  const log = (msg: string) => console.log(`[${stamp}] ${msg}`);

  let hb;
  try {
    const { getDb } = await import("../store/db.js");
    const { getHeartbeat } = await import("../store/queries.js");
    getDb();
    hb = getHeartbeat();
  } catch (err) {
    log(`heartbeat read error: ${err instanceof Error ? err.message : err}`);
    return;
  }

  if (!hb) {
    log("no heartbeat row yet — skipping");
    return;
  }

  const lastBeatMs = Date.parse(hb.lastBeatAt);
  const staleSecs = Math.round((Date.now() - lastBeatMs) / 1000);
  const loaded = isLoaded(LABEL);

  if (staleSecs < WATCHDOG_STALE_SECONDS) {
    log(`ok: heartbeat ${staleSecs}s old, loaded=${loaded}`);
    return;
  }

  if (!loaded) {
    log(`stale ${staleSecs}s but bot agent not loaded — not restarting (user may have stopped it)`);
    return;
  }

  log(`heartbeat stale ${staleSecs}s — kickstarting ${LABEL}`);
  const k = kickstart(LABEL, true);
  log(`kickstart result: ${k.ok ? "ok" : "fail"} — ${k.detail}`);
}

export async function runService(
  args: string[],
  flags: CLIFlags = {}
): Promise<void> {
  const sub = args[0] ?? "status";

  if (process.platform !== "darwin") {
    console.error("conductor-telegram service currently only supports macOS launchd.");
    process.exit(1);
  }

  switch (sub) {
    case "install":
      await cmdInstall(flags);
      return;
    case "uninstall":
    case "remove":
      await cmdUninstall();
      return;
    case "start":
      await cmdStart();
      return;
    case "stop":
      await cmdStop();
      return;
    case "restart":
      await cmdRestart();
      return;
    case "status":
      await cmdStatus();
      return;
    case "logs":
    case "log":
      await cmdLogs();
      return;
    case "watchdog":
      await cmdWatchdog();
      return;
    default:
      console.error(`Unknown service subcommand: ${sub}`);
      console.error("Available: install, uninstall, start, stop, restart, status, logs");
      process.exit(1);
  }
}
