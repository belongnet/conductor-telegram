import type { Telegram } from "telegraf";

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
    const topicName = `${repoName} / ${workspaceName}`;
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
