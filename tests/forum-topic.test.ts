import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRepoTopicName,
  buildTopicName,
  finalizeWorkspaceTopic,
  finalizeWorkspaceTopicForCloudNotices,
  syncWorkspaceTopic,
} from "../src/bot/forum.js";
import type { Workspace, WorkspaceStatus } from "../src/types/index.js";

function sampleWorkspace(status: WorkspaceStatus): Workspace {
  return {
    id: `ws-${status}`,
    name: "local-name",
    prompt: "do work",
    status,
    repoPath: "/repos/conductor-telegram",
    createdAt: "2026-07-15T00:00:00.000Z",
    telegramChatId: "chat-1",
    telegramMessageId: null,
    conductorWorkspaceName: "durban",
    conductorWorkspaceId: null,
    conductorSessionId: null,
    conductorBackendKind: null,
    lastForwardedMessageRowid: 0,
    telegramThreadId: 123,
    archivedAt: null,
  };
}

test("terminal workspace topics use the folder icon", async () => {
  const edits: Array<{ icon_custom_emoji_id?: string; name?: string }> = [];
  const telegram = {
    getForumTopicIconStickers: async () => [
      { emoji: "📁", custom_emoji_id: "folder-icon" },
      { emoji: "⚡️", custom_emoji_id: "active-icon" },
    ],
    editForumTopic: async (_chatId: string, _threadId: number, extra: any) => {
      edits.push(extra);
    },
  };

  for (const status of ["done", "stopped", "archived"] as const) {
    await syncWorkspaceTopic(telegram as any, sampleWorkspace(status));
  }

  assert.deepEqual(
    edits.map((edit) => edit.icon_custom_emoji_id),
    ["folder-icon", "folder-icon", "folder-icon"]
  );
});

test("terminal workspace topic finalization syncs and closes the topic", async () => {
  const actions: string[] = [];
  const telegram = {
    getForumTopicIconStickers: async () => [
      { emoji: "📁", custom_emoji_id: "folder-icon" },
    ],
    editForumTopic: async () => {
      actions.push("sync");
    },
    closeForumTopic: async () => {
      actions.push("close");
    },
  };

  await finalizeWorkspaceTopic(
    telegram as any,
    sampleWorkspace("stopped")
  );

  assert.deepEqual(actions, ["sync", "close"]);
});

test("terminal workspace topic finalization still closes after a sync error", async () => {
  let closed = false;
  const telegram = {
    getForumTopicIconStickers: async () => [
      { emoji: "📁", custom_emoji_id: "folder-icon" },
    ],
    editForumTopic: async () => {
      throw new Error("topic sync unavailable");
    },
    closeForumTopic: async () => {
      closed = true;
    },
  };

  await assert.rejects(
    finalizeWorkspaceTopic(
      telegram as any,
      sampleWorkspace("archived")
    ),
    /topic sync unavailable/
  );
  assert.equal(closed, true);
});

test("durable terminal notices finalize topics before they can be acknowledged", async () => {
  const actions: string[] = [];
  const telegram = {
    getForumTopicIconStickers: async () => [
      { emoji: "📁", custom_emoji_id: "folder-icon" },
    ],
    editForumTopic: async () => {
      actions.push("sync");
    },
    closeForumTopic: async () => {
      actions.push("close");
    },
  };

  await finalizeWorkspaceTopicForCloudNotices(
    telegram as any,
    sampleWorkspace("stopped"),
    ["messages_sent"]
  );
  assert.deepEqual(actions, []);

  await finalizeWorkspaceTopicForCloudNotices(
    telegram as any,
    sampleWorkspace("stopped"),
    ["launch_canceled"]
  );
  assert.deepEqual(actions, ["sync", "close"]);
});

test("durable terminal finalization surfaces retryable Telegram failures", async () => {
  const workspace = sampleWorkspace("stopped");
  const telegram = {
    getForumTopicIconStickers: async () => [
      { emoji: "📁", custom_emoji_id: "folder-icon" },
    ],
    editForumTopic: async () => undefined,
    closeForumTopic: async () => {
      throw new Error("Telegram unavailable");
    },
  };
  await assert.rejects(
    finalizeWorkspaceTopicForCloudNotices(
      telegram as any,
      workspace,
      ["stop_confirmed"]
    ),
    /Telegram unavailable/
  );

  telegram.closeForumTopic = async () => {
    throw new Error("Bad Request: TOPIC_CLOSED");
  };
  await finalizeWorkspaceTopicForCloudNotices(
    telegram as any,
    workspace,
    ["archive_confirmed"]
  );
});

test("durable terminal finalization leaves the topic open after a sync failure", async () => {
  let closeCalls = 0;
  const telegram = {
    getForumTopicIconStickers: async () => [
      { emoji: "📁", custom_emoji_id: "folder-icon" },
    ],
    editForumTopic: async () => {
      throw new Error("topic sync unavailable");
    },
    closeForumTopic: async () => {
      closeCalls += 1;
    },
  };

  await assert.rejects(
    finalizeWorkspaceTopicForCloudNotices(
      telegram as any,
      sampleWorkspace("stopped"),
      ["stop_confirmed"]
    ),
    /topic sync unavailable/
  );
  assert.equal(closeCalls, 0);
});

test("durable terminal finalization never recreates a deleted topic", async () => {
  let closeCalls = 0;
  let createCalls = 0;
  const telegram = {
    getForumTopicIconStickers: async () => [
      { emoji: "📁", custom_emoji_id: "folder-icon" },
    ],
    editForumTopic: async () => {
      throw new Error("Bad Request: message_thread_not_found");
    },
    closeForumTopic: async () => {
      closeCalls += 1;
    },
    createForumTopic: async () => {
      createCalls += 1;
      return { message_thread_id: 999 };
    },
  };

  await finalizeWorkspaceTopicForCloudNotices(
    telegram as any,
    sampleWorkspace("stopped"),
    ["stop_confirmed"]
  );
  assert.equal(createCalls, 0);
  assert.equal(closeCalls, 0);
});

test("topic names clamp to Telegram's 128-character limit", () => {
  // Short names pass through untouched.
  assert.equal(buildTopicName("repo", "quiet-city"), "quiet-city · repo");

  // A combined name over the limit clamps to exactly 128 with an ellipsis,
  // keeping the workspace-name prefix that identifies the topic.
  const clamped = buildTopicName("r".repeat(200), "workspace");
  assert.equal(clamped.length, 128);
  assert.ok(clamped.endsWith("…"));
  assert.ok(clamped.startsWith("workspace · "));

  // Exactly at the limit is legal and must not be shortened.
  const exact = "x".repeat(128);
  assert.equal(buildRepoTopicName(exact), exact);
  const over = buildRepoTopicName("x".repeat(129));
  assert.equal(over.length, 128);
  assert.ok(over.endsWith("…"));
});
