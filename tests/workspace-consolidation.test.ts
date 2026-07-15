import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { closeDb, getDb } from "../src/store/db.js";
import {
  formatAttachmentReference,
  inferAgentTypeFromModel,
  isConductorWorkspaceVisible,
  simplifyModel,
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
  assert.equal(inferAgentTypeFromModel("gpt-5.6-sol"), "codex");
  assert.equal(inferAgentTypeFromModel("o4-mini"), "codex");
  assert.equal(inferAgentTypeFromModel("opus-1m"), "claude");
  assert.equal(inferAgentTypeFromModel("claude-sonnet-4-5"), "claude");
  assert.equal(inferAgentTypeFromModel("fable-5"), "claude");
  assert.equal(inferAgentTypeFromModel("claude-fable-5"), "claude");
  assert.equal(inferAgentTypeFromModel("custom-router-model"), null);
});

test("simplifyModel collapses model ids to their display family", () => {
  assert.equal(simplifyModel("claude-fable-5"), "fable");
  assert.equal(simplifyModel("fable-5"), "fable");
  assert.equal(simplifyModel("claude-opus-4-8"), "opus");
  assert.equal(simplifyModel("custom-router-model"), "custom-router-model");
  assert.equal(simplifyModel(null), null);
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
        // Pre-0.72 Conductor: no settings.toml, DB rows are live.
        CONDUCTOR_SETTINGS_PATH: path.join(dir, "no-settings.toml"),
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

test("forced Claude launch skips an incompatible live Conductor model setting", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-claude-model-skip-"));
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
        // Pre-0.72 Conductor: no settings.toml, DB rows are live.
        CONDUCTOR_SETTINGS_PATH: path.join(dir, "no-settings.toml"),
        TELEGRAM_DEFAULT_AGENT_TYPE: "claude",
        TELEGRAM_DEFAULT_MODEL: "",
      }
    ) as { agentType: string; model: string };

    assert.equal(result.agentType, "claude");
    assert.equal(result.model, "claude-fable-5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deprecated Conductor settings and session history don't override shipped defaults", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-stale-model-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const db = createConductorDb(dbPath);
    // Conductor 0.72 migration freezes settings rows with a deprecated_at stamp.
    db.exec("ALTER TABLE settings ADD COLUMN deprecated_at TEXT");
    db.prepare(
      "INSERT INTO settings (key, value, deprecated_at) VALUES ('default_model', 'gpt-5.5', '2026-06-06 11:03:39')"
    ).run();
    db.prepare(
      "INSERT INTO settings (key, value, deprecated_at) VALUES ('review_model', 'opus-4-8-1m', '2026-06-06 11:03:39')"
    ).run();
    // Stale history left behind by the bot's own earlier launches.
    db.prepare(
      `INSERT INTO sessions (id, status, created_at, updated_at, workspace_id, model, agent_type)
       VALUES ('old-claude', 'idle', '2026-07-01 10:00:00', '2026-07-01 10:00:00', 'ws-1', 'opus', 'claude')`
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, status, created_at, updated_at, workspace_id, model, agent_type)
       VALUES ('old-codex', 'idle', '2026-07-02 10:00:00', '2026-07-02 10:00:00', 'ws-1', 'gpt-5.4', 'codex')`
    ).run();
    db.close();

    // settings.toml as Conductor 0.72+ writes it: sections present, no model values.
    const tomlPath = path.join(dir, "settings.toml");
    writeFileSync(tomlPath, "[models]\n[models.claude_code]\n[models.codex]\n");

    const result = runLauncherEval(
      `
        import { resolveLaunchConfig } from "./src/bot/launcher.ts";
        console.log(JSON.stringify({
          prompt: resolveLaunchConfig({}),
          review: resolveLaunchConfig({ launchMode: "review" }),
        }));
      `,
      {
        CONDUCTOR_DB_PATH: dbPath,
        CONDUCTOR_SETTINGS_PATH: tomlPath,
        TELEGRAM_DEFAULT_AGENT_TYPE: "",
        TELEGRAM_DEFAULT_MODEL: "",
        TELEGRAM_REVIEW_AGENT_TYPE: "",
        TELEGRAM_REVIEW_MODEL: "",
      }
    ) as {
      prompt: { agentType: string; model: string };
      review: { agentType: string; model: string };
    };

    assert.equal(result.prompt.agentType, "claude");
    assert.equal(result.prompt.model, "claude-fable-5");
    assert.equal(result.review.agentType, "codex");
    assert.equal(result.review.model, "gpt-5.6-sol");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unstamped Conductor 0.72 DB settings remain live fallbacks", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-live-model-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const db = createConductorDb(dbPath);
    db.exec("ALTER TABLE settings ADD COLUMN deprecated_at TEXT");
    db.prepare(
      "INSERT INTO settings (key, value, deprecated_at) VALUES ('default_model', 'gpt-5.5', NULL)"
    ).run();
    db.close();

    const tomlPath = path.join(dir, "settings.toml");
    writeFileSync(tomlPath, "[models]\n");

    const result = runLauncherEval(
      `
        import { resolveLaunchConfig } from "./src/bot/launcher.ts";
        console.log(JSON.stringify(resolveLaunchConfig({})));
      `,
      {
        CONDUCTOR_DB_PATH: dbPath,
        CONDUCTOR_SETTINGS_PATH: tomlPath,
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

test("Conductor workspace lookup matches workspace_name and detects cloud workspaces", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-conductor-cloud-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const db = createConductorDb(dbPath);
    db.prepare(
      `INSERT INTO repos (id, root_path, name, default_branch)
       VALUES ('repo-1', '/tmp/repo', 'repo', 'main')`
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, status, updated_at, workspace_id, is_hidden, model, agent_type)
       VALUES ('session-1', 'idle', datetime('now'), 'ws-1', 0, 'gpt-5.5', 'codex')`
    ).run();
    db.prepare(
      `INSERT INTO workspaces
        (id, repository_id, directory_name, workspace_name, active_session_id,
         updated_at, state, derived_status, pinned_at, initialization_parent_branch,
         intended_target_branch, hosting_server_url, sandbox_provider, remote_file_sync_enabled)
       VALUES
        ('ws-1', 'repo-1', 'cloud-dir', 'Cloud Friendly', 'session-1',
         '2026-05-19 00:00:00', 'ready', 'in-progress', NULL, 'main',
         'main', 'https://sandbox.example', 'vercel', 1)`
    ).run();
    db.close();

    const result = runLauncherEval(
      `
        import { getWorkspaceSessionInfo, isRemoteConductorWorkspace } from "./src/bot/launcher.ts";
        const info = getWorkspaceSessionInfo("Cloud Friendly", "/tmp/repo");
        console.log(JSON.stringify({
          displayName: info?.displayName,
          directoryName: info?.directoryName,
          remote: info ? isRemoteConductorWorkspace(info) : false,
          remoteFileSyncEnabled: info?.remoteFileSyncEnabled
        }));
      `,
      { CONDUCTOR_DB_PATH: dbPath }
    ) as {
      displayName: string;
      directoryName: string;
      remote: boolean;
      remoteFileSyncEnabled: boolean;
    };

    assert.equal(result.displayName, "Cloud Friendly");
    assert.equal(result.directoryName, "cloud-dir");
    assert.equal(result.remote, true);
    assert.equal(result.remoteFileSyncEnabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cursor sessions are observe-only from Telegram steering", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-conductor-cursor-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const db = createConductorDb(dbPath);
    db.prepare(
      `INSERT INTO repos (id, root_path, name, default_branch)
       VALUES ('repo-1', '/tmp/repo', 'repo', 'main')`
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, status, updated_at, workspace_id, is_hidden, model, agent_type)
       VALUES ('session-1', 'idle', datetime('now'), 'ws-1', 0, 'cursor-model', 'cursor')`
    ).run();
    db.prepare(
      `INSERT INTO workspaces
        (id, repository_id, directory_name, active_session_id, updated_at, state,
         derived_status, pinned_at, initialization_parent_branch, intended_target_branch)
       VALUES
        ('ws-1', 'repo-1', 'cursor-ws', 'session-1', '2026-05-19 00:00:00',
         'ready', 'in-progress', NULL, 'main', 'main')`
    ).run();
    db.close();

    const result = runLauncherEval(
      `
        import { sendToSession } from "./src/bot/launcher.ts";
        console.log(JSON.stringify(await sendToSession("cursor-ws", "hello", [], { repoPath: "/tmp/repo" })));
      `,
      { CONDUCTOR_DB_PATH: dbPath }
    ) as { reason: string };

    assert.equal(result.reason, "unsupported_agent");
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

test("claude follow-ups resume the stored claude_session_id, not the Conductor session id", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-claude-resume-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const workspaceRoot = path.join(dir, "workspaces");
    const workspaceDir = path.join(workspaceRoot, "repo", "local-ws");
    mkdirSync(workspaceDir, { recursive: true });

    const db = createConductorDb(dbPath);
    db.prepare(
      `INSERT INTO repos (id, root_path, name, default_branch)
       VALUES ('repo-1', '/tmp/repo', 'repo', 'main')`
    ).run();
    // App-created thread: the real Claude session id differs from the row id.
    db.prepare(
      `INSERT INTO sessions (id, status, claude_session_id, updated_at, workspace_id, is_hidden, model, agent_type)
       VALUES ('conductor-session-1', 'idle', 'claude-real-1', datetime('now'), 'ws-1', 0, 'opus', 'claude')`
    ).run();
    db.prepare(
      `INSERT INTO workspaces
        (id, repository_id, directory_name, active_session_id, updated_at, state, derived_status, pinned_at, initialization_parent_branch, intended_target_branch)
       VALUES
        ('ws-1', 'repo-1', 'local-ws', 'conductor-session-1', '2026-05-19 00:00:00', 'ready', 'in-progress', NULL, 'main', 'main')`
    ).run();
    db.close();

    const argsOut = path.join(dir, "claude-args.txt");
    const fakeClaude = path.join(dir, "fake-claude.sh");
    writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsOut}"\nexit 0\n`);
    chmodSync(fakeClaude, 0o755);

    const result = runLauncherEval(
      `
        import { readFileSync } from "node:fs";
        import { sendToSession } from "./src/bot/launcher.ts";
        const sendResult = await sendToSession("local-ws", "hello again", [], { repoPath: "/tmp/repo" });
        if (!("ok" in sendResult)) {
          console.log(JSON.stringify(sendResult));
          process.exit(0);
        }
        const agentResult = await sendResult.done;
        const args = readFileSync("${argsOut}", "utf8").trim().split("\\n");
        console.log(JSON.stringify({ ok: true, exitCode: agentResult.exitCode, args }));
      `,
      {
        CONDUCTOR_DB_PATH: dbPath,
        CONDUCTOR_WORKSPACES_DIR: workspaceRoot,
        CLAUDE_BIN: fakeClaude,
        DB_PATH: path.join(dir, "bot.db"),
      }
    ) as { ok?: boolean; error?: string; exitCode: number; args: string[] };

    assert.equal(result.ok, true, `send failed: ${result.error}`);
    assert.equal(result.exitCode, 0);
    const resumeIndex = result.args.indexOf("--resume");
    assert.notEqual(resumeIndex, -1, `expected --resume in ${result.args.join(" ")}`);
    assert.equal(result.args[resumeIndex + 1], "claude-real-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed claude runs surface an error result with stderr detail", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-claude-fail-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const workspaceRoot = path.join(dir, "workspaces");
    const workspaceDir = path.join(workspaceRoot, "repo", "local-ws");
    mkdirSync(workspaceDir, { recursive: true });

    const db = createConductorDb(dbPath);
    db.prepare(
      `INSERT INTO repos (id, root_path, name, default_branch)
       VALUES ('repo-1', '/tmp/repo', 'repo', 'main')`
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, status, claude_session_id, updated_at, workspace_id, is_hidden, model, agent_type)
       VALUES ('conductor-session-1', 'idle', 'claude-real-1', datetime('now'), 'ws-1', 0, 'opus', 'claude')`
    ).run();
    db.prepare(
      `INSERT INTO workspaces
        (id, repository_id, directory_name, active_session_id, updated_at, state, derived_status, pinned_at, initialization_parent_branch, intended_target_branch)
       VALUES
        ('ws-1', 'repo-1', 'local-ws', 'conductor-session-1', '2026-05-19 00:00:00', 'ready', 'in-progress', NULL, 'main', 'main')`
    ).run();
    db.close();

    const fakeClaude = path.join(dir, "fake-claude.sh");
    writeFileSync(
      fakeClaude,
      `#!/bin/sh\necho "No conversation found with session ID: claude-real-1" >&2\nexit 1\n`
    );
    chmodSync(fakeClaude, 0o755);

    const result = runLauncherEval(
      `
        import { sendToSession } from "./src/bot/launcher.ts";
        const sendResult = await sendToSession("local-ws", "hello", [], { repoPath: "/tmp/repo" });
        if (!("ok" in sendResult)) {
          console.log(JSON.stringify(sendResult));
          process.exit(0);
        }
        const agentResult = await sendResult.done;
        console.log(JSON.stringify(agentResult));
      `,
      {
        CONDUCTOR_DB_PATH: dbPath,
        CONDUCTOR_WORKSPACES_DIR: workspaceRoot,
        CLAUDE_BIN: fakeClaude,
        DB_PATH: path.join(dir, "bot.db"),
      }
    ) as { isError: boolean; exitCode: number | null; stderrTail?: string };

    assert.equal(result.isError, true);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderrTail ?? "", /No conversation found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cloud steering reports dropped attachments in the send warning", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-cloud-attach-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const db = createConductorDb(dbPath);
    db.exec(`
      CREATE TABLE session_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        role TEXT,
        content TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        sent_at TEXT,
        model TEXT,
        turn_id TEXT,
        queue_order INTEGER
      );
    `);
    db.prepare(
      `INSERT INTO repos (id, root_path, name, default_branch)
       VALUES ('repo-1', '/tmp/repo', 'repo', 'main')`
    ).run();
    // Busy cloud session: verified queue capability returns without polling.
    db.prepare(
      `INSERT INTO sessions (id, status, updated_at, workspace_id, is_hidden, model, agent_type)
       VALUES ('session-1', 'working', datetime('now'), 'ws-1', 0, 'opus', 'claude')`
    ).run();
    db.prepare(
      `INSERT INTO workspaces
        (id, repository_id, directory_name, workspace_name, active_session_id,
         updated_at, state, derived_status, pinned_at, initialization_parent_branch,
         intended_target_branch, hosting_server_url, sandbox_provider, remote_file_sync_enabled)
       VALUES
        ('ws-1', 'repo-1', 'cloud-dir', 'honolulu', 'session-1',
         '2026-05-19 00:00:00', 'ready', 'in-progress', NULL, 'main',
         'main', 'https://sandbox.example', 'vercel', 1)`
    ).run();
    db.close();

    const attachment = path.join(dir, "screenshot.jpg");
    writeFileSync(attachment, "fake-image-bytes");

    const result = runLauncherEval(
      `
        import { setMetaValue } from "./src/store/queries.ts";
        import { sendToSession } from "./src/bot/launcher.ts";
        setMetaValue("remote_steer:ws-1", "queue");
        const sendResult = await sendToSession("honolulu", "", ["${attachment}"], { repoPath: "/tmp/repo" });
        console.log(JSON.stringify(sendResult));
      `,
      {
        CONDUCTOR_DB_PATH: dbPath,
        DB_PATH: path.join(dir, "bot.db"),
      }
    ) as { ok?: boolean; error?: string; warning?: string };

    assert.equal(result.ok, true, `steer failed: ${result.error}`);
    assert.match(result.warning ?? "", /couldn't be delivered/);

    const verifyDb = new Database(dbPath);
    const queued = verifyDb
      .prepare("SELECT content FROM session_messages WHERE queue_order IS NOT NULL")
      .get() as { content: string } | undefined;
    verifyDb.close();
    assert.match(queued?.content ?? "", /could not be delivered/);
  } finally {
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
      agent_type TEXT,
      title TEXT
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      repository_id TEXT,
      directory_name TEXT,
      workspace_name TEXT,
      active_session_id TEXT,
      workspace_path TEXT,
      hosting_server_url TEXT,
      sandbox_provider TEXT,
      remote_file_sync_enabled INTEGER DEFAULT 0,
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
