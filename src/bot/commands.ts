import type { Context, Telegraf } from "telegraf";
import {
  answerPendingStdinDecision,
  archiveConductorWorkspace,
  canUseConductorCloudApi,
  CLOUD_OBSERVE_ONLY_HINT,
  formatAttachmentReference,
  getConductorWorkspaceSessions,
  getLocalSessionMessagesTail,
  getMaxSessionMessageCursor,
  getSessionMessagesAfter,
  getWorkspaceDir,
  getWorkspaceSessionInfo,
  isConductorWorkspaceVisible,
  isKnownCliAuthenticationFailure,
  isRemoteConductorWorkspace,
  launchCloudWorkspace,
  reconcilePendingCloudMessages,
  reconcilePendingCloudTerminalIntent,
  type CloudWorkspaceLaunchResult,
  launchWorkspace,
  launchWorkspaceSession,
  resolveRepoRemoteUrl,
  resolveSafeCloudTakeoverBranch,
  sendToSession,
  stageAttachmentPaths,
  setConductorActiveSession,
  stopConductorAgent,
  type AgentResult,
  type ConductorSessionInfo,
} from "./launcher.js";
import {
  archiveWorkspace,
  acknowledgePendingCloudNotice,
  createWorkspace,
  getActiveWorkspaces,
  getAllWorkspaces,
  getAllWorkspacesForChat,
  getWorkspace,
  getWorkspaceByName,
  getWorkspaceByThreadId,
  getDecision,
  updateWorkspaceStatus,
  updateWorkspaceStatusUnlessTerminal,
  updateWorkspaceTelegramMessage,
  updateWorkspaceConductorName,
  updateWorkspaceConductorBinding,
  updateWorkspaceThreadId,
  answerDecision,
  updateWorkspaceConductorSession,
  updateWorkspaceForwardCursor,
  getWorkspaceMessageTarget,
  getHeartbeat,
  getThreadCursor,
  updateThreadCursor,
  getPrRecordsForWorkspaces,
  consumeMergeIntent,
  clearPendingCloudLaunch,
  createMergeIntent,
  getMergeIntent,
  deleteRepoTopic,
  enqueuePendingCloudMessage,
  getRepoTopic,
  getRepoTopicByThreadId,
  getPendingDecisionsForChat,
  getPendingCloudNotices,
  getPendingCloudLaunch,
  hasPendingCloudTopicFinalizationNotice,
  requestWorkspaceTopicReconciliation,
  getPendingCloudMessages,
  getPendingCloudMessageOutcome,
  getPendingCloudTerminalIntent,
  recordRouteAttempt,
  markPendingCloudLaunchCanceled,
  persistPendingCloudLaunch,
  touchRepoTopic,
  upsertRepoTopic,
  type PendingCloudLaunch,
} from "../store/queries.js";
import {
  createWorkspaceTopic,
  createRepoTopic,
  closeWorkspaceTopic,
  reconcilePendingWorkspaceTopicState,
  reopenWorkspaceTopic,
  syncWorkspaceTopic,
} from "./forum.js";
import {
  ConductorApiError,
  createConductorApiClientFromEnv,
  type ConductorApiClient,
  type ConductorApiProject,
} from "../integrations/conductor-api.js";
import type { Decision, PrRecord, RepoTopic, RouteSource, Workspace } from "../types/index.js";
import { btn, escHtml, formatRelativeTime, statusIcon, styledButtons, styledKeyboard, truncate, truncateHtml, TELEGRAM_MAX_TEXT } from "./format.js";
import { detectExplicitTarget, routeVoiceMessage, routeTextMessage, transcribeVoiceMessage, type RouteResult } from "./ai-router.js";
import { saveConfig, tryLoadConfig, type Config } from "../cli/config.js";
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { canMergePr, mergeWorkspacePr, refreshWorkspacePr } from "./github.js";
import { compactPrBadge, formatPrCard, prKeyboard } from "./pr-ui.js";

const AUTO_ROUTE_FAILURE_MESSAGE =
  "Couldn't auto-route that. Use /run <repo> to start a workspace, or reply inside an existing workspace's topic.";

function describeWorkspaceRejection(
  workspace: Workspace | undefined,
  chatId: string
): string {
  if (!workspace) return "unknown id";
  if (workspace.telegramChatId !== chatId) return "wrong chat";
  if (workspace.status !== "running") return `status=${workspace.status}`;
  return "no conductor name";
}

type RouteExecutionPlannerDeps = {
  getWorkspace: (id: string) => Workspace | undefined;
  getActiveWorkspaces: () => Workspace[];
  resolveRepo: (input: string) => string | null;
};

interface RepoLaunchTarget {
  repoName: string;
  repoPath: string;
}

export type RouteExecutionPlan =
  | { kind: "existing"; workspace: Workspace }
  | { kind: "new"; repoName: string; existingRejection?: string }
  | {
      kind: "unroutable";
      reason: "missing_target" | "unresolvable_repo";
      repoName?: string;
      existingRejection?: string;
    };

/** @internal exported for route executor unit tests; not part of the public bot API. */
export function resolveRouteExecutionPlan(
  chatId: string,
  result: RouteResult,
  deps: RouteExecutionPlannerDeps = { getWorkspace, getActiveWorkspaces, resolveRepo }
): RouteExecutionPlan {
  let existingRejection: string | undefined;

  if (result.action === "existing" && result.workspaceId) {
    const workspace = deps.getWorkspace(result.workspaceId);
    if (
      workspace &&
      workspace.telegramChatId === chatId &&
      workspace.status === "running" &&
      workspace.conductorWorkspaceName
    ) {
      return { kind: "existing", workspace };
    }
    existingRejection = describeWorkspaceRejection(workspace, chatId);
  }

  if (result.repoName) {
    const resolved = deps.resolveRepo(result.repoName);
    if (resolved) {
      if (result.action === "existing" && !result.workspaceId) {
        const candidates = deps
          .getActiveWorkspaces()
          .filter(
            (workspace) =>
              workspace.telegramChatId === chatId &&
              workspace.status === "running" &&
              workspace.conductorWorkspaceName &&
              path.basename(workspace.repoPath) === resolved
          );

        if (candidates.length === 1) {
          return { kind: "existing", workspace: candidates[0] };
        }

        if (candidates.length > 1) {
          existingRejection = "ambiguous running workspaces in repo";
        }
      }
      return { kind: "new", repoName: resolved, existingRejection };
    }
    return {
      kind: "unroutable",
      reason: "unresolvable_repo",
      repoName: result.repoName,
      existingRejection,
    };
  }

  return { kind: "unroutable", reason: "missing_target", existingRejection };
}

/** @internal exported for route executor unit tests; not part of the public bot API. */
export function resolveRepoTopicLaunchTarget(
  topic: Pick<RepoTopic, "repoName" | "repoPath">
): RepoLaunchTarget {
  return {
    repoName: topic.repoName,
    repoPath: topic.repoPath,
  };
}

// Map Telegram message IDs to decision IDs (for reply-based answering)
const messageToDecision = new Map<number, number>();

// Track repo-selection confirmation messages so replies create a workspace directly
const messageToRepoSelection = new Map<string, string>(); // chatId:messageId → repoName
const messageToThreadStart = new Map<
  string,
  { conductorName: string; repoPath: string | null }
>(); // chatId:messageId → target workspace

interface PendingThreadAction {
  chatId: string;
  action: "select" | "new";
  conductorName: string;
  repoPath: string | null;
  workspaceId: string;
  sessionId?: string;
  backendKind?: "local" | "cloud-api";
  createdAt: number;
}

const pendingThreadActions = new Map<string, PendingThreadAction>();

/**
 * Register a Telegram message ID as associated with a decision,
 * so that replies to that message can answer the decision.
 */
export function trackDecisionMessage(messageId: number, decisionId: number): void {
  messageToDecision.set(messageId, decisionId);
}

const TELEGRAM_DOWNLOADS_DIR =
  process.env.TELEGRAM_DOWNLOADS_DIR ??
  `${process.env.HOME}/.conductor-telegram/downloads`;

/**
 * Download a Telegram file locally and return the temporary local path.
 * The file is staged into the target workspace before the agent sees it.
 */
async function downloadTelegramFile(ctx: Context, fileId: string, ext: string = ""): Promise<string> {
  const file = await ctx.telegram.getFile(fileId);
  const token = (ctx.telegram as any).token;
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

  // Determine extension from Telegram's file_path if not provided
  const fileExt = safeExtension(ext || path.extname(file.file_path ?? ""));
  const safeId = fileId.slice(-8).replace(/[^A-Za-z0-9_-]/g, "");
  const localName = `${Date.now()}-${safeId}${fileExt}`;

  mkdirSync(TELEGRAM_DOWNLOADS_DIR, { recursive: true });
  const localPath = path.join(TELEGRAM_DOWNLOADS_DIR, localName);
  if (
    path.dirname(path.resolve(localPath)) !==
    path.resolve(TELEGRAM_DOWNLOADS_DIR)
  ) {
    throw new Error("Refusing to stage a download outside the downloads directory");
  }

  const data = await fetchBuffer(url);
  writeFileSync(localPath, data);
  return localPath;
}

/**
 * Constrain a Telegram-supplied extension to something that cannot steer the
 * download path. `mime_type` is attacker-controlled and reaches here verbatim,
 * so a value like `application/../../../.claude/settings.json` would otherwise
 * be normalised by path.join into an arbitrary file write.
 */
export function safeExtension(ext: string): string {
  return /^\.[A-Za-z0-9][A-Za-z0-9+._-]{0,15}$/.test(ext.trim())
    ? ext.trim()
    : ".bin";
}

function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchBuffer(res.headers.location!).then(resolve, reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

const CONDUCTOR_REPOS_DIR =
  process.env.CONDUCTOR_REPOS_DIR ??
  `${process.env.HOME}/conductor/repos`;

function getRepoList(): string[] {
  try {
    const entries = readdirSync(CONDUCTOR_REPOS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function resolveRepo(input: string): string | null {
  const repos = getRepoList();
  // Try as a number first
  const num = parseInt(input, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= repos.length) {
    return repos[num - 1];
  }
  // Try exact match
  if (repos.includes(input)) return input;
  // Try prefix match
  const matches = repos.filter((r) => r.startsWith(input));
  if (matches.length === 1) return matches[0];
  return null;
}

interface WorkspaceTarget {
  conductorName: string;
  trackedWorkspace: Workspace | null;
  repoPath: string | null;
  repoName: string | null;
  targetBranch: string | null;
  sessionId: string | null;
}

interface SkillRoute {
  description: string;
  skill: string;
}

export interface TelegramCommandDefinition {
  command: string;
  description: string;
}

interface WellKnownSkill {
  /** Slash command name (telegram-safe: lowercase letters, digits, underscores) */
  command: string;
  /** Actual skill name passed to the agent (may use hyphens) */
  skill: string;
  /** Shown in the slash menu */
  description: string;
}

const WELL_KNOWN_SKILLS: WellKnownSkill[] = [
  { command: "ship", skill: "ship", description: "Ship: tests, review, bump, PR, deploy" },
  { command: "qa", skill: "qa", description: "QA test the app and fix bugs" },
  { command: "investigate", skill: "investigate", description: "Root-cause investigation of a bug" },
  { command: "retro", skill: "retro", description: "Weekly engineering retrospective" },
  { command: "health", skill: "health", description: "Code quality / health dashboard" },
  { command: "checkpoint", skill: "checkpoint", description: "Save or resume a checkpoint" },
  { command: "document_release", skill: "document-release", description: "Update docs after shipping" },
  { command: "office_hours", skill: "office-hours", description: "YC office-hours mode" },
  { command: "design_review", skill: "design-review", description: "Designer's-eye visual QA" },
];

const TELEGRAM_COMMANDS: TelegramCommandDefinition[] = [
  { command: "setup", description: "Check setup and apply this chat" },
  { command: "run", description: "Start a Cloud-first workspace run" },
  { command: "cloud", description: "Start a ☁️ cloud workspace via the Conductor API" },
  { command: "projects", description: "List ☁️ cloud projects and workspaces" },
  { command: "fleet", description: "☁️ cloud activity report (last 24h)" },
  { command: "rename", description: "Rename a ☁️ cloud workspace" },
  { command: "renamethread", description: "Rename a ☁️ cloud thread" },
  { command: "review", description: "Start a review session for a workspace" },
  { command: "send", description: "Send a follow-up to a workspace" },
  { command: "threads", description: "List or switch Conductor threads" },
  { command: "skills", description: "List available skills" },
  { command: "skill", description: "Invoke a workspace skill by name" },
  { command: "gstack", description: "Ask the agent to use GStack skills" },
  ...WELL_KNOWN_SKILLS.map((s) => ({
    command: s.command,
    description: s.description,
  })),
  { command: "workspaces", description: "List tracked workspaces" },
  { command: "prs", description: "Show PR and branch ship status" },
  { command: "ship_status", description: "Show PR and branch ship status" },
  { command: "decisions", description: "Show pending agent questions" },
  { command: "status", description: "Show active workspace status" },
  { command: "stop", description: "Stop a running workspace" },
  { command: "repos", description: "List available repos" },
  { command: "ping", description: "Bot liveness (uptime, heartbeat, version)" },
  { command: "help", description: "Show bot help" },
];

export function getTelegramCommands(): TelegramCommandDefinition[] {
  return TELEGRAM_COMMANDS;
}

/**
 * Parse a `#skill` mention from a message. Matches any whitespace-delimited
 * hashtag whose body looks like a skill name (letters/digits/underscore/hyphen).
 * Underscores are normalized to hyphens to match canonical skill names
 * (e.g. `#design_review` → `design-review`). Returns the skill plus the
 * message with the hashtag removed, or null if no skill tag is present.
 */
function parseSkillMention(text: string): { skill: string; remaining: string } | null {
  const match = text.match(/(?:^|\s)#([a-z][a-z0-9_-]{0,48})(?=\s|[.,!?;:)]|$)/i);
  if (!match || typeof match.index !== "number") return null;
  const raw = match[1].toLowerCase();
  const skill = raw.replace(/_/g, "-");
  const start = match.index + (match[0].startsWith("#") ? 0 : 1);
  const end = match.index + match[0].length;
  const remaining = (text.slice(0, start) + " " + text.slice(end))
    .replace(/\s+/g, " ")
    .trim();
  return { skill, remaining };
}

function findTrackedWorkspace(
  identifier: string,
  chatId?: string
): Workspace | undefined | "ambiguous" {
  let workspace = getWorkspace(identifier);
  if (workspace) {
    if (chatId && workspace.telegramChatId !== chatId) return undefined;
    return workspace;
  }

  const all = chatId ? getAllWorkspacesForChat(chatId, 100) : getAllWorkspaces(100);
  const matches = all.filter((ws) => ws.conductorWorkspaceName === identifier);
  if (matches.length > 1) return "ambiguous";
  return matches[0];
}

function resolveWorkspaceTarget(
  identifier: string,
  opts: { chatId?: string; repoPath?: string | null; sessionId?: string | null } = {}
): WorkspaceTarget | null | "ambiguous" {
  const tracked = findTrackedWorkspace(identifier, opts.chatId);
  if (tracked === "ambiguous") return "ambiguous";
  const trackedWorkspace = tracked ?? null;
  const conductorName = trackedWorkspace?.conductorWorkspaceName ?? identifier;
  const repoPath = opts.repoPath ?? trackedWorkspace?.repoPath ?? null;
  const sessionInfo = getWorkspaceSessionInfo(
    conductorName,
    repoPath,
    trackedWorkspace
  );
  if (!sessionInfo) {
    return null;
  }
  if (!isConductorWorkspaceVisible(sessionInfo)) {
    return null;
  }

  return {
    conductorName,
    trackedWorkspace,
    repoPath: sessionInfo.repoPath,
    repoName: sessionInfo.repoName,
    targetBranch: sessionInfo.targetBranch,
    sessionId: opts.sessionId ?? null,
  };
}

function splitHead(text: string): [string, string] {
  const trimmed = text.trim();
  if (!trimmed) {
    return ["", ""];
  }
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return [trimmed, ""];
  }
  return [trimmed.slice(0, spaceIdx), trimmed.slice(spaceIdx + 1).trim()];
}

function getReplyWorkspaceTarget(ctx: Context): WorkspaceTarget | null {
  const chatId = ctx.chat?.id?.toString();
  if (!chatId) {
    return null;
  }
  const repliedTarget = getReplyTargetWorkspace(ctx, chatId);
  const conductorName = repliedTarget?.workspace.conductorWorkspaceName;
  if (!conductorName) {
    return null;
  }
  const repliedWorkspace = repliedTarget.workspace;
  const target = resolveWorkspaceTarget(conductorName, {
    chatId,
    repoPath: repliedWorkspace.repoPath,
    sessionId: repliedTarget.sessionId,
  });
  return target === "ambiguous" ? null : target;
}

function getThreadWorkspaceTarget(ctx: Context): WorkspaceTarget | null {
  const chatId = ctx.chat?.id?.toString();
  const threadId = (ctx.message as any)?.message_thread_id;
  if (!chatId || !threadId) return null;

  const threadWorkspace = getWorkspaceByThreadId(chatId, threadId);
  if (!threadWorkspace?.conductorWorkspaceName) return null;

  const target = resolveWorkspaceTarget(threadWorkspace.conductorWorkspaceName, {
    chatId,
    repoPath: threadWorkspace.repoPath,
  });
  return target === "ambiguous" ? null : target;
}

function getContextualTarget(ctx: Context): WorkspaceTarget | null {
  return getReplyWorkspaceTarget(ctx) ?? getThreadWorkspaceTarget(ctx);
}

function getThreadRepoTopic(ctx: Context, chatId: string): RepoTopic | null {
  const threadId = (ctx.message as any)?.message_thread_id;
  if (!threadId) return null;
  return getRepoTopicByThreadId(chatId, threadId) ?? null;
}

function getWorkspaceDirectory(target: WorkspaceTarget): string | null {
  return getWorkspaceDir(target.conductorName, target.repoPath);
}

function parseSkillRoutes(text: string): SkillRoute[] {
  const matches = [...text.matchAll(/^- (.+?)\s+→\s+invoke\s+([a-z0-9._-]+)/gim)];
  return matches.map((match) => ({
    description: match[1].trim(),
    skill: match[2].trim(),
  }));
}

function getWorkspaceSkillRoutes(target: WorkspaceTarget): SkillRoute[] {
  const workspaceDir = getWorkspaceDirectory(target);
  if (!workspaceDir) {
    return [];
  }

  for (const fileName of ["CLAUDE.md", "AGENTS.md"]) {
    const filePath = path.join(workspaceDir, fileName);
    if (!existsSync(filePath)) {
      continue;
    }

    const routes = parseSkillRoutes(readFileSync(filePath, "utf8"));
    if (routes.length > 0) {
      return routes;
    }
  }

  return [];
}

function buildReviewPrompt(extraInstructions: string): string {
  const lines = [
    "Prioritize concrete bugs, regressions, risky assumptions, and missing tests.",
    "Present findings first with file references when possible.",
    "Keep the summary brief after the findings.",
  ];

  if (extraInstructions.trim()) {
    lines.push("", `Additional instructions:\n${extraInstructions.trim()}`);
  }

  return lines.join("\n");
}

function buildSkillPrompt(skill: string, extraInstructions: string): string {
  const normalizedSkill = skill.trim();
  if (normalizedSkill === "gstack") {
    return buildGstackPrompt(extraInstructions);
  }

  const lines = [`Invoke the ${normalizedSkill} skill for this workspace.`];
  if (extraInstructions.trim()) {
    lines.push("", `Additional instructions:\n${extraInstructions.trim()}`);
  }
  return lines.join("\n");
}

/**
 * If `text` contains a `#skill` mention, rewrite it as a skill-invocation
 * prompt. Otherwise return the text unchanged.
 */
function applySkillHashtag(text: string): string {
  const mention = parseSkillMention(text);
  if (!mention) return text;
  return buildSkillPrompt(mention.skill, mention.remaining);
}

function buildGstackPrompt(extraInstructions: string): string {
  const lines = [
    "Use the GStack skills available in this workspace.",
    "GStack provides Claude Code skills such as /ship, /qa, /browse, /review, /health, /investigate, /design-review, and others.",
  ];

  if (extraInstructions.trim()) {
    lines.push(
      "Choose the appropriate skill based on the instructions below.",
      "",
      `Additional instructions:\n${extraInstructions.trim()}`
    );
  } else {
    lines.push(
      "List the available GStack skills in this workspace and ask which one to run.",
      "Do NOT invoke any skill automatically without explicit instructions."
    );
  }

  lines.push(
    "",
    "If no GStack skills are available, explain what is missing and stop."
  );

  return lines.join("\n");
}

function ensureTrackedWorkspace(
  ctx: Context,
  target: WorkspaceTarget,
  prompt: string
): Workspace | null {
  if (target.trackedWorkspace) {
    return target.trackedWorkspace;
  }

  const repoPath =
    target.repoPath ??
    (target.repoName ? path.join(CONDUCTOR_REPOS_DIR, target.repoName) : null);
  if (!repoPath) {
    return null;
  }

  const workspace = createWorkspace({
    name: `${target.conductorName}-${Date.now()}`,
    prompt,
    repoPath,
    telegramChatId: ctx.chat!.id.toString(),
  });
  updateWorkspaceConductorName(workspace.id, target.conductorName);
  return workspace;
}

function persistConductorLaunchBinding(
  workspaceId: string,
  launch: {
    workspaceId: string;
    sessionId: string;
    backendKind: "local" | "cloud-api";
    initialCursorRowid: number;
    initialCursorMessageId: string | null;
  }
): void {
  updateWorkspaceConductorBinding(workspaceId, {
    workspaceId: launch.workspaceId,
    sessionId: launch.sessionId,
    backendKind: launch.backendKind,
  });
  updateWorkspaceForwardCursor(workspaceId, launch.initialCursorRowid);
  updateThreadCursor(
    workspaceId,
    launch.sessionId,
    launch.initialCursorRowid,
    null,
    launch.initialCursorMessageId,
    launch.backendKind
  );
}

function commitSessionLaunchResult(
  trackedWorkspace: Workspace,
  conductorName: string,
  launch: {
    workspaceId: string;
    sessionId: string;
    backendKind: "local" | "cloud-api";
    initialCursorRowid: number;
    initialCursorMessageId: string | null;
  }
): Workspace | null {
  if (launch.backendKind === "cloud-api") {
    // The durable launch saga owns Cloud binding/cursor/status finalization.
    // Re-read it and never overwrite a Stop/Archive that won after return.
    const durable = getWorkspace(trackedWorkspace.id);
    if (
      !durable ||
      durable.status === "stopped" ||
      durable.status === "archived" ||
      durable.conductorBackendKind !== "cloud-api" ||
      durable.conductorWorkspaceId !== launch.workspaceId ||
      durable.conductorSessionId !== launch.sessionId
    ) {
      return null;
    }
    return durable;
  }
  updateWorkspaceConductorName(trackedWorkspace.id, conductorName);
  persistConductorLaunchBinding(trackedWorkspace.id, launch);
  updateWorkspaceStatus(trackedWorkspace.id, "running");
  return getWorkspace(trackedWorkspace.id) ?? {
    ...trackedWorkspace,
    conductorWorkspaceName: conductorName,
    conductorWorkspaceId: launch.workspaceId,
    conductorSessionId: launch.sessionId,
    conductorBackendKind: launch.backendKind,
    status: "running",
  };
}

function workspaceTopicNeedsResume(workspace: Workspace): boolean {
  return Boolean(
    workspace.telegramThreadId &&
      (workspace.status === "done" ||
        workspace.status === "stopped" ||
        workspace.status === "failed")
  );
}

async function reopenWorkspaceTopicBeforeActivity(
  ctx: Context,
  workspace: Workspace,
  needed: boolean
): Promise<void> {
  if (!needed || !workspace.telegramThreadId) return;
  await reopenWorkspaceTopic(
    ctx.telegram,
    workspace.telegramChatId,
    workspace.telegramThreadId
  );
}

/**
 * Reopen again after a successful resume. A durable terminal publisher may
 * have closed and acknowledged its notice between the handler's first reopen
 * and the launcher's atomic activity gate.
 */
async function restoreWorkspaceTopicAfterActivity(
  ctx: Context,
  workspace: Workspace,
  needed: boolean
): Promise<void> {
  if (!needed || !workspace.telegramThreadId) return;
  requestWorkspaceTopicReconciliation(workspace.id);
  try {
    const status = await reconcilePendingWorkspaceTopicState(
      ctx.telegram,
      workspace.id
    );
    if (status === "pending") {
      console.log(
        `[forum] topic state changed repeatedly for ${workspace.id}; queued a retry`
      );
    }
  } catch (error) {
    console.error(
      `[forum] topic reconciliation queued for ${workspace.telegramThreadId}:`,
      error
    );
  }
}

function persistProvisionedCloudLaunch(
  workspace: Workspace,
  pending: PendingCloudLaunch
): string {
  persistPendingCloudLaunch(workspace.id, pending);
  workspace.conductorWorkspaceName = pending.workspaceId;
  workspace.conductorWorkspaceId = pending.workspaceId;
  workspace.conductorSessionId = pending.sessionId;
  workspace.conductorBackendKind = "cloud-api";
  workspace.status = "starting";
  return workspace.id;
}

async function sendPromptToTarget(
  ctx: Context,
  target: WorkspaceTarget,
  prompt: string
): Promise<void> {
  if (target.trackedWorkspace) {
    await sendMessageToWorkspace(ctx, target.trackedWorkspace, prompt, [], {
      sessionId: target.sessionId,
    });
    return;
  }

  await ctx.reply(`Sending message to <b>${escHtml(target.conductorName)}</b>...\n\n<i>${escHtml(truncate(prompt, 200))}</i>`, {
    parse_mode: "HTML",
  });

  const result = await sendToSession(target.conductorName, prompt, [], {
    repoPath: target.repoPath,
    sessionId: target.sessionId,
  });
  if ("error" in result) {
    await ctx.reply(`Failed: ${escHtml(result.error)}`, { parse_mode: "HTML" });
    return;
  }

  await ctx.reply(
    `📨 Message sent to <b>${escHtml(target.conductorName)}</b>:\n<i>${escHtml(truncate(prompt, 200))}</i>`,
    { parse_mode: "HTML" }
  );
}

export function registerCommands(bot: Telegraf<Context>): void {
  bot.start(handleSetup);
  bot.command("setup", handleSetup);
  bot.command("run", handleRun);
  bot.command("cloud", handleCloud);
  bot.command("projects", handleProjects);
  bot.command("fleet", handleFleet);
  bot.command("rename", handleRename);
  bot.command("renamethread", handleRenameThread);
  bot.command("workspaces", handleWorkspaces);
  bot.command("prs", handlePrs);
  bot.command("ship_status", handlePrs);
  bot.command("decisions", handleDecisions);
  bot.command("status", handleStatus);
  bot.command("stop", handleStop);
  bot.command("repos", handleRepos);
  bot.command("send", handleSend);
  bot.command("threads", handleThreads);
  bot.command("review", handleReview);
  bot.command("skills", handleSkills);
  bot.command("skill", handleSkill);
  bot.command("gstack", handleGstack);
  for (const spec of WELL_KNOWN_SKILLS) {
    bot.command(spec.command, (ctx) => handleWellKnownSkillCommand(ctx, spec));
  }
  bot.command("ping", handlePing);
  bot.command("help", handleHelp);

  // Inline button callbacks
  bot.action(/^stop:(.+)$/, handleStopCallback);
  bot.action(/^open:(.+)$/, handleOpenCallback);
  bot.action(/^decide:(\d+):(.+)$/, handleDecisionCallback);
  bot.action(/^run:(\d+)$/, handleRunRepoCallback);
  bot.action(/^repotopic:(\d+)$/, handleRepoTopicCallback);
  bot.action(/^routeconfirm:([a-f0-9]+):(yes|cancel)$/, handleRouteConfirmCallback);
  bot.action(/^setup:apply:(\d+)$/, handleSetupApplyCallback);
  bot.action(/^thread:(set|new):([a-f0-9]+)$/, handleThreadCallback);
  bot.action(/^postdone:(review|pr):(.+)$/, handlePostDoneCallback);
  bot.action(/^pr:(refresh|fix|merge):(.+)$/, handlePrCallback);
  bot.action(/^pr:mergeconfirm:([a-f0-9]+)$/, handlePrMergeConfirmCallback);
  bot.action(/^archive:(.+)$/, handleArchiveCallback);

  // Media and text handlers
  bot.on("photo", handlePhotoMessage);
  bot.on("voice", handleVoiceMessage);
  bot.on("document", (ctx) => handleAttachmentMessage(ctx, "document"));
  bot.on("audio", (ctx) => handleAttachmentMessage(ctx, "audio"));
  bot.on("video", (ctx) => handleAttachmentMessage(ctx, "video"));
  bot.on("animation", (ctx) => handleAttachmentMessage(ctx, "animation"));
  bot.on("text", handleTextMessage);
}

interface SetupDiagnostics {
  botCanManageTopics: boolean | null;
  botStatus: string | null;
  botUsername: string | null;
  chatId: string;
  chatTitle: string | null;
  chatType: string;
  configuredOwnerChatId: string | null;
  configuredOwnerUserId: string | null;
  isForum: boolean | null;
  userId: string;
}

interface SetupResponse {
  message: string;
  showApplyButton: boolean;
}

async function getSetupDiagnostics(ctx: Context): Promise<SetupDiagnostics> {
  const chatId = ctx.chat?.id?.toString() ?? "unknown";
  const userId = ctx.from?.id?.toString() ?? "unknown";
  const chatType = ctx.chat?.type ?? "unknown";

  let chatTitle: string | null = null;
  let isForum: boolean | null = null;
  let botUsername: string | null = null;
  let botStatus: string | null = null;
  let botCanManageTopics: boolean | null = null;

  const chatInfo = await (ctx.chat ? ctx.getChat().catch(() => ctx.chat as any) : Promise.resolve(null));
  if (chatInfo) {
    chatTitle = (chatInfo as any).title ?? null;
    if (typeof (chatInfo as any).is_forum === "boolean") {
      isForum = (chatInfo as any).is_forum;
    }
  }

  const botInfo = await ctx.telegram.getMe().catch(() => null);
  if (botInfo) {
    botUsername = botInfo.username ?? null;
    if (ctx.chat) {
      const member = await ctx.telegram
        .getChatMember(ctx.chat.id, botInfo.id)
        .catch(() => null);
      if (member) {
        botStatus = (member as any).status ?? null;
        if ("can_manage_topics" in (member as any)) {
          botCanManageTopics = Boolean((member as any).can_manage_topics);
        }
      }
    }
  }

  return {
    botCanManageTopics,
    botStatus,
    botUsername,
    chatId,
    chatTitle,
    chatType,
    configuredOwnerChatId: process.env.OWNER_CHAT_ID ?? null,
    configuredOwnerUserId: process.env.OWNER_USER_ID ?? null,
    isForum,
    userId,
  };
}

function buildRuntimeConfigSnapshot(): Config {
  const loaded = tryLoadConfig();
  if (loaded) {
    return loaded;
  }

  return {
    version: 1,
    botToken: process.env.BOT_TOKEN ?? "",
    ownerChatId: process.env.OWNER_CHAT_ID ?? "",
    ownerUserId: process.env.OWNER_USER_ID || undefined,
    dbPath: process.env.DB_PATH || undefined,
    conductorDbPath: process.env.CONDUCTOR_DB_PATH || undefined,
    conductorWorkspacesDir: process.env.CONDUCTOR_WORKSPACES_DIR || undefined,
    conductorReposDir: process.env.CONDUCTOR_REPOS_DIR || undefined,
    downloadsDir: process.env.TELEGRAM_DOWNLOADS_DIR || undefined,
    claudeBin: process.env.CLAUDE_BIN || undefined,
    codexBin: process.env.CODEX_BIN || undefined,
    permissionMode: process.env.TELEGRAM_AGENT_PERMISSION_MODE || undefined,
    defaultAgentType: process.env.TELEGRAM_DEFAULT_AGENT_TYPE || undefined,
    defaultModel: process.env.TELEGRAM_DEFAULT_MODEL || undefined,
    reviewAgentType: process.env.TELEGRAM_REVIEW_AGENT_TYPE || undefined,
    reviewModel: process.env.TELEGRAM_REVIEW_MODEL || undefined,
  };
}

function applySetupConfiguration(diag: SetupDiagnostics): void {
  const config = buildRuntimeConfigSnapshot();
  config.ownerChatId = diag.chatId;
  config.ownerUserId = diag.chatType === "private" ? undefined : diag.userId;
  saveConfig(config);

  process.env.OWNER_CHAT_ID = diag.chatId;
  if (diag.chatType === "private") {
    delete process.env.OWNER_USER_ID;
  } else {
    process.env.OWNER_USER_ID = diag.userId;
  }
}

function buildSetupResponse(diag: SetupDiagnostics): SetupResponse {
  const isPrivateChat = diag.chatType === "private";
  const currentIds = isPrivateChat
    ? `Current private chat ID: <code>${escHtml(diag.chatId)}</code>\nYour Telegram user ID: <code>${escHtml(diag.userId)}</code>`
    : `${diag.chatTitle ? `Current chat: <b>${escHtml(diag.chatTitle)}</b>\n` : ""}Current chat ID: <code>${escHtml(diag.chatId)}</code>\nYour Telegram user ID: <code>${escHtml(diag.userId)}</code>`;
  const configLines = [
    `Configured OWNER_CHAT_ID: <code>${escHtml(diag.configuredOwnerChatId ?? "unset")}</code>`,
    `Configured OWNER_USER_ID: <code>${escHtml(diag.configuredOwnerUserId ?? "unset")}</code>`,
  ];

  if (diag.botStatus) {
    configLines.push(`Bot role in this chat: <code>${escHtml(diag.botStatus)}</code>`);
  }
  if (!isPrivateChat && diag.chatType === "supergroup") {
    configLines.push(
      `Topics enabled: <code>${diag.isForum === true ? "yes" : diag.isForum === false ? "no" : "unknown"}</code>`
    );
  }
  if (!isPrivateChat && diag.botCanManageTopics !== null) {
    configLines.push(
      `Bot can manage topics: <code>${diag.botCanManageTopics ? "yes" : "no"}</code>`
    );
  }

  const remainingSteps: string[] = [];
  const currentChatConfigured = diag.configuredOwnerChatId === diag.chatId;
  const currentUserConfigured = diag.configuredOwnerUserId === diag.userId;
  const canApplyCurrentChat =
    !currentChatConfigured ||
    (isPrivateChat && !!diag.configuredOwnerUserId) ||
    (!isPrivateChat && !currentUserConfigured);

  if (isPrivateChat) {
    if (!currentChatConfigured) {
      remainingSteps.push("Apply this private chat as the bot owner chat.");
    }
    if (diag.configuredOwnerUserId) {
      remainingSteps.push("Clear the group-only owner user setting for private-chat mode.");
    }
  } else {
    if (!currentChatConfigured) {
      remainingSteps.push("Apply this chat as the active owner chat.");
    }
    if (!currentUserConfigured) {
      remainingSteps.push("Apply your current Telegram user as the owner for this chat.");
    }
    if (diag.chatType !== "supergroup") {
      remainingSteps.push("Use a Telegram <b>supergroup</b> for forum-topic mode.");
    } else if (diag.isForum === false) {
      remainingSteps.push(
        "Enable <b>Topics</b> in this supergroup if you want one topic per workspace."
      );
    }
    if (diag.botStatus && diag.botStatus !== "administrator" && diag.botStatus !== "creator") {
      remainingSteps.push("Promote the bot to admin in this chat.");
    }
    if (diag.isForum === true && diag.botCanManageTopics === false) {
      remainingSteps.push("Grant the bot permission to manage topics.");
    }
  }

  const summary =
    remainingSteps.length === 0
      ? isPrivateChat
        ? "This private chat is already configured. No unconfigure step is needed."
        : "This chat is already configured. No unconfigure step is needed."
      : isPrivateChat
        ? "This private chat is reachable. Only the remaining items below still need changes."
        : "The bot is already in this chat, so you do not need to create or re-add anything. Only the remaining items below still need changes.";

  const nextSteps =
    remainingSteps.length === 0
      ? isPrivateChat
        ? "Next: use <code>/repos</code> or <code>/run</code> here."
        : diag.chatType === "supergroup" && diag.isForum === true
          ? "Next: use <code>/repos</code> or <code>/run</code>. New workspaces will get their own topics."
          : "Next: use <code>/repos</code> or <code>/run</code>. Group chat mode works now; forum topics are optional."
      : `<b>Remaining steps</b>\n${remainingSteps.map((step, i) => `${i + 1}. ${step}`).join("\n")}${canApplyCurrentChat ? "\n\nTap <b>Use This Chat</b> below and the bot will update the chat/user config automatically." : ""}`;

  const commandHint =
    !isPrivateChat && diag.botUsername
      ? `\nIf commands are flaky in this group, use <code>/setup@${escHtml(diag.botUsername)}</code>.`
      : "";

  return {
    message: `<b>Conductor Telegram setup check</b>

${currentIds}

<b>Current config</b>
${configLines.join("\n")}

<b>Status</b>
${summary}

${nextSteps}${commandHint}`,
    showApplyButton: canApplyCurrentChat,
  };
}

// ── /run <repo> <prompt> ────────────────────────────────────

async function handleRun(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const args = text.replace(/^\/run\s*/, "").trim();

  if (!args) {
    const repos = getRepoList();
    const repoLines = repos.map((r, i) => `${i + 1}. <code>${escHtml(r)}</code>`).join("\n");
    await ctx.reply(
      `Usage: /run &lt;repo&gt; &lt;prompt&gt;\n\nRepos (use number or name):\n${repoLines}\n\nExample:\n<code>/run 1 Fix the auth bug</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // Parse repo identifier and prompt
  const spaceIdx = args.indexOf(" ");
  if (spaceIdx === -1) {
    await ctx.reply("Please provide both a repo and a prompt.\n\nExample: /run 1 Fix the auth bug");
    return;
  }

  const repoInput = args.slice(0, spaceIdx);
  const prompt = args.slice(spaceIdx + 1).trim();

  const repoName = resolveRepo(repoInput);
  if (!repoName) {
    const repos = getRepoList();
    const repoLines = repos.map((r, i) => `${i + 1}. <code>${escHtml(r)}</code>`).join("\n");
    await ctx.reply(
      `Repo "${escHtml(repoInput)}" not found.\n\nAvailable repos:\n${repoLines}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  await startWorkspaceFromMessage(ctx, repoName, prompt);
}

async function startWorkspaceFromMessage(
  ctx: Context,
  repoName: string,
  prompt: string,
  attachmentSourcePaths: string[] = []
): Promise<void> {
  await startWorkspaceForRepo(
    ctx,
    { repoName, repoPath: path.join(CONDUCTOR_REPOS_DIR, repoName) },
    prompt,
    attachmentSourcePaths
  );
}

/** The persisted launch fields every tracked-workspace start must produce. */
interface TrackedLaunchBinding {
  workspaceId: string;
  sessionId: string;
  backendKind: "local" | "cloud-api";
  initialCursorRowid: number;
  initialCursorMessageId: string | null;
  workspaceName: string;
}

/**
 * Shared chat scaffolding for starting a tracked workspace: create the bot-DB
 * record, give it a forum topic when the chat supports one (any topic failure
 * other than "no forum" is fatal), post the starting message, run the
 * supplied launch, and persist its binding. Callers provide the user-facing
 * copy and handle launch-specific follow-up via the returned handles.
 */
async function startTrackedWorkspace<S extends TrackedLaunchBinding>(
  ctx: Context,
  input: {
    displayName: string;
    recordName: string;
    repoPath: string;
    prompt: string;
    startingHtml: string;
    failedHtml: (error: string) => string;
    successHtml: (launched: S) => string;
    launch: (
      workspace: Workspace
    ) => Promise<S | { error: string; reason?: string }>;
  }
): Promise<{ workspace: Workspace; launched: S | null }> {
  const chatId = ctx.chat!.id;
  const chatIdStr = chatId.toString();

  let workspace = createWorkspace({
    name: input.recordName,
    prompt: input.prompt,
    repoPath: input.repoPath,
    telegramChatId: chatIdStr,
  });

  const topicResult = await createWorkspaceTopic(
    ctx.telegram,
    chatIdStr,
    input.displayName,
    workspace.name
  );
  let threadId: number | undefined;
  if (topicResult.ok) {
    threadId = topicResult.threadId;
  } else if (topicResult.kind !== "no_forum") {
    const explanation =
      topicResult.kind === "no_permission"
        ? "The bot needs the <b>Manage Topics</b> admin permission in this chat."
        : `Telegram returned: <code>${escHtml(topicResult.message)}</code>`;
    updateWorkspaceStatus(workspace.id, "failed");
    await ctx.reply(
      `⚠️ Could not create a forum topic for <b>${escHtml(input.displayName)}</b>. ${explanation}\n\nWorkspace was not started.`,
      { parse_mode: "HTML" }
    );
    return { workspace, launched: null };
  }
  if (threadId) {
    updateWorkspaceThreadId(workspace.id, threadId);
    workspace.telegramThreadId = threadId;
  }

  const threadOpts = threadId ? { message_thread_id: threadId } : {};
  const msg = await ctx.telegram.sendMessage(chatId, input.startingHtml, {
    parse_mode: "HTML",
    ...threadOpts,
  });
  updateWorkspaceTelegramMessage(workspace.id, msg.message_id.toString());

  const noticeIdsBeforeLaunch = snapshotCloudNoticeIds(workspace.id);
  const result = await input.launch(workspace);

  if ("error" in result) {
    if (
      result.reason === "cloud_launch_canceled" ||
      result.reason === "cloud_launch_cancel_pending"
    ) {
      await publishTrackedWorkspaceStatus(
        ctx,
        workspace,
        msg,
        result.reason === "cloud_launch_cancel_pending"
          ? "⏹ Cloud launch cancellation is saved and will keep retrying. The pending prompt will not be sent."
          : "⏹ Cloud launch canceled before its prompt was sent.",
        false
      );
      // The poller owns publication of every durable terminal notice (plus
      // any following suppression notice), then closes and acknowledges once
      // the complete backlog is visible.
      return { workspace, launched: null };
    }
    if (result.reason === "cloud_launch_cleanup_pending") {
      await publishTrackedWorkspaceStatus(
        ctx,
        workspace,
        msg,
        `⚠️ The Cloud workspace was created, but prompt delivery could not be confirmed and cleanup is still pending. The bot will keep retrying cleanup safely. Do not retry this launch yet.\n\n<pre>${escHtml(truncate(result.error, 500))}</pre>`,
        false
      );
      return { workspace, launched: null };
    }
    clearPendingCloudLaunch(workspace.id);
    updateWorkspaceStatus(workspace.id, "failed");
    const noticeIds = newCloudNoticeIds(
      workspace.id,
      noticeIdsBeforeLaunch,
      new Set(["launch_failed"])
    );
    const published = await publishTrackedWorkspaceStatus(
      ctx,
      workspace,
      msg,
      input.failedHtml(result.error),
      false
    );
    if (published) {
      acknowledgeCloudNoticeIds(workspace.id, noticeIds);
    }
    return { workspace, launched: null };
  }

  if (result.backendKind === "cloud-api") {
    // Cloud launch finalization already committed binding + cursor + running
    // status atomically. Never overwrite a stop that arrived after it.
    const durable = getWorkspace(workspace.id);
    if (
      !durable ||
      durable.status === "stopped" ||
      durable.status === "archived" ||
      durable.conductorBackendKind !== "cloud-api" ||
      durable.conductorWorkspaceId !== result.workspaceId ||
      durable.conductorSessionId !== result.sessionId
    ) {
      await publishTrackedWorkspaceStatus(
        ctx,
        durable ?? workspace,
        msg,
        "⏹ Cloud launch finished provisioning, but a stop or binding change won before success could be reported.",
        false
      );
      return { workspace: durable ?? workspace, launched: null };
    }
    workspace = durable;
  } else {
    updateWorkspaceConductorName(workspace.id, result.workspaceName);
    persistConductorLaunchBinding(workspace.id, result);
    updateWorkspaceStatus(workspace.id, "running");
    workspace.conductorWorkspaceName = result.workspaceName;
    workspace.status = "running";
  }

  if (threadId) {
    try {
      await syncWorkspaceTopic(ctx.telegram, workspace);
    } catch (err) {
      console.error(`[forum] could not rename topic ${threadId}:`, err);
    }
  }

  const noticeIds =
    result.backendKind === "cloud-api"
      ? newCloudNoticeIds(
          workspace.id,
          noticeIdsBeforeLaunch,
          new Set(["launch_queued"])
        )
      : [];
  const published = await publishTrackedWorkspaceStatus(
    ctx,
    workspace,
    msg,
    input.successHtml(result),
    true
  );
  if (published && result.backendKind === "cloud-api") {
    acknowledgeCloudNoticeIds(workspace.id, noticeIds);
  }

  return { workspace, launched: result };
}

/** @internal exported for cloud-first launch integration tests. */
export async function startWorkspaceForRepo(
  ctx: Context,
  target: RepoLaunchTarget,
  prompt: string,
  attachmentSourcePaths: string[] = []
): Promise<void> {
  const { repoName, repoPath } = target;
  const promptPreview = previewOutgoingText(prompt, attachmentSourcePaths);
  const backend = await resolveDefaultRepoLaunchBackend(
    target,
    attachmentSourcePaths.length
  );
  if (backend.kind === "cloud") {
    await startCloudWorkspaceForRepo(ctx, target, backend.project, prompt);
    return;
  }

  const fallbackNote = localLaunchFallbackNote(backend.reason);
  type RepoLaunchSuccess = Exclude<
    Awaited<ReturnType<typeof launchWorkspace>>,
    { error: string }
  >;
  const { workspace, launched } = await startTrackedWorkspace<RepoLaunchSuccess>(ctx, {
    displayName: repoName,
    recordName: `${repoName}-${Date.now()}`,
    repoPath,
    prompt,
    startingHtml: `Starting local workspace for <b>${escHtml(repoName)}</b>...\n<i>${escHtml(fallbackNote)}</i>\n\n<i>Prompt: ${escHtml(truncate(promptPreview, 200))}</i>`,
    failedHtml: (error) =>
      `Failed to start local workspace for <b>${escHtml(repoName)}</b>:\n${escHtml(error)}`,
    successHtml: (result) =>
      `🟢 <b>${escHtml(result.workspaceName)}</b> running locally for <b>${escHtml(repoName)}</b>\n\n<i>${escHtml(truncate(promptPreview, 200))}</i>`,
    launch: (workspace) =>
      launchWorkspace(
        repoPath,
        prompt,
        (output) => {
          console.log(`[${workspace.id}] ${output.slice(0, 200)}`);
        },
        attachmentSourcePaths
      ),
  });

  if (launched) {
    void observeAgentCompletion(
      ctx,
      workspace,
      launched.workspaceName,
      launched.done,
      attachmentSourcePaths.length === 0
        ? {
            cloudRecovery: {
              prompt,
              repoName,
              repoPath,
              workspaceDir:
                getWorkspaceDir(launched.workspaceName, repoPath) ?? undefined,
            },
          }
        : undefined
    );
  }
}

async function startCloudWorkspaceForRepo(
  ctx: Context,
  target: RepoLaunchTarget,
  project: ConductorApiProject,
  prompt: string
): Promise<void> {
  await startTrackedCloudWorkspace(ctx, {
    displayName: target.repoName,
    // Keep the local repo path for deterministic Telegram repo routing. The
    // durable backend binding, not this display/routing field, selects Cloud.
    repoPath: target.repoPath,
    projectId: project.id,
    prompt,
    locationPreposition: "for",
  });
}

async function startTrackedCloudWorkspace(
  ctx: Context,
  input: {
    displayName: string;
    repoPath: string;
    projectId: string;
    prompt: string;
    locationPreposition: "for" | "in";
  }
): Promise<void> {
  const promptPreview = previewOutgoingText(input.prompt, []);
  const location = `${input.locationPreposition} <b>${escHtml(input.displayName)}</b>`;
  await startTrackedWorkspace<CloudWorkspaceLaunchResult>(ctx, {
    displayName: input.displayName,
    recordName: `${input.displayName}-${Date.now()}`,
    repoPath: input.repoPath,
    prompt: input.prompt,
    startingHtml: `Starting ☁️ cloud workspace ${location}...\n\n<i>Prompt: ${escHtml(truncate(promptPreview, 200))}</i>`,
    failedHtml: (error) =>
      `Failed to start ☁️ cloud workspace ${location}:\n${escHtml(error)}`,
    successHtml: (result) =>
      `🟢 ☁️ <b>${escHtml(result.workspaceName)}</b> running ${location} (${escHtml(result.model)})\n\n<i>${escHtml(truncate(promptPreview, 200))}</i>\n\n${formatConductorDeepLink(result.deepLink)}`,
    launch: (workspace) =>
      launchCloudWorkspace({
        projectId: input.projectId,
        prompt: input.prompt,
        persistBeforePrompt: (pending) =>
          persistProvisionedCloudLaunch(workspace, pending),
      }),
  });
}

async function startWorkspaceFromRepoTopic(
  ctx: Context,
  topic: RepoTopic,
  prompt: string,
  attachmentSourcePaths: string[] = []
): Promise<void> {
  touchRepoTopic(topic.chatId, topic.repoPath);
  recordRouteAttempt({
    chatId: topic.chatId,
    source: "repo_topic",
    telegramThreadId: topic.telegramThreadId,
    action: "new",
    repoPath: topic.repoPath,
    repoName: topic.repoName,
    status: "routed",
  });
  await startWorkspaceForRepo(
    ctx,
    resolveRepoTopicLaunchTarget(topic),
    prompt,
    attachmentSourcePaths
  );
}

// ── Conductor Cloud (/projects, /cloud, /rename, /fleet) ────

/**
 * Bot-DB workspace rows require a repo_path; cloud workspaces have no local
 * checkout, so they carry a sentinel that display code basenames into the
 * project name and existsSync guards treat as absent.
 */
function cloudRepoSentinel(projectName: string): string {
  return `conductor-cloud://${projectName}`;
}

function describeApiError(error: unknown): string {
  return error instanceof ConductorApiError
    ? error.message
    : String((error as Error)?.message ?? error);
}

async function getCloudApiClientOrExplain(
  ctx: Context
): Promise<ConductorApiClient | null> {
  let client: ConductorApiClient | null = null;
  try {
    client = createConductorApiClientFromEnv();
  } catch (error) {
    await ctx.reply(
      `☁️ Conductor Cloud configuration error: ${escHtml(describeApiError(error))}`,
      { parse_mode: "HTML" }
    );
    return null;
  }
  if (!client) {
    await ctx.reply(
      `☁️ Conductor Cloud is in observe-only mode. ${CLOUD_OBSERVE_ONLY_HINT} to use cloud commands.`
    );
    return null;
  }
  return client;
}

function sortCloudProjects(
  projects: ConductorApiProject[]
): ConductorApiProject[] {
  return [...projects].sort((a, b) => a.name.localeCompare(b.name));
}

type LocalLaunchFallbackReason =
  | "telegram_attachments"
  | "cloud_api_unconfigured"
  | "cloud_configuration_invalid"
  | "cloud_project_lookup_failed"
  | "cloud_project_not_found";

type DefaultRepoLaunchBackend =
  | { kind: "cloud"; project: ConductorApiProject }
  | { kind: "local"; reason: LocalLaunchFallbackReason };

const DEFAULT_REPO_CLOUD_LOOKUP_TIMEOUT_MS = 5_000;

async function resolveDefaultRepoLaunchBackend(
  target: RepoLaunchTarget,
  attachmentCount: number
): Promise<DefaultRepoLaunchBackend> {
  // The public Cloud API cannot upload Telegram files yet. Keep the existing
  // local bridge instead of silently dropping user attachments.
  if (attachmentCount > 0) {
    return { kind: "local", reason: "telegram_attachments" };
  }

  let client: ConductorApiClient | null;
  try {
    client = createConductorApiClientFromEnv();
  } catch (error) {
    console.error(
      "[conductor-api] Cloud-first launch configuration is invalid:",
      error
    );
    return { kind: "local", reason: "cloud_configuration_invalid" };
  }
  if (!client) {
    return { kind: "local", reason: "cloud_api_unconfigured" };
  }

  let projects: ConductorApiProject[];
  const lookupController = new AbortController();
  const lookupTimeout = setTimeout(
    () => lookupController.abort(),
    DEFAULT_REPO_CLOUD_LOOKUP_TIMEOUT_MS
  );
  try {
    projects = await client.listProjects({ signal: lookupController.signal });
  } catch (error) {
    console.error("[conductor-api] Cloud-first project lookup failed:", error);
    return { kind: "local", reason: "cloud_project_lookup_failed" };
  } finally {
    clearTimeout(lookupTimeout);
  }

  const remoteUrl = await resolveRepoRemoteUrl(target.repoPath);
  const project = resolveCloudProjectForRepo(
    projects,
    target.repoName,
    remoteUrl
  );
  return project
    ? { kind: "cloud", project }
    : { kind: "local", reason: "cloud_project_not_found" };
}

function localLaunchFallbackNote(reason: LocalLaunchFallbackReason): string {
  switch (reason) {
    case "telegram_attachments":
      return "Using the local file bridge because Cloud cannot receive Telegram attachments yet.";
    case "cloud_api_unconfigured":
      return "Using the local agent because the Conductor Cloud API is not configured.";
    case "cloud_configuration_invalid":
      return "Using the local agent because the Conductor Cloud configuration is invalid.";
    case "cloud_project_lookup_failed":
      return "Using the local agent because Cloud project lookup failed.";
    case "cloud_project_not_found":
      return "Using the local agent because no Cloud project matches this repository.";
  }
}

function cloudRecoveryUnavailableReason(
  reason: LocalLaunchFallbackReason
): string {
  switch (reason) {
    case "telegram_attachments":
      return "the failed request included Telegram attachments that Cloud cannot receive yet";
    case "cloud_api_unconfigured":
      return "the Conductor Cloud API is not configured";
    case "cloud_configuration_invalid":
      return "the Conductor Cloud configuration is invalid";
    case "cloud_project_lookup_failed":
      return "Cloud project lookup failed";
    case "cloud_project_not_found":
      return "no Cloud project matches this repository";
  }
}

function normalizeGitRemote(remote: string | null | undefined): string | null {
  const value = remote?.trim();
  if (!value) return null;

  const normalizePath = (input: string, lowercase: boolean): string => {
    const normalized = input
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "");
    return lowercase ? normalized.toLowerCase() : normalized;
  };
  const hostAndPath = (host: string, remotePath: string): string => {
    const normalizedHost = host.toLowerCase();
    const hostWithoutPort = normalizedHost.replace(/:\d+$/, "");
    // GitHub repository paths are case-insensitive. Unknown/self-hosted Git
    // servers may be case-sensitive, so preserve their path identity.
    const lowercasePath = hostWithoutPort === "github.com";
    return `${normalizedHost}/${normalizePath(remotePath, lowercasePath)}`;
  };

  if (!value.includes("://")) {
    const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scp) {
      return hostAndPath(scp[1], scp[2]);
    }
    return normalizePath(value, false);
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "file:") {
      return normalizePath(decodeURIComponent(parsed.pathname), false);
    }
    return hostAndPath(parsed.host, decodeURIComponent(parsed.pathname));
  } catch {
    return normalizePath(value, false);
  }
}

/**
 * Match a local repository to exactly one Cloud project using only its origin
 * identity across SSH/HTTPS URL dialects. Automatic routing never guesses by
 * a display name or basename; explicit /cloud remains the name-based picker.
 *
 * @internal exported for cloud-first launch tests.
 */
export function resolveCloudProjectForRepo(
  projects: ConductorApiProject[],
  _repoName: string,
  remoteUrl: string | null
): ConductorApiProject | null {
  const normalizedRemote = normalizeGitRemote(remoteUrl);
  if (normalizedRemote) {
    const remoteMatches = projects.filter(
      (project) => normalizeGitRemote(project.gitRemote) === normalizedRemote
    );
    if (remoteMatches.length === 1) return remoteMatches[0];
    // A usable origin is authoritative. Falling through to a same-name
    // project here could send the prompt to a different repository.
    return null;
  }

  return null;
}

/** @internal exported for cloud command unit tests; not part of the public bot API. */
export function resolveCloudProject(
  projects: ConductorApiProject[],
  input: string
): ConductorApiProject | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const byIndex = projects[Number(trimmed) - 1];
    if (byIndex) return byIndex;
    // An out-of-range number may still be a literal project name or id.
  }
  const exactId = projects.find((project) => project.id === trimmed);
  if (exactId) return exactId;
  const lower = trimmed.toLowerCase();
  const exactName = projects.filter(
    (project) => project.name.toLowerCase() === lower
  );
  if (exactName.length === 1) return exactName[0];
  const prefixed = projects.filter((project) =>
    project.name.toLowerCase().startsWith(lower)
  );
  return prefixed.length === 1 ? prefixed[0] : null;
}

const CLOUD_PROJECTS_MAX_SHOWN = 25;

function cloudProjectLines(projects: ConductorApiProject[]): string {
  // Unbounded lists blow through Telegram's 4096-char message cap and the
  // whole reply is rejected, so cap the rendering like /fleet does. Numbers
  // stay valid for /cloud <number> because resolution uses the same sort.
  const shown = projects.slice(0, CLOUD_PROJECTS_MAX_SHOWN);
  const lines = shown.map(
    (project, index) =>
      `${index + 1}. <b>${escHtml(project.name)}</b> — <code>${escHtml(project.gitRemote)}</code>`
  );
  if (projects.length > shown.length) {
    lines.push(
      `…and ${projects.length - shown.length} more project(s) — pick them by exact name or id.`
    );
  }
  return lines.join("\n");
}

/**
 * Only linkify deep links that point at Conductor itself. The value comes
 * from the Conductor API, but a clickable "Open in Conductor" anchor is a
 * phishing surface if the API (or a future proxy) ever returned a foreign
 * host, so anything else renders as inert code.
 *
 * @internal exported for cloud command unit tests; not part of the public bot API.
 */
export function isTrustedConductorLink(deepLink: string): boolean {
  try {
    const url = new URL(deepLink);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    return (
      url.hostname === "conductor.build" ||
      url.hostname.endsWith(".conductor.build")
    );
  } catch {
    return false;
  }
}

/** @internal exported for cloud command unit tests; not part of the public bot API. */
export function formatConductorDeepLink(deepLink: string): string {
  // escHtml leaves double quotes alone; escape them so the href attribute
  // cannot be truncated by a quoted deep link.
  const safe = escHtml(deepLink).replace(/"/g, "&quot;");
  return isTrustedConductorLink(deepLink)
    ? `<a href="${safe}">Open in Conductor</a>`
    : `<code>${safe}</code>`;
}

/** @internal re-exported for cloud command unit tests; lives in format.ts. */
export { formatRelativeTime };

/**
 * Strip a leading /command (with an optional @botname mention) from a
 * message. One dialect for every handler, so `/run@bot` parses like `/run`.
 */
function stripCommandPrefix(text: string, command: string): string {
  return text.replace(new RegExp(`^\\/${command}(?:@\\S+)?\\s*`), "").trim();
}

/**
 * The shared /projects + /cloud opener: list the org's projects or explain
 * why the listing is empty/unavailable. Returns null when the handler should
 * stop (the user has already been told why).
 */
async function listCloudProjectsOrExplain(
  ctx: Context,
  client: ConductorApiClient
): Promise<ConductorApiProject[] | null> {
  let projects: ConductorApiProject[];
  try {
    projects = sortCloudProjects(await client.listProjects());
  } catch (error) {
    await ctx.reply(
      `Could not list cloud projects: ${escHtml(describeApiError(error))}`,
      { parse_mode: "HTML" }
    );
    return null;
  }
  if (projects.length === 0) {
    await ctx.reply(
      "No cloud projects are visible to this API key yet. Connect a repository in Conductor's Cloud settings first."
    );
    return null;
  }
  return projects;
}

/** @internal exported for cloud handler unit tests; not part of the public bot API. */
export async function handleProjects(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const arg = stripCommandPrefix(text, "projects");
  const client = await getCloudApiClientOrExplain(ctx);
  if (!client) return;

  const projects = await listCloudProjectsOrExplain(ctx, client);
  if (!projects) return;

  if (arg) {
    const resolved = resolveCloudProject(projects, arg);
    if (!resolved) {
      await ctx.reply(
        truncateHtml(
          `Project "${escHtml(arg)}" not found.\n\n☁️ Cloud projects:\n${cloudProjectLines(projects)}`,
          TELEGRAM_MAX_TEXT
        ),
        { parse_mode: "HTML" }
      );
      return;
    }
    try {
      // The detail view re-reads the single project so the reply reflects the
      // API's current record rather than the cached listing.
      const [project, workspaces] = await Promise.all([
        client.getProject(resolved.id),
        client.listProjectWorkspaces(resolved.id),
      ]);
      const recent = [...workspaces]
        .sort((a, b) =>
          (b.lastActivityAt ?? b.createdAt).localeCompare(
            a.lastActivityAt ?? a.createdAt
          )
        )
        .slice(0, 10);
      const workspaceLines =
        recent.length === 0
          ? "No workspaces yet."
          : recent
              .map(
                (workspace) =>
                  `• <b>${escHtml(workspace.name)}</b> — active ${formatRelativeTime(workspace.lastActivityAt ?? workspace.createdAt)}`
              )
              .join("\n");
      await ctx.reply(
        truncateHtml(
          `☁️ <b>${escHtml(project.name)}</b>\n<code>${escHtml(project.gitRemote)}</code>\n\n${workspaces.length} workspace(s)${workspaces.length > recent.length ? ` (showing ${recent.length} most recent)` : ""}:\n${workspaceLines}\n\nStart work: <code>/cloud ${escHtml(project.name)} &lt;prompt&gt;</code>`,
          TELEGRAM_MAX_TEXT
        ),
        { parse_mode: "HTML" }
      );
    } catch (error) {
      await ctx.reply(
        `Could not inspect ${escHtml(resolved.name)}: ${escHtml(describeApiError(error))}`,
        { parse_mode: "HTML" }
      );
    }
    return;
  }

  await ctx.reply(
    truncateHtml(
      `☁️ <b>Cloud projects</b>\n\n${cloudProjectLines(projects)}\n\nStart work: <code>/cloud &lt;number|name&gt; &lt;prompt&gt;</code>\nDetails: <code>/projects &lt;name&gt;</code>`,
      TELEGRAM_MAX_TEXT
    ),
    { parse_mode: "HTML" }
  );
}

/** @internal exported for cloud handler unit tests; not part of the public bot API. */
export async function handleCloud(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const args = stripCommandPrefix(text, "cloud");
  const client = await getCloudApiClientOrExplain(ctx);
  if (!client) return;

  const projects = await listCloudProjectsOrExplain(ctx, client);
  if (!projects) return;

  if (!args) {
    await ctx.reply(
      truncateHtml(
        `Usage: /cloud &lt;project&gt; &lt;prompt&gt;\n\n☁️ Cloud projects (use number or name):\n${cloudProjectLines(projects)}\n\nExample:\n<code>/cloud 1 Fix the auth bug</code>`,
        TELEGRAM_MAX_TEXT
      ),
      { parse_mode: "HTML" }
    );
    return;
  }

  const spaceIdx = args.indexOf(" ");
  if (spaceIdx === -1) {
    await ctx.reply(
      "Please provide both a project and a prompt.\n\nExample: /cloud 1 Fix the auth bug"
    );
    return;
  }
  // Project names may contain spaces; prefer the longest leading exact-name
  // match so "/cloud Belong Network fix bug" targets "Belong Network" instead
  // of leaking "Network" into the agent's prompt via prefix resolution.
  let projectInput = args.slice(0, spaceIdx);
  let prompt = args.slice(spaceIdx + 1).trim();
  const lowerArgs = args.toLowerCase();
  for (const candidate of [...projects].sort(
    (a, b) => b.name.length - a.name.length
  )) {
    const lowerName = candidate.name.toLowerCase();
    if (lowerName.includes(" ") && lowerArgs.startsWith(`${lowerName} `)) {
      projectInput = args.slice(0, candidate.name.length);
      prompt = args.slice(candidate.name.length + 1).trim();
      break;
    }
  }
  if (!prompt) {
    await ctx.reply(
      "Please provide both a project and a prompt.\n\nExample: /cloud 1 Fix the auth bug"
    );
    return;
  }
  const project = resolveCloudProject(projects, projectInput);
  if (!project) {
    await ctx.reply(
      truncateHtml(
        `Project "${escHtml(projectInput)}" not found.\n\n☁️ Cloud projects:\n${cloudProjectLines(projects)}`,
        TELEGRAM_MAX_TEXT
      ),
      { parse_mode: "HTML" }
    );
    return;
  }

  await startCloudWorkspaceForProject(ctx, project, prompt);
}

async function startCloudWorkspaceForProject(
  ctx: Context,
  project: ConductorApiProject,
  prompt: string
): Promise<void> {
  await startTrackedCloudWorkspace(ctx, {
    displayName: project.name,
    repoPath: cloudRepoSentinel(project.name),
    projectId: project.id,
    prompt,
    locationPreposition: "in",
  });
}

/** @internal exported for cloud handler unit tests; not part of the public bot API. */
export async function handleRename(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const newName = stripCommandPrefix(text, "rename");
  if (!newName) {
    await ctx.reply(
      "Usage: /rename <new name> — run inside a workspace topic or as a reply to a workspace message."
    );
    return;
  }
  const target = getContextualTarget(ctx);
  if (!target) {
    await ctx.reply(
      "Couldn't tell which workspace to rename. Use /rename inside a workspace topic or reply to one of its messages."
    );
    return;
  }
  const tracked = target.trackedWorkspace;
  const wsInfo = getWorkspaceSessionInfo(
    target.conductorName,
    target.repoPath,
    tracked ?? null
  );
  if (!wsInfo || !isRemoteConductorWorkspace(wsInfo)) {
    await ctx.reply(
      "Renaming is only available for ☁️ cloud workspaces — the Conductor API does not manage local workspaces."
    );
    return;
  }
  const client = await getCloudApiClientOrExplain(ctx);
  if (!client) return;
  try {
    const renamed = await client.renameWorkspace(wsInfo.workspaceId, newName);
    if (tracked) {
      updateWorkspaceConductorName(tracked.id, renamed.name);
      syncWorkspaceTopic(ctx.telegram, {
        ...tracked,
        conductorWorkspaceName: renamed.name,
      }).catch((err) =>
        console.error(`[forum] topic sync error after rename:`, err)
      );
    }
    await ctx.reply(
      `✏️ ☁️ Workspace renamed to <b>${escHtml(renamed.name)}</b>.`,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    await ctx.reply(
      `Could not rename ☁️ "${escHtml(wsInfo.displayName)}": ${escHtml(describeApiError(error))}`,
      { parse_mode: "HTML" }
    );
  }
}

/** @internal exported for cloud handler unit tests; not part of the public bot API. */
export async function handleRenameThread(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const newName = stripCommandPrefix(text, "renamethread");
  if (!newName) {
    await ctx.reply(
      "Usage: /renamethread <new name> — run inside a workspace topic (or reply to a specific thread's message)."
    );
    return;
  }
  const target = getContextualTarget(ctx);
  if (!target) {
    await ctx.reply(
      "Couldn't tell which thread to rename. Use /renamethread inside a workspace topic or reply to a thread's message."
    );
    return;
  }
  const wsInfo = getWorkspaceSessionInfo(
    target.conductorName,
    target.repoPath,
    target.trackedWorkspace ?? null
  );
  if (!wsInfo || !isRemoteConductorWorkspace(wsInfo)) {
    await ctx.reply(
      "Thread renaming is only available for ☁️ cloud workspaces — the Conductor API does not manage local threads."
    );
    return;
  }
  const sessionId = target.sessionId ?? wsInfo.sessionId;
  const client = await getCloudApiClientOrExplain(ctx);
  if (!client) return;
  try {
    const renamed = await client.renameSession(sessionId, newName);
    await ctx.reply(
      `✏️ ☁️ Thread renamed to <b>${escHtml(renamed.name ?? newName)}</b>.`,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    await ctx.reply(
      `Could not rename the thread: ${escHtml(describeApiError(error))}`,
      { parse_mode: "HTML" }
    );
  }
}

const FLEET_MAX_HOURS = 168;
const FLEET_ROW_LIMIT = 200;
const FLEET_MAX_WORKSPACES_SHOWN = 25;

/**
 * This is the only guard between user input and the interval literal inlined
 * into the /v0/sql query, so it accepts nothing but a plain bounded integer
 * (no signs, decimals, exponents, or trailing text).
 *
 * @internal exported for cloud command unit tests; not part of the public bot API.
 */
export function parseFleetHours(arg: string): number | null {
  if (!arg) return 24;
  if (!/^\d+$/.test(arg)) return null;
  const parsed = Number(arg);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > FLEET_MAX_HOURS) {
    return null;
  }
  return parsed;
}

/** @internal exported for cloud handler unit tests; not part of the public bot API. */
export async function handleFleet(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const arg = stripCommandPrefix(text, "fleet");
  const hours = parseFleetHours(arg);
  if (hours === null) {
    await ctx.reply(
      `Usage: /fleet [hours] — hours must be an integer between 1 and ${FLEET_MAX_HOURS}.`
    );
    return;
  }

  const client = await getCloudApiClientOrExplain(ctx);
  if (!client) return;

  // hours is a validated integer, so inlining it into the interval is safe;
  // the endpoint itself is restricted to read-only SQL over this view.
  const query =
    "SELECT workspace_id, workspace_name, session_title, transcript_updated_at " +
    "FROM session_transcripts_view " +
    `WHERE transcript_updated_at >= now() - interval '${hours} hours' ` +
    `ORDER BY transcript_updated_at DESC LIMIT ${FLEET_ROW_LIMIT}`;
  let result;
  try {
    result = await client.runSql(query);
  } catch (error) {
    await ctx.reply(
      `Could not query cloud transcripts: ${escHtml(describeApiError(error))}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  interface FleetEntry {
    name: string;
    threads: number;
    titles: string[];
    latest: string | null;
  }
  const byWorkspace = new Map<string, FleetEntry>();
  for (const row of result.rows) {
    const workspaceId = row.workspace_id == null ? "" : String(row.workspace_id);
    if (!workspaceId) continue;
    const entry = byWorkspace.get(workspaceId) ?? {
      name:
        row.workspace_name == null || row.workspace_name === ""
          ? "unnamed"
          : String(row.workspace_name),
      threads: 0,
      titles: [],
      latest:
        row.transcript_updated_at == null
          ? null
          : String(row.transcript_updated_at),
    };
    entry.threads += 1;
    const title = row.session_title == null ? "" : String(row.session_title).trim();
    if (title && entry.titles.length < 2 && !entry.titles.includes(title)) {
      entry.titles.push(title);
    }
    byWorkspace.set(workspaceId, entry);
  }

  if (byWorkspace.size === 0) {
    if (result.rowCount > 0) {
      // Rows came back but none carried a workspace_id — the view's schema
      // has drifted from what this report expects. Say so instead of
      // presenting a false "no activity" all-clear.
      await ctx.reply(
        `⚠️ The transcript view returned ${result.rowCount} row(s) without the expected workspace_id column. Conductor's session_transcripts_view schema may have changed; /fleet needs an update.`
      );
      return;
    }
    await ctx.reply(
      `☁️ No cloud session activity in the last ${hours}h.`
    );
    return;
  }

  const entries = [...byWorkspace.values()];
  const shown = entries.slice(0, FLEET_MAX_WORKSPACES_SHOWN);
  const lines = shown.map((entry) => {
    const titles =
      entry.titles.length > 0
        ? `\n   <i>${escHtml(truncate(entry.titles.join(" · "), 120))}</i>`
        : "";
    return `• <b>${escHtml(entry.name)}</b> — ${entry.threads} thread(s), active ${formatRelativeTime(entry.latest)}${titles}`;
  });
  const overflow =
    entries.length > shown.length
      ? `\n…and ${entries.length - shown.length} more workspace(s).`
      : "";
  // The query's own LIMIT caps rows before the server's truncation flag can
  // fire, so a full page means the window may be incomplete either way.
  const truncatedNote =
    result.truncated || result.rowCount >= FLEET_ROW_LIMIT
      ? "\n\n⚠️ The report hit its row cap; older activity in this window may be missing."
      : "";
  await ctx.reply(
    truncateHtml(
      `☁️ <b>Cloud activity — last ${hours}h</b>\n${entries.length} workspace(s), ${result.rowCount} active thread(s)\n\n${lines.join("\n")}${overflow}${truncatedNote}`,
      TELEGRAM_MAX_TEXT
    ),
    { parse_mode: "HTML" }
  );
}

// ── /workspaces ─────────────────────────────────────────────

async function handleWorkspaces(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  const workspaces = chatId ? getAllWorkspacesForChat(chatId, 20) : getAllWorkspaces(20);

  if (workspaces.length === 0) {
    await ctx.reply("No workspaces tracked yet. Use /run to start one.");
    return;
  }

  const prRecords = getPrRecordsForWorkspaces(workspaces.map((ws) => ws.id));
  const lines = workspaces.map((ws) => {
    const icon = statusIcon(ws.status);
    const name = ws.conductorWorkspaceName ?? ws.name;
    const sessionInfo = ws.conductorWorkspaceName
      ? getWorkspaceSessionInfo(ws.conductorWorkspaceName, ws.repoPath, ws)
      : null;
    const cloud = sessionInfo && isRemoteConductorWorkspace(sessionInfo) ? " ☁️" : "";
    const pr = compactPrBadge(prRecords.get(ws.id));
    return `${icon} <b>${escHtml(name)}${cloud}</b> — ${ws.status} · <code>${escHtml(pr)}</code>\n   <i>${escHtml(truncate(ws.prompt, 60))}</i>`;
  });

  const stopRows = workspaces
    .filter((ws) => ws.status === "running" || ws.status === "starting")
    .map((ws) => [
      btn(`Stop ${ws.conductorWorkspaceName ?? ws.name}`, `stop:${ws.id}`),
    ]);
  const archiveRows = workspaces
    .filter((ws) => ws.status === "done" || ws.status === "failed" || ws.status === "stopped")
    .map((ws) => [
      btn(
        `Archive ${ws.conductorWorkspaceName ?? ws.name}`,
        `archive:${ws.id}`
      ),
    ]);

  await ctx.reply(lines.join("\n\n"), {
    parse_mode: "HTML",
    ...(
      stopRows.length > 0 || archiveRows.length > 0
        ? styledKeyboard([...stopRows, ...archiveRows])
        : {}
    ),
  });
}

async function handlePrs(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  const workspaces = chatId ? getAllWorkspacesForChat(chatId, 30) : getAllWorkspaces(30);
  const shippable = workspaces.filter((ws) => ws.conductorWorkspaceName);
  if (shippable.length === 0) {
    await ctx.reply("No tracked workspaces with Conductor sessions yet.");
    return;
  }

  const refreshed = await Promise.all(
    shippable.map((ws) =>
      refreshWorkspacePr(ws).catch((err) => {
        console.error("[prs] refresh failed:", err);
        return null;
      })
    )
  );
  const byWorkspace = new Map<string, PrRecord>();
  for (const result of refreshed) {
    if (result?.record) byWorkspace.set(result.record.workspaceId, result.record);
  }

  const lines = shippable.map((ws) => {
    const name = ws.conductorWorkspaceName ?? ws.name;
    const repo = path.basename(ws.repoPath);
    const record = byWorkspace.get(ws.id);
    const branch = record?.branch ?? `belongcond/${name}`;
    const badge = compactPrBadge(record);
    return `<b>${escHtml(name)}</b> · <code>${escHtml(repo)}</code>\n<code>${escHtml(branch)}</code> · ${escHtml(badge)}`;
  });

  const rows = shippable
    .slice(0, 12)
    .map((ws) => [btn(`Refresh ${ws.conductorWorkspaceName ?? ws.name}`, `pr:refresh:${ws.id}`)]);

  await ctx.reply(`<b>PR / branch status</b>\n\n${lines.join("\n\n")}`, {
    parse_mode: "HTML",
    ...(rows.length > 0 ? styledKeyboard(rows) : {}),
  });
}

// ── /status ─────────────────────────────────────────────────

async function handleStatus(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  const active = getActiveWorkspaces().filter(
    (workspace) => !chatId || workspace.telegramChatId === chatId
  );

  if (active.length === 0) {
    await ctx.reply("No active workspaces. All quiet.");
    return;
  }

  const summary = active
    .map((ws) => {
      const name = ws.conductorWorkspaceName ?? ws.name;
      const sessionInfo = ws.conductorWorkspaceName
        ? getWorkspaceSessionInfo(ws.conductorWorkspaceName, ws.repoPath, ws)
        : null;
      const cloud = sessionInfo && isRemoteConductorWorkspace(sessionInfo) ? " ☁️" : "";
      return `${statusIcon(ws.status)} <b>${escHtml(name)}${cloud}</b>: ${ws.status}`;
    })
    .join("\n");

  await ctx.reply(`<b>Active workspaces (${active.length}):</b>\n\n${summary}`, {
    parse_mode: "HTML",
  });
}

async function handleDecisions(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  if (!chatId) return;

  const decisions = getPendingDecisionsForChat(chatId, 20);
  if (decisions.length === 0) {
    await ctx.reply("No pending agent questions.");
    return;
  }

  const lines = decisions.map((decision) => {
    const workspace = getWorkspace(decision.workspaceId);
    const name = workspace?.conductorWorkspaceName ?? workspace?.name ?? "unknown";
    const repo = workspace ? path.basename(workspace.repoPath) : "unknown";
    return `<b>#${decision.id}</b> · <b>${escHtml(name)}</b> · <code>${escHtml(repo)}</code>\n<i>${escHtml(truncate(decision.question, 220))}</i>`;
  });

  await ctx.reply(
    `<b>Pending questions (${decisions.length})</b>\n\n${lines.join("\n\n")}\n\nReply to the original question message, or tap its option buttons if present.`,
    { parse_mode: "HTML" }
  );
}

// ── /stop <workspace> ───────────────────────────────────────

/** @internal exported for pending-launch cancellation integration tests. */
export async function handleStop(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const idOrName = text.replace(/^\/stop\s*/, "").trim();
  const chatId = ctx.chat?.id?.toString();

  if (!idOrName) {
    await ctx.reply("Usage: /stop <workspace-id or conductor-name>");
    return;
  }

  // Try to find by ID first, then by conductor name
  let workspace = getWorkspace(idOrName);
  if (workspace && chatId && workspace.telegramChatId !== chatId) {
    workspace = undefined;
  }
  if (!workspace) {
    const all = chatId ? getAllWorkspacesForChat(chatId, 50) : getAllWorkspaces(50);
    const matches = all.filter((ws) => ws.conductorWorkspaceName === idOrName);
    if (matches.length > 1) {
      await ctx.reply(`Workspace "${escHtml(idOrName)}" is ambiguous in this chat. Use the workspace id instead.`, {
        parse_mode: "HTML",
      });
      return;
    }
    workspace = matches[0];
  }

  if (!workspace) {
    await ctx.reply(`Workspace "${idOrName}" not found.`);
    return;
  }
  const wsName = workspace.conductorWorkspaceName ?? workspace.name;
  const conductorInfo = workspace.conductorWorkspaceName
    ? getWorkspaceSessionInfo(
        workspace.conductorWorkspaceName,
        workspace.repoPath,
        workspace
      )
    : null;
  // Persist stop intent before the remote call so a crash or slow poll cannot
  // enqueue a durable-but-unsent first prompt after the user canceled it.
  const hadPendingLaunch = Boolean(getPendingCloudLaunch(workspace.id));
  const pendingCancellation = markPendingCloudLaunchCanceled(workspace.id);
  const terminalIntent = getPendingCloudTerminalIntent(workspace.id);
  const terminalResult = terminalIntent
    ? await reconcilePendingCloudTerminalIntent(workspace.id)
    : null;
  const terminalFailure =
    terminalResult?.status === "failed" ? terminalResult : null;
  const killed = terminalResult
    ? terminalResult.status === "completed" || terminalResult.status === "none"
    : workspace.conductorWorkspaceName
      ? await stopConductorAgent(
          workspace.conductorWorkspaceName,
          workspace.repoPath,
          workspace.conductorSessionId,
          workspace
        )
      : false;
  if (
    (terminalIntent ||
      (conductorInfo && isRemoteConductorWorkspace(conductorInfo))) &&
    !killed
  ) {
    if (terminalFailure) {
      await ctx.reply(
        `🔴 The saved Cloud stop request for <b>${escHtml(wsName)}</b> could not be confirmed and was given up on: <pre>${escHtml(truncate(terminalFailure.error, 500))}</pre> Check the workspace in Conductor Cloud before sending more work.`,
        { parse_mode: "HTML" }
      );
      if (terminalFailure.noticeId) {
        acknowledgePendingCloudNotice(workspace.id, terminalFailure.noticeId);
      }
      return;
    }
    if (pendingCancellation) {
      await ctx.reply(
        `⏹ Stop intent for ☁️ <b>${escHtml(wsName)}</b> is saved, but Conductor has not confirmed cancellation yet. The bot will retry and ${
          hadPendingLaunch
            ? "will not send the pending prompt"
            : "will keep new Cloud work blocked"
        }.`,
        { parse_mode: "HTML" }
      );
      return;
    }
    await ctx.reply(
      `Could not stop ☁️ <b>${escHtml(wsName)}</b> through the Conductor API.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  updateWorkspaceStatus(workspace.id, "stopped");
  const deferTopicFinalization =
    hadPendingLaunch ||
    hasPendingCloudTopicFinalizationNotice(workspace.id);
  if (workspace.telegramThreadId && !deferTopicFinalization) {
    try {
      await syncWorkspaceTopic(ctx.telegram, { ...workspace, status: "stopped" });
    } catch (err) {
      console.error(`[forum] topic sync error ${workspace.telegramThreadId}:`, err);
    }
  }
  await ctx.reply(
    `⏹ <b>${escHtml(wsName)}</b> stopped.${
      hadPendingLaunch
        ? "\n<i>The provisioned Cloud workspace will be archived and the previous binding restored in the background.</i>"
        : killed
          ? ""
          : "\n<i>Agent process was not running.</i>"
    }`,
    {
      parse_mode: "HTML",
      ...styledButtons([btn("Archive", `archive:${workspace.id}`)]),
    }
  );
  if (workspace.telegramThreadId && !deferTopicFinalization) {
    await closeWorkspaceTopic(
      ctx.telegram,
      workspace.telegramChatId,
      workspace.telegramThreadId
    );
  }
}

// ── /repos ──────────────────────────────────────────────────

async function handleRepos(ctx: Context): Promise<void> {
  const repos = getRepoList();

  if (repos.length === 0) {
    await ctx.reply("No repos found in Conductor repos directory.");
    return;
  }

  const lines = repos.map((r, i) => `${i + 1}. <code>${escHtml(r)}</code>`).join("\n");
  const repoButtons = repos.flatMap((r, i) => [
    [
      btn(`${i + 1}. ${r}`, `run:${i + 1}`),
      btn("Topic", `repotopic:${i + 1}`),
    ],
  ]);

  await ctx.reply(
    `<b>Available repos:</b>\n\n${lines}\n\nTap a repo for the two-step /run flow, or tap <b>Topic</b> to create a durable repo topic. Messages and voice notes in a repo topic always start new work in that repo.`,
    {
      parse_mode: "HTML",
      ...styledKeyboard(repoButtons),
    }
  );
}

interface PendingRepoSelection {
  repoNum: number;
  confirmationMessageKey: string;
}

interface PendingRouteConfirmation {
  chatId: string;
  result: RouteResult;
  attachments: string[];
  createdAt: number;
}

// Last selected repo per user (for two-step /run flow)
const pendingRepoSelection = new Map<string, PendingRepoSelection>();
const pendingRouteConfirmations = new Map<string, PendingRouteConfirmation>();

function getRepoSelectionMessageKey(chatId: string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function getPendingRepoSelectionKey(ctx: Context): string | null {
  const chatId = ctx.chat?.id?.toString();
  if (!chatId) return null;

  const msg = (ctx as any).msg;
  const threadId =
    typeof msg?.message_thread_id === "number" ? msg.message_thread_id : null;

  return threadId ? `${chatId}:${threadId}` : chatId;
}

function repoPathForName(repoName: string): string {
  return path.join(CONDUCTOR_REPOS_DIR, repoName);
}

function isTelegramThreadMissingError(err: any): boolean {
  const msg = String(err?.message ?? "").toLowerCase();
  return (
    msg.includes("message_thread_not_found") ||
    msg.includes("topic_deleted") ||
    msg.includes("thread not found") ||
    (msg.includes("bad request") && msg.includes("thread"))
  );
}

async function ensureRepoTopic(
  ctx: Context,
  chatId: string,
  repoName: string
): Promise<{ ok: true; threadId: number; created: boolean } | { ok: false; message: string }> {
  const repoPath = repoPathForName(repoName);
  const existing = getRepoTopic(chatId, repoPath);
  if (existing) {
    return { ok: true, threadId: existing.telegramThreadId, created: false };
  }

  const result = await createRepoTopic(ctx.telegram, chatId, repoName);
  if (!result.ok) {
    const message =
      result.kind === "no_forum"
        ? "Repo topics require a Telegram supergroup with Topics enabled."
        : result.kind === "no_permission"
          ? "The bot needs the Manage Topics admin permission to create repo topics."
          : `Telegram returned: ${result.message}`;
    return { ok: false, message };
  }

  upsertRepoTopic({
    chatId,
    repoPath,
    repoName,
    telegramThreadId: result.threadId,
  });
  return { ok: true, threadId: result.threadId, created: true };
}

async function sendRepoTopicReadyMessage(
  ctx: Context,
  repoName: string,
  threadId: number
): Promise<void> {
  const message = await ctx.telegram.sendMessage(
    ctx.chat!.id,
    `<b>${escHtml(repoName)}</b> repo topic is ready.\n\nSend a message or voice note here to start a new workspace in this repo. Workspace follow-ups still go in the workspace's own topic.`,
    {
      parse_mode: "HTML",
      message_thread_id: threadId,
    }
  );
  await ctx.telegram
    .pinChatMessage(ctx.chat!.id, message.message_id, {
      disable_notification: true,
    })
    .catch((err) =>
      console.error(`[forum] could not pin repo topic message ${threadId}:`, err)
    );
}

async function handleRunRepoCallback(ctx: Context): Promise<void> {
  const match = (ctx as any).match;
  const repoNum = parseInt(match?.[1], 10);
  if (Number.isNaN(repoNum)) return;

  const repos = getRepoList();
  const repoName = repos[repoNum - 1];
  if (!repoName) return;

  const selectionKey = getPendingRepoSelectionKey(ctx);
  if (!selectionKey) return;

  await ctx.answerCbQuery(`Selected: ${repoName}`);
  const confirmMsg = await ctx.reply(
    `Selected <b>${escHtml(repoName)}</b>. Now send your prompt as a message (or reply to this message), or use:\n<code>/run ${repoNum} your prompt here</code>`,
    { parse_mode: "HTML" }
  );
  const confirmationMessageKey = getRepoSelectionMessageKey(
    ctx.chat!.id.toString(),
    confirmMsg.message_id
  );
  messageToRepoSelection.set(confirmationMessageKey, repoName);
  pendingRepoSelection.set(selectionKey, { repoNum, confirmationMessageKey });
}

async function handleRepoTopicCallback(ctx: Context): Promise<void> {
  const match = (ctx as any).match;
  const repoNum = parseInt(match?.[1], 10);
  if (Number.isNaN(repoNum)) return;

  const repos = getRepoList();
  const repoName = repos[repoNum - 1];
  const chatId = ctx.chat?.id?.toString();
  if (!repoName || !chatId) return;

  let topic = await ensureRepoTopic(ctx, chatId, repoName);
  if (!topic.ok) {
    await ctx.answerCbQuery("Could not create repo topic");
    await ctx.reply(`Could not create a repo topic for <b>${escHtml(repoName)}</b>.\n\n${escHtml(topic.message)}`, {
      parse_mode: "HTML",
    });
    return;
  }

  let recreated = false;
  try {
    await sendRepoTopicReadyMessage(ctx, repoName, topic.threadId);
  } catch (err) {
    if (!topic.created && isTelegramThreadMissingError(err)) {
      deleteRepoTopic(chatId, repoPathForName(repoName));
      topic = await ensureRepoTopic(ctx, chatId, repoName);
      if (topic.ok) {
        recreated = true;
        await sendRepoTopicReadyMessage(ctx, repoName, topic.threadId);
      }
    }
    if (!topic.ok || !recreated) {
      throw err;
    }
  }

  await ctx.answerCbQuery(
    recreated ? "Repo topic recreated" : topic.created ? "Repo topic created" : "Repo topic ready"
  );
}

// ── Reply-to-decision helper ─────────────────────────────────

/**
 * Check if a message is a reply to a tracked decision message.
 * If so, answer the decision and return true.
 */
async function tryAnswerDecisionReply(ctx: Context, answerText: string): Promise<boolean> {
  const replyTo = (ctx.message as any)?.reply_to_message?.message_id;
  if (!replyTo) return false;

  const decisionId = messageToDecision.get(replyTo);
  if (!decisionId) return false;

  const decision = getDecision(decisionId);
  if (!decision || decision.answer) return false; // Already answered

  answerDecision(decisionId, answerText);
  answerPendingStdinDecision(decisionId, answerText);
  messageToDecision.delete(replyTo);
  const workspace = getWorkspace(decision.workspaceId);
  if (workspace?.telegramThreadId) {
    syncWorkspaceTopic(ctx.telegram, workspace).catch((err) =>
      console.error(`[forum] topic sync error ${workspace.telegramThreadId}:`, err)
    );
  }
  await ctx.reply(`Answered: ${truncate(answerText, 200)}`, {
    reply_parameters: { message_id: (ctx.message as any).message_id },
  });
  return true;
}

async function tryAnswerDecisionReplyWithFormatter(
  ctx: Context,
  formatAnswer: (decision: Decision) => string
): Promise<boolean> {
  const replyTo = (ctx.message as any)?.reply_to_message?.message_id;
  if (!replyTo) return false;

  const decisionId = messageToDecision.get(replyTo);
  if (!decisionId) return false;

  const decision = getDecision(decisionId);
  if (!decision || decision.answer) return false;

  const answerText = formatAnswer(decision);
  answerDecision(decisionId, answerText);
  messageToDecision.delete(replyTo);
  const workspace = getWorkspace(decision.workspaceId);
  if (workspace?.telegramThreadId) {
    syncWorkspaceTopic(ctx.telegram, workspace).catch((err) =>
      console.error(`[forum] topic sync error ${workspace.telegramThreadId}:`, err)
    );
  }
  await ctx.reply(`Answered: ${truncate(answerText, 200)}`, {
    reply_parameters: { message_id: (ctx.message as any).message_id },
  });
  return true;
}

// ── Photo handler ────────────────────────────────────────────

const IMAGE_REVIEW_FALLBACK_PROMPT =
  "The user sent a screenshot/image; it is attached below as a file reference. Open the attached image with the Read tool, then respond to what it shows.";

async function handlePhotoMessage(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  if (!chatId) return;

  const msg = ctx.message as any;
  if (!msg?.photo?.length) return;

  // Get the largest photo (last in the array)
  const photo = msg.photo[msg.photo.length - 1];
  const caption = msg.caption?.trim() ?? "";

  // If caption contains a bot command, route it (Telegram doesn't fire bot.command for photo captions)
  if (caption.startsWith("/")) {
    const localPath = await downloadTelegramFile(ctx, photo.file_id, ".jpg");
    await handleCaptionCommand(ctx, caption, localPath);
    return;
  }

  const localPath = await downloadTelegramFile(ctx, photo.file_id, ".jpg");
  if (
    await tryAnswerDecisionReplyWithFormatter(ctx, (decision) => {
      const stagedPath = stageDecisionAttachment(decision, localPath);
      const ref = formatAttachmentReference(stagedPath);
      return caption ? `${ref}\n${caption}` : ref;
    })
  ) {
    return;
  }

  const repliedTarget = getReplyTargetWorkspace(ctx, chatId);
  if (repliedTarget) {
    const message = caption
      ? applySkillHashtag(caption)
      : IMAGE_REVIEW_FALLBACK_PROMPT;
    await sendMessageToWorkspace(ctx, repliedTarget.workspace, message, [localPath], {
      sessionId: repliedTarget.sessionId,
    });
    return;
  }

  // If sent inside a forum topic, route to that workspace automatically
  const threadId = (ctx.message as any)?.message_thread_id;
  if (threadId) {
    const threadWorkspace = getWorkspaceByThreadId(chatId, threadId);
    if (threadWorkspace) {
      const message = caption
        ? applySkillHashtag(caption)
        : IMAGE_REVIEW_FALLBACK_PROMPT;
      await sendMessageToWorkspace(ctx, threadWorkspace, message, [localPath]);
      return;
    }
  }

  const repoTopic = getThreadRepoTopic(ctx, chatId);
  if (repoTopic) {
    const message = caption
      ? applySkillHashtag(caption)
      : IMAGE_REVIEW_FALLBACK_PROMPT;
    await startWorkspaceFromRepoTopic(ctx, repoTopic, message, [localPath]);
    return;
  }

  // General-chat fallback: if the caption has routing intent (repo/workspace
  // name, skill hashtag, etc.), let the AI router pick the target and forward
  // the image as an attachment.
  if (caption) {
    const routed = await tryAutoRouteText(ctx, chatId, caption, [localPath]);
    if (routed) return;
  }

  await ctx.reply(
    "Got your image. Reply to a question from an agent, or use /send to forward to a workspace."
  );
}

// ── Generic attachment handler (document/audio/video/animation) ──────

type AttachmentKind = "document" | "audio" | "video" | "animation";

interface TelegramFileSpec {
  fileId: string;
  ext: string;
  mimeType?: string;
  label: string;
  fallbackPrompt: string;
}

function describeAttachment(ctx: Context, kind: AttachmentKind): TelegramFileSpec | null {
  const msg = ctx.message as any;
  const meta = msg?.[kind];
  if (!meta?.file_id) return null;

  const fileName: string | undefined = meta.file_name;
  const mimeType: string | undefined = meta.mime_type;
  const duration: number | undefined = meta.duration;

  let ext = "";
  if (fileName) ext = path.extname(fileName);
  if (!ext && mimeType) {
    const slash = mimeType.indexOf("/");
    if (slash >= 0) ext = "." + mimeType.slice(slash + 1).split(";")[0].trim();
  }
  if (!ext) {
    ext = kind === "audio" ? ".mp3" : kind === "video" ? ".mp4" : kind === "animation" ? ".mp4" : ".bin";
  }

  const niceName = fileName ? `: ${fileName}` : "";
  const dur = duration ? ` (${duration}s)` : "";
  const prettyKind = kind === "animation" ? "Animation" : capitalize(kind);

  return {
    fileId: meta.file_id,
    ext,
    mimeType,
    label: `${prettyKind}${dur}${niceName}`,
    fallbackPrompt: `The user sent a ${kind}${dur}${niceName}. Please review the attached file.`,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const TRANSCRIBABLE_AUDIO_EXTS = new Set([
  ".mp3", ".m4a", ".wav", ".ogg", ".oga", ".opus", ".flac", ".aac",
]);

function isTranscribableAudio(kind: AttachmentKind, spec: TelegramFileSpec): boolean {
  return kind === "audio" ||
    TRANSCRIBABLE_AUDIO_EXTS.has(spec.ext.toLowerCase()) ||
    spec.mimeType?.startsWith("audio/") === true;
}

async function buildAudioMessageOrAttachment(
  localPath: string,
  caption: string,
  fallbackPrompt: string
): Promise<{ message: string; attachments: string[] }> {
  const transcript = await transcribeVoiceMessage(localPath);
  if (transcript) {
    const text = caption ? `${caption}\n\n${transcript}` : transcript;
    return { message: applySkillHashtag(text), attachments: [] };
  }
  return {
    message: caption ? applySkillHashtag(caption) : fallbackPrompt,
    attachments: [localPath],
  };
}

async function handleAttachmentMessage(ctx: Context, kind: AttachmentKind): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  if (!chatId) return;

  const spec = describeAttachment(ctx, kind);
  if (!spec) return;

  const msg = ctx.message as any;
  const caption = msg?.caption?.trim() ?? "";

  // Caption-as-command path mirrors the photo handler.
  if (caption.startsWith("/")) {
    const localPath = await downloadTelegramFile(ctx, spec.fileId, spec.ext);
    await handleCaptionCommand(ctx, caption, localPath);
    return;
  }

  const localPath = await downloadTelegramFile(ctx, spec.fileId, spec.ext);
  const audioLike = isTranscribableAudio(kind, spec);

  // Decision-reply path: stage and forward as a markdown image/link ref so
  // Conductor renders the file inline and agents can echo the same syntax back.
  if (
    await tryAnswerDecisionReplyWithFormatter(ctx, (decision) => {
      const stagedPath = stageDecisionAttachment(decision, localPath);
      const ref = formatAttachmentReference(stagedPath);
      return caption ? `${ref}\n${caption}` : ref;
    })
  ) {
    return;
  }

  const repliedTarget = getReplyTargetWorkspace(ctx, chatId);
  if (repliedTarget) {
    const routed = audioLike
      ? await buildAudioMessageOrAttachment(localPath, caption, spec.fallbackPrompt)
      : {
          message: caption ? applySkillHashtag(caption) : spec.fallbackPrompt,
          attachments: [localPath],
        };
    await sendMessageToWorkspace(ctx, repliedTarget.workspace, routed.message, routed.attachments, {
      sessionId: repliedTarget.sessionId,
    });
    return;
  }

  const threadId = (ctx.message as any)?.message_thread_id;
  if (threadId) {
    const threadWorkspace = getWorkspaceByThreadId(chatId, threadId);
    if (threadWorkspace) {
      const routed = audioLike
        ? await buildAudioMessageOrAttachment(localPath, caption, spec.fallbackPrompt)
        : {
            message: caption ? applySkillHashtag(caption) : spec.fallbackPrompt,
            attachments: [localPath],
          };
      await sendMessageToWorkspace(ctx, threadWorkspace, routed.message, routed.attachments);
      return;
    }
  }

  const repoTopic = getThreadRepoTopic(ctx, chatId);
  if (repoTopic) {
    const routed = audioLike
      ? await buildAudioMessageOrAttachment(localPath, caption, spec.fallbackPrompt)
      : {
          message: caption ? applySkillHashtag(caption) : spec.fallbackPrompt,
          attachments: [localPath],
        };
    await startWorkspaceFromRepoTopic(ctx, repoTopic, routed.message, routed.attachments);
    return;
  }

  if (audioLike) {
    const routed = await tryAutoRouteVoice(ctx, chatId, localPath, caption);
    if (routed) return;
  }

  if (caption) {
    const routed = await tryAutoRouteText(ctx, chatId, caption, [localPath]);
    if (routed) return;
  }

  await ctx.reply(
    `Got your ${kind}. Reply to a question from an agent, or use /send to forward to a workspace.`
  );
}

/**
 * Handle a bot command sent as a photo/voice caption.
 * Telegram doesn't fire bot.command() for captions, so we parse manually.
 */
async function handleCaptionCommand(
  ctx: Context,
  caption: string,
  attachmentPath: string
): Promise<void> {
  const runMatch = caption.match(/^\/run\s+(.+)/);
  if (runMatch) {
    const args = runMatch[1].trim();
    const spaceIdx = args.indexOf(" ");
    if (spaceIdx === -1) {
      // Caption is "/run 3" with no prompt — use attachment as context
      const repoInput = args;
      const repoName = resolveRepo(repoInput);
      if (!repoName) {
        await ctx.reply(`Repo "${escHtml(repoInput)}" not found. Use /repos to see available repos.`, { parse_mode: "HTML" });
        return;
      }
      await startWorkspaceFromMessage(ctx, repoName, "", [attachmentPath]);
      return;
    }

    const repoInput = args.slice(0, spaceIdx);
    const prompt = args.slice(spaceIdx + 1).trim();
    const repoName = resolveRepo(repoInput);
    if (!repoName) {
      const repos = getRepoList();
      const repoLines = repos.map((r, i) => `${i + 1}. <code>${escHtml(r)}</code>`).join("\n");
      await ctx.reply(
        `Repo "${escHtml(repoInput)}" not found.\n\nAvailable repos:\n${repoLines}`,
        { parse_mode: "HTML" }
      );
      return;
    }
    await startWorkspaceFromMessage(ctx, repoName, prompt, [attachmentPath]);
    return;
  }

  const sendMatch = caption.match(/^\/send\s+(.+)/);
  if (sendMatch) {
    const chatId = ctx.chat?.id?.toString();
    const args = sendMatch[1].trim();
    const spaceIdx = args.indexOf(" ");
    const wsName = spaceIdx === -1 ? args : args.slice(0, spaceIdx);
    const message = spaceIdx === -1 ? "" : args.slice(spaceIdx + 1).trim();

    let workspace = getWorkspace(wsName);
    if (workspace && chatId && workspace.telegramChatId !== chatId) {
      workspace = undefined;
    }
    if (!workspace) {
      const all = chatId ? getAllWorkspacesForChat(chatId, 50) : getAllWorkspaces(50);
      const matches = all.filter((ws) => ws.conductorWorkspaceName === wsName);
      if (matches.length > 1) {
        await ctx.reply(`Workspace "${escHtml(wsName)}" is ambiguous in this chat. Use the workspace id instead.`, { parse_mode: "HTML" });
        return;
      }
      workspace = matches[0];
    }
    if (workspace) {
      await sendMessageToWorkspace(ctx, workspace, message, [attachmentPath]);
    } else {
      await ctx.reply(`Workspace "${escHtml(wsName)}" not found.`, { parse_mode: "HTML" });
    }
    return;
  }

  // Unrecognized command in caption
  await ctx.reply(
    "Got your image. Reply to a question from an agent, or use /send to forward to a workspace."
  );
}
// ── AI auto-routing for general-thread messages ─────────────

async function tryAutoRouteVoice(
  ctx: Context,
  chatId: string,
  voicePath: string,
  caption: string = ""
): Promise<boolean> {
  const repos = getRepoList();
  if (repos.length === 0) return false;

  const activeWorkspaces = getAutoRoutableWorkspaces(chatId);

  try {
    await ctx.reply("🎙 Listening...");
    const result = await routeVoiceMessage(
      voicePath,
      repos,
      activeWorkspaces,
      caption
    );
    if (!result) return false;

    const routingText = [caption, result.transcript].filter(Boolean).join("\n\n");
    if (shouldConfirmGeneralRoute(routingText, result, repos, activeWorkspaces)) {
      await requestRouteConfirmation(ctx, chatId, result, [voicePath]);
      return true;
    }

    return await executeRouteResult(ctx, chatId, result, [voicePath]);
  } catch (err) {
    console.error("[ai-router] voice routing failed:", err);
    return false;
  }
}

async function tryAutoRouteText(
  ctx: Context,
  chatId: string,
  text: string,
  attachments: string[] = []
): Promise<boolean> {
  const repos = getRepoList();
  if (repos.length === 0) return false;

  const activeWorkspaces = getAutoRoutableWorkspaces(chatId);
  const skillMention = parseSkillMention(text);
  const routingText =
    skillMention && skillMention.remaining ? skillMention.remaining : text;

  try {
    const result = await routeTextMessage(routingText, repos, activeWorkspaces);
    if (!result) return false;

    if (skillMention) {
      result.prompt = buildSkillPrompt(skillMention.skill, skillMention.remaining);
    }

    if (shouldConfirmGeneralRoute(text, result, repos, activeWorkspaces)) {
      await requestRouteConfirmation(ctx, chatId, result, attachments);
      return true;
    }

    return await executeRouteResult(ctx, chatId, result, attachments);
  } catch (err) {
    console.error("[ai-router] text routing failed:", err);
    return false;
  }
}

async function executeRouteResult(
  ctx: Context,
  chatId: string,
  result: RouteResult,
  attachments: string[] = [],
  source: RouteSource = "general_ai"
): Promise<boolean> {
  const promptPreview = JSON.stringify(result.prompt.slice(0, 120));
  console.log(
    `[ai-router] decision: action=${result.action} repo=${result.repoName ?? "-"} workspaceId=${result.workspaceId ?? "-"} prompt=${promptPreview}`
  );

  const plan = resolveRouteExecutionPlan(chatId, result);
  if ("existingRejection" in plan && plan.existingRejection) {
    console.log(
      `[ai-router] existing rejected (${plan.existingRejection}); falling back to new`
    );
  }

  if (plan.kind === "existing") {
    recordRouteAttempt({
      chatId,
      source,
      action: "existing",
      repoPath: plan.workspace.repoPath,
      repoName: path.basename(plan.workspace.repoPath),
      workspaceId: plan.workspace.id,
      status: "routed",
    });
    await sendMessageToWorkspace(ctx, plan.workspace, result.prompt, attachments);
    return true;
  }

  if (plan.kind === "new") {
    recordRouteAttempt({
      chatId,
      source,
      action: "new",
      repoPath: repoPathForName(plan.repoName),
      repoName: plan.repoName,
      status: "routed",
      failureReason: plan.existingRejection,
    });
    await startWorkspaceFromMessage(ctx, plan.repoName, result.prompt, attachments);
    return true;
  }

  if (plan.reason === "unresolvable_repo" && plan.repoName) {
    console.log(`[ai-router] unresolvable repo: ${plan.repoName}`);
  }

  recordRouteAttempt({
    chatId,
    source,
    action: result.action,
    repoName: result.repoName ?? null,
    workspaceId: result.workspaceId ?? null,
    status: "failed",
    failureReason:
      plan.reason === "unresolvable_repo" && plan.repoName
        ? `unresolvable_repo:${plan.repoName}`
        : plan.reason,
  });

  return false;
}

function shouldConfirmGeneralRoute(
  text: string,
  result: RouteResult,
  repos: string[],
  activeWorkspaces: Workspace[]
): boolean {
  if (detectExplicitTarget(text, repos)) return false;
  if (detectExplicitWorkspaceTarget(text, activeWorkspaces)) return false;
  // A General-topic route with no explicit repo/workspace is an inference. Ask
  // before creating a branch, workspace, topic, and agent run.
  return result.action === "new" || result.action === "existing";
}

function detectExplicitWorkspaceTarget(text: string, activeWorkspaces: Workspace[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const workspace of activeWorkspaces) {
    const candidates = [
      workspace.id,
      workspace.conductorWorkspaceName,
      workspace.name,
    ].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      const escaped = candidate.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|\\W)${escaped}(\\W|$)`, "i").test(lower)) {
        return true;
      }
    }
  }
  return false;
}

async function requestRouteConfirmation(
  ctx: Context,
  chatId: string,
  result: RouteResult,
  attachments: string[]
): Promise<void> {
  pruneExpiredRouteConfirmations();
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  pendingRouteConfirmations.set(id, {
    chatId,
    result: { ...result },
    attachments: [...attachments],
    createdAt: Date.now(),
  });
  recordRouteAttempt({
    chatId,
    source: "general_ai",
    action: result.action,
    repoName: result.repoName ?? null,
    workspaceId: result.workspaceId ?? null,
    status: "needs_confirmation",
    failureReason: "general_topic_inferred_target",
  });

  const target =
    result.action === "new"
      ? `repo <b>${escHtml(result.repoName ?? "unknown")}</b>`
      : "an existing workspace";
  await ctx.reply(
    `I can route this to ${target}, but the General topic did not name a repo or workspace clearly.\n\n<i>${escHtml(truncate(result.prompt, 240))}</i>`,
    {
      parse_mode: "HTML",
      ...styledKeyboard([
        [btn(`Start in ${result.repoName ?? "target"}`, `routeconfirm:${id}:yes`)],
        [btn("Cancel", `routeconfirm:${id}:cancel`)],
      ]),
    }
  );
}

function pruneExpiredRouteConfirmations(): void {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, pending] of pendingRouteConfirmations) {
    if (pending.createdAt < cutoff) pendingRouteConfirmations.delete(id);
  }
}

function getAutoRoutableWorkspaces(chatId: string): Workspace[] {
  return getActiveWorkspaces().filter(
    (workspace) =>
      workspace.telegramChatId === chatId &&
      workspace.status === "running" &&
      !!workspace.conductorWorkspaceName
  );
}

// ── Voice handler ────────────────────────────────────────────

async function handleVoiceMessage(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  if (!chatId) return;

  const msg = ctx.message as any;
  if (!msg?.voice) return;

  const localPath = await downloadTelegramFile(ctx, msg.voice.file_id, ".ogg");
  const duration = msg.voice.duration ?? 0;
  const caption = msg.caption?.trim() ?? "";

  if (
    await tryAnswerDecisionReplyWithFormatter(ctx, (decision) => {
      const stagedPath = stageDecisionAttachment(decision, localPath);
      const ref = formatAttachmentReference(stagedPath);
      return caption ? `${ref}\n${caption}` : ref;
    })
  ) {
    return;
  }

  const repliedTarget = getReplyTargetWorkspace(ctx, chatId);
  if (repliedTarget) {
    const transcript = await transcribeVoiceMessage(localPath);
    if (transcript) {
      const text = caption ? `${caption}\n\n${transcript}` : transcript;
      await sendMessageToWorkspace(ctx, repliedTarget.workspace, applySkillHashtag(text), [], {
        sessionId: repliedTarget.sessionId,
      });
    } else {
      const message = caption
        ? `${caption}\n\nThe user sent a voice message (${duration}s). Please review the attached recording.`
        : `The user sent a voice message (${duration}s). Please review the attached recording.`;
      await sendMessageToWorkspace(ctx, repliedTarget.workspace, message, [localPath], {
        sessionId: repliedTarget.sessionId,
      });
    }
    return;
  }

  // If sent inside a forum topic, transcribe and send transcript only (no file
  // attachment) — thread tabs already receive pre-transcribed messages, so avoid
  // redundant attachments.
  const threadId = (ctx.message as any)?.message_thread_id;
  if (threadId) {
    const threadWorkspace = getWorkspaceByThreadId(chatId, threadId);
    if (threadWorkspace) {
      const transcript = await transcribeVoiceMessage(localPath);
      if (transcript) {
        const text = caption ? `${caption}\n\n${transcript}` : transcript;
        await sendMessageToWorkspace(ctx, threadWorkspace, applySkillHashtag(text));
      } else {
        const message = caption
          ? `${caption}\n\nThe user sent a voice message (${duration}s). Please review the attached recording.`
          : `The user sent a voice message (${duration}s). Please review the attached recording.`;
        await sendMessageToWorkspace(ctx, threadWorkspace, message, [localPath]);
      }
      return;
    }
  }

  const repoTopic = getThreadRepoTopic(ctx, chatId);
  if (repoTopic) {
    const transcript = await transcribeVoiceMessage(localPath);
    if (transcript) {
      const text = caption ? `${caption}\n\n${transcript}` : transcript;
      await startWorkspaceFromRepoTopic(ctx, repoTopic, applySkillHashtag(text));
    } else {
      const message = caption
        ? `${caption}\n\nThe user sent a voice message (${duration}s). Please review the attached recording.`
        : `The user sent a voice message (${duration}s). Please review the attached recording.`;
      await startWorkspaceFromRepoTopic(ctx, repoTopic, message, [localPath]);
    }
    return;
  }

  // Auto-route: use AI to transcribe and determine the target repo/workspace.
  // Caption (if any) is the user's explicit routing intent; the router sees
  // both signals.
  const routed = await tryAutoRouteVoice(ctx, chatId, localPath, caption);
  if (routed) return;

  await ctx.reply(
    "Got your voice message. Reply to a question from an agent, or use /send to forward to a workspace."
  );
}

// ── Text handler (two-step run flow + decision replies) ──────

async function handleTextMessage(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  if (!chatId) return;
  const selectionKey = getPendingRepoSelectionKey(ctx);

  const text = (ctx.message as any)?.text?.trim();
  if (!text || text.startsWith("/")) return;

  // Check if this is a reply to a decision question
  if (await tryAnswerDecisionReply(ctx, text)) return;

  // Check if this is a reply to a "new thread" prompt
  const replyToMsgId = (ctx.message as any)?.reply_to_message?.message_id;
  if (replyToMsgId) {
    const replyMessageKey = getRepoSelectionMessageKey(chatId, replyToMsgId);
    const threadStart = messageToThreadStart.get(replyMessageKey);
    if (threadStart) {
      messageToThreadStart.delete(replyMessageKey);
      const target = resolveWorkspaceTarget(threadStart.conductorName, {
        chatId,
        repoPath: threadStart.repoPath,
      });
      if (!target || target === "ambiguous") {
        await ctx.reply(`Workspace "${escHtml(threadStart.conductorName)}" is no longer available.`, {
          parse_mode: "HTML",
        });
        return;
      }
      await startThreadForTarget(ctx, target, text);
      return;
    }
  }

  // Check if this is a reply to a repo-selection confirmation message
  if (replyToMsgId) {
    const replyMessageKey = getRepoSelectionMessageKey(chatId, replyToMsgId);
    const repoName = messageToRepoSelection.get(replyMessageKey);
    if (repoName) {
      messageToRepoSelection.delete(replyMessageKey);
      // Also clear pending selection if any
      if (selectionKey) pendingRepoSelection.delete(selectionKey);
      await startWorkspaceFromMessage(ctx, repoName, text);
      return;
    }
  }

  const repliedTarget = getReplyTargetWorkspace(ctx, chatId);
  if (repliedTarget) {
    await sendMessageToWorkspace(ctx, repliedTarget.workspace, applySkillHashtag(text), [], {
      sessionId: repliedTarget.sessionId,
    });
    return;
  }

  // If sent inside a forum topic, route to that workspace automatically
  const threadId = (ctx.message as any)?.message_thread_id;
  if (threadId) {
    const threadWorkspace = getWorkspaceByThreadId(chatId, threadId);
    if (threadWorkspace) {
      await sendMessageToWorkspace(ctx, threadWorkspace, applySkillHashtag(text));
      return;
    }
  }

  const repoTopic = getThreadRepoTopic(ctx, chatId);
  if (repoTopic) {
    await startWorkspaceFromRepoTopic(ctx, repoTopic, applySkillHashtag(text));
    return;
  }

  if (!selectionKey) {
    // No reply context, no forum thread, no pending selection key —
    // try AI auto-routing for general-thread messages.
    const routed = await tryAutoRouteText(ctx, chatId, text);
    if (!routed) {
      await ctx.reply(AUTO_ROUTE_FAILURE_MESSAGE);
    }
    return;
  }

  const pendingSelection = pendingRepoSelection.get(selectionKey);
  if (!pendingSelection) {
    // Has a selection key but no pending selection — try AI auto-routing
    const routed = await tryAutoRouteText(ctx, chatId, text);
    if (!routed) {
      await ctx.reply(AUTO_ROUTE_FAILURE_MESSAGE);
    }
    return;
  }

  const prompt = text;

  // Clear the pending selection
  pendingRepoSelection.delete(selectionKey);
  messageToRepoSelection.delete(pendingSelection.confirmationMessageKey);

  const repos = getRepoList();
  const repoName = repos[pendingSelection.repoNum - 1];
  if (!repoName) return;

  await startWorkspaceFromMessage(ctx, repoName, prompt);
}

// ── /send <workspace> <message> ──────────────────────────────

async function handleSend(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const args = text.replace(/^\/send\s*/, "").trim();
  const chatId = ctx.chat?.id?.toString();

  if (!args) {
    await ctx.reply("Usage: /send <workspace-name> <message>");
    return;
  }

  const spaceIdx = args.indexOf(" ");
  if (spaceIdx === -1) {
    await ctx.reply("Please provide both a workspace name and a message.\n\nExample: /send dubai Fix the login bug");
    return;
  }

  const wsName = args.slice(0, spaceIdx);
  const message = args.slice(spaceIdx + 1).trim();

  // Find workspace by conductor name
  let workspace = getWorkspace(wsName);
  if (workspace && chatId && workspace.telegramChatId !== chatId) {
    workspace = undefined;
  }
  if (!workspace) {
    const all = chatId ? getAllWorkspacesForChat(chatId, 50) : getAllWorkspaces(50);
    const matches = all.filter((ws) => ws.conductorWorkspaceName === wsName);
    if (matches.length > 1) {
      await ctx.reply(`Workspace "${escHtml(wsName)}" is ambiguous in this chat. Use the workspace id instead.`, {
        parse_mode: "HTML",
      });
      return;
    }
    workspace = matches[0];
  }

  const conductorName = workspace?.conductorWorkspaceName ?? wsName;
  if (!workspace) {
    await ctx.reply(`Workspace "${escHtml(conductorName)}" is not tracked in this chat. Use a workspace id, reply inside its topic, or start with /run.`, {
      parse_mode: "HTML",
    });
    return;
  }

  await sendMessageToWorkspace(ctx, workspace, message);
}

// ── /threads [workspace] [new <prompt>] ─────────────────────

async function handleThreads(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const args = text.replace(/^\/threads\s*/, "").trim();
  const chatId = ctx.chat?.id?.toString();
  const contextualTarget = getContextualTarget(ctx);

  let target: WorkspaceTarget | null = null;
  let tail = "";

  if (!args) {
    target = contextualTarget;
  } else {
    const [head, rest] = splitHead(args);
    if (head.toLowerCase() === "new" && contextualTarget) {
      target = contextualTarget;
      tail = args;
    } else {
      const explicitTarget = resolveWorkspaceTarget(head, { chatId });
      if (explicitTarget === "ambiguous") {
        await ctx.reply(`Workspace "${escHtml(head)}" is ambiguous in this chat. Use the workspace id instead.`, {
          parse_mode: "HTML",
        });
        return;
      }
      if (explicitTarget) {
        target = explicitTarget;
        tail = rest;
      } else if (contextualTarget) {
        target = contextualTarget;
        tail = args;
      }
    }
  }

  if (!target) {
    await ctx.reply(
      "Usage: /threads <workspace-name>\n\nInside a workspace topic or reply, use /threads. To start a thread: /threads <workspace-name> new <prompt>."
    );
    return;
  }

  const [maybeNew, newPrompt] = splitHead(tail);
  if (maybeNew.toLowerCase() === "new") {
    if (!newPrompt) {
      await ctx.reply("Usage: /threads <workspace-name> new <prompt>");
      return;
    }
    await startThreadForTarget(ctx, target, newPrompt);
    return;
  }

  await showThreadList(ctx, target);
}

function formatSessionTitle(session: ConductorSessionInfo): string {
  const title = session.title?.trim();
  if (title) return title;
  if (session.isActive) return "Active thread";
  return `Thread ${session.sessionId.slice(0, 8)}`;
}

function rememberThreadAction(input: Omit<
  PendingThreadAction,
  "createdAt"
>): string {
  pruneThreadActions();
  const token = randomUUID().replace(/-/g, "").slice(0, 12);
  pendingThreadActions.set(token, { ...input, createdAt: Date.now() });
  return token;
}

function pruneThreadActions(): void {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [token, action] of pendingThreadActions) {
    if (action.createdAt < cutoff) pendingThreadActions.delete(token);
  }
}

async function showThreadList(ctx: Context, target: WorkspaceTarget): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  const info = getWorkspaceSessionInfo(
    target.conductorName,
    target.repoPath,
    target.trackedWorkspace
  );
  if (!info) {
    await ctx.reply(`Workspace "${escHtml(target.conductorName)}" was not found in Conductor.`, {
      parse_mode: "HTML",
    });
    return;
  }

  const sessions = await getConductorWorkspaceSessions(
    info.workspaceId,
    target.trackedWorkspace?.conductorSessionId ?? info.sessionId,
    target.trackedWorkspace?.conductorBackendKind ??
      (isRemoteConductorWorkspace(info) ? "cloud-api" : "local")
  );
  const remoteBadge = isRemoteConductorWorkspace(info) ? " ☁️" : "";
  const lines = sessions.length > 0
    ? sessions.map((session, index) => {
        const marker = session.isActive ? "▶" : " ";
        const title = formatSessionTitle(session);
        const agent = session.rawAgentType ?? session.agentType;
        return `${marker} ${index + 1}. <b>${escHtml(title)}</b> · <code>${escHtml(session.status ?? "unknown")}</code> · <code>${escHtml(agent)}</code>${session.model ? ` · <code>${escHtml(session.model)}</code>` : ""}`;
      })
    : ["No visible threads found."];

  const rows = sessions
    .filter((session) => !session.isActive)
    .slice(0, 8)
    .map((session) => {
      const token = rememberThreadAction({
        chatId: chatId ?? "",
        action: "select",
        conductorName: target.conductorName,
        repoPath: target.repoPath,
        workspaceId: info.workspaceId,
        sessionId: session.sessionId,
        backendKind: session.backendKind,
      });
      return [btn(`Use ${formatSessionTitle(session)}`, `thread:set:${token}`)];
    });

  if (!isRemoteConductorWorkspace(info) || canUseConductorCloudApi()) {
    const token = rememberThreadAction({
      chatId: chatId ?? "",
      action: "new",
      conductorName: target.conductorName,
      repoPath: target.repoPath,
      workspaceId: info.workspaceId,
      backendKind: isRemoteConductorWorkspace(info) ? "cloud-api" : "local",
    });
    rows.push([btn("New Thread", `thread:new:${token}`)]);
  }

  await ctx.reply(
    `<b>${escHtml(info.displayName)}${remoteBadge} threads</b>\n\n${lines.join("\n")}`,
    {
      parse_mode: "HTML",
      ...(rows.length > 0 ? styledKeyboard(rows) : {}),
    }
  );
}

async function startThreadForTarget(
  ctx: Context,
  target: WorkspaceTarget,
  prompt: string
): Promise<void> {
  const trackedWorkspace = ensureTrackedWorkspace(ctx, target, prompt);
  if (!trackedWorkspace) {
    await ctx.reply(`Could not resolve repo details for <b>${escHtml(target.conductorName)}</b>.`, {
      parse_mode: "HTML",
    });
    return;
  }
  const topicNeedsResume = workspaceTopicNeedsResume(trackedWorkspace);
  await reopenWorkspaceTopicBeforeActivity(
    ctx,
    trackedWorkspace,
    topicNeedsResume
  );
  const threadOpts = trackedWorkspace.telegramThreadId
    ? { message_thread_id: trackedWorkspace.telegramThreadId }
    : {};
  const progress = await ctx.reply(
    `Starting a new thread for <b>${escHtml(target.conductorName)}</b>...\n\n<i>${escHtml(truncate(prompt, 200))}</i>`,
    { parse_mode: "HTML", ...threadOpts }
  );
  updateWorkspaceTelegramMessage(trackedWorkspace.id, progress.message_id.toString());

  const result = await launchWorkspaceSession(target.conductorName, prompt, {
    repoPath: target.repoPath,
    launchMode: "prompt",
    binding: trackedWorkspace,
  });

  if ("error" in result) {
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progress.message_id,
      undefined,
      `Failed to start a new thread for <b>${escHtml(target.conductorName)}</b>:\n${escHtml(result.error)}`,
      { parse_mode: "HTML", ...threadOpts }
    );
    return;
  }

  const durableWorkspace = commitSessionLaunchResult(
    trackedWorkspace,
    target.conductorName,
    result
  );
  if (!durableWorkspace) {
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progress.message_id,
      undefined,
      `⏹ The new Cloud thread was stopped or rebound before success could be reported for <b>${escHtml(target.conductorName)}</b>.`,
      { parse_mode: "HTML", ...threadOpts }
    );
    return;
  }
  await restoreWorkspaceTopicAfterActivity(
    ctx,
    durableWorkspace,
    topicNeedsResume
  );
  await ctx.telegram.editMessageText(
    ctx.chat!.id,
    progress.message_id,
    undefined,
    `🟢 New thread running for <b>${escHtml(target.conductorName)}</b> via <b>${escHtml(result.agentType)}</b> (<code>${escHtml(result.model)}</code>)`,
    { parse_mode: "HTML", ...threadOpts }
  );

  observeAgentCompletion(ctx, durableWorkspace, target.conductorName, result.done);
}

// ── /review <workspace> [instructions] ──────────────────────

async function handleReview(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const args = text.replace(/^\/review\s*/, "").trim();
  const chatId = ctx.chat?.id?.toString();
  const replyTarget = getReplyWorkspaceTarget(ctx);

  let target: WorkspaceTarget | null = null;
  let instructions = "";

  if (!args) {
    target = replyTarget;
  } else {
    const [head, tail] = splitHead(args);
    const explicitTarget = resolveWorkspaceTarget(head, { chatId });
    if (explicitTarget === "ambiguous") {
      await ctx.reply(`Workspace "${escHtml(head)}" is ambiguous in this chat. Use the workspace id instead.`, {
        parse_mode: "HTML",
      });
      return;
    }
    if (explicitTarget) {
      target = explicitTarget;
      instructions = tail;
    } else if (replyTarget) {
      target = replyTarget;
      instructions = args;
    }
  }

  if (!target) {
    await ctx.reply(
      "Usage: /review <workspace-name> [instructions]\n\nYou can also reply to a workspace message with /review."
    );
    return;
  }

  const reviewPrompt = buildReviewPrompt(instructions);
  const trackedWorkspace = ensureTrackedWorkspace(ctx, target, reviewPrompt);
  if (!trackedWorkspace) {
    await ctx.reply(`Could not resolve repo details for <b>${escHtml(target.conductorName)}</b>.`, {
      parse_mode: "HTML",
    });
    return;
  }
  const topicNeedsResume = workspaceTopicNeedsResume(trackedWorkspace);
  await reopenWorkspaceTopicBeforeActivity(
    ctx,
    trackedWorkspace,
    topicNeedsResume
  );
  const progress = await ctx.reply(
    `Starting review for <b>${escHtml(target.conductorName)}</b>...\n\n<i>${escHtml(truncate(reviewPrompt, 200))}</i>`,
    { parse_mode: "HTML" }
  );
  updateWorkspaceTelegramMessage(trackedWorkspace.id, progress.message_id.toString());

  const result = await launchWorkspaceSession(target.conductorName, reviewPrompt, {
    launchMode: "review",
    title: "Review Changes",
    reviewBaseBranch: target.targetBranch,
    repoPath: target.repoPath,
    binding: trackedWorkspace,
  });

  if ("error" in result) {
    updateWorkspaceStatusUnlessTerminal(trackedWorkspace.id, "failed");
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progress.message_id,
      undefined,
      `Failed to start review for <b>${escHtml(target.conductorName)}</b>:\n${escHtml(result.error)}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const durableWorkspace = commitSessionLaunchResult(
    trackedWorkspace,
    target.conductorName,
    result
  );
  if (!durableWorkspace) {
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progress.message_id,
      undefined,
      `⏹ The Cloud review thread was stopped or rebound before success could be reported for <b>${escHtml(target.conductorName)}</b>.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  await restoreWorkspaceTopicAfterActivity(
    ctx,
    durableWorkspace,
    topicNeedsResume
  );

  await ctx.telegram.editMessageText(
    ctx.chat!.id,
    progress.message_id,
    undefined,
    `🟢 Review running for <b>${escHtml(target.conductorName)}</b> via <b>${escHtml(result.agentType)}</b> (<code>${escHtml(result.model)}</code>)`,
    { parse_mode: "HTML" }
  );

  observeAgentCompletion(ctx, durableWorkspace, target.conductorName, result.done);
}

// ── /skills <workspace> ─────────────────────────────────────

async function handleSkills(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const args = text.replace(/^\/skills\s*/, "").trim();
  const chatId = ctx.chat?.id?.toString();
  const explicitTarget = args ? resolveWorkspaceTarget(args, { chatId }) : null;
  if (explicitTarget === "ambiguous") {
    await ctx.reply(`Workspace "${escHtml(args)}" is ambiguous in this chat. Use the workspace id instead.`, {
      parse_mode: "HTML",
    });
    return;
  }
  const target = explicitTarget ?? getContextualTarget(ctx);

  const sections: string[] = [];
  const builtInLines = [
    `<code>gstack</code> — Use the GStack skills available in this workspace`,
    ...WELL_KNOWN_SKILLS.map(
      (s) => `<code>${escHtml(s.skill)}</code> — ${escHtml(s.description)}`
    ),
  ];
  sections.push(`<b>Built-in skills</b>\n${builtInLines.join("\n")}`);

  if (target) {
    const routes = getWorkspaceSkillRoutes(target);
    if (routes.length > 0) {
      const lines = routes.map(
        (route) => `<code>${escHtml(route.skill)}</code> — ${escHtml(route.description)}`
      );
      sections.push(
        `<b>Workspace skills (${escHtml(target.conductorName)})</b>\n${lines.join("\n")}`
      );
    }
  }

  const firstSkill = WELL_KNOWN_SKILLS[0]!.skill;
  const targetHint = target ? escHtml(target.conductorName) : "&lt;workspace&gt;";
  sections.push(
    `<b>How to invoke</b>\n` +
      `• Tag a hashtag anywhere: <code>#${escHtml(firstSkill)} fix the flaky test</code>\n` +
      `• Slash command: <code>/${escHtml(firstSkill)} ${targetHint} [instructions]</code>\n` +
      `• Reply to a workspace message with <code>#${escHtml(firstSkill)}</code> or a slash command\n` +
      `• Custom skill: <code>/skill ${targetHint} &lt;skill-name&gt; [instructions]</code>`
  );

  await ctx.reply(sections.join("\n\n"), { parse_mode: "HTML" });
}

// ── /skill <workspace> <skill> [instructions] ──────────────

async function handleSkill(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const args = text.replace(/^\/skill\s*/, "").trim();
  const chatId = ctx.chat?.id?.toString();
  const replyTarget = getContextualTarget(ctx);

  if (!args) {
    await ctx.reply(
      "Usage: /skill <workspace-name> <skill> [instructions]\n\nYou can also reply to a workspace message or send in a workspace topic with /skill <skill>."
    );
    return;
  }

  const [head, tail] = splitHead(args);
  let target: WorkspaceTarget | null = null;
  const explicitTarget = resolveWorkspaceTarget(head, { chatId });
  if (explicitTarget === "ambiguous") {
    await ctx.reply(`Workspace "${escHtml(head)}" is ambiguous in this chat. Use the workspace id instead.`, {
      parse_mode: "HTML",
    });
    return;
  }
  target = explicitTarget;
  let skill = "";
  let extraInstructions = "";

  if (target) {
    [skill, extraInstructions] = splitHead(tail);
  } else if (replyTarget) {
    target = replyTarget;
    skill = head;
    extraInstructions = tail;
  }

  if (!target || !skill) {
    await ctx.reply(
      "Usage: /skill <workspace-name> <skill> [instructions]\n\nYou can also reply to a workspace message with /skill <skill>."
    );
    return;
  }

  await sendPromptToTarget(ctx, target, buildSkillPrompt(skill, extraInstructions));
}

// ── /gstack <workspace> [instructions] ──────────────────────

async function handleGstack(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const args = text.replace(/^\/gstack\s*/, "").trim();
  const chatId = ctx.chat?.id?.toString();
  const replyTarget = getContextualTarget(ctx);

  let target: WorkspaceTarget | null = null;
  let extraInstructions = "";

  if (!args) {
    target = replyTarget;
  } else {
    const [head, tail] = splitHead(args);
    const explicitTarget = resolveWorkspaceTarget(head, { chatId });
    if (explicitTarget === "ambiguous") {
      await ctx.reply(`Workspace "${escHtml(head)}" is ambiguous in this chat. Use the workspace id instead.`, {
        parse_mode: "HTML",
      });
      return;
    }
    if (explicitTarget) {
      target = explicitTarget;
      extraInstructions = tail;
    } else if (replyTarget) {
      target = replyTarget;
      extraInstructions = args;
    }
  }

  if (!target) {
    await ctx.reply(
      "Usage: /gstack <workspace-name> [instructions]\n\nYou can also reply to a workspace message, send in a workspace topic, or tag #gstack in any message."
    );
    return;
  }

  await sendPromptToTarget(ctx, target, buildGstackPrompt(extraInstructions));
}

// ── /<well-known-skill> [workspace] [instructions] ──────────

async function handleWellKnownSkillCommand(
  ctx: Context,
  spec: WellKnownSkill
): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const args = text.replace(/^\/[\w@]+\s*/, "").trim();
  const chatId = ctx.chat?.id?.toString();
  const replyTarget = getContextualTarget(ctx);

  let target: WorkspaceTarget | null = null;
  let extraInstructions = "";

  if (!args) {
    target = replyTarget;
  } else {
    const [head, tail] = splitHead(args);
    const explicitTarget = resolveWorkspaceTarget(head, { chatId });
    if (explicitTarget === "ambiguous") {
      await ctx.reply(`Workspace "${escHtml(head)}" is ambiguous in this chat. Use the workspace id instead.`, {
        parse_mode: "HTML",
      });
      return;
    }
    if (explicitTarget) {
      target = explicitTarget;
      extraInstructions = tail;
    } else if (replyTarget) {
      target = replyTarget;
      extraInstructions = args;
    }
  }

  if (!target) {
    await ctx.reply(
      `Usage: /${spec.command} <workspace-name> [instructions]\n\nYou can also reply to a workspace message, send in a workspace topic, or tag #${spec.skill} in a message.`
    );
    return;
  }

  await sendPromptToTarget(ctx, target, buildSkillPrompt(spec.skill, extraInstructions));
  if (spec.skill === "ship" && target.trackedWorkspace) {
    await sendPrStatusCard(ctx, target.trackedWorkspace);
  }
}

// ── /setup, /start ──────────────────────────────────────────

async function handleSetup(ctx: Context): Promise<void> {
  const response = await getSetupDiagnostics(ctx).then(buildSetupResponse);
  const setupUserId = ctx.from?.id;
  await ctx.reply(response.message, {
    parse_mode: "HTML",
    ...(response.showApplyButton && setupUserId
      ? styledButtons([btn("Use This Chat", `setup:apply:${setupUserId}`)])
      : {}),
  });
}

// ── /help ───────────────────────────────────────────────────

function formatAgoSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ${seconds % 60}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

async function handlePing(ctx: Context): Promise<void> {
  const hb = getHeartbeat();
  const uptimeSecs = Math.round(process.uptime());
  const now = Date.now();

  const lines = [`🏓 <b>pong</b>`];
  lines.push(`<code>pid ${process.pid} · node ${process.versions.node}</code>`);
  if (hb?.version) lines.push(`<code>v${escHtml(hb.version)}</code>`);
  lines.push(`uptime: ${formatAgoSeconds(uptimeSecs)}`);

  if (hb) {
    const beatAgo = Math.max(0, Math.round((now - Date.parse(hb.lastBeatAt)) / 1000));
    lines.push(`last heartbeat: ${beatAgo}s ago`);
    lines.push(`boot #${hb.bootCount}`);
    if (hb.lastExitReason) {
      lines.push(`<i>last exit: ${escHtml(hb.lastExitReason)}</i>`);
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    `<b>Conductor Telegram Bot</b>

Commands:
/setup — Check setup and apply this chat
/run &lt;repo&gt; &lt;prompt&gt; — Start Cloud-first (local fallback)
/run &lt;number&gt; &lt;prompt&gt; — Start Cloud-first by repo number
/cloud &lt;project&gt; &lt;prompt&gt; — Start a ☁️ cloud workspace (no Mac needed)
/projects [name] — List ☁️ cloud projects, or one project's workspaces
/fleet [hours] — ☁️ org-wide cloud activity report
/rename &lt;name&gt; — Rename the current ☁️ cloud workspace
/renamethread &lt;name&gt; — Rename the current ☁️ cloud thread
/send &lt;workspace&gt; &lt;message&gt; — Send follow-up to agent
/threads [workspace] — List, switch, or start Conductor threads
/review &lt;workspace&gt; [instructions] — Start a review session
/skills [workspace] — List built-in and workspace skills
/skill &lt;workspace&gt; &lt;skill&gt; [instructions] — Ask the agent to invoke a skill
/gstack [workspace] [instructions] — Ask the agent to use GStack skills
/ship, /qa, /investigate, /retro, /health, /checkpoint — Shortcut skills
/workspaces — List all tracked workspaces
/prs, /ship_status — Show PR and branch ship status
/decisions — Show pending agent questions
/status — Show active workspace summary
/stop &lt;name&gt; — Stop a workspace
/repos — List repos (tap to select)
/ping — Bot liveness (uptime, heartbeat, version)
/help — Show this message

<b>Invoking skills</b>
• Tag <code>#skill</code> anywhere in a message: <code>#ship</code>, <code>#qa find auth bugs</code>, <code>#gstack</code>.
• Inside a workspace topic or reply, the hashtag targets that workspace automatically.
• Replying to a forwarded thread message targets that exact Conductor thread.
• Slash shortcuts (like <code>/ship</code>) accept an optional workspace name and instructions.
• Use <code>/skills</code> any time to see the full list.

Tap a repo from /repos, then type your prompt. In group/forum mode, tap Topic beside a repo to create a durable repo topic for new tasks.
Reply with a photo, screenshot, or voice note to send it to the agent.`,
    { parse_mode: "HTML" }
  );
}

// ── Inline button callbacks ─────────────────────────────────

async function handleSetupApplyCallback(ctx: Context): Promise<void> {
  const match = (ctx as any).match;
  const expectedUserId = match?.[1];
  const currentUserId = ctx.from?.id?.toString();
  if (!expectedUserId || currentUserId !== expectedUserId) {
    await ctx.answerCbQuery("Run /setup yourself in this chat");
    return;
  }

  const diag = await getSetupDiagnostics(ctx);

  try {
    applySetupConfiguration(diag);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.answerCbQuery("Failed to save setup");
    await ctx.reply(`Failed to save setup: ${escHtml(message)}`, {
      parse_mode: "HTML",
    });
    return;
  }

  const response = buildSetupResponse({
    ...diag,
    configuredOwnerChatId: diag.chatId,
    configuredOwnerUserId: diag.chatType === "private" ? null : diag.userId,
  });

  await ctx.answerCbQuery("This chat is now configured");
  const edit = (ctx as any).editMessageText?.bind(ctx);
  if (edit) {
    await edit(response.message, { parse_mode: "HTML" }).catch(async () => {
      await ctx.reply(response.message, { parse_mode: "HTML" });
    });
    return;
  }

  await ctx.reply(response.message, { parse_mode: "HTML" });
}

async function handleRouteConfirmCallback(ctx: Context): Promise<void> {
  const match = (ctx as any).match;
  const id = match?.[1];
  const choice = match?.[2] as "yes" | "cancel" | undefined;
  const chatId = ctx.chat?.id?.toString();
  if (!id || !choice || !chatId) return;

  const pending = pendingRouteConfirmations.get(id);
  if (!pending || pending.chatId !== chatId) {
    await ctx.answerCbQuery("This route confirmation expired");
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    return;
  }

  pendingRouteConfirmations.delete(id);
  if (choice === "cancel") {
    recordRouteAttempt({
      chatId,
      source: "general_ai",
      action: pending.result.action,
      repoName: pending.result.repoName ?? null,
      workspaceId: pending.result.workspaceId ?? null,
      status: "cancelled",
      failureReason: "user_cancelled_confirmation",
    });
    await ctx.answerCbQuery("Cancelled");
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    return;
  }

  await ctx.answerCbQuery("Starting...");
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
  const routed = await executeRouteResult(
    ctx,
    chatId,
    pending.result,
    pending.attachments,
    "general_ai"
  );
  if (!routed) {
    await ctx.reply(
      "That route is no longer available. Use /run <repo> to start a workspace, or send a new message with the repo/workspace named explicitly."
    );
  }
}

async function handleThreadCallback(ctx: Context): Promise<void> {
  const match = (ctx as any).match;
  const action = match?.[1] as "set" | "new" | undefined;
  const token = match?.[2];
  const chatId = ctx.chat?.id?.toString();
  if (!action || !token || !chatId) return;

  const pending = pendingThreadActions.get(token);
  if (!pending || pending.chatId !== chatId || pending.action !== (action === "set" ? "select" : "new")) {
    await ctx.answerCbQuery("This thread action expired");
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    return;
  }

  pendingThreadActions.delete(token);

  if (action === "set") {
    if (!pending.sessionId) return;
    const ok = await setConductorActiveSession(
      pending.workspaceId,
      pending.sessionId,
      pending.backendKind
    );
    if (!ok) {
      await ctx.answerCbQuery("Thread no longer exists");
      return;
    }

    const tracked = getWorkspaceByName(pending.conductorName, {
      chatId,
      repoPath: pending.repoPath ?? undefined,
    });
    if (tracked) {
      const cursor = getThreadCursor(tracked.id, pending.sessionId);
      const latest =
        cursor ??
        (await getMaxSessionMessageCursor(
          pending.sessionId,
          pending.backendKind
        ));
      const rowid =
        "lastForwardedRowid" in latest
          ? latest.lastForwardedRowid
          : latest.rowid;
      if (!cursor) {
        updateThreadCursor(
          tracked.id,
          pending.sessionId,
          rowid,
          null,
          "messageId" in latest ? latest.messageId : null,
          pending.backendKind
        );
      }
      updateWorkspaceConductorSession(tracked.id, pending.sessionId);
      updateWorkspaceForwardCursor(tracked.id, rowid);
    }

    await ctx.answerCbQuery("Default thread updated");
    await ctx.reply(`Default thread updated for <b>${escHtml(pending.conductorName)}</b>.`, {
      parse_mode: "HTML",
    });
    return;
  }

  const prompt = await ctx.reply(
    `Reply to this message with the first prompt for a new thread in <b>${escHtml(pending.conductorName)}</b>.`,
    { parse_mode: "HTML" }
  );
  messageToThreadStart.set(
    getRepoSelectionMessageKey(chatId, prompt.message_id),
    {
      conductorName: pending.conductorName,
      repoPath: pending.repoPath,
    }
  );
  await ctx.answerCbQuery("Reply with the first prompt");
}

export async function handleStopCallback(ctx: Context): Promise<void> {
  const match = (ctx as any).match;
  const workspaceId = match?.[1];
  if (!workspaceId) return;

  const workspace = getWorkspace(workspaceId);
  const hadPendingLaunch = workspace
    ? Boolean(getPendingCloudLaunch(workspace.id))
    : false;
  const pendingCancellation = workspace
    ? markPendingCloudLaunchCanceled(workspace.id)
    : false;
  let deferTopicFinalization = Boolean(
    workspace &&
      (hadPendingLaunch ||
        hasPendingCloudTopicFinalizationNotice(workspace.id))
  );
  if (workspace?.conductorWorkspaceName) {
    const info = getWorkspaceSessionInfo(
      workspace.conductorWorkspaceName,
      workspace.repoPath,
      workspace
    );
    const terminalIntent = getPendingCloudTerminalIntent(workspace.id);
    const terminalResult = terminalIntent
      ? await reconcilePendingCloudTerminalIntent(workspace.id)
      : null;
    deferTopicFinalization =
      hadPendingLaunch ||
      hasPendingCloudTopicFinalizationNotice(workspace.id);
    const stopped = terminalResult
      ? terminalResult.status === "completed" || terminalResult.status === "none"
      : await stopConductorAgent(
          workspace.conductorWorkspaceName,
          workspace.repoPath,
          workspace.conductorSessionId,
          workspace
        );
    if (
      (terminalIntent || (info && isRemoteConductorWorkspace(info))) &&
      !stopped
    ) {
      if (terminalResult?.status === "failed") {
        await ctx.answerCbQuery(
          "Cloud stop gave up; check the workspace in Conductor Cloud"
        );
        return;
      }
      await ctx.answerCbQuery(
        pendingCancellation
          ? "Stop saved; Cloud cancellation will retry"
          : "Conductor API could not stop this cloud session"
      );
      return;
    }
  }

  updateWorkspaceStatus(workspaceId, "stopped");
  if (workspace?.telegramThreadId && !deferTopicFinalization) {
    try {
      await syncWorkspaceTopic(ctx.telegram, { ...workspace, status: "stopped" });
    } catch (err) {
      console.error(`[forum] topic sync error ${workspace.telegramThreadId}:`, err);
    }
    await closeWorkspaceTopic(
      ctx.telegram,
      workspace.telegramChatId,
      workspace.telegramThreadId
    );
  }
  await ctx.answerCbQuery("Agent stopped");
  await ctx
    .editMessageReplyMarkup(
      styledButtons([btn("Archive", `archive:${workspaceId}`)]).reply_markup
    )
    .catch(() => undefined);
}

async function handleOpenCallback(ctx: Context): Promise<void> {
  await ctx.answerCbQuery("Open workspace in Conductor UI");
}

export async function handleArchiveCallback(ctx: Context): Promise<void> {
  const match = (ctx as any).match;
  const workspaceId = match?.[1];
  if (!workspaceId) return;

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    await ctx.answerCbQuery("Workspace not found");
    return;
  }
  // Persist terminal intent before any remote await so launch/outbox
  // reconciliation cannot send another prompt after the Archive click.
  archiveWorkspace(workspaceId);
  let deferTopicFinalization =
    hasPendingCloudTopicFinalizationNotice(workspace.id);
  if (workspace.conductorWorkspaceName) {
    const info = getWorkspaceSessionInfo(
      workspace.conductorWorkspaceName,
      workspace.repoPath,
      workspace
    );
    const terminalIntent = getPendingCloudTerminalIntent(workspace.id);
    const terminalResult = terminalIntent
      ? await reconcilePendingCloudTerminalIntent(workspace.id)
      : null;
    deferTopicFinalization =
      hasPendingCloudTopicFinalizationNotice(workspace.id);
    const archived = terminalResult
      ? terminalResult.status === "completed" || terminalResult.status === "none"
      : await archiveConductorWorkspace(
          workspace.conductorWorkspaceName,
          workspace.repoPath,
          workspace
        );
    if (
      (terminalIntent || (info && isRemoteConductorWorkspace(info))) &&
      !archived
    ) {
      if (terminalResult?.status === "failed") {
        await ctx.answerCbQuery(
          "Cloud archive gave up; check the workspace in Conductor Cloud"
        );
        return;
      }
      await ctx.answerCbQuery(
        "Cloud archive is not confirmed; local prompt delivery remains blocked"
      );
      return;
    }
  }

  if (workspace.telegramThreadId && !deferTopicFinalization) {
    try {
      await syncWorkspaceTopic(ctx.telegram, { ...workspace, status: "archived" });
    } catch (err) {
      console.error(`[forum] topic sync error ${workspace.telegramThreadId}:`, err);
    }
    await closeWorkspaceTopic(
      ctx.telegram,
      workspace.telegramChatId,
      workspace.telegramThreadId
    );
  }

  await ctx.answerCbQuery("Workspace archived");
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
}

async function handleDecisionCallback(ctx: Context): Promise<void> {
  const match = (ctx as any).match;
  const decisionId = parseInt(match?.[1], 10);
  const optionIndex = parseInt(match?.[2], 10);
  if (Number.isNaN(decisionId) || Number.isNaN(optionIndex)) return;

  const decision = getDecision(decisionId);
  if (!decision) return;

  const options: string[] | null = decision.options
    ? JSON.parse(decision.options)
    : null;
  const answer = options?.[optionIndex];
  if (!answer) return;

  answerDecision(decisionId, answer);
  answerPendingStdinDecision(decisionId, answer);
  const workspace = getWorkspace(decision.workspaceId);
  if (workspace?.telegramThreadId) {
    syncWorkspaceTopic(ctx.telegram, workspace).catch((err) =>
      console.error(`[forum] topic sync error ${workspace.telegramThreadId}:`, err)
    );
  }

  await ctx.answerCbQuery(`Answered: ${answer}`);
  await ctx.editMessageReplyMarkup(undefined);
}

// ── PR status and approval-gated actions ─────────────────────

async function sendPrStatusCard(ctx: Context, workspace: Workspace): Promise<void> {
  const { record } = await refreshWorkspacePr(workspace);
  const threadOpts = workspace.telegramThreadId
    ? { message_thread_id: workspace.telegramThreadId }
    : {};
  await ctx.telegram.sendMessage(workspace.telegramChatId, formatPrCard(workspace, record), {
    parse_mode: "HTML",
    ...threadOpts,
    ...prKeyboard(record, workspace),
  });
}

async function handlePrCallback(ctx: Context): Promise<void> {
  const match = (ctx as any).match;
  const action = match?.[1] as "refresh" | "fix" | "merge";
  const workspaceId = match?.[2];
  if (!action || !workspaceId) return;

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    await ctx.answerCbQuery("Workspace not found");
    return;
  }
  if (action === "refresh") {
    await ctx.answerCbQuery("Refreshing PR status...");
    const { record } = await refreshWorkspacePr(workspace);
    await editOrSendPrCard(ctx, workspace, record);
    return;
  }

  if (action === "fix") {
    await ctx.answerCbQuery("Asking agent to fix PR...");
    const { record } = await refreshWorkspacePr(workspace);
    if (!workspace.conductorWorkspaceName) {
      await ctx.reply("Workspace is not linked to a Conductor session.");
      return;
    }
    const topicNeedsResume = workspaceTopicNeedsResume(workspace);
    await reopenWorkspaceTopicBeforeActivity(
      ctx,
      workspace,
      topicNeedsResume
    );
    const prompt = buildFixPrPrompt(record);
    const result = await sendToSession(
      workspace.conductorWorkspaceName,
      prompt,
      [],
      { repoPath: workspace.repoPath, binding: workspace }
    );
    if ("error" in result) {
      await ctx.reply(`Failed: ${escHtml(result.error)}`, { parse_mode: "HTML" });
      return;
    }
    const durable = getWorkspace(workspace.id) ?? workspace;
    if (workspace.conductorBackendKind !== "cloud-api") {
      updateWorkspaceStatus(workspace.id, "running");
      durable.status = "running";
    }
    await restoreWorkspaceTopicAfterActivity(
      ctx,
      durable,
      topicNeedsResume
    );
    await sendPrStatusCard(ctx, durable);
    return;
  }

  await ctx.answerCbQuery("Checking merge eligibility...");
  const { record } = await refreshWorkspacePr(workspace);
  if (!canMergePr(record)) {
    await editOrSendPrCard(ctx, workspace, record);
    await ctx.reply("PR is not eligible to merge yet. Refresh after checks pass.");
    return;
  }
  if (!record.prNumber || !record.headSha) {
    await ctx.reply("PR identity is incomplete. Refresh and try again.");
    return;
  }
  const intent = createMergeIntent({
    workspaceId: workspace.id,
    prNumber: record.prNumber,
    headSha: record.headSha,
    requestedBy: ctx.from!.id.toString(),
  });
  await ctx.reply(
    [
      "<b>Confirm merge</b>",
      `PR: <code>#${record.prNumber}</code>`,
      `Exact reviewed head: <code>${escHtml(record.headSha.slice(0, 12))}</code>`,
      "This confirmation expires in 10 minutes and becomes invalid if the PR head changes.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...styledKeyboard([
        [btn("Confirm exact SHA merge", `pr:mergeconfirm:${intent.intentId}`)],
      ]),
    }
  );
}

async function handlePrMergeConfirmCallback(ctx: Context): Promise<void> {
  const intentId = (ctx as any).match?.[1] as string | undefined;
  if (!intentId || !ctx.from) return;

  const intent = getMergeIntent(intentId);
  if (!intent || intent.requestedBy !== ctx.from.id.toString()) {
    await ctx.answerCbQuery("Merge confirmation is invalid");
    return;
  }
  if (intent.consumedAt || Date.parse(intent.expiresAt) <= Date.now()) {
    await ctx.answerCbQuery("Merge confirmation expired");
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    return;
  }

  const workspace = getWorkspace(intent.workspaceId);
  if (!workspace) {
    await ctx.answerCbQuery("Workspace not found");
    return;
  }
  await ctx.answerCbQuery("Re-checking exact PR head...");
  const { record } = await refreshWorkspacePr(workspace);
  if (
    !canMergePr(record) ||
    record.prNumber !== intent.prNumber ||
    record.headSha?.toLowerCase() !== intent.headSha.toLowerCase()
  ) {
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    await ctx.reply(
      "Merge stopped: the PR, review, checks, mergeability, or exact head SHA changed. Request a fresh merge confirmation."
    );
    await editOrSendPrCard(ctx, workspace, record);
    return;
  }
  const consumed = consumeMergeIntent(intentId, ctx.from.id.toString());
  if (!consumed) {
    await ctx.reply("Merge confirmation was already used or expired.");
    return;
  }
  await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);

  const merged = await mergeWorkspacePr(workspace, record, intent.headSha);
  if (!merged.ok) {
    await ctx.reply(`Merge failed: ${escHtml(merged.message)}`, { parse_mode: "HTML" });
    const refreshed = await refreshWorkspacePr(workspace);
    await editOrSendPrCard(ctx, workspace, refreshed.record);
    return;
  }

  const refreshed = await refreshWorkspacePr(workspace);
  await ctx.reply(`Merged PR: ${escHtml(merged.message)}`, { parse_mode: "HTML" }).catch((error) =>
    console.error(`[pr:${record.prNumber}] merge notice failed:`, error)
  );
  await editOrSendPrCard(ctx, workspace, refreshed.record).catch((error) =>
    console.error(`[pr:${record.prNumber}] merged PR card failed:`, error)
  );
}

async function editOrSendPrCard(
  ctx: Context,
  workspace: Workspace,
  record: PrRecord
): Promise<void> {
  const edit = (ctx as any).editMessageText?.bind(ctx);
  if (edit) {
    const edited = await edit(formatPrCard(workspace, record), {
      parse_mode: "HTML",
      ...prKeyboard(record, workspace),
    }).then(() => true).catch(() => false);
    if (edited) return;
  }
  await sendPrStatusCard(ctx, workspace);
}

function buildFixPrPrompt(record: PrRecord): string {
  const lines = [
    "The PR is not ready to merge from Telegram.",
    "Inspect the current branch, GitHub PR, failing checks, and review comments.",
    "Fix the issue, push the branch, and report the updated PR status.",
    "",
    `Branch: ${record.branch || "(unknown)"}`,
  ];
  if (record.prUrl) lines.push(`PR: ${record.prUrl}`);
  if (record.checksSummary) lines.push(`Checks: ${record.checksSummary}`);
  if (record.lastError) lines.push(`Verification error: ${record.lastError}`);
  return lines.join("\n");
}

// ── Post-done: Review Changes / Generate PR ─────────────────

function buildPrPrompt(): string {
  return [
    "Review all changes in this workspace and create a pull request.",
    "Write a clear PR title and description summarizing the changes.",
    "Use /commit to create any needed commits, then create the PR.",
    "After the PR exists, report its URL if the conductor-telegram MCP tools are available.",
  ].join("\n");
}

async function handlePostDoneCallback(ctx: Context): Promise<void> {
  const match = (ctx as any).match;
  const action = match?.[1] as "review" | "pr";
  const workspaceId = match?.[2];
  if (!action || !workspaceId) return;

  const workspace = getWorkspace(workspaceId);
  if (!workspace?.conductorWorkspaceName) {
    await ctx.answerCbQuery("Workspace not found");
    return;
  }
  const conductorName = workspace.conductorWorkspaceName;
  const actionLabel = action === "review" ? "Review" : "PR generation";
  const topicNeedsResume = workspaceTopicNeedsResume(workspace);

  await ctx.answerCbQuery(`Starting ${actionLabel}...`);
  await ctx.editMessageReplyMarkup(undefined);

  await reopenWorkspaceTopicBeforeActivity(ctx, workspace, topicNeedsResume);

  const prompt = action === "review"
    ? buildReviewPrompt("")
    : buildPrPrompt();

  const trackedWorkspace = ensureTrackedWorkspace(ctx, {
    conductorName,
    trackedWorkspace: workspace,
    repoPath: workspace.repoPath,
    repoName: workspace.repoPath ? path.basename(workspace.repoPath) : null,
    targetBranch: null,
    sessionId: null,
  }, prompt);

  if (!trackedWorkspace) {
    await ctx.reply(`Could not resolve workspace details for <b>${escHtml(conductorName)}</b>.`, {
      parse_mode: "HTML",
    });
    return;
  }

  const threadOpts = workspace.telegramThreadId
    ? { message_thread_id: workspace.telegramThreadId }
    : {};

  const progress = await ctx.reply(
    `Starting ${actionLabel.toLowerCase()} for <b>${escHtml(conductorName)}</b> using secondary review model...`,
    { parse_mode: "HTML", ...threadOpts }
  );
  updateWorkspaceTelegramMessage(trackedWorkspace.id, progress.message_id.toString());

  const result = await launchWorkspaceSession(conductorName, prompt, {
    launchMode: action === "review" ? "review" : "prompt",
    title: action === "review" ? "Review Changes" : "Generate PR",
    repoPath: workspace.repoPath,
    binding: trackedWorkspace,
  });

  if ("error" in result) {
    updateWorkspaceStatusUnlessTerminal(trackedWorkspace.id, "failed");
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progress.message_id,
      undefined,
      `Failed to start ${actionLabel.toLowerCase()} for <b>${escHtml(conductorName)}</b>:\n${escHtml(result.error)}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const durableWorkspace = commitSessionLaunchResult(
    trackedWorkspace,
    conductorName,
    result
  );
  if (!durableWorkspace) {
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progress.message_id,
      undefined,
      `⏹ The Cloud ${actionLabel.toLowerCase()} thread was stopped or rebound before success could be reported for <b>${escHtml(conductorName)}</b>.`,
      { parse_mode: "HTML", ...threadOpts }
    );
    return;
  }

  await restoreWorkspaceTopicAfterActivity(
    ctx,
    durableWorkspace,
    topicNeedsResume
  );

  await ctx.telegram.editMessageText(
    ctx.chat!.id,
    progress.message_id,
    undefined,
    `🟢 ${actionLabel} running for <b>${escHtml(conductorName)}</b> via <b>${escHtml(result.agentType)}</b> (<code>${escHtml(result.model)}</code>)`,
    { parse_mode: "HTML" }
  );

  observeAgentCompletion(ctx, durableWorkspace, conductorName, result.done);

  if (action === "pr") {
    await sendPrStatusCard(ctx, durableWorkspace);
  }
}

function getReplyTargetWorkspace(
  ctx: Context,
  chatId: string
): { workspace: Workspace; sessionId: string | null } | undefined {
  const reply = (ctx.message as any)?.reply_to_message;
  const replyToMessageId = reply?.message_id;
  if (!replyToMessageId) return undefined;

  const linked = getWorkspaceMessageTarget(chatId, String(replyToMessageId));
  if (linked) {
    console.log(
      `[reply-route] linked message ${replyToMessageId} -> ${linked.workspace.conductorWorkspaceName ?? linked.workspace.name}${linked.sessionId ? ` (${linked.sessionId})` : ""}`
    );
    return linked;
  }

  const inferred = inferWorkspaceFromReply(reply, chatId);
  if (inferred) {
    console.log(
      `[reply-route] inferred from replied text ${replyToMessageId} -> ${inferred.conductorWorkspaceName ?? inferred.name}`
    );
  } else {
    console.log(`[reply-route] no match for replied message ${replyToMessageId}`);
  }
  return inferred ? { workspace: inferred, sessionId: null } : undefined;
}

function inferWorkspaceFromReply(reply: any, chatId: string): Workspace | undefined {
  const text = [reply?.text, reply?.caption]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  if (!text) return undefined;

  const firstLine = text
    .split("\n")
    .map((line: string) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;

  const workspaceName = firstLine.replace(/^[^\p{L}\p{N}]*/u, "").trim();
  if (!workspaceName) return undefined;

  return getWorkspaceByName(workspaceName, { chatId });
}

export async function sendMessageToWorkspace(
  ctx: Context,
  workspace: Workspace,
  message: string,
  attachmentSourcePaths: string[] = [],
  options: { sessionId?: string | null } = {}
): Promise<void> {
  const conductorName = workspace.conductorWorkspaceName ?? workspace.name;
  const messagePreview = previewOutgoingText(message, attachmentSourcePaths);
  const topicNeedsResume = workspaceTopicNeedsResume(workspace);

  await reopenWorkspaceTopicBeforeActivity(ctx, workspace, topicNeedsResume);

  await ctx.reply(`Sending message to <b>${escHtml(conductorName)}</b>...\n\n<i>${escHtml(truncate(messagePreview, 200))}</i>`, {
    parse_mode: "HTML",
  });

  const result = await sendToSession(conductorName, message, attachmentSourcePaths, {
    repoPath: workspace.repoPath,
    sessionId: options.sessionId ?? null,
    binding: workspace,
  });

  if ("error" in result) {
    await ctx.reply(`Failed: ${escHtml(result.error)}`, { parse_mode: "HTML" });
    return;
  }

  if (workspace.conductorBackendKind === "cloud-api") {
    workspace = getWorkspace(workspace.id) ?? workspace;
  } else {
    updateWorkspaceStatus(workspace.id, "running");
    workspace.status = "running";
  }
  await restoreWorkspaceTopicAfterActivity(
    ctx,
    workspace,
    topicNeedsResume
  );
  if (workspace.telegramThreadId && !topicNeedsResume) {
    syncWorkspaceTopic(ctx.telegram, workspace).catch((err) =>
      console.error(`[forum] topic sync error ${workspace.telegramThreadId}:`, err)
    );
  }

  await ctx.reply(
    `📨 Message sent to <b>${escHtml(conductorName)}</b>:\n<i>${escHtml(truncate(messagePreview, 200))}</i>`,
    { parse_mode: "HTML" }
  );

  if (result.warning) {
    await ctx.reply(result.warning);
  }

  const cloudRecovery =
    attachmentSourcePaths.length === 0 &&
    workspace.conductorBackendKind !== "cloud-api"
      ? {
          prompt: await buildCloudRecoveryPromptFromLocalSession(
            workspace,
            message,
            options.sessionId ?? workspace.conductorSessionId
          ),
          repoName: path.basename(workspace.repoPath),
          repoPath: workspace.repoPath,
          workspaceDir:
            getWorkspaceDir(conductorName, workspace.repoPath) ?? undefined,
        }
      : undefined;

  void observeAgentCompletion(
    ctx,
    workspace,
    conductorName,
    result.done,
    cloudRecovery ? { cloudRecovery } : undefined
  );
}

export interface LocalCloudRecoveryRequest {
  prompt: string;
  repoName: string;
  repoPath: string;
  /** Tests and callers that already know the worktree can avoid a DB lookup. */
  workspaceDir?: string;
}

export interface LocalCloudRecoveryOutcome {
  handled: boolean;
  recovered: boolean;
  reason: string | null;
}

interface AgentCompletionOptions {
  cloudRecovery?: LocalCloudRecoveryRequest;
}

interface CloudRecoveryPrompt {
  requestId: string;
  prompt: string;
}

interface CloudTakeoverInFlight {
  requests: CloudRecoveryPrompt[];
  includedRequestIds: Set<string>;
  durablyQueuedRequestIds: Set<string>;
  persisted: Promise<PendingCloudLaunch | null>;
  settlePersistence: (pending: PendingCloudLaunch | null) => void;
  promise: Promise<LocalCloudRecoveryOutcome>;
}

const cloudTakeoversInFlight = new Map<string, CloudTakeoverInFlight>();

/** @internal exported for auth-failure regression tests. */
export function isLocalAgentAuthenticationFailure(
  result: AgentResult
): boolean {
  return result.isError && isKnownCliAuthenticationFailure(result);
}

async function publishTrackedWorkspaceStatus(
  ctx: Context,
  workspace: Workspace,
  progress: { message_id: number } | null,
  html: string,
  includeStopButton: boolean
): Promise<boolean> {
  const threadOpts = workspace.telegramThreadId
    ? { message_thread_id: workspace.telegramThreadId }
    : {};
  const keyboardOpts = includeStopButton
    ? styledKeyboard([[btn("Stop", `stop:${workspace.id}`)]])
    : {};

  if (progress) {
    const edited = await ctx.telegram
      .editMessageText(
        workspace.telegramChatId,
        progress.message_id,
        undefined,
        html,
        { parse_mode: "HTML", ...keyboardOpts }
      )
      .then(() => true)
      .catch((error: unknown) => {
        console.error("[workspace-status] Could not edit status:", error);
        return false;
      });
    if (edited) {
      updateWorkspaceTelegramMessage(workspace.id, String(progress.message_id));
      return true;
    }
  }

  const replacement = await ctx.telegram
    .sendMessage(workspace.telegramChatId, html, {
      parse_mode: "HTML",
      ...threadOpts,
      ...keyboardOpts,
    })
    .catch((error: unknown) => {
      console.error("[workspace-status] Could not post status:", error);
      return null;
    });
  if (replacement) {
    updateWorkspaceTelegramMessage(workspace.id, String(replacement.message_id));
    return true;
  }
  return false;
}

function snapshotCloudNoticeIds(workspaceId: string): ReadonlySet<string> {
  return new Set(
    getPendingCloudNotices(workspaceId).map((notice) => notice.id)
  );
}

function newCloudNoticeIds(
  workspaceId: string,
  previousIds: ReadonlySet<string>,
  kinds: ReadonlySet<string>
): string[] {
  return getPendingCloudNotices(workspaceId)
    .filter(
      (notice) => !previousIds.has(notice.id) && kinds.has(notice.kind)
    )
    .map((notice) => notice.id);
}

function acknowledgeCloudNoticeIds(
  workspaceId: string,
  noticeIds: readonly string[]
): void {
  for (const noticeId of noticeIds) {
    acknowledgePendingCloudNotice(workspaceId, noticeId);
  }
}

/**
 * Move a failed local prompt to Cloud only when its clean commit is available
 * on the selected origin branch. The public API cannot attest the provisioned
 * checkout SHA, so the handoff includes the expected SHA and requires a HEAD
 * check before side effects.
 *
 * @internal exported for Cloud recovery integration tests.
 */
export async function recoverLocalAgentFailure(
  ctx: Context,
  workspace: Workspace,
  conductorName: string,
  agentResult: AgentResult,
  recovery: LocalCloudRecoveryRequest
): Promise<LocalCloudRecoveryOutcome> {
  if (!isLocalAgentAuthenticationFailure(agentResult)) {
    return { handled: false, recovered: false, reason: null };
  }
  if (agentResult.authenticationFailure !== true) {
    return {
      handled: false,
      recovered: false,
      reason:
        "the local launcher could not confirm that authentication failed before execution began",
    };
  }
  if (
    agentResult.hadMeaningfulActivity !== false ||
    (agentResult.numTurns ?? 0) > 1
  ) {
    return {
      handled: false,
      recovered: false,
      reason:
        "the local agent produced output or tool activity before authentication failed, so replaying the request could duplicate side effects",
    };
  }

  const request: CloudRecoveryPrompt = {
    requestId: randomUUID(),
    prompt: recovery.prompt,
  };
  const inFlight = cloudTakeoversInFlight.get(workspace.id);
  if (inFlight) {
    inFlight.requests.push(request);
    const pending = await inFlight.persisted;
    let durablyQueued = false;
    if (pending && !inFlight.includedRequestIds.has(request.requestId)) {
      try {
        enqueueCloudRecoveryPrompt(workspace.id, pending.sessionId, request);
        inFlight.durablyQueuedRequestIds.add(request.requestId);
        durablyQueued = true;
      } catch (error) {
        console.error("[cloud-takeover] Could not persist late recovery prompt:", error);
      }
    }
    const outcome = await inFlight.promise;
    const includedInFirstPrompt = inFlight.includedRequestIds.has(
      request.requestId
    );
    if (!outcome.recovered || includedInFirstPrompt) {
      if (!outcome.recovered && !includedInFirstPrompt) {
        await publishTrackedWorkspaceStatus(
          ctx,
          getWorkspace(workspace.id) ?? workspace,
          null,
          "⚠️ Another local request arrived during a failed or canceled Cloud takeover and was not replayed. Resend it after the reported cleanup finishes.",
          false
        );
      }
      return outcome;
    }

    const rebound = getWorkspace(workspace.id) ?? workspace;
    return forwardLateRecoveryPromptToCloud(
      ctx,
      rebound,
      request,
      durablyQueued
    );
  }

  const current = getWorkspace(workspace.id) ?? workspace;
  if (current.conductorBackendKind === "cloud-api") {
    return forwardLateRecoveryPromptToCloud(ctx, current, request, false);
  }

  const workspaceDir =
    recovery.workspaceDir ?? getWorkspaceDir(conductorName, recovery.repoPath);
  if (!workspaceDir) {
    return {
      handled: false,
      recovered: false,
      reason: "the local worktree could not be resolved",
    };
  }

  let persistenceSettled = false;
  let resolvePersistence!: (pending: PendingCloudLaunch | null) => void;
  const persisted = new Promise<PendingCloudLaunch | null>((resolve) => {
    resolvePersistence = resolve;
  });
  const takeover = {
    requests: [request],
    includedRequestIds: new Set<string>(),
    durablyQueuedRequestIds: new Set<string>(),
    persisted,
    settlePersistence: (pending: PendingCloudLaunch | null) => {
      if (persistenceSettled) return;
      persistenceSettled = true;
      resolvePersistence(pending);
    },
    promise: null as unknown as Promise<LocalCloudRecoveryOutcome>,
  } satisfies CloudTakeoverInFlight;
  takeover.promise = performLocalCloudRecovery(
    ctx,
    current,
    conductorName,
    recovery,
    workspaceDir,
    takeover
  ).finally(() => takeover.settlePersistence(null));
  cloudTakeoversInFlight.set(workspace.id, takeover);
  try {
    return await takeover.promise;
  } finally {
    if (cloudTakeoversInFlight.get(workspace.id) === takeover) {
      cloudTakeoversInFlight.delete(workspace.id);
    }
  }
}

async function performLocalCloudRecovery(
  ctx: Context,
  current: Workspace,
  conductorName: string,
  recovery: LocalCloudRecoveryRequest,
  workspaceDir: string,
  takeover: CloudTakeoverInFlight
): Promise<LocalCloudRecoveryOutcome> {
  try {
    // Linked worktrees may override origin through extensions.worktreeConfig.
    // Keep branch/SHA verification and Cloud project identity anchored to the
    // exact same worktree so a divergent repository-root origin cannot route
    // the recovered prompt into the wrong Cloud project.
    const branch = await resolveSafeCloudTakeoverBranch(
      workspaceDir,
      workspaceDir
    );
    if (!branch.branch || !branch.commit) {
      return {
        handled: false,
        recovered: false,
        reason: describeCloudTakeoverBranchFailure(branch.reason),
      };
    }

    const backend = await resolveDefaultRepoLaunchBackend(
      {
        repoName: recovery.repoName,
        repoPath: workspaceDir,
      },
      0
    );
    if (backend.kind !== "cloud") {
      return {
        handled: false,
        recovered: false,
        reason: cloudRecoveryUnavailableReason(backend.reason),
      };
    }
    const latestBeforeProvisioning = getWorkspace(current.id);
    if (
      latestBeforeProvisioning?.status === "stopped" ||
      latestBeforeProvisioning?.status === "archived"
    ) {
      return {
        handled: true,
        recovered: false,
        reason: "Cloud takeover was canceled before provisioning",
      };
    }

    const threadOpts = current.telegramThreadId
      ? { message_thread_id: current.telegramThreadId }
      : {};
    const progress = await ctx.telegram
      .sendMessage(
        current.telegramChatId,
        `⚠️ Local agent authentication failed for <b>${escHtml(conductorName)}</b>. Switching to Conductor Cloud from <code>${escHtml(branch.branch)}</code>...`,
        { parse_mode: "HTML", ...threadOpts }
      )
      .catch((error: unknown) => {
        console.error("[cloud-takeover] Could not post progress:", error);
        return null;
      });

    const noticeIdsBeforeLaunch = snapshotCloudNoticeIds(current.id);
    const launched = await launchCloudWorkspace({
      projectId: backend.project.id,
      prompt: recovery.prompt,
      promptProvider: () => {
        const includedRequests = takeover.requests.filter(
          (request) =>
            !takeover.durablyQueuedRequestIds.has(request.requestId)
        );
        takeover.includedRequestIds = new Set(
          includedRequests.map((request) => request.requestId)
        );
        return [
          combineCloudRecoveryPrompts(includedRequests),
          "",
          `Expected remote state: ${branch.branch} at ${branch.commit}. The public Cloud API does not expose checkout SHA, so verify HEAD before any side effect.`,
        ].join("\n");
      },
      branch: branch.branch,
      expectedRemoteCommit: {
        cwd: workspaceDir,
        commit: branch.commit,
      },
      persistBeforePrompt: (pending) => {
        const trackedWorkspaceId = persistProvisionedCloudLaunch(current, pending);
        takeover.settlePersistence(pending);
        return trackedWorkspaceId;
      },
    });
    if ("error" in launched) {
      if (
        launched.reason === "cloud_launch_canceled" ||
        launched.reason === "cloud_launch_cancel_pending"
      ) {
        await publishTrackedWorkspaceStatus(
          ctx,
          current,
          progress,
          launched.reason === "cloud_launch_cancel_pending"
            ? `⏹ Cloud takeover cancellation for <b>${escHtml(conductorName)}</b> is saved and will keep retrying. The pending prompt will not be sent.`
            : `⏹ Cloud takeover for <b>${escHtml(conductorName)}</b> was canceled before its prompt was sent.`,
          false
        );
        // Leave terminal and suppression notices together for the poller's
        // publish-all → close → acknowledge sequence.
        return {
          handled: true,
          recovered: false,
          reason: "Cloud takeover was canceled",
        };
      }
      if (launched.reason === "cloud_launch_cleanup_pending") {
        const pendingHtml =
          `⚠️ Cloud takeover for <b>${escHtml(conductorName)}</b> could not confirm prompt delivery, and cleanup is still pending. The bot will keep retrying cleanup; do not resend this request yet.`;
        await publishTrackedWorkspaceStatus(
          ctx,
          current,
          progress,
          pendingHtml,
          false
        );
        return {
          handled: true,
          recovered: false,
          reason: "Cloud cleanup is still pending",
        };
      }
      clearPendingCloudLaunch(current.id);
      updateWorkspaceStatus(current.id, "failed");
      const failedHtml =
        `🔴 Local authentication failed, and Cloud takeover for <b>${escHtml(conductorName)}</b> also failed:\n` +
        escHtml(launched.error);
      const noticeIds = newCloudNoticeIds(
        current.id,
        noticeIdsBeforeLaunch,
        new Set(["launch_failed"])
      );
      const published = await publishTrackedWorkspaceStatus(
        ctx,
        current,
        progress,
        failedHtml,
        false
      );
      if (published) {
        acknowledgeCloudNoticeIds(current.id, noticeIds);
      }
      return { handled: true, recovered: false, reason: launched.error };
    }

    // launchCloudWorkspace finalized the Cloud binding, cursor, and running
    // state atomically. Re-read it so a concurrent stop is never resurrected
    // by redundant post-launch writes.
    const durable = getWorkspace(current.id);
    if (
      !durable ||
      durable.status === "stopped" ||
      durable.status === "archived" ||
      durable.conductorBackendKind !== "cloud-api" ||
      durable.conductorWorkspaceId !== launched.workspaceId ||
      durable.conductorSessionId !== launched.sessionId
    ) {
      await publishTrackedWorkspaceStatus(
        ctx,
        durable ?? current,
        progress,
        `⏹ Cloud takeover for <b>${escHtml(conductorName)}</b> was stopped or rebound before success could be reported.`,
        false
      );
      return {
        handled: true,
        recovered: false,
        reason: "Cloud takeover was stopped during finalization",
      };
    }
    Object.assign(current, durable);
    if (current.telegramThreadId) {
      await syncWorkspaceTopic(ctx.telegram, current).catch((error: unknown) =>
        console.error(
          `[forum] topic sync error ${current.telegramThreadId}:`,
          error
        )
      );
    }

    const successHtml =
      `🟢 ☁️ <b>${escHtml(launched.workspaceName)}</b> took over after local authentication failed.\n` +
      `Expected remote state: <code>${escHtml(branch.branch)} @ ${escHtml(branch.commit.slice(0, 12))}</code> (verify HEAD before side effects)\n\n` +
      formatConductorDeepLink(launched.deepLink);
    const noticeIds = newCloudNoticeIds(
      current.id,
      noticeIdsBeforeLaunch,
      new Set(["launch_queued"])
    );
    const published = await publishTrackedWorkspaceStatus(
      ctx,
      current,
      progress,
      successHtml,
      true
    );
    if (published) {
      acknowledgeCloudNoticeIds(current.id, noticeIds);
    }
    return { handled: true, recovered: true, reason: null };
  } catch (error) {
    console.error("[cloud-takeover] Unexpected recovery failure:", error);
    return {
      handled: false,
      recovered: false,
      reason: "an unexpected Cloud recovery error occurred",
    };
  }
}

function combineCloudRecoveryPrompts(requests: CloudRecoveryPrompt[]): string {
  const prompts = requests
    .map((request) => request.prompt.trim())
    .filter(Boolean);
  if (prompts.length <= 1) return prompts[0] ?? "";

  return [
    prompts[0],
    "",
    "Additional Telegram requests that also failed locally during takeover:",
    ...prompts.slice(1).map((prompt, index) =>
      [`Request ${index + 2}:`, prompt].join("\n")
    ),
  ].join("\n\n");
}

function enqueueCloudRecoveryPrompt(
  trackedWorkspaceId: string,
  sessionId: string,
  request: CloudRecoveryPrompt
): void {
  enqueuePendingCloudMessage(trackedWorkspaceId, {
    requestId: request.requestId,
    sessionId,
    messageId: randomUUID(),
    prompt: request.prompt,
    createdAt: new Date().toISOString(),
  });
}

async function forwardLateRecoveryPromptToCloud(
  ctx: Context,
  workspace: Workspace,
  request: CloudRecoveryPrompt,
  alreadyQueued: boolean
): Promise<LocalCloudRecoveryOutcome> {
  const conductorName = workspace.conductorWorkspaceName;
  const sessionId = workspace.conductorSessionId;
  if (!conductorName || !sessionId) {
    return {
      handled: true,
      recovered: false,
      reason: "the Cloud workspace binding is incomplete",
    };
  }

  try {
    if (!alreadyQueued) {
      enqueueCloudRecoveryPrompt(workspace.id, sessionId, request);
    }
  } catch (error) {
    const reason = `the recovery outbox could not be persisted: ${(error as Error).message}`;
    await publishTrackedWorkspaceStatus(
      ctx,
      workspace,
      null,
      `⚠️ ☁️ <b>${escHtml(conductorName)}</b> took over, but another local request could not be saved safely. Please resend it.`,
      true
    );
    return { handled: true, recovered: false, reason };
  }

  const noticeIdsBeforeDelivery = snapshotCloudNoticeIds(workspace.id);
  const delivery = await reconcilePendingCloudMessages(workspace.id, workspace);
  if (delivery.status === "sent" || delivery.status === "none") {
    const durable = getWorkspace(workspace.id);
    const exactOutcome = getPendingCloudMessageOutcome(
      workspace.id,
      request.requestId
    );
    if (
      exactOutcome?.outcome !== "delivered" ||
      !durable ||
      durable.status === "stopped" ||
      durable.status === "archived" ||
      durable.status === "failed"
    ) {
      const failedNoticeIds = newCloudNoticeIds(
        workspace.id,
        noticeIdsBeforeDelivery,
        new Set(["messages_suppressed", "messages_failed"])
      );
      const published = await publishTrackedWorkspaceStatus(
        ctx,
        durable ?? workspace,
        null,
        exactOutcome?.outcome === "suppressed"
          ? `⏹ ☁️ The recovered request for <b>${escHtml(conductorName)}</b> was suppressed because the workspace was stopped or archived before delivery completed.`
          : `⚠️ ☁️ The recovered request for <b>${escHtml(conductorName)}</b> was not durably confirmed as delivered. Please resend only after checking the Cloud workspace.`,
        false
      );
      if (published) {
        acknowledgeCloudNoticeIds(workspace.id, failedNoticeIds);
      }
      return {
        handled: true,
        recovered: false,
        reason:
          exactOutcome?.error ??
          "the Cloud request was not durably acknowledged as delivered",
      };
    }
    const deliveredNoticeIds = newCloudNoticeIds(
      workspace.id,
      noticeIdsBeforeDelivery,
      new Set(["messages_sent"])
    );
    const published = await publishTrackedWorkspaceStatus(
      ctx,
      durable,
      null,
      `🟢 ☁️ The local authentication failure happened after Cloud had already taken over. The pending request was queued in <b>${escHtml(conductorName)}</b>.`,
      true
    );
    if (published) {
      acknowledgeCloudNoticeIds(workspace.id, deliveredNoticeIds);
    }
    return { handled: true, recovered: true, reason: null };
  }

  if (delivery.status === "pending") {
    const exactOutcome = getPendingCloudMessageOutcome(
      workspace.id,
      request.requestId
    );
    const stillPending = getPendingCloudMessages(workspace.id).some(
      (pending) => pending.requestId === request.requestId
    );
    if (exactOutcome?.outcome === "delivered") {
      const noticeIds = newCloudNoticeIds(
        workspace.id,
        noticeIdsBeforeDelivery,
        new Set(["messages_sent"])
      );
      const published = await publishTrackedWorkspaceStatus(
        ctx,
        getWorkspace(workspace.id) ?? workspace,
        null,
        `🟢 ☁️ The pending request was queued in <b>${escHtml(conductorName)}</b>.`,
        true
      );
      if (published) acknowledgeCloudNoticeIds(workspace.id, noticeIds);
      return { handled: true, recovered: true, reason: null };
    }
    if (exactOutcome?.outcome === "suppressed" ||
        exactOutcome?.outcome === "failed" ||
        !stillPending) {
      const noticeIds = newCloudNoticeIds(
        workspace.id,
        noticeIdsBeforeDelivery,
        new Set(["messages_suppressed", "messages_failed"])
      );
      const published = await publishTrackedWorkspaceStatus(
        ctx,
        getWorkspace(workspace.id) ?? workspace,
        null,
        exactOutcome?.outcome === "suppressed"
          ? `⏹ ☁️ The recovered request for <b>${escHtml(conductorName)}</b> was suppressed before delivery.`
          : `⚠️ ☁️ The recovered request for <b>${escHtml(conductorName)}</b> is no longer queued and was not confirmed delivered. Please inspect Cloud before resending.`,
        false
      );
      if (published) acknowledgeCloudNoticeIds(workspace.id, noticeIds);
      return {
        handled: true,
        recovered: false,
        reason:
          exactOutcome?.error ??
          "the Cloud request is no longer queued and was not confirmed delivered",
      };
    }
    await publishTrackedWorkspaceStatus(
      ctx,
      workspace,
      null,
      `🟡 ☁️ The pending request is saved durably for <b>${escHtml(conductorName)}</b> and will be delivered with the same message identity when the API is available.`,
      true
    );
    return { handled: true, recovered: true, reason: "delivery is pending" };
  }

  if (delivery.status === "suppressed") {
    const reason = `the request was not delivered because ${delivery.error}`;
    const noticeIds = newCloudNoticeIds(
      workspace.id,
      noticeIdsBeforeDelivery,
      new Set(["messages_suppressed"])
    );
    const published = await publishTrackedWorkspaceStatus(
      ctx,
      workspace,
      null,
      `⏹ ☁️ The recovered request for <b>${escHtml(conductorName)}</b> was suppressed because the workspace was stopped or became unavailable. Resend only after intentionally reopening it.`,
      false
    );
    if (published) {
      acknowledgeCloudNoticeIds(workspace.id, noticeIds);
    }
    return { handled: true, recovered: false, reason };
  }

  const reason = delivery.error;
  const noticeIds = newCloudNoticeIds(
    workspace.id,
    noticeIdsBeforeDelivery,
    new Set(["messages_failed"])
  );
  const published = await publishTrackedWorkspaceStatus(
    ctx,
    workspace,
    null,
    `⚠️ ☁️ <b>${escHtml(conductorName)}</b> took over, but another local request could not be replayed because ${escHtml(reason)}. Please resend that request after the current Cloud run finishes.`,
    true
  );
  if (published) {
    acknowledgeCloudNoticeIds(workspace.id, noticeIds);
  }
  return { handled: true, recovered: false, reason };
}

function describeCloudTakeoverBranchFailure(
  reason: Awaited<ReturnType<typeof resolveSafeCloudTakeoverBranch>>["reason"]
): string {
  switch (reason) {
    case "workspace_has_uncommitted_changes":
      return "the local worktree has changes that are not available in Cloud";
    case "commit_not_available_on_remote":
      return "the checked-out commit has not been pushed to origin";
    default:
      return "the local repository state could not be verified safely";
  }
}

/**
 * Watch a spawned agent run and surface hard failures in Telegram. Local
 * authentication failures first attempt a commit-gated Cloud takeover when
 * the caller supplied an eligible recovery plan.
 */
export async function observeAgentCompletion(
  ctx: Context,
  workspace: Workspace,
  conductorName: string,
  done: Promise<AgentResult>,
  options: AgentCompletionOptions = {}
): Promise<void> {
  try {
    const agentResult = await done;
    if (!agentResult.isError) return;

    let recovery: LocalCloudRecoveryOutcome | null = null;
    if (options.cloudRecovery) {
      recovery = await recoverLocalAgentFailure(
        ctx,
        workspace,
        conductorName,
        agentResult,
        options.cloudRecovery
      );
      if (recovery.handled) return;
    }

    updateWorkspaceStatus(workspace.id, "failed");
    if (workspace.telegramThreadId) {
      await syncWorkspaceTopic(ctx.telegram, {
        ...workspace,
        status: "failed",
      }).catch((err) =>
        console.error(`[forum] topic sync error ${workspace.telegramThreadId}:`, err)
      );
    }

    const exitNote =
      typeof agentResult.exitCode === "number"
        ? ` (exit ${agentResult.exitCode})`
        : "";
    let text = `🔴 <b>${escHtml(conductorName)}</b> agent run failed${exitNote}.`;
    const detail =
      agentResult.stderrTail?.trim() || agentResult.resultText?.trim();
    if (detail) {
      text += `\n<pre>${escHtml(truncate(detail, 600))}</pre>`;
    }
    if (isLocalAgentAuthenticationFailure(agentResult)) {
      const reason = recovery?.reason
        ? ` Automatic Cloud takeover was skipped because ${recovery.reason}.`
        : " Automatic Cloud takeover was not eligible for this run.";
      text += `\n\n☁️${escHtml(reason)}`;
    }
    if (workspace.telegramThreadId) {
      await ctx.telegram.sendMessage(workspace.telegramChatId, text, {
        parse_mode: "HTML",
        message_thread_id: workspace.telegramThreadId,
      });
    } else {
      await ctx.reply(text, { parse_mode: "HTML" });
    }
  } catch (err) {
    console.error("[send] agent completion watch error:", err);
  }
}

// ── Helpers ─────────────────────────────────────────────────

/** @internal exported for Cloud handoff prompt tests. */
export function buildCloudRecoveryPrompt(
  originalPrompt: string,
  latestPrompt: string,
  localConversation = ""
): string {
  const original = originalPrompt.trim();
  const latest = latestPrompt.trim();
  const conversation = localConversation.trim();
  if ((!original || original === latest) && !conversation) return latest;

  const sections = [
    "Continue this workspace in Conductor Cloud after the local agent lost authentication.",
    "The requested pushed branch was used for provisioning. Verify HEAD against the expected SHA in the handoff before acting.",
  ];
  if (original) {
    sections.push("", "Original workspace task:", original);
  }
  if (conversation) {
    sections.push(
      "",
      "Relevant local conversation before the failed request:",
      conversation
    );
  }
  if (latest) {
    sections.push("", "Latest request that did not complete:", latest);
  }
  return sections.join("\n");
}

async function buildCloudRecoveryPromptFromLocalSession(
  workspace: Workspace,
  latestPrompt: string,
  sessionId: string | null
): Promise<string> {
  if (!sessionId) {
    return buildCloudRecoveryPrompt(workspace.prompt, latestPrompt);
  }
  const messages = getLocalSessionMessagesTail(sessionId, 50);
  return buildCloudRecoveryPrompt(
    workspace.prompt,
    latestPrompt,
    formatRecoveryConversation(messages, workspace.prompt, latestPrompt)
  );
}

/** @internal exported for recovery-tail budget tests. */
export function formatRecoveryConversation(
  messages: Awaited<ReturnType<typeof getSessionMessagesAfter>>,
  originalPrompt: string,
  latestPrompt: string
): string {
  const entries: string[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = recoveryMessageText(message.content, message.role).trim();
    if (!content) {
      continue;
    }
    entries.push(
      `${message.role === "user" ? "User" : "Assistant"}: ${content.slice(0, 1_500)}`
    );
  }

  const selected = entries.slice(-12);
  let remaining = 9_000;
  const newestFirst: string[] = [];
  for (const entry of [...selected].reverse()) {
    if (remaining <= 0) break;
    const value = entry.slice(0, remaining);
    newestFirst.push(value);
    remaining -= value.length;
  }
  return newestFirst.reverse().join("\n\n");
}

function recoveryMessageText(content: string, role: string): string {
  if (role === "user") return content;
  try {
    const parsed = JSON.parse(content);
    if (parsed?.type === "result" && typeof parsed.result === "string") {
      return parsed.result;
    }
    const messageContent = parsed?.message?.content;
    if (typeof messageContent === "string") return messageContent;
    if (Array.isArray(messageContent)) {
      return messageContent
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text.trim())
        .filter(Boolean)
        .join("\n\n");
    }
    return "";
  } catch {
    return content;
  }
}

function previewOutgoingText(prompt: string, attachmentSourcePaths: string[]): string {
  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt) {
    return trimmedPrompt;
  }

  if (attachmentSourcePaths.length === 0) {
    return "(empty message)";
  }

  if (attachmentSourcePaths.length === 1) {
    return `[Attached: ${path.basename(attachmentSourcePaths[0])}]`;
  }

  return `[${attachmentSourcePaths.length} attached files]`;
}

function stageDecisionAttachment(decision: Decision, sourcePath: string): string {
  const workspace = getWorkspace(decision.workspaceId);
  if (!workspace?.conductorWorkspaceName) {
    return sourcePath;
  }

  const workspaceDir = getWorkspaceDir(
    workspace.conductorWorkspaceName,
    workspace.repoPath
  );
  if (!workspaceDir) {
    return sourcePath;
  }

  try {
    const [stagedPath] = stageAttachmentPaths(workspaceDir, [sourcePath]);
    return stagedPath ?? sourcePath;
  } catch (err) {
    console.error("[attachments] Failed to stage decision attachment:", err);
    return sourcePath;
  }
}
