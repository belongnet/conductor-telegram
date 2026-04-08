import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Workspace } from "../types/index.js";

const CLAUDE_BIN =
  process.env.CLAUDE_BIN ??
  `${process.env.HOME}/Library/Application Support/com.conductor.app/bin/claude`;
const WHISPER_CPP_DIR =
  process.env.TELEGRAM_WHISPER_CPP_DIR ??
  `${process.env.HOME}/.conductor-telegram/tools/whisper.cpp`;
const WHISPER_BIN =
  process.env.TELEGRAM_WHISPER_BIN ??
  path.join(WHISPER_CPP_DIR, "build/bin/whisper-cli");
const WHISPER_MODEL =
  process.env.TELEGRAM_WHISPER_MODEL ??
  path.join(WHISPER_CPP_DIR, "models-local/ggml-base.bin");
const AFCONVERT_BIN =
  process.env.AFCONVERT_BIN ??
  "/usr/bin/afconvert";

const ROUTER_MODEL = "sonnet";

export interface RouteResult {
  /** The transcribed text from the voice message, or the original text */
  transcript: string;
  /** "new" to create a new workspace, "existing" to send to a running one */
  action: "new" | "existing";
  /** Repo name (when action is "new") */
  repoName?: string;
  /** Workspace ID (when action is "existing") */
  workspaceId?: string;
  /** The prompt to send to the workspace / use for the new workspace */
  prompt: string;
}

/**
 * Use the existing Claude CLI to transcribe a voice message and determine
 * which repo or running workspace it should be routed to.
 */
export async function routeVoiceMessage(
  voicePath: string,
  repos: string[],
  activeWorkspaces: Workspace[]
): Promise<RouteResult | null> {
  const transcript = await transcribeVoiceMessage(voicePath);
  if (!transcript) {
    return null;
  }

  const context = buildContext(repos, activeWorkspaces);
  const prompt = `${context}

The user sent a voice message.
It was transcribed as: ${JSON.stringify(transcript)}
Route it to the appropriate repo or workspace.
Respond with ONLY a JSON object (no markdown, no code fences).`;

  return runClaudeRouter(prompt);
}

/**
 * Use the existing Claude CLI to determine which repo or running workspace
 * a text message should be routed to.
 */
export async function routeTextMessage(
  text: string,
  repos: string[],
  activeWorkspaces: Workspace[]
): Promise<RouteResult | null> {
  const context = buildContext(repos, activeWorkspaces);
  const prompt = `${context}

The user sent this message: "${text}"
Route it to the appropriate repo or workspace.
Respond with ONLY a JSON object (no markdown, no code fences).`;

  return runClaudeRouter(prompt);
}

function buildContext(repos: string[], activeWorkspaces: Workspace[]): string {
  const repoList = repos.map((r, i) => `${i + 1}. ${r}`).join("\n");

  const workspaceList =
    activeWorkspaces.length > 0
      ? activeWorkspaces
          .map((ws) => {
            const name = ws.conductorWorkspaceName ?? ws.name;
            const repo = path.basename(ws.repoPath);
            return `- ID: ${ws.id} | Name: ${name} | Repo: ${repo} | Status: ${ws.status} | Prompt: ${ws.prompt.slice(0, 120)}`;
          })
          .join("\n")
      : "(none running)";

  return `You are a routing assistant. Your ONLY job is to determine where a user message should go.

Available repositories:
${repoList}

Currently active workspaces:
${workspaceList}

Rules:
- If the message clearly relates to work in an active workspace, route there (action: "existing").
- Otherwise, route to the best matching repo (action: "new").
- Use the repo name (not number).
- The prompt should be a clean, actionable instruction. Remove filler words and "um/uh" but preserve full intent.
- If you cannot confidently determine the target repo, pick the most likely one based on the repo name and message content.

Respond with ONLY a JSON object:
{
  "transcript": "the transcription or original text",
  "action": "new" or "existing",
  "repoName": "repo-name (when action is new)",
  "workspaceId": "workspace-uuid (when action is existing)",
  "prompt": "clean actionable prompt for the agent"
}`;
}

async function transcribeVoiceMessage(voicePath: string): Promise<string | null> {
  if (!existsSync(voicePath)) {
    console.log(`[ai-router] Voice file not found: ${voicePath}`);
    return null;
  }
  if (!existsSync(AFCONVERT_BIN)) {
    console.log(`[ai-router] afconvert not found at ${AFCONVERT_BIN}`);
    return null;
  }
  if (!existsSync(WHISPER_BIN)) {
    console.log(`[ai-router] whisper-cli not found at ${WHISPER_BIN}`);
    return null;
  }
  if (!existsSync(WHISPER_MODEL)) {
    console.log(`[ai-router] Whisper model not found at ${WHISPER_MODEL}`);
    return null;
  }

  const wavPath = path.join(
    tmpdir(),
    `telegram-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
  );

  try {
    const convert = await runCommand(AFCONVERT_BIN, [
      "-f", "WAVE",
      "-d", "LEI16@16000",
      voicePath,
      wavPath,
    ]);
    if (convert.code !== 0) {
      console.log(`[ai-router] afconvert failed: ${convert.stderr.slice(0, 300)}`);
      return null;
    }

    const whisper = await runCommand(WHISPER_BIN, [
      "-m", WHISPER_MODEL,
      "-l", "auto",
      "-np",
      "-nt",
      "-f", wavPath,
    ], { cwd: WHISPER_CPP_DIR });
    if (whisper.code !== 0) {
      console.log(`[ai-router] whisper transcription failed: ${whisper.stderr.slice(0, 300)}`);
      return null;
    }

    const transcript = whisper.stdout.trim();
    if (!transcript) {
      console.log("[ai-router] Whisper returned an empty transcript");
      return null;
    }

    console.log(`[ai-router] Transcribed voice message: ${transcript.slice(0, 200)}`);
    return transcript;
  } finally {
    try {
      unlinkSync(wavPath);
    } catch {
      // Ignore temp-file cleanup failures.
    }
  }
}

function runClaudeRouter(
  prompt: string,
  options: {
    addDirs?: string[];
    maxTurns?: number;
  } = {}
): Promise<RouteResult | null> {
  return new Promise((resolve) => {
    const addDirs = [...new Set((options.addDirs ?? []).filter(Boolean))];
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--model", ROUTER_MODEL,
      "--max-turns", String(options.maxTurns ?? 1),
      "--permission-mode", "default",
    ];
    for (const dir of addDirs) {
      args.push("--add-dir", dir);
    }

    console.log(`[ai-router] Spawning Claude CLI for routing...`);

    const child = spawn(CLAUDE_BIN, args, {
      cwd: process.env.HOME ?? "/tmp",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: process.env.HOME },
    });

    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (result: RouteResult | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Timeout after 60 seconds
    const timeout = setTimeout(() => {
      console.log("[ai-router] Timeout — killing router process");
      child.kill();
      finish(null);
    }, 60_000);

    child.on("error", (err) => {
      console.log(`[ai-router] Failed to spawn router CLI: ${String(err)}`);
      finish(null);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.log(`[ai-router] CLI exited with code ${code}: ${stderr.slice(0, 200)}`);
        finish(null);
        return;
      }

      finish(parseCliOutput(stdout));
    });
  });
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
  } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: process.env.HOME },
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      resolve({
        code: -1,
        stdout,
        stderr: stderr || String(err),
      });
    });

    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function parseCliOutput(output: string): RouteResult | null {
  try {
    // The CLI with --output-format json wraps the result in a JSON envelope
    const envelope = JSON.parse(output);
    const text = envelope?.result ?? output;
    return parseRouteJson(text);
  } catch {
    // Try parsing the raw output directly
    return parseRouteJson(output);
  }
}

function parseRouteJson(text: string): RouteResult | null {
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.action || !parsed.prompt) return null;
    return {
      transcript: parsed.transcript ?? parsed.prompt,
      action: parsed.action,
      repoName: parsed.repoName,
      workspaceId: parsed.workspaceId,
      prompt: parsed.prompt,
    };
  } catch {
    return null;
  }
}
