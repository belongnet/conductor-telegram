import type { Context, Telegraf } from "telegraf";
import { Markup } from "telegraf";
import {
  getWorkspaceSessionInfo,
  launchWorkspace,
  launchWorkspaceSession,
  sendToSession,
  stageAttachmentPaths,
  stopAgent,
} from "./launcher.js";
import {
  createWorkspace,
  getActiveWorkspaces,
  getAllWorkspaces,
  getWorkspace,
  getWorkspaceByName,
  getDecision,
  updateWorkspaceStatus,
  updateWorkspaceTelegramMessage,
  updateWorkspaceConductorName,
  answerDecision,
  updateWorkspaceConductorSession,
  updateWorkspaceForwardCursor,
  getWorkspaceByTelegramMessage,
} from "../store/queries.js";
import type { Decision, Workspace, WorkspaceStatus } from "../types/index.js";
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import https from "node:https";

// Map Telegram message IDs to decision IDs (for reply-based answering)
const messageToDecision = new Map<number, number>();

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

// Map Telegram message IDs to decision IDs (for reply-based answering)
const messageToDecision = new Map<number, number>();

/**
 * Register a Telegram message ID as associated with a decision,
 * so that replies to that message can answer the decision.
 */
export function trackDecisionMessage(messageId: number, decisionId: number): void {
  messageToDecision.set(messageId, decisionId);
}

/**
 * Get a Telegram file URL for downloading.
 */
async function getFileUrl(ctx: Context, fileId: string): Promise<string> {
  const file = await ctx.telegram.getFile(fileId);
  const token = (ctx.telegram as any).token;
  return `https://api.telegram.org/file/bot${token}/` + file.file_path;
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

  // Media and text handlers
  bot.on("photo", handlePhotoMessage);
  bot.on("voice", handleVoiceMessage);
  bot.on("text", handleTextMessage);
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

  // Send initial message
  const msg = await ctx.reply(`Starting workspace for <b>${escHtml(repoName)}</b>...\n\n<i>Prompt: ${escHtml(truncate(promptPreview, 200))}</i>`, {
    parse_mode: "HTML",
  });

  // Create record in our DB
  const workspace = createWorkspace({
    name: `${repoName}-${Date.now()}`,
    prompt,
    repoPath,
    telegramChatId: ctx.chat!.id.toString(),
  });

  updateWorkspaceTelegramMessage(workspace.id, msg.message_id.toString());

  const chatId = ctx.chat!.id;

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

  await ctx.telegram.editMessageText(
    chatId,
    msg.message_id,
    undefined,
    `🟢 Agent <b>${escHtml(result.workspaceName)}</b> running for <b>${escHtml(repoName)}</b>\n\n<i>${escHtml(truncate(promptPreview, 200))}</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        Markup.button.callback("Stop", `stop:${workspace.id}`),
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

  const buttons = workspaces
    .filter((ws) => ws.status === "running" || ws.status === "starting")
    .map((ws) => [
      Markup.button.callback(
        `Stop ${ws.conductorWorkspaceName ?? ws.name}`,
        `stop:${ws.id}`
      ),
    ]);

  await ctx.reply(lines.join("\n\n"), {
    parse_mode: "HTML",
    ...(buttons.length > 0 ? Markup.inlineKeyboard(buttons) : {}),
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
  await ctx.reply(
    `⏹ <b>${escHtml(wsName)}</b> stopped.${killed ? "" : "\n<i>Agent process was not running.</i>"}`,
    { parse_mode: "HTML" }
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
  const buttons = repos.map((r, i) => [
    Markup.button.callback(`${i + 1}. ${r}`, `run:${i + 1}`),
  ]);

  await ctx.reply(
    `<b>Available repos:</b>\n\n${lines}\n\nTap a repo or use <code>/run 1 your prompt</code>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons),
    }
  );
}

// Last selected repo per user (for two-step /run flow)
const pendingRepoSelection = new Map<string, number>();

async function handleRunRepoCallback(ctx: Context): Promise<void> {
  const match = (ctx as any).match;
  const repoNum = parseInt(match?.[1], 10);
  if (Number.isNaN(repoNum)) return;

  const repos = getRepoList();
  const repoName = repos[repoNum - 1];
  if (!repoName) return;

  const chatId = ctx.chat?.id?.toString();
  if (!chatId) return;

  pendingRepoSelection.set(chatId, repoNum);

  await ctx.answerCbQuery(`Selected: ${repoName}`);
  await ctx.reply(
    `Selected <b>${escHtml(repoName)}</b>. Now send your prompt as a message, or use:\n<code>/run ${repoNum} your prompt here</code>`,
    { parse_mode: "HTML" }
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
  messageToDecision.delete(replyTo);
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
  await ctx.reply(`Answered: ${truncate(answerText, 200)}`, {
    reply_parameters: { message_id: (ctx.message as any).message_id },
  });
  return true;
}
// ── Photo handler ────────────────────────────────────────────

async function handlePhotoMessage(ctx: Context): Promise<void> {
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

  // Not a reply to a decision — treat as a standalone message
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
// ── Voice handler ────────────────────────────────────────────

async function handleVoiceMessage(ctx: Context): Promise<void> {
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

  // Not a reply to a decision
  await ctx.reply(
    "Got your voice message. Reply to a question from an agent, or use /send to forward to a workspace."
  );
}

// ── Text handler (two-step run flow + decision replies) ──────

async function handleTextMessage(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  if (!chatId) return;

  const text = (ctx.message as any)?.text?.trim();
  if (!text || text.startsWith("/")) return;

  // Check if this is a reply to a decision question
  if (await tryAnswerDecisionReply(ctx, text)) return;

  const repliedWorkspace = getReplyTargetWorkspace(ctx, chatId);
  if (repliedWorkspace) {
    await sendMessageToWorkspace(ctx, repliedWorkspace, text);
    return;
  }

  const repoNum = pendingRepoSelection.get(chatId);
  if (!repoNum) return; // No pending selection, ignore

  const prompt = text;

  // Clear the pending selection
  pendingRepoSelection.delete(chatId);

  const repos = getRepoList();
  const repoName = repos[repoNum - 1];
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

// ── /help ───────────────────────────────────────────────────

async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    `<b>Conductor Telegram Bot</b>

Commands:
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

Tap a repo from /repos, then type your prompt.
Reply to a forwarded workspace message to target that workspace with /send, /review, /skills, /skill, or /gstack.`,
    { parse_mode: "HTML" }
  );
}

// ── Inline button callbacks ─────────────────────────────────

async function handleStopCallback(ctx: Context): Promise<void> {
  const match = (ctx as any).match;
  const workspaceId = match?.[1];
  if (!workspaceId) return;

  const workspace = getWorkspace(workspaceId);
  if (workspace?.conductorWorkspaceName) {
    stopAgent(workspace.conductorWorkspaceName);
  }

  updateWorkspaceStatus(workspaceId, "stopped");
  await ctx.answerCbQuery("Agent stopped");
  await ctx.editMessageReplyMarkup(undefined);
}

async function handleOpenCallback(ctx: Context): Promise<void> {
  await ctx.answerCbQuery("Open workspace in Conductor UI");
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

  await ctx.answerCbQuery(`Answered: ${answer}`);
  await ctx.editMessageReplyMarkup(undefined);
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

  await ctx.reply(`Sending message to <b>${escHtml(conductorName)}</b>...\n\n<i>${escHtml(truncate(messagePreview, 200))}</i>`, {
    parse_mode: "HTML",
  });

  const result = await sendToSession(conductorName, message, attachmentSourcePaths);

  if ("error" in result) {
    await ctx.reply(`Failed: ${escHtml(result.error)}`, { parse_mode: "HTML" });
    return;
  }

  updateWorkspaceStatus(workspace.id, "running");

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

function statusIcon(status: WorkspaceStatus): string {
  switch (status) {
    case "starting":
      return "🟡";
    case "running":
      return "🟢";
    case "done":
      return "✅";
    case "failed":
      return "🔴";
    case "stopped":
      return "⏹";
  }
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + "..." : s;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
