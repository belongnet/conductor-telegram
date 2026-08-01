import { exec, execFile, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  createDecision,
  addEvent,
  getMetaValue,
  getWorkspaceByName as getTrackedWorkspaceByName,
  resetCloudThreadCursorAnchors,
  setMetaValue,
} from "../store/queries.js";
import { getConductorSetting } from "../store/conductor-settings.js";
import {
  cloudCycleIsInFlight,
  cloudSessionCycleKey,
  encodeCloudSessionCycle,
  mapWithConcurrency,
  parseCloudSessionCycle,
  MAX_CONCURRENT_SESSION_REQUESTS,
  type CloudSessionCycle,
} from "./polling-policy.js";
import {
  ConductorApiError,
  createConductorApiClientFromEnv,
  isConductorCloudApiConfigured,
  type ConductorApiClient,
  type ConductorApiMessage,
  type ConductorApiSession,
} from "../integrations/conductor-api.js";

/**
 * The env guidance shared by every observe-only refusal. One source so the
 * variable names cannot drift between the three surfaces that print it.
 */
export const CLOUD_OBSERVE_ONLY_HINT =
  "Set CONDUCTOR_API_KEY and leave CONDUCTOR_CLOUD_BACKEND=auto (or set it to api)";

export const CONDUCTOR_WORKSPACES_DIR =
  process.env.CONDUCTOR_WORKSPACES_DIR ?? `${process.env.HOME}/conductor/workspaces`;

const CONDUCTOR_DB_PATH =
  process.env.CONDUCTOR_DB_PATH ??
  `${process.env.HOME}/Library/Application Support/com.conductor.app/conductor.db`;

const CLAUDE_BIN =
  process.env.CLAUDE_BIN ??
  `${process.env.HOME}/Library/Application Support/com.conductor.app/bin/claude`;

const CODEX_BIN =
  process.env.CODEX_BIN ??
  `${process.env.HOME}/Library/Application Support/com.conductor.app/bin/codex`;

const TELEGRAM_AGENT_PERMISSION_MODE =
  process.env.TELEGRAM_AGENT_PERMISSION_MODE ?? "acceptEdits";

const DEFAULT_CLAUDE_MODEL = "claude-fable-5";
const DEFAULT_CODEX_MODEL = "gpt-5.5";

// City names for workspace directory naming (matches Conductor's convention)
const CITY_NAMES = [
  "abuja", "accra", "algiers", "amman", "ankara", "athens", "auckland",
  "baghdad", "bangkok", "beirut", "belgrade", "berlin", "bern", "bogota",
  "brasilia", "brisbane", "brussels", "budapest", "cairo", "canberra",
  "caracas", "colombo", "copenhagen", "cusco", "damascus", "delhi",
  "denver", "detroit", "doha", "dublin", "durban", "entebbe", "geneva",
  "guangzhou", "hanoi", "harare", "helsinki", "honolulu", "houston",
  "istanbul", "jakarta", "jeddah", "kabul", "kampala", "kathmandu",
  "kigali", "kinshasa", "kingston", "lagos", "lahore", "lisbon", "london",
  "luanda", "lusaka", "madrid", "malabo", "manila", "maputo", "marrakech",
  "melbourne", "milan", "minsk", "mogadishu", "moscow", "mumbai", "nairobi",
  "nicosia", "oslo", "paris", "perth", "prague", "pretoria", "quito",
  "rabat", "reykjavik", "riga", "riyadh", "rome", "rotterdam", "santiago",
  "seattle", "seoul", "shanghai", "singapore", "sofia", "stockholm",
  "sucre", "suva", "taipei", "tallinn", "tirana", "tokyo", "toronto",
  "tripoli", "tunis", "vancouver", "warsaw", "wellington", "windhoek",
  "yerevan", "zanzibar", "zurich",
];

// Track running agents by workspace name
const runningAgents = new Map<string, ChildProcess>();
const lastAssistantSdkMessageIds = new Map<string, string>();
// Track seen tool_use IDs to avoid duplicate question forwarding
const seenToolUseIds = new Set<string>();
// Map decision IDs to workspace names for stdin piping
const pendingStdinDecisions = new Map<number, string>();

function workspaceAgentKey(repoPath: string, workspaceName: string): string {
  return `${repoPath}::${workspaceName}`;
}

// ── Agent result interface ──────────────────────────────────

export interface AgentResult {
  resultText?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  isError: boolean;
  exitCode: number | null;
  /** Last portion of the agent process stderr, set only on failed runs. */
  stderrTail?: string;
}

const STDERR_TAIL_LIMIT = 2000;

export type AgentType = "claude" | "codex";
type LaunchMode = "prompt" | "review";
export type AgentAccessMode = "legacy" | "read-only" | "workspace-write";

interface SessionLaunchOptions {
  agentType?: AgentType;
  model?: string | null;
  title?: string | null;
  launchMode?: LaunchMode;
  reviewBaseBranch?: string | null;
  accessMode?: AgentAccessMode;
}

export interface WorkspaceLaunchOptions extends SessionLaunchOptions {}

interface ResolvedLaunchConfig {
  agentType: AgentType;
  model: string;
  title: string;
  launchMode: LaunchMode;
  reviewBaseBranch: string | null;
  codexThinkingLevel: string | null;
  claudeEffortLevel: string | null;
  accessMode: AgentAccessMode;
}

interface SessionCreateResult {
  sessionId: string;
  initialCursorRowid: number;
  agentType: AgentType;
  model: string;
}

/**
 * Format an attachment as a markdown file reference. Conductor renders image
 * refs inline, and the Telegram outbound media extractor recognizes this same
 * syntax when agents send generated files back.
 */
export function formatAttachmentReference(filePath: string): string {
  const filename = path.basename(filePath);
  if (isImageAttachment(filePath)) {
    return `![${filename}](${filePath})`;
  }
  return `[${filename}](${filePath})`;
}

function buildPromptWithAttachments(
  prompt: string,
  attachmentPaths: string[]
): string {
  const trimmedPrompt = prompt.trim();
  if (attachmentPaths.length === 0) {
    return trimmedPrompt;
  }

  const attachmentLines = attachmentPaths.map(formatAttachmentReference);
  if (!trimmedPrompt) {
    return attachmentLines.join("\n");
  }

  return `${trimmedPrompt}\n\n${attachmentLines.join("\n")}`;
}

export function stageAttachmentPaths(
  workspaceDir: string,
  sourcePaths: string[]
): string[] {
  if (sourcePaths.length === 0) {
    return [];
  }

  const attachmentsDir = path.join(workspaceDir, ".context", "attachments");
  mkdirSync(attachmentsDir, { recursive: true });

  const timestamp = Date.now();
  return sourcePaths.map((sourcePath, index) => {
    const ext = path.extname(sourcePath) || ".bin";
    const destPath = path.join(attachmentsDir, `${timestamp}-${index + 1}${ext}`);
    copyFileSync(sourcePath, destPath);
    return destPath;
  });
}

function revealWorkspaceInConductor(workspaceDir: string): void {
  const child = spawn("open", ["-g", "-a", "Conductor", workspaceDir], {
    detached: true,
    stdio: "ignore",
  });

  child.on("error", (err) => {
    console.error(`[launcher] Failed to reveal workspace in Conductor:`, err);
  });
  child.unref();
}

function normalizeAgentType(value: string | null | undefined): AgentType | null {
  if (value === "claude" || value === "codex") {
    return value;
  }
  return null;
}

export function inferAgentTypeFromModel(
  model: string | null | undefined
): AgentType | null {
  const normalized = normalizeModelForCli(model?.trim() ?? "").toLowerCase();
  if (!normalized) {
    return null;
  }
  if (/^(gpt|o\d|codex)([-_.]|$)/.test(normalized)) {
    return "codex";
  }
  if (/(^|[-_.])(claude|opus|sonnet|haiku|fable)([-_.]|$)/.test(normalized)) {
    return "claude";
  }
  return null;
}

/**
 * Conductor 0.72 moved settings to ~/.conductor/settings.toml; the DB rows
 * this bot historically read are deprecated (but kept as fallback).
 */
function getSettingValue(key: string): string | null {
  return getConductorSetting(key);
}

function hasAgentSessions(agentType: AgentType): boolean {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const row = db.prepare(
      "SELECT 1 as present FROM sessions WHERE agent_type = ? LIMIT 1"
    ).get(agentType) as { present?: number } | undefined;
    db.close();
    return row?.present === 1;
  } catch {
    return false;
  }
}

function getDefaultAgentType(): AgentType {
  return (
    normalizeAgentType(process.env.TELEGRAM_DEFAULT_AGENT_TYPE) ??
    inferAgentTypeFromModel(process.env.TELEGRAM_DEFAULT_MODEL) ??
    inferAgentTypeFromModel(getSettingValue("default_model")) ??
    "claude"
  );
}

function getReviewAgentType(): AgentType {
  const configured = normalizeAgentType(process.env.TELEGRAM_REVIEW_AGENT_TYPE);
  if (configured) {
    return configured;
  }
  const reviewModelAgent =
    inferAgentTypeFromModel(process.env.TELEGRAM_REVIEW_MODEL) ??
    inferAgentTypeFromModel(getSettingValue("review_model"));
  if (reviewModelAgent) {
    return reviewModelAgent;
  }
  if (hasAgentSessions("codex")) {
    return "codex";
  }
  return getDefaultAgentType();
}

/**
 * Strip Conductor-internal context-window suffixes (e.g. "opus-1m" → "opus")
 * so the model identifier is valid for the Claude CLI.
 */
function normalizeModelForCli(model: string): string {
  return model.replace(/-\d+[mk]$/i, "");
}

function normalizeModelForConductorApi(model: string): string {
  return model.replace(/^claude-/i, "");
}

function isModelCompatibleWithAgent(model: string, agentType: AgentType): boolean {
  const inferredAgentType = inferAgentTypeFromModel(model);
  return inferredAgentType === null || inferredAgentType === agentType;
}

function firstCompatibleModel(
  agentType: AgentType,
  candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const normalized = candidate?.trim()
      ? normalizeModelForCli(candidate.trim())
      : null;
    if (normalized && isModelCompatibleWithAgent(normalized, agentType)) {
      return normalized;
    }
  }
  return null;
}

function firstCompatibleApiModel(
  agentType: AgentType,
  candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const normalized = candidate?.trim()
      ? normalizeModelForConductorApi(candidate.trim())
      : null;
    if (normalized && isModelCompatibleWithAgent(normalized, agentType)) {
      return normalized;
    }
  }
  return null;
}

function resolveAgentModel(
  agentType: AgentType,
  launchMode: LaunchMode,
  requestedModel?: string | null
): string {
  if (requestedModel?.trim()) {
    return normalizeModelForCli(requestedModel.trim());
  }

  const envModel =
    launchMode === "review"
      ? process.env.TELEGRAM_REVIEW_MODEL
      : process.env.TELEGRAM_DEFAULT_MODEL;
  if (envModel?.trim()) {
    return normalizeModelForCli(envModel.trim());
  }

  // Session history is deliberately not consulted here: the bot writes each
  // launch's model back into the sessions table, so a historical model would
  // re-elect itself on every launch and shipped default upgrades would never
  // take effect.
  const configuredModel =
    launchMode === "review"
      ? getSettingValue("review_model")
      : getSettingValue("default_model");
  const fallback =
    agentType === "claude" ? DEFAULT_CLAUDE_MODEL : DEFAULT_CODEX_MODEL;
  return firstCompatibleModel(agentType, [configuredModel]) ?? fallback;
}

function resolveAgentModelForConductorApi(
  agentType: AgentType,
  launchMode: LaunchMode,
  requestedModel?: string | null
): string {
  const envModel =
    launchMode === "review"
      ? process.env.TELEGRAM_REVIEW_MODEL
      : process.env.TELEGRAM_DEFAULT_MODEL;
  const configuredModel =
    launchMode === "review"
      ? getSettingValue("review_model")
      : getSettingValue("default_model");
  const fallback =
    agentType === "claude" ? DEFAULT_CLAUDE_MODEL : DEFAULT_CODEX_MODEL;
  return (
    firstCompatibleApiModel(agentType, [
      requestedModel,
      envModel,
      configuredModel,
    ]) ?? normalizeModelForConductorApi(fallback)
  );
}

function resolveCodexThinkingLevel(launchMode: LaunchMode): string | null {
  const settingKey =
    launchMode === "review"
      ? "review_codex_thinking_level"
      : "default_codex_thinking_level";
  return getSettingValue(settingKey);
}

function resolveClaudeEffortLevel(launchMode: LaunchMode): string | null {
  const settingKey =
    launchMode === "review"
      ? "review_claude_effort_level"
      : "default_claude_effort_level";
  return getSettingValue(settingKey);
}

function resolveCloudSessionEffort(
  config: Pick<
    ResolvedLaunchConfig,
    "agentType" | "codexThinkingLevel" | "claudeEffortLevel"
  >
): string | undefined {
  const level =
    config.agentType === "codex"
      ? config.codexThinkingLevel
      : config.claudeEffortLevel;
  return level ?? undefined;
}

function deriveSessionTitle(
  prompt: string,
  fallback: string
): string {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !line.startsWith("[Attached:") &&
        !isStandaloneAttachmentReference(line)
    );
  return truncateTitle(firstLine ?? fallback, 80);
}

function isStandaloneAttachmentReference(line: string): boolean {
  return (
    /^!\[[^\]]*\]\([^)\s]+\)\s*$/.test(line) ||
    /^\[[^\]]+\]\([^)\s]+\)\s*$/.test(line)
  );
}

function truncateTitle(value: string, maxLen: number): string {
  return value.length > maxLen ? `${value.slice(0, maxLen - 3)}...` : value;
}

export function resolveLaunchConfig(
  options: SessionLaunchOptions
): ResolvedLaunchConfig {
  const launchMode = options.launchMode ?? "prompt";
  const agentType =
    options.agentType ??
    (launchMode === "review" ? getReviewAgentType() : getDefaultAgentType());
  const model = resolveAgentModel(agentType, launchMode, options.model);
  const title =
    options.title?.trim() ||
    (launchMode === "review" ? "Review Changes" : "Untitled");

  return {
    agentType,
    model,
    title,
    launchMode,
    reviewBaseBranch: options.reviewBaseBranch ?? null,
    accessMode:
      options.accessMode ?? (launchMode === "review" ? "read-only" : "legacy"),
    codexThinkingLevel:
      agentType === "codex" ? resolveCodexThinkingLevel(launchMode) : null,
    claudeEffortLevel:
      agentType === "claude" ? resolveClaudeEffortLevel(launchMode) : null,
  };
}

function restrictedCodexLaunchError(
  config: Pick<
    ResolvedLaunchConfig,
    "agentType" | "launchMode" | "accessMode"
  >
): string | null {
  if (
    config.agentType === "codex" &&
    (config.launchMode === "review" || config.accessMode === "read-only")
  ) {
    return (
      "Restricted Codex launches are disabled because its read-only sandbox " +
      "does not isolate the CLI authentication store. Configure Claude as the review agent."
    );
  }
  return null;
}

function isImageAttachment(filePath: string): boolean {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic"].includes(
    path.extname(filePath).toLowerCase()
  );
}

const TELEGRAM_INLINE_MEDIA_SYSTEM_PROMPT = [
  "Telegram inline file bridge:",
  "- Files the user sends via Telegram arrive in your prompts as markdown image refs `![filename](/abs/path)` for images or markdown links `[filename](/abs/path)` for other files. Treat these as the user's real attachments.",
  "- When you want the user to see a file you produced, reference it with the same syntax: `![name.png](/abs/path/to/name.png)` for images, `[name.ext](/abs/path/to/name.ext)` for everything else. The bridge will upload it to Telegram as a real attachment.",
  "- Use absolute paths inside the workspace.",
].join("\n");

const AGENT_ENV_ALLOWLIST = [
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
] as const;

/**
 * Build the environment visible to an autonomous agent.
 *
 * The bot process may hold Telegram and cloud-provider credentials. Child
 * agents get only the small runtime allowlist below plus
 * non-secret workspace coordinates. Authentication should come from the
 * locally logged-in CLI/keychain, not inherited API-key environment variables.
 */
export function buildAgentEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  context: {
    agentType: AgentType;
    accessMode?: AgentAccessMode;
    workspaceName: string;
    workspaceDir: string;
    repoPath: string;
  }
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of AGENT_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  const operatorHome = source.HOME?.trim() || os.homedir();
  const runtimeHome = createAgentRuntimeHome(context.workspaceDir);
  result.HOME = runtimeHome;
  if (context.agentType === "codex") {
    result.CODEX_HOME =
      source.CODEX_HOME?.trim() || path.join(operatorHome, ".codex");
  } else {
    result.CLAUDE_CONFIG_DIR =
      source.CLAUDE_CONFIG_DIR?.trim() || path.join(operatorHome, ".claude");
  }
  result.CONDUCTOR_WORKSPACE_NAME = context.workspaceName;
  result.CONDUCTOR_WORKSPACE_PATH = context.workspaceDir;
  result.CONDUCTOR_ROOT_PATH = context.repoPath;

  // Oversight database coordinates. The MCP server runs as a child of the
  // agent and resolves these from its own environment; relative to the
  // isolated HOME it would otherwise create an empty database and silently
  // drop every report_status/report_artifact/request_human call.
  result.DB_PATH =
    source.DB_PATH?.trim() ||
    path.join(operatorHome, ".conductor-telegram", "conductor-telegram.db");
  result.CONDUCTOR_DB_PATH =
    source.CONDUCTOR_DB_PATH?.trim() ||
    path.join(
      operatorHome,
      "Library",
      "Application Support",
      "com.conductor.app",
      "conductor.db"
    );

  // Full-access launches are expected to commit, push, and open PRs, but the
  // isolated HOME hides the operator's git/gh/ssh stores. Re-point them at the
  // real ones the way CODEX_HOME/CLAUDE_CONFIG_DIR already are. Restricted
  // launches are review-only and stay without VCS credentials.
  if ((context.accessMode ?? "legacy") === "legacy") {
    result.GIT_CONFIG_GLOBAL =
      source.GIT_CONFIG_GLOBAL?.trim() || path.join(operatorHome, ".gitconfig");
    result.GH_CONFIG_DIR =
      source.GH_CONFIG_DIR?.trim() || path.join(operatorHome, ".config", "gh");
    if (source.SSH_AUTH_SOCK?.trim()) {
      result.SSH_AUTH_SOCK = source.SSH_AUTH_SOCK.trim();
    }
    const sshCommand =
      source.GIT_SSH_COMMAND?.trim() || operatorGitSshCommand(operatorHome);
    if (sshCommand) result.GIT_SSH_COMMAND = sshCommand;
  }
  return result;
}

/** Standard key names ssh would have found under the operator's real HOME. */
const SSH_IDENTITY_FILENAMES = ["id_ed25519", "id_ecdsa", "id_rsa"] as const;

/**
 * Point ssh back at the operator's ~/.ssh, since HOME no longer resolves there.
 * Returns null when the operator has no ssh directory at all.
 */
function operatorGitSshCommand(operatorHome: string): string | null {
  const sshDir = path.join(operatorHome, ".ssh");
  if (!existsSync(sshDir)) return null;
  const parts = ["ssh"];
  const configPath = path.join(sshDir, "config");
  if (existsSync(configPath)) parts.push("-F", shellQuote(configPath));
  const knownHosts = path.join(sshDir, "known_hosts");
  if (existsSync(knownHosts)) {
    parts.push("-o", shellQuote(`UserKnownHostsFile=${knownHosts}`));
  }
  for (const name of SSH_IDENTITY_FILENAMES) {
    const keyPath = path.join(sshDir, name);
    if (existsSync(keyPath)) {
      parts.push("-o", shellQuote(`IdentityFile=${keyPath}`));
    }
  }
  return parts.length > 1 ? parts.join(" ") : null;
}

function createAgentRuntimeHome(workspaceDir: string): string {
  const root = path.join(os.tmpdir(), "conductor-telegram-agents");
  if (existsSync(root)) {
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Agent runtime temp root must be a real private directory");
    }
  } else {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  chmodSync(root, 0o700);
  const workspaceKey = createHash("sha256")
    .update(path.resolve(workspaceDir))
    .digest("hex")
    .slice(0, 24);
  const runtimeHome = path.join(root, `${workspaceKey}-${randomUUID()}`);
  mkdirSync(runtimeHome, { mode: 0o700 });
  chmodSync(runtimeHome, 0o700);
  return runtimeHome;
}

function cleanupAgentRuntimeHome(env: NodeJS.ProcessEnv): void {
  const runtimeHome = env.HOME;
  const root = path.resolve(os.tmpdir(), "conductor-telegram-agents");
  if (
    !runtimeHome ||
    !path.resolve(runtimeHome).startsWith(`${root}${path.sep}`)
  ) {
    return;
  }
  try {
    rmSync(runtimeHome, { recursive: true, force: true });
  } catch (error) {
    console.warn("[agent] Could not clean isolated runtime home:", error);
  }
}

const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const CODEX_EXEC_ISOLATION_ARGS = ["--ignore-user-config", "--ignore-rules"];

export function claudeAccessArgs(accessMode: AgentAccessMode): string[] {
  if (accessMode === "read-only") {
    return [
      "--permission-mode",
      "plan",
      "--tools",
      "Read,Glob,Grep",
      "--allowedTools",
      "Read(./**),Glob,Grep",
      "--setting-sources",
      "",
      "--safe-mode",
      "--no-chrome",
      "--strict-mcp-config",
      "--mcp-config",
      EMPTY_MCP_CONFIG,
      "--disable-slash-commands",
    ];
  }
  if (accessMode === "workspace-write") {
    return [
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Edit,Write,Glob,Grep",
      "--allowedTools",
      "Read(./**),Edit(./**),Write(./**),Glob,Grep",
      "--setting-sources",
      "",
      "--safe-mode",
      "--no-chrome",
      "--strict-mcp-config",
      "--mcp-config",
      EMPTY_MCP_CONFIG,
      "--disable-slash-commands",
    ];
  }
  return ["--permission-mode", TELEGRAM_AGENT_PERMISSION_MODE];
}

function codexAccessArgs(accessMode: AgentAccessMode): string[] {
  const sandbox = accessMode === "read-only" ? "read-only" : "workspace-write";
  return [
    "--sandbox",
    sandbox,
    "--ask-for-approval",
    "never",
    "--config",
    "mcp_servers={}",
    "--disable",
    "apps",
    "--disable",
    "browser_use",
    "--disable",
    "browser_use_external",
    "--disable",
    "computer_use",
    "--disable",
    "hooks",
    "--disable",
    "in_app_browser",
    "--disable",
    "multi_agent",
    "--disable",
    "plugins",
  ];
}

// ── Core: spawn Claude CLI + mirror to DB ───────────────────

function spawnAgent(
  conductorSessionId: string,
  repoPath: string,
  workspaceDir: string,
  prompt: string,
  model: string,
  agentType: AgentType,
  workspaceName: string,
  options: {
    agentSessionId?: string | null;
    isFollowUp?: boolean;
    attachmentPaths?: string[];
    launchMode?: LaunchMode;
    accessMode?: AgentAccessMode;
  } = {}
): { child: ChildProcess; done: Promise<AgentResult> } {
  if (agentType === "codex") {
    return spawnCodexAgent(
      conductorSessionId,
      repoPath,
      workspaceDir,
      prompt,
      model,
      workspaceName,
      options
    );
  }

  return spawnClaudeAgent(
    conductorSessionId,
    repoPath,
    workspaceDir,
    prompt,
    model,
    workspaceName,
    options
  );
}

function spawnClaudeAgent(
  conductorSessionId: string,
  repoPath: string,
  workspaceDir: string,
  prompt: string,
  model: string,
  workspaceName: string,
  options: {
    agentSessionId?: string | null;
    isFollowUp?: boolean;
    accessMode?: AgentAccessMode;
  } = {}
): { child: ChildProcess; done: Promise<AgentResult> } {
  const isFollowUp = options.isFollowUp ?? false;
  const sessionFlag = isFollowUp ? "--resume" : "--session-id";
  // App-created threads have a Claude session id that differs from the
  // Conductor session id; resuming the Conductor id makes the CLI exit
  // immediately with "No conversation found".
  const sessionArg = isFollowUp
    ? options.agentSessionId ?? conductorSessionId
    : conductorSessionId;
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    sessionFlag, sessionArg,
    "--max-turns", "1000",
    "--model", model,
    ...claudeAccessArgs(options.accessMode ?? "legacy"),
    "--append-system-prompt", TELEGRAM_INLINE_MEDIA_SYSTEM_PROMPT,
  ];

  console.log(`[agent] Spawning: claude ${args.join(" ").slice(0, 100)}...`);
  console.log(`[agent] CWD: ${workspaceDir}`);

  console.log(`[agent] CLAUDE_BIN: ${CLAUDE_BIN}`);

  const agentEnv = buildAgentEnvironment(process.env, {
    agentType: "claude",
    accessMode: options.accessMode ?? "legacy",
    workspaceName,
    workspaceDir,
    repoPath,
  });
  const child = spawn(CLAUDE_BIN, args, {
    cwd: workspaceDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: agentEnv,
  });

  console.log(`[agent] Spawned PID: ${child.pid}`);

  runningAgents.set(workspaceAgentKey(repoPath, workspaceName), child);

  // Mark session as working
  updateSessionStatus(conductorSessionId, "working");

  const done = new Promise<AgentResult>((resolve) => {
    let result: AgentResult = { isError: false, exitCode: null };
    let buffer = "";
    let stdoutBytes = 0;
    let stderrTail = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      console.log(`[agent:stdout] Received ${chunk.length} bytes (total: ${stdoutBytes})`);
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          processStreamMessage(conductorSessionId, msg, model, workspaceName, repoPath);

          // Extract result info
          if (msg.type === "result") {
            result.resultText = msg.result;
            result.costUsd = msg.total_cost_usd;
            result.durationMs = msg.duration_ms;
            result.numTurns = msg.num_turns;
            result.isError = msg.is_error ?? false;
          }
        } catch {
          console.log(`[agent] Non-JSON output: ${line.slice(0, 100)}`);
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
      const trimmed = text.trim();
      if (trimmed) console.log(`[agent:stderr] ${trimmed.slice(0, 200)}`);
    });

    child.on("close", (code) => {
      console.log(`[agent] Process exited with code ${code}`);
      result.exitCode = code;
      // code === null means killed by signal (e.g. user pressed Stop) — not an error.
      if (code !== null && code !== 0 && !result.resultText) {
        result.isError = true;
      }
      if (result.isError && stderrTail.trim()) {
        result.stderrTail = stderrTail.trim();
      }
      runningAgents.delete(workspaceAgentKey(repoPath, workspaceName));
      updateSessionStatus(conductorSessionId, "idle");
      cleanupAgentRuntimeHome(agentEnv);
      resolve(result);
    });

    child.on("error", (err) => {
      console.error(`[agent] Spawn error:`, err);
      result.isError = true;
      result.exitCode = -1;
      result.stderrTail = String(err?.message ?? err);
      runningAgents.delete(workspaceAgentKey(repoPath, workspaceName));
      updateSessionStatus(conductorSessionId, "idle");
      cleanupAgentRuntimeHome(agentEnv);
      resolve(result);
    });
  });

  return { child, done };
}

function spawnCodexAgent(
  conductorSessionId: string,
  repoPath: string,
  workspaceDir: string,
  prompt: string,
  model: string,
  workspaceName: string,
  options: {
    agentSessionId?: string | null;
    isFollowUp?: boolean;
    attachmentPaths?: string[];
    launchMode?: LaunchMode;
    accessMode?: AgentAccessMode;
  } = {}
): { child: ChildProcess; done: Promise<AgentResult> } {
  const launchMode = options.launchMode ?? "prompt";
  const accessMode = options.accessMode ?? "legacy";
  if (launchMode === "review" || accessMode === "read-only") {
    throw new Error(
      "Restricted Codex launches are disabled; configure Claude for review work"
    );
  }
  const agentSessionId = options.agentSessionId ?? null;
  const args = buildCodexExecArgs(
    model,
    prompt,
    agentSessionId,
    options.attachmentPaths ?? [],
    accessMode
  );

  console.log(`[agent] Spawning: codex ${args.join(" ").slice(0, 120)}...`);
  console.log(`[agent] CWD: ${workspaceDir}`);
  console.log(`[agent] CODEX_BIN: ${CODEX_BIN}`);

  const agentEnv = buildAgentEnvironment(process.env, {
    agentType: "codex",
    accessMode,
    workspaceName,
    workspaceDir,
    repoPath,
  });
  const child = spawn(CODEX_BIN, args, {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: agentEnv,
  });

  console.log(`[agent] Spawned PID: ${child.pid}`);

  runningAgents.set(workspaceAgentKey(repoPath, workspaceName), child);
  updateSessionStatus(conductorSessionId, "working");

  const done = new Promise<AgentResult>((resolve) => {
    let result: AgentResult = { isError: false, exitCode: null };
    let buffer = "";
    const startedAt = Date.now();
    let turnCount = 0;
    let latestAgentSessionId = agentSessionId;
    let lastAssistantText = "";
    let stderrTail = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const parsed = processCodexStreamMessage(
            conductorSessionId,
            msg,
            latestAgentSessionId
          );
          if (parsed.agentSessionId) {
            latestAgentSessionId = parsed.agentSessionId;
          }
          if (parsed.assistantText) {
            lastAssistantText = parsed.assistantText;
          }
          if (msg.type === "turn.completed") {
            turnCount += 1;
          }
        } catch {
          console.log(`[agent] Non-JSON output: ${line.slice(0, 100)}`);
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
      const trimmed = text.trim();
      if (trimmed) console.log(`[agent:stderr] ${trimmed.slice(0, 200)}`);
    });

    child.on("close", (code) => {
      console.log(`[agent] Process exited with code ${code}`);
      result.exitCode = code;
      result.durationMs = Date.now() - startedAt;
      result.numTurns = turnCount;
      result.resultText = lastAssistantText || result.resultText;
      if (code !== null && code !== 0 && !result.resultText) {
        result.isError = true;
      }
      if (result.isError && stderrTail.trim()) {
        result.stderrTail = stderrTail.trim();
      }

      if (lastAssistantText) {
        insertCodexResultMessage(
          conductorSessionId,
          latestAgentSessionId ?? conductorSessionId,
          lastAssistantText,
          result.durationMs,
          turnCount,
          result.isError
        );
      }

      runningAgents.delete(workspaceAgentKey(repoPath, workspaceName));
      updateSessionStatus(conductorSessionId, "idle");
      cleanupAgentRuntimeHome(agentEnv);
      resolve(result);
    });

    child.on("error", (err) => {
      console.error(`[agent] Spawn error:`, err);
      result.isError = true;
      result.exitCode = -1;
      result.stderrTail = String(err?.message ?? err);
      result.durationMs = Date.now() - startedAt;
      runningAgents.delete(workspaceAgentKey(repoPath, workspaceName));
      updateSessionStatus(conductorSessionId, "idle");
      cleanupAgentRuntimeHome(agentEnv);
      resolve(result);
    });
  });

  return { child, done };
}

export function buildCodexExecArgs(
  model: string,
  prompt: string,
  agentSessionId: string | null,
  attachmentPaths: string[],
  accessMode: AgentAccessMode = "legacy"
): string[] {
  const imageArgs = attachmentPaths
    .filter(isImageAttachment)
    .flatMap((filePath) => ["--image", filePath]);

  // The prompt is attacker-controlled, and Codex accepts sandbox-defeating
  // flags on the exec subcommand. `--` forces everything after it to be read
  // as a positional, so a message starting with "--dangerously-bypass-..."
  // stays a prompt.
  if (agentSessionId) {
    return [
      ...codexAccessArgs(accessMode),
      "exec",
      "resume",
      "--json",
      ...CODEX_EXEC_ISOLATION_ARGS,
      "--model",
      model,
      ...imageArgs,
      "--",
      agentSessionId,
      prompt,
    ];
  }

  return [
    ...codexAccessArgs(accessMode),
    "exec",
    "--json",
    ...CODEX_EXEC_ISOLATION_ARGS,
    "--model",
    model,
    ...imageArgs,
    "--",
    prompt,
  ];
}

function processCodexStreamMessage(
  conductorSessionId: string,
  msg: any,
  currentAgentSessionId: string | null
): { agentSessionId?: string; assistantText?: string } {
  if (msg.type === "thread.started" && typeof msg.thread_id === "string") {
    updateAgentSessionId(conductorSessionId, msg.thread_id);
    insertSessionMessage(
      conductorSessionId,
      "assistant",
      JSON.stringify({
        type: "system",
        session_id: msg.thread_id,
      }),
      new Date().toISOString(),
      null,
      null,
      null,
      randomUUID()
    );
    return { agentSessionId: msg.thread_id };
  }

  if (
    msg.type === "item.completed" &&
    msg.item?.type === "agent_message" &&
    typeof msg.item.text === "string"
  ) {
    const agentSessionId = currentAgentSessionId ?? conductorSessionId;
    insertSessionMessage(
      conductorSessionId,
      "assistant",
      JSON.stringify({
        type: "assistant",
        session_id: agentSessionId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: msg.item.text }],
        },
      }),
      new Date().toISOString(),
      null,
      null,
      null,
      randomUUID()
    );
    return { assistantText: msg.item.text };
  }

  return {};
}

function insertCodexResultMessage(
  conductorSessionId: string,
  agentSessionId: string,
  resultText: string,
  durationMs: number | undefined,
  numTurns: number,
  isError: boolean
): void {
  insertSessionMessage(
    conductorSessionId,
    "assistant",
    JSON.stringify({
      type: "result",
      session_id: agentSessionId,
      result: resultText,
      duration_ms: durationMs ?? 0,
      num_turns: numTurns,
      is_error: isError,
    }),
    new Date().toISOString(),
    null,
    null,
    null,
    randomUUID()
  );
}

function insertSessionMessage(
  sessionId: string,
  role: string,
  content: string,
  timestamp: string,
  model: string | null,
  sdkMessageId: string | null,
  lastAssistantMessageId: string | null,
  turnId: string
): void {
  const messageId = randomUUID();

  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    db.prepare(
      `INSERT OR IGNORE INTO session_messages
       (id, session_id, role, content, created_at, sent_at, model, sdk_message_id, last_assistant_message_id, turn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      messageId,
      sessionId,
      role,
      content,
      timestamp,
      timestamp,
      model,
      sdkMessageId,
      lastAssistantMessageId,
      turnId
    );
    db.close();
  } catch (err) {
    console.error(`[db] Failed to insert message:`, err);
  }
}

/**
 * Send text input to a running agent's stdin (for answering AskUserQuestion).
 * Returns true if the write succeeded.
 */
export function sendInputToAgent(agentKey: string, input: string): boolean {
  const child = runningAgents.get(agentKey);
  if (!child?.stdin?.writable) return false;
  child.stdin.write(input + "\n");
  return true;
}

/**
 * Pull the question text and option labels out of an AskUserQuestion tool_use input.
 *
 * Claude Code's AskUserQuestion tool ships the prompt as `questions: [{ question, options: [{ label, description }] }]`
 * (1-4 questions per call). Older variants used a flat `{ question, options: string[] }`. We accept both so the
 * Telegram surface keeps working across SDK versions. Multi-question calls collapse to the first question for now,
 * with the rest mentioned in the body so the operator at least sees them.
 */
export function extractAskUserQuestion(input: any): { question: string; options: string[] | undefined } {
  const fallback = "Agent is asking a question";

  const questions = Array.isArray(input?.questions) ? input.questions : null;
  if (questions && questions.length > 0) {
    const first = questions[0];
    const primary: string = typeof first?.question === "string" ? first.question : fallback;
    const opts = Array.isArray(first?.options)
      ? first.options
          .map((o: any) => (typeof o === "string" ? o : typeof o?.label === "string" ? o.label : null))
          .filter((s: string | null): s is string => Boolean(s))
      : undefined;

    if (questions.length > 1) {
      const extras = questions
        .slice(1)
        .map((q: any, i: number) => {
          const text = typeof q?.question === "string" ? q.question : "";
          return text ? `Q${i + 2}: ${text}` : "";
        })
        .filter(Boolean)
        .join("\n");
      const combined = extras ? `${primary}\n\n${extras}` : primary;
      return { question: combined, options: opts && opts.length > 0 ? opts : undefined };
    }

    return { question: primary, options: opts && opts.length > 0 ? opts : undefined };
  }

  const legacyQuestion: string = typeof input?.question === "string" ? input.question : fallback;
  const legacyOptions = Array.isArray(input?.options)
    ? input.options.filter((o: any): o is string => typeof o === "string")
    : undefined;
  return {
    question: legacyQuestion,
    options: legacyOptions && legacyOptions.length > 0 ? legacyOptions : undefined,
  };
}

/**
 * Check if a decision has a pending stdin answer and send it.
 */
export function answerPendingStdinDecision(decisionId: number, answer: string): boolean {
  const agentKey = pendingStdinDecisions.get(decisionId);
  if (!agentKey) return false;
  pendingStdinDecisions.delete(decisionId);
  return sendInputToAgent(agentKey, answer);
}

/**
 * Process a streaming JSON message from Claude CLI and mirror to Conductor's DB.
 */
function processStreamMessage(
  sessionId: string,
  msg: any,
  model: string,
  workspaceName?: string,
  repoPath?: string
): void {
  // Mirror the same message families Conductor persists for Claude sessions.
  if (
    msg.type !== "user" &&
    msg.type !== "assistant" &&
    msg.type !== "result" &&
    msg.type !== "system"
  ) {
    return;
  }

  // Keep claude_session_id pointing at the live Claude session so follow-up
  // --resume calls target the right conversation (resume can mint a new id).
  if (
    msg.type === "system" &&
    msg.subtype === "init" &&
    typeof msg.session_id === "string" &&
    msg.session_id
  ) {
    updateAgentSessionId(sessionId, msg.session_id);
  }

  const role = msg.type === "user" ? "user" : "assistant";
  const timestamp = msg.timestamp ?? new Date().toISOString();
  const normalized = {
    ...msg,
    session_id: msg.session_id ?? sessionId,
  };
  const userContent = role === "user" ? extractUserContent(msg) : null;
  const content = userContent ?? JSON.stringify(normalized);
  const turnId = msg.uuid ?? randomUUID();
  const sdkMessageId =
    role === "assistant" && typeof msg.message?.id === "string"
      ? msg.message.id
      : null;
  if (sdkMessageId) {
    lastAssistantSdkMessageIds.set(sessionId, sdkMessageId);
  }
  const lastAssistantMessageId =
    role === "user" ? lastAssistantSdkMessageIds.get(sessionId) ?? null : null;
  const msgModel =
    role === "assistant" ? null : simplifyModel(msg.message?.model ?? model);

  insertSessionMessage(
    sessionId,
    role,
    content,
    timestamp,
    msgModel,
    sdkMessageId,
    lastAssistantMessageId,
    turnId
  );

  // Detect AskUserQuestion tool_use blocks and create Telegram decisions
  if (msg.type === "assistant" && workspaceName) {
    const contentBlocks = msg.message?.content;
    if (Array.isArray(contentBlocks)) {
      for (const block of contentBlocks) {
        if (block.type === "tool_use") {
          console.log(`[agent] tool_use block: name="${block.name}" id="${block.id}" workspace="${workspaceName}"`);
        }
        const isAskUser =
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          (block.name === "AskUserQuestion" ||
            block.name === "mcp__conductor__AskUserQuestion" ||
            block.name.toLowerCase().includes("askuser"));
        if (
          isAskUser &&
          block.id &&
          !seenToolUseIds.has(block.id)
        ) {
          seenToolUseIds.add(block.id);
          const { question, options } = extractAskUserQuestion(block.input);

          // Look up workspace in conductor-telegram DB
          const trackedWs = repoPath
            ? getTrackedWorkspaceByName(workspaceName, { repoPath })
            : undefined;
          if (trackedWs) {
            const decisionId = createDecision(
              trackedWs.id,
              question,
              options ?? null
            );
            const eventPayload = JSON.stringify({
              decisionId,
              question,
              options: options ?? [],
            });
            addEvent(trackedWs.id, "human_request", eventPayload);
            pendingStdinDecisions.set(
              decisionId,
              workspaceAgentKey(repoPath!, workspaceName)
            );
            console.log(
              `[agent] AskUserQuestion detected for ${workspaceName}: "${question.slice(0, 80)}..." → decision ${decisionId}`
            );
          } else {
            console.warn(
              `[agent] AskUserQuestion found but no tracked workspace for "${workspaceName}" — question will be lost`
            );
          }
        }
      }
    }
  }
}

function extractUserContent(msg: any): string | null {
  const content = msg?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const renderedParts = content
      .map((part) => extractUserContentPart(part, msg))
      .filter((part): part is string => Boolean(part));
    if (renderedParts.length > 0) {
      return renderedParts.join("\n\n");
    }
  }
  return null;
}

function extractUserContentPart(part: any, msg: any): string | null {
  if (part?.type === "text" && typeof part.text === "string") {
    const text = part.text.trim();
    return text || null;
  }
  if (part?.type === "tool_result") {
    return extractToolResultContent(part, msg);
  }
  return null;
}

function extractToolResultContent(part: any, msg: any): string | null {
  const text =
    extractTextValue(part?.content) ??
    extractTextValue(msg?.tool_use_result) ??
    extractTextValue(msg?.result);

  if (!text) {
    return part?.is_error ? "Tool result error." : "Tool result received.";
  }

  return text;
}

function extractTextValue(value: any): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractTextValue(entry))
      .filter((entry): entry is string => Boolean(entry));
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  if (typeof value.text === "string") {
    const trimmed = value.text.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  for (const key of ["message", "error", "result"]) {
    if (typeof value[key] === "string") {
      const trimmed = value[key].trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }

  return JSON.stringify(value);
}

export function simplifyModel(model: string | null | undefined): string | null {
  if (!model) return null;
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  if (model.includes("fable")) return "fable";
  return model;
}

/**
 * Update session status in Conductor's DB.
 */
function updateSessionStatus(sessionId: string, status: string): void {
  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    db.prepare(
      `UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(status, sessionId);
    db.close();
    console.log(`[db] Session ${sessionId} → ${status}`);
  } catch (err) {
    console.error(`[db] Failed to update session status:`, err);
  }
}

function updateAgentSessionId(sessionId: string, agentSessionId: string): void {
  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    db.prepare(
      `UPDATE sessions
       SET claude_session_id = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(agentSessionId, sessionId);
    db.close();
  } catch (err) {
    console.error(`[db] Failed to update agent session id:`, err);
  }
}

function buildDisplayPrompt(
  prompt: string,
  launchMode: LaunchMode,
  reviewBaseBranch?: string | null
): string {
  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt) {
    if (launchMode === "review" && reviewBaseBranch?.trim()) {
      return `Review changes against ${reviewBaseBranch.trim()}.\n\n${trimmedPrompt}`;
    }
    return trimmedPrompt;
  }

  if (launchMode === "review") {
    return reviewBaseBranch?.trim()
      ? `Review changes against ${reviewBaseBranch.trim()}.`
      : "Review changes in this workspace.";
  }

  return "(empty message)";
}

function finalizeLaunchConfig(
  config: ResolvedLaunchConfig,
  displayPrompt: string
): ResolvedLaunchConfig {
  return {
    ...config,
    title: deriveSessionTitle(displayPrompt, config.title),
  };
}

function insertSessionForWorkspace(
  db: Database.Database,
  workspaceId: string,
  sessionId: string,
  displayPrompt: string,
  config: ResolvedLaunchConfig
): SessionCreateResult {
  const agentSessionId = config.agentType === "claude" ? sessionId : null;
  const promptMessageId = randomUUID();
  const promptModel = simplifyModel(config.model) ?? config.model;

  db.prepare(
    `INSERT INTO sessions
      (id, status, model, permission_mode, workspace_id, agent_type, claude_session_id, title, codex_thinking_level)
     VALUES (?, 'idle', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    config.model,
    config.accessMode === "legacy"
      ? TELEGRAM_AGENT_PERMISSION_MODE
      : config.accessMode,
    workspaceId,
    config.agentType,
    agentSessionId,
    config.title,
    config.codexThinkingLevel
  );

  const promptInsert = db.prepare(
    `INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, model, turn_id)
     VALUES (?, ?, 'user', ?, datetime('now'), datetime('now'), ?, ?)`
  ).run(promptMessageId, sessionId, displayPrompt, promptModel, randomUUID());

  return {
    sessionId,
    initialCursorRowid: Number(promptInsert.lastInsertRowid ?? 0),
    agentType: config.agentType,
    model: config.model,
  };
}

// ── Public API ──────────────────────────────────────────────

/**
 * Pick a random city name not already used by this repo's workspaces.
 */
function pickCityName(existingDirs: Set<string>): string {
  const available = CITY_NAMES.filter((c) => !existingDirs.has(c));
  if (available.length === 0) {
    // Fallback: append random suffix
    return `workspace-${Date.now()}`;
  }
  return available[Math.floor(Math.random() * available.length)];
}

const LEGACY_BRANCH_PREFIX = "belongcond";

let cachedBranchPrefix: string | null = null;

/**
 * Resolve the branch prefix for bot-created workspace branches.
 *
 * Conductor 0.72 defaults to prefixing branches with the GitHub username
 * (settings.toml `[git] branch_prefix_type = "github_username"`), e.g.
 * `nomadcalendar/tokyo`. Follow the app's convention so bot branches sit next
 * to app branches: recent app-created branches are the best source (no
 * network), then `gh api user`, then the legacy `belongcond` prefix.
 */
export async function getBranchPrefix(): Promise<string> {
  if (cachedBranchPrefix) return cachedBranchPrefix;

  const fromEnv = process.env.TELEGRAM_BRANCH_PREFIX?.trim().replace(/\/+$/, "");
  if (fromEnv) {
    cachedBranchPrefix = fromEnv;
    return cachedBranchPrefix;
  }

  const configuredPrefix = getSettingValue("branch_prefix")?.trim().replace(/\/+$/, "");
  if (configuredPrefix) {
    cachedBranchPrefix = configuredPrefix;
    return cachedBranchPrefix;
  }

  if (getSettingValue("branch_prefix_type") === "github_username") {
    const sniffed = sniffRecentBranchPrefix();
    if (sniffed) {
      cachedBranchPrefix = sniffed;
      return cachedBranchPrefix;
    }
    const ghUser = await getGithubUsername();
    if (ghUser) {
      cachedBranchPrefix = ghUser;
      return cachedBranchPrefix;
    }
  }

  cachedBranchPrefix = LEGACY_BRANCH_PREFIX;
  return cachedBranchPrefix;
}

/** Most recent Conductor workspace branch prefix that isn't the bot's own. */
function sniffRecentBranchPrefix(): string | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const rows = db.prepare(
      `SELECT branch FROM workspaces
       WHERE branch LIKE '%/%'
       ORDER BY created_at DESC
       LIMIT 25`
    ).all() as Array<{ branch?: string }>;
    db.close();
    for (const row of rows) {
      const prefix = row.branch?.split("/")[0]?.trim();
      if (prefix && prefix !== LEGACY_BRANCH_PREFIX) {
        return prefix;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function getGithubUsername(): Promise<string | null> {
  try {
    const output = await execAsync("gh api user -q .login");
    const login = output.trim();
    return /^[A-Za-z0-9-]+$/.test(login) ? login : null;
  } catch {
    return null;
  }
}

async function getExistingWorkspaceBranchNames(
  repoPath: string,
  prefixes: string[]
): Promise<Set<string>> {
  const names = new Set<string>();
  for (const prefix of new Set(prefixes)) {
    try {
      const output = await execAsync(
        `cd ${shellQuote(repoPath)} && git branch --format='%(refname:short)' --list ${shellQuote(`${prefix}/*`)}`
      );
      for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith(`${prefix}/`)) {
          const name = trimmed.slice(prefix.length + 1);
          if (name) names.add(name);
        }
      }
    } catch {
      // Repo without git or prefix without branches: nothing to reserve.
    }
  }
  return names;
}

const COMMIT_SHA_RE = /^[0-9a-f]{40,64}$/i;

export async function resolveRemoteBaseCommit(
  repoPath: string,
  defaultBranch: string
): Promise<string> {
  await execFileAsync("git", ["fetch", "--prune", "origin", defaultBranch], repoPath);
  const commit = (
    await execFileAsync(
      "git",
      ["rev-parse", "--verify", `origin/${defaultBranch}^{commit}`],
      repoPath
    )
  ).trim();
  if (!COMMIT_SHA_RE.test(commit)) {
    throw new Error(`origin/${defaultBranch} did not resolve to an immutable commit`);
  }
  return commit;
}

function deleteConductorWorkspaceRecords(
  workspaceId: string | null,
  sessionId: string | null
): void {
  if (!workspaceId && !sessionId) return;
  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    const remove = db.transaction(() => {
      if (sessionId) {
        db.prepare("DELETE FROM session_messages WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      }
      if (workspaceId) {
        db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
      }
    });
    remove();
    db.close();
  } catch (err) {
    console.error(`[launcher] Failed to roll back Conductor DB records:`, err);
  }
}

async function rollBackWorkspaceCreation(
  repoPath: string,
  workspaceDir: string,
  branchName: string,
  workspaceId: string | null,
  sessionId: string | null
): Promise<void> {
  deleteConductorWorkspaceRecords(workspaceId, sessionId);
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", workspaceDir], repoPath);
  } catch (err) {
    console.error(`[launcher] Failed to remove rolled-back worktree:`, err);
  }
  try {
    await execFileAsync("git", ["branch", "-D", branchName], repoPath);
  } catch (err) {
    console.error(`[launcher] Failed to remove rolled-back branch:`, err);
  }
}

/**
 * Create a workspace programmatically: git worktree + Conductor DB records.
 * No deeplinks needed — works even when Conductor UI is busy or unresponsive.
 */
export async function launchWorkspace(
  repoPath: string,
  prompt: string,
  onOutput?: (data: string) => void,
  attachmentSourcePaths: string[] = [],
  options: WorkspaceLaunchOptions = {}
): Promise<
  {
    workspaceName: string;
    sessionId: string;
    done: Promise<AgentResult>;
    initialCursorRowid: number;
    initialCursorMessageId: string | null;
    agentType: AgentType;
    model: string;
    workspaceId: string;
    backendKind: "local";
  } | { error: string }
> {
  console.log(`[launcher] launchWorkspace called: repoPath=${repoPath}`);

  // Ensure the repo exists in Conductor's DB before choosing the workspace
  // path. Telegram lists repos from disk, and Conductor's repo name can differ
  // from the root folder basename when users add the same repo more than once.
  const repoInfo = await ensureRepoInConductorDb(repoPath);
  if (!repoInfo) {
    return { error: `Repo "${repoPath}" does not exist or is not a git repository.` };
  }
  const workspacesDir = path.join(
    CONDUCTOR_WORKSPACES_DIR,
    getWorkspaceRepoDirName(repoInfo, repoPath)
  );
  console.log(`[launcher] Found repo: ${repoInfo.repoId} (${repoInfo.name})`);

  // Reserve city names already used by workspace directories or workspace branches.
  let reservedNames: Set<string>;
  try {
    const entries = await readdir(workspacesDir);
    reservedNames = new Set(entries);
  } catch {
    reservedNames = new Set();
  }
  const branchPrefix = await getBranchPrefix();
  for (const usedName of await getExistingWorkspaceBranchNames(repoPath, [
    branchPrefix,
    LEGACY_BRANCH_PREFIX,
  ])) {
    reservedNames.add(usedName);
  }

  // Pick a city name for the workspace
  const cityName = pickCityName(reservedNames);
  const branchName = `${branchPrefix}/${cityName}`;
  const workspaceDir = getWorkspacePathFromRepo(repoInfo, repoPath, cityName);
  const defaultBranch = repoInfo.defaultBranch ?? "main";
  let baseCommit: string;

  try {
    baseCommit = await resolveRemoteBaseCommit(repoPath, defaultBranch);
  } catch (err) {
    try {
      baseCommit = (
        await execFileAsync(
          "git",
          ["rev-parse", "--verify", `${defaultBranch}^{commit}`],
          repoPath
        )
      ).trim();
      if (!COMMIT_SHA_RE.test(baseCommit)) {
        throw new Error(
          `${defaultBranch} did not resolve to an immutable commit`
        );
      }
    } catch {
      return { error: `Failed to resolve workspace base commit: ${err}` };
    }
  }

  console.log(
    `[launcher] Creating workspace: ${cityName} (branch: ${branchName}, base: ${baseCommit})`
  );

  // 1. Create git worktree
  try {
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", branchName, workspaceDir, baseCommit],
      repoPath
    );
    console.log(`[launcher] Git worktree created at ${workspaceDir}`);
  } catch (err) {
    console.error(`[launcher] Git worktree failed:`, err);
    return { error: `Failed to create git worktree: ${err}` };
  }
  onOutput?.(`Workspace created: ${cityName}`);

  let stagedAttachmentPaths: string[];
  try {
    stagedAttachmentPaths = stageAttachmentPaths(
      workspaceDir,
      attachmentSourcePaths
    );
  } catch (err) {
    await rollBackWorkspaceCreation(
      repoPath,
      workspaceDir,
      branchName,
      null,
      null
    );
    return { error: `Failed to stage workspace attachments: ${err}` };
  }
  const fullPrompt = buildPromptWithAttachments(prompt, stagedAttachmentPaths);
  const launchConfig = finalizeLaunchConfig(
    resolveLaunchConfig(options),
    buildDisplayPrompt(fullPrompt, options.launchMode ?? "prompt")
  );
  const restrictedLaunchError = restrictedCodexLaunchError(launchConfig);
  if (restrictedLaunchError) {
    await rollBackWorkspaceCreation(
      repoPath,
      workspaceDir,
      branchName,
      null,
      null
    );
    return { error: restrictedLaunchError };
  }

  // 2. Insert workspace + session into Conductor's DB
  const workspaceId = randomUUID();
  let sessionCreateResult: SessionCreateResult;
  let conductorSessionId: string | null = null;

  let conductorDb: Database.Database | null = null;
  try {
    conductorDb = new Database(CONDUCTOR_DB_PATH);
    const sessionId = randomUUID();
    conductorSessionId = sessionId;
    const createRecords = conductorDb.transaction(() => {
      insertConductorWorkspace(conductorDb!, {
        workspaceId,
        repoId: repoInfo.repoId,
        cityName,
        branchName,
        sessionId,
        defaultBranchName: defaultBranch,
        workspaceDir,
      });
      return insertSessionForWorkspace(
        conductorDb!,
        workspaceId,
        sessionId,
        buildDisplayPrompt(fullPrompt, launchConfig.launchMode),
        launchConfig
      );
    });
    sessionCreateResult = createRecords();

    console.log(
      `[launcher] DB records created: workspace=${workspaceId}, session=${sessionCreateResult.sessionId}`
    );
  } catch (err) {
    console.error(`[launcher] DB insert failed:`, err);
    await rollBackWorkspaceCreation(
      repoPath,
      workspaceDir,
      branchName,
      workspaceId,
      conductorSessionId
    );
    return { error: `Failed to create DB records: ${err}` };
  } finally {
    conductorDb?.close();
  }

  revealWorkspaceInConductor(workspaceDir);

  // 3. Spawn the configured agent
  let done: Promise<AgentResult>;
  try {
    ({ done } = spawnAgent(
      sessionCreateResult.sessionId,
      repoPath,
      workspaceDir,
      fullPrompt,
      launchConfig.model,
      launchConfig.agentType,
      cityName,
      {
        attachmentPaths: stagedAttachmentPaths,
        launchMode: launchConfig.launchMode,
        accessMode: launchConfig.accessMode,
      }
    ));
  } catch (err) {
    await rollBackWorkspaceCreation(
      repoPath,
      workspaceDir,
      branchName,
      workspaceId,
      sessionCreateResult.sessionId
    );
    return { error: `Failed to start agent process: ${err}` };
  }
  onOutput?.("Agent is running.");

  return {
    workspaceName: cityName,
    sessionId: sessionCreateResult.sessionId,
    done,
    initialCursorRowid: sessionCreateResult.initialCursorRowid,
    initialCursorMessageId: null,
    agentType: launchConfig.agentType,
    model: launchConfig.model,
    workspaceId,
    backendKind: "local",
  };
}

export interface SendError {
  error: string;
  reason?:
    | "unsupported_agent"
    | "remote_observe_only"
    | "conductor_api_unavailable"
    | "cloud_policy_unsupported"
    | "cloud_session_busy";
}

interface SessionSendTarget {
  sessionId: string;
  agentType: AgentType;
  rawAgentType: string | null;
  agentSessionId: string | null;
  model: string | null;
  status: string | null;
}

/**
 * Send a follow-up prompt to an existing workspace session.
 *
 * `options.sessionId` targets a specific thread (Conductor session) instead of
 * the workspace's active one — used when the user replies to a forwarded
 * thread message in Telegram.
 */
export interface SendSuccess {
  ok: true;
  done: Promise<AgentResult>;
  /** User-facing caveat about the send (e.g. attachments dropped for cloud). */
  warning?: string;
}

export async function sendToSession(
  workspaceName: string,
  prompt: string,
  attachmentSourcePaths: string[] = [],
  options: {
    repoPath?: string | null;
    sessionId?: string | null;
    accessMode?: AgentAccessMode;
    binding?: TrackedConductorBinding | null;
  } = {}
): Promise<SendSuccess | SendError> {
  const wsInfo = resolveConductorWorkspaceInfo(
    workspaceName,
    options.repoPath ?? null,
    options.binding
  );
  if (!wsInfo) {
    return {
      error: options.repoPath
        ? `Workspace "${workspaceName}" not found in Conductor DB for ${options.repoPath}.`
        : `Workspace "${workspaceName}" was ambiguous or not found in Conductor DB.`,
    };
  }
  if (!isConductorWorkspaceVisible(wsInfo)) {
    return {
      error: `Workspace "${workspaceName}" is no longer visible in Conductor.`,
    };
  }

  const remote = isRemoteConductorWorkspace(wsInfo);
  if (
    remote &&
    options.accessMode !== undefined &&
    options.accessMode !== "legacy"
  ) {
    return {
      error:
        `☁️ "${wsInfo.displayName}" cannot use the requested ${options.accessMode} policy through the Conductor API. ` +
        "Use a local workspace until the API exposes equivalent permission controls.",
      reason: "cloud_policy_unsupported",
    };
  }

  const trackedDefaultSessionId =
    remote && !options.sessionId
      ? options.binding?.conductorSessionId ??
        getTrackedWorkspaceByName(workspaceName, {
          repoPath: options.repoPath ?? wsInfo.repoPath ?? undefined,
        })?.conductorSessionId
      : null;
  const requestedSessionId =
    options.sessionId ?? trackedDefaultSessionId ?? wsInfo.sessionId;

  let target: SessionSendTarget = {
    sessionId: wsInfo.sessionId,
    agentType: wsInfo.agentType,
    rawAgentType: wsInfo.rawAgentType,
    agentSessionId: wsInfo.agentSessionId,
    model: wsInfo.model,
    status: wsInfo.status,
  };
  if (remote) {
    const remoteTarget = await getRemoteSessionSendTarget(
      wsInfo,
      requestedSessionId
    );
    if ("error" in remoteTarget) {
      return remoteTarget;
    }
    target = remoteTarget;
  } else if (requestedSessionId !== wsInfo.sessionId) {
    const session = getConductorSessionById(requestedSessionId);
    if (!session || session.workspaceId !== wsInfo.workspaceId) {
      return {
        error: `That thread no longer exists in "${wsInfo.displayName}". Sending in the topic targets the active thread instead.`,
      };
    }
    target = {
      sessionId: session.sessionId,
      agentType: session.agentType,
      rawAgentType: session.rawAgentType,
      agentSessionId: session.claudeSessionId,
      model: session.model,
      status: session.status,
    };
  }

  const repoPath = wsInfo.repoPath ?? options.repoPath;
  if (!repoPath) {
    return { error: `Workspace "${workspaceName}" is missing repo path metadata.` };
  }

  if (remote) {
    return steerRemoteSession(wsInfo, target, prompt, attachmentSourcePaths);
  }

  if (!isSpawnableAgentType(target.rawAgentType)) {
    return {
      error: `This thread runs "${target.rawAgentType}", which the bot can't steer from Telegram. Open it in Conductor, or start a new thread with /threads.`,
      reason: "unsupported_agent",
    };
  }

  const workspaceDir = getWorkspacePathFromInfo(wsInfo, wsInfo.directoryName || workspaceName);
  if (!workspaceDir) {
    return { error: `Workspace "${wsInfo.displayName}" has no local directory on this Mac.` };
  }
  const stagedAttachmentPaths = stageAttachmentPaths(
    workspaceDir,
    attachmentSourcePaths
  );
  const fullPrompt = buildPromptWithAttachments(prompt, stagedAttachmentPaths);
  markConductorWorkspaceActive(wsInfo.workspaceId);
  const accessMode = options.accessMode ?? "legacy";
  if (target.agentType === "codex" && accessMode === "read-only") {
    return {
      error:
        "Restricted Codex launches are disabled. Configure Claude for read-only review work.",
      reason: "unsupported_agent",
    };
  }

  const { done } = spawnAgent(
    target.sessionId,
    repoPath,
    workspaceDir,
    fullPrompt,
    normalizeModelForCli(target.model ?? resolveAgentModel(target.agentType, "prompt")),
    target.agentType,
    wsInfo.directoryName || workspaceName,
    {
      agentSessionId: target.agentSessionId,
      isFollowUp: true,
      attachmentPaths: stagedAttachmentPaths,
      launchMode: "prompt",
      accessMode,
    }
  );

  return { ok: true, done };
}

export async function launchWorkspaceSession(
  workspaceName: string,
  prompt: string,
  options: SessionLaunchOptions & {
    attachmentSourcePaths?: string[];
    repoPath?: string | null;
    binding?: TrackedConductorBinding | null;
  } = {}
): Promise<
  {
    sessionId: string;
    done: Promise<AgentResult>;
    initialCursorRowid: number;
    initialCursorMessageId: string | null;
    agentType: AgentType;
    model: string;
    workspaceId: string;
    backendKind: "local" | "cloud-api";
  } | SendError
> {
  const wsInfo = resolveConductorWorkspaceInfo(
    workspaceName,
    options.repoPath ?? null,
    options.binding
  );
  if (!wsInfo) {
    return {
      error: options.repoPath
        ? `Workspace "${workspaceName}" not found in Conductor DB for ${options.repoPath}.`
        : `Workspace "${workspaceName}" was ambiguous or not found in Conductor DB.`,
    };
  }
  if (!isConductorWorkspaceVisible(wsInfo)) {
    return {
      error: `Workspace "${workspaceName}" is no longer visible in Conductor.`,
    };
  }

  const repoPath = wsInfo.repoPath ?? options.repoPath;
  if (!repoPath) {
    return { error: `Workspace "${workspaceName}" is missing repo path metadata.` };
  }
  if (isRemoteConductorWorkspace(wsInfo)) {
    const accessMode =
      options.accessMode ??
      (options.launchMode === "review" ? "read-only" : "legacy");
    if (accessMode !== "legacy") {
      return {
        error:
          `☁️ "${wsInfo.displayName}" cannot start a ${accessMode} thread through the Conductor API because the API does not expose permission-policy enforcement yet.`,
        reason: "cloud_policy_unsupported",
      };
    }
    if ((options.attachmentSourcePaths?.length ?? 0) > 0) {
      return {
        error:
          `☁️ "${wsInfo.displayName}" cannot receive Telegram attachments when starting a cloud thread through the Conductor API yet.`,
        reason: "conductor_api_unavailable",
      };
    }

    let client;
    try {
      client = createConductorApiClientFromEnv();
    } catch (error) {
      return conductorApiSendError(wsInfo, error);
    }
    if (!client) {
      return remoteObserveOnlyError(wsInfo);
    }

    const launchConfig = finalizeLaunchConfig(
      resolveLaunchConfig(options),
      buildDisplayPrompt(prompt, options.launchMode ?? "prompt")
    );
    const apiModel = resolveAgentModelForConductorApi(
      launchConfig.agentType,
      launchConfig.launchMode,
      options.model
    );
    let session: ConductorApiSession | null = null;
    try {
      const createdSession = await client.createSession({
        workspaceId: wsInfo.workspaceId,
        name: launchConfig.title,
        agent: launchConfig.agentType,
        model: apiModel,
        effort: resolveCloudSessionEffort(launchConfig),
      });
      session = createdSession;
      const sent = await queueFirstCloudPrompt(
        client,
        wsInfo.workspaceId,
        createdSession.id,
        prompt
      );
      return {
        sessionId: session.id,
        done: Promise.resolve({ isError: false, exitCode: 0 }),
        initialCursorRowid: 0,
        initialCursorMessageId: sent.messageId,
        agentType: launchConfig.agentType,
        model: session.resolvedModel ?? session.model ?? apiModel,
        workspaceId: wsInfo.workspaceId,
        backendKind: "cloud-api",
      };
    } catch (error) {
      if (session) {
        await client.archiveSession(session.id).catch((cleanupError) => {
          console.error(
            `[conductor-api] Failed to archive incomplete session ${session?.id}:`,
            cleanupError
          );
        });
      }
      return conductorApiSendError(wsInfo, error);
    }
  }
  const workspaceDir = getWorkspacePathFromInfo(
    wsInfo,
    wsInfo.directoryName || workspaceName
  );
  if (!workspaceDir) {
    return { error: `Workspace "${wsInfo.displayName}" has no local directory on this Mac.` };
  }
  const stagedAttachmentPaths = stageAttachmentPaths(
    workspaceDir,
    options.attachmentSourcePaths ?? []
  );
  const fullPrompt = buildPromptWithAttachments(prompt, stagedAttachmentPaths);
  const reviewBaseBranch =
    options.launchMode === "review"
      ? options.reviewBaseBranch ?? wsInfo.targetBranch
      : options.reviewBaseBranch ?? null;
  const launchConfig = finalizeLaunchConfig(
    resolveLaunchConfig({
      ...options,
      reviewBaseBranch,
    }),
    buildDisplayPrompt(fullPrompt, options.launchMode ?? "prompt", reviewBaseBranch)
  );
  const restrictedLaunchError = restrictedCodexLaunchError(launchConfig);
  if (restrictedLaunchError) {
    return { error: restrictedLaunchError, reason: "unsupported_agent" };
  }
  let sessionCreateResult: SessionCreateResult;

  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    const sessionId = randomUUID();
    sessionCreateResult = insertSessionForWorkspace(
      db,
      wsInfo.workspaceId,
      sessionId,
      buildDisplayPrompt(fullPrompt, launchConfig.launchMode, reviewBaseBranch),
      launchConfig
    );
    db.prepare(
      "UPDATE workspaces SET active_session_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(sessionId, wsInfo.workspaceId);
    db.close();
  } catch (err) {
    console.error(`[launcher] Failed to create session for workspace ${workspaceName}:`, err);
    return { error: `Failed to create session: ${err}` };
  }

  markConductorWorkspaceActive(wsInfo.workspaceId);
  revealWorkspaceInConductor(workspaceDir);

  const { done } = spawnAgent(
    sessionCreateResult.sessionId,
    repoPath,
    workspaceDir,
    fullPrompt,
    launchConfig.model,
    launchConfig.agentType,
    workspaceName,
    {
      attachmentPaths: stagedAttachmentPaths,
      launchMode: launchConfig.launchMode,
      accessMode: launchConfig.accessMode,
    }
  );

  return {
    sessionId: sessionCreateResult.sessionId,
    done,
    initialCursorRowid: sessionCreateResult.initialCursorRowid,
    initialCursorMessageId: null,
    agentType: launchConfig.agentType,
    model: launchConfig.model,
    workspaceId: wsInfo.workspaceId,
    backendKind: "local",
  };
}

export interface CloudWorkspaceLaunchResult {
  workspaceId: string;
  sessionId: string;
  deepLink: string;
  workspaceName: string;
  agentType: AgentType;
  model: string;
  initialCursorRowid: number;
  initialCursorMessageId: string | null;
  backendKind: "cloud-api";
}

/**
 * Create a Conductor Cloud workspace (and its first session) entirely through
 * the supported HTTP API, then queue the initial prompt. No local Conductor
 * install is involved: the returned binding is enough for the poll loop to
 * follow the thread over the API.
 */
export async function launchCloudWorkspace(input: {
  projectId: string;
  prompt: string;
  name?: string | null;
  branch?: string | null;
  agentType?: AgentType;
  model?: string | null;
}): Promise<CloudWorkspaceLaunchResult | SendError> {
  const displayName = input.name?.trim() || "new cloud workspace";
  let client;
  try {
    client = createConductorApiClientFromEnv();
  } catch (error) {
    return conductorApiSendError({ displayName }, error);
  }
  if (!client) {
    return {
      error:
        "☁️ Conductor Cloud is in observe-only mode. " +
        `${CLOUD_OBSERVE_ONLY_HINT} to create cloud workspaces from Telegram.`,
      reason: "conductor_api_unavailable",
    };
  }

  const launchConfig = resolveLaunchConfig({
    agentType: input.agentType,
    model: input.model ?? undefined,
    title: input.name ?? undefined,
    launchMode: "prompt",
  });
  const apiModel = resolveAgentModelForConductorApi(
    launchConfig.agentType,
    launchConfig.launchMode,
    input.model
  );

  let createdWorkspace: {
    workspaceId: string;
    sessionId: string;
    deepLink: string;
  } | null = null;
  try {
    createdWorkspace = await client.createWorkspace({
      projectId: input.projectId,
      branch: input.branch?.trim() || undefined,
      name: input.name?.trim() || undefined,
      agent: launchConfig.agentType,
      model: apiModel,
      effort: resolveCloudSessionEffort(launchConfig),
    });
    // Breadcrumb for crash recovery: if the bot dies before the caller
    // persists this binding, the log line is the only pointer to the live
    // cloud workspace this call just created.
    console.log(
      `[conductor-api] Created cloud workspace ${createdWorkspace.workspaceId} (session ${createdWorkspace.sessionId}) in project ${input.projectId}`
    );
    const sent = await queueFirstCloudPrompt(
      client,
      createdWorkspace.workspaceId,
      createdWorkspace.sessionId,
      input.prompt
    );
    // Unnamed workspaces get a Conductor-assigned city name; read it back so
    // topics and bindings show the real name rather than a UUID.
    const workspaceName =
      input.name?.trim() ||
      (await client
        .getWorkspace(createdWorkspace.workspaceId)
        .then((workspace) => workspace.name.trim() || null)
        .catch(() => null)) ||
      createdWorkspace.workspaceId;
    return {
      workspaceId: createdWorkspace.workspaceId,
      sessionId: createdWorkspace.sessionId,
      deepLink: createdWorkspace.deepLink,
      workspaceName,
      agentType: launchConfig.agentType,
      model: apiModel,
      initialCursorRowid: 0,
      initialCursorMessageId: sent.messageId,
      backendKind: "cloud-api",
    };
  } catch (error) {
    if (createdWorkspace) {
      await client
        .archiveWorkspace(createdWorkspace.workspaceId)
        .catch((cleanupError) => {
          console.error(
            `[conductor-api] Failed to archive incomplete cloud workspace ${createdWorkspace?.workspaceId}:`,
            cleanupError
          );
        });
    }
    return conductorApiSendError({ displayName }, error);
  }
}

/**
 * Queue the first prompt into a freshly created cloud session under the
 * cloud-cycle protocol: verify the session landed in the expected workspace,
 * reserve the cycle before any network send, stamp the boundary receipt that
 * becomes the initial transcript cursor, and restore the cycle if the send
 * fails so the thread is not left permanently in-flight.
 */
async function queueFirstCloudPrompt(
  client: ConductorApiClient,
  workspaceId: string,
  sessionId: string,
  prompt: string
): Promise<{ messageId: string }> {
  const createdStatus = await client.getSessionStatus(sessionId);
  if (createdStatus.workspaceId !== workspaceId) {
    throw new ConductorApiError(
      "Conductor API created the session in a different workspace"
    );
  }
  const messageId = randomUUID();
  const pendingCycle = reserveCloudSessionCycle(workspaceId, sessionId);
  writeCloudSessionCycle(pendingCycle, {
    phase: "pending",
    outboundMessageId: messageId,
  });
  try {
    const sent = await client.sendMessage({
      sessionId,
      message: prompt.trim() || "(empty message)",
      messageId,
    });
    // A new session has no older transcript backlog, and callers persist
    // this receipt as the initial API cursor.
    writeCloudSessionCycle(pendingCycle, {
      phase: "boundary",
      outboundMessageId: sent.messageId,
    });
    return sent;
  } catch (error) {
    restoreCloudSessionCycleAfterSendFailure(pendingCycle);
    throw error;
  }
}

/**
 * Stop a running agent by workspace name.
 */
export function stopAgent(workspaceName: string, repoPath: string): boolean {
  const key = workspaceAgentKey(repoPath, workspaceName);
  const child = runningAgents.get(key);
  if (!child) return false;

  child.kill("SIGTERM");
  // Give it 5s for graceful shutdown, then force kill
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 5000);

  runningAgents.delete(key);
  return true;
}

export async function archiveConductorWorkspace(
  workspaceName: string,
  repoPath: string | null = null,
  binding: TrackedConductorBinding | null = null
): Promise<boolean> {
  const workspace = resolveConductorWorkspaceInfo(
    workspaceName,
    repoPath,
    binding
  );
  if (workspace && isRemoteConductorWorkspace(workspace)) {
    try {
      const client = createConductorApiClientFromEnv();
      if (!client) return false;
      await client.archiveWorkspace(workspace.workspaceId);
      return true;
    } catch (error) {
      console.error(
        `[conductor-api] Failed to archive workspace ${workspace.displayName}:`,
        error
      );
      return false;
    }
  }

  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    const columns = getTableColumns(db, "workspaces");
    const where = [
      columns.has("workspace_name")
        ? "(directory_name = ? OR workspace_name = ?)"
        : "directory_name = ?",
    ];
    const params: any[] = columns.has("workspace_name")
      ? [workspaceName, workspaceName]
      : [workspaceName];
    if (repoPath) {
      where.push(
        `repository_id IN (
          SELECT id FROM repos WHERE root_path = ?
        )`
      );
      params.push(repoPath);
    }
    const result = db.prepare(
      `UPDATE workspaces
       SET state = 'archived',
           updated_at = datetime('now')
       WHERE ${where.join(" AND ")}`
    ).run(...params);
    db.close();
    return result.changes > 0;
  } catch (err) {
    console.error(`[launcher] Failed to archive Conductor workspace ${workspaceName}:`, err);
    return false;
  }
}

/**
 * Check if an agent is currently running.
 */
export function isAgentRunning(workspaceName: string, repoPath: string): boolean {
  return runningAgents.has(workspaceAgentKey(repoPath, workspaceName));
}

export async function stopConductorAgent(
  workspaceName: string,
  repoPath: string,
  sessionId: string | null = null,
  binding: TrackedConductorBinding | null = null
): Promise<boolean> {
  const workspace = resolveConductorWorkspaceInfo(
    workspaceName,
    repoPath,
    binding
  );
  if (workspace && isRemoteConductorWorkspace(workspace)) {
    try {
      const client = createConductorApiClientFromEnv();
      if (!client) return false;
      const trackedSessionId =
        sessionId ??
        getTrackedWorkspaceByName(workspaceName, { repoPath })
          ?.conductorSessionId ??
        workspace.sessionId;
      const status = await client.getSessionStatus(trackedSessionId);
      if (status.workspaceId !== workspace.workspaceId) {
        console.error(
          `[conductor-api] Refusing to cancel session ${trackedSessionId}: workspace identity mismatch`
        );
        return false;
      }
      const canceled = await client.cancelSession(trackedSessionId);
      setMetaValue(
        cloudSessionCycleKey(workspace.workspaceId, trackedSessionId),
        encodeCloudSessionCycle({
          phase: canceled.status === "idle" ? "complete" : "canceling",
        })
      );
      return true;
    } catch (error) {
      console.error(
        `[conductor-api] Failed to cancel session for ${workspace.displayName}:`,
        error
      );
      return false;
    }
  }
  return stopAgent(workspaceName, repoPath);
}

// ── Conductor DB helpers ────────────────────────────────────

interface ConductorRepoInfo {
  repoId: string;
  name: string;
  defaultBranch: string | null;
}

function isPathSegment(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !value.includes("\\");
}

function getWorkspaceRepoDirName(
  repoInfo: Pick<ConductorRepoInfo, "name">,
  repoPath: string
): string {
  const dbName = repoInfo.name?.trim();
  if (dbName && isPathSegment(dbName)) {
    return dbName;
  }
  return path.basename(repoPath);
}

function getWorkspacePathFromRepo(
  repoInfo: Pick<ConductorRepoInfo, "name">,
  repoPath: string,
  workspaceName: string
): string {
  return path.join(
    CONDUCTOR_WORKSPACES_DIR,
    getWorkspaceRepoDirName(repoInfo, repoPath),
    workspaceName
  );
}

function getWorkspacePathFromInfo(
  workspace: Pick<
    ConductorWorkspaceInfo,
    "repoName" | "workspacePath" | "hostingServerUrl" | "sandboxProvider"
  >,
  workspaceName: string
): string | null {
  if (workspace.workspacePath?.trim()) {
    // For cloud workspaces workspace_path is the local sync mirror — only
    // trust it when it actually exists on this machine.
    if (
      isRemoteConductorWorkspace(workspace) &&
      !existsSync(workspace.workspacePath)
    ) {
      return null;
    }
    return workspace.workspacePath;
  }
  if (isRemoteConductorWorkspace(workspace)) {
    return null;
  }
  const repoName = workspace.repoName ?? workspaceName;
  return path.join(CONDUCTOR_WORKSPACES_DIR, repoName, workspaceName);
}

/** Agent types the bot can spawn locally. Cursor (0.63+) and future agents are
 * observe-only: resuming their sessions with the Claude CLI would corrupt them. */
function isSpawnableAgentType(rawAgentType: string | null): boolean {
  return (
    rawAgentType === null || rawAgentType === "claude" || rawAgentType === "codex"
  );
}

function getTableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
}

function insertConductorWorkspace(
  db: Database.Database,
  opts: {
    workspaceId: string;
    repoId: string;
    cityName: string;
    branchName: string;
    sessionId: string;
    defaultBranchName: string;
    workspaceDir: string;
  }
): void {
  const columns = [
    "id",
    "repository_id",
    "directory_name",
    "branch",
    "active_session_id",
    "state",
    "derived_status",
    "initialization_parent_branch",
    "intended_target_branch",
    "placeholder_branch_name",
    "initialization_files_copied",
  ];
  const values: unknown[] = [
    opts.workspaceId,
    opts.repoId,
    opts.cityName,
    opts.branchName,
    opts.sessionId,
    "ready",
    "in-progress",
    opts.defaultBranchName,
    opts.defaultBranchName,
    opts.branchName,
    0,
  ];

  const workspaceColumns = getTableColumns(db, "workspaces");
  if (workspaceColumns.has("workspace_path")) {
    columns.push("workspace_path");
    values.push(opts.workspaceDir);
  }
  if (workspaceColumns.has("workspace_name")) {
    columns.push("workspace_name");
    values.push(opts.cityName);
  }
  if (workspaceColumns.has("permission_level")) {
    columns.push("permission_level");
    values.push("write");
  }

  db.prepare(
    `INSERT INTO workspaces (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`
  ).run(...values);
}

function getRepoFromConductorDb(repoPath: string): ConductorRepoInfo | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const row = db.prepare(
      `SELECT id, name, default_branch FROM repos WHERE root_path = ?`
    ).get(repoPath) as any;
    db.close();
    if (!row) return null;
    return { repoId: row.id, name: row.name, defaultBranch: row.default_branch };
  } catch {
    return null;
  }
}

async function ensureRepoInConductorDb(repoPath: string): Promise<ConductorRepoInfo | null> {
  const existing = getRepoFromConductorDb(repoPath);
  if (existing) {
    return existing;
  }

  if (!(await isGitRepo(repoPath))) {
    return null;
  }

  const repoId = randomUUID();
  const name = path.basename(repoPath);
  const defaultBranch = await resolveRepoDefaultBranch(repoPath);
  const remoteUrl = await resolveRepoRemoteUrl(repoPath);

  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    const row = db.prepare(
      `SELECT id, name, default_branch FROM repos WHERE root_path = ?`
    ).get(repoPath) as any;
    if (row) {
      db.close();
      return { repoId: row.id, name: row.name, defaultBranch: row.default_branch };
    }

    db.prepare(
      `INSERT INTO repos (id, remote_url, name, default_branch, root_path)
       VALUES (?, ?, ?, ?, ?)`
    ).run(repoId, remoteUrl, name, defaultBranch, repoPath);
    db.close();
    console.log(
      `[launcher] Registered repo in Conductor DB: ${repoId} (${name}) ${repoPath}`
    );
    return { repoId, name, defaultBranch };
  } catch (err) {
    console.error(`[launcher] Failed to register repo in Conductor DB:`, err);
    return null;
  }
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    if (!statSync(repoPath).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    await execAsync(`git -C ${shellQuote(repoPath)} rev-parse --git-dir`);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRepoDefaultBranch(repoPath: string): Promise<string> {
  const candidates = [
    `git -C ${shellQuote(repoPath)} symbolic-ref --short refs/remotes/origin/HEAD`,
    `git -C ${shellQuote(repoPath)} rev-parse --abbrev-ref HEAD`,
  ];

  for (const cmd of candidates) {
    try {
      const output = (await execAsync(cmd)).trim();
      const branch = output.replace(/^origin\//, "");
      if (branch && branch !== "HEAD") {
        return branch;
      }
    } catch {
      // Try the next source.
    }
  }

  return "main";
}

async function resolveRepoRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const output = (await execAsync(
      `git -C ${shellQuote(repoPath)} config --get remote.origin.url`
    )).trim();
    return output || null;
  } catch {
    return null;
  }
}

export interface ConductorWorkspaceInfo {
  workspaceId: string;
  sessionId: string;
  agentSessionId: string | null;
  agentType: AgentType;
  /** Raw sessions.agent_type — may be an agent the bot can't spawn (cursor). */
  rawAgentType: string | null;
  model: string | null;
  repoName: string | null;
  repoPath: string | null;
  workspacePath: string | null;
  /** User-visible name: workspace_name when set (0.72+), else directory_name. */
  displayName: string;
  directoryName: string;
  status: string | null;
  state: string | null;
  derivedStatus: string | null;
  pinnedAt: string | null;
  sessionHidden: boolean;
  targetBranch: string | null;
  branchName: string | null;
  hostingServerUrl: string | null;
  sandboxProvider: string | null;
  remoteFileSyncEnabled: boolean;
}

/**
 * Durable Conductor identity stored by conductor-telegram. The field names
 * intentionally match Workspace so callers can pass a tracked row directly.
 */
export interface TrackedConductorBinding {
  conductorWorkspaceId: string | null;
  conductorSessionId: string | null;
  conductorBackendKind: "local" | "cloud-api" | null;
  repoPath?: string | null;
  status?: string;
}

/** A Conductor Cloud workspace: hosted in a remote sandbox, not on this Mac. */
export function isRemoteConductorWorkspace(
  workspace: Pick<ConductorWorkspaceInfo, "hostingServerUrl" | "sandboxProvider">
): boolean {
  return Boolean(
    workspace.hostingServerUrl?.trim() || workspace.sandboxProvider?.trim()
  );
}

export function isConductorWorkspaceVisible(
  workspace: Pick<
    ConductorWorkspaceInfo,
    "state" | "derivedStatus" | "pinnedAt" | "sessionHidden"
  >
): boolean {
  if (workspace.state === "archived") return false;
  if (workspace.sessionHidden) return false;
  return true;
}

function markConductorWorkspaceActive(workspaceId: string): void {
  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    db.prepare(
      `UPDATE workspaces
       SET state = CASE WHEN state = 'archived' THEN state ELSE 'ready' END,
           derived_status = 'in-progress',
           updated_at = datetime('now')
       WHERE id = ?
         AND state != 'archived'`
    ).run(workspaceId);
    db.close();
  } catch (err) {
    console.error(`[launcher] Failed to mark workspace ${workspaceId} active:`, err);
  }
}

/** Feature-detected SELECT fragments for columns added in newer Conductor versions. */
function workspaceOptionalSelects(db: Database.Database): {
  workspacePath: string;
  workspaceName: string;
  hostingServerUrl: string;
  sandboxProvider: string;
  remoteFileSync: string;
  branchName: string;
  hasWorkspaceName: boolean;
} {
  const columns = getTableColumns(db, "workspaces");
  return {
    workspacePath: columns.has("workspace_path")
      ? "w.workspace_path"
      : "NULL as workspace_path",
    workspaceName: columns.has("workspace_name")
      ? "w.workspace_name"
      : "NULL as workspace_name",
    hostingServerUrl: columns.has("hosting_server_url")
      ? "w.hosting_server_url"
      : "NULL as hosting_server_url",
    sandboxProvider: columns.has("sandbox_provider")
      ? "w.sandbox_provider"
      : "NULL as sandbox_provider",
    remoteFileSync: columns.has("remote_file_sync_enabled")
      ? "w.remote_file_sync_enabled"
      : "0 as remote_file_sync_enabled",
    branchName: columns.has("branch") ? "w.branch as branch_name" : "NULL as branch_name",
    hasWorkspaceName: columns.has("workspace_name"),
  };
}

function getWorkspaceFromConductorDb(
  workspaceName: string,
  repoPath: string | null = null
): ConductorWorkspaceInfo | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const optional = workspaceOptionalSelects(db);
    // 0.72+ lets users rename workspaces (workspace_name); match either the
    // directory name (the bot's stored identity) or the user-set name.
    const nameMatch = optional.hasWorkspaceName
      ? "(w.directory_name = ? OR w.workspace_name = ?)"
      : "w.directory_name = ?";
    const where = [nameMatch];
    const params: any[] = optional.hasWorkspaceName
      ? [workspaceName, workspaceName]
      : [workspaceName];
    if (repoPath) {
      where.push("r.root_path = ?");
      params.push(repoPath);
    }
    const rows = db.prepare(
      `SELECT
          w.id as workspace_id,
          w.active_session_id as session_id,
          w.directory_name,
          ${optional.branchName},
          s.model,
          s.status,
          s.agent_type,
          s.claude_session_id as agent_session_id,
          s.is_hidden as session_hidden,
          r.name as repo_name,
          r.root_path as repo_path,
          ${optional.workspacePath},
          ${optional.workspaceName},
          ${optional.hostingServerUrl},
          ${optional.sandboxProvider},
          ${optional.remoteFileSync},
          w.state,
          w.derived_status,
          w.pinned_at,
          COALESCE(w.intended_target_branch, w.initialization_parent_branch, r.default_branch) as target_branch
       FROM workspaces w
       LEFT JOIN sessions s ON s.id = w.active_session_id
       LEFT JOIN repos r ON r.id = w.repository_id
       WHERE ${where.join(" AND ")}
       ORDER BY
         CASE WHEN w.state = 'archived' THEN 1 ELSE 0 END,
         CASE WHEN s.is_hidden = 1 THEN 1 ELSE 0 END,
         datetime(w.updated_at) DESC,
         w.updated_at DESC`
    ).all(...params) as any[];
    db.close();

    if (!repoPath && rows.length > 1) {
      console.warn(
        `[launcher] ambiguous Conductor workspace "${workspaceName}" matched ${rows.length} repos; caller must pass repoPath`
      );
      return null;
    }
    const row = rows[0];
    if (!row?.workspace_id || !row?.session_id) return null;
    return mapConductorWorkspaceRow(row);
  } catch {
    return null;
  }
}

function mapConductorWorkspaceRow(row: any): ConductorWorkspaceInfo {
  const directoryName = row.directory_name ?? "";
  const userSetName =
    typeof row.workspace_name === "string" && row.workspace_name.trim()
      ? row.workspace_name.trim()
      : null;
  return {
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    agentSessionId: row.agent_session_id ?? null,
    agentType: normalizeAgentType(row.agent_type) ?? "claude",
    rawAgentType: row.agent_type ?? null,
    model: row.model,
    repoName: row.repo_name ?? null,
    repoPath: row.repo_path ?? null,
    workspacePath: row.workspace_path ?? null,
    displayName: userSetName ?? directoryName,
    directoryName,
    status: row.status ?? null,
    state: row.state ?? null,
    derivedStatus: row.derived_status ?? null,
    pinnedAt: row.pinned_at ?? null,
    sessionHidden: row.session_hidden === 1,
    targetBranch: row.target_branch ?? null,
    branchName: row.branch_name ?? null,
    hostingServerUrl: row.hosting_server_url ?? null,
    sandboxProvider: row.sandbox_provider ?? null,
    remoteFileSyncEnabled: row.remote_file_sync_enabled === 1,
  };
}

function trackedCloudWorkspaceInfo(
  workspaceName: string,
  repoPath: string | null,
  binding: TrackedConductorBinding | null = null
): ConductorWorkspaceInfo | null {
  const tracked =
    binding ??
    getTrackedWorkspaceByName(workspaceName, {
      repoPath: repoPath ?? undefined,
    });
  if (
    tracked?.conductorBackendKind !== "cloud-api" ||
    !tracked.conductorWorkspaceId ||
    !tracked.conductorSessionId
  ) {
    return null;
  }

  const effectiveRepoPath = repoPath ?? tracked.repoPath ?? null;
  const archived = tracked.status === "archived";
  const inProgress =
    tracked.status === "starting" || tracked.status === "running";
  return {
    workspaceId: tracked.conductorWorkspaceId,
    sessionId: tracked.conductorSessionId,
    agentSessionId: null,
    agentType: getDefaultAgentType(),
    rawAgentType: null,
    model: null,
    repoName: effectiveRepoPath ? path.basename(effectiveRepoPath) : null,
    repoPath: effectiveRepoPath,
    workspacePath: null,
    displayName: workspaceName,
    directoryName: workspaceName,
    status: inProgress ? "working" : "idle",
    state: archived ? "archived" : "ready",
    derivedStatus: inProgress ? "in-progress" : tracked.status ?? null,
    pinnedAt: null,
    sessionHidden: archived,
    targetBranch: null,
    branchName: null,
    hostingServerUrl: null,
    sandboxProvider: "conductor-api",
    remoteFileSyncEnabled: false,
  };
}

function resolveConductorWorkspaceInfo(
  workspaceName: string,
  repoPath: string | null = null,
  binding: TrackedConductorBinding | null = null
): ConductorWorkspaceInfo | null {
  const boundCloud = trackedCloudWorkspaceInfo(
    workspaceName,
    repoPath,
    binding
  );
  if (binding?.conductorBackendKind === "cloud-api" && boundCloud) {
    return boundCloud;
  }
  return (
    getWorkspaceFromConductorDb(workspaceName, repoPath) ??
    boundCloud
  );
}

export function getWorkspaceSessionInfo(
  workspaceName: string,
  repoPath: string | null = null,
  binding: TrackedConductorBinding | null = null
): ConductorWorkspaceInfo | null {
  return resolveConductorWorkspaceInfo(workspaceName, repoPath, binding);
}

/**
 * Refresh a durable cloud binding through the public API. If the API is
 * temporarily unavailable, retain the last known identity so polling can
 * recover without falsely declaring the workspace deleted.
 */
export async function getCloudWorkspaceSessionInfo(
  workspaceName: string,
  repoPath: string | null,
  binding: TrackedConductorBinding,
  options: { includeMetadata?: boolean } = {}
): Promise<ConductorWorkspaceInfo | null> {
  const fallback = trackedCloudWorkspaceInfo(
    workspaceName,
    repoPath,
    binding
  );
  if (!fallback) return null;

  let client;
  try {
    client = createConductorApiClientFromEnv();
  } catch (error) {
    console.error("[conductor-api] Invalid cloud backend configuration:", error);
    return fallback;
  }
  if (!client) return fallback;

  try {
    const metadataPromise =
      options.includeMetadata === false
        ? Promise.resolve(null)
        : Promise.all([
            client.getWorkspace(fallback.workspaceId),
            client.getSession(fallback.sessionId),
          ]);
    const [workspaceStatus, sessionStatus, metadata] = await Promise.all([
      client.getWorkspaceStatus(fallback.workspaceId),
      client.getSessionStatus(fallback.sessionId),
      metadataPromise,
    ]);
    if (
      workspaceStatus.workspaceId !== fallback.workspaceId ||
      sessionStatus.workspaceId !== fallback.workspaceId ||
      sessionStatus.sessionId !== fallback.sessionId
    ) {
      throw new ConductorApiError(
        `Conductor API returned mismatched workspace/session identity for ${workspaceName}`
      );
    }

    const [workspace, session] = metadata ?? [null, null];
    const model = session?.resolvedModel ?? session?.model ?? fallback.model;
    const agentType = inferAgentTypeFromModel(model) ?? fallback.agentType;
    const archived =
      workspaceStatus.status === "archived" ||
      workspaceStatus.status === "deleted";
    const working =
      sessionStatus.status === "working" ||
      workspaceStatus.status === "initializing" ||
      workspaceStatus.status === "updating";
    return {
      ...fallback,
      displayName: workspace?.name.trim() || fallback.displayName,
      status: sessionStatus.status,
      state: archived ? "archived" : workspaceStatus.status,
      derivedStatus: working ? "in-progress" : "done",
      sessionHidden: Boolean(session?.archivedAt) || archived,
      agentType,
      rawAgentType: agentType,
      model,
    };
  } catch (error) {
    console.warn(
      `[conductor-api] Could not refresh persisted binding for ${workspaceName}:`,
      error
    );
    return fallback;
  }
}

export function getWorkspaceBranchName(
  workspaceName: string,
  repoPath: string | null = null
): string | null {
  return getWorkspaceFromConductorDb(workspaceName, repoPath)?.branchName ?? null;
}

// ── Threads (multiple sessions per workspace, Conductor 0.44+) ──

export interface ConductorSessionInfo {
  sessionId: string;
  workspaceId: string;
  title: string | null;
  status: string | null;
  agentType: AgentType;
  rawAgentType: string | null;
  model: string | null;
  claudeSessionId: string | null;
  isActive: boolean;
  createdAt: string | null;
  backendKind: "local" | "cloud-api";
}

const SESSION_SELECT = `
  SELECT s.id as session_id, s.workspace_id, s.title, s.status, s.agent_type,
         s.model, s.claude_session_id, s.created_at,
         CASE WHEN w.active_session_id = s.id THEN 1 ELSE 0 END as is_active
  FROM sessions s
  JOIN workspaces w ON w.id = s.workspace_id`;

function mapConductorSessionRow(row: any): ConductorSessionInfo {
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    title: row.title ?? null,
    status: row.status ?? null,
    agentType: normalizeAgentType(row.agent_type) ?? "claude",
    rawAgentType: row.agent_type ?? null,
    model: row.model ?? null,
    claudeSessionId: row.claude_session_id ?? null,
    isActive: row.is_active === 1,
    createdAt: row.created_at ?? null,
    backendKind: "local",
  };
}

function mapConductorApiSession(
  workspaceId: string,
  session: ConductorApiSession,
  status: string | null,
  isActive: boolean
): ConductorSessionInfo {
  const model = session.resolvedModel ?? session.model ?? null;
  const agentType = inferAgentTypeFromModel(model) ?? "claude";
  return {
    sessionId: session.id,
    workspaceId,
    title: session.name ?? null,
    status,
    agentType,
    rawAgentType: agentType,
    model,
    claudeSessionId: null,
    isActive,
    createdAt: null,
    backendKind: "cloud-api",
  };
}

function getWorkspaceTransportInfo(workspaceId: string): {
  isRemote: boolean;
  activeSessionId: string | null;
} | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const optional = workspaceOptionalSelects(db);
    const row = db.prepare(
      `SELECT w.active_session_id,
              ${optional.hostingServerUrl},
              ${optional.sandboxProvider}
       FROM workspaces w
       WHERE w.id = ?`
    ).get(workspaceId) as any;
    db.close();
    if (!row) return null;
    return {
      isRemote: Boolean(row.hosting_server_url || row.sandbox_provider),
      activeSessionId: row.active_session_id ?? null,
    };
  } catch {
    return null;
  }
}

function getSessionTransportInfo(sessionId: string): {
  workspaceId: string;
  isRemote: boolean;
} | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const optional = workspaceOptionalSelects(db);
    const row = db.prepare(
      `SELECT s.workspace_id,
              ${optional.hostingServerUrl},
              ${optional.sandboxProvider}
       FROM sessions s
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.id = ?`
    ).get(sessionId) as any;
    db.close();
    if (!row?.workspace_id) return null;
    return {
      workspaceId: row.workspace_id,
      isRemote: Boolean(row.hosting_server_url || row.sandbox_provider),
    };
  } catch {
    return null;
  }
}

function getConductorWorkspaceSessionsFromDb(
  workspaceId: string
): ConductorSessionInfo[] {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const rows = db.prepare(
      `${SESSION_SELECT}
       WHERE s.workspace_id = ? AND COALESCE(s.is_hidden, 0) = 0
       ORDER BY s.created_at ASC, s.id ASC`
    ).all(workspaceId) as any[];
    db.close();
    return rows.map(mapConductorSessionRow);
  } catch {
    return [];
  }
}

/** All visible sessions of a workspace, using the API for cloud workspaces. */
export async function getConductorWorkspaceSessions(
  workspaceId: string,
  preferredActiveSessionId: string | null = null,
  backendKind?: "local" | "cloud-api"
): Promise<ConductorSessionInfo[]> {
  const localSessions = getConductorWorkspaceSessionsFromDb(workspaceId);
  const transport = getWorkspaceTransportInfo(workspaceId);
  const useCloudApi =
    backendKind === "cloud-api" ||
    (backendKind === undefined && transport?.isRemote === true);
  if (!useCloudApi) {
    return localSessions;
  }

  const fallback = localSessions.map((session) => ({
    ...session,
    // Desktop mirror status is not authoritative for a cloud session. Keeping
    // this unknown prevents transient API failures from looking like completion.
    status: null,
    isActive:
      session.sessionId ===
      (preferredActiveSessionId ?? transport?.activeSessionId),
    backendKind: "cloud-api" as const,
  }));

  let client;
  try {
    client = createConductorApiClientFromEnv();
  } catch (error) {
    console.error("[conductor-api] Invalid cloud backend configuration:", error);
    return fallback;
  }
  if (!client) return fallback;

  try {
    const sessions = (await client.listWorkspaceSessions(workspaceId)).filter(
      (session) => !session.archivedAt
    );
    const statuses = await mapWithConcurrency(
      sessions,
      MAX_CONCURRENT_SESSION_REQUESTS,
      (session) =>
        client
          .getSessionStatus(session.id)
          .then((status) => {
            if (status.workspaceId !== workspaceId) {
              throw new ConductorApiError(
                `Conductor API returned session ${session.id} for a different workspace`
              );
            }
            return status;
          })
          .catch((error) => {
            console.warn(
              `[conductor-api] Could not read status for session ${session.id}:`,
              error
            );
            return null;
          })
    );
    const activeSessionId =
      preferredActiveSessionId ?? transport?.activeSessionId;
    return sessions.map((session, index) =>
      mapConductorApiSession(
        workspaceId,
        session,
        statuses[index]?.status ?? null,
        session.id === activeSessionId
      )
    );
  } catch (error) {
    console.warn(
      `[conductor-api] Falling back to the desktop DB for workspace ${workspaceId}:`,
      error
    );
    return fallback;
  }
}

export function getConductorSessionById(
  sessionId: string
): ConductorSessionInfo | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const row = db.prepare(
      `${SESSION_SELECT} WHERE s.id = ?`
    ).get(sessionId) as any;
    db.close();
    return row ? mapConductorSessionRow(row) : null;
  } catch {
    return null;
  }
}

/**
 * Make a local thread active in the desktop app. For cloud sessions the public
 * API has no active-tab mutation, so validate membership and let Telegram's
 * own persisted conductor_session_id become the default routing target.
 */
export async function setConductorActiveSession(
  workspaceId: string,
  sessionId: string,
  backendKind?: "local" | "cloud-api"
): Promise<boolean> {
  const transport = getWorkspaceTransportInfo(workspaceId);
  const useCloudApi =
    backendKind === "cloud-api" ||
    (backendKind === undefined && transport?.isRemote === true);
  if (useCloudApi) {
    let client;
    try {
      client = createConductorApiClientFromEnv();
    } catch (error) {
      console.error("[conductor-api] Invalid cloud backend configuration:", error);
      return false;
    }
    if (!client) return false;
    try {
      const status = await client.getSessionStatus(sessionId);
      return status.workspaceId === workspaceId;
    } catch (error) {
      console.error(
        `[conductor-api] Failed to validate session ${sessionId}:`,
        error
      );
      return false;
    }
  }

  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    const result = db.prepare(
      `UPDATE workspaces
       SET active_session_id = ?, updated_at = datetime('now')
       WHERE id = ?
         AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = ? AND s.workspace_id = ?)`
    ).run(sessionId, workspaceId, sessionId, workspaceId);
    db.close();
    return result.changes > 0;
  } catch (err) {
    console.error(`[launcher] Failed to set active session:`, err);
    return false;
  }
}

export interface ConductorWorkspaceListing {
  workspaceId: string;
  directoryName: string;
  displayName: string;
  repoName: string | null;
  repoPath: string | null;
  isRemote: boolean;
  updatedAt: string | null;
}

/** Recent non-archived Conductor workspaces (for /watch discovery). */
export function listRecentConductorWorkspaces(limit = 15): ConductorWorkspaceListing[] {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const optional = workspaceOptionalSelects(db);
    const rows = db.prepare(
      `SELECT w.id as workspace_id, w.directory_name, w.updated_at,
              r.name as repo_name, r.root_path as repo_path,
              ${optional.workspaceName},
              ${optional.hostingServerUrl},
              ${optional.sandboxProvider}
       FROM workspaces w
       LEFT JOIN repos r ON r.id = w.repository_id
       WHERE COALESCE(w.state, 'ready') != 'archived'
       ORDER BY datetime(w.updated_at) DESC
       LIMIT ?`
    ).all(limit) as any[];
    db.close();
    return rows.map((row) => {
      const userSetName =
        typeof row.workspace_name === "string" && row.workspace_name.trim()
          ? row.workspace_name.trim()
          : null;
      return {
        workspaceId: row.workspace_id,
        directoryName: row.directory_name ?? "",
        displayName: userSetName ?? row.directory_name ?? "",
        repoName: row.repo_name ?? null,
        repoPath: row.repo_path ?? null,
        isRemote: Boolean(row.hosting_server_url || row.sandbox_provider),
        updatedAt: row.updated_at ?? null,
      };
    });
  } catch {
    return [];
  }
}

// ── Conductor Cloud API transport ────────────────────────────
//
// Cloud writes must use Conductor's supported HTTP API. The local desktop DB
// remains a temporary read-only discovery/fallback surface, but this process
// never inserts, updates, or deletes cloud session_messages rows.

async function getRemoteSessionSendTarget(
  wsInfo: ConductorWorkspaceInfo,
  sessionId: string
): Promise<SessionSendTarget | SendError> {
  let client;
  try {
    client = createConductorApiClientFromEnv();
  } catch (error) {
    return conductorApiSendError(wsInfo, error);
  }
  if (!client) {
    return remoteObserveOnlyError(wsInfo);
  }

  try {
    const [session, status] = await Promise.all([
      client.getSession(sessionId),
      client.getSessionStatus(sessionId),
    ]);
    if (status.workspaceId !== wsInfo.workspaceId) {
      return {
        error: `That thread does not belong to "${wsInfo.displayName}".`,
        reason: "conductor_api_unavailable",
      };
    }
    const model = session.resolvedModel ?? session.model ?? wsInfo.model;
    const agentType =
      inferAgentTypeFromModel(model) ?? wsInfo.agentType;
    return {
      sessionId,
      agentType,
      rawAgentType: agentType,
      agentSessionId: null,
      model,
      status: status.status,
    };
  } catch (error) {
    return conductorApiSendError(wsInfo, error);
  }
}

function remoteObserveOnlyError(wsInfo: ConductorWorkspaceInfo): SendError {
  return {
    error:
      `☁️ "${wsInfo.displayName}" is a Conductor Cloud workspace in observe-only mode. ` +
      `${CLOUD_OBSERVE_ONLY_HINT} to steer it from Telegram.`,
    reason: "conductor_api_unavailable",
  };
}

export function canUseConductorCloudApi(): boolean {
  return isConductorCloudApiConfigured();
}

interface CloudSessionCycleWrite {
  key: string;
  previous: CloudSessionCycle | null;
  currentValue: string;
  startedAt: number;
}

function getCloudSessionCycle(
  conductorWorkspaceId: string,
  sessionId: string
): CloudSessionCycle | null {
  return parseCloudSessionCycle(
    getMetaValue(cloudSessionCycleKey(conductorWorkspaceId, sessionId))
  );
}

function reserveCloudSessionCycle(
  conductorWorkspaceId: string,
  sessionId: string
): CloudSessionCycleWrite {
  const key = cloudSessionCycleKey(conductorWorkspaceId, sessionId);
  const previous = parseCloudSessionCycle(getMetaValue(key));
  // Stamped before any network I/O so a crash mid-send still leaves an
  // expirable reservation rather than a permanently in-flight thread.
  const startedAt = Date.now();
  const currentValue = encodeCloudSessionCycle({ phase: "pending", startedAt });
  setMetaValue(key, currentValue);
  return { key, previous, currentValue, startedAt };
}

function writeCloudSessionCycle(
  write: CloudSessionCycleWrite,
  cycle: CloudSessionCycle
): boolean {
  if (getMetaValue(write.key) !== write.currentValue) return false;
  // Carry the reservation timestamp forward so the TTL measures the whole
  // cycle, not just the time since the last phase transition.
  write.currentValue = encodeCloudSessionCycle({
    startedAt: write.startedAt,
    ...cycle,
  });
  setMetaValue(write.key, write.currentValue);
  return true;
}

function restoreCloudSessionCycleAfterSendFailure(
  write: CloudSessionCycleWrite
): void {
  // Do not overwrite evidence recorded by a poll that raced the failed send.
  if (getMetaValue(write.key) !== write.currentValue) return;
  setMetaValue(
    write.key,
    encodeCloudSessionCycle(write.previous ?? { phase: "complete" })
  );
}

async function steerRemoteSession(
  wsInfo: ConductorWorkspaceInfo,
  target: SessionSendTarget,
  prompt: string,
  attachmentSourcePaths: string[]
): Promise<SendSuccess | SendError> {
  let client;
  try {
    client = createConductorApiClientFromEnv();
  } catch (error) {
    return conductorApiSendError(wsInfo, error);
  }
  if (!client) {
    return remoteObserveOnlyError(wsInfo);
  }

  const droppedCount = attachmentSourcePaths.length;
  let text = prompt.trim() || "(empty message)";
  if (droppedCount > 0) {
    text += `\n\n[Note: ${droppedCount} Telegram attachment(s) could not be delivered to this cloud workspace.]`;
  }
  const warning =
    droppedCount > 0
      ? `⚠️ ${droppedCount === 1 ? "The attachment" : `${droppedCount} attachments`} couldn't be delivered — ☁️ cloud workspaces can't receive Telegram files yet. Only the text was sent.`
      : undefined;

  const existingCycle = getCloudSessionCycle(
    wsInfo.workspaceId,
    target.sessionId
  );
  if (cloudCycleIsInFlight(existingCycle)) {
    return {
      error:
        `☁️ "${wsInfo.displayName}" still has queued or running work in that thread. ` +
        "Wait for it to finish or stop it before sending another message.",
      reason: "cloud_session_busy",
    };
  }

  const pendingCycle = reserveCloudSessionCycle(
    wsInfo.workspaceId,
    target.sessionId
  );
  try {
    const [status, latest] = await Promise.all([
      client.getSessionStatus(target.sessionId),
      client.getLatestSessionMessage(target.sessionId),
    ]);
    if (status.workspaceId !== wsInfo.workspaceId) {
      throw new ConductorApiError(
        "Conductor API returned the thread for a different workspace"
      );
    }
    if (
      status.status !== "idle" ||
      (latest && conductorApiMessageRole(latest) === "user")
    ) {
      restoreCloudSessionCycleAfterSendFailure(pendingCycle);
      return {
        error:
          `☁️ "${wsInfo.displayName}" still has queued or running work in that thread. ` +
          "Wait for it to finish or stop it before sending another message.",
        reason: "cloud_session_busy",
      };
    }

    const messageId = randomUUID();
    writeCloudSessionCycle(pendingCycle, {
      phase: "pending",
      outboundMessageId: messageId,
      ...(latest
        ? { baselineRowid: Math.max(0, Math.trunc(latest.sessionIndex)) }
        : {}),
    });
    const sent = await client.sendMessage({
      sessionId: target.sessionId,
      message: text,
      messageId,
    });
    console.log(
      `[conductor-api] message ${sent.state} for ${wsInfo.displayName} (${target.sessionId})`
    );
    return { ok: true, done: Promise.resolve({ isError: false, exitCode: 0 }), warning };
  } catch (error) {
    restoreCloudSessionCycleAfterSendFailure(pendingCycle);
    return conductorApiSendError(wsInfo, error);
  }
}

function conductorApiSendError(
  wsInfo: Pick<ConductorWorkspaceInfo, "displayName">,
  error: unknown
): SendError {
  const detail =
    error instanceof ConductorApiError
      ? error.message
      : `Conductor API request failed: ${(error as Error).message}`;
  console.error(`[conductor-api] ${wsInfo.displayName}: ${detail}`);
  return {
    error: `Could not steer ☁️ "${wsInfo.displayName}" through the Conductor API: ${detail}`,
    reason: "conductor_api_unavailable",
  };
}

/**
 * Get the agent's final result from Conductor's session_messages.
 */
export interface SessionResult {
  resultText: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  isError: boolean;
}

export interface SessionMessage {
  messageId: string | null;
  rowid: number;
  role: string;
  content: string;
  createdAt: string;
  sentAt: string | null;
}

export function getSessionResult(
  workspaceName: string,
  repoPath: string | null = null
): SessionResult | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const where = ["w.directory_name = ?", "sm.role = 'assistant'"];
    const params: any[] = [workspaceName];
    if (repoPath) {
      where.push("r.root_path = ?");
      params.push(repoPath);
    }
    const rows = db.prepare(
      `SELECT sm.content FROM session_messages sm
       JOIN sessions s ON s.id = sm.session_id
       JOIN workspaces w ON w.active_session_id = s.id
       LEFT JOIN repos r ON r.id = w.repository_id
       WHERE ${where.join(" AND ")}
       ORDER BY sm.created_at DESC LIMIT 5`
    ).all(...params) as any[];
    db.close();

    for (const row of rows) {
      try {
        const content = JSON.parse(row.content);
        if (content.type === "result") {
          return {
            resultText: content.result ?? "",
            costUsd: content.total_cost_usd ?? 0,
            durationMs: content.duration_ms ?? 0,
            numTurns: content.num_turns ?? 0,
            isError: content.is_error ?? false,
          };
        }
      } catch {
        // Not JSON or wrong shape
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Per-session variant of getSessionResult, for thread-level completion notices. */
export function getSessionResultBySessionId(
  sessionId: string
): SessionResult | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const rows = db.prepare(
      `SELECT content FROM session_messages
       WHERE session_id = ? AND role = 'assistant'
       ORDER BY created_at DESC LIMIT 5`
    ).all(sessionId) as any[];
    db.close();

    for (const row of rows) {
      try {
        const content = JSON.parse(row.content);
        if (content.type === "result") {
          return {
            resultText: content.result ?? "",
            costUsd: content.total_cost_usd ?? 0,
            durationMs: content.duration_ms ?? 0,
            numTurns: content.num_turns ?? 0,
            isError: content.is_error ?? false,
          };
        }
      } catch {
        // Not JSON or wrong shape
      }
    }
    return null;
  } catch {
    return null;
  }
}

export interface SessionMessageCursor {
  rowid: number;
  messageId: string | null;
}

/**
 * A poll cursor names a concrete transcript message, and Conductor rejects the
 * whole listing when that message no longer exists (archived thread, rebuilt
 * transcript). GET /v0/messages/{id} disambiguates a dead cursor from a
 * transient failure; on a dead cursor the poll re-anchors at the latest
 * message instead of stalling forever. Re-anchoring only happens after a
 * successful latest-message fetch, so auth or availability failures never
 * masquerade as a dead cursor.
 *
 * @internal exported for cursor-recovery unit tests; not part of the public bot API.
 */
const CURSOR_RECOVERY_PROBE_COOLDOWN_MS = 10 * 60_000;
const CURSOR_RECOVERY_PROBE_CAP = 512;
// Matches the poll loop's per-tick batch size.
const CURSOR_RECOVERY_TAIL_LIMIT = 25;
const cursorRecoveryProbes = new Map<string, number>();

/**
 * A dead cursor that cannot re-anchor yet (empty transcript, persistent
 * non-retryable failure) would otherwise re-pay the recovery probes — up to
 * three API calls — on every poll tick. Let a probe through at most once per
 * cooldown per cursor; a successful re-anchor moves the cursor id, which
 * retires its key naturally.
 */
function shouldProbeCursorRecovery(
  sessionId: string,
  afterMessageId: string | null | undefined
): boolean {
  if (!afterMessageId) return true; // recovery no-ops without a cursor
  const key = `${sessionId}:${afterMessageId}`;
  const now = Date.now();
  const last = cursorRecoveryProbes.get(key);
  if (last !== undefined && now - last < CURSOR_RECOVERY_PROBE_COOLDOWN_MS) {
    return false;
  }
  if (cursorRecoveryProbes.size >= CURSOR_RECOVERY_PROBE_CAP) {
    cursorRecoveryProbes.clear();
  }
  cursorRecoveryProbes.set(key, now);
  return true;
}

export async function recoverCloudTranscriptCursor(
  client: NonNullable<ReturnType<typeof createConductorApiClientFromEnv>>,
  sessionId: string,
  afterMessageId: string | null | undefined,
  error: unknown
): Promise<SessionMessage[] | null> {
  if (!afterMessageId) return null;
  if (
    !(error instanceof ConductorApiError) ||
    error.retryable ||
    error.status === null
  ) {
    return null;
  }
  try {
    const cursorMessage = await client.getMessage(afterMessageId);
    // The cursor still resolves to this session's transcript; the listing
    // failed for some other reason, so leave the cursor untouched.
    if (cursorMessage.sessionId === sessionId) return null;
  } catch (cursorError) {
    const cursorGone =
      cursorError instanceof ConductorApiError &&
      !cursorError.retryable &&
      cursorError.status !== null;
    if (!cursorGone) return null;
  }
  try {
    // Deliver the transcript tail rather than only the newest message, so
    // agent replies posted between the dead anchor and the tail still reach
    // Telegram after a rebuild.
    const tail = await client.getSessionMessageTail(
      sessionId,
      CURSOR_RECOVERY_TAIL_LIMIT
    );
    try {
      // A rebuilt transcript can number its messages BELOW the stored cursor
      // position, and upsertThreadCursor deliberately never moves a cloud
      // cursor backwards — clear the persisted anchor so the re-anchored
      // messages (or the next baseline pass) can actually replace it.
      resetCloudThreadCursorAnchors(sessionId);
    } catch (resetError) {
      console.warn(
        `[conductor-api] Could not reset the thread cursor for ${sessionId}:`,
        resetError
      );
    }
    console.warn(
      `[conductor-api] Transcript cursor ${afterMessageId} for ${sessionId} no longer resolves; re-anchoring at ${
        tail.length > 0
          ? `the last ${tail.length} message(s)`
          : "the empty transcript"
      }`
    );
    return tail.map(mapConductorApiMessage);
  } catch {
    return null;
  }
}

export async function getMaxSessionMessageCursor(
  sessionId: string,
  backendKind?: "local" | "cloud-api"
): Promise<SessionMessageCursor> {
  const transport = getSessionTransportInfo(sessionId);
  const explicitCloud = backendKind === "cloud-api";
  if (explicitCloud || transport?.isRemote) {
    try {
      const client = createConductorApiClientFromEnv();
      if (client) {
        const latest = await client.getLatestSessionMessage(sessionId);
        if (latest) {
          return {
            rowid: Math.max(0, Math.trunc(latest.sessionIndex)),
            messageId: latest.id,
          };
        }
        return { rowid: 0, messageId: null };
      }
    } catch (error) {
      console.warn(
        `[conductor-api] Could not establish transcript cursor for ${sessionId}:`,
        error
      );
    }
    // API message IDs and SQLite row IDs are different cursor namespaces.
    // The read-only desktop mirror may still establish a row baseline, but it
    // always leaves messageId null so a later API recovery replaces it with a
    // fresh API cursor instead of reusing a SQLite identifier.
  }

  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const row = db.prepare(
      "SELECT MAX(rowid) as maxRowId FROM session_messages WHERE session_id = ?"
    ).get(sessionId) as any;
    db.close();
    return { rowid: Number(row?.maxRowId ?? 0), messageId: null };
  } catch {
    return { rowid: 0, messageId: null };
  }
}

export async function getSessionMessagesAfter(
  sessionId: string,
  afterRowid: number,
  limit = 25,
  options: {
    afterMessageId?: string | null;
    backendKind?: "local" | "cloud-api";
  } = {}
): Promise<SessionMessage[]> {
  const transport = getSessionTransportInfo(sessionId);
  const explicitCloud = options.backendKind === "cloud-api";
  if (explicitCloud || transport?.isRemote) {
    let client: ReturnType<typeof createConductorApiClientFromEnv> = null;
    try {
      client = createConductorApiClientFromEnv();
    } catch (error) {
      console.warn(
        `[conductor-api] Could not poll transcript for ${sessionId}:`,
        error
      );
    }
    if (client) {
      try {
        if (options.afterMessageId) {
          const messages = await client.listSessionMessages({
            sessionId,
            after: options.afterMessageId,
            limit,
          });
          return messages.slice(0, limit).map(mapConductorApiMessage);
        }
        // A missing API cursor means no cursor was ever established for this
        // thread (first rollout against it, or the API was previously
        // disabled). Do not replay an entire historical transcript; the
        // poller first establishes a latest cursor.
        return [];
      } catch (error) {
        console.warn(
          `[conductor-api] Could not poll transcript for ${sessionId}:`,
          error
        );
        if (shouldProbeCursorRecovery(sessionId, options.afterMessageId)) {
          const recovered = await recoverCloudTranscriptCursor(
            client,
            sessionId,
            options.afterMessageId,
            error
          );
          if (recovered) return recovered;
        }
      }
    }
    // Preserve an established API cursor during outages. If no API cursor has
    // ever been established, the desktop DB remains a safe read-only mirror;
    // mirrored rows below deliberately return messageId=null.
    if (explicitCloud && options.afterMessageId) return [];
  }

  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const rows = db.prepare(
      `SELECT id, rowid, role, content, created_at, sent_at
       FROM session_messages
       WHERE session_id = ? AND rowid > ?
       ORDER BY rowid ASC
       LIMIT ?`
    ).all(sessionId, afterRowid, limit) as any[];
    db.close();

    return rows.map((row) => ({
      // SQLite row IDs and Cloud API message IDs are separate cursor
      // namespaces. Local polling advances only by rowid.
      messageId: null,
      rowid: Number(row.rowid),
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      sentAt: row.sent_at ?? null,
    }));
  } catch {
    return [];
  }
}

function mapConductorApiMessage(message: ConductorApiMessage): SessionMessage {
  const role = conductorApiMessageRole(message);
  return {
    messageId: message.id,
    rowid: Math.max(0, Math.trunc(message.sessionIndex)),
    role,
    content: canonicalConductorApiMessageContent(message, role),
    createdAt: message.receivedAt,
    sentAt: message.receivedAt,
  };
}

function conductorApiMessageRole(message: ConductorApiMessage): string {
  const content =
    message.content && typeof message.content === "object"
      ? (message.content as Record<string, any>)
      : null;
  const candidates = [
    content?.role,
    content?.message?.role,
    content?.type,
    message.type,
  ]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.toLowerCase());
  if (
    candidates.some(
      (candidate) =>
        candidate === "assistant" ||
        candidate.includes("assistant") ||
        candidate.includes("agent")
    )
  ) {
    return "assistant";
  }
  if (
    candidates.some(
      (candidate) =>
        candidate === "user" ||
        candidate.includes("user") ||
        candidate.includes("human")
    )
  ) {
    return "user";
  }
  if (candidates.some((candidate) => candidate.includes("result"))) {
    return "assistant";
  }
  return message.type;
}

function canonicalConductorApiMessageContent(
  message: ConductorApiMessage,
  role: string
): string {
  const content = message.content;
  if (
    content &&
    typeof content === "object" &&
    typeof (content as Record<string, unknown>).type === "string"
  ) {
    return JSON.stringify(content);
  }
  if (role !== "assistant") {
    return typeof content === "string" ? content : JSON.stringify(content);
  }

  let messageContent: unknown = content;
  if (
    content &&
    typeof content === "object" &&
    !Array.isArray(content) &&
    typeof (content as Record<string, unknown>).text === "string"
  ) {
    messageContent = (content as Record<string, unknown>).text;
  } else if (
    content &&
    typeof content === "object" &&
    !Array.isArray(content)
  ) {
    messageContent = JSON.stringify(content);
  }
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: messageContent },
  });
}

/**
 * Get the filesystem path for a workspace by its directory name.
 * Uses Conductor's stored workspace path when present, falling back to repo name.
 */
export function getWorkspaceDir(
  workspaceName: string,
  repoPath: string | null = null
): string | null {
  const wsInfo = getWorkspaceFromConductorDb(workspaceName, repoPath);
  if (!wsInfo?.repoName && !wsInfo?.workspacePath) return null;
  return getWorkspacePathFromInfo(wsInfo, workspaceName);
}

// ── Shell helpers ────────────────────────────────────────────

function execAsync(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function execFileAsync(
  command: string,
  args: string[],
  cwd?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
