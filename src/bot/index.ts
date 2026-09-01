import { Telegraf } from "telegraf";
import { getDb } from "../store/db.js";
import { authGuard } from "./middleware.js";
import {
  getTelegramCommands,
  registerCommands,
  trackDecisionMessage,
} from "./commands.js";
import {
  installCrashHandlers,
  startHeartbeat,
  supervisedInterval,
  getLogger,
} from "./supervisor.js";
import { initHeartbeat } from "../store/queries.js";
import { startLanesScheduler } from "../lanes/scheduler.js";
import {
  runStartupMaintenance,
  startMaintenanceTimer,
} from "../store/maintenance.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  canUseConductorCloudApi,
  getCloudWorkspaceSessionInfo,
  getMaxSessionMessageCursor,
  getConductorWorkspaceSessions,
  getSessionMessagesAfter,
  getSessionResultBySessionId,
  getWorkspaceDir,
  getWorkspaceSessionInfo,
  isConductorWorkspaceVisible,
  isRemoteConductorWorkspace,
  reconcilePendingCloudLaunch,
  reconcilePendingCloudMessages,
  reconcilePendingCloudTerminalIntent,
  type ConductorSessionInfo,
  type SessionMessage,
} from "./launcher.js";
import {
  archiveWorkspaceLocally,
  acknowledgePendingCloudNotice,
  cloudNoticeFinalizesWorkspaceTopic,
  deleteThreadCursorsNotIn,
  getAllThreadedWorkspaces,
  getAllWorkspaces,
  getWorkspacesWithPendingCloudWork,
  getArtifactEvents,
  getMaxEventId,
  getMetaValue,
  getNewEvents,
  getPendingCloudNotices,
  getThreadCursor,
  getWorkspace,
  linkTelegramMessage,
  setMetaValue,
  updateThreadCursor,
  upsertThreadCursor,
  updateWorkspaceConductorBinding,
  updateWorkspaceForwardCursor,
  updateWorkspaceStatus,
  updateWorkspaceTelegramMessage,
  updateWorkspaceThreadId,
  type PendingCloudNotice,
} from "../store/queries.js";
import type {
  ArtifactPayload,
  HumanRequestPayload,
  StatusPayload,
  ThreadCursor,
  Workspace,
} from "../types/index.js";
import {
  btn,
  escHtml as esc,
  expandableQuote,
  formatStats,
  markdownToTelegramHtml,
  formatAgo,
  maybeExpandableQuote,
  styledButtons,
  styledKeyboard,
  TELEGRAM_MAX_TEXT,
  truncate as trunc,
  truncateHtml,
} from "./format.js";
import {
  createWorkspaceTopic,
  deleteWorkspaceTopic,
  ensureWorkspaceTopic,
  finalizeWorkspaceTopicForCloudNotices,
  reconcilePendingWorkspaceTopicState,
  renameWorkspaceTopics,
  syncWorkspaceTopic,
} from "./forum.js";
import {
  extractInlineMedia,
  resolveWorkspaceMediaFile,
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_MEDIA_GROUP_MAX,
  type InlineMediaItem,
} from "./media.js";
import { existsSync } from "node:fs";
import { refreshWorkspacePr } from "./github.js";
import { formatPrCard, prKeyboard } from "./pr-ui.js";
import {
  advanceCloudSessionCycle,
  canCompletePolledWorkspace,
  cloudCycleIsInFlight,
  cloudSessionCycleKey,
  encodeCloudSessionCycle,
  chunkTelegramHtmlEntries,
  publishCloudNoticeChunks,
  parseCloudSessionCycle,
  shouldReconcilePendingCloudWork,
  shouldPollTrackedWorkspace,
  type CloudSessionCycle,
} from "./polling-policy.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const POLL_INTERVAL_MS = 5000;
const CLOUD_POLL_INTERVAL_MS = 15_000;
const STALE_WORKSPACE_MS = 15 * 60 * 1000;

const lifecycleLog = getLogger("bot");
const pollerLog = getLogger("poller");
const eventPollerLog = getLogger("event-poller");
const forumLog = getLogger("forum");

function readBotVersion(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/bot/index.js → ../.. → project root
    const pkgPath = path.resolve(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export const BOT_VERSION = readBotVersion();

function getOwnerChatId(): string | undefined {
  return process.env.OWNER_CHAT_ID;
}

function getOwnerUserId(): string | undefined {
  return process.env.OWNER_USER_ID;
}

if (!BOT_TOKEN || !getOwnerChatId()) {
  // When launched via CLI, config is already validated. This guard is for
  // direct `node dist/bot/index.js` invocations (legacy .env workflow).
  const missing = [
    !BOT_TOKEN && "BOT_TOKEN",
    !getOwnerChatId() && "OWNER_CHAT_ID",
  ].filter(Boolean);
  console.error(
    `ERROR: Missing required environment variable(s): ${missing.join(", ")}\n` +
    `CAUSE: Neither config.json nor env vars provide these values\n` +
    `FIX:   Run 'conductor-telegram setup' or set ${missing.join(" and ")} in your environment\n` +
    `       For manual Telegram bootstrap, you can temporarily set OWNER_CHAT_ID=0 and use /setup to configure the active chat`
  );
  process.exit(2);
}

// Initialize DB
getDb();

// Create bot
const bot = new Telegraf(BOT_TOKEN);

// Debug: log all incoming updates
bot.use((ctx, next) => {
  const msg = ctx.message as any;
  const preview = msg?.text?.slice(0, 50) ?? (msg?.photo ? "[photo]" : msg?.voice ? "[voice]" : "");
  console.log(`[update] type=${ctx.updateType} chat=${ctx.chat?.id} ${preview}`);
  return next();
});

// Auth: only respond to the owner
bot.use(
  authGuard(() => ({
    ownerChatId: getOwnerChatId(),
    ownerUserId: getOwnerUserId(),
  }))
);

// Register commands
registerCommands(bot);

async function syncTelegramCommands(): Promise<void> {
  const commands = getTelegramCommands();

  await bot.telegram.callApi("deleteMyCommands", {});
  await bot.telegram.callApi("deleteMyCommands", {
    scope: { type: "all_private_chats" },
  });
  const ownerChatId = getOwnerChatId();
  // scope: "chat" only accepts private-chat or channel IDs. Supergroup IDs
  // (starting with -100) will 400 here. Best-effort: try it for private
  // chats only, and tolerate any failure so startup is never blocked by a
  // commands-sync hiccup.
  if (ownerChatId && ownerChatId !== "0" && !ownerChatId.startsWith("-")) {
    try {
      await bot.telegram.callApi("deleteMyCommands", {
        scope: { type: "chat", chat_id: ownerChatId },
      });
    } catch (err) {
      lifecycleLog.warn("per-chat deleteMyCommands skipped:", err);
    }
  }
  await bot.telegram.setMyCommands(commands);
}

// ── Topic-safe message sending ───────────────────────────────

/**
 * Send a message to a workspace's topic, recreating the topic if it was deleted.
 */
async function sendToWorkspaceTopic(
  ws: Workspace,
  text: string,
  extra: Record<string, any> = {}
): ReturnType<typeof bot.telegram.sendMessage> {
  if (!ws.telegramThreadId) {
    const recovered = await recoverMissingWorkspaceTopic(ws);
    if (recovered) ws.telegramThreadId = recovered;
  }

  const threadOpts = ws.telegramThreadId
    ? { message_thread_id: ws.telegramThreadId }
    : {};
  try {
    return await bot.telegram.sendMessage(ws.telegramChatId, text, {
      ...extra,
      ...threadOpts,
    });
  } catch (err: any) {
    const msg = String(err?.message ?? "").toLowerCase();
    const isDeleted =
      msg.includes("message_thread_not_found") ||
      msg.includes("topic_deleted") ||
      msg.includes("thread not found") ||
      (msg.includes("bad request") && msg.includes("thread"));

    if (!isDeleted || !ws.telegramThreadId) throw err;

    const newThreadId = await ensureWorkspaceTopic(bot.telegram, ws);
    const newThreadOpts = newThreadId ? { message_thread_id: newThreadId } : {};
    return await bot.telegram.sendMessage(ws.telegramChatId, text, {
      ...extra,
      ...newThreadOpts,
    });
  }
}

// Coalesce topic recovery so parallel poller/event sends cannot create
// multiple topics once permissions are restored.
const topicRecoveryInFlight = new Map<string, Promise<number | null>>();

async function recoverMissingWorkspaceTopic(ws: Workspace): Promise<number | null> {
  const existing = topicRecoveryInFlight.get(ws.id);
  if (existing) return existing;

  const attempt = (async () => {
    const chat = await bot.telegram.getChat(ws.telegramChatId).catch(() => null);
    if (!(chat as any)?.is_forum) return null;

    const result = await createWorkspaceTopic(
      bot.telegram,
      ws.telegramChatId,
      path.basename(ws.repoPath),
      ws.conductorWorkspaceName ?? ws.name
    );
    if (!result.ok) return null;

    updateWorkspaceThreadId(ws.id, result.threadId);
    return result.threadId;
  })();

  topicRecoveryInFlight.set(ws.id, attempt);
  try {
    return await attempt;
  } finally {
    topicRecoveryInFlight.delete(ws.id);
  }
}

/**
 * Send agent text plus any inline media items to a workspace's topic.
 *
 * - 0 media: same as `sendToWorkspaceTopic`.
 * - 1 media: singular `sendPhoto`/`sendDocument`/`sendVideo`/`sendAudio`/`sendAnimation`
 *   with the text as caption (or as a follow-up text message when text exceeds the
 *   1024-char Telegram caption cap).
 * - N media (2-10): one `sendMediaGroup` call with the caption attached to the first
 *   item. >10 splits into successive groups; the caption only rides the first group.
 * - HTML mode is forwarded for both the caption (when it fits) and the trailing text.
 * - Topic-recovery semantics mirror `sendToWorkspaceTopic`.
 */
async function sendForwardToWorkspaceTopic(
  ws: Workspace,
  htmlText: string,
  media: InlineMediaItem[],
  sessionId?: string | null
): Promise<void> {
  if (media.length === 0) {
    await sendToWorkspaceTopic(ws, htmlText, { parse_mode: "HTML" })
      .then((sent) => {
        linkTelegramMessage(ws.telegramChatId, String(sent.message_id), ws.id, sessionId);
      });
    return;
  }

  const captionFits = htmlText.length > 0 && htmlText.length <= TELEGRAM_CAPTION_MAX;
  const captionForFirst = captionFits ? htmlText : undefined;
  const trailingText = captionFits ? "" : htmlText;

  if (media.length === 1) {
    const item = media[0];
    const sentMessageId = await sendSingleMediaToWorkspaceTopic(
      ws,
      item,
      captionForFirst
    );
    if (sentMessageId !== null) {
      linkTelegramMessage(ws.telegramChatId, String(sentMessageId), ws.id, sessionId);
    }
  } else {
    // Split into chunks of 10 (Telegram's media-group cap). The caption rides the
    // very first item of the very first group; the rest go captionless.
    let isFirstChunk = true;
    for (let i = 0; i < media.length; i += TELEGRAM_MEDIA_GROUP_MAX) {
      const chunk = media.slice(i, i + TELEGRAM_MEDIA_GROUP_MAX);
      const caption = isFirstChunk ? captionForFirst : undefined;
      isFirstChunk = false;
      const sentMessages = await sendMediaGroupToWorkspaceTopic(ws, chunk, caption);
      for (const sent of sentMessages) {
        linkTelegramMessage(ws.telegramChatId, String(sent.message_id), ws.id, sessionId);
      }
    }
  }

  if (trailingText) {
    await sendToWorkspaceTopic(ws, trailingText, { parse_mode: "HTML" }).then((sent) => {
      linkTelegramMessage(ws.telegramChatId, String(sent.message_id), ws.id, sessionId);
    });
  }
}

async function sendSingleMediaToWorkspaceTopic(
  ws: Workspace,
  item: InlineMediaItem,
  captionHtml: string | undefined
): Promise<number | null> {
  if (!ws.telegramThreadId) {
    const recovered = await recoverMissingWorkspaceTopic(ws);
    if (recovered) ws.telegramThreadId = recovered;
  }

  const baseExtra: Record<string, any> = captionHtml
    ? { caption: captionHtml, parse_mode: "HTML" }
    : {};
  const send = async (extra: Record<string, any>) => {
    const file = { source: item.filePath, filename: item.filename };
    switch (item.kind) {
      case "photo":
        return bot.telegram.sendPhoto(ws.telegramChatId, file as any, extra);
      case "video":
        return bot.telegram.sendVideo(ws.telegramChatId, file as any, extra);
      case "audio":
        return bot.telegram.sendAudio(ws.telegramChatId, file as any, extra);
      case "animation":
        return bot.telegram.sendAnimation(ws.telegramChatId, file as any, extra);
      case "document":
      default:
        return bot.telegram.sendDocument(ws.telegramChatId, file as any, extra);
    }
  };

  const threadOpts = ws.telegramThreadId ? { message_thread_id: ws.telegramThreadId } : {};
  try {
    const sent = await send({ ...baseExtra, ...threadOpts });
    return sent.message_id;
  } catch (err: any) {
    if (!isDeletedThreadError(err) || !ws.telegramThreadId) {
      eventPollerLog.error("media send error:", err);
      return null;
    }
    const newThreadId = await ensureWorkspaceTopic(bot.telegram, ws);
    const newThreadOpts = newThreadId ? { message_thread_id: newThreadId } : {};
    const sent = await send({ ...baseExtra, ...newThreadOpts });
    return sent.message_id;
  }
}

async function sendMediaGroupToWorkspaceTopic(
  ws: Workspace,
  items: InlineMediaItem[],
  captionHtml: string | undefined
): Promise<{ message_id: number }[]> {
  if (!ws.telegramThreadId) {
    const recovered = await recoverMissingWorkspaceTopic(ws);
    if (recovered) ws.telegramThreadId = recovered;
  }

  const group = items.map((item, index) => {
    const base: any = {
      type: item.kind === "animation" ? "document" : item.kind,
      media: { source: item.filePath, filename: item.filename },
    };
    if (index === 0 && captionHtml) {
      base.caption = captionHtml;
      base.parse_mode = "HTML";
    }
    return base;
  });

  const threadOpts = ws.telegramThreadId ? { message_thread_id: ws.telegramThreadId } : {};
  try {
    return await bot.telegram.sendMediaGroup(ws.telegramChatId, group, threadOpts);
  } catch (err: any) {
    if (!isDeletedThreadError(err) || !ws.telegramThreadId) {
      eventPollerLog.error("media group send error:", err);
      return [];
    }
    const newThreadId = await ensureWorkspaceTopic(bot.telegram, ws);
    const newThreadOpts = newThreadId ? { message_thread_id: newThreadId } : {};
    return await bot.telegram.sendMediaGroup(ws.telegramChatId, group, newThreadOpts);
  }
}

function isDeletedThreadError(err: any): boolean {
  const msg = String(err?.message ?? "").toLowerCase();
  return (
    msg.includes("message_thread_not_found") ||
    msg.includes("topic_deleted") ||
    msg.includes("thread not found") ||
    (msg.includes("bad request") && msg.includes("thread"))
  );
}

// ── Conductor session status polling ─────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let cloudPollTimer: ReturnType<typeof setInterval> | null = null;
let lanesSchedulerStop: (() => void) | null = null;

function startSessionPoller(): void {
  pollTimer = supervisedInterval(
    "poller",
    () => pollConductorWorkspaces(false),
    POLL_INTERVAL_MS
  );
  cloudPollTimer = supervisedInterval(
    "cloud-poller",
    () => pollConductorWorkspaces(true),
    CLOUD_POLL_INTERVAL_MS
  );
}

async function pollConductorWorkspaces(cloudOnly: boolean): Promise<void> {
  const tracked = [
    ...new Map(
      [...getAllWorkspaces(100), ...getWorkspacesWithPendingCloudWork()].map(
        (workspace) => [workspace.id, workspace]
      )
    ).values(),
  ];
  for (const ws of tracked) {
    await pollConductorWorkspace(ws, cloudOnly).catch((error) => {
      pollerLog.error(
        `${cloudOnly ? "cloud " : ""}workspace poll failed for ${ws.id}:`,
        error
      );
    });
  }
}

async function reconcilePendingCloudWorkForWorkspace(
  ws: Workspace
): Promise<boolean> {
  await publishPendingCloudNotices(ws);
  const terminalIntent = await reconcilePendingCloudTerminalIntent(ws.id);
  if (terminalIntent.status === "pending") return true;
  if (terminalIntent.status === "failed") {
    pollerLog.error(
      `pending cloud ${terminalIntent.action} failed for ${ws.id}: ${terminalIntent.error}`
    );
    Object.assign(ws, getWorkspace(ws.id) ?? ws);
    await publishPendingCloudNotices(ws);
    if (ws.telegramThreadId) {
      await syncWorkspaceTopic(bot.telegram, ws).catch((error) =>
        forumLog.error(`topic sync error ${ws.telegramThreadId}:`, error)
      );
    }
    return true;
  }
  if (terminalIntent.status === "completed") {
    Object.assign(ws, getWorkspace(ws.id) ?? ws);
    await publishPendingCloudNotices(ws);
    return true;
  }
  const pendingLaunch = await reconcilePendingCloudLaunch(ws.id, ws);
  if (pendingLaunch.status === "pending") return true;
  if (pendingLaunch.status === "failed") {
    pollerLog.error(
      `pending cloud launch failed for ${ws.id}: ${pendingLaunch.error}`
    );
    Object.assign(ws, getWorkspace(ws.id) ?? ws);
    await publishPendingCloudNotices(ws);
    if (ws.telegramThreadId) {
      await syncWorkspaceTopic(bot.telegram, ws).catch((error) =>
        forumLog.error(`topic sync error ${ws.telegramThreadId}:`, error)
      );
    }
    return true;
  }
  if (pendingLaunch.status === "queued") {
    Object.assign(ws, getWorkspace(ws.id) ?? ws);
    await publishPendingCloudNotices(ws);
    if (ws.telegramThreadId) {
      await syncWorkspaceTopic(bot.telegram, ws).catch((error) =>
        forumLog.error(`topic sync error ${ws.telegramThreadId}:`, error)
      );
    }
  }

  const pendingMessages = await reconcilePendingCloudMessages(ws.id, ws);
  if (pendingMessages.status === "suppressed") {
    Object.assign(ws, getWorkspace(ws.id) ?? ws);
    await publishPendingCloudNotices(ws);
    return true;
  }
  if (pendingMessages.status === "failed") {
    Object.assign(ws, getWorkspace(ws.id) ?? ws);
    await publishPendingCloudNotices(ws);
    if (ws.telegramThreadId) {
      await syncWorkspaceTopic(bot.telegram, ws).catch((error) =>
        forumLog.error(`topic sync error ${ws.telegramThreadId}:`, error)
      );
    }
    return true;
  }
  if (pendingMessages.status === "sent") {
    Object.assign(ws, getWorkspace(ws.id) ?? ws);
    await publishPendingCloudNotices(ws);
  }

  return false;
}

async function pollConductorWorkspace(
  ws: Workspace,
  cloudOnly: boolean
): Promise<void> {
  if (
    shouldReconcilePendingCloudWork(cloudOnly) &&
    (await reconcilePendingCloudWorkForWorkspace(ws))
  ) {
    return;
  }

  if (!ws.conductorWorkspaceName) {
    // Normally a row is only briefly nameless mid-launch. If the bot died
    // between an API-side cloud create and persisting the binding, the row
    // would otherwise sit in "starting" forever while a live cloud workspace
    // runs untracked — the stale grace period turns that into a visible
    // failure instead of a silent hang.
    markWorkspaceStaleIfNeeded(ws);
    return;
  }
  if (!shouldPollTrackedWorkspace({ status: ws.status, cloudOnly })) return;
  const persistedCloud = Boolean(
    ws.conductorBackendKind === "cloud-api" &&
      ws.conductorWorkspaceId &&
      ws.conductorSessionId
  );
  const discoveredInfo = persistedCloud
    ? null
    : getWorkspaceSessionInfo(
        ws.conductorWorkspaceName,
        ws.repoPath,
        ws
      );
  const discoveredCloud = Boolean(
    discoveredInfo && isRemoteConductorWorkspace(discoveredInfo)
  );
  const isCloudWorkspace = persistedCloud || discoveredCloud;
  if (isCloudWorkspace !== cloudOnly) {
    // Discovery is local and cheap. Persist the cloud identity now, then
    // let the independent cloud poller perform all network I/O.
    if (isCloudWorkspace && discoveredInfo) {
      updateWorkspaceConductorBinding(ws.id, {
        workspaceId: discoveredInfo.workspaceId,
        sessionId: ws.conductorSessionId ?? discoveredInfo.sessionId,
        backendKind: "cloud-api",
      });
    }
    return;
  }
  const sessionInfo = persistedCloud
    ? await getCloudWorkspaceSessionInfo(
        ws.conductorWorkspaceName,
        ws.repoPath,
        ws,
        { includeMetadata: false }
      )
    : discoveredInfo;
  if (!sessionInfo) {
    markWorkspaceStaleIfNeeded(ws);
    return;
  }
  if (
    !isConductorWorkspaceVisible(sessionInfo) &&
    (sessionInfo.state === "archived" ||
      sessionInfo.sessionHidden ||
      ws.status !== "running")
  ) {
    syncHiddenConductorWorkspace(ws);
    return;
  }

  const remote = isRemoteConductorWorkspace(sessionInfo);
  const routedSessionId = remote
    ? ws.conductorSessionId ?? sessionInfo.sessionId
    : sessionInfo.sessionId;
  const backendKind = remote ? "cloud-api" : "local";
  if (
    ws.conductorWorkspaceId !== sessionInfo.workspaceId ||
    ws.conductorSessionId !== routedSessionId ||
    ws.conductorBackendKind !== backendKind
  ) {
    updateWorkspaceConductorBinding(ws.id, {
      workspaceId: sessionInfo.workspaceId,
      sessionId: routedSessionId,
      backendKind,
    });
  }

  const sessions = await getConductorWorkspaceSessions(
    sessionInfo.workspaceId,
    routedSessionId,
    backendKind
  );
  const visibleSessions =
    sessions.length > 0
      ? sessions
      : [activeSessionFromWorkspaceInfo(sessionInfo)];
  const hasMultipleThreads = visibleSessions.length > 1;
  const wsDir = workspaceDirFor(ws);
  const cancelingDuringPoll = new Set<string>();
  if (!remote) {
    deleteThreadCursorsNotIn(
      ws.id,
      visibleSessions.map((session) => session.sessionId)
    );
  }

  for (const session of visibleSessions) {
    const title = formatThreadTitle(session);
    const cursor = await ensureThreadCursor(ws, session, title);
    const newMessages = await getSessionMessagesAfter(
      session.sessionId,
      cursor.lastForwardedRowid,
      25,
      {
        afterMessageId: cursor.lastMessageId,
        backendKind: session.backendKind,
      }
    );
    const wasCanceling =
      session.backendKind === "cloud-api" &&
      getCloudSessionCycle(sessionInfo.workspaceId, session.sessionId)?.phase ===
        "canceling";
    if (wasCanceling) cancelingDuringPoll.add(session.sessionId);
    rememberCloudWorkEvidence(sessionInfo.workspaceId, session, newMessages);
    if (newMessages.length === 0) {
      rememberThreadStatus(
        ws,
        session,
        hasMultipleThreads,
        wasCanceling
      );
      continue;
    }

    for (const message of newMessages) {
      const forwarded = formatForwardedMessage(
        ws.conductorWorkspaceName,
        message,
        remote ? null : wsDir,
        hasMultipleThreads ? title : null
      );
      if (forwarded) {
        await sendForwardToWorkspaceTopic(
          ws,
          forwarded.text,
          forwarded.media,
          session.sessionId
        );
      }
      updateThreadCursor(
        ws.id,
        session.sessionId,
        message.rowid,
        title,
        message.messageId,
        session.backendKind
      );
      if (session.sessionId === sessionInfo.sessionId) {
        updateWorkspaceForwardCursor(ws.id, message.rowid);
      }
    }
    rememberThreadStatus(
      ws,
      session,
      hasMultipleThreads,
      wasCanceling
    );
  }

  const cycleSessionIds = new Set(
    visibleSessions.map((session) => session.sessionId)
  );
  if (remote) cycleSessionIds.add(routedSessionId);
  const cloudCycles = remote
    ? [...cycleSessionIds].map((sessionId) => ({
        sessionId,
        cycle: getCloudSessionCycle(sessionInfo.workspaceId, sessionId),
      }))
    : [];
  const cancelingSessionIds = new Set(
    cloudCycles
      .filter(({ cycle }) => cycle?.phase === "canceling")
      .map(({ sessionId }) => sessionId)
  );
  for (const sessionId of cancelingDuringPoll) {
    cancelingSessionIds.add(sessionId);
  }
  const anyWorking = visibleSessions.some(
    (session) =>
      session.status === "working" &&
      !cancelingSessionIds.has(session.sessionId)
  );
  const anyError = visibleSessions.some(
    (session) =>
      session.status === "error" &&
      !cancelingSessionIds.has(session.sessionId)
  );
  const cloudWorkPending = cloudCycles.some(({ cycle }) =>
    cloudCycleIsInFlight(cycle)
  );
  const cloudWorkObserved =
    !remote ||
    cloudCycles.some(({ cycle }) => cycle?.phase === "observed");
  if (anyWorking && ws.status !== "running") {
    updateWorkspaceStatus(ws.id, "running");
    if (ws.telegramThreadId) {
      syncWorkspaceTopic(bot.telegram, { ...ws, status: "running" }).catch((err) =>
        forumLog.error(`topic sync error ${ws.telegramThreadId}:`, err)
      );
    }
  }

  if (
    canCompletePolledWorkspace({
      remote,
      sessions: visibleSessions,
      cloudWorkObserved,
      cloudWorkPending,
    }) &&
    (remote || ws.status === "running")
  ) {
    updateWorkspaceStatus(ws.id, "done");
    if (remote) {
      completeObservedCloudCycles(
        sessionInfo.workspaceId,
        cycleSessionIds
      );
    }
    const active = visibleSessions.find(
      (session) => session.sessionId === sessionInfo.sessionId
    );
    const notifyDone = !hasMultipleThreads;
    const doneNotify = notifyDone
      ? sendToWorkspaceTopic(
          ws,
          buildFinishedMessage(ws, active ?? null, false),
          {
            parse_mode: "HTML",
            ...postDoneKeyboard(ws),
          }
        )
      : Promise.resolve();
    doneNotify
      .then(() => {
        if (ws.telegramThreadId) {
          syncWorkspaceTopic(bot.telegram, { ...ws, status: "done" }).catch((err) =>
            forumLog.error(`topic sync error ${ws.telegramThreadId}:`, err)
          );
        }
      })
      .catch((err) => pollerLog.error("notify error:", err));
  } else if (anyError && ws.status !== "failed") {
    updateWorkspaceStatus(ws.id, "failed");
    if (remote) {
      completeCloudCycles(
        sessionInfo.workspaceId,
        visibleSessions
          .filter(
            (session) =>
              session.status === "error" &&
              !cancelingSessionIds.has(session.sessionId)
          )
          .map((session) => session.sessionId)
      );
    }
    const name = ws.conductorWorkspaceName ?? ws.name;
    sendToWorkspaceTopic(ws, `🔴 <b>${esc(name)}</b> encountered an error.`, {
      parse_mode: "HTML",
      ...styledButtons([btn("Archive", `archive:${ws.id}`)]),
    })
      .then(() => {
        if (ws.telegramThreadId) {
          syncWorkspaceTopic(bot.telegram, { ...ws, status: "failed" }).catch((err) =>
            forumLog.error(`topic sync error ${ws.telegramThreadId}:`, err)
          );
        }
      })
      .catch((err) => pollerLog.error("notify error:", err));
  }
}

async function publishCloudReconciliationStatus(
  ws: Workspace,
  html: string,
  includeStopButton: boolean,
  forceNewMessage = false
): Promise<boolean> {
  const keyboard = includeStopButton
    ? styledKeyboard([[btn("Stop", `stop:${ws.id}`)]])
    : {};
  const messageId = Number(ws.telegramMessageId);
  if (!forceNewMessage && Number.isSafeInteger(messageId) && messageId > 0) {
    const edited = await bot.telegram
      .editMessageText(ws.telegramChatId, messageId, undefined, html, {
        parse_mode: "HTML",
        ...keyboard,
      })
      .then(() => true)
      .catch((error) => {
        pollerLog.error(`could not edit recovery status for ${ws.id}:`, error);
        return false;
      });
    if (edited) return true;
  }
  return sendToWorkspaceTopic(ws, html, {
    parse_mode: "HTML",
    ...keyboard,
  })
    .then((replacement) => {
      updateWorkspaceTelegramMessage(ws.id, String(replacement.message_id));
      ws.telegramMessageId = String(replacement.message_id);
      return true;
    })
    .catch((error) => {
      pollerLog.error(`could not post recovery status for ${ws.id}:`, error);
      return false;
    });
}

function formatPendingCloudNotice(notice: PendingCloudNotice): {
  html: string;
  includeStopButton: boolean;
} {
  const count = Math.max(0, notice.count ?? 0);
  switch (notice.kind) {
    case "launch_queued":
      return {
        html: "🟢 ☁️ Cloud launch recovered after restart; its original prompt is queued with the same message identity.",
        includeStopButton: true,
      };
    case "launch_failed":
      return {
        html: `🔴 Cloud launch recovery failed: <pre>${esc(trunc(notice.error ?? "unknown recovery error", 500))}</pre>`,
        includeStopButton: false,
      };
    case "launch_canceled":
      return {
        html: "⏹ Cloud launch cancellation recovered after restart; the provisioned workspace was archived and its prompt was not replayed.",
        includeStopButton: false,
      };
    case "messages_sent":
      return {
        html: `🟢 ☁️ Delivered ${count} recovered Telegram request${count === 1 ? "" : "s"} from the durable outbox.`,
        includeStopButton: true,
      };
    case "messages_suppressed":
      return {
        html: `⏹ Suppressed ${count} recovered Cloud request${count === 1 ? "" : "s"}: ${esc(trunc(notice.error ?? "workspace became unavailable", 500))}.`,
        includeStopButton: false,
      };
    case "messages_failed":
      return {
        html: `🔴 ${count || 1} recovered Cloud request${(count || 1) === 1 ? "" : "s"} could not be delivered safely: <pre>${esc(trunc(notice.error ?? "unknown delivery error", 500))}</pre> Please resend ${((count || 1) === 1) ? "it" : "them"}.`,
        includeStopButton: false,
      };
    case "stop_confirmed":
      return {
        html: "⏹ ☁️ The saved Cloud stop request was confirmed after retrying.",
        includeStopButton: false,
      };
    case "archive_confirmed":
      return {
        html: "📦 ☁️ The saved Cloud archive request was confirmed after retrying.",
        includeStopButton: false,
      };
    case "stop_failed":
      return {
        html: `🔴 The saved Cloud stop request could not be confirmed and was given up on: <pre>${esc(trunc(notice.error ?? "unknown cancellation error", 500))}</pre> Check the workspace in Conductor Cloud before sending more work.`,
        includeStopButton: false,
      };
    case "archive_failed":
      return {
        html: `🔴 The saved Cloud archive request could not be confirmed and was given up on: <pre>${esc(trunc(notice.error ?? "unknown archive error", 500))}</pre> Check the workspace in Conductor Cloud.`,
        includeStopButton: false,
      };
    case "topic_reconcile":
      return { html: "", includeStopButton: false };
  }
}

const pendingCloudNoticePublications = new Map<string, Promise<void>>();

async function publishPendingCloudNotices(ws: Workspace): Promise<void> {
  const existing = pendingCloudNoticePublications.get(ws.id);
  if (existing) return existing;
  const publication = performPendingCloudNoticePublication(ws).finally(() => {
    if (pendingCloudNoticePublications.get(ws.id) === publication) {
      pendingCloudNoticePublications.delete(ws.id);
    }
  });
  pendingCloudNoticePublications.set(ws.id, publication);
  return publication;
}

async function performPendingCloudNoticePublication(
  ws: Workspace
): Promise<void> {
  const allNotices = getPendingCloudNotices(ws.id);
  if (allNotices.length === 0) return;
  const notices = allNotices.filter(
    (notice) => notice.kind !== "topic_reconcile"
  );
  // An uncertain topic state is repaired open before any user-visible notice.
  // Terminal rows remain in deferred-close mode until publication/finalization
  // retires their durable notice, then the post-publication pass closes them.
  await reconcilePendingWorkspaceTopicState(bot.telegram, ws.id);
  if (notices.length === 0) return;
  const grouped: Array<{ notice: PendingCloudNotice; noticeIds: string[] }> = [];
  for (const notice of notices) {
    const previous = grouped.at(-1);
    if (
      notice.kind === "messages_sent" &&
      previous?.notice.kind === notice.kind
    ) {
      previous.notice.count =
        (previous.notice.count ?? 0) + (notice.count ?? 0);
      previous.noticeIds.push(notice.id);
    } else {
      grouped.push({ notice: { ...notice }, noticeIds: [notice.id] });
    }
  }
  Object.assign(ws, getWorkspace(ws.id) ?? ws);
  const entries = grouped.map(({ notice, noticeIds }) => ({
    ...formatPendingCloudNotice(notice),
    noticeKind: notice.kind,
    noticeIds,
  }));
  const chunks = chunkTelegramHtmlEntries(entries);
  const published = await publishCloudNoticeChunks(chunks, {
    publish: (chunk, index) => {
      const includeStopButton =
        chunk.some((entry) => entry.includeStopButton) &&
        ws.status !== "stopped" &&
        ws.status !== "archived" &&
        ws.status !== "failed";
      return publishCloudReconciliationStatus(
        ws,
        chunk.map((entry) => entry.html).join("\n\n"),
        includeStopButton,
        index > 0
      );
    },
    isTerminal: cloudNoticeFinalizesWorkspaceTopic,
    finalize: (kinds) =>
      finalizeWorkspaceTopicForCloudNotices(bot.telegram, ws, kinds),
    acknowledge: (noticeId) =>
      acknowledgePendingCloudNotice(ws.id, noticeId),
  });
  if (published) {
    await reconcilePendingWorkspaceTopicState(bot.telegram, ws.id);
  }
}

function activeSessionFromWorkspaceInfo(
  info: NonNullable<ReturnType<typeof getWorkspaceSessionInfo>>
): ConductorSessionInfo {
  return {
    sessionId: info.sessionId,
    workspaceId: info.workspaceId,
    title: null,
    status: info.status,
    agentType: info.agentType,
    rawAgentType: info.rawAgentType,
    model: info.model,
    claudeSessionId: info.agentSessionId,
    isActive: true,
    createdAt: null,
    backendKind: isRemoteConductorWorkspace(info) ? "cloud-api" : "local",
  };
}

function formatThreadTitle(session: ConductorSessionInfo): string {
  const title = session.title?.trim();
  if (title) return title;
  if (session.isActive) return "Active thread";
  return `Thread ${session.sessionId.slice(0, 8)}`;
}

async function ensureThreadCursor(
  ws: Workspace,
  session: ConductorSessionInfo,
  title: string
): Promise<ThreadCursor> {
  const existing = getThreadCursor(ws.id, session.sessionId);
  if (existing) {
    if (
      session.backendKind === "cloud-api" &&
      (existing.backendKind !== "cloud-api" || !existing.lastMessageId) &&
      canUseConductorCloudApi()
    ) {
      const latest = await getMaxSessionMessageCursor(
        session.sessionId,
        session.backendKind
      );
      return upsertThreadCursor({
        workspaceId: ws.id,
        sessionId: session.sessionId,
        backendKind: session.backendKind,
        lastForwardedRowid: latest.rowid,
        lastMessageId: latest.messageId,
        title,
      });
    }
    if (existing.backendKind === session.backendKind) return existing;
  }

  const baseline =
    session.backendKind === "local" &&
    session.sessionId === ws.conductorSessionId
      ? {
          rowid: ws.lastForwardedMessageRowid,
          messageId: null,
        }
      : await getMaxSessionMessageCursor(
          session.sessionId,
          session.backendKind
        );
  return upsertThreadCursor({
    workspaceId: ws.id,
    sessionId: session.sessionId,
    backendKind: session.backendKind,
    lastForwardedRowid: baseline.rowid,
    lastMessageId: baseline.messageId,
    title,
  });
}

function threadStatusKey(workspaceId: string, sessionId: string): string {
  return `thread_status:${workspaceId}:${sessionId}`;
}

function rememberCloudWorkEvidence(
  conductorWorkspaceId: string,
  session: ConductorSessionInfo,
  messages: SessionMessage[]
): void {
  if (session.backendKind !== "cloud-api") return;
  const key = cloudSessionCycleKey(
    conductorWorkspaceId,
    session.sessionId
  );
  const currentValue = getMetaValue(key);
  const next = advanceCloudSessionCycle({
    cycle: parseCloudSessionCycle(currentValue),
    status: session.status,
    messages,
  });
  const nextValue = next ? encodeCloudSessionCycle(next) : null;
  if (nextValue && nextValue !== currentValue) {
    setMetaValue(key, nextValue);
  }
}

function getCloudSessionCycle(
  conductorWorkspaceId: string,
  sessionId: string
): CloudSessionCycle | null {
  return parseCloudSessionCycle(
    getMetaValue(cloudSessionCycleKey(conductorWorkspaceId, sessionId))
  );
}

function completeObservedCloudCycles(
  conductorWorkspaceId: string,
  sessionIds: Iterable<string>
): void {
  for (const sessionId of sessionIds) {
    const key = cloudSessionCycleKey(conductorWorkspaceId, sessionId);
    if (parseCloudSessionCycle(getMetaValue(key))?.phase === "observed") {
      setMetaValue(
        key,
        encodeCloudSessionCycle({ phase: "complete" })
      );
    }
  }
}

function completeCloudCycles(
  conductorWorkspaceId: string,
  sessionIds: Iterable<string>
): void {
  for (const sessionId of sessionIds) {
    setMetaValue(
      cloudSessionCycleKey(conductorWorkspaceId, sessionId),
      encodeCloudSessionCycle({ phase: "complete" })
    );
  }
}

function rememberThreadStatus(
  ws: Workspace,
  session: ConductorSessionInfo,
  hasMultipleThreads: boolean,
  suppressTerminalNotification = false
): void {
  const status = session.status ?? "unknown";
  const key = threadStatusKey(ws.id, session.sessionId);
  const previous = getMetaValue(key);
  if (previous === status) return;
  setMetaValue(key, status);

  if (
    suppressTerminalNotification ||
    !hasMultipleThreads ||
    previous !== "working"
  ) {
    return;
  }

  if (status === "idle") {
    sendToWorkspaceTopic(ws, buildFinishedMessage(ws, session, true), {
      parse_mode: "HTML",
      ...postDoneKeyboard(ws),
    }).catch((err) => pollerLog.error("thread done notify error:", err));
  } else if (status === "error") {
    const name = ws.conductorWorkspaceName ?? ws.name;
    sendToWorkspaceTopic(
      ws,
      `🔴 <b>${esc(name)}</b> · 🧵 <i>${esc(formatThreadTitle(session))}</i> encountered an error.`,
      {
        parse_mode: "HTML",
        ...styledButtons([btn("Archive", `archive:${ws.id}`)]),
      }
    ).catch((err) => pollerLog.error("thread error notify error:", err));
  }
}

function postDoneKeyboard(ws: Workspace): Record<string, unknown> {
  return styledKeyboard([
    [
      btn("🔍 Review Changes", `postdone:review:${ws.id}`),
      btn("🔀 Generate PR", `postdone:pr:${ws.id}`),
    ],
    [btn("Archive", `archive:${ws.id}`)],
  ]);
}

function buildFinishedMessage(
  ws: Workspace,
  session: ConductorSessionInfo | null,
  includeThread: boolean
): string {
  const name = ws.conductorWorkspaceName ?? ws.name;
  const result = session ? getSessionResultBySessionId(session.sessionId) : null;
  const thread = includeThread && session
    ? ` · 🧵 <i>${esc(formatThreadTitle(session))}</i>`
    : "";

  let msg = `✅ <b>${esc(name)}</b>${thread} finished`;
  if (result) {
    const stats = formatStats(result);
    if (stats) msg += `  <code>${stats}</code>`;
    if (result.resultText) {
      const resultHtml = maybeExpandableQuote(
        markdownToTelegramHtml(trunc(result.resultText, 3200))
      );
      msg += `\n\n${resultHtml}`;
      if (msg.length > TELEGRAM_MAX_TEXT) {
        msg = truncateHtml(msg, TELEGRAM_MAX_TEXT);
      }
    }
  }
  return msg;
}

function syncHiddenConductorWorkspace(ws: Workspace): void {
  archiveWorkspaceLocally(ws.id);
  const name = ws.conductorWorkspaceName ?? ws.name;
  pollerLog.info(`archived hidden Conductor workspace ${name} locally`);
  if (ws.telegramThreadId) {
    deleteWorkspaceTopic(bot.telegram, ws.telegramChatId, ws.telegramThreadId).catch((err) =>
      forumLog.error(`topic delete error ${ws.telegramThreadId}:`, err)
    );
  }
}

function markWorkspaceStaleIfNeeded(ws: Workspace): void {
  if (ws.status !== "starting" && ws.status !== "running") return;
  const createdAt = Date.parse(ws.createdAt);
  if (!Number.isFinite(createdAt)) return;
  if (Date.now() - createdAt < STALE_WORKSPACE_MS) return;

  updateWorkspaceStatus(ws.id, "failed");
  const name = ws.conductorWorkspaceName ?? ws.name;
  const text =
    (ws.conductorWorkspaceName
      ? `⚠️ <b>${esc(name)}</b> lost its Conductor session.\n\n`
      : `⚠️ <b>${esc(name)}</b> never completed its launch — if this was a ☁️ cloud launch, check the bot log for the created workspace id.\n\n`) +
    `<i>Marked failed so it no longer attracts new routed work. No branch or workspace cleanup was performed.</i>`;
  sendToWorkspaceTopic(ws, text, {
    parse_mode: "HTML",
    ...styledButtons([btn("Archive", `archive:${ws.id}`)]),
  })
    .then(() => {
      if (ws.telegramThreadId) {
        syncWorkspaceTopic(bot.telegram, { ...ws, status: "failed" }).catch((err) =>
          forumLog.error(`topic sync error ${ws.telegramThreadId}:`, err)
        );
      }
    })
    .catch((err) => pollerLog.error("stale workspace notify error:", err));
}

// ── Event polling (human_request → Telegram) ────────────────

let eventPollTimer: ReturnType<typeof setInterval> | null = null;
let lastEventId = 0;

function startEventPoller(): void {
  lastEventId = getMaxEventId();

  eventPollTimer = supervisedInterval("event-poller", () => {
      const events = getNewEvents(lastEventId);
      for (const event of events) {
        lastEventId = event.id;
        const ws = getWorkspace(event.workspaceId);

        if (event.type === "human_request") {
          const payload: HumanRequestPayload = JSON.parse(event.payload);
          const chatId = ws?.telegramChatId ?? getOwnerChatId()!;
          const wsName = ws?.conductorWorkspaceName ?? ws?.name ?? "unknown";

          const questionHtml = esc(payload.question);
          let text = `❓ <b>${esc(wsName)}</b> needs your input\n\n`;
          text += expandableQuote(questionHtml, 300);

          if (!payload.options?.length) {
            text += `\n\n<i>Reply to this message with text, a photo, or a voice message.</i>`;
          }

          const buttons = payload.options?.length
            ? styledButtons(
                payload.options.map((opt, i) =>
                  btn(opt, `decide:${payload.decisionId}:${i}`)
                )
              )
            : {};

          const sendFn = ws
            ? sendToWorkspaceTopic(ws, text, { parse_mode: "HTML", ...buttons })
            : bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML", ...buttons });
          sendFn
            .then((sentMsg) => {
              trackDecisionMessage(sentMsg.message_id, payload.decisionId);
            })
            .catch((err) => eventPollerLog.error("send error:", err));
        }

        // ── PR celebration: fireworks when a merge request is submitted ──
        if (event.type === "artifact" && ws) {
          try {
            const artifact: ArtifactPayload = JSON.parse(event.payload);
            if (artifact.type === "pr") {
              refreshWorkspacePr(ws)
                .then(({ record }) =>
                  sendToWorkspaceTopic(ws, formatPrCard(ws, record), {
                    parse_mode: "HTML",
                    ...prKeyboard(record, ws),
                  })
                )
                .catch((err) => eventPollerLog.error("PR verification send error:", err));
            } else if (artifact.type === "file") {
              const wsName = ws.conductorWorkspaceName ?? ws.name ?? "unknown";
              const wsDir = workspaceDirFor(ws);
              const localItem = resolveArtifactFile(artifact, wsDir);
              const captionHtml =
                `📎 <b>${esc(wsName)}</b>: ${esc(artifact.description)}` +
                (artifact.url && /^https?:\/\//i.test(artifact.url)
                  ? `\n🔗 <a href="${esc(artifact.url).replace(/"/g, "&quot;")}">${esc(artifact.url)}</a>`
                  : "");

              if (localItem) {
                sendForwardToWorkspaceTopic(ws, captionHtml, [localItem])
                  .catch((err) => eventPollerLog.error("file artifact send error:", err));
              } else {
                sendToWorkspaceTopic(ws, captionHtml, { parse_mode: "HTML" })
                  .catch((err) => eventPollerLog.error("file artifact send error:", err));
              }
            }
          } catch {
            // Ignore malformed artifact payloads
          }
        }

        // ── Merge congratulation ──────────────────────────────
        if (event.type === "status" && ws) {
          try {
            const payload: StatusPayload = JSON.parse(event.payload);
            const text = `${payload.status} ${payload.message}`.toLowerCase();
            if (
              text.includes("merged") ||
              text.includes("merge complete") ||
              text.includes("successfully merged") ||
              text.includes("pr merged") ||
              text.includes("pull request merged")
            ) {
              const wsName = ws.conductorWorkspaceName ?? ws.name;

              // Find any PR artifact URL for this workspace
              let prLink = "";
              const artifacts = getArtifactEvents(ws.id);
              for (const art of artifacts) {
                try {
                  const artPayload: ArtifactPayload = JSON.parse(art.payload);
                  if (artPayload.type === "pr" && artPayload.url) {
                    prLink = `\n\n🔗 <a href="${esc(artPayload.url)}">${esc(artPayload.description || "View PR")}</a>`;
                    break;
                  }
                } catch { /* skip malformed */ }
              }

              const congratsMsg =
                `🎉🎉🎉\n\n` +
                `<b>${esc(wsName)}</b> — PR merged successfully!` +
                prLink;

              sendToWorkspaceTopic(ws, congratsMsg, { parse_mode: "HTML" })
                .catch((err) => eventPollerLog.error("merge congrats error:", err));
            }
          } catch { /* skip malformed status payload */ }
        }

        if (ws?.telegramThreadId && (
          event.type === "human_request" ||
          event.type === "status" ||
          event.type === "artifact"
        )) {
          syncWorkspaceTopic(bot.telegram, ws).catch((err) =>
            forumLog.error(`topic sync error ${ws.telegramThreadId}:`, err)
          );
        }
      }
  }, POLL_INTERVAL_MS);
}

function formatForwardedMessage(
  workspaceName: string,
  message: SessionMessage,
  workspaceDir: string | null,
  threadTitle: string | null = null
): { text: string; media: InlineMediaItem[] } | null {
  if (message.role !== "assistant") {
    return null;
  }

  const text = extractAssistantText(message.content);
  if (!text) return null;

  // Strip markdown image/link refs that point at local files in the workspace,
  // and ship them as real Telegram attachments instead.
  const { cleanedText, media } = workspaceDir
    ? extractInlineMedia(text, workspaceDir)
    : { cleanedText: text, media: [] as InlineMediaItem[] };

  const headerLine = threadTitle
    ? `🤖 <b>${esc(workspaceName)}</b> · 🧵 <i>${esc(threadTitle)}</i>`
    : `🤖 <b>${esc(workspaceName)}</b>`;
  if (!cleanedText.trim()) {
    // Assistant turn was nothing but file refs. Send media with a bare header
    // (or nothing if there's also no media to ship).
    if (media.length === 0) return null;
    return { text: headerLine, media };
  }

  const formatted = markdownToTelegramHtml(trunc(cleanedText, 3200));
  const body = maybeExpandableQuote(formatted);
  const full = `${headerLine}\n\n${body}`;
  const truncated =
    full.length <= TELEGRAM_MAX_TEXT ? full : truncateHtml(full, TELEGRAM_MAX_TEXT);
  return { text: truncated, media };
}

function workspaceDirFor(ws: Workspace): string | null {
  if (!ws.conductorWorkspaceName) return null;
  const dir = getWorkspaceDir(ws.conductorWorkspaceName, ws.repoPath);
  if (!dir) return null;
  return existsSync(dir) ? dir : null;
}

function resolveArtifactFile(
  artifact: ArtifactPayload,
  wsDir: string | null
): InlineMediaItem | null {
  // Reuse the same shape as text-extracted media: only honor local-file refs,
  // skip remote URLs (they keep their <a href> link rendering above).
  const url = artifact.url ?? "";
  if (!url || !wsDir) return null;
  return resolveWorkspaceMediaFile(url, wsDir);
}

function extractAssistantText(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.type === "result") {
      return null;
    }

    const msgContent = parsed?.message?.content;
    // Extract text parts first
    const text = extractTextParts(msgContent);

    // Also check for AskUserQuestion tool_use (question text is forwarded via
    // the decision/event system, so we just skip these to avoid double display)
    if (!text && Array.isArray(msgContent)) {
      const hasOnlyToolUse = msgContent.every(
        (block: any) =>
          block?.type === "tool_use" || block?.type === "thinking"
      );
      if (hasOnlyToolUse) return null;
    }

    return text || null;
  } catch {
    return null;
  }
}

function extractTextParts(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function logSetupHints(): void {
  lifecycleLog.info("Use /setup for guided private-chat and forum-topic configuration.");
  if (getOwnerChatId() === "0") {
    lifecycleLog.info(
      "Bootstrap mode enabled (OWNER_CHAT_ID=0). /start, /help, and /setup are allowed before auth so the bot can configure the active chat."
    );
  }
}

// Shared with the CLI service status; lives in format.ts.

async function sendBootAnnouncement(
  previous: { lastKnownAliveAt: string | null; lastExitReason: string | null } | undefined,
  bootCount: number
): Promise<void> {
  const ownerChatId = getOwnerChatId();
  if (!ownerChatId || ownerChatId === "0") return;

  const version = BOT_VERSION ?? "unknown";
  const pid = process.pid;
  const now = Date.now();

  const lines = [
    `🟢 <b>conductor-telegram</b> online`,
    `<code>v${esc(version)} · pid ${pid} · boot #${bootCount}</code>`,
  ];

  if (previous?.lastKnownAliveAt) {
    const ago = formatAgo(previous.lastKnownAliveAt, now);
    const reason = previous.lastExitReason
      ? ` (${esc(previous.lastExitReason)})`
      : "";
    lines.push(`Last alive: ${ago}${reason}`);
  }

  try {
    await bot.telegram.sendMessage(ownerChatId, lines.join("\n"), {
      parse_mode: "HTML",
    });
  } catch (err) {
    lifecycleLog.warn("boot announcement failed:", err);
  }
}


// ── Start ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const { previous, bootCount } = initHeartbeat({
    pid: process.pid,
    version: BOT_VERSION,
  });

  runStartupMaintenance();
  const maintenance = startMaintenanceTimer();
  const heartbeat = startHeartbeat();

  installCrashHandlers(() => {
    heartbeat.stop();
    maintenance.stop();
    lanesSchedulerStop?.();
    if (pollTimer) clearInterval(pollTimer);
    if (cloudPollTimer) clearInterval(cloudPollTimer);
    if (eventPollTimer) clearInterval(eventPollTimer);
    try {
      bot.stop("SIGTERM");
    } catch {
      // best-effort
    }
  });

  bot.catch((err: any) => {
    lifecycleLog.error("telegraf error:", err);
  });

  try {
    await syncTelegramCommands();
  } catch (err) {
    lifecycleLog.warn("syncTelegramCommands failed, continuing without it:", err);
  }
  bot.launch();

  // Rename existing forum topics to new "workspace · repo" format
  const topicsWithThreads = getAllThreadedWorkspaces();
  if (topicsWithThreads.length > 0) {
    renameWorkspaceTopics(bot.telegram, topicsWithThreads).catch((err) =>
      lifecycleLog.error("topic rename error:", err)
    );
  }

  startSessionPoller();
  startEventPoller();
  const lanes = startLanesScheduler({
    notify: async (text) => {
      const ownerChatId = getOwnerChatId();
      if (!ownerChatId || ownerChatId === "0") return;
      await bot.telegram.sendMessage(ownerChatId, text);
    },
  });
  lanesSchedulerStop = lanes.stop;
  lifecycleLog.info(
    `connected · polling every ${POLL_INTERVAL_MS / 1000}s · v${BOT_VERSION ?? "?"} · pid ${process.pid} · boot #${bootCount}`
  );
  logSetupHints();

  sendBootAnnouncement(previous, bootCount).catch((err) =>
    lifecycleLog.warn("boot announcement error:", err)
  );
}

main().catch((err) => {
  lifecycleLog.error("fatal:", err);
  process.exit(1);
});
