import type { Context, Telegraf } from "telegraf";
import { Markup } from "telegraf";
import { launchWorkspace, stopAgent, sendToSession, answerPendingStdinDecision, type AgentResult } from "./launcher.js";
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
  getWorkspaceByTelegramMessage,
} from "../store/queries.js";
import type { Workspace, WorkspaceStatus } from "../types/index.js";
import { readdirSync } from "node:fs";
import path from "node:path";

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

let _bot: Telegraf<Context>;

export function registerCommands(bot: Telegraf<Context>): void {
  _bot = bot;
  bot.command("run", handleRun);
  bot.command("workspaces", handleWorkspaces);
  bot.command("status", handleStatus);
  bot.command("stop", handleStop);
  bot.command("repos", handleRepos);
  bot.command("send", handleSend);
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

  const repoPath = path.join(CONDUCTOR_REPOS_DIR, repoName);

  // Send initial message
  const msg = await ctx.reply(`Starting workspace for <b>${escHtml(repoName)}</b>...\n\n<i>Prompt: ${escHtml(prompt)}</i>`, {
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

  // Launch via deeplink + Claude CLI spawn (no sidecar socket)
  const result = await launchWorkspace(repoPath, prompt, (output) => {
    console.log(`[${workspace.id}] ${output.slice(0, 200)}`);
  });

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
  updateWorkspaceStatus(workspace.id, "running");

  await ctx.telegram.editMessageText(
    chatId,
    msg.message_id,
    undefined,
    `🟢 Agent <b>${escHtml(result.workspaceName)}</b> running for <b>${escHtml(repoName)}</b>\n\n<i>${escHtml(prompt)}</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        Markup.button.callback("Stop", `stop:${workspace.id}`),
      ]),
    }
  );

  // Wait for agent completion in background, notify via Telegram
  result.done.then((agentResult) => {
    notifyCompletion(_bot, chatId.toString(), workspace.id, result.workspaceName, agentResult);
  });
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
  answerPendingStdinDecision(decisionId, answerText);
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

  // Check if this is a reply to a decision
  const fileUrl = await getFileUrl(ctx, photo.file_id);
  const answerText = caption
    ? `[Image: ${fileUrl}]\n${caption}`
    : `[Image: ${fileUrl}]`;

  if (await tryAnswerDecisionReply(ctx, answerText)) return;

  // Not a reply to a decision — treat as a standalone message
  await ctx.reply(
    "Got your image. Reply to a question from an agent, or use /send to forward to a workspace."
  );
}

// ── Voice handler ────────────────────────────────────────────

async function handleVoiceMessage(ctx: Context): Promise<void> {
  const msg = ctx.message as any;
  if (!msg?.voice) return;

  const fileUrl = await getFileUrl(ctx, msg.voice.file_id);
  const duration = msg.voice.duration ?? 0;
  const answerText = `[Voice message (${duration}s): ${fileUrl}]`;

  // Check if this is a reply to a decision
  if (await tryAnswerDecisionReply(ctx, answerText)) return;

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

  // Reuse the run logic
  const repoPath = path.join(CONDUCTOR_REPOS_DIR, repoName);

  const msg = await ctx.reply(`Starting workspace for <b>${escHtml(repoName)}</b>...\n\n<i>Prompt: ${escHtml(prompt)}</i>`, {
    parse_mode: "HTML",
  });

  const workspace = createWorkspace({
    name: `${repoName}-${Date.now()}`,
    prompt,
    repoPath,
    telegramChatId: chatId,
  });

  updateWorkspaceTelegramMessage(workspace.id, msg.message_id.toString());

  const result = await launchWorkspace(repoPath, prompt, (output) => {
    console.log(`[${workspace.id}] ${output.slice(0, 200)}`);
  });

  if ("error" in result) {
    updateWorkspaceStatus(workspace.id, "failed");
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      msg.message_id,
      undefined,
      `Failed to start workspace for <b>${escHtml(repoName)}</b>:\n${escHtml(result.error)}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  updateWorkspaceConductorName(workspace.id, result.workspaceName);
  updateWorkspaceConductorSession(workspace.id, result.sessionId);
  updateWorkspaceStatus(workspace.id, "running");

  await ctx.telegram.editMessageText(
    ctx.chat!.id,
    msg.message_id,
    undefined,
    `🟢 Agent <b>${escHtml(result.workspaceName)}</b> running for <b>${escHtml(repoName)}</b>\n\n<i>${escHtml(prompt)}</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        Markup.button.callback("Stop", `stop:${workspace.id}`),
      ]),
    }
  );

  result.done.then((agentResult) => {
    notifyCompletion(_bot, chatId, workspace!.id, result.workspaceName, agentResult);
  });
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
    await ctx.reply(`Sending message to <b>${escHtml(conductorName)}</b>...`, {
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

// ── /help ───────────────────────────────────────────────────

async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    `<b>Conductor Telegram Bot</b>

Commands:
/run &lt;repo&gt; &lt;prompt&gt; — Start a new workspace
/run &lt;number&gt; &lt;prompt&gt; — Start using repo number
/send &lt;workspace&gt; &lt;message&gt; — Send follow-up to agent
/workspaces — List all tracked workspaces
/status — Show active workspace summary
/stop &lt;name&gt; — Stop a workspace
/repos — List repos (tap to select)
/help — Show this message

Tap a repo from /repos, then type your prompt.
Reply to a forwarded workspace message to send a follow-up to that same workspace.`,
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
  answerPendingStdinDecision(decisionId, answer);

  await ctx.answerCbQuery(`Answered: ${answer}`);
  await ctx.editMessageReplyMarkup(undefined);
}

// ── Agent completion notification ────────────────────────────

function notifyCompletion(
  bot: Telegraf<Context>,
  chatId: string,
  workspaceId: string,
  workspaceName: string,
  agentResult: AgentResult
): void {
  const status = agentResult.isError ? "failed" : "done";
  updateWorkspaceStatus(workspaceId, status);

  const icon = agentResult.isError ? "🔴" : "✅";
  const parts: string[] = [];
  if (agentResult.costUsd) parts.push(`$${agentResult.costUsd.toFixed(2)}`);
  if (agentResult.numTurns) parts.push(`${agentResult.numTurns} turns`);
  if (agentResult.durationMs) parts.push(`${Math.round(agentResult.durationMs / 1000)}s`);

  let msg = `${icon} Agent <b>${escHtml(workspaceName)}</b> ${status}`;
  if (parts.length) msg += `\n${parts.join(" · ")}`;
  if (agentResult.resultText) {
    msg += `\n\n<i>${escHtml(truncate(agentResult.resultText, 500))}</i>`;
  }

  bot.telegram
    .sendMessage(chatId, msg, { parse_mode: "HTML" })
    .catch((err) => console.error("[notify] error:", err));
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
  message: string
): Promise<void> {
  const conductorName = workspace.conductorWorkspaceName ?? workspace.name;

  await ctx.reply(`Sending message to <b>${escHtml(conductorName)}</b>...`, {
    parse_mode: "HTML",
  });

  const result = await sendToSession(conductorName, message);

  if ("error" in result) {
    await ctx.reply(`Failed: ${escHtml(result.error)}`, { parse_mode: "HTML" });
    return;
  }

  updateWorkspaceStatus(workspace.id, "running");

  const chatId = ctx.chat!.id;
  await ctx.reply(
    `📨 Message sent to <b>${escHtml(conductorName)}</b>:\n<i>${escHtml(truncate(message, 200))}</i>`,
    { parse_mode: "HTML" }
  );

  result.done.then((agentResult) => {
    notifyCompletion(_bot, chatId.toString(), workspace.id, conductorName, agentResult);
  });
}

// ── Helpers ─────────────────────────────────────────────────

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
