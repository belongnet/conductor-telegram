import { exec, spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
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

// Track running agents by workspace name
const runningAgents = new Map<string, ChildProcess>();

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

  const child = spawn(CLAUDE_BIN, args, {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: process.env.HOME },
  });

  runningAgents.set(workspaceName, child);

  // Mark session as working
  updateSessionStatus(sessionId, "working");

  const done = new Promise<AgentResult>((resolve) => {
    let result: AgentResult = { isError: false, exitCode: null };
    let buffer = "";

    child.stdout?.on("data", (chunk: Buffer) => {
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
  // Only persist user and assistant messages
  if (msg.type !== "user" && msg.type !== "assistant" && msg.type !== "result") {
    return;
  }

  const content = JSON.stringify({
    type: msg.type,
    ...(msg.message ? { message: msg.message } : {}),
    ...(msg.type === "result" ? {
      subtype: msg.subtype,
      is_error: msg.is_error,
      duration_ms: msg.duration_ms,
      duration_api_ms: msg.duration_api_ms,
      num_turns: msg.num_turns,
      result: msg.result,
      total_cost_usd: msg.total_cost_usd,
      usage: msg.usage,
    } : {}),
  });

  const messageId = randomUUID();
  const turnId = msg.uuid ?? randomUUID();
  const timestamp = msg.timestamp ?? new Date().toISOString();
  const msgModel = msg.message?.model ?? (msg.type === "assistant" ? model : null);

  try {
    const db = new Database(CONDUCTOR_DB_PATH);
    db.prepare(
      `INSERT OR IGNORE INTO session_messages (id, session_id, role, content, created_at, model, turn_id)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?)`
    ).run(messageId, sessionId, content, timestamp, msgModel, turnId);
    db.close();
  } catch (err) {
    console.error(`[db] Failed to insert message:`, err);
  }
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
 * Launch a new Conductor workspace via deeplink, then spawn Claude CLI.
 */
export async function launchWorkspace(
  repoPath: string,
  prompt: string,
  onOutput?: (data: string) => void
): Promise<{ workspaceName: string; done: Promise<AgentResult> } | { error: string }> {
  const repoName = path.basename(repoPath);
  const workspacesDir = path.join(CONDUCTOR_WORKSPACES_DIR, repoName);

  console.log(`[launcher] launchWorkspace called: repoPath=${repoPath}`);

  // Snapshot existing directories
  let existingDirs: Set<string>;
  try {
    const entries = await readdir(workspacesDir);
    existingDirs = new Set(entries);
    console.log(`[launcher] Existing dirs in ${workspacesDir}: ${[...existingDirs].join(", ")}`);
  } catch (err) {
    existingDirs = new Set();
    console.log(`[launcher] Workspaces dir not found (${workspacesDir}), starting fresh. Error: ${err}`);
  }

  // Open deeplink to create workspace in Conductor
  const deeplinkUrl = `conductor://new?path=${encodeURIComponent(repoPath)}`;
  console.log(`[launcher] Opening deeplink: ${deeplinkUrl}`);
  try {
    await execAsync(`open "${deeplinkUrl}"`);
    console.log(`[launcher] Deeplink opened successfully`);
  } catch (err) {
    console.error(`[launcher] Deeplink failed:`, err);
    return { error: `Failed to open deeplink: ${err}` };
  }

  // Watch for new directory (30s timeout)
  console.log(`[launcher] Watching for new directory in ${workspacesDir} (30s timeout)...`);
  const newDir = await waitForNewDirectory(workspacesDir, existingDirs, 30_000);
  if (!newDir) {
    return {
      error: "Workspace creation timed out after 30s. Conductor may not be running.",
    };
  }

  console.log(`[launcher] New workspace directory: ${newDir}`);
  onOutput?.(`Workspace created: ${newDir}`);

  // Give Conductor time to set up worktree and DB records
  await sleep(3000);

  // Read workspace + session info from Conductor's DB
  const wsInfo = getWorkspaceFromConductorDb(newDir);
  if (!wsInfo) {
    return { error: `Could not find workspace "${newDir}" in Conductor DB.` };
  }

  console.log(`[launcher] Session ${wsInfo.sessionId} workspace ${wsInfo.workspaceId}`);

  const workspaceDir = path.join(workspacesDir, newDir);
  const model = wsInfo.model ?? "opus";

  // Spawn Claude CLI — no sidecar socket needed
  const { done } = spawnAgent(wsInfo.sessionId, workspaceDir, prompt, model, newDir);
  onOutput?.("Agent is running.");

  return { workspaceName: newDir, done };
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

interface ConductorWorkspaceInfo {
  workspaceId: string;
  sessionId: string;
  model: string | null;
  repoName: string | null;
}

function getWorkspaceFromConductorDb(directoryName: string): ConductorWorkspaceInfo | null {
  try {
    const db = new Database(CONDUCTOR_DB_PATH, { readonly: true });
    const row = db.prepare(
      `SELECT w.id as workspace_id, w.active_session_id as session_id, s.model, r.name as repo_name
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
    };
  } catch {
    return null;
  }
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

// ── Filesystem helpers ──────────────────────────────────────

async function waitForNewDirectory(
  dir: string,
  existing: Set<string>,
  timeoutMs: number
): Promise<string | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      clearInterval(pollInterval);
      watcher.close();
      resolve(null);
    }, timeoutMs);

    const pollInterval = setInterval(async () => {
      try {
        const entries = await readdir(dir);
        const newEntry = entries.find((e) => !existing.has(e));
        if (newEntry) {
          clearTimeout(timeout);
          clearInterval(pollInterval);
          watcher.close();
          resolve(newEntry);
        }
      } catch {
        // directory might not exist yet
      }
    }, 1000);

    let watcher: ReturnType<typeof watch>;
    try {
      watcher = watch(dir, (eventType, filename) => {
        if (filename && !existing.has(filename)) {
          clearTimeout(timeout);
          clearInterval(pollInterval);
          watcher.close();
          resolve(filename);
        }
      });
    } catch {
      watcher = { close: () => {} } as any;
    }
  });
}

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
