import { exec, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  createDecision,
  addEvent,
  getMetaValue,
  setMetaValue,
  getWorkspaceByName as getTrackedWorkspaceByName,
} from "../store/queries.js";
import { getConductorSetting } from "../store/conductor-settings.js";

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
  process.env.TELEGRAM_AGENT_PERMISSION_MODE ?? "bypassPermissions";

const DEFAULT_CLAUDE_MODEL = "opus";
const DEFAULT_CODEX_MODEL = "gpt-5.4";

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
}

export type AgentType = "claude" | "codex";
type LaunchMode = "prompt" | "review";

interface SessionLaunchOptions {
  agentType?: AgentType;
  model?: string | null;
  title?: string | null;
  launchMode?: LaunchMode;
  reviewBaseBranch?: string | null;
}

interface ResolvedLaunchConfig {
  agentType: AgentType;
  model: string;
  title: string;
  launchMode: LaunchMode;
  reviewBaseBranch: string | null;
  codexThinkingLevel: string | null;
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

function getRecentModelForAgent(agentType: AgentType): string | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const row = db.prepare(
      `SELECT model
       FROM sessions
       WHERE agent_type = ? AND model IS NOT NULL AND trim(model) != ''
       ORDER BY created_at DESC
       LIMIT 1`
    ).get(agentType) as { model?: string } | undefined;
    db.close();
    return typeof row?.model === "string" ? row.model : null;
  } catch {
    return null;
  }
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

  if (agentType === "claude") {
    return (
      firstCompatibleModel("claude", [
        launchMode === "review"
          ? getSettingValue("review_model")
          : getSettingValue("default_model"),
        getRecentModelForAgent("claude"),
        DEFAULT_CLAUDE_MODEL,
      ]) ?? DEFAULT_CLAUDE_MODEL
    );
  }

  return (
    firstCompatibleModel("codex", [
      launchMode === "review"
        ? getSettingValue("review_model")
        : getSettingValue("default_model"),
      getRecentModelForAgent("codex"),
      DEFAULT_CODEX_MODEL,
    ]) ?? DEFAULT_CODEX_MODEL
  );
}

function resolveCodexThinkingLevel(launchMode: LaunchMode): string | null {
  const settingKey =
    launchMode === "review"
      ? "review_codex_thinking_level"
      : "default_codex_thinking_level";
  return getSettingValue(settingKey);
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
    codexThinkingLevel:
      agentType === "codex" ? resolveCodexThinkingLevel(launchMode) : null,
  };
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
    reviewBaseBranch?: string | null;
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
    isFollowUp?: boolean;
  } = {}
): { child: ChildProcess; done: Promise<AgentResult> } {
  const isFollowUp = options.isFollowUp ?? false;
  const sessionFlag = isFollowUp ? "--resume" : "--session-id";
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    sessionFlag, conductorSessionId,
    "--max-turns", "1000",
    "--model", model,
    "--permission-mode", TELEGRAM_AGENT_PERMISSION_MODE,
    "--append-system-prompt", TELEGRAM_INLINE_MEDIA_SYSTEM_PROMPT,
  ];

  console.log(`[agent] Spawning: claude ${args.join(" ").slice(0, 100)}...`);
  console.log(`[agent] CWD: ${workspaceDir}`);

  console.log(`[agent] CLAUDE_BIN: ${CLAUDE_BIN}`);

  const child = spawn(CLAUDE_BIN, args, {
    cwd: workspaceDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: process.env.HOME },
  });

  console.log(`[agent] Spawned PID: ${child.pid}`);

  runningAgents.set(workspaceAgentKey(repoPath, workspaceName), child);

  // Mark session as working
  updateSessionStatus(conductorSessionId, "working");

  const done = new Promise<AgentResult>((resolve) => {
    let result: AgentResult = { isError: false, exitCode: null };
    let buffer = "";
    let stdoutBytes = 0;

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
      const text = chunk.toString().trim();
      if (text) console.log(`[agent:stderr] ${text.slice(0, 200)}`);
    });

    child.on("close", (code) => {
      console.log(`[agent] Process exited with code ${code}`);
      result.exitCode = code;
      if (code !== 0 && !result.resultText) {
        result.isError = true;
      }
      runningAgents.delete(workspaceAgentKey(repoPath, workspaceName));
      updateSessionStatus(conductorSessionId, "idle");
      resolve(result);
    });

    child.on("error", (err) => {
      console.error(`[agent] Spawn error:`, err);
      result.isError = true;
      result.exitCode = -1;
      runningAgents.delete(workspaceAgentKey(repoPath, workspaceName));
      updateSessionStatus(conductorSessionId, "idle");
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
    reviewBaseBranch?: string | null;
  } = {}
): { child: ChildProcess; done: Promise<AgentResult> } {
  const launchMode = options.launchMode ?? "prompt";
  const agentSessionId = options.agentSessionId ?? null;
  const args =
    launchMode === "review"
      ? buildCodexReviewArgs(model, prompt, options.reviewBaseBranch)
      : buildCodexExecArgs(model, prompt, agentSessionId, options.attachmentPaths ?? []);

  console.log(`[agent] Spawning: codex ${args.join(" ").slice(0, 120)}...`);
  console.log(`[agent] CWD: ${workspaceDir}`);
  console.log(`[agent] CODEX_BIN: ${CODEX_BIN}`);

  const child = spawn(CODEX_BIN, args, {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: process.env.HOME },
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
      const text = chunk.toString().trim();
      if (text) console.log(`[agent:stderr] ${text.slice(0, 200)}`);
    });

    child.on("close", (code) => {
      console.log(`[agent] Process exited with code ${code}`);
      result.exitCode = code;
      result.durationMs = Date.now() - startedAt;
      result.numTurns = turnCount;
      result.resultText = lastAssistantText || result.resultText;
      if (code !== 0 && !result.resultText) {
        result.isError = true;
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
      resolve(result);
    });

    child.on("error", (err) => {
      console.error(`[agent] Spawn error:`, err);
      result.isError = true;
      result.exitCode = -1;
      result.durationMs = Date.now() - startedAt;
      runningAgents.delete(workspaceAgentKey(repoPath, workspaceName));
      updateSessionStatus(conductorSessionId, "idle");
      resolve(result);
    });
  });

  return { child, done };
}

function buildCodexExecArgs(
  model: string,
  prompt: string,
  agentSessionId: string | null,
  attachmentPaths: string[]
): string[] {
  const imageArgs = attachmentPaths
    .filter(isImageAttachment)
    .flatMap((filePath) => ["--image", filePath]);

  if (agentSessionId) {
    return [
      "exec",
      "resume",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      model,
      ...imageArgs,
      agentSessionId,
      prompt,
    ];
  }

  return [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    model,
    ...imageArgs,
    prompt,
  ];
}

function buildCodexReviewArgs(
  model: string,
  prompt: string,
  reviewBaseBranch: string | null | undefined
): string[] {
  const args = [
    "exec",
    "review",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    model,
  ];

  if (reviewBaseBranch?.trim()) {
    args.push("--base", reviewBaseBranch.trim());
    // Codex CLI does not allow --base and a positional prompt together
  } else if (prompt.trim()) {
    args.push(prompt);
  }
  return args;
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

function simplifyModel(model: string | null | undefined): string | null {
  if (!model) return null;
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
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
    TELEGRAM_AGENT_PERMISSION_MODE,
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

/**
 * Create a workspace programmatically: git worktree + Conductor DB records.
 * No deeplinks needed — works even when Conductor UI is busy or unresponsive.
 */
export async function launchWorkspace(
  repoPath: string,
  prompt: string,
  onOutput?: (data: string) => void,
  attachmentSourcePaths: string[] = [],
  options: SessionLaunchOptions = {}
): Promise<
  {
    workspaceName: string;
    sessionId: string;
    done: Promise<AgentResult>;
    initialCursorRowid: number;
    agentType: AgentType;
    model: string;
  } | { error: string }
> {
  console.log(`[launcher] launchWorkspace called: repoPath=${repoPath}`);

  // Look up the repo in Conductor's DB before choosing the workspace path.
  // Conductor's repo name can differ from the root folder basename when users
  // add the same repo more than once, e.g. conductor-telegram-v1.
  const repoInfo = getRepoFromConductorDb(repoPath);
  if (!repoInfo) {
    return { error: `Repo "${repoPath}" not found in Conductor DB. Add it via the Conductor UI first.` };
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

  console.log(`[launcher] Creating workspace: ${cityName} (branch: ${branchName})`);

  // 1. Create git worktree
  try {
    const defaultBranch = repoInfo.defaultBranch ?? "main";
    await execAsync(
      `cd ${shellQuote(repoPath)} && git worktree add -b ${shellQuote(branchName)} ${shellQuote(workspaceDir)} ${shellQuote(defaultBranch)}`
    );
    console.log(`[launcher] Git worktree created at ${workspaceDir}`);
  } catch (err) {
    console.error(`[launcher] Git worktree failed:`, err);
    return { error: `Failed to create git worktree: ${err}` };
  }
  onOutput?.(`Workspace created: ${cityName}`);

  const stagedAttachmentPaths = stageAttachmentPaths(
    workspaceDir,
    attachmentSourcePaths
  );
  const fullPrompt = buildPromptWithAttachments(prompt, stagedAttachmentPaths);
  const launchConfig = finalizeLaunchConfig(
    resolveLaunchConfig(options),
    buildDisplayPrompt(fullPrompt, options.launchMode ?? "prompt")
  );

  // 2. Insert workspace + session into Conductor's DB
  const workspaceId = randomUUID();
  let sessionCreateResult: SessionCreateResult;

  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    const defaultBranchName = repoInfo.defaultBranch ?? "main";
    const sessionId = randomUUID();
    insertConductorWorkspace(db, {
      workspaceId,
      repoId: repoInfo.repoId,
      cityName,
      branchName,
      sessionId,
      defaultBranchName,
      workspaceDir,
    });
    sessionCreateResult = insertSessionForWorkspace(
      db,
      workspaceId,
      sessionId,
      buildDisplayPrompt(fullPrompt, launchConfig.launchMode),
      launchConfig
    );

    db.close();
    console.log(
      `[launcher] DB records created: workspace=${workspaceId}, session=${sessionCreateResult.sessionId}`
    );
  } catch (err) {
    console.error(`[launcher] DB insert failed:`, err);
    return { error: `Failed to create DB records: ${err}` };
  }

  revealWorkspaceInConductor(workspaceDir);

  // 3. Spawn the configured agent
  const { done } = spawnAgent(
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
      reviewBaseBranch: launchConfig.reviewBaseBranch,
    }
  );
  onOutput?.("Agent is running.");

  return {
    workspaceName: cityName,
    sessionId: sessionCreateResult.sessionId,
    done,
    initialCursorRowid: sessionCreateResult.initialCursorRowid,
    agentType: launchConfig.agentType,
    model: launchConfig.model,
  };
}

export interface SendError {
  error: string;
  reason?: "unsupported_agent" | "remote_observe_only" | "remote_steer_unverified";
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
export async function sendToSession(
  workspaceName: string,
  prompt: string,
  attachmentSourcePaths: string[] = [],
  options: { repoPath?: string | null; sessionId?: string | null } = {}
): Promise<{ ok: true; done: Promise<AgentResult> } | SendError> {
  const wsInfo = getWorkspaceFromConductorDb(workspaceName, options.repoPath ?? null);
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

  let target: SessionSendTarget = {
    sessionId: wsInfo.sessionId,
    agentType: wsInfo.agentType,
    rawAgentType: wsInfo.rawAgentType,
    agentSessionId: wsInfo.agentSessionId,
    model: wsInfo.model,
    status: wsInfo.status,
  };
  if (options.sessionId && options.sessionId !== wsInfo.sessionId) {
    const session = getConductorSessionById(options.sessionId);
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

  if (isRemoteConductorWorkspace(wsInfo)) {
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
  } = {}
): Promise<
  {
    sessionId: string;
    done: Promise<AgentResult>;
    initialCursorRowid: number;
    agentType: AgentType;
    model: string;
  } | SendError
> {
  const wsInfo = getWorkspaceFromConductorDb(workspaceName, options.repoPath ?? null);
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
    const remoteError: SendError = {
      error: `☁️ "${wsInfo.displayName}" runs in Conductor Cloud — the bot can message its existing threads, but can't start new threads there yet. Open it in Conductor on your Mac.`,
      reason: "remote_observe_only",
    };
    return remoteError;
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
      reviewBaseBranch,
    }
  );

  return {
    sessionId: sessionCreateResult.sessionId,
    done,
    initialCursorRowid: sessionCreateResult.initialCursorRowid,
    agentType: launchConfig.agentType,
    model: launchConfig.model,
  };
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

export function archiveConductorWorkspace(
  workspaceName: string,
  repoPath: string | null = null
): boolean {
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
  hostingServerUrl: string | null;
  sandboxProvider: string | null;
  remoteFileSyncEnabled: boolean;
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
    hostingServerUrl: row.hosting_server_url ?? null,
    sandboxProvider: row.sandbox_provider ?? null,
    remoteFileSyncEnabled: row.remote_file_sync_enabled === 1,
  };
}

export function getWorkspaceSessionInfo(
  workspaceName: string,
  repoPath: string | null = null
): ConductorWorkspaceInfo | null {
  return getWorkspaceFromConductorDb(workspaceName, repoPath);
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
  };
}

/** All visible (non-hidden) sessions of a Conductor workspace — its threads. */
export function getConductorWorkspaceSessions(
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

/** Make a thread the workspace's active session (mirrors switching tabs in the app). */
export function setConductorActiveSession(
  workspaceId: string,
  sessionId: string
): boolean {
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

// ── Conductor Cloud steering (experimental) ──────────────────
//
// Cloud workspaces run their agents in remote sandboxes; the bot can't spawn a
// CLI against them. The Mac app queues user messages as `session_messages`
// rows (queue_order set, sent_at NULL until dispatch) and dispatches them to
// the agent. We mimic that write and watch whether the running app picks it
// up. Capability is probed once per workspace and cached in bot meta.

const REMOTE_STEERING_MODE = (
  process.env.TELEGRAM_REMOTE_STEERING ?? "queue"
).trim().toLowerCase();
const STEER_DISPATCH_TIMEOUT_MS = 45_000;
const STEER_POLL_INTERVAL_MS = 1_500;

function steerCapabilityKey(workspaceId: string): string {
  return `remote_steer:${workspaceId}`;
}

function remoteObserveOnlyError(wsInfo: ConductorWorkspaceInfo): SendError {
  return {
    error: `☁️ "${wsInfo.displayName}" is a Conductor Cloud workspace in observe-only mode — its activity mirrors here, but steering from Telegram isn't available. Open it in Conductor on your Mac to reply.`,
    reason: "remote_observe_only",
  };
}

async function steerRemoteSession(
  wsInfo: ConductorWorkspaceInfo,
  target: SessionSendTarget,
  prompt: string,
  attachmentSourcePaths: string[]
): Promise<{ ok: true; done: Promise<AgentResult> } | SendError> {
  if (REMOTE_STEERING_MODE !== "queue") {
    return remoteObserveOnlyError(wsInfo);
  }
  const capability = getMetaValue(steerCapabilityKey(wsInfo.workspaceId));
  if (capability === "observe") {
    return remoteObserveOnlyError(wsInfo);
  }

  let text = prompt.trim() || "(empty message)";
  if (attachmentSourcePaths.length > 0) {
    text += `\n\n[Note: ${attachmentSourcePaths.length} Telegram attachment(s) could not be delivered to this cloud workspace.]`;
  }

  const queued = queueUserMessageInConductorDb(
    target.sessionId,
    text,
    target.model
  );
  if (!queued) {
    return {
      error: `Could not queue a message for "${wsInfo.displayName}" — this Conductor version may not support message queueing.`,
    };
  }

  const sessionBusy = target.status === "working";
  if (sessionBusy && capability === "queue") {
    // Verified workspace with a busy agent: the app dispatches queued
    // messages when the agent frees up, same as sending from the app UI.
    console.log(
      `[steer] message queued behind busy agent for ${wsInfo.displayName} (${target.sessionId})`
    );
    return { ok: true, done: Promise.resolve({ isError: false, exitCode: 0 }) };
  }

  const dispatched = await waitForQueuedDispatch(queued.messageId);
  if (dispatched) {
    setMetaValue(steerCapabilityKey(wsInfo.workspaceId), "queue");
    console.log(
      `[steer] queued message dispatched for ${wsInfo.displayName} (${target.sessionId})`
    );
    return { ok: true, done: Promise.resolve({ isError: false, exitCode: 0 }) };
  }

  removeQueuedMessageIfUndispatched(queued.messageId);
  if (sessionBusy) {
    // Can't distinguish "app never dispatches bot rows" from "agent is just
    // busy" — don't poison the capability cache; ask the user to retry.
    return {
      error: `The agent in ☁️ "${wsInfo.displayName}" is busy and steering isn't verified yet for this workspace. Try again once it's idle.`,
      reason: "remote_steer_unverified",
    };
  }
  setMetaValue(steerCapabilityKey(wsInfo.workspaceId), "observe");
  console.warn(
    `[steer] queued message was not dispatched for ${wsInfo.displayName}; marking workspace observe-only`
  );
  return remoteObserveOnlyError(wsInfo);
}

function queueUserMessageInConductorDb(
  sessionId: string,
  text: string,
  model: string | null
): { messageId: string } | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    const columns = getTableColumns(db, "session_messages");
    if (!columns.has("queue_order")) {
      db.close();
      return null;
    }

    const messageId = randomUUID();
    const now = new Date().toISOString();
    // Mirror the app's own queued-row shape (sampled from a live 0.72 DB):
    // turn_id = id, model = raw session model, sender_id = the app's client
    // user id, sent_at NULL until the app dispatches.
    const nextOrder = db.prepare(
      `SELECT COALESCE(MAX(queue_order), 0) + 1 as next_order
       FROM session_messages
       WHERE session_id = ? AND sent_at IS NULL AND queue_order IS NOT NULL`
    ).get(sessionId) as { next_order?: number } | undefined;
    const senderId = db.prepare(
      "SELECT value FROM settings WHERE key = 'roundhouse_client_user_id'"
    ).get() as { value?: string } | undefined;

    const insertColumns = [
      "id", "session_id", "role", "content", "created_at", "sent_at",
      "model", "turn_id", "queue_order",
    ];
    const values: unknown[] = [
      messageId, sessionId, "user", text, now, null,
      model, messageId, nextOrder?.next_order ?? 1,
    ];
    if (columns.has("sender_id")) {
      insertColumns.push("sender_id");
      values.push(senderId?.value ?? null);
    }

    db.prepare(
      `INSERT INTO session_messages (${insertColumns.join(", ")})
       VALUES (${insertColumns.map(() => "?").join(", ")})`
    ).run(...values);
    db.close();
    return { messageId };
  } catch (err) {
    console.error(`[steer] Failed to queue message:`, err);
    return null;
  }
}

async function waitForQueuedDispatch(messageId: string): Promise<boolean> {
  const deadline = Date.now() + STEER_DISPATCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(STEER_POLL_INTERVAL_MS);
    try {
      const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
      const row = db.prepare(
        "SELECT sent_at FROM session_messages WHERE id = ?"
      ).get(messageId) as { sent_at?: string | null } | undefined;
      db.close();
      if (row && row.sent_at) return true;
      if (!row) return false; // The app removed the row — treat as rejected.
    } catch {
      // Transient read error (WAL churn): keep polling until the deadline.
    }
  }
  return false;
}

function removeQueuedMessageIfUndispatched(messageId: string): void {
  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    db.prepare(
      "DELETE FROM session_messages WHERE id = ? AND sent_at IS NULL"
    ).run(messageId);
    db.close();
  } catch (err) {
    console.error(`[steer] Failed to clean up queued message:`, err);
  }
}

/**
 * Get session status from Conductor's DB.
 */
export function getSessionStatus(
  workspaceName: string,
  repoPath: string | null = null
): string | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const where = ["w.directory_name = ?"];
    const params: any[] = [workspaceName];
    if (repoPath) {
      where.push("r.root_path = ?");
      params.push(repoPath);
    }
    const rows = db.prepare(
      `SELECT s.status FROM sessions s
       JOIN workspaces w ON w.active_session_id = s.id
       LEFT JOIN repos r ON r.id = w.repository_id
       WHERE ${where.join(" AND ")}
       ORDER BY w.updated_at DESC`
    ).all(...params) as any[];
    db.close();
    if (!repoPath && rows.length > 1) return null;
    const row = rows[0];
    return row?.status ?? null;
  } catch {
    return null;
  }
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

export function getMaxSessionMessageRowId(sessionId: string): number {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const row = db.prepare(
      "SELECT MAX(rowid) as maxRowId FROM session_messages WHERE session_id = ?"
    ).get(sessionId) as any;
    db.close();
    return Number(row?.maxRowId ?? 0);
  } catch {
    return 0;
  }
}

export function getSessionMessagesAfter(
  sessionId: string,
  afterRowid: number,
  limit = 25
): SessionMessage[] {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const rows = db.prepare(
      `SELECT rowid, role, content, created_at, sent_at
       FROM session_messages
       WHERE session_id = ? AND rowid > ?
       ORDER BY rowid ASC
       LIMIT ?`
    ).all(sessionId, afterRowid, limit) as any[];
    db.close();

    return rows.map((row) => ({
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
