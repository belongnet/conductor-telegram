import test from "node:test";
import assert from "node:assert/strict";
import { syncWorkspaceTopic } from "../src/bot/forum.js";
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
    conductorSessionId: null,
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
