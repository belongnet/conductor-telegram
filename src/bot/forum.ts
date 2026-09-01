import path from "node:path";
import type { Telegram } from "telegraf";
import {
  acknowledgePendingCloudNotice,
  getLatestEventByType,
  getPendingCloudLaunch,
  getPendingCloudNotices,
  getPendingCloudTerminalIntent,
  getPendingDecision,
  getWorkspace,
  requestWorkspaceTopicReconciliation,
  updateWorkspaceThreadId,
  cloudNoticeFinalizesWorkspaceTopic,
  type PendingCloudNoticeKind,
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
  | "testing"
  | "blocked"
  | "needs_input"
  | "awaiting_pr_review"
  | "ready_to_submit_pr"
  | "ready_to_merge"
  | "archived";

const TOPIC_ICON_EMOJIS: Record<TopicVisualState, readonly string[]> = {
  in_progress: ["⚡️", "💻", "🤖"],
  testing: ["🧪", "🔬", "✅"],
  blocked: ["❗️", "⁉️", "‼️"],
  needs_input: ["❓", "💬", "🗣"],
  awaiting_pr_review: ["🔎", "👀", "📝"],
  ready_to_submit_pr: ["📣", "📝", "💻"],
  ready_to_merge: ["✅", "🏁", "🎖"],
  archived: ["📁", "💼", "🧳"],
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
      text.includes("needs input") ||
      text.includes("awaiting input") ||
      text.includes("waiting for input")
    ) {
      return "needs_input";
    }
    if (text.includes("blocked") || text.includes("stuck")) {
      return "blocked";
    }
    if (
      text.includes("awaiting pr review") ||
      text.includes("awaiting review") ||
      text.includes("pr review")
    ) {
      return "awaiting_pr_review";
    }
    if (text.includes("ready to merge") || text.includes("can merge")) {
      return "ready_to_merge";
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
    if (text.includes("test")) {
      return "testing";
    }
    if (text.includes("review")) {
      return "awaiting_pr_review";
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
  if (
    workspace.status === "done" ||
    workspace.status === "stopped" ||
    workspace.status === "archived"
  ) {
    return "archived";
  }
  if (getPendingDecision(workspace.id)) return "needs_input";

  const reportedState = parseStatusTopicState(workspace);
  if (reportedState) return reportedState;

  const artifactState = parseArtifactTopicState(workspace);
  if (artifactState) return artifactState;

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

export type CreateTopicResult =
  | { ok: true; threadId: number }
  | { ok: false; kind: CreateTopicFailureKind; message: string };

type CreateTopicFailureKind = "no_forum" | "no_permission" | "other";

function classifyTopicCreateError(err: any): CreateTopicFailureKind {
  const msg = String(err?.message ?? "").toLowerCase();
  if (
    msg.includes("not enough rights") ||
    msg.includes("can_manage_topics") ||
    msg.includes("forbidden")
  ) {
    return "no_permission";
  }
  if (
    msg.includes("not a forum") ||
    msg.includes("forum") ||
    msg.includes("topics_disabled") ||
    msg.includes("supergroup")
  ) {
    return "no_forum";
  }
  return "other";
}

/**
 * Create a forum topic for a workspace. Structured failures let callers
 * distinguish private/non-forum chats from permission or Telegram errors.
 */
export async function createWorkspaceTopic(
  telegram: Telegram,
  chatId: string,
  repoName: string,
  workspaceName: string
): Promise<CreateTopicResult> {
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
    return { ok: true, threadId: result.message_thread_id };
  } catch (err: any) {
    const message = String(err?.message ?? "unknown error");
    const kind = classifyTopicCreateError(err);
    console.log(`[forum] could not create topic (${kind}): ${message}`);
    return { ok: false, kind, message };
  }
}

export async function createRepoTopic(
  telegram: Telegram,
  chatId: string,
  repoName: string
): Promise<CreateTopicResult> {
  try {
    const result = await telegram.createForumTopic(chatId, buildRepoTopicName(repoName), {
      icon_color: pickColor(repoName),
    });
    return { ok: true, threadId: result.message_thread_id };
  } catch (err: any) {
    const message = String(err?.message ?? "unknown error");
    const kind = classifyTopicCreateError(err);
    console.log(`[forum] could not create repo topic (${kind}): ${message}`);
    return { ok: false, kind, message };
  }
}

/** Telegram rejects forum topic names longer than 128 characters. */
const MAX_TOPIC_NAME_LENGTH = 128;

function clampTopicName(name: string): string {
  return name.length > MAX_TOPIC_NAME_LENGTH
    ? `${name.slice(0, MAX_TOPIC_NAME_LENGTH - 1)}…`
    : name;
}

export function buildRepoTopicName(repoName: string): string {
  return clampTopicName(repoName);
}

/**
 * Build the canonical topic name for a workspace.
 */
export function buildTopicName(repoName: string, workspaceName: string): string {
  return clampTopicName(`${workspaceName} · ${repoName}`);
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
  const extra = await workspaceTopicEdit(telegram, workspace);
  if (!extra.name && !extra.icon_custom_emoji_id) return;
  try {
    await telegram.editForumTopic(
      workspace.telegramChatId,
      workspace.telegramThreadId,
      extra
    );
  } catch (err: any) {
    if (isTopicDeletedError(err)) {
      console.log(
        `[forum] topic ${workspace.telegramThreadId} was deleted during sync, recreating`
      );
      await ensureWorkspaceTopic(telegram, workspace);
    } else {
      throw err;
    }
  }
}

async function workspaceTopicEdit(
  telegram: Telegram,
  workspace: Workspace
): Promise<{ name?: string; icon_custom_emoji_id?: string }> {
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
  return extra;
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

export async function deleteWorkspaceTopic(
  telegram: Telegram,
  chatId: string,
  threadId: number
): Promise<void> {
  try {
    await telegram.callApi("deleteForumTopic", {
      chat_id: chatId,
      message_thread_id: threadId,
    });
  } catch (err: any) {
    console.log(`[forum] could not delete topic: ${err.message}`);
    await closeWorkspaceTopic(telegram, chatId, threadId);
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

/** Apply the terminal topic state, then collapse the forum topic. */
export async function finalizeWorkspaceTopic(
  telegram: Telegram,
  workspace: Workspace
): Promise<void> {
  try {
    await syncWorkspaceTopic(telegram, workspace);
  } finally {
    if (workspace.telegramThreadId) {
      await closeWorkspaceTopic(
        telegram,
        workspace.telegramChatId,
        workspace.telegramThreadId
      );
    }
  }
}

/** Idempotently apply terminal topic state before recovery notices are acked. */
export async function finalizeWorkspaceTopicForCloudNotices(
  telegram: Telegram,
  workspace: Workspace,
  kinds: readonly PendingCloudNoticeKind[]
): Promise<void> {
  if (!kinds.some(cloudNoticeFinalizesWorkspaceTopic)) return;
  if (!workspace.telegramThreadId) return;
  try {
    const extra = await workspaceTopicEdit(telegram, workspace);
    if (extra.name || extra.icon_custom_emoji_id) {
      await telegram.editForumTopic(
        workspace.telegramChatId,
        workspace.telegramThreadId,
        extra
      );
    }
  } catch (error) {
    // A deleted terminal topic is already beyond "closed". Crucially, do not
    // recreate it: that would create a new open topic after recovery.
    if (isTopicAlreadyTerminalError(error)) return;
    // Keep the topic open when its terminal styling cannot be applied. The
    // durable notice can then publish and retry the whole finalization later.
    throw error;
  }
  try {
    await telegram.closeForumTopic(
      workspace.telegramChatId,
      workspace.telegramThreadId
    );
  } catch (error) {
    if (!isTopicAlreadyTerminalError(error)) throw error;
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

type DurableWorkspaceTopicState = "open" | "deferred_close" | "closed";

function durableWorkspaceTopicState(
  workspace: Workspace
): DurableWorkspaceTopicState {
  if (
    !workspace.archivedAt &&
    (workspace.status === "starting" || workspace.status === "running")
  ) {
    return "open";
  }
  const publicationPending = getPendingCloudNotices(workspace.id).some(
    (notice) => notice.kind !== "topic_reconcile"
  );
  if (
    publicationPending ||
    getPendingCloudTerminalIntent(workspace.id) ||
    getPendingCloudLaunch(workspace.id)
  ) {
    return "deferred_close";
  }
  return "closed";
}

function workspaceTopicStateSignature(workspace: Workspace): string {
  return JSON.stringify([
    durableWorkspaceTopicState(workspace),
    workspace.status,
    workspace.telegramChatId,
    workspace.telegramThreadId,
    workspace.conductorWorkspaceName,
    workspace.repoPath,
  ]);
}

function isTopicAlreadyOpenError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? "").toLowerCase();
  return (
    msg.includes("topic_not_modified") ||
    msg.includes("topic is not closed") ||
    msg.includes("topic already open") ||
    msg.includes("topic is already open")
  );
}

async function applyDurableWorkspaceTopicState(
  telegram: Telegram,
  workspace: Workspace
): Promise<void> {
  if (!workspace.telegramThreadId) return;
  if (durableWorkspaceTopicState(workspace) === "closed") {
    await finalizeWorkspaceTopicForCloudNotices(telegram, workspace, [
      "stop_confirmed",
    ]);
    return;
  }

  try {
    await telegram.reopenForumTopic(
      workspace.telegramChatId,
      workspace.telegramThreadId
    );
  } catch (error) {
    if (isTopicDeletedError(error)) {
      const recreated = await ensureWorkspaceTopic(telegram, workspace);
      if (!recreated) throw error;
    } else if (!isTopicAlreadyOpenError(error)) {
      throw error;
    }
  }
  await syncWorkspaceTopic(telegram, workspace);
}

export type WorkspaceTopicReconciliationStatus =
  | "none"
  | "completed"
  | "pending";

const pendingWorkspaceTopicReconciliations = new Map<
  string,
  Promise<WorkspaceTopicReconciliationStatus>
>();

/**
 * Retry an invisible topic-state marker against fresh durable workspace state.
 * A bounded loop compensates when Stop/Archive or a new resume wins during a
 * Telegram request; continued churn leaves the marker for the next poll.
 */
async function performPendingWorkspaceTopicReconciliation(
  telegram: Telegram,
  trackedWorkspaceId: string
): Promise<WorkspaceTopicReconciliationStatus> {
  let marker = getPendingCloudNotices(trackedWorkspaceId).find(
    (notice) => notice.kind === "topic_reconcile"
  );
  if (!marker) return "none";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const workspace = getWorkspace(trackedWorkspaceId);
    if (!workspace || !workspace.telegramThreadId) {
      return acknowledgePendingCloudNotice(trackedWorkspaceId, marker.id)
        ? "completed"
        : "pending";
    }
    const before = workspaceTopicStateSignature(workspace);
    await applyDurableWorkspaceTopicState(telegram, workspace);

    const latestMarker = getPendingCloudNotices(trackedWorkspaceId).find(
      (notice) => notice.kind === "topic_reconcile"
    );
    const latest = getWorkspace(trackedWorkspaceId);
    if (!latestMarker) {
      if (
        latest &&
        latest.telegramThreadId &&
        workspaceTopicStateSignature(latest) !== before
      ) {
        marker = requestWorkspaceTopicReconciliation(trackedWorkspaceId);
        continue;
      }
      return "completed";
    }
    if (latestMarker.id !== marker.id) {
      marker = latestMarker;
      continue;
    }
    if (
      latest &&
      latest.telegramThreadId &&
      workspaceTopicStateSignature(latest) === before
    ) {
      if (durableWorkspaceTopicState(latest) === "deferred_close") {
        return "pending";
      }
      return acknowledgePendingCloudNotice(trackedWorkspaceId, marker.id)
        ? "completed"
        : "pending";
    }
  }
  return "pending";
}

export function reconcilePendingWorkspaceTopicState(
  telegram: Telegram,
  trackedWorkspaceId: string
): Promise<WorkspaceTopicReconciliationStatus> {
  const previous = pendingWorkspaceTopicReconciliations.get(trackedWorkspaceId);
  const afterPrevious = previous
    ? previous.then(
        () => undefined,
        () => undefined
      )
    : Promise.resolve();
  const reconciliation = afterPrevious.then(() =>
    performPendingWorkspaceTopicReconciliation(telegram, trackedWorkspaceId)
  );
  pendingWorkspaceTopicReconciliations.set(
    trackedWorkspaceId,
    reconciliation
  );
  return reconciliation.finally(() => {
    if (
      pendingWorkspaceTopicReconciliations.get(trackedWorkspaceId) ===
      reconciliation
    ) {
      pendingWorkspaceTopicReconciliations.delete(trackedWorkspaceId);
    }
  });
}

function isTopicDeletedError(err: any): boolean {
  const msg = String(err?.message ?? "").toLowerCase();
  return (
    msg.includes("message_thread_not_found") ||
    msg.includes("topic_deleted") ||
    msg.includes("thread not found") ||
    (msg.includes("bad request") && msg.includes("thread"))
  );
}

function isTopicAlreadyTerminalError(err: unknown): boolean {
  if (isTopicDeletedError(err)) return true;
  const msg = String((err as { message?: unknown })?.message ?? "").toLowerCase();
  return msg.includes("topic_closed") || msg.includes("topic is closed");
}

/**
 * Ensure a workspace has a valid topic. If the existing topic was deleted,
 * create a new one and update the database.
 * Returns the (possibly new) thread ID, or null if topics aren't supported.
 */
export async function ensureWorkspaceTopic(
  telegram: Telegram,
  workspace: Workspace
): Promise<number | null> {
  if (!workspace.telegramThreadId) return null;

  try {
    // Probe: try editing the topic (no-op name update) to see if it still exists
    await telegram.editForumTopic(
      workspace.telegramChatId,
      workspace.telegramThreadId,
      {}
    );
    return workspace.telegramThreadId;
  } catch (err: any) {
    if (!isTopicDeletedError(err)) {
      // Some other error (permissions, rate limit, etc.) — assume topic exists
      return workspace.telegramThreadId;
    }
  }

  // Topic was deleted — recreate it
  console.log(
    `[forum] topic ${workspace.telegramThreadId} was deleted, recreating for workspace ${workspace.id}`
  );
  const repoName = path.basename(workspace.repoPath);
  const wsName = workspace.conductorWorkspaceName ?? workspace.name;
  const result = await createWorkspaceTopic(
    telegram,
    workspace.telegramChatId,
    repoName,
    wsName
  );
  if (!result.ok) return null;
  const newThreadId = result.threadId;
  updateWorkspaceThreadId(workspace.id, newThreadId);
  workspace.telegramThreadId = newThreadId;
  // Apply the workspace's current visual state to the new topic
  const desiredIcon = await getTopicIconId(
    telegram,
    getWorkspaceTopicState(workspace)
  );
  if (desiredIcon) {
    try {
      await telegram.editForumTopic(workspace.telegramChatId, newThreadId, {
        icon_custom_emoji_id: desiredIcon,
      });
    } catch (err: any) {
      console.log(`[forum] could not set initial icon on recreated topic: ${err.message}`);
    }
  }
  return newThreadId;
}
