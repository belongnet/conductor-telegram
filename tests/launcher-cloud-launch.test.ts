import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * launchCloudWorkspace builds its API client from the environment, so these
 * tests run it in a child process with globalThis.fetch stubbed before the
 * call (the client captures fetch at construction time, which happens inside
 * the call). The child gets a throwaway bot DB for the cloud-cycle metadata
 * writes and empty Conductor settings so model resolution stays on the
 * shipped defaults.
 */
function runCloudLaunch(fetchBehavior: string): {
  out: Record<string, unknown>;
  calls: string[];
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-cloud-launch-"));
  const script = `
import { launchCloudWorkspace } from "./src/bot/launcher.ts";

const calls = [];
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
globalThis.fetch = async (url, init = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  const pathname = new URL(String(url)).pathname;
  calls.push(method + " " + pathname);
  const body = init.body ? JSON.parse(String(init.body)) : {};
  if (method === "POST" && pathname === "/v0/workspaces") {
    return json(201, {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      deepLink: "conductor://workspace-1",
    });
  }
  if (method === "GET" && pathname === "/v0/sessions/session-1/status") {
    return json(200, {
      workspaceId: STATUS_WORKSPACE,
      sessionId: "session-1",
      status: "idle",
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
  }
  if (method === "POST" && pathname === "/v0/sessions/session-1/messages") {
    return SEND_RESPONSE(json, body);
  }
  if (method === "GET" && pathname === "/v0/workspaces/workspace-1") {
    return json(200, {
      id: "workspace-1",
      name: "quiet-city",
      createdAt: "2026-07-30T00:00:00.000Z",
      deepLink: "conductor://workspace-1",
    });
  }
  if (method === "POST" && pathname === "/v0/workspaces/workspace-1/archive") {
    return json(200, { workspaceId: "workspace-1", status: "archived" });
  }
  return json(404, { userMessage: "unhandled " + method + " " + pathname });
};

${fetchBehavior}

const out = await launchCloudWorkspace({
  projectId: "project-1",
  prompt: "Fix the auth bug",
});
console.log(JSON.stringify({ out, calls }));
`;
  try {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CONDUCTOR_API_KEY: "test-key",
          CONDUCTOR_API_BASE_URL: "https://conductor.test",
          CONDUCTOR_CLOUD_BACKEND: "api",
          CONDUCTOR_API_MAX_RETRIES: "0",
          DB_PATH: path.join(dir, "bot.db"),
          CONDUCTOR_SETTINGS_PATH: path.join(dir, "no-settings.toml"),
          CONDUCTOR_DB_PATH: path.join(dir, "no-conductor.db"),
          TELEGRAM_DEFAULT_MODEL: "",
          TELEGRAM_REVIEW_MODEL: "",
          TELEGRAM_DEFAULT_AGENT_TYPE: "",
        },
      }
    );
    const lines = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return JSON.parse(lines[lines.length - 1] ?? "null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("cloud workspace launch queues the prompt and reads the assigned name", () => {
  const { out, calls } = runCloudLaunch(`
const STATUS_WORKSPACE = "workspace-1";
const SEND_RESPONSE = (json, body) =>
  json(201, { messageId: body.messageId, state: "queued" });
`);

  assert.equal(out.workspaceId, "workspace-1");
  assert.equal(out.sessionId, "session-1");
  assert.equal(out.backendKind, "cloud-api");
  assert.equal(out.workspaceName, "quiet-city");
  assert.equal(out.model, "fable-5");
  assert.equal(out.initialCursorRowid, 0);
  assert.equal(typeof out.initialCursorMessageId, "string");
  assert.ok(calls.includes("POST /v0/workspaces"));
  assert.ok(calls.includes("POST /v0/sessions/session-1/messages"));
  // Nothing failed, so the workspace must not be archived.
  assert.ok(!calls.includes("POST /v0/workspaces/workspace-1/archive"));
});

test("a failed first send archives the half-created cloud workspace", () => {
  const { out, calls } = runCloudLaunch(`
const STATUS_WORKSPACE = "workspace-1";
const SEND_RESPONSE = (json) => json(500, { userMessage: "boom" });
`);

  assert.equal(typeof out.error, "string");
  assert.match(String(out.error), /boom/);
  assert.ok(calls.includes("POST /v0/workspaces/workspace-1/archive"));
});

test("a session created in a foreign workspace aborts and archives", () => {
  const { out, calls } = runCloudLaunch(`
const STATUS_WORKSPACE = "workspace-other";
const SEND_RESPONSE = (json, body) =>
  json(201, { messageId: body.messageId, state: "queued" });
`);

  assert.equal(typeof out.error, "string");
  assert.match(String(out.error), /different workspace/);
  // The prompt must never be sent to a session outside the created workspace.
  assert.ok(!calls.includes("POST /v0/sessions/session-1/messages"));
  assert.ok(calls.includes("POST /v0/workspaces/workspace-1/archive"));
});
