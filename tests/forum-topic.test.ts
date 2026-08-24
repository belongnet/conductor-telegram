import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRepoTopicName,
  buildTopicName,
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
