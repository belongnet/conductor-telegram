import path from "node:path";
import type { Telegram } from "telegraf";
import {
  getLatestEventByType,
  getPendingDecision,
} from "../store/queries.js";
import type {
  ArtifactPayload,
  StatusPayload,
  Workspace,
} from "../types/index.js";

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

type TopicVisualState =
  | "in_progress"
  | "needs_input"
  | "awaiting_pr_review"
  | "ready_to_submit_pr"
  | "ready_to_merge"
  | "failed"
  | "stopped";

const TOPIC_ICON_EMOJIS: Record<TopicVisualState, readonly string[]> = {
  in_progress: ["⏳", "⌛", "⚙️", "🔄"],
  needs_input: ["❓", "💬", "👀"],
  awaiting_pr_review: ["👀", "🔎", "📝"],
  ready_to_submit_pr: ["📤", "📝", "🚀"],
  ready_to_merge: ["✅", "🎯", "🚀"],
  failed: ["❌", "⛔", "🚫"],
  stopped: ["⏹️", "⏸️", "🛑"],
};

let topicIconCache: Promise<Map<string, string> | null> | null = null;

function pickColor(repoName: string): TopicColor {
  let hash = 0;
  for (let i = 0; i < repoName.length; i++) {
    hash = (hash * 31 + repoName.charCodeAt(i)) | 0;
  }
  return TOPIC_COLORS[Math.abs(hash) % TOPIC_COLORS.length];
}

function normalizeEmoji(emoji: string): string {
  return emoji.replace(/\uFE0F/g, "");
}

function parseStatusTopicState(workspace: Workspace): TopicVisualState | null {
  const event = getLatestEventByType(workspace.id, "status");
  if (!event?.payload) return null;
  try {
    const payload = JSON.parse(event.payload) as StatusPayload;
    const text = `${payload.status} ${payload.message}`.toLowerCase();
    if (
      text.includes("awaiting pr review") ||
      text.includes("awaiting review") ||
      text.includes("pr review")
    ) {
      return "awaiting_pr_review";
    }
    if (
      text.includes("submit pr") ||
      text.includes("open pr") ||
      text.includes("create pr")
    ) {
      return "ready_to_submit_pr";
    }
    if (text.includes("merge")) {
      return "ready_to_merge";
    }
  } catch {
    return null;
  }
  return null;
}

function parseArtifactTopicState(workspace: Workspace): TopicVisualState | null {
  const event = getLatestEventByType(workspace.id, "artifact");
  if (!event?.payload) return null;
  try {
    const payload = JSON.parse(event.payload) as ArtifactPayload;
    if (payload.type === "pr") {
      return "awaiting_pr_review";
    }
  } catch {
    return null;
  }
  return null;
}

function getWorkspaceTopicState(workspace: Workspace): TopicVisualState {
  if (workspace.status === "failed") return "failed";
  if (workspace.status === "stopped") return "stopped";
  if (getPendingDecision(workspace.id)) return "needs_input";

  const reportedState = parseStatusTopicState(workspace);
  if (reportedState) return reportedState;

  const artifactState = parseArtifactTopicState(workspace);
  if (artifactState) return artifactState;

  if (workspace.status === "done") {
    return "ready_to_submit_pr";
  }

  return "in_progress";
}

async function getTopicIcons(telegram: Telegram): Promise<Map<string, string> | null> {
  if (!topicIconCache) {
    topicIconCache = telegram
      .getForumTopicIconStickers()
      .then((stickers) => {
        const icons = new Map<string, string>();
        for (const sticker of stickers) {
          if (!sticker.emoji || !sticker.custom_emoji_id) continue;
          icons.set(normalizeEmoji(sticker.emoji), sticker.custom_emoji_id);
        }
        return icons;
      })
      .catch((err: any) => {
        console.log(`[forum] could not load topic icon stickers: ${err.message}`);
        return null;
      });
  }
  return topicIconCache;
}

async function getTopicIconId(
  telegram: Telegram,
  state: TopicVisualState
): Promise<string | undefined> {
  const icons = await getTopicIcons(telegram);
  if (!icons) return undefined;
  for (const emoji of TOPIC_ICON_EMOJIS[state]) {
    const iconId = icons.get(normalizeEmoji(emoji));
    if (iconId) return iconId;
  }
  return undefined;
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
    const iconId = await getTopicIconId(telegram, "in_progress");
    const result = await telegram.createForumTopic(
      chatId,
      topicName,
      iconId
        ? { icon_custom_emoji_id: iconId }
        : { icon_color: pickColor(repoName) }
    );
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
  await telegram.editForumTopic(chatId, threadId, { name: newName });
}

export async function syncWorkspaceTopic(
  telegram: Telegram,
  workspace: Workspace
): Promise<void> {
  if (!workspace.telegramThreadId) return;

  const extra: { name?: string; icon_custom_emoji_id?: string } = {};
  if (workspace.conductorWorkspaceName) {
    extra.name = buildTopicName(
      path.basename(workspace.repoPath),
      workspace.conductorWorkspaceName
    );
  }

  const iconId = await getTopicIconId(telegram, getWorkspaceTopicState(workspace));
  if (iconId) {
    extra.icon_custom_emoji_id = iconId;
  }

  if (!extra.name && !extra.icon_custom_emoji_id) return;
  await telegram.editForumTopic(
    workspace.telegramChatId,
    workspace.telegramThreadId,
    extra
  );
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
    if (!ws.telegramThreadId) continue;
    try {
      await syncWorkspaceTopic(telegram, ws);
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
