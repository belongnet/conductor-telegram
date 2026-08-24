import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { closeDb, getDb } from "../src/store/db.js";
import {
  answerDecision,
  createDecision,
  deleteRepoTopic,
  createWorkspace,
  getThreadCursor,
  getPendingDecisionsForChat,
  getRepoTopic,
  getRepoTopicByThreadId,
  getRepoTopicsForChat,
  getWorkspace,
  getWorkspaceMessageTarget,
  linkTelegramMessage,
  recordRouteAttempt,
  touchRepoTopic,
  updateThreadCursor,
  updateWorkspaceConductorBinding,
  upsertRepoTopic,
} from "../src/store/queries.js";

function withTempDb(fn: () => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-routing-store-"));
  try {
    closeDb();
    getDb(path.join(dir, "bot.db"));
    fn();
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("repo topics are persisted by chat and repo path", () => {
  withTempDb(() => {
    const topic = upsertRepoTopic({
      chatId: "chat-1",
      repoPath: "/repos/conductor-telegram",
      repoName: "conductor-telegram",
      telegramThreadId: 123,
    });

    assert.equal(topic.chatId, "chat-1");
    assert.equal(topic.repoPath, "/repos/conductor-telegram");
    assert.equal(topic.telegramThreadId, 123);
    assert.equal(
      getRepoTopic("chat-1", "/repos/conductor-telegram")?.telegramThreadId,
      123
    );
    assert.equal(getRepoTopicByThreadId("chat-1", 123)?.repoName, "conductor-telegram");
    assert.deepEqual(
      getRepoTopicsForChat("chat-1").map((row) => row.repoName),
      ["conductor-telegram"]
    );

    deleteRepoTopic("chat-1", "/repos/conductor-telegram");
    assert.equal(getRepoTopic("chat-1", "/repos/conductor-telegram"), undefined);

    upsertRepoTopic({
      chatId: "chat-1",
      repoPath: "/repos/conductor-telegram",
      repoName: "conductor-telegram",
      telegramThreadId: 123,
    });

    const beforeTouch = getRepoTopic("chat-1", "/repos/conductor-telegram");
    touchRepoTopic("chat-1", "/repos/conductor-telegram");
    const afterTouch = getRepoTopic("chat-1", "/repos/conductor-telegram");
    assert.ok(beforeTouch?.lastUsedAt);
    assert.ok(afterTouch?.lastUsedAt);
    assert.ok(afterTouch.lastUsedAt >= beforeTouch.lastUsedAt);
  });
});

test("store migration adds telegram link session column before creating its index", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-routing-migration-"));
  try {
    const dbPath = path.join(dir, "bot.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE telegram_message_links (
        chat_id TEXT NOT NULL,
        telegram_message_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (chat_id, telegram_message_id)
      );
      CREATE INDEX idx_telegram_message_links_workspace
        ON telegram_message_links(workspace_id, created_at);
    `);
    legacy.close();

    closeDb();
    const db = getDb(dbPath);
    const columns = db.prepare("PRAGMA table_info(telegram_message_links)").all() as Array<{
      name: string;
    }>;
    const indexes = db.prepare("PRAGMA index_list(telegram_message_links)").all() as Array<{
      name: string;
    }>;

    assert.ok(columns.some((row) => row.name === "session_id"));
    assert.ok(indexes.some((row) => row.name === "idx_telegram_message_links_session"));
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent processes serialize legacy schema migrations", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-routing-concurrent-"));
  try {
    const dbPath = path.join(dir, "bot.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'starting',
        repo_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        telegram_chat_id TEXT NOT NULL,
        telegram_message_id TEXT,
        conductor_workspace_name TEXT,
        conductor_session_id TEXT,
        last_forwarded_message_rowid INTEGER NOT NULL DEFAULT 0,
        telegram_thread_id INTEGER,
        archived_at TEXT
      );
    `);
    legacy.close();

    const script = [
      'import { getDb, closeDb } from "./src/store/db.ts";',
      "getDb();",
      "closeDb();",
    ].join("\n");
    const runMigration = () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script],
          {
            cwd: process.cwd(),
            env: { ...process.env, DB_PATH: dbPath },
            stdio: ["ignore", "ignore", "pipe"],
          }
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr || `migration exited ${code}`));
        });
      });

    await Promise.all(Array.from({ length: 6 }, runMigration));

    const migrated = new Database(dbPath, { readonly: true });
    const columns = migrated
      .prepare("PRAGMA table_info(workspaces)")
      .all() as Array<{ name: string }>;
    migrated.close();
    assert.ok(columns.some((row) => row.name === "conductor_workspace_id"));
    assert.ok(columns.some((row) => row.name === "conductor_backend_kind"));
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("route attempts record redacted routing decisions", () => {
  withTempDb(() => {
    const id = recordRouteAttempt({
      chatId: "chat-1",
      source: "repo_topic",
      telegramThreadId: 123,
      action: "new",
      repoPath: "/repos/conductor-telegram",
      repoName: "conductor-telegram",
      status: "routed",
    });

    const row = getDb()
      .prepare("SELECT * FROM route_attempts WHERE id = ?")
      .get(id) as any;

    assert.equal(row.chat_id, "chat-1");
    assert.equal(row.source, "repo_topic");
    assert.equal(row.telegram_thread_id, 123);
    assert.equal(row.action, "new");
    assert.equal(row.repo_path, "/repos/conductor-telegram");
    assert.equal(row.repo_name, "conductor-telegram");
    assert.equal(row.workspace_id, null);
    assert.equal(row.status, "routed");
    assert.equal(row.failure_reason, null);
  });
});

test("pending decisions are scoped to unanswered decisions in the chat", () => {
  withTempDb(() => {
    const first = createWorkspace({
      name: "first",
      prompt: "one",
      repoPath: "/repos/a",
      telegramChatId: "chat-1",
    });
    const second = createWorkspace({
      name: "second",
      prompt: "two",
      repoPath: "/repos/b",
      telegramChatId: "chat-1",
    });
    const otherChat = createWorkspace({
      name: "other",
      prompt: "three",
      repoPath: "/repos/c",
      telegramChatId: "chat-2",
    });

    const answered = createDecision(first.id, "answered?", null);
    const pending = createDecision(second.id, "pending?", ["yes", "no"]);
    createDecision(otherChat.id, "other chat?", null);
    answerDecision(answered, "done");

    const rows = getPendingDecisionsForChat("chat-1");

    assert.deepEqual(rows.map((row) => row.id), [pending]);
    assert.equal(rows[0]?.question, "pending?");
    assert.equal(rows[0]?.options, JSON.stringify(["yes", "no"]));
  });
});

test("thread cursors and Telegram links preserve Conductor session targets", () => {
  withTempDb(() => {
    const workspace = createWorkspace({
      name: "threaded",
      prompt: "watch both threads",
      repoPath: "/repos/a",
      telegramChatId: "chat-1",
    });

    updateThreadCursor(
      workspace.id,
      "session-a",
      41,
      "Build",
      "api-message-41",
      "cloud-api"
    );
    updateThreadCursor(workspace.id, "session-b", 7, "Review");

    assert.equal(
      getThreadCursor(workspace.id, "session-a")?.lastForwardedRowid,
      41
    );
    assert.equal(
      getThreadCursor(workspace.id, "session-a")?.lastMessageId,
      "api-message-41"
    );
    assert.equal(getThreadCursor(workspace.id, "session-b")?.title, "Review");

    updateWorkspaceConductorBinding(workspace.id, {
      workspaceId: "cloud-workspace-1",
      sessionId: "session-a",
      backendKind: "cloud-api",
    });
    const rebound = getWorkspace(workspace.id);
    assert.equal(rebound?.conductorWorkspaceId, "cloud-workspace-1");
    assert.equal(rebound?.conductorSessionId, "session-a");
    assert.equal(rebound?.conductorBackendKind, "cloud-api");

    linkTelegramMessage("chat-1", "100", workspace.id, "session-b");

    const target = getWorkspaceMessageTarget("chat-1", "100");
    assert.equal(target?.workspace.id, workspace.id);
    assert.equal(target?.sessionId, "session-b");
  });
});

test("stale cursor updates cannot regress a forwarded transcript", () => {
  withTempDb(() => {
    const workspace = createWorkspace({
      name: "cursor-race",
      prompt: "watch",
      repoPath: "/repos/a",
      telegramChatId: "chat-1",
    });

    updateThreadCursor(workspace.id, "session-a", 900, "Local baseline");
    updateThreadCursor(
      workspace.id,
      "session-a",
      42,
      "Build",
      "api-message-42",
      "cloud-api"
    );
    updateThreadCursor(
      workspace.id,
      "session-a",
      12,
      "Stale title",
      "api-message-12",
      "cloud-api"
    );
    updateThreadCursor(workspace.id, "session-a", 1_000, "Stale local mirror");

    const cursor = getThreadCursor(workspace.id, "session-a");
    assert.equal(cursor?.lastForwardedRowid, 42);
    assert.equal(cursor?.lastMessageId, "api-message-42");
  });
});

test("a cloud cursor holding a SQLite rowid adopts the first API id it sees", () => {
  withTempDb(() => {
    const workspace = createWorkspace({
      name: "cursor-namespace",
      prompt: "watch",
      repoPath: "/repos/a",
      telegramChatId: "chat-1",
    });

    // A cloud cursor can be created before the API is reachable, baselined
    // from the local mirror. Its position is a session_messages rowid, which
    // is orders of magnitude larger than a per-session API index.
    updateThreadCursor(workspace.id, "session-a", 4210, "Recovered", null, "cloud-api");
    let cursor = getThreadCursor(workspace.id, "session-a");
    assert.equal(cursor?.lastMessageId, null);

    // Once the API answers, the real id must be adopted. Comparing 12 against
    // the stale 4210 would reject it forever and strand the transcript.
    updateThreadCursor(
      workspace.id,
      "session-a",
      12,
      "Build",
      "api-message-12",
      "cloud-api"
    );
    cursor = getThreadCursor(workspace.id, "session-a");
    assert.equal(cursor?.lastMessageId, "api-message-12");
    assert.equal(cursor?.lastForwardedRowid, 12);

    // And the namespace must stay switched, so ordinary advances still apply.
    updateThreadCursor(
      workspace.id,
      "session-a",
      13,
      "Build",
      "api-message-13",
      "cloud-api"
    );
    cursor = getThreadCursor(workspace.id, "session-a");
    assert.equal(cursor?.lastMessageId, "api-message-13");
    assert.equal(cursor?.lastForwardedRowid, 13);
  });
});

test("relabelling a cursor to cloud-api drops its local-namespace position", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-cursor-migration-"));
  const dbPath = path.join(dir, "bot.db");
  try {
    closeDb();
    getDb(dbPath);
    const workspace = createWorkspace({
      name: "cursor-migration",
      prompt: "watch",
      repoPath: "/repos/a",
      telegramChatId: "chat-1",
    });
    updateThreadCursor(workspace.id, "session-a", 4210, "Local baseline");
    updateWorkspaceConductorBinding(workspace.id, {
      workspaceId: "cw-1",
      sessionId: "session-a",
      backendKind: "cloud-api",
    });
    closeDb();

    // Reopening runs the migration that relabels the cursor.
    getDb(dbPath);
    const cursor = getThreadCursor(workspace.id, "session-a");
    assert.equal(cursor?.backendKind, "cloud-api");
    assert.equal(cursor?.lastForwardedRowid, 0);
    assert.equal(cursor?.lastMessageId, null);

    // Re-running must not disturb a cursor that has since been anchored.
    updateThreadCursor(
      workspace.id,
      "session-a",
      7,
      "Build",
      "api-message-7",
      "cloud-api"
    );
    closeDb();
    getDb(dbPath);
    const anchored = getThreadCursor(workspace.id, "session-a");
    assert.equal(anchored?.lastForwardedRowid, 7);
    assert.equal(anchored?.lastMessageId, "api-message-7");
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
