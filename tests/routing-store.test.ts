import test from "node:test";
import assert from "node:assert/strict";
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
  getWorkspaceMessageTarget,
  linkTelegramMessage,
  recordRouteAttempt,
  touchRepoTopic,
  updateThreadCursor,
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

    updateThreadCursor(workspace.id, "session-a", 41, "Build");
    updateThreadCursor(workspace.id, "session-b", 7, "Review");

    assert.equal(
      getThreadCursor(workspace.id, "session-a")?.lastForwardedRowid,
      41
    );
    assert.equal(getThreadCursor(workspace.id, "session-b")?.title, "Review");

    linkTelegramMessage("chat-1", "100", workspace.id, "session-b");

    const target = getWorkspaceMessageTarget("chat-1", "100");
    assert.equal(target?.workspace.id, workspace.id);
    assert.equal(target?.sessionId, "session-b");
  });
});
