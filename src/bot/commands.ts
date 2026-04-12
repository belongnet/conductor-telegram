import type { Context, Telegraf } from "telegraf";
import {
  answerPendingStdinDecision,
  getWorkspaceSessionInfo,
  launchWorkspace,
  launchWorkspaceSession,
  sendToSession,
  stageAttachmentPaths,
  stopAgent,
} from "./launcher.js";
import {
  archiveWorkspace,
  createWorkspace,
  getActiveWorkspaces,
  getAllWorkspaces,
  getWorkspace,
  getWorkspaceByName,
  getWorkspaceByThreadId,
  getDecision,
  updateWorkspaceStatus,
  updateWorkspaceTelegramMessage,
  updateWorkspaceConductorName,
  updateWorkspaceThreadId,
  answerDecision,
  updateWorkspaceConductorSession,
  updateWorkspaceForwardCursor,
  getWorkspaceByTelegramMessage,
} from "../store/queries.js";
import {
  createWorkspaceTopic,
  closeWorkspaceTopic,
  deleteWorkspaceTopic,
  reopenWorkspaceTopic,
  syncWorkspaceTopic,
} from "./forum.js";
import type { Decision, Workspace } from "../types/index.js";
import { btn, escHtml, statusIcon, styledButtons, styledKeyboard, truncate } from "./format.js";
import { routeVoiceMessage, routeTextMessage, transcribeVoiceMessage } from "./ai-router.js";
import { saveConfig, tryLoadConfig, type Config } from "../cli/config.js";
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import https from "node:https";

// Map Telegram message IDs to decision IDs (for reply-based answering)
const messageToDecision = new Map<number, number>();

// Track repo-selection confirmation messages so replies create a workspace directly
const messageToRepoSelection = new Map<string, string>(); // chatId:messageId → repoName

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
  const fileExt = ext || path.extname(file.file_path ?? "") || ".bin";
  const localName = `${Date.now()}-${fileId.slice(-8)}${fileExt}`;

  mkdirSync(TELEGRAM_DOWNLOADS_DIR, { recursive: true });
  const localPath = path.join(TELEGRAM_DOWNLOADS_DIR, localName);

  const data = await fetchBuffer(url);
  writeFileSync(localPath, data);
  return localPath;
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

const CONDUCTOR_WORKSPACES_DIR =
  process.env.CONDUCTOR_WORKSPACES_DIR ??
  `${process.env.HOME}/conductor/workspaces`;

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
}

interface SkillRoute {
  description: string;
  skill: string;
}

export interface TelegramCommandDefinition {
  command: string;
  description: string;
}

const TELEGRAM_COMMANDS: TelegramCommandDefinition[] = [
  { command: "setup", description: "Check setup and apply this chat" },
  { command: "run", description: "Start a new workspace run" },
  { command: "review", description: "Start a review session for a workspace" },
  { command: "send", description: "Send a follow-up to a workspace" },
  { command: "skills", description: "List workspace skill routes" },
  { command: "skill", description: "Invoke a workspace skill by name" },
  { command: "gstack", description: "Ask the agent to use the GStack workflow" },
  { command: "workspaces", description: "List tracked workspaces" },
  { command: "status", description: "Show active workspace status" },
  { command: "stop", description: "Stop a running workspace" },
  { command: "repos", description: "List available repos" },
  { command: "help", description: "Show bot help" },
];

export function getTelegramCommands(): TelegramCommandDefinition[] {
  return TELEGRAM_COMMANDS;
}

function findTrackedWorkspace(identifier: string): Workspace | undefined {
  let workspace = getWorkspace(identifier);
  if (workspace) {
    return workspace;
  }

  const all = getAllWorkspaces(100);
  return all.find((ws) => ws.conductorWorkspaceName === identifier);
}

function resolveWorkspaceTarget(identifier: string): WorkspaceTarget | null {
  const trackedWorkspace = findTrackedWorkspace(identifier) ?? null;
  const conductorName = trackedWorkspace?.conductorWorkspaceName ?? identifier;
  const sessionInfo = getWorkspaceSessionInfo(conductorName);
  if (!sessionInfo) {
    return null;
  }

  return {
    conductorName,
    trackedWorkspace,
    repoPath: sessionInfo.repoPath,
    repoName: sessionInfo.repoName,
    targetBranch: sessionInfo.targetBranch,
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
  const repliedWorkspace = getReplyTargetWorkspace(ctx, chatId);
  if (!repliedWorkspace?.conductorWorkspaceName) {
    return null;
  }
  return resolveWorkspaceTarget(repliedWorkspace.conductorWorkspaceName);
}

function getWorkspaceDirectory(target: WorkspaceTarget): string | null {
  if (!target.repoName) {
    return null;
  }
  return path.join(CONDUCTOR_WORKSPACES_DIR, target.repoName, target.conductorName);
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

function buildGstackPrompt(extraInstructions: string): string {
  const lines = [
    "Use the GStack or Graphite workflow in this workspace.",
    "If `gstack`, `gt`, or the Graphite CLI is available, use it.",
    "If the tooling is missing, explain exactly what is unavailable and stop.",
  ];

  if (extraInstructions.trim()) {
    lines.push("", `Additional instructions:\n${extraInstructions.trim()}`);
  }

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

async function sendPromptToTarget(
  ctx: Context,
  target: WorkspaceTarget,
  prompt: string
): Promise<void> {
  if (target.trackedWorkspace) {
    await sendMessageToWorkspace(ctx, target.trackedWorkspace, prompt);
    return;
  }

  await ctx.reply(`Sending message to <b>${escHtml(target.conductorName)}</b>...\n\n<i>${escHtml(truncate(prompt, 200))}</i>`, {
    parse_mode: "HTML",
  });

  const result = await sendToSession(target.conductorName, prompt);
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
  bot.command("workspaces", handleWorkspaces);
  bot.command("status", handleStatus);
  bot.command("stop", handleStop);
  bot.command("repos", handleRepos);
  bot.command("send", handleSend);
  bot.command("review", handleReview);
  bot.command("skills", handleSkills);
  bot.command("skill", handleSkill);
  bot.command("gstack", handleGstack);
  bot.command("help", handleHelp);

  // Inline button callbacks
  bot.action(/^stop:(.+)$/, handleStopCallback);
  bot.action(/^open:(.+)$/, handleOpenCallback);
  bot.action(/^decide:(\d+):(.+)$/, handleDecisionCallback);
  bot.action(/^run:(\d+)$/, handleRunRepoCallback);
  bot.action(/^setup:apply:(\d+)$/, handleSetupApplyCallback);
  bot.action(/^postdone:(review|pr):(.+)$/, handlePostDoneCallback);
  bot.action(/^archive:(.+)$/, handleArchiveCallback);

  // Media and text handlers
  bot.on("photo", handlePhotoMessage);
  bot.on("voice", handleVoiceMessage);
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
  const repoPath = path.join(CONDUCTOR_REPOS_DIR, repoName);
  const promptPreview = previewOutgoingText(prompt, attachmentSourcePaths);
  const chatId = ctx.chat!.id;
  const chatIdStr = chatId.toString();

  // Create record in our DB
  const workspace = createWorkspace({
    name: `${repoName}-${Date.now()}`,
    prompt,
    repoPath,
    telegramChatId: chatIdStr,
  });

  // Try to create a forum topic for this workspace
  const threadId = await createWorkspaceTopic(
    ctx.telegram,
    chatIdStr,
    repoName,
    workspace.name
  );
  if (threadId) {
    updateWorkspaceThreadId(workspace.id, threadId);
    workspace.telegramThreadId = threadId;
  }

  const threadOpts = threadId ? { message_thread_id: threadId } : {};

  // Send initial message (into the topic if created)
  const msg = await ctx.telegram.sendMessage(
    chatId,
    `Starting workspace for <b>${escHtml(repoName)}</b>...\n\n<i>Prompt: ${escHtml(truncate(promptPreview, 200))}</i>`,
    { parse_mode: "HTML", ...threadOpts }
  );

  updateWorkspaceTelegramMessage(workspace.id, msg.message_id.toString());

  // Launch the workspace and spawn the agent process.
  const result = await launchWorkspace(repoPath, prompt, (output) => {
    console.log(`[${workspace.id}] ${output.slice(0, 200)}`);
  }, attachmentSourcePaths);

  if ("error" in result) {
    updateWorkspaceStatus(workspace.id, "failed");
    await ctx.telegram.editMessageText(
      chatId,
      msg.message_id,
      undefined,
      `Failed to start workspace for <b>${escHtml(repoName)}</b>:\n${escHtml(result.error)}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // Workspace created and agent running
  updateWorkspaceConductorName(workspace.id, result.workspaceName);
  updateWorkspaceConductorSession(workspace.id, result.sessionId);
  updateWorkspaceForwardCursor(workspace.id, result.initialCursorRowid);
  updateWorkspaceStatus(workspace.id, "running");
  workspace.conductorWorkspaceName = result.workspaceName;
  workspace.status = "running";

  if (threadId) {
    try {
      await syncWorkspaceTopic(ctx.telegram, workspace);
    } catch (err) {
      console.error(`[forum] could not rename topic ${threadId}:`, err);
    }
  }

  await ctx.telegram.editMessageText(
    chatId,
    msg.message_id,
    undefined,
    `🟢 <b>${escHtml(result.workspaceName)}</b> running for <b>${escHtml(repoName)}</b>\n\n<i>${escHtml(truncate(promptPreview, 200))}</i>`,
    {
      parse_mode: "HTML",
      ...styledKeyboard([
        [btn("Stop", `stop:${workspace.id}`, "danger")],
      ]),
    }
  );
}

// ── /workspaces ─────────────────────────────────────────────

async function handleWorkspaces(ctx: Context): Promise<void> {
  const workspaces = getAllWorkspaces(20);

  if (workspaces.length === 0) {
    await ctx.reply("No workspaces tracked yet. Use /run to start one.");
    return;
  }

  const lines = workspaces.map((ws) => {
    const icon = statusIcon(ws.status);
    const name = ws.conductorWorkspaceName ?? ws.name;
    return `${icon} <b>${escHtml(name)}</b> — ${ws.status}\n   <i>${escHtml(truncate(ws.prompt, 60))}</i>`;
  });

  const stopRows = workspaces
    .filter((ws) => ws.status === "running" || ws.status === "starting")
    .map((ws) => [
      btn(
        `Stop ${ws.conductorWorkspaceName ?? ws.name}`,
        `stop:${ws.id}`,
        "danger"
      ),
    ]);
  const archiveRows = workspaces
    .filter((ws) => ws.status === "done" || ws.status === "failed" || ws.status === "stopped")
    .map((ws) => [
      btn(
        `Archive ${ws.conductorWorkspaceName ?? ws.name}`,
        `archive:${ws.id}`,
        "secondary"
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

// ── /status ─────────────────────────────────────────────────

async function handleStatus(ctx: Context): Promise<void> {
  const active = getActiveWorkspaces();

  if (active.length === 0) {
    await ctx.reply("No active workspaces. All quiet.");
    return;
  }

  const summary = active
    .map((ws) => {
      const name = ws.conductorWorkspaceName ?? ws.name;
      return `${statusIcon(ws.status)} <b>${escHtml(name)}</b>: ${ws.status}`;
    })
    .join("\n");

  await ctx.reply(`<b>Active workspaces (${active.length}):</b>\n\n${summary}`, {
    parse_mode: "HTML",
  });
}

// ── /stop <workspace> ───────────────────────────────────────

async function handleStop(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const idOrName = text.replace(/^\/stop\s*/, "").trim();

  if (!idOrName) {
    await ctx.reply("Usage: /stop <workspace-id or conductor-name>");
    return;
  }

  // Try to find by ID first, then by conductor name
  let workspace = getWorkspace(idOrName);
  if (!workspace) {
    const all = getAllWorkspaces(50);
    workspace = all.find((ws) => ws.conductorWorkspaceName === idOrName);
  }

  if (!workspace) {
    await ctx.reply(`Workspace "${idOrName}" not found.`);
    return;
  }

  const wsName = workspace.conductorWorkspaceName ?? workspace.name;
  const killed = workspace.conductorWorkspaceName
    ? stopAgent(workspace.conductorWorkspaceName)
    : false;

  updateWorkspaceStatus(workspace.id, "stopped");
  if (workspace.telegramThreadId) {
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
  await ctx.reply(
    `⏹ <b>${escHtml(wsName)}</b> stopped.${killed ? "" : "\n<i>Agent process was not running.</i>"}`,
    {
      parse_mode: "HTML",
      ...styledButtons([btn("Archive", `archive:${workspace.id}`, "secondary")]),
    }
  );
}

// ── /repos ──────────────────────────────────────────────────

async function handleRepos(ctx: Context): Promise<void> {
  const repos = getRepoList();

  if (repos.length === 0) {
    await ctx.reply("No repos found in Conductor repos directory.");
    return;
  }

  const lines = repos.map((r, i) => `${i + 1}. <code>${escHtml(r)}</code>`).join("\n");
  const repoButtons = repos.map((r, i) => [
    btn(`${i + 1}. ${r}`, `run:${i + 1}`, "primary"),
  ]);

  await ctx.reply(
    `<b>Available repos:</b>\n\n${lines}\n\nTap a repo or use <code>/run 1 your prompt</code>`,
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

// Last selected repo per user (for two-step /run flow)
const pendingRepoSelection = new Map<string, PendingRepoSelection>();

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
      return caption
        ? `[Image: ${stagedPath}]\n${caption}`
        : `[Image: ${stagedPath}]`;
    })
  ) {
    return;
  }

  const repliedWorkspace = getReplyTargetWorkspace(ctx, chatId);
  if (repliedWorkspace) {
    const message = caption || "The user sent a screenshot/image. Please review it.";
    await sendMessageToWorkspace(ctx, repliedWorkspace, message, [localPath]);
    return;
  }

  // If sent inside a forum topic, route to that workspace automatically
  const threadId = (ctx.message as any)?.message_thread_id;
  if (threadId) {
    const threadWorkspace = getWorkspaceByThreadId(chatId, threadId);
    if (threadWorkspace) {
      const message = caption || "The user sent a screenshot/image. Please review it.";
      await sendMessageToWorkspace(ctx, threadWorkspace, message, [localPath]);
      return;
    }
  }

  await ctx.reply(
    "Got your image. Reply to a question from an agent, or use /send to forward to a workspace."
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
    const args = sendMatch[1].trim();
    const spaceIdx = args.indexOf(" ");
    const wsName = spaceIdx === -1 ? args : args.slice(0, spaceIdx);
    const message = spaceIdx === -1 ? "" : args.slice(spaceIdx + 1).trim();

    let workspace = getWorkspace(wsName);
    if (!workspace) {
      const all = getAllWorkspaces(50);
      workspace = all.find((ws) => ws.conductorWorkspaceName === wsName);
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
  voicePath: string
): Promise<boolean> {
  const repos = getRepoList();
  if (repos.length === 0) return false;

  const activeWorkspaces = getAutoRoutableWorkspaces(chatId);

  try {
    await ctx.reply("🎙 Listening...");
    const result = await routeVoiceMessage(voicePath, repos, activeWorkspaces);
    if (!result) return false;

    return await executeRouteResult(ctx, chatId, result, [voicePath]);
  } catch (err) {
    console.error("[ai-router] voice routing failed:", err);
    return false;
  }
}

async function tryAutoRouteText(
  ctx: Context,
  chatId: string,
  text: string
): Promise<boolean> {
  const repos = getRepoList();
  if (repos.length === 0) return false;

  const activeWorkspaces = getAutoRoutableWorkspaces(chatId);

  try {
    const result = await routeTextMessage(text, repos, activeWorkspaces);
    if (!result) return false;

    return await executeRouteResult(ctx, chatId, result);
  } catch (err) {
    console.error("[ai-router] text routing failed:", err);
    return false;
  }
}

async function executeRouteResult(
  ctx: Context,
  chatId: string,
  result: { action: string; repoName?: string; workspaceId?: string; prompt: string; transcript: string },
  attachments: string[] = []
): Promise<boolean> {
  if (result.action === "existing" && result.workspaceId) {
    const workspace = getWorkspace(result.workspaceId);
    if (
      workspace &&
      workspace.telegramChatId === chatId &&
      workspace.status === "running" &&
      workspace.conductorWorkspaceName
    ) {
      await sendMessageToWorkspace(ctx, workspace, result.prompt, attachments);
      return true;
    }
    // Workspace not found — fall through to create new
  }

  if (result.repoName) {
    const resolved = resolveRepo(result.repoName);
    if (resolved) {
      await startWorkspaceFromMessage(ctx, resolved, result.prompt, attachments);
      return true;
    }
  }

  return false;
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

  if (
    await tryAnswerDecisionReplyWithFormatter(ctx, (decision) => {
      const stagedPath = stageDecisionAttachment(decision, localPath);
      return `[Voice message (${duration}s): ${stagedPath}]`;
    })
  ) {
    return;
  }

  const repliedWorkspace = getReplyTargetWorkspace(ctx, chatId);
  if (repliedWorkspace) {
    const transcript = await transcribeVoiceMessage(localPath);
    if (transcript) {
      await sendMessageToWorkspace(ctx, repliedWorkspace, transcript);
    } else {
      const message = `The user sent a voice message (${duration}s). Please review the attached recording.`;
      await sendMessageToWorkspace(ctx, repliedWorkspace, message, [localPath]);
    }
    return;
  }

  // If sent inside a forum topic, skip — thread tabs already receive
  // pre-transcribed messages from the general tab (transcript only, no file).
  const threadId = (ctx.message as any)?.message_thread_id;
  if (threadId) {
    const threadWorkspace = getWorkspaceByThreadId(chatId, threadId);
    if (threadWorkspace) return;
  }

  // Auto-route: use AI to transcribe and determine the target repo/workspace
  const routed = await tryAutoRouteVoice(ctx, chatId, localPath);
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

  // Check if this is a reply to a repo-selection confirmation message
  const replyToMsgId = (ctx.message as any)?.reply_to_message?.message_id;
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

  const repliedWorkspace = getReplyTargetWorkspace(ctx, chatId);
  if (repliedWorkspace) {
    await sendMessageToWorkspace(ctx, repliedWorkspace, text);
    return;
  }

  // If sent inside a forum topic, route to that workspace automatically
  const threadId = (ctx.message as any)?.message_thread_id;
  if (threadId) {
    const threadWorkspace = getWorkspaceByThreadId(chatId, threadId);
    if (threadWorkspace) {
      await sendMessageToWorkspace(ctx, threadWorkspace, text);
      return;
    }
  }

  if (!selectionKey) {
    // No reply context, no forum thread, no pending selection key —
    // try AI auto-routing for general-thread messages.
    await tryAutoRouteText(ctx, chatId, text);
    return;
  }

  const pendingSelection = pendingRepoSelection.get(selectionKey);
  if (!pendingSelection) {
    // Has a selection key but no pending selection — try AI auto-routing
    await tryAutoRouteText(ctx, chatId, text);
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
  if (!workspace) {
    const all = getAllWorkspaces(50);
    workspace = all.find((ws) => ws.conductorWorkspaceName === wsName);
  }

  const conductorName = workspace?.conductorWorkspaceName ?? wsName;
  if (!workspace) {
    await ctx.reply(`Sending message to <b>${escHtml(conductorName)}</b>...\n\n<i>${escHtml(truncate(message, 200))}</i>`, {
      parse_mode: "HTML",
    });
    const result = await sendToSession(conductorName, message);
    if ("error" in result) {
      await ctx.reply(`Failed: ${escHtml(result.error)}`, { parse_mode: "HTML" });
      return;
    }
    await ctx.reply(
      `📨 Message sent to <b>${escHtml(conductorName)}</b>:\n<i>${escHtml(truncate(message, 200))}</i>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  await sendMessageToWorkspace(ctx, workspace, message);
}

// ── /review <workspace> [instructions] ──────────────────────

async function handleReview(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const args = text.replace(/^\/review\s*/, "").trim();
  const replyTarget = getReplyWorkspaceTarget(ctx);

  let target: WorkspaceTarget | null = null;
  let instructions = "";

  if (!args) {
    target = replyTarget;
  } else {
    const [head, tail] = splitHead(args);
    const explicitTarget = resolveWorkspaceTarget(head);
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

  const progress = await ctx.reply(
    `Starting review for <b>${escHtml(target.conductorName)}</b>...\n\n<i>${escHtml(truncate(reviewPrompt, 200))}</i>`,
    { parse_mode: "HTML" }
  );
  updateWorkspaceTelegramMessage(trackedWorkspace.id, progress.message_id.toString());

  const result = await launchWorkspaceSession(target.conductorName, reviewPrompt, {
    launchMode: "review",
    title: "Review Changes",
    reviewBaseBranch: target.targetBranch,
  });

  if ("error" in result) {
    updateWorkspaceStatus(trackedWorkspace.id, "failed");
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progress.message_id,
      undefined,
      `Failed to start review for <b>${escHtml(target.conductorName)}</b>:\n${escHtml(result.error)}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  updateWorkspaceConductorName(trackedWorkspace.id, target.conductorName);
  updateWorkspaceConductorSession(trackedWorkspace.id, result.sessionId);
  updateWorkspaceForwardCursor(trackedWorkspace.id, result.initialCursorRowid);
  updateWorkspaceStatus(trackedWorkspace.id, "running");

  await ctx.telegram.editMessageText(
    ctx.chat!.id,
    progress.message_id,
    undefined,
    `🟢 Review running for <b>${escHtml(target.conductorName)}</b> via <b>${escHtml(result.agentType)}</b> (<code>${escHtml(result.model)}</code>)`,
    { parse_mode: "HTML" }
  );
}

// ── /skills <workspace> ─────────────────────────────────────

async function handleSkills(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const args = text.replace(/^\/skills\s*/, "").trim();
  const target =
    (args ? resolveWorkspaceTarget(args) : null) ?? getReplyWorkspaceTarget(ctx);

  if (!target) {
    await ctx.reply(
      "Usage: /skills <workspace-name>\n\nYou can also reply to a workspace message with /skills."
    );
    return;
  }

  const routes = getWorkspaceSkillRoutes(target);
  if (routes.length === 0) {
    await ctx.reply(
      `No invoke-style skills were found for <b>${escHtml(target.conductorName)}</b>.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const lines = routes.map(
    (route) => `<code>${escHtml(route.skill)}</code> — ${escHtml(route.description)}`
  );
  lines.push("");
  lines.push(
    `Use <code>/skill ${escHtml(target.conductorName)} ${escHtml(routes[0]!.skill)}</code> to invoke one.`
  );
  lines.push(
    `Use <code>/gstack ${escHtml(target.conductorName)}</code> for the Graphite/GStack workflow.`
  );

  await ctx.reply(
    `<b>Skills for ${escHtml(target.conductorName)}</b>\n\n${lines.join("\n")}`,
    { parse_mode: "HTML" }
  );
}

// ── /skill <workspace> <skill> [instructions] ──────────────

async function handleSkill(ctx: Context): Promise<void> {
  const text = (ctx.message as any)?.text ?? "";
  const args = text.replace(/^\/skill\s*/, "").trim();
  const replyTarget = getReplyWorkspaceTarget(ctx);

  if (!args) {
    await ctx.reply(
      "Usage: /skill <workspace-name> <skill> [instructions]\n\nYou can also reply to a workspace message with /skill <skill>."
    );
    return;
  }

  const [head, tail] = splitHead(args);
  let target = resolveWorkspaceTarget(head);
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
  const replyTarget = getReplyWorkspaceTarget(ctx);

  let target: WorkspaceTarget | null = null;
  let extraInstructions = "";

  if (!args) {
    target = replyTarget;
  } else {
    const [head, tail] = splitHead(args);
    const explicitTarget = resolveWorkspaceTarget(head);
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
      "Usage: /gstack <workspace-name> [instructions]\n\nYou can also reply to a workspace message with /gstack."
    );
    return;
  }

  await sendPromptToTarget(ctx, target, buildGstackPrompt(extraInstructions));
}

// ── /setup, /start ──────────────────────────────────────────

async function handleSetup(ctx: Context): Promise<void> {
  const response = await getSetupDiagnostics(ctx).then(buildSetupResponse);
  const setupUserId = ctx.from?.id;
  await ctx.reply(response.message, {
    parse_mode: "HTML",
    ...(response.showApplyButton && setupUserId
      ? styledButtons([btn("Use This Chat", `setup:apply:${setupUserId}`, "success")])
      : {}),
  });
}

// ── /help ───────────────────────────────────────────────────

async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    `<b>Conductor Telegram Bot</b>

Commands:
/setup — Check setup and apply this chat
/run &lt;repo&gt; &lt;prompt&gt; — Start a new workspace
/run &lt;number&gt; &lt;prompt&gt; — Start using repo number
/send &lt;workspace&gt; &lt;message&gt; — Send follow-up to agent
/review &lt;workspace&gt; [instructions] — Start a review session
/skills &lt;workspace&gt; — List invoke-style skills from the workspace
/skill &lt;workspace&gt; &lt;skill&gt; [instructions] — Ask the agent to invoke a skill
/gstack &lt;workspace&gt; [instructions] — Ask the agent to use the GStack/Graphite workflow
/workspaces — List all tracked workspaces
/status — Show active workspace summary
/stop &lt;name&gt; — Stop a workspace
/repos — List repos (tap to select)
/help — Show this message

Use <code>/setup</code> to check the current chat and let the bot configure it for you.
Tap a repo from /repos, then type your prompt.
Reply to a forwarded workspace message to target that workspace with /send, /review, /skills, /skill, or /gstack.
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

async function handleStopCallback(ctx: Context): Promise<void> {
  const match = (ctx as any).match;
  const workspaceId = match?.[1];
  if (!workspaceId) return;

  const workspace = getWorkspace(workspaceId);
  if (workspace?.conductorWorkspaceName) {
    stopAgent(workspace.conductorWorkspaceName);
  }

  updateWorkspaceStatus(workspaceId, "stopped");
  if (workspace?.telegramThreadId) {
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
      styledButtons([btn("Archive", `archive:${workspaceId}`, "secondary")]).reply_markup
    )
    .catch(() => undefined);
}

async function handleOpenCallback(ctx: Context): Promise<void> {
  await ctx.answerCbQuery("Open workspace in Conductor UI");
}

async function handleArchiveCallback(ctx: Context): Promise<void> {
  const match = (ctx as any).match;
  const workspaceId = match?.[1];
  if (!workspaceId) return;

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    await ctx.answerCbQuery("Workspace not found");
    return;
  }

  archiveWorkspace(workspaceId);

  if (workspace.telegramThreadId) {
    await deleteWorkspaceTopic(
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

// ── Post-done: Review Changes / Generate PR ─────────────────

function buildPrPrompt(): string {
  return [
    "Review all changes in this workspace and create a pull request.",
    "Write a clear PR title and description summarizing the changes.",
    "Use /commit to create any needed commits, then create the PR.",
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

  await ctx.answerCbQuery(`Starting ${actionLabel}...`);
  await ctx.editMessageReplyMarkup(undefined);

  // Reopen forum topic if needed
  if (
    workspace.telegramThreadId &&
    (workspace.status === "done" || workspace.status === "stopped" || workspace.status === "failed")
  ) {
    await reopenWorkspaceTopic(
      ctx.telegram,
      workspace.telegramChatId,
      workspace.telegramThreadId
    );
  }

  const prompt = action === "review"
    ? buildReviewPrompt("")
    : buildPrPrompt();

  const trackedWorkspace = ensureTrackedWorkspace(ctx, {
    conductorName,
    trackedWorkspace: workspace,
    repoPath: workspace.repoPath,
    repoName: workspace.repoPath ? path.basename(workspace.repoPath) : null,
    targetBranch: null,
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
  });

  if ("error" in result) {
    updateWorkspaceStatus(trackedWorkspace.id, "failed");
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      progress.message_id,
      undefined,
      `Failed to start ${actionLabel.toLowerCase()} for <b>${escHtml(conductorName)}</b>:\n${escHtml(result.error)}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  updateWorkspaceConductorName(trackedWorkspace.id, conductorName);
  updateWorkspaceConductorSession(trackedWorkspace.id, result.sessionId);
  updateWorkspaceForwardCursor(trackedWorkspace.id, result.initialCursorRowid);
  updateWorkspaceStatus(trackedWorkspace.id, "running");

  await ctx.telegram.editMessageText(
    ctx.chat!.id,
    progress.message_id,
    undefined,
    `🟢 ${actionLabel} running for <b>${escHtml(conductorName)}</b> via <b>${escHtml(result.agentType)}</b> (<code>${escHtml(result.model)}</code>)`,
    { parse_mode: "HTML" }
  );
}

function getReplyTargetWorkspace(
  ctx: Context,
  chatId: string
): Workspace | undefined {
  const reply = (ctx.message as any)?.reply_to_message;
  const replyToMessageId = reply?.message_id;
  if (!replyToMessageId) return undefined;

  const linked = getWorkspaceByTelegramMessage(chatId, String(replyToMessageId));
  if (linked) {
    console.log(
      `[reply-route] linked message ${replyToMessageId} -> ${linked.conductorWorkspaceName ?? linked.name}`
    );
    return linked;
  }

  const inferred = inferWorkspaceFromReply(reply);
  if (inferred) {
    console.log(
      `[reply-route] inferred from replied text ${replyToMessageId} -> ${inferred.conductorWorkspaceName ?? inferred.name}`
    );
  } else {
    console.log(`[reply-route] no match for replied message ${replyToMessageId}`);
  }
  return inferred;
}

function inferWorkspaceFromReply(reply: any): Workspace | undefined {
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

  return getWorkspaceByName(workspaceName);
}

async function sendMessageToWorkspace(
  ctx: Context,
  workspace: Workspace,
  message: string,
  attachmentSourcePaths: string[] = []
): Promise<void> {
  const conductorName = workspace.conductorWorkspaceName ?? workspace.name;
  const messagePreview = previewOutgoingText(message, attachmentSourcePaths);

  // Reopen forum topic if the workspace was stopped/done/failed
  if (
    workspace.telegramThreadId &&
    (workspace.status === "done" || workspace.status === "stopped" || workspace.status === "failed")
  ) {
    await reopenWorkspaceTopic(
      ctx.telegram,
      workspace.telegramChatId,
      workspace.telegramThreadId
    );
  }

  await ctx.reply(`Sending message to <b>${escHtml(conductorName)}</b>...\n\n<i>${escHtml(truncate(messagePreview, 200))}</i>`, {
    parse_mode: "HTML",
  });

  const result = await sendToSession(conductorName, message, attachmentSourcePaths);

  if ("error" in result) {
    await ctx.reply(`Failed: ${escHtml(result.error)}`, { parse_mode: "HTML" });
    return;
  }

  updateWorkspaceStatus(workspace.id, "running");
  workspace.status = "running";
  if (workspace.telegramThreadId) {
    syncWorkspaceTopic(ctx.telegram, workspace).catch((err) =>
      console.error(`[forum] topic sync error ${workspace.telegramThreadId}:`, err)
    );
  }

  await ctx.reply(
    `📨 Message sent to <b>${escHtml(conductorName)}</b>:\n<i>${escHtml(truncate(messagePreview, 200))}</i>`,
    { parse_mode: "HTML" }
  );
}

// ── Helpers ─────────────────────────────────────────────────

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

  const repoName = path.basename(workspace.repoPath);
  const workspaceDir = path.join(
    CONDUCTOR_WORKSPACES_DIR,
    repoName,
    workspace.conductorWorkspaceName
  );

  try {
    const [stagedPath] = stageAttachmentPaths(workspaceDir, [sourcePath]);
    return stagedPath ?? sourcePath;
  } catch (err) {
    console.error("[attachments] Failed to stage decision attachment:", err);
    return sourcePath;
  }
}
