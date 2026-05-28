import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { closeDb, getDb } from "../src/store/db.js";
import {
  buildCodexExecArgs,
  formatAttachmentReference,
  getTerminalSessionStatus,
  inferAgentTypeFromModel,
  isConductorWorkspaceVisible,
} from "../src/bot/launcher.js";
import { runStartupMaintenance } from "../src/store/maintenance.js";

test("attachment references use markdown syntax that inline media extractor understands", () => {
  assert.equal(
    formatAttachmentReference("/tmp/screenshot.png"),
    "![screenshot.png](/tmp/screenshot.png)"
  );
  assert.equal(
    formatAttachmentReference("/tmp/notes.pdf"),
    "[notes.pdf](/tmp/notes.pdf)"
  );
  assert.equal(
    formatAttachmentReference("/tmp/photo.heic"),
    "![photo.heic](/tmp/photo.heic)"
  );
});

test("Conductor visibility hides archived or hidden workspaces", () => {
  assert.equal(
    isConductorWorkspaceVisible({
      state: "ready",
      derivedStatus: "in-progress",
      pinnedAt: null,
      sessionHidden: false,
    }),
    true
  );
  assert.equal(
    isConductorWorkspaceVisible({
      state: "archived",
      derivedStatus: "in-progress",
      pinnedAt: null,
      sessionHidden: false,
    }),
    false
  );
  assert.equal(
    isConductorWorkspaceVisible({
      state: "ready",
      derivedStatus: "done",
      pinnedAt: null,
      sessionHidden: false,
    }),
    true
  );
  assert.equal(
    isConductorWorkspaceVisible({
      state: "ready",
      derivedStatus: "done",
      pinnedAt: null,
      sessionHidden: true,
    }),
    false
  );
});

test("model family detection recognizes Codex and Claude model names", () => {
  assert.equal(inferAgentTypeFromModel("gpt-5.5"), "codex");
  assert.equal(inferAgentTypeFromModel("o4-mini"), "codex");
  assert.equal(inferAgentTypeFromModel("opus-1m"), "claude");
  assert.equal(inferAgentTypeFromModel("claude-sonnet-4-5"), "claude");
  assert.equal(inferAgentTypeFromModel("custom-router-model"), null);
});

test("Codex exec args delimit prompts after variadic image attachments", () => {
  assert.deepEqual(
    buildCodexExecArgs(
      "gpt-5.5",
      "Review this screenshot.",
      null,
      ["/tmp/screenshot.png", "/tmp/notes.txt"]
    ),
    [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.5",
      "--image",
      "/tmp/screenshot.png",
      "--",
      "Review this screenshot.",
    ]
  );

  assert.deepEqual(
    buildCodexExecArgs(
      "gpt-5.5",
      "Follow up with this screenshot.",
      "thread-123",
      ["/tmp/screenshot.jpg"]
    ),
    [
      "exec",
      "resume",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.5",
      "--image",
      "/tmp/screenshot.jpg",
      "--",
      "thread-123",
      "Follow up with this screenshot.",
    ]
  );
});

test("agent process failures leave sessions in error status", () => {
  assert.equal(getTerminalSessionStatus({ isError: false, exitCode: 0 }), "idle");
  assert.equal(getTerminalSessionStatus({ isError: true, exitCode: 0 }), "error");
  assert.equal(getTerminalSessionStatus({ isError: false, exitCode: 1 }), "error");
  assert.equal(getTerminalSessionStatus({ isError: false, exitCode: -1 }), "error");
});

test("OpenAI Conductor default model selects Codex when no Telegram agent is configured", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-model-default-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const db = createConductorDb(dbPath);
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('default_model', 'gpt-5.5')"
    ).run();
    db.close();

    const result = runLauncherEval(
      `
        import { resolveLaunchConfig } from "./src/bot/launcher.ts";
        console.log(JSON.stringify(resolveLaunchConfig({})));
      `,
      {
        CONDUCTOR_DB_PATH: dbPath,
        TELEGRAM_DEFAULT_AGENT_TYPE: "",
        TELEGRAM_DEFAULT_MODEL: "",
      }
    ) as { agentType: string; model: string };

    assert.equal(result.agentType, "codex");
    assert.equal(result.model, "gpt-5.5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude launch skips incompatible OpenAI model history", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-claude-model-skip-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const db = createConductorDb(dbPath);
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('default_model', 'gpt-5.5')"
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, status, updated_at, workspace_id, model, agent_type)
       VALUES ('bad-claude-session', 'idle', datetime('now'), 'ws-1', 'gpt-5.5', 'claude')`
    ).run();
    db.close();

    const result = runLauncherEval(
      `
        import { resolveLaunchConfig } from "./src/bot/launcher.ts";
        console.log(JSON.stringify(resolveLaunchConfig({})));
      `,
      {
        CONDUCTOR_DB_PATH: dbPath,
        TELEGRAM_DEFAULT_AGENT_TYPE: "claude",
        TELEGRAM_DEFAULT_MODEL: "",
      }
    ) as { agentType: string; model: string };

    assert.equal(result.agentType, "claude");
    assert.equal(result.model, "opus");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Conductor workspace lookup prefers the newest timestamp even across mixed SQLite formats", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-conductor-db-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const db = createConductorDb(dbPath);
    db.prepare(
      `INSERT INTO repos (id, root_path, name, default_branch)
       VALUES ('repo-1', '/tmp/repo', 'repo', 'main')`
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, status, updated_at, workspace_id, is_hidden, model, agent_type)
       VALUES
        ('old-session', 'idle', datetime('now'), 'old-ws', 0, 'gpt-5.4', 'codex'),
        ('new-session', 'idle', datetime('now'), 'new-ws', 0, 'gpt-5.4', 'codex')`
    ).run();
    db.prepare(
      `INSERT INTO workspaces
        (id, repository_id, directory_name, active_session_id, updated_at, state, derived_status, pinned_at, initialization_parent_branch, intended_target_branch)
       VALUES
        ('old-ws', 'repo-1', 'same-name', 'old-session', '2026-05-19T00:01:00.000Z', 'ready', 'in-progress', NULL, NULL, NULL),
        ('new-ws', 'repo-1', 'same-name', 'new-session', '2026-05-19 23:59:59', 'ready', 'in-progress', NULL, NULL, NULL)`
    ).run();
    db.close();

    const result = runLauncherEval(
      `
        import { getWorkspaceSessionInfo } from "./src/bot/launcher.ts";
        console.log(JSON.stringify(getWorkspaceSessionInfo("same-name", "/tmp/repo")));
      `,
      { CONDUCTOR_DB_PATH: dbPath }
    ) as { workspaceId: string; sessionId: string };

    assert.equal(result.workspaceId, "new-ws");
    assert.equal(result.sessionId, "new-session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace directories use Conductor repo names when root folder names differ", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-conductor-path-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const workspaceRoot = path.join(dir, "workspaces");
    const db = createConductorDb(dbPath);
    db.prepare(
      `INSERT INTO repos (id, root_path, name, default_branch)
       VALUES ('repo-1', '/tmp/repos/conductor-telegram', 'conductor-telegram-v1', 'main')`
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, status, updated_at, workspace_id, is_hidden, model, agent_type)
       VALUES ('session-1', 'idle', datetime('now'), 'ws-1', 0, 'gpt-5.4', 'codex')`
    ).run();
    db.prepare(
      `INSERT INTO workspaces
        (id, repository_id, directory_name, active_session_id, updated_at, state, derived_status, pinned_at, initialization_parent_branch, intended_target_branch, workspace_path)
       VALUES
        ('ws-1', 'repo-1', 'rabat', 'session-1', '2026-05-19 00:00:00', 'ready', 'in-progress', NULL, 'main', 'main', NULL)`
    ).run();
    db.close();

    const result = runLauncherEval(
      `
        import { getWorkspaceDir } from "./src/bot/launcher.ts";
        console.log(JSON.stringify({
          dir: getWorkspaceDir("rabat", "/tmp/repos/conductor-telegram")
        }));
      `,
      {
        CONDUCTOR_DB_PATH: dbPath,
        CONDUCTOR_WORKSPACES_DIR: workspaceRoot,
      }
    ) as { dir: string };

    assert.equal(
      result.dir,
      path.join(workspaceRoot, "conductor-telegram-v1", "rabat")
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sendToSession does not mark Conductor workspaces active when launch preconditions fail", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-conductor-send-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const db = createConductorDb(dbPath);
    db.prepare(
      `INSERT INTO sessions (id, status, updated_at, workspace_id, is_hidden, model, agent_type)
       VALUES ('session-1', 'idle', datetime('now'), 'ws-1', 0, 'gpt-5.4', 'codex')`
    ).run();
    db.prepare(
      `INSERT INTO workspaces
        (id, repository_id, directory_name, active_session_id, updated_at, state, derived_status, pinned_at, initialization_parent_branch, intended_target_branch)
       VALUES
        ('ws-1', NULL, 'missing-repo-path', 'session-1', '2026-05-19 00:00:00', 'ready', 'done', NULL, NULL, NULL)`
    ).run();
    db.close();

    const result = runLauncherEval(
      `
        import { sendToSession } from "./src/bot/launcher.ts";
        console.log(JSON.stringify(await sendToSession("missing-repo-path", "hello")));
      `,
      { CONDUCTOR_DB_PATH: dbPath }
    ) as { error: string };

    assert.equal(
      result.error,
      'Workspace "missing-repo-path" is missing repo path metadata.'
    );

    const verifyDb = new Database(dbPath);
    const after = verifyDb
      .prepare("SELECT state, derived_status FROM workspaces WHERE id = 'ws-1'")
      .get() as {
      state: string;
      derived_status: string;
    };
    verifyDb.close();
    assert.equal(after.state, "ready");
    assert.equal(after.derived_status, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup maintenance prunes old events and archived message links", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-maintenance-"));
  try {
    const db = getDb(path.join(dir, "bot.db"));
    db.prepare(
      `INSERT INTO workspaces
        (id, name, prompt, status, repo_path, created_at, telegram_chat_id, archived_at)
       VALUES
        ('old-ws', 'old', 'old prompt', 'archived', '/repos/a', datetime('now', '-45 days'), '1', datetime('now', '-45 days')),
        ('new-ws', 'new', 'new prompt', 'running', '/repos/a', datetime('now'), '1', NULL)`
    ).run();
    db.prepare(
      `INSERT INTO events (workspace_id, type, payload, created_at)
       VALUES
        ('old-ws', 'status', '{}', datetime('now', '-45 days')),
        ('new-ws', 'status', '{}', datetime('now'))`
    ).run();
    db.prepare(
      `INSERT INTO telegram_message_links (chat_id, telegram_message_id, workspace_id, created_at)
       VALUES
        ('1', '10', 'old-ws', datetime('now', '-45 days')),
        ('1', '11', 'new-ws', datetime('now'))`
    ).run();

    const report = runStartupMaintenance();
    assert.equal(report.eventsDeleted, 1);
    assert.equal(report.linksDeleted, 1);
    const eventCount = db
      .prepare("SELECT COUNT(*) AS count FROM events")
      .get() as { count: number };
    const linkCount = db
      .prepare("SELECT COUNT(*) AS count FROM telegram_message_links")
      .get() as { count: number };
    assert.equal(eventCount.count, 1);
    assert.equal(linkCount.count, 1);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

function createConductorDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY,
      root_path TEXT,
      name TEXT,
      default_branch TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      status TEXT,
      claude_session_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT,
      workspace_id TEXT,
      is_hidden INTEGER DEFAULT 0,
      model TEXT,
      agent_type TEXT
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      repository_id TEXT,
      directory_name TEXT,
      active_session_id TEXT,
      workspace_path TEXT,
      updated_at TEXT,
      state TEXT,
      derived_status TEXT,
      pinned_at TEXT,
      initialization_parent_branch TEXT,
      intended_target_branch TEXT
    );
  `);
  return db;
}

function runLauncherEval(
  script: string,
  env: Record<string, string>
): unknown {
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "-e", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: "utf8",
    }
  );
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return JSON.parse(lines[lines.length - 1] ?? "null");
}
