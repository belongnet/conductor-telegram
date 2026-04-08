import path from "node:path";
import type { Telegram } from "telegraf";
import type { Workspace } from "../types/index.js";

// Icon colors available for forum topics (Telegram API exact values)
type TopicColor = 7322096 | 16766590 | 13338331 | 9367192 | 16749490 | 16478047;
const TOPIC_COLORS: TopicColor[] = [
  7322096,  // blue
  16766590, // yellow
  13338331, // purple
  9367192,  // green
  16749490, // pink
  16478047, // red
];

function pickColor(repoName: string): TopicColor {
  let hash = 0;
  for (let i = 0; i < repoName.length; i++) {
    hash = (hash * 31 + repoName.charCodeAt(i)) | 0;
  }
  return TOPIC_COLORS[Math.abs(hash) % TOPIC_COLORS.length];
}

/**
 * Create a forum topic for a workspace. Returns the message_thread_id,
 * or null if the chat doesn't support topics.
 */
export async function createWorkspaceTopic(
  telegram: Telegram,
  chatId: string,
  repoName: string,
  workspaceName: string
): Promise<number | null> {
  try {
    const topicName = buildTopicName(repoName, workspaceName);
    const result = await telegram.createForumTopic(chatId, topicName, {
      icon_color: pickColor(repoName),
    });
    return result.message_thread_id;
  } catch (err: any) {
    // Chat is not a forum-enabled supergroup, or bot lacks permissions
    console.log(`[forum] could not create topic: ${err.message}`);
    return null;
  }
}

/**
 * Build the canonical topic name for a workspace.
 */
export function buildTopicName(repoName: string, workspaceName: string): string {
  return `${workspaceName} · ${repoName}`;
}

export async function renameWorkspaceTopic(
  telegram: Telegram,
  chatId: string,
  threadId: number,
  repoPath: string,
  workspaceName: string
): Promise<void> {
  const repoName = path.basename(repoPath);
  const newName = buildTopicName(repoName, workspaceName);
  await telegram.callApi("editForumTopic", {
    chat_id: chatId,
    message_thread_id: threadId,
    name: newName,
  });
}

/**
 * Rename all existing forum topics to the current naming format.
 * Safe to call on every startup — Telegram ignores no-op renames.
 */
export async function renameWorkspaceTopics(
  telegram: Telegram,
  workspaces: Workspace[]
): Promise<void> {
  for (const ws of workspaces) {
    if (!ws.telegramThreadId || !ws.conductorWorkspaceName) continue;
    try {
      await renameWorkspaceTopic(
        telegram,
        ws.telegramChatId,
        ws.telegramThreadId,
        ws.repoPath,
        ws.conductorWorkspaceName
      );
    } catch (err: any) {
      console.log(`[forum] could not rename topic ${ws.telegramThreadId}: ${err.message}`);
    }
  }
}

/**
 * Close (collapse) a forum topic when a workspace reaches a terminal state.
 */
export async function closeWorkspaceTopic(
  telegram: Telegram,
  chatId: string,
  threadId: number
): Promise<void> {
  try {
    await telegram.closeForumTopic(chatId, threadId);
  } catch (err: any) {
    console.log(`[forum] could not close topic: ${err.message}`);
  }
}

/**
 * Reopen a previously closed forum topic (e.g. when /send resumes a stopped workspace).
 */
export async function reopenWorkspaceTopic(
  telegram: Telegram,
  chatId: string,
  threadId: number
): Promise<void> {
  try {
    await telegram.reopenForumTopic(chatId, threadId);
  } catch (err: any) {
    console.log(`[forum] could not reopen topic: ${err.message}`);
  }
}
