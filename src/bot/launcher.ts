import { exec, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  createDecision,
  addEvent,
  getWorkspaceByName as getTrackedWorkspaceByName,
} from "../store/queries.js";

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

function buildPromptWithAttachments(
  prompt: string,
  attachmentPaths: string[]
): string {
  const trimmedPrompt = prompt.trim();
  if (attachmentPaths.length === 0) {
    return trimmedPrompt;
  }

  const attachmentLines = attachmentPaths.map((filePath) => `[Attached: ${filePath}]`);
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

function getSettingValue(key: string): string | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const row = db.prepare(
      "SELECT value FROM settings WHERE key = ?"
    ).get(key) as { value?: string } | undefined;
    db.close();
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    return null;
  }
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
  return normalizeAgentType(process.env.TELEGRAM_DEFAULT_AGENT_TYPE) ?? "claude";
}

function getReviewAgentType(): AgentType {
  const configured = normalizeAgentType(process.env.TELEGRAM_REVIEW_AGENT_TYPE);
  if (configured) {
    return configured;
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
    return normalizeModelForCli(
      getSettingValue("default_model") ??
      getRecentModelForAgent("claude") ??
      DEFAULT_CLAUDE_MODEL
    );
  }

  return getRecentModelForAgent("codex") ?? DEFAULT_CODEX_MODEL;
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
    .find((line) => line.length > 0 && !line.startsWith("[Attached:"));
  return truncateTitle(firstLine ?? fallback, 80);
}

function truncateTitle(value: string, maxLen: number): string {
  return value.length > maxLen ? `${value.slice(0, maxLen - 3)}...` : value;
}

function resolveLaunchConfig(
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
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(
    path.extname(filePath).toLowerCase()
  );
}

// ── Core: spawn Claude CLI + mirror to DB ───────────────────

function spawnAgent(
  conductorSessionId: string,
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
      workspaceDir,
      prompt,
      model,
      workspaceName,
      options
    );
  }

  return spawnClaudeAgent(
    conductorSessionId,
    workspaceDir,
    prompt,
    model,
    workspaceName,
    options
  );
}

function spawnClaudeAgent(
  conductorSessionId: string,
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

  runningAgents.set(workspaceName, child);

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
          processStreamMessage(conductorSessionId, msg, model, workspaceName);

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
      runningAgents.delete(workspaceName);
      updateSessionStatus(conductorSessionId, "idle");
      resolve(result);
    });

    child.on("error", (err) => {
      console.error(`[agent] Spawn error:`, err);
      result.isError = true;
      result.exitCode = -1;
      runningAgents.delete(workspaceName);
      updateSessionStatus(conductorSessionId, "idle");
      resolve(result);
    });
  });

  return { child, done };
}

function spawnCodexAgent(
  conductorSessionId: string,
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

  runningAgents.set(workspaceName, child);
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

      runningAgents.delete(workspaceName);
      updateSessionStatus(conductorSessionId, "idle");
      resolve(result);
    });

    child.on("error", (err) => {
      console.error(`[agent] Spawn error:`, err);
      result.isError = true;
      result.exitCode = -1;
      result.durationMs = Date.now() - startedAt;
      runningAgents.delete(workspaceName);
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
export function sendInputToAgent(workspaceName: string, input: string): boolean {
  const child = runningAgents.get(workspaceName);
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
function extractAskUserQuestion(input: any): { question: string; options: string[] | undefined } {
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
  const workspaceName = pendingStdinDecisions.get(decisionId);
  if (!workspaceName) return false;
  pendingStdinDecisions.delete(decisionId);
  return sendInputToAgent(workspaceName, answer);
}

/**
 * Process a streaming JSON message from Claude CLI and mirror to Conductor's DB.
 */
function processStreamMessage(sessionId: string, msg: any, model: string, workspaceName?: string): void {
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
          const trackedWs = getTrackedWorkspaceByName(workspaceName);
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
            pendingStdinDecisions.set(decisionId, workspaceName);
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

async function getExistingWorkspaceBranchNames(repoPath: string): Promise<Set<string>> {
  try {
    const output = await execAsync(
      `cd "${repoPath}" && git branch --format='%(refname:short)' --list 'belongcond/*'`
    );
    return new Set(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("belongcond/"))
        .map((line) => line.slice("belongcond/".length))
        .filter((line) => line.length > 0)
    );
  } catch {
    return new Set();
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
  const repoName = path.basename(repoPath);
  const workspacesDir = path.join(CONDUCTOR_WORKSPACES_DIR, repoName);

  console.log(`[launcher] launchWorkspace called: repoPath=${repoPath}`);

  // Reserve city names already used by workspace directories or workspace branches.
  let reservedNames: Set<string>;
  try {
    const entries = await readdir(workspacesDir);
    reservedNames = new Set(entries);
  } catch {
    reservedNames = new Set();
  }
  for (const branchName of await getExistingWorkspaceBranchNames(repoPath)) {
    reservedNames.add(branchName);
  }

  // Pick a city name for the workspace
  const cityName = pickCityName(reservedNames);
  const branchName = `belongcond/${cityName}`;
  const workspaceDir = path.join(workspacesDir, cityName);

  console.log(`[launcher] Creating workspace: ${cityName} (branch: ${branchName})`);

  // 1. Look up the repo in Conductor's DB
  const repoInfo = getRepoFromConductorDb(repoPath);
  if (!repoInfo) {
    return { error: `Repo "${repoPath}" not found in Conductor DB. Add it via the Conductor UI first.` };
  }
  console.log(`[launcher] Found repo: ${repoInfo.repoId} (${repoInfo.name})`);

  // 2. Create git worktree
  try {
    const defaultBranch = repoInfo.defaultBranch ?? "main";
    await execAsync(`cd "${repoPath}" && git worktree add -b "${branchName}" "${workspaceDir}" "${defaultBranch}"`);
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

  // 3. Insert workspace + session into Conductor's DB
  const workspaceId = randomUUID();
  let sessionCreateResult: SessionCreateResult;

  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    const defaultBranchName = repoInfo.defaultBranch ?? "main";
    const sessionId = randomUUID();
    db.prepare(
      `INSERT INTO workspaces (id, repository_id, directory_name, branch, active_session_id, state, derived_status, initialization_parent_branch, intended_target_branch, placeholder_branch_name, initialization_files_copied)
       VALUES (?, ?, ?, ?, ?, 'ready', 'in-progress', ?, ?, ?, 0)`
    ).run(workspaceId, repoInfo.repoId, cityName, branchName, sessionId, defaultBranchName, defaultBranchName, branchName);
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

  // 4. Spawn the configured agent
  const { done } = spawnAgent(
    sessionCreateResult.sessionId,
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

/**
 * Send a follow-up prompt to an existing workspace session.
 */
export async function sendToSession(
  workspaceName: string,
  prompt: string,
  attachmentSourcePaths: string[] = []
): Promise<{ ok: true; done: Promise<AgentResult> } | { error: string }> {
  const wsInfo = getWorkspaceFromConductorDb(workspaceName);
  if (!wsInfo) {
    return { error: `Workspace "${workspaceName}" not found in Conductor DB.` };
  }

  const repoName = wsInfo.repoName ?? workspaceName;
  const workspaceDir = path.join(CONDUCTOR_WORKSPACES_DIR, repoName, workspaceName);
  const stagedAttachmentPaths = stageAttachmentPaths(
    workspaceDir,
    attachmentSourcePaths
  );
  const fullPrompt = buildPromptWithAttachments(prompt, stagedAttachmentPaths);

  const { done } = spawnAgent(
    wsInfo.sessionId,
    workspaceDir,
    fullPrompt,
    normalizeModelForCli(wsInfo.model ?? resolveAgentModel(wsInfo.agentType, "prompt")),
    wsInfo.agentType,
    workspaceName,
    {
      agentSessionId: wsInfo.agentSessionId,
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
  } = {}
): Promise<
  {
    sessionId: string;
    done: Promise<AgentResult>;
    initialCursorRowid: number;
    agentType: AgentType;
    model: string;
  } | { error: string }
> {
  const wsInfo = getWorkspaceFromConductorDb(workspaceName);
  if (!wsInfo) {
    return { error: `Workspace "${workspaceName}" not found in Conductor DB.` };
  }

  const repoName = wsInfo.repoName ?? workspaceName;
  const workspaceDir = path.join(CONDUCTOR_WORKSPACES_DIR, repoName, workspaceName);
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

  revealWorkspaceInConductor(workspaceDir);

  const { done } = spawnAgent(
    sessionCreateResult.sessionId,
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
export function stopAgent(workspaceName: string): boolean {
  const child = runningAgents.get(workspaceName);
  if (!child) return false;

  child.kill("SIGTERM");
  // Give it 5s for graceful shutdown, then force kill
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 5000);

  runningAgents.delete(workspaceName);
  return true;
}

/**
 * Check if an agent is currently running.
 */
export function isAgentRunning(workspaceName: string): boolean {
  return runningAgents.has(workspaceName);
}

// ── Conductor DB helpers ────────────────────────────────────

interface ConductorRepoInfo {
  repoId: string;
  name: string;
  defaultBranch: string | null;
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

interface ConductorWorkspaceInfo {
  workspaceId: string;
  sessionId: string;
  agentSessionId: string | null;
  agentType: AgentType;
  model: string | null;
  repoName: string | null;
  repoPath: string | null;
  status: string | null;
  targetBranch: string | null;
}

function getWorkspaceFromConductorDb(directoryName: string): ConductorWorkspaceInfo | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const row = db.prepare(
      `SELECT
          w.id as workspace_id,
          w.active_session_id as session_id,
          s.model,
          s.status,
          s.agent_type,
          s.claude_session_id as agent_session_id,
          r.name as repo_name,
          r.root_path as repo_path,
          COALESCE(w.intended_target_branch, w.initialization_parent_branch, r.default_branch) as target_branch
       FROM workspaces w
       LEFT JOIN sessions s ON s.id = w.active_session_id
       LEFT JOIN repos r ON r.id = w.repository_id
       WHERE w.directory_name = ?`
    ).get(directoryName) as any;
    db.close();

    if (!row?.workspace_id || !row?.session_id) return null;
    return {
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      agentSessionId: row.agent_session_id ?? null,
      agentType: normalizeAgentType(row.agent_type) ?? "claude",
      model: row.model,
      repoName: row.repo_name ?? null,
      repoPath: row.repo_path ?? null,
      status: row.status ?? null,
      targetBranch: row.target_branch ?? null,
    };
  } catch {
    return null;
  }
}

export function getWorkspaceSessionInfo(
  workspaceName: string
): ConductorWorkspaceInfo | null {
  return getWorkspaceFromConductorDb(workspaceName);
}

/**
 * Get session status from Conductor's DB.
 */
export function getSessionStatus(workspaceName: string): string | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const row = db.prepare(
      `SELECT s.status FROM sessions s
       JOIN workspaces w ON w.active_session_id = s.id
       WHERE w.directory_name = ?`
    ).get(workspaceName) as any;
    db.close();
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

export function getSessionResult(workspaceName: string): SessionResult | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const rows = db.prepare(
      `SELECT sm.content FROM session_messages sm
       JOIN sessions s ON s.id = sm.session_id
       JOIN workspaces w ON w.active_session_id = s.id
       WHERE w.directory_name = ? AND sm.role = 'assistant'
       ORDER BY sm.created_at DESC LIMIT 5`
    ).all(workspaceName) as any[];
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
 * Looks up the repo name from Conductor's DB to build the full path.
 */
export function getWorkspaceDir(workspaceName: string): string | null {
  const wsInfo = getWorkspaceFromConductorDb(workspaceName);
  if (!wsInfo?.repoName) return null;
  return path.join(CONDUCTOR_WORKSPACES_DIR, wsInfo.repoName, workspaceName);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
