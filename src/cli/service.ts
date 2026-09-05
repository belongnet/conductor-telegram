/**
 * `conductor-telegram service` — manage the launchd LaunchAgent that
 * keeps the bot alive on macOS. Replaces the manual screen-based start
 * flow with a supervised background job.
 *
 * Subcommands:
 *   install          Write plists, bootstrap bot + watchdog agents; with
 *                    --with-updater also enroll in auto-deploys from main
 *   uninstall        Bootout and remove plists, updater script copy, marker
 *   start            launchctl kickstart the bot agent (clears stop marker)
 *   stop             launchctl bootout the bot agent (watchdog keeps
 *                    running; auto-deploys leave the bot stopped)
 *   restart          stop + start
 *   status           Show loaded state, PID, last heartbeat, boot count
 *   logs             Tail ~/.conductor-telegram/bot.log
 *   watchdog         (internal) invoked by the watchdog plist every 60s
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatAgo } from "../bot/format.js";
import { fileURLToPath } from "node:url";
import {
  configExists,
  loadConfig,
  loadPersistableConfig,
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
const LANES_LABEL = "net.belong.conductor-telegram.lanes";
const WATCHDOG_LABEL = "net.belong.conductor-telegram.watchdog";
const UPDATER_LABEL = "net.belong.conductor-telegram.updater";
const STATE_DIR = path.join(os.homedir(), ".conductor-telegram");
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);
const LANES_PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${LANES_LABEL}.plist`);
const WATCHDOG_PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${WATCHDOG_LABEL}.plist`);
const UPDATER_PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${UPDATER_LABEL}.plist`);
const BOT_LOG = path.join(STATE_DIR, "bot.log");
const LANES_LOG = path.join(STATE_DIR, "lanes.log");
const REQUIRED_LANE_SERVICE_SECRETS = Object.freeze([
  "BOT_TOKEN",
  "OWNER_CHAT_ID",
  "CONDUCTOR_API_KEY",
  "COMMAND_CENTER_API_BASE_URL",
  "COMMAND_CENTER_API_KEY",
  "BELONG_HUMAN_APPROVAL_KEY",
]);
const WATCHDOG_LOG = path.join(STATE_DIR, "watchdog.log");
// scripts/gateway-update.sh caps this same file in place; its
// CONDUCTOR_TELEGRAM_GATEWAY_LOG default must stay in sync with this path.
const UPDATE_LOG = path.join(STATE_DIR, "update.log");
const UPDATER_SCRIPT_PATH = path.join(STATE_DIR, "bin", "gateway-update.sh");
const GATEWAY_REPO_DIR = path.join(STATE_DIR, "gateway", "repo");
// Written by `service stop`, cleared by start/interactive restart. While
// present, updater-driven installs/restarts leave the bot down instead of
// resurrecting something the operator deliberately stopped.
const STOP_MARKER_PATH = path.join(STATE_DIR, "bot-stopped");
// Exported by gateway-update.sh around the deploy it runs, so install and
// restart can tell an auto-deploy from an operator at a terminal.
const UPDATER_ENV_FLAG = "CONDUCTOR_TELEGRAM_UPDATER";
// Present while an updater plist rewrite is waiting for a re-bootstrap
// (login/reboot) to take effect on an always-loaded agent.
const UPDATER_PLIST_PENDING_PATH = path.join(STATE_DIR, "updater-plist-pending");

const GATEWAY_OVERRIDE_ENV_NAMES = [
  "CONDUCTOR_TELEGRAM_GATEWAY_HOME",
  "CONDUCTOR_TELEGRAM_GATEWAY_REMOTE",
  "CONDUCTOR_TELEGRAM_GATEWAY_BRANCH",
  "CONDUCTOR_TELEGRAM_GATEWAY_LOG",
] as const;

const WATCHDOG_STALE_SECONDS = 120;
const WATCHDOG_INTERVAL_SECONDS = 60;
const UPDATER_INTERVAL_SECONDS = 60;

function here(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function findCliEntrypoint(): string {
  return path.resolve(here(), "index.js");
}

function findUpdaterScriptSource(): string {
  // dist/cli (built) and src/cli (dev) are both two levels below the
  // package root that carries scripts/.
  return path.resolve(here(), "..", "..", "scripts", "gateway-update.sh");
}

/**
 * process.execPath resolves Homebrew's stable bin/node symlink to a
 * versioned Cellar path (…/Cellar/node/22.9.0_1/bin/node) that dies on the
 * next `brew upgrade node`. Burn the stable symlink into the plists instead
 * whenever it points at the node we are running under.
 */
export function resolveLaunchdNodePath(
  candidates: string[] = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
): string {
  for (const candidate of candidates) {
    try {
      if (fs.realpathSync(candidate) === fs.realpathSync(process.execPath)) {
        return candidate;
      }
    } catch {
      // candidate missing or unreadable — keep looking
    }
  }
  return process.execPath;
}

function getUid(): number {
  return process.getuid?.() ?? 0;
}

function runningUnderUpdater(): boolean {
  return process.env[UPDATER_ENV_FLAG] === "1";
}

/**
 * The one rule both install and restart follow: only an auto-deploy defers
 * to a standing operator stop; a human at a terminal always wins.
 */
export function shouldLeaveBotStopped(
  underUpdater: boolean,
  stopMarkerExists: boolean
): boolean {
  return underUpdater && stopMarkerExists;
}

function setStopMarker(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STOP_MARKER_PATH, `${new Date().toISOString()}\n`);
}

function clearStopMarker(): void {
  fs.rmSync(STOP_MARKER_PATH, { force: true });
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

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Gateway overrides already baked into an installed updater plist. An
 * interactive reinstall without those variables in its environment must not
 * silently drop them — that would flip which repo the machine auto-deploys.
 */
export function extractGatewayOverrides(plistXml: string): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const name of GATEWAY_OVERRIDE_ENV_NAMES) {
    const match = plistXml.match(
      new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`)
    );
    if (match) overrides[name] = xmlUnescape(match[1]);
  }
  return overrides;
}

interface BotPlistOptions {
  doppler?: DopplerRuntime | null;
  nodePath?: string;
  cliPath?: string;
  durableLanes?: boolean;
}

export function buildBotProgramArguments(
  options: BotPlistOptions = {}
): string[] {
  const directCommand = [
    options.nodePath ?? resolveLaunchdNodePath(),
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
${options.durableLanes ? "    <key>LANES_STATE_BACKEND</key>\n    <string>http</string>" : ""}
  </dict>
</dict>
</plist>
`;
}

export function buildLaneWorkerProgramArguments(
  options: BotPlistOptions = {}
): string[] {
  const directCommand = [
    options.nodePath ?? resolveLaunchdNodePath(),
    options.cliPath ?? findCliEntrypoint(),
    "lanes",
    "worker",
    "--no-color",
  ];
  const command = options.doppler
    ? [
        options.doppler.executable,
        ...buildDopplerRunArgs(
          {
            ...options.doppler,
            secretNames: (
              options.doppler.secretNames ?? [...DOPPLER_RUNTIME_SECRET_NAMES]
            ).filter((name) => name !== "BELONG_HUMAN_APPROVAL_KEY"),
          },
          directCommand
        ),
      ]
    : directCommand;
  // Strip even a launchd-global ambient copy before Doppler starts. Doppler's
  // lane allowlist above cannot reintroduce the human-only approval secret.
  return ["/usr/bin/env", "-u", "BELONG_HUMAN_APPROVAL_KEY", ...command];
}

export function buildLaneWorkerPlist(options: BotPlistOptions = {}): string {
  const programArguments = buildLaneWorkerProgramArguments(options)
    .map((argument) => `    <string>${xmlEscape(argument)}</string>`)
    .join("\n");
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
  <string>${LANES_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(LANES_LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(LANES_LOG)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(STATE_DIR)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${pathEnv}</string>
    <key>HOME</key><string>${xmlEscape(os.homedir())}</string>
    <key>LANES_SITE</key><string>mac</string>
    <key>LANES_STATE_BACKEND</key><string>http</string>
    <key>CONDUCTOR_CLOUD_BACKEND</key><string>api</string>
    <key>CONDUCTOR_API_TIMEOUT_MS</key><string>30000</string>
    <key>CONDUCTOR_API_MAX_RETRIES</key><string>0</string>
  </dict>
</dict>
</plist>
`;
}

/** @internal exported for service-definition tests; not part of the CLI API. */
export function missingLaneServiceSecrets(
  names: ReadonlySet<string>
): string[] {
  return REQUIRED_LANE_SERVICE_SECRETS.filter((name) => !names.has(name));
}

function buildWatchdogPlist(): string {
  const nodePath = xmlEscape(resolveLaunchdNodePath());
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

/**
 * The auto-update agent. It runs /bin/bash on a copy of gateway-update.sh
 * that install places outside the checkout, so it keeps polling even when a
 * deploy left the checkout broken, and it depends on no node install at all
 * — the two things it exists to replace.
 */
export function buildUpdaterPlist(): string {
  const scriptPath = xmlEscape(UPDATER_SCRIPT_PATH);
  // launchd must append to the same file the script caps in place, so an
  // install-time log override moves BOTH, never just the script's side.
  const logPath = xmlEscape(
    process.env.CONDUCTOR_TELEGRAM_GATEWAY_LOG || UPDATE_LOG
  );
  // Unlike the bot plist (npm-prefix bin last), deploys want npm-prefix
  // tools ahead of system ones, so ~/.local/bin leads here.
  const pathEnv = xmlEscape(
    [
      path.join(os.homedir(), ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":")
  );
  // Bake any gateway overrides present at install time into the agent, since
  // launchd starts it with no shell environment.
  const gatewayEnvXml = GATEWAY_OVERRIDE_ENV_NAMES
    .filter((name) => process.env[name])
    .map(
      (name) =>
        `    <key>${xmlEscape(name)}</key>\n    <string>${xmlEscape(process.env[name] as string)}</string>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${UPDATER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${scriptPath}</string>
  </array>
  <key>StartInterval</key>
  <integer>${UPDATER_INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
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
${gatewayEnvXml ? `${gatewayEnvXml}\n` : ""}  </dict>
</dict>
</plist>
`;
}

function installUpdaterScript(): void {
  const source = findUpdaterScriptSource();
  if (!fs.existsSync(source)) {
    throw new Error(`updater script not found at ${source}`);
  }
  fs.mkdirSync(path.dirname(UPDATER_SCRIPT_PATH), { recursive: true });
  // Swap via rename so a tick already running the old copy keeps its inode.
  const staged = `${UPDATER_SCRIPT_PATH}.tmp`;
  fs.copyFileSync(source, staged);
  fs.chmodSync(staged, 0o755);
  fs.renameSync(staged, UPDATER_SCRIPT_PATH);
}

function writePlist(plistPath: string, contents: string): void {
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, contents, { mode: 0o644 });
}

function sleepSync(seconds: number): void {
  spawnSync("/bin/sleep", [String(seconds)]);
}

function bootstrap(label: string, plistPath: string): { ok: boolean; detail: string } {
  if (isLoaded(label)) {
    launchctl(["bootout", domainTarget(label)]);
    // launchd tears the job down asynchronously; bootstrapping while the
    // label still exists fails with "5: Input/output error". Wait for the
    // teardown to finish before re-registering.
    for (let i = 0; i < 20 && isLoaded(label); i++) {
      sleepSync(0.5);
    }
  }
  let detail = "bootstrap failed";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { code, stderr, stdout } = launchctl([
      "bootstrap",
      `gui/${getUid()}`,
      plistPath,
    ]);
    if (code === 0) {
      return {
        ok: true,
        detail: attempt === 1 ? "bootstrapped" : `bootstrapped (attempt ${attempt})`,
      };
    }
    detail = (stderr || stdout || "bootstrap failed").trim();
    sleepSync(attempt);
  }
  return { ok: false, detail };
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
  let dopplerSecretNames: ReadonlySet<string> | null = null;
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
      dopplerSecretNames = names;
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

  const lanesEnrolled = flags.withLanes || fs.existsSync(LANES_PLIST_PATH);
  if (lanesEnrolled && !doppler) {
    console.error(
      "The durable lanes launchd job requires a configured Doppler runtime so its independent process can receive Command Center and Conductor credentials."
    );
    process.exit(1);
  }
  if (lanesEnrolled) {
    const missingLaneSecrets = missingLaneServiceSecrets(
      dopplerSecretNames ?? new Set<string>()
    );
    if (missingLaneSecrets.length > 0) {
      console.error(
        `The durable lanes launchd job is missing required Doppler keys: ${missingLaneSecrets.join(", ")}`
      );
      process.exit(1);
    }
  }
  const botPlist = buildBotPlist({ doppler, durableLanes: lanesEnrolled });
  const watchdogPlist = buildWatchdogPlist();
  const lanesPlist = lanesEnrolled ? buildLaneWorkerPlist({ doppler }) : null;

  writePlist(PLIST_PATH, botPlist);
  writePlist(WATCHDOG_PLIST_PATH, watchdogPlist);
  if (lanesPlist) writePlist(LANES_PLIST_PATH, lanesPlist);

  console.log(`  wrote ${PLIST_PATH}`);
  console.log(`  wrote ${WATCHDOG_PLIST_PATH}`);
  if (lanesPlist) console.log(`  wrote ${LANES_PLIST_PATH}`);

  // Persist before bootstrapping. A bootstrap failure exits, and leaving
  // Doppler-managed secrets in config.json while the service is already live
  // under Doppler is the outcome this whole flow exists to avoid.
  if (shouldSaveConfig) {
    let persisted = loadPersistableConfig(flags);
    if (dopplerSecretNames) {
      persisted = stripDopplerManagedConfig(persisted, dopplerSecretNames);
    }
    saveConfig(persisted);
    console.log(`  saved runtime configuration to ${STATE_DIR}/config.json`);
  }

  if (!runningUnderUpdater()) {
    // An operator running install wants the bot up; only auto-deploys have
    // to respect a standing `service stop`.
    clearStopMarker();
  }
  if (shouldLeaveBotStopped(runningUnderUpdater(), fs.existsSync(STOP_MARKER_PATH))) {
    console.log(
      "  bot: left stopped (operator ran 'service stop'; resume with 'service start')"
    );
  } else {
    const bot = bootstrap(LABEL, PLIST_PATH);
    if (!bot.ok) {
      console.error(`  bot: FAIL — ${bot.detail}`);
      process.exit(1);
    }
    console.log(`  bot: ${bot.detail}`);
  }

  const watchdog = bootstrap(WATCHDOG_LABEL, WATCHDOG_PLIST_PATH);
  if (!watchdog.ok) {
    console.error(`  watchdog: FAIL — ${watchdog.detail}`);
    process.exit(1);
  }
  console.log(`  watchdog: ${watchdog.detail}`);

  if (lanesPlist) {
    if (shouldLeaveBotStopped(runningUnderUpdater(), fs.existsSync(STOP_MARKER_PATH))) {
      const stopped = bootout(LANES_LABEL);
      console.log(`  lanes: left stopped (${stopped.detail})`);
    } else {
      const lanes = bootstrap(LANES_LABEL, LANES_PLIST_PATH);
      if (!lanes.ok) {
        console.error(`  lanes: FAIL — ${lanes.detail}`);
        process.exit(1);
      }
      console.log(`  lanes: ${lanes.detail}`);
    }
  } else {
    console.log("  lanes: not enrolled (use service install --with-lanes)");
  }

  if (flags.withUpdater) {
    try {
      installUpdaterScript();
    } catch (error) {
      console.error(
        `  updater: FAIL — ${error instanceof Error ? error.message : error}`
      );
      process.exit(1);
    }
    // Carry forward overrides baked into the existing plist that this run's
    // environment doesn't set — a bare reinstall must not silently flip the
    // machine back to the default repo/branch/paths.
    if (fs.existsSync(UPDATER_PLIST_PATH)) {
      const existing = extractGatewayOverrides(
        fs.readFileSync(UPDATER_PLIST_PATH, "utf8")
      );
      for (const [name, value] of Object.entries(existing)) {
        if (!process.env[name]) {
          process.env[name] = value;
          console.log(`  updater: preserving ${name}=${value} from existing plist`);
        }
      }
    }
    const updaterPlist = buildUpdaterPlist();
    const plistChanged =
      !fs.existsSync(UPDATER_PLIST_PATH) ||
      fs.readFileSync(UPDATER_PLIST_PATH, "utf8") !== updaterPlist;
    writePlist(UPDATER_PLIST_PATH, updaterPlist);
    console.log(`  wrote ${UPDATER_PLIST_PATH}`);
    if (!isLoaded(UPDATER_LABEL)) {
      const updater = bootstrap(UPDATER_LABEL, UPDATER_PLIST_PATH);
      if (!updater.ok) {
        console.error(`  updater: FAIL — ${updater.detail}`);
        process.exit(1);
      }
      fs.rmSync(UPDATER_PLIST_PENDING_PATH, { force: true });
      console.log(`  updater: ${updater.detail}`);
    } else if (runningUnderUpdater()) {
      // Auto-deploys run *under* this agent; a bootout here would kill the
      // deploy that is installing us. The refreshed script is picked up on
      // the next tick regardless, since every tick re-reads it.
      if (plistChanged) {
        fs.writeFileSync(UPDATER_PLIST_PENDING_PATH, `${new Date().toISOString()}\n`);
        console.log(
          "  updater: already loaded (left running; plist changes apply at next login)"
        );
      } else {
        console.log("  updater: already loaded (left running)");
      }
    } else if (plistChanged) {
      const updater = bootstrap(UPDATER_LABEL, UPDATER_PLIST_PATH);
      if (!updater.ok) {
        console.error(`  updater: FAIL — ${updater.detail}`);
        process.exit(1);
      }
      fs.rmSync(UPDATER_PLIST_PENDING_PATH, { force: true });
      console.log("  updater: re-bootstrapped with updated configuration");
    } else {
      console.log("  updater: already loaded (up to date)");
    }
  } else if (fs.existsSync(UPDATER_PLIST_PATH)) {
    console.log(
      "  updater: left as-is (previously enrolled; 'service uninstall' removes it)"
    );
  }

  console.log();
  console.log("Bot and enrolled lane worker restart automatically on crash, logout, and reboot.");
  if (flags.withUpdater) {
    console.log(
      "Gateway auto-updates from the repo's main branch within a minute of every push."
    );
  }
  console.log(`Logs: ${BOT_LOG}`);
  if (lanesPlist) console.log(`Lane logs: ${LANES_LOG}`);
  console.log(`Run 'conductor-telegram service status' to verify.`);
}

async function cmdUninstall(): Promise<void> {
  const bot = bootout(LABEL);
  console.log(`  bot: ${bot.detail}`);
  const lanes = bootout(LANES_LABEL);
  console.log(`  lanes: ${lanes.detail}`);
  const watchdog = bootout(WATCHDOG_LABEL);
  console.log(`  watchdog: ${watchdog.detail}`);
  const updater = bootout(UPDATER_LABEL);
  console.log(`  updater: ${updater.detail}`);

  for (const p of [
    PLIST_PATH,
    LANES_PLIST_PATH,
    WATCHDOG_PLIST_PATH,
    UPDATER_PLIST_PATH,
    UPDATER_SCRIPT_PATH,
    STOP_MARKER_PATH,
    UPDATER_PLIST_PENDING_PATH,
  ]) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`  removed ${p}`);
    }
  }

  const gatewayHome = path.dirname(GATEWAY_REPO_DIR);
  if (fs.existsSync(gatewayHome)) {
    console.log();
    console.log("  left behind (remove manually if no longer wanted):");
    console.log(`    ${gatewayHome}  (deploy checkout + updater state)`);
    console.log(`    ${UPDATE_LOG}`);
    console.log("    the global install: npm uninstall -g conductor-telegram");
  }
}

async function cmdStart(): Promise<void> {
  if (!fs.existsSync(PLIST_PATH)) {
    console.error("Bot plist not installed. Run 'conductor-telegram service install' first.");
    process.exit(1);
  }
  clearStopMarker();
  if (!isLoaded(LABEL)) {
    const bot = bootstrap(LABEL, PLIST_PATH);
    console.log(`  bot: ${bot.detail}`);
  } else {
    const k = kickstart(LABEL);
    console.log(`  bot: ${k.detail}`);
  }
  if (fs.existsSync(LANES_PLIST_PATH)) {
    const lanes = isLoaded(LANES_LABEL)
      ? kickstart(LANES_LABEL)
      : bootstrap(LANES_LABEL, LANES_PLIST_PATH);
    console.log(`  lanes: ${lanes.detail}`);
  }
}

async function cmdStop(): Promise<void> {
  // Marker first: an auto-deploy landing mid-stop must already see it.
  setStopMarker();
  const bot = bootout(LABEL);
  console.log(`  bot: ${bot.detail}`);
  const lanes = bootout(LANES_LABEL);
  console.log(`  lanes: ${lanes.detail}`);
  if (fs.existsSync(UPDATER_PLIST_PATH)) {
    console.log("  auto-deploys will leave the bot stopped until 'service start'.");
  }
}

async function cmdRestart(): Promise<void> {
  if (shouldLeaveBotStopped(runningUnderUpdater(), fs.existsSync(STOP_MARKER_PATH))) {
    // Enforce, don't just skip: `service stop` may have raced the install
    // step of this same deploy, leaving the bot bootstrapped after the
    // operator's bootout. Bootout is idempotent when already down.
    const enforced = bootout(LABEL);
    const lanes = bootout(LANES_LABEL);
    console.log(
      `  bot: left stopped, ${enforced.detail} (operator ran 'service stop'; resume with 'service start')`
    );
    console.log(`  lanes: left stopped, ${lanes.detail}`);
    return;
  }
  clearStopMarker();
  if (isLoaded(LABEL)) {
    const k = kickstart(LABEL, true);
    console.log(`  bot: ${k.detail}`);
  } else {
    const bot = bootstrap(LABEL, PLIST_PATH);
    console.log(`  bot: ${bot.detail}`);
  }
  if (fs.existsSync(LANES_PLIST_PATH)) {
    const lanes = isLoaded(LANES_LABEL)
      ? kickstart(LANES_LABEL, true)
      : bootstrap(LANES_LABEL, LANES_PLIST_PATH);
    console.log(`  lanes: ${lanes.detail}`);
  }
}

// Shared with the bot status view; lives in bot/format.ts.

async function cmdStatus(): Promise<void> {
  const { getDb } = await import("../store/db.js");
  const { getHeartbeat } = await import("../store/queries.js");

  const botLoaded = isLoaded(LABEL);
  const lanesLoaded = isLoaded(LANES_LABEL);
  const watchdogLoaded = isLoaded(WATCHDOG_LABEL);
  const updaterLoaded = isLoaded(UPDATER_LABEL);
  console.log();
  console.log(`  bot agent        ${botLoaded ? "✓ loaded" : "✗ not loaded"}`);
  console.log(`  lanes agent      ${lanesLoaded ? "✓ loaded" : "✗ not loaded"}`);
  console.log(`  watchdog agent   ${watchdogLoaded ? "✓ loaded" : "✗ not loaded"}`);
  console.log(`  updater agent    ${updaterLoaded ? "✓ loaded" : "✗ not loaded"}`);
  console.log(`  plist (bot)      ${fs.existsSync(PLIST_PATH) ? PLIST_PATH : "not installed"}`);
  console.log(`  plist (lanes)    ${fs.existsSync(LANES_PLIST_PATH) ? LANES_PLIST_PATH : "not installed"}`);
  console.log(`  plist (wd)       ${fs.existsSync(WATCHDOG_PLIST_PATH) ? WATCHDOG_PLIST_PATH : "not installed"}`);
  console.log(`  plist (updater)  ${fs.existsSync(UPDATER_PLIST_PATH) ? UPDATER_PLIST_PATH : "not installed"}`);
  const gatewayRev = spawnSync(
    "git",
    ["-C", GATEWAY_REPO_DIR, "rev-parse", "--short", "HEAD"],
    { encoding: "utf8" }
  );
  if (gatewayRev.status === 0) {
    console.log(`  gateway checkout ${GATEWAY_REPO_DIR} @ ${gatewayRev.stdout.trim()}`);
  }
  if (fs.existsSync(STOP_MARKER_PATH)) {
    console.log(
      "  bot stopped by operator — auto-deploys will not restart it ('service start' resumes)"
    );
  }
  if (fs.existsSync(UPDATER_PLIST_PENDING_PATH)) {
    console.log(
      "  updater plist changed on disk — takes effect at next login/reboot (or bootout + service install --with-updater)"
    );
  }
  console.log(`  log              ${BOT_LOG}`);
  console.log(`  lanes log        ${LANES_LOG}`);
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
