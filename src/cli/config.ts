/**
 * Unified config module for conductor-telegram.
 * Precedence: CLI flags > env vars > config.json > defaults
 * Built by Belong.net — conductor.build
 */

import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".conductor-telegram");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const DOPPLER_REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const ConfigSchema = z
  .object({
    version: z.literal(1),
    // Empty values are valid only for a Doppler-backed service installation.
    // The start command still fails closed unless the merged runtime config
    // supplies both values.
    botToken: z.string(),
    ownerChatId: z.string(),
    ownerUserId: z.string().optional(),
    dbPath: z.string().optional(),
    conductorDbPath: z.string().optional(),
    conductorWorkspacesDir: z.string().optional(),
    conductorReposDir: z.string().optional(),
    downloadsDir: z.string().optional(),
    claudeBin: z.string().optional(),
    codexBin: z.string().optional(),
    permissionMode: z.string().optional(),
    defaultAgentType: z.string().optional(),
    defaultModel: z.string().optional(),
    reviewAgentType: z.string().optional(),
    reviewModel: z.string().optional(),
    conductorApiBaseUrl: z.string().url().optional(),
    conductorApiKey: z.string().optional(),
    conductorCloudBackend: z.enum(["auto", "api", "off"]).optional(),
    dopplerProject: z.string().regex(DOPPLER_REFERENCE_RE).optional(),
    dopplerConfig: z.string().regex(DOPPLER_REFERENCE_RE).optional(),
  })
  .superRefine((config, context) => {
    if (Boolean(config.dopplerProject) !== Boolean(config.dopplerConfig)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dopplerProject"],
        message: "Doppler project and config must be set together",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export interface CLIFlags {
  token?: string;
  chatId?: string;
  dbPath?: string;
  dopplerProject?: string;
  dopplerConfig?: string;
}

const DEFAULTS: Omit<Config, "botToken" | "ownerChatId"> & {
  botToken: string;
  ownerChatId: string;
} = {
  version: 1,
  botToken: "",
  ownerChatId: "",
  ownerUserId: undefined,
  dbPath: path.join(CONFIG_DIR, "conductor-telegram.db"),
  conductorDbPath: path.join(
    os.homedir(),
    "Library/Application Support/com.conductor.app/conductor.db"
  ),
  conductorWorkspacesDir: path.join(os.homedir(), "conductor/workspaces"),
  conductorReposDir: path.join(os.homedir(), "conductor/repos"),
  downloadsDir: path.join(CONFIG_DIR, "downloads"),
  claudeBin: path.join(
    os.homedir(),
    "Library/Application Support/com.conductor.app/bin/claude"
  ),
  codexBin: path.join(
    os.homedir(),
    "Library/Application Support/com.conductor.app/bin/codex"
  ),
  permissionMode: "acceptEdits",
  defaultAgentType: undefined,
  defaultModel: undefined,
  reviewAgentType: undefined,
  reviewModel: undefined,
  conductorApiBaseUrl: "https://api.conductor.build",
  conductorApiKey: undefined,
  conductorCloudBackend: "auto",
  dopplerProject: undefined,
  dopplerConfig: undefined,
};

type EnvConfigSource = Record<string, string | undefined>;

// Keep env-file migration and live env loading on the same key mapping.
function configFromEnvSource(env: EnvConfigSource): Partial<Config> {
  const config: Partial<Config> = { version: 1 };
  if (env.BOT_TOKEN) config.botToken = env.BOT_TOKEN;
  if (env.OWNER_CHAT_ID) config.ownerChatId = env.OWNER_CHAT_ID;
  if (env.OWNER_USER_ID) config.ownerUserId = env.OWNER_USER_ID;
  if (env.DB_PATH) config.dbPath = env.DB_PATH;
  if (env.CONDUCTOR_DB_PATH) config.conductorDbPath = env.CONDUCTOR_DB_PATH;
  if (env.CONDUCTOR_WORKSPACES_DIR) {
    config.conductorWorkspacesDir = env.CONDUCTOR_WORKSPACES_DIR;
  }
  if (env.CONDUCTOR_REPOS_DIR) config.conductorReposDir = env.CONDUCTOR_REPOS_DIR;
  if (env.TELEGRAM_DOWNLOADS_DIR) config.downloadsDir = env.TELEGRAM_DOWNLOADS_DIR;
  if (env.CLAUDE_BIN) config.claudeBin = env.CLAUDE_BIN;
  if (env.CODEX_BIN) config.codexBin = env.CODEX_BIN;
  if (env.TELEGRAM_AGENT_PERMISSION_MODE) {
    config.permissionMode = env.TELEGRAM_AGENT_PERMISSION_MODE;
  }
  if (env.TELEGRAM_DEFAULT_AGENT_TYPE) {
    config.defaultAgentType = env.TELEGRAM_DEFAULT_AGENT_TYPE;
  }
  if (env.TELEGRAM_DEFAULT_MODEL) config.defaultModel = env.TELEGRAM_DEFAULT_MODEL;
  if (env.TELEGRAM_REVIEW_AGENT_TYPE) {
    config.reviewAgentType = env.TELEGRAM_REVIEW_AGENT_TYPE;
  }
  if (env.TELEGRAM_REVIEW_MODEL) config.reviewModel = env.TELEGRAM_REVIEW_MODEL;
  if (env.CONDUCTOR_API_BASE_URL) {
    config.conductorApiBaseUrl = env.CONDUCTOR_API_BASE_URL;
  }
  if (env.CONDUCTOR_API_KEY) config.conductorApiKey = env.CONDUCTOR_API_KEY;
  if (
    env.CONDUCTOR_CLOUD_BACKEND === "auto" ||
    env.CONDUCTOR_CLOUD_BACKEND === "api" ||
    env.CONDUCTOR_CLOUD_BACKEND === "off"
  ) {
    config.conductorCloudBackend = env.CONDUCTOR_CLOUD_BACKEND;
  }
  if (env.CONDUCTOR_TELEGRAM_DOPPLER_PROJECT) {
    config.dopplerProject = env.CONDUCTOR_TELEGRAM_DOPPLER_PROJECT;
  }
  if (env.CONDUCTOR_TELEGRAM_DOPPLER_CONFIG) {
    config.dopplerConfig = env.CONDUCTOR_TELEGRAM_DOPPLER_CONFIG;
  }
  return config;
}

function readConfigFile(): Partial<Config> {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function readEnvVars(): Partial<Config> {
  return configFromEnvSource(process.env);
}

function applyFlags(flags: CLIFlags): Partial<Config> {
  const result: Partial<Config> = { version: 1 };
  if (flags.token) result.botToken = flags.token;
  if (flags.chatId) result.ownerChatId = flags.chatId;
  if (flags.dbPath) result.dbPath = flags.dbPath;
  if (flags.dopplerProject) result.dopplerProject = flags.dopplerProject;
  if (flags.dopplerConfig) result.dopplerConfig = flags.dopplerConfig;
  return result;
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

/** Load config with full precedence chain. Throws ZodError if invalid. */
export function loadConfig(flags: CLIFlags = {}): Config {
  const fileConfig = readConfigFile();
  const envConfig = readEnvVars();
  const flagConfig = applyFlags(flags);

  const merged = {
    ...DEFAULTS,
    ...stripUndefined(fileConfig as Record<string, unknown>),
    ...stripUndefined(envConfig as Record<string, unknown>),
    ...stripUndefined(flagConfig as Record<string, unknown>),
  };

  return ConfigSchema.parse(merged);
}

/**
 * Doppler references are non-secret pointers, so they may persist from the
 * environment. `scripts/deploy-mac-gateway.sh` sets them exactly this way.
 */
const PERSISTABLE_ENV_KEYS = ["dopplerProject", "dopplerConfig"] as const;

/**
 * Config that is safe to write back to disk.
 *
 * `loadConfig` merges the ambient environment, which is right for a running
 * process but wrong for persistence: a secret exported for a single command
 * would be captured into config.json and silently outlive the shell that set
 * it. Only the existing file, explicit flags, and the non-secret Doppler
 * references survive here.
 */
export function loadPersistableConfig(flags: CLIFlags = {}): Config {
  const fileConfig = stripUndefined(readConfigFile() as Record<string, unknown>);
  const envConfig = stripUndefined(readEnvVars() as Record<string, unknown>);
  const flagConfig = stripUndefined(applyFlags(flags) as Record<string, unknown>);

  const persistableEnv: Record<string, unknown> = {};
  for (const key of PERSISTABLE_ENV_KEYS) {
    if (envConfig[key] !== undefined) persistableEnv[key] = envConfig[key];
  }

  return ConfigSchema.parse({
    ...DEFAULTS,
    ...fileConfig,
    ...persistableEnv,
    ...flagConfig,
  });
}

/** Try to load config, returning null instead of throwing on validation errors. */
export function tryLoadConfig(flags: CLIFlags = {}): Config | null {
  try {
    return loadConfig(flags);
  } catch {
    return null;
  }
}

/** Save config to disk with 0600 permissions. */
export function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(CONFIG_DIR, 0o700);
  const content = JSON.stringify(config, null, 2) + "\n";
  fs.writeFileSync(CONFIG_PATH, content, { mode: 0o600 });
  // `mode` only applies when a file is created, so always repair permissions
  // for existing secret-bearing configuration files.
  fs.chmodSync(CONFIG_PATH, 0o600);
}

/** Check if config file exists. */
export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

/** Check if a .env file exists in the given directory. */
export function dotenvExists(dir: string = process.cwd()): boolean {
  return fs.existsSync(path.join(dir, ".env"));
}

/** Parse a .env file and return key-value pairs. */
export function parseDotenv(
  dir: string = process.cwd()
): Record<string, string> {
  const envPath = path.join(dir, ".env");
  if (!fs.existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (value) result[key] = value;
  }
  return result;
}

/** Migrate .env values to a Config object. */
export function migrateFromDotenv(
  dir: string = process.cwd()
): Partial<Config> {
  return configFromEnvSource(parseDotenv(dir));
}

export { CONFIG_DIR, CONFIG_PATH };
