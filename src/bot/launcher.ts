import { exec, spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const CONDUCTOR_WORKSPACES_DIR =
  process.env.CONDUCTOR_WORKSPACES_DIR ?? `${process.env.HOME}/conductor/workspaces`;

const CONDUCTOR_DB_PATH =
  process.env.CONDUCTOR_DB_PATH ??
  `${process.env.HOME}/Library/Application Support/com.conductor.app/conductor.db`;

const CLAUDE_BIN =
  process.env.CLAUDE_BIN ??
  `${process.env.HOME}/Library/Application Support/com.conductor.app/bin/claude`;

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

// ── Agent result interface ──────────────────────────────────

export interface AgentResult {
  resultText?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  isError: boolean;
  exitCode: number | null;
}

// ── Core: spawn Claude CLI + mirror to DB ───────────────────

function spawnAgent(
  sessionId: string,
  workspaceDir: string,
  prompt: string,
  model: string,
  workspaceName: string,
  isFollowUp: boolean = false
): { child: ChildProcess; done: Promise<AgentResult> } {
  const sessionFlag = isFollowUp ? "--resume" : "--session-id";
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    sessionFlag, sessionId,
    "--max-turns", "1000",
    "--model", model,
    "--permission-mode", "default",
  ];

  console.log(`[agent] Spawning: claude ${args.join(" ").slice(0, 100)}...`);
  console.log(`[agent] CWD: ${workspaceDir}`);

  console.log(`[agent] CLAUDE_BIN: ${CLAUDE_BIN}`);

  const child = spawn(CLAUDE_BIN, args, {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: process.env.HOME },
  });

  console.log(`[agent] Spawned PID: ${child.pid}`);

  runningAgents.set(workspaceName, child);

  // Mark session as working
  updateSessionStatus(sessionId, "working");

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
          processStreamMessage(sessionId, msg, model);

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
      updateSessionStatus(sessionId, "idle");
      resolve(result);
    });

    child.on("error", (err) => {
      console.error(`[agent] Spawn error:`, err);
      result.isError = true;
      result.exitCode = -1;
      runningAgents.delete(workspaceName);
      updateSessionStatus(sessionId, "idle");
      resolve(result);
    });
  });

  return { child, done };
}

/**
 * Process a streaming JSON message from Claude CLI and mirror to Conductor's DB.
 */
function processStreamMessage(sessionId: string, msg: any, model: string): void {
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
  const content =
    role === "user" && isPlainUserPrompt(msg)
      ? extractUserContent(msg)
      : JSON.stringify(normalized);

  const messageId = randomUUID();
  const turnId = msg.uuid ?? randomUUID();
  const sdkMessageId =
    role === "assistant" && typeof msg.message?.id === "string"
      ? msg.message.id
      : null;
  if (sdkMessageId) {
    lastAssistantSdkMessageIds.set(sessionId, sdkMessageId);
  }
  const lastAssistantMessageId =
    role === "user" && isPlainUserPrompt(msg)
      ? lastAssistantSdkMessageIds.get(sessionId) ?? null
      : null;
  const msgModel =
    role === "assistant" ? null : simplifyModel(msg.message?.model ?? model);

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
      msgModel,
      sdkMessageId,
      lastAssistantMessageId,
      turnId
    );
    db.close();
  } catch (err) {
    console.error(`[db] Failed to insert message:`, err);
  }
}

function isPlainUserPrompt(msg: any): boolean {
  const content = msg?.message?.content;
  if (typeof content === "string") {
    return true;
  }
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return content.every(
    (part) => part?.type === "text" && typeof part.text === "string"
  );
}

function extractUserContent(msg: any): string {
  const content = msg?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textParts = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text.trim())
      .filter(Boolean);
    if (textParts.length > 0) {
      return textParts.join("\n\n");
    }
  }
  return JSON.stringify({
    type: msg.type,
    ...(msg.message ? { message: msg.message } : {}),
  });
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
      `UPDATE sessions SET status = ?, claude_session_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(status, sessionId, sessionId);
    db.close();
    console.log(`[db] Session ${sessionId} → ${status}`);
  } catch (err) {
    console.error(`[db] Failed to update session status:`, err);
  }
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

/**
 * Create a workspace programmatically: git worktree + Conductor DB records.
 * No deeplinks needed — works even when Conductor UI is busy or unresponsive.
 */
export async function launchWorkspace(
  repoPath: string,
  prompt: string,
  onOutput?: (data: string) => void
): Promise<
  { workspaceName: string; sessionId: string; done: Promise<AgentResult> } | { error: string }
> {
  const repoName = path.basename(repoPath);
  const workspacesDir = path.join(CONDUCTOR_WORKSPACES_DIR, repoName);

  console.log(`[launcher] launchWorkspace called: repoPath=${repoPath}`);

  // Find existing workspace directories
  let existingDirs: Set<string>;
  try {
    const entries = await readdir(workspacesDir);
    existingDirs = new Set(entries);
  } catch {
    existingDirs = new Set();
  }

  // Pick a city name for the workspace
  const cityName = pickCityName(existingDirs);
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
    // Create branch from default branch and set up worktree
    const defaultBranch = repoInfo.defaultBranch ?? "main";
    await execAsync(`cd "${repoPath}" && git worktree add -b "${branchName}" "${workspaceDir}" "${defaultBranch}"`);
    console.log(`[launcher] Git worktree created at ${workspaceDir}`);
  } catch (err) {
    console.error(`[launcher] Git worktree failed:`, err);
    return { error: `Failed to create git worktree: ${err}` };
  }
  onOutput?.(`Workspace created: ${cityName}`);

  // 3. Insert workspace + session into Conductor's DB
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    db.prepare(
      `INSERT INTO workspaces (id, repository_id, directory_name, branch, active_session_id, state, derived_status)
       VALUES (?, ?, ?, ?, ?, 'active', 'in-progress')`
    ).run(workspaceId, repoInfo.repoId, cityName, branchName, sessionId);

    db.prepare(
      `INSERT INTO sessions (id, status, model, permission_mode, workspace_id, agent_type)
       VALUES (?, 'idle', 'opus', 'default', ?, 'claude')`
    ).run(sessionId, workspaceId);

    db.close();
    console.log(`[launcher] DB records created: workspace=${workspaceId}, session=${sessionId}`);
  } catch (err) {
    console.error(`[launcher] DB insert failed:`, err);
    return { error: `Failed to create DB records: ${err}` };
  }

  // 4. Spawn Claude CLI
  const { done } = spawnAgent(sessionId, workspaceDir, prompt, "opus", cityName);
  onOutput?.("Agent is running.");

  return { workspaceName: cityName, sessionId, done };
}

/**
 * Send a follow-up prompt to an existing workspace session.
 */
export async function sendToSession(
  workspaceName: string,
  prompt: string
): Promise<{ ok: true; done: Promise<AgentResult> } | { error: string }> {
  const wsInfo = getWorkspaceFromConductorDb(workspaceName);
  if (!wsInfo) {
    return { error: `Workspace "${workspaceName}" not found in Conductor DB.` };
  }

  const repoName = wsInfo.repoName ?? workspaceName;
  const workspaceDir = path.join(CONDUCTOR_WORKSPACES_DIR, repoName, workspaceName);
  const model = wsInfo.model ?? "opus";

  const { done } = spawnAgent(wsInfo.sessionId, workspaceDir, prompt, model, workspaceName, true);

  return { ok: true, done };
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
  model: string | null;
  repoName: string | null;
  status: string | null;
}

function getWorkspaceFromConductorDb(directoryName: string): ConductorWorkspaceInfo | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const row = db.prepare(
      `SELECT w.id as workspace_id, w.active_session_id as session_id, s.model, s.status, r.name as repo_name
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
      model: row.model,
      repoName: row.repo_name ?? null,
      status: row.status ?? null,
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
