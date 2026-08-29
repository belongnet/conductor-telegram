import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    assert.equal(result.review.model, "gpt-5.5");
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
    writeFileSync(fakeClaude, `#!/bin/sh\nif [ "$1" = "auth" ]; then\n  printf '{"loggedIn":true}\\n'\n  exit 0\nfi\nprintf '%s\\n' "$@" > "${argsOut}"\nexit 0\n`);
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
      `#!/bin/sh\nif [ "$1" = "auth" ]; then\n  printf '{"loggedIn":true}\\n'\n  exit 0\nfi\necho "No conversation found with session ID: claude-real-1" >&2\nexit 1\n`
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

test("claude auth preflight fails before any customized prompt process starts", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-claude-auth-preflight-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const workspaceRoot = path.join(dir, "workspaces");
    const workspaceDir = path.join(workspaceRoot, "repo", "local-ws");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      path.join(workspaceDir, "CLAUDE.md"),
      "This repo instruction must remain available to authenticated launches.\n"
    );

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

    const promptStarted = path.join(dir, "prompt-started");
    const fakeClaude = path.join(dir, "fake-claude.sh");
    writeFileSync(
      fakeClaude,
      `#!/bin/sh\nif [ "$1" = "auth" ]; then\n  printf '{"loggedIn":false}\\n'\n  exit 1\nfi\ntouch "${promptStarted}"\nexit 1\n`
    );
    chmodSync(fakeClaude, 0o755);

    const result = runLauncherEval(
      `
        import { sendToSession } from "./src/bot/launcher.ts";
        const sendResult = await sendToSession("local-ws", "do not start", [], { repoPath: "/tmp/repo" });
        if (!("ok" in sendResult)) {
          console.log(JSON.stringify(sendResult));
          process.exit(0);
        }
        console.log(JSON.stringify(await sendResult.done));
      `,
      {
        CONDUCTOR_DB_PATH: dbPath,
        CONDUCTOR_WORKSPACES_DIR: workspaceRoot,
        CLAUDE_BIN: fakeClaude,
        DB_PATH: path.join(dir, "bot.db"),
      }
    ) as {
      isError: boolean;
      authenticationFailure?: boolean;
      hadMeaningfulActivity?: boolean;
    };

    assert.equal(result.isError, true);
    assert.equal(result.authenticationFailure, true);
    assert.equal(result.hadMeaningfulActivity, false);
    assert.equal(existsSync(promptStarted), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending Claude auth preflight is visible, duplicate-fenced, and Stop-cancelable", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-claude-auth-pending-"));
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

    const authGate = path.join(dir, "release-auth");
    const promptStarted = path.join(dir, "prompt-started");
    const fakeClaude = path.join(dir, "fake-claude.sh");
    writeFileSync(
      fakeClaude,
      `#!/bin/sh
if [ "$1" = "auth" ]; then
  while [ ! -f "${authGate}" ]; do sleep 0.01; done
  printf '{"loggedIn":true}\\n'
  exit 0
fi
touch "${promptStarted}"
exit 0
`
    );
    chmodSync(fakeClaude, 0o755);

    const result = runLauncherEval(
      `
        import Database from "better-sqlite3";
        import { writeFileSync, existsSync } from "node:fs";
        import { sendToSession, stopAgent } from "./src/bot/launcher.ts";
        const first = await sendToSession("local-ws", "first", [], { repoPath: "/tmp/repo" });
        const statusDb = new Database(process.env.CONDUCTOR_DB_PATH);
        const pendingStatus = statusDb.prepare("SELECT status FROM sessions WHERE id = ?").get("conductor-session-1").status;
        statusDb.close();
        const duplicate = await sendToSession("local-ws", "second", [], { repoPath: "/tmp/repo" });
        const stopped = stopAgent("local-ws", "/tmp/repo");
        const stoppedDb = new Database(process.env.CONDUCTOR_DB_PATH);
        const stoppedStatus = stoppedDb.prepare("SELECT status FROM sessions WHERE id = ?").get("conductor-session-1").status;
        stoppedDb.close();
        writeFileSync(${JSON.stringify(authGate)}, "release");
        const agentResult = "ok" in first ? await first.done : first;
        const finalDb = new Database(process.env.CONDUCTOR_DB_PATH);
        const finalStatus = finalDb.prepare("SELECT status FROM sessions WHERE id = ?").get("conductor-session-1").status;
        finalDb.close();
        console.log(JSON.stringify({
          firstOk: "ok" in first,
          pendingStatus,
          duplicate,
          stopped,
          stoppedStatus,
          agentResult,
          finalStatus,
          promptStarted: existsSync(${JSON.stringify(promptStarted)}),
        }));
      `,
      {
        CONDUCTOR_DB_PATH: dbPath,
        CONDUCTOR_WORKSPACES_DIR: workspaceRoot,
        CLAUDE_BIN: fakeClaude,
        DB_PATH: path.join(dir, "bot.db"),
      }
    ) as {
      firstOk: boolean;
      pendingStatus: string;
      duplicate: { error?: string; ok?: boolean };
      stopped: boolean;
      stoppedStatus: string;
      agentResult: { isError?: boolean; hadMeaningfulActivity?: boolean };
      finalStatus: string;
      promptStarted: boolean;
    };

    assert.equal(result.firstOk, true);
    assert.equal(result.pendingStatus, "working");
    assert.match(result.duplicate.error ?? "", /still starting/i);
    assert.equal(result.duplicate.ok, undefined);
    assert.equal(result.stopped, true);
    assert.equal(result.stoppedStatus, "idle");
    assert.equal(result.agentResult.isError, false);
    assert.equal(result.agentResult.hadMeaningfulActivity, false);
    assert.equal(result.finalStatus, "idle");
    assert.equal(result.promptStarted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude spawn classifies the attached weekly-limit banner before activity", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-claude-weekly-limit-"));
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

    const argsLog = path.join(dir, "args.log");
    const hookMarker = path.join(dir, "hook-ran");
    const fakeClaude = path.join(dir, "fake-claude.sh");
    writeFileSync(
      fakeClaude,
      `#!/bin/sh
if [ "$1" = "auth" ]; then
  printf '{"loggedIn":true}\\n'
  exit 0
fi
previous=""
for argument in "$@"; do
  if [ "$previous" = "--setting-sources" ]; then
    printf 'setting=%s\\n' "$argument" >> "${argsLog}"
    if [ -n "$argument" ]; then touch "${hookMarker}"; fi
  fi
  if [ "$argument" = "--strict-mcp-config" ]; then printf 'strict-mcp\\n' >> "${argsLog}"; fi
  if [ "$argument" = "--safe-mode" ]; then printf 'safe-mode\\n' >> "${argsLog}"; fi
  previous="$argument"
done
printf '%s\\n' '{"type":"result","is_error":true,"result":"You'"'"'ve hit your weekly limit · resets Aug 28 at 7am (America/New_York)","num_turns":0}'
exit 1
`
    );
    chmodSync(fakeClaude, 0o755);

    const result = runLauncherEval(
      `
        import { sendToSession } from "./src/bot/launcher.ts";
        const sent = await sendToSession("local-ws", "do not replay twice", [], { repoPath: "/tmp/repo" });
        console.log(JSON.stringify("ok" in sent ? await sent.done : sent));
      `,
      {
        CONDUCTOR_DB_PATH: dbPath,
        CONDUCTOR_WORKSPACES_DIR: workspaceRoot,
        CLAUDE_BIN: fakeClaude,
        DB_PATH: path.join(dir, "bot.db"),
      }
    ) as {
      isError: boolean;
      resultText?: string;
      authenticationFailure?: boolean;
      hadMeaningfulActivity?: boolean;
    };

    assert.equal(result.isError, true);
    assert.equal(result.authenticationFailure, true);
    assert.equal(result.hadMeaningfulActivity, false);
    assert.match(result.resultText ?? "", /weekly limit/);
    const args = readFileSync(argsLog, "utf8");
    assert.match(args, /setting=\n/);
    assert.match(args, /strict-mcp/);
    assert.doesNotMatch(args, /safe-mode/);
    assert.equal(existsSync(hookMarker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unavailable Claude auth preflight falls through to the controlled launch", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-claude-auth-unsupported-"));
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
    const promptStarted = path.join(dir, "prompt-started");
    const fakeClaude = path.join(dir, "fake-claude.sh");
    writeFileSync(
      fakeClaude,
      `#!/bin/sh
if [ "$1" = "auth" ]; then
  echo 'unknown command: auth' >&2
  exit 2
fi
touch "${promptStarted}"
printf '%s\\n' '{"type":"result","is_error":false,"result":"completed","num_turns":0}'
exit 0
`
    );
    chmodSync(fakeClaude, 0o755);

    const result = runLauncherEval(
      `
        import { sendToSession } from "./src/bot/launcher.ts";
        const sent = await sendToSession("local-ws", "continue", [], { repoPath: "/tmp/repo" });
        console.log(JSON.stringify("ok" in sent ? await sent.done : sent));
      `,
      {
        CONDUCTOR_DB_PATH: dbPath,
        CONDUCTOR_WORKSPACES_DIR: workspaceRoot,
        CLAUDE_BIN: fakeClaude,
        DB_PATH: path.join(dir, "bot.db"),
      }
    ) as { isError: boolean; authenticationFailure?: boolean };

    assert.equal(existsSync(promptStarted), true);
    assert.equal(result.isError, false);
    assert.notEqual(result.authenticationFailure, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cloud steering uses the official API and never writes Conductor message rows", () => {
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
        const calls = [];
        globalThis.fetch = async (url, init = {}) => {
          const target = String(url);
          const pathname = new URL(target).pathname;
          const method = String(init.method ?? "GET").toUpperCase();
          calls.push({
            url: target,
            pathname,
            method,
            body: init.body ? JSON.parse(String(init.body)) : null,
          });
          if (pathname === "/v0/sessions/session-1/status") {
            return new Response(
              JSON.stringify({
                workspaceId: "ws-1",
                sessionId: "session-1",
                status: "idle",
                updatedAt: "2026-07-28T12:00:00.000Z",
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            );
          }
          if (pathname === "/v0/sessions/session-1") {
            return new Response(
              JSON.stringify({
                id: "session-1",
                deepLink: "conductor://workspace/ws-1/session/session-1",
                name: "Active thread",
                model: "opus",
                resolvedModel: "opus",
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            );
          }
          if (
            pathname === "/v0/sessions/session-1/messages" &&
            method === "GET"
          ) {
            return new Response(
              JSON.stringify({
                data: [{
                  id: "message-existing",
                  sessionId: "session-1",
                  sessionIndex: 10,
                  type: "assistant",
                  content: { role: "assistant", text: "Ready" },
                  receivedAt: "2026-07-28T11:59:00.000Z",
                }],
                offset: 0,
                hasMore: false,
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            );
          }
          if (pathname === "/v0/sessions/session-2/status") {
            return new Response(
              JSON.stringify({
                workspaceId: "ws-1",
                sessionId: "session-2",
                status: "idle",
                updatedAt: "2026-07-28T12:00:00.000Z",
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            );
          }
          if (pathname === "/v0/sessions") {
            return new Response(
              JSON.stringify({
                id: "session-2",
                deepLink: "conductor://workspace/ws-1/session/session-2",
                name: "Cloud thread",
                model: "sonnet-4-6-1m",
                resolvedModel: "sonnet-4-6-1m",
              }),
              { status: 201, headers: { "content-type": "application/json" } }
            );
          }
          const body = init.body ? JSON.parse(String(init.body)) : null;
          return new Response(
            JSON.stringify({ messageId: body?.messageId, state: "queued" }),
            { status: 201, headers: { "content-type": "application/json" } }
          );
        };
        import { launchWorkspaceSession, sendToSession } from "./src/bot/launcher.ts";
        const sendResult = await sendToSession("honolulu", "", ["${attachment}"], { repoPath: "/tmp/repo" });
        const launchResult = await launchWorkspaceSession("honolulu", "Start a cloud thread", {
          repoPath: "/tmp/repo",
          agentType: "claude",
          model: "claude-sonnet-4-6-1m",
          title: "Cloud thread",
        });
        const reviewResult = await launchWorkspaceSession("honolulu", "Review this", {
          repoPath: "/tmp/repo",
          launchMode: "review",
        });
        console.log(JSON.stringify({ sendResult, launchResult, reviewResult, calls }));
      `,
      {
        CONDUCTOR_DB_PATH: dbPath,
        DB_PATH: path.join(dir, "bot.db"),
        CONDUCTOR_API_BASE_URL: "https://api.conductor.test",
        CONDUCTOR_API_KEY: "test-key",
        CONDUCTOR_CLOUD_BACKEND: "api",
      }
    ) as {
      sendResult: { ok?: boolean; error?: string; warning?: string };
      launchResult: {
        sessionId?: string;
        backendKind?: string;
        initialCursorMessageId?: string;
        error?: string;
      };
      reviewResult: { error?: string; reason?: string };
      calls: Array<{
        url: string;
        pathname: string;
        method: string;
        body: { message?: string; messageId?: string; model?: string };
      }>;
    };

    assert.equal(
      result.sendResult.ok,
      true,
      `steer failed: ${result.sendResult.error}`
    );
    assert.match(result.sendResult.warning ?? "", /couldn't be delivered/);
    const steeringCall = result.calls.find(
      (call) =>
        call.pathname === "/v0/sessions/session-1/messages" &&
        call.method === "POST"
    );
    assert.equal(
      steeringCall?.url,
      "https://api.conductor.test/v0/sessions/session-1/messages"
    );
    assert.match(
      steeringCall?.body.message ?? "",
      /could not be delivered/
    );
    assert.equal(result.launchResult.sessionId, "session-2");
    assert.equal(result.launchResult.backendKind, "cloud-api");
    const launchMessageCall = result.calls.find(
      (call) =>
        call.pathname === "/v0/sessions/session-2/messages" &&
        call.method === "POST"
    );
    assert.equal(
      result.launchResult.initialCursorMessageId,
      launchMessageCall?.body.messageId
    );
    const createSessionCall = result.calls.find(
      (call) =>
        call.pathname === "/v0/sessions" &&
        call.method === "POST"
    );
    assert.equal(
      createSessionCall?.url,
      "https://api.conductor.test/v0/sessions"
    );
    assert.equal(createSessionCall?.body.model, "sonnet-4-6-1m");
    assert.equal(
      launchMessageCall?.url,
      "https://api.conductor.test/v0/sessions/session-2/messages"
    );
    assert.equal(result.reviewResult.reason, "cloud_policy_unsupported");
    assert.match(result.reviewResult.error ?? "", /permission-policy enforcement/);
    assert.equal(result.calls.length, 8);

    const verifyDb = new Database(dbPath);
    const queuedRows = verifyDb
      .prepare("SELECT COUNT(*) as count FROM session_messages")
      .get() as { count: number };
    verifyDb.close();
    assert.equal(queuedRows.count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("observe-only cloud mirroring never stores SQLite ids as API cursors", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-cloud-mirror-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const db = createConductorDb(dbPath);
    db.exec(`
      CREATE TABLE session_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        role TEXT,
        content TEXT,
        created_at TEXT,
        sent_at TEXT
      );
    `);
    db.prepare(
      `INSERT INTO session_messages
       (id, session_id, role, content, created_at, sent_at)
       VALUES
       ('sqlite-message-1', 'session-1', 'assistant', 'first', datetime('now'), datetime('now')),
       ('sqlite-message-2', 'session-1', 'assistant', 'second', datetime('now'), datetime('now'))`
    ).run();
    db.close();

    const result = runLauncherEval(
      `
        import {
          getMaxSessionMessageCursor,
          getSessionMessagesAfter,
        } from "./src/bot/launcher.ts";
        const baseline = await getMaxSessionMessageCursor(
          "session-1",
          "cloud-api"
        );
        const messages = await getSessionMessagesAfter(
          "session-1",
          1,
          25,
          { backendKind: "cloud-api", afterMessageId: null }
        );
        console.log(JSON.stringify({ baseline, messages }));
      `,
      {
        CONDUCTOR_DB_PATH: dbPath,
        CONDUCTOR_CLOUD_BACKEND: "off",
        DB_PATH: path.join(dir, "bot.db"),
      }
    ) as {
      baseline: { rowid: number; messageId: string | null };
      messages: Array<{ rowid: number; messageId: string | null; content: string }>;
    };

    assert.equal(result.baseline.rowid, 2);
    assert.equal(result.baseline.messageId, null);
    assert.deepEqual(
      result.messages.map((message) => ({
        rowid: message.rowid,
        messageId: message.messageId,
        content: message.content,
      })),
      [{ rowid: 2, messageId: null, content: "second" }]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted cloud bindings survive without the Conductor desktop database", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-cloud-restart-"));
  try {
    const result = runLauncherEval(
      `
        const calls = [];
        globalThis.fetch = async (url, init = {}) => {
          const pathname = new URL(String(url)).pathname;
          calls.push(pathname);
          const json = (value, status = 200) =>
            new Response(JSON.stringify(value), {
              status,
              headers: { "content-type": "application/json" },
            });
          if (pathname === "/v0/workspaces/workspace-api/status") {
            return json({
              workspaceId: "workspace-api",
              status: "ready",
              updatedAt: "2026-07-28T12:00:00.000Z",
            });
          }
          if (pathname === "/v0/workspaces/workspace-api") {
            return json({
              id: "workspace-api",
              name: "Cloud after restart",
              createdAt: "2026-07-28T11:00:00.000Z",
              deepLink: "conductor://workspace/workspace-api",
            });
          }
          if (pathname === "/v0/sessions/session-api/status") {
            return json({
              workspaceId: "workspace-api",
              sessionId: "session-api",
              status: "idle",
              updatedAt: "2026-07-28T12:00:00.000Z",
            });
          }
          if (pathname === "/v0/sessions/session-api") {
            return json({
              id: "session-api",
              deepLink: "conductor://workspace/workspace-api/session/session-api",
              name: "Recovered thread",
              model: "gpt-5.5",
              resolvedModel: "gpt-5.5",
              archivedAt: null,
            });
          }
          if (pathname === "/v0/sessions/session-api/messages") {
            if (String(init.method ?? "GET").toUpperCase() === "GET") {
              return json({
                data: [{
                  id: "message-existing",
                  sessionId: "session-api",
                  sessionIndex: 4,
                  type: "assistant",
                  content: { role: "assistant", text: "Ready" },
                  receivedAt: "2026-07-28T11:59:00.000Z",
                }],
                offset: 0,
                hasMore: false,
              });
            }
            const body = init.body ? JSON.parse(String(init.body)) : {};
            return json({ messageId: body.messageId, state: "queued" }, 201);
          }
          return json({ userMessage: "not found" }, 404);
        };
        import {
          getCloudWorkspaceSessionInfo,
          getWorkspaceSessionInfo,
          sendToSession,
        } from "./src/bot/launcher.ts";
        const binding = {
          conductorWorkspaceId: "workspace-api",
          conductorSessionId: "session-api",
          conductorBackendKind: "cloud-api",
          repoPath: "/tmp/repo",
          status: "running",
        };
        const fallback = getWorkspaceSessionInfo(
          "cloud-restart",
          "/tmp/repo",
          binding
        );
        const live = await getCloudWorkspaceSessionInfo(
          "cloud-restart",
          "/tmp/repo",
          binding
        );
        const sent = await sendToSession(
          "cloud-restart",
          "Continue after restart",
          [],
          { repoPath: "/tmp/repo", binding }
        );
        console.log(JSON.stringify({ fallback, live, sent, calls }));
      `,
      {
        CONDUCTOR_DB_PATH: path.join(dir, "missing-conductor.db"),
        CONDUCTOR_SETTINGS_PATH: path.join(dir, "missing-settings.toml"),
        DB_PATH: path.join(dir, "bot.db"),
        CONDUCTOR_API_BASE_URL: "https://api.conductor.test",
        CONDUCTOR_API_KEY: "test-key",
        CONDUCTOR_CLOUD_BACKEND: "api",
      }
    ) as {
      fallback: {
        workspaceId: string;
        sessionId: string;
        sandboxProvider: string;
      };
      live: {
        displayName: string;
        status: string;
        model: string;
        agentType: string;
      };
      sent: { ok?: boolean; error?: string };
      calls: string[];
    };

    assert.equal(result.fallback.workspaceId, "workspace-api");
    assert.equal(result.fallback.sessionId, "session-api");
    assert.equal(result.fallback.sandboxProvider, "conductor-api");
    assert.equal(result.live.displayName, "Cloud after restart");
    assert.equal(result.live.status, "idle");
    assert.equal(result.live.model, "gpt-5.5");
    assert.equal(result.live.agentType, "codex");
    assert.equal(result.sent.ok, true, result.sent.error);
    assert.ok(result.calls.includes("/v0/workspaces/workspace-api"));
    assert.ok(result.calls.includes("/v0/sessions/session-api/messages"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createConductorDb(dbPath: string): Database.Database {
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
