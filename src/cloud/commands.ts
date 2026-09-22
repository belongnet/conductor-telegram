import { createHash } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { GatewayStore, QueueRow } from "./store.js";
import { CloudEngine, type CloudAction, type Provider } from "./engine.js";
import { GitHubError, githubSlug } from "./catalog.js";
import { gatewayHealth } from "./bridge.js";
import { enqueueTelegram, enqueueText, telegramFailure, TerminalError, type TelegramCall } from "./telegram.js";
import { createWorkspace, getWorkspace, getWorkspaceByThreadId, getWorkspaceMessageTarget, getAllWorkspacesForChat,
  getRepoTopicByThreadId, updateWorkspaceThreadId, getDecision, answerDecision, getPendingDecisionsForChat, linkTelegramMessage } from "../store/queries.js";
import { transcribeVoiceMessage } from "../bot/ai-router.js";
import {nativeSessionProvider} from "./messages.js";
import { repositoryRemoteIdentity } from "../lanes/repository-identity.js";
import type { ConductorApiProject } from "../integrations/conductor-api.js";
import type { RepoTopic } from "../types/index.js";

/** Telegram stamps `date` in seconds; one pasted list lands inside this window. */
const BURST_SECONDS = 2;
/** How long an album stays joinable by a file Telegram delivers late, and how long its bookkeeping is kept. */
export const ALBUM_JOIN_MS = 600_000;
/** Album files are fetched a few at a time: one worker serves every chat, and each fetch can take a minute. */
const MEDIA_DOWNLOAD_CONCURRENCY = 4;
/** The Bot API refuses to hand a bot any file larger than this. */
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const TOO_LARGE = "This file is larger than the 20 MB Telegram lets bots download. Send a link to it instead.";
/** Files sent without a word of instruction still reach the agent with one. */
export const ATTACHMENTS_ONLY_PROMPT = "The owner sent the attached files without instructions. Open them, then respond to what they show.";

/** This list drives DELETEs, so it can only ever name buttons, whatever is in the row. */
const offeredKeys = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((key): key is string => typeof key === "string" && key.startsWith("bindtopic:")) : [];

const topicProjectKey = (chatId: string, threadId: number): string => `repo-topic-project:${chatId}:${threadId}`;
const topicNoticeKey = (chatId: string, threadId: number): string => `repo-topic-notice:${chatId}:${threadId}`;
const topicOfferKey = (chatId: string, threadId: number): string => `repo-topic-offer:${chatId}:${threadId}`;

/** A repo topic's own repository identity: the project's name, or the repository name in its remote. */
function matchesRepoName(project: ConductorApiProject, name: string): boolean {
  return project.name.toLowerCase() === name ||
    (repositoryRemoteIdentity(project.gitRemote) ?? "").split("/").pop() === name;
}

/** A project name is free text; the owner needs the repository it actually points at. */
function projectLabel(project: ConductorApiProject): string {
  const identity = repositoryRemoteIdentity(project.gitRemote);
  return `${project.name} · ${identity ? identity.split("/").slice(1).join("/") : project.id}`.slice(0, 60);
}

export function repoTopicCandidates(repoName: string, projects: ConductorApiProject[]): ConductorApiProject[] {
  const name = repoName.trim().toLowerCase();
  return name ? projects.filter(project => matchesRepoName(project, name)) : [];
}

const SHORTCUTS = new Set(["ship", "qa", "investigate", "retro", "health", "checkpoint", "document_release", "office_hours", "design_review", "gstack", "skill"]);
const HELP = "/projects or /repos — list Conductor repositories\n/run <project> <task> — start a task\n/link [project] — show or change which project a repo topic routes to\n/sync — refresh cloud workspace topics\n/send [workspace] <message> — follow up\n/review [PR number or URL] — native review in a separate thread\n/threads — list or select a thread\n/threads new <prompt> — start a thread\n/workspaces, /status, /ping — progress and health\n/prs — PR status\n/decisions — unanswered questions\n/stop, /archive — stop work\n/rename, /renamethread — rename\nReply to a forwarded message or use its workspace topic to target it. Photos, files, and voice notes are supported.";

interface MediaFile { fileId: string; fileName: string; voice: boolean }

/**
 * A queued attachment job. `files` is what this release reads; the first file is also written inline, so a
 * gateway rolled back to a single-file release still prepares the job instead of dead-ending on it.
 */
interface MediaJob extends Partial<MediaFile> {
  action?: CloudAction; decisionId?: number; chatId: string; threadId?: number; text?: string;
  /** Every file of the message, or of its whole album. Absent on jobs queued before albums were grouped. */
  files?: MediaFile[];
  /** The acknowledgement that serves as this job's status card, so a failure lands on it. */
  statusId?: string;
}

function jobFiles(job: MediaJob): MediaFile[] {
  return job.files ?? (job.fileId ? [{ fileId: job.fileId, fileName: job.fileName ?? "attachment", voice: !!job.voice }] : []);
}

/** Both shapes of one message's files: the array this release reads, and the inline first file a rollback reads. */
function mediaPayload(files: MediaFile[]): (MediaJob & { files: MediaFile[] }) | undefined {
  return files.length ? { files, ...files[0] } as MediaJob & { files: MediaFile[] } : undefined;
}

/** The file one Telegram message carries, if any. An album numbers its files so their names stay distinct. */
function messageFile(message: any, position?: number): MediaFile | undefined {
  const attachment = message.voice ?? message.audio ?? message.document ?? message.photo?.at(-1);
  if (!attachment) return undefined;
  const numbered = (name: string, extension = ""): string => position ? `${name}-${position}${extension}` : `${name}${extension}`;
  return { fileId: attachment.file_id, voice: !!(message.voice || message.audio),
    fileName: attachment.file_name ?? (message.photo ? numbered("photo", ".jpg") : message.document ? numbered("attachment") : numbered("voice", ".ogg")) };
}

type AlbumIntake =
  | { kind: "wait" }
  /** A file Telegram delivered after its album was handled, and the work it joins when there is any. */
  | { kind: "late"; joined?: { trackedId: string; sessionId?: string } }
  | { kind: "collected"; messages: any[] };

export class CloudCommands {
  /** How long the first update of an album keeps waiting for the rest of it, at most. */
  albumWaitMs = 1500;
  /** How long it waits after each arrival before deciding the album is complete. */
  albumSettleMs = 300;
  /** Whisper runs as a local binary; tests replace it. */
  transcribe: (voicePath: string) => Promise<string | null> = transcribeVoiceMessage;

  constructor(readonly store: GatewayStore, readonly engine: CloudEngine, readonly telegram: TelegramCall,
    readonly ownerChatId: string, readonly ownerUserId?: string, readonly syncChatId?: string,
    readonly syncInput: "all" | "commands" = "all") {}

  async handle(row: QueueRow): Promise<void> {
    const update = JSON.parse(row.payload);
    const callback = update.callback_query;
    const msg = update.message ?? callback?.message;
    const from = callback?.from ?? msg?.from;
    if (!msg || (this.ownerUserId && String(from?.id) !== this.ownerUserId)) return;
    const syncedTarget = this.syncChatId && String(msg.chat?.id) === this.syncChatId && msg.message_thread_id
      ? getWorkspaceByThreadId(this.syncChatId, msg.message_thread_id) : undefined;
    if (String(msg.chat?.id) !== this.ownerChatId && !(this.ownerUserId && syncedTarget && this.store.get(`cloud-synced:${syncedTarget.id}`))) return;
    const chatId = String(msg.chat.id);
    const threadId = msg.message_thread_id;
    // An album is one message: its first update handles every file and the caption, wherever that caption sits.
    let messages: any[] = [msg];
    let late: { joined?: { trackedId: string; sessionId?: string } } | undefined;
    if (!callback && msg.media_group_id) {
      const album = this.collectAlbum(row, msg, chatId);
      if (album.kind === "wait") return;
      if (album.kind === "late") late = album; else messages = album.messages;
    }
    const files = messages.flatMap((m, i) => messageFile(m, messages.length > 1 ? i + 1 : undefined) ?? []);
    const captions = messages.map(m => String(m.text ?? m.caption ?? "").trim()).filter(Boolean);
    if (!callback && !captions.length && !files.length) return;
    const media = mediaPayload(files);
    const voiceNote = files.some(file => file.voice);
    // A direct reply answers the owner's own message, so it never needs to ring. The acknowledgement doubles as the
    // turn's status card: actions carry its row id so later states edit it instead of posting again.
    const reply = (text: string, suffix = "reply", markup?: unknown) => enqueueText(this.store, `${row.id}:${suffix}`, chatId, text,
      { threadId, replyMarkup: markup, priority: 0, silent: true });
    const statusId = `${row.id}:reply:0`;
    const replyTarget = msg.reply_to_message ? getWorkspaceMessageTarget(chatId, String(msg.reply_to_message.message_id)) : undefined;
    let target = replyTarget?.workspace ?? (threadId ? getWorkspaceByThreadId(chatId, threadId) : undefined);
    // A repo topic is a launch pad, never a workspace's own topic, including for a workspace an
    // earlier release pinned to one. Reply to its message, or use its workspace ID, to follow up.
    if (!replyTarget && target && threadId && getRepoTopicByThreadId(chatId, threadId)) target = undefined;
    let sessionId = replyTarget?.sessionId ?? undefined;
    if (callback) {
      const data = String(callback.data ?? "");
      const answer = (text?: string) => enqueueTelegram(this.store, `${row.id}:answer`,
        { method: "answerCallbackQuery", payload: { callback_query_id: callback.id, ...(text ? { text } : {}) } }, 0);
      // Telegram strips message_thread_id from an inaccessible message, so a bindtopic tap that
      // cannot be placed answers in the toast rather than in whatever topic a reply would land in.
      if (!data.startsWith("bindtopic:")) answer();
      const decisionMatch = data.match(/^decision:(\d+):(\d+)$/);
      if (decisionMatch) {
        const decision = getDecision(Number(decisionMatch[1]));
        if (!decision || getWorkspace(decision.workspaceId)?.telegramChatId !== chatId) return;
        const choice = (JSON.parse(decision.options ?? "[]") as string[])[Number(decisionMatch[2])];
        if (choice && !decision.answeredAt) answerDecision(decision.id, choice);
        reply(decision.answeredAt ? "This question was already answered." : `Answer recorded: ${choice}`); return;
      }
      if (data.startsWith("thread:")) {
        const selection = this.store.get<{ trackedId: string; sessionId: string }>(data);
        const binding = selection && this.store.binding(selection.trackedId);
        if (!selection || !binding || getWorkspace(selection.trackedId)?.telegramChatId !== chatId) return;
        const provider = binding.synced ? nativeSessionProvider(await this.engine.api.getSession(selection.sessionId)) : undefined;
        this.store.bind(selection.trackedId, { ...binding, ...provider, sessionId: selection.sessionId }); reply("Active thread updated."); return;
      }
      if (data.startsWith("bindtopic:")) {
        // Answering an offer, or making a new one, deletes the buttons it retires. A tap on one is
        // scrollback: it must neither re-point the topic nor leave the owner wondering what happened.
        const selection = this.store.get<{ chatId: string; threadId: number; projectId: string; projectLabel: string }>(data);
        if (!selection || selection.chatId !== chatId || selection.threadId !== threadId) {
          answer("That choice is no longer on the table. Use /link to see where this topic routes."); return;
        }
        answer();
        this.linkRepoTopic(chatId, threadId!, selection.projectId);
        reply(`Linked to ${selection.projectLabel}. Send a message here to start a new workspace in it.`); return;
      }
      if (data.startsWith("route:")) {
        const proposed = this.store.get<{ chatId: string; action: CloudAction; media?: MediaJob; ack?: string; choiceFence?: string }>(data);
        if (!proposed || proposed.chatId !== chatId) return;
        if (proposed.choiceFence && this.store.get(proposed.choiceFence)) return;
        if (this.store.row(`${data}:confirmed:action`)) return;
        const action = { ...proposed.action, statusId };
        this.store.db.transaction(() => {
          if (proposed.choiceFence) this.store.set(proposed.choiceFence, true);
          this.enqueueTurn(reply, proposed.ack ?? "Confirmed. Task queued.", `${data}:confirmed:action`, action, proposed.media, `${data}:confirmed`);
        })();
        return;
      }
      return;
    }
    // Any one caption of an album can carry the command; the rest add to its task.
    const commanded = captions.findIndex(caption => /^\/[\w]+/.test(caption));
    const raw = (commanded > 0 ? [captions[commanded], ...captions.filter((_, i) => i !== commanded)] : captions).join("\n\n");
    const match = raw.match(/^\/([\w]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/);
    const addressedBot = match?.[2]?.toLowerCase();
    if (addressedBot && addressedBot !== this.store.get<string>("telegram-bot-username")?.toLowerCase()) return;
    if (chatId === this.syncChatId && this.syncInput === "commands" && !addressedBot) {
      const username = this.store.get<string>("telegram-bot-username");
      reply(`This gateway is awaiting cutover. Your message was not sent to Conductor.\n\nUse /send@${username} <text> in this topic. Plain text and voice replies will be enabled after the old gateway is stopped.`); return;
    }
    if (late) {
      // Telegram handed over the rest of an album after its first update was already handled. It joins that same
      // work rather than starting new work or being refused.
      if (!late.joined) { reply("This file arrived after the rest of its album was handled. Send it again on its own."); return; }
      const action: CloudAction = { type: "send", trackedId: late.joined.trackedId, sessionId: late.joined.sessionId, prompt: raw, statusId };
      linkTelegramMessage(chatId, String(msg.message_id), late.joined.trackedId, late.joined.sessionId);
      this.enqueueTurn(reply, "Added to the same task.", `${row.id}:action`, action, media ? { ...media, chatId, threadId } : undefined, row.id);
      return;
    }
    const command = match?.[1]?.toLowerCase();
    let args = match?.[3]?.trim() ?? "";
    if (command === "ping") { const health = gatewayHealth(this.store); enqueueText(this.store, `${row.id}:reply`, chatId, `Gateway online · ${health.ready ? "ready" : "recovering"}\n${JSON.stringify(health.checks)}${this.githubNote()}`, {threadId, priority: 0, silent: true}); return; }
    if (command === "sync") {
      if (!this.syncChatId) { reply("Cloud workspace sync needs TELEGRAM_CLOUD_SYNC_CHAT_ID set to a forum group."); return; }
      this.store.set("cloud-sync-after", 0);
      reply("Cloud workspace sync requested. Existing workspace topics will be reused."); return;
    }
    if (["help", "start", "setup"].includes(command ?? "")) { reply(HELP); return; }
    if (command === "lanes") {
      if (process.env.LANES_STATE_BACKEND !== "http") { reply("The independent lanes worker needs its HTTP state connection configured."); return; }
      const {handleDurableLanes} = await import("../bot/durable-lanes-command.js");
      let part = 0;
      await handleDurableLanes({message: msg, from, chat: msg.chat, reply: async (text: string, extra?: Record<string, unknown>) => {
        enqueueTelegram(this.store, `${row.id}:lanes:${part++}`, {method: "sendMessage", payload: {chat_id: chatId,
          ...(threadId ? {message_thread_id: threadId} : {}), text, ...extra}}); return {};
      }} as any, args); return;
    }
    if (command === "fleet") {
      const hours = args ? Number(args) : 24;
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) { reply("Usage: /fleet [hours], from 1 to 168."); return; }
      const result = await this.engine.api.runSql(`SELECT workspace_id, workspace_name, session_title, transcript_updated_at FROM session_transcripts_view WHERE transcript_updated_at >= now() - interval '${hours} hours' ORDER BY transcript_updated_at DESC LIMIT 100`);
      reply(result.rows.map(r => `${r.workspace_name} · ${r.session_title}\n${r.workspace_id} · ${r.transcript_updated_at}`).join("\n\n") || "No recent cloud activity."); return;
    }
    if (["projects", "repos"].includes(command ?? "")) {
      const projects = await this.engine.catalog.projects(true);
      const denied = await this.unreadableRepositories(projects.map(p => { try { return githubSlug(p.gitRemote); } catch { return ""; } }));
      const slugOf = (p: ConductorApiProject): string => { try { return githubSlug(p.gitRemote); } catch { return ""; } };
      reply((projects.map((p, i) => `${i + 1}. ${p.name}\n${p.id}\n${p.gitRemote}${denied.has(slugOf(p)) ? "\nGitHub: the gateway's token cannot read this repository" : ""}`).join("\n\n") || "No Conductor projects are available.") +
        (denied.size ? "\n\n/review and /prs need that access. Add those repositories to the gateway's GitHub token with Pull requests: read." : "")); return;
    }
    if (command === "link") {
      const topic = threadId ? getRepoTopicByThreadId(chatId, threadId) : undefined;
      if (!topic) { reply("Use /link inside a repository topic."); return; }
      const current = this.store.get<string>(topicProjectKey(chatId, threadId!));
      // Fetched before the branch on purpose: a catalog outage must retry this update rather than
      // reach the catch below and answer `/link <project>` with an API error.
      const catalog = await this.engine.catalog.projects();
      if (!args) {
        // An explicit ask, so it neither joins a burst nor claims one from a message behind it.
        const linkedTo = catalog.find(p => p.id === current);
        this.offerRepoTopicProject({ repoTopic: topic, chatId, threadId: threadId!, projects: catalog, reply, current,
          lead: `${topic.repoName} routes to ${linkedTo ? projectLabel(linkedTo) : current ? `${current}, which this catalog does not list` : "no project yet"}.` }); return;
      }
      let project: ConductorApiProject;
      try { project = await this.engine.catalog.resolve(args); } catch (error) { reply(error instanceof Error ? error.message : "Repository unavailable"); return; }
      this.linkRepoTopic(chatId, threadId!, project.id);
      reply(`${topic.repoName} routes to ${projectLabel(project)}. Send a message here to start a new workspace in it.`); return;
    }
    if (["workspaces", "status", "prs", "ship_status"].includes(command ?? "")) {
      const rows = getAllWorkspacesForChat(chatId, -1);
      if (command === "prs" || command === "ship_status") {
        const lines: string[] = [];
        // No PR can ever be verified in a repository the token cannot read, so that is said instead of "no PRs yet".
        const denied = await this.unreadableRepositories(rows.map(ws => this.store.binding(ws.id)?.repoSlug ?? ""));
        for (const ws of rows) {
          const binding = this.store.binding(ws.id); if (!binding?.prUrl || denied.has(binding.repoSlug)) continue;
          try { const pr = await this.engine.github.pr(binding.repoSlug, binding.prUrl); lines.push(`${ws.name}: ${pr.merged ? "merged" : pr.state} ${pr.head.slice(0, 12)}\n${pr.url}`); }
          catch (error) {
            const refused = error instanceof GitHubError && !error.rateLimited && [401, 403, 404].includes(error.status)
              ? await this.engine.repoAccess(binding.repoSlug, true).catch(() => undefined) : undefined;
            if (refused && !refused.ok) denied.set(binding.repoSlug, refused.status); else lines.push(`${ws.name}: PR status unavailable`);
          }
        }
        for (const [slug, status] of denied) lines.push(this.engine.github.advice(slug, status));
        reply(lines.join("\n\n") || "No verified PRs yet. Include the PR URL in /review or report it from the agent.");
      } else reply(rows.map(ws => `${ws.name} · ${ws.status}${this.store.binding(ws.id) ? " · cloud" : " · historical"}\n${ws.id}`).join("\n\n") || "No tracked workspaces.");
      return;
    }
    if (command === "decisions") {
      reply(getPendingDecisionsForChat(chatId, 100).map(d => `${d.id}. ${d.question}\nReply to its original message or use /answer ${d.id} <answer>.`).join("\n\n") || "No pending questions."); return;
    }
    const answerId = command === "answer" ? Number(args.split(/\s+/)[0]) : msg.reply_to_message ? this.store.decisionForMessage(chatId, msg.reply_to_message.message_id) : undefined;
    if (answerId) {
      const decision = getDecision(answerId);
      if (decision && getWorkspace(decision.workspaceId)?.telegramChatId === chatId) {
        const answer = command === "answer" ? args.replace(/^\d+\s*/, "") : raw;
        if (media && !decision.answeredAt) {
          this.store.enqueue("media", `${chatId}:${threadId ?? 0}`, { ...media, chatId, threadId, decisionId: answerId,
            action: { type: "send", trackedId: decision.workspaceId, prompt: answer } }, `${row.id}:media`);
          reply("Answer received. Preparing the attachment."); return;
        }
        if (!answer) { reply("Please send a text answer, or /answer <id> <answer>."); return; }
        if (!decision.answeredAt) answerDecision(answerId, answer);
        reply(decision.answeredAt ? "This question was already answered." : "Answer recorded."); return;
      }
    }

    if (command && !["run", "cloud"].includes(command)) {
      const head = args.match(/^\S+/)?.[0];
      const candidates = head ? getAllWorkspacesForChat(chatId, -1).filter(w => w.id === head || w.name === head || w.conductorWorkspaceName === head) : [];
      if (candidates.length > 1) { reply("Workspace name is ambiguous. Use its workspace ID."); return; }
      if (candidates.length === 1) { target = candidates[0]; args = args.slice(head!.length).trimStart(); sessionId = undefined; }
    }
    const historicalTarget = target && !this.store.binding(target.id) && target.conductorBackendKind !== "cloud-api" &&
      !target.repoPath.startsWith("conductor-project:");
    if (historicalTarget && (!command || ["threads", "stop", "archive", "rename", "renamethread", "review", "send"].includes(command) || SHORTCUTS.has(command))) {
      reply("This is preserved historical work with no Conductor Cloud session. Use /repos, then /run <project ID> <task> to start new work. Your message was not sent."); return;
    }
    if (command === "threads") {
      if (!target) { reply("Use /threads inside a workspace topic or reply to its message."); return; }
      const binding = this.store.binding(target.id);
      if (!binding) { reply("This is historical local work. Start a cloud task with /run first."); return; }
      if (args.startsWith("new ") || (args === "new" && media)) {
        const action: CloudAction = { type: "thread", trackedId: target.id, prompt: args.slice(4), statusId };
        this.enqueueTurn(reply, "New thread queued.", `${row.id}:thread`, action,
          media ? {...media, chatId, threadId} : undefined, row.id); return;
      }
      const sessions = await this.engine.api.listWorkspaceSessions(binding.workspaceId);
      const keyboard = sessions.map(s => {
        const key = `thread:${createHash("sha256").update(`${target!.id}:${s.id}`).digest("hex").slice(0, 32)}`;
        this.store.set(key, { trackedId: target!.id, sessionId: s.id });
        return [{ text: `${s.id === binding.sessionId ? "● " : ""}${s.name ?? s.id}`, callback_data: key }];
      });
      reply("Select the active thread, or /threads new <prompt>.", "threads", { inline_keyboard: keyboard }); return;
    }
    if (command === "skills") { reply("Skills: ship, qa, investigate, retro, health, checkpoint, document_release, office_hours, design_review. Use /skill <name> [instructions] in a workspace topic."); return; }
    if (["stop", "archive", "rename", "renamethread", "review", "send"].includes(command ?? "") || SHORTCUTS.has(command ?? "")) {
      if (!target) { reply("Reply to a workspace message, use its topic, or supply its workspace ID."); return; }
      const type = SHORTCUTS.has(command!) ? "send" : command as CloudAction["type"];
      const prompt = SHORTCUTS.has(command!) ? `Use /${command === "skill" ? args : command!.replace(/_/g, "-")} ${command === "skill" ? "" : args}` : args;
      if (["send", "rename", "renamethread"].includes(type) && !prompt && !(type === "send" && media)) { reply("Please include a message or name."); return; }
      const action: CloudAction = { type, trackedId: target.id, sessionId, prompt, statusId };
      this.enqueueTurn(reply, ["stop", "archive"].includes(type) ? "Stop requested. Confirming with Conductor." : "Queued for Conductor.",
        `${row.id}:action`, action, ["send", "review"].includes(type) && media ? { ...media, chatId, threadId } : undefined, row.id); return;
    }
    if (command && !["run", "cloud"].includes(command)) { reply(`Unknown command /${command}.\n\n${HELP}`); return; }

    let chosen: ConductorApiProject | undefined;
    /** The project a new workspace starts in, when this message starts one. */
    let launchProject: ConductorApiProject | undefined;
    let prompt = command ? args : raw;
    if (["run", "cloud"].includes(command ?? "")) {
      const projectInput = args.match(/^\S+/)?.[0];
      prompt = projectInput ? args.slice(projectInput.length).trimStart() : "";
      if (!projectInput || (!prompt && !media)) { reply("Usage: /run <project ID or name> <task>"); return; }
      try { chosen = await this.engine.catalog.resolve(projectInput); }
      catch (error) { reply(error instanceof Error ? error.message : "Repository unavailable"); return; }
      launchProject = chosen; target = undefined; sessionId = undefined;
    }
    const repoTopic = !target && threadId ? getRepoTopicByThreadId(chatId, threadId) : undefined;
    let linked = "";
    if (repoTopic) {
      const key = topicProjectKey(chatId, threadId!);
      const stored = this.store.get<string>(key);
      const projects = await this.engine.catalog.projects();
      const current = stored ? projects.find(p => p.id === stored) : undefined;
      if (chosen) {
        // /run and /cloud name a project for one task. They adopt an unlinked topic, and
        // never silently re-point a linked one; /link is the only way to change it.
        if (!current) { this.linkRepoTopic(chatId, threadId!, chosen.id); linked = `\n\n${repoTopic.repoName} now routes to ${projectLabel(chosen)}. Use /link to change it.`; }
        else if (current.id !== chosen.id) linked = `\n\nThis one is a one-off in ${projectLabel(chosen)}. ${repoTopic.repoName} still routes to ${projectLabel(current)}. Use /link to change it.`;
      } else if (current) launchProject = current;
      else if (stored) {
        // A catalog read can be stale or partial, so a link the owner confirmed is never deleted
        // on its absence, and never silently replaced. Ask until the catalog agrees or /link re-points it.
        this.offerRepoTopicProject({ repoTopic, chatId, threadId: threadId!, projects, reply, burst: true, at: Number(msg.date) || 0, current: stored,
          lead: `${repoTopic.repoName} is linked to a Conductor project this catalog does not list, so nothing sent here reaches Conductor yet.` }); return;
      } else {
        const candidates = repoTopicCandidates(repoTopic.repoName, projects);
        // One repository identity routes on its own. Anything ambiguous asks instead of guessing.
        if (candidates.length !== 1) {
          this.offerRepoTopicProject({ repoTopic, chatId, threadId: threadId!, projects, reply, burst: true, at: Number(msg.date) || 0,
            lead: `${repoTopic.repoName} does not match exactly one Conductor project, so nothing sent here reaches Conductor yet.` }); return;
        }
        this.linkRepoTopic(chatId, threadId!, candidates[0].id); launchProject = candidates[0];
        linked = `\n\n${repoTopic.repoName} now routes to ${projectLabel(candidates[0])}. Use /link to change it.`;
      }
    }
    if (!target && !launchProject) {
      if (voiceNote) {
        this.store.enqueue("media", `${chatId}:${threadId ?? 0}`, { ...media, text: prompt, chatId, threadId, statusId }, `${row.id}:media`);
        reply("Voice note received. Transcribing it before target confirmation."); return;
      }
      if (!prompt) { reply("Choose a workspace topic or /run <project> before sending attachments."); return; }
      this.store.enqueue("route", "native-router", { text: prompt, chatId, threadId, statusId, ...(media ? {media: {...media, chatId, threadId}} : {}) }, `${row.id}:route`);
      reply("Finding a target. I’ll ask you to confirm it before starting work."); return;
    }
    if (!target) {
      const existing = this.store.get<string>(`update-workspace:${row.id}`);
      if (existing) target = getWorkspace(existing);
      // Files sent without a word still deserve a name that says what they are.
      const unnamed = media && !voiceNote && launchProject ? `${launchProject.name}: ${files.length} attachment${files.length === 1 ? "" : "s"}` : "Telegram task";
      if (!target) this.store.db.transaction(() => {
        target = createWorkspace({ name: prompt.slice(0, 70) || unnamed, prompt, repoPath: `conductor-project:${launchProject!.id}`, telegramChatId: chatId });
        this.store.set(`update-workspace:${row.id}`, target.id);
        // A repo topic launches work; it never becomes the workspace's own topic.
        if (threadId && !repoTopic) updateWorkspaceThreadId(target.id, threadId);
      })();
    }
    if (!target) throw new Error("Could not create workspace record");
    // A reply to any photo of an album reaches the work the album started.
    for (const message of messages) linkTelegramMessage(chatId, String(message.message_id), target.id, sessionId);
    const action: CloudAction = { type: this.store.binding(target.id) ? "send" : "launch", trackedId: target.id, sessionId, projectId: launchProject?.id, prompt, statusId };
    const received = files.length > 1 ? `${files.length} attachments received. Preparing them for Conductor.` : "Attachment received. Preparing it for Conductor.";
    this.enqueueTurn(reply, (media ? received : "Task received and queued.") + linked,
      `${row.id}:action`, action, media ? { ...media, chatId, threadId } : undefined, row.id);
  }

  /** Repositories the gateway's GitHub token cannot read. An outage or a rate limit leaves a repository unchecked rather than accused. */
  private async unreadableRepositories(slugs: string[]): Promise<Map<string, number>> {
    const denied = new Map<string, number>();
    await Promise.all([...new Set(slugs.filter(Boolean))].map(async slug => {
      try { const access = await this.engine.repoAccess(slug); if (!access.ok) denied.set(slug, access.status); } catch { /* Not checked. */ }
    }));
    return denied;
  }

  /** `/ping` is a liveness check in its own lane, so it reports only what an earlier command already learned. */
  private githubNote(): string {
    const rows = this.store.db.prepare("SELECT key,value FROM gateway_state WHERE key LIKE 'github-access:%'").all() as Array<{ key: string; value: string }>;
    const denied = rows.filter(row => {
      try { const value = JSON.parse(row.value) as { ok?: boolean; at?: number }; return value.ok === false && typeof value.at === "number" && Date.now() - value.at < 300_000; }
      catch { return false; }
    })
      .map(row => row.key.slice("github-access:".length)).sort();
    return denied.length ? `\nGitHub token cannot read: ${denied.join(", ")}` : "";
  }

  /** The status-card anchor and the work it represents become durable in one commit, anchor first. */
  private enqueueTurn(reply: (text: string, suffix?: string, markup?: unknown) => void, acknowledgement: string,
    actionId: string, action: CloudAction, media?: MediaJob, mediaReservationId = actionId.replace(/:action$/, "")): void {
    this.store.db.transaction(() => {
      reply(acknowledgement);
      if (media) this.prepareMedia(mediaReservationId, action, media);
      else this.engine.queue(actionId, action);
    })();
  }

  /** One authorization, recorded once: the topic's project, with its notice and offer retired together. */
  private linkRepoTopic(chatId: string, threadId: number, projectId: string): void {
    this.store.db.transaction(() => {
      for (const key of offeredKeys(this.store.get(topicOfferKey(chatId, threadId)))) this.store.clear(key);
      this.store.clear(topicOfferKey(chatId, threadId));
      this.store.clear(topicNoticeKey(chatId, threadId));
      this.store.set(topicProjectKey(chatId, threadId), projectId);
    })();
  }

  /** Ambiguous repo topics ask once per burst; a later attempt is always answered. */
  private offerRepoTopicProject(input: { repoTopic: RepoTopic; chatId: string; threadId: number;
    projects: ConductorApiProject[]; reply: (text: string, suffix?: string, markup?: unknown) => void;
    lead: string; at?: number; burst?: boolean; current?: string }): void {
    const { repoTopic, chatId, threadId, projects, reply, lead, at, burst, current } = input;
    const noticeKey = topicNoticeKey(chatId, threadId);
    const notice = burst ? this.store.get<number>(noticeKey) : undefined;
    // A pasted list is several messages Telegram stamped at the same moment, however they end up
    // batched. Anything the owner typed afterwards has a later stamp and is always answered, and a
    // message with no stamp is answered too: silence is never the response to a real message.
    if (notice && at && at >= notice && at - notice <= BURST_SECONDS) return;
    const name = repoTopic.repoName.trim().toLowerCase();
    const rank = (p: ConductorApiProject): number => p.id === current ? -1
      : name && matchesRepoName(p, name) ? 0 : name && p.name.toLowerCase().includes(name) ? 1 : 2;
    const candidates = projects.map(project => ({ project, rank: rank(project) }))
      .sort((a, b) => a.rank - b.rank || a.project.name.localeCompare(b.project.name)).slice(0, 4);
    this.store.db.transaction(() => {
      if (burst) this.store.set(noticeKey, at ?? 0);
      // A button dropped from this offer must stop working, not merely stop being listed.
      for (const stale of offeredKeys(this.store.get(topicOfferKey(chatId, threadId)))) this.store.clear(stale);
      const keyboard = candidates.map(({ project }) => {
        const key = `bindtopic:${createHash("sha256").update(`${chatId}:${threadId}:${project.id}`).digest("hex").slice(0, 32)}`;
        this.store.set(key, { chatId, threadId, projectId: project.id, projectLabel: projectLabel(project) });
        return [{ text: `${project.id === current ? "● " : ""}${projectLabel(project)}`, callback_data: key }];
      });
      this.store.set(topicOfferKey(chatId, threadId), keyboard.map(([button]) => button.callback_data));
      reply(`${lead}\n\n` +
        (keyboard.length ? "Pick its project below, or use /link <project ID>." : "Use /projects, then /link <project ID>.") +
        "\nOnce linked, plain messages here start new workspaces.",
        "bindtopic", keyboard.length ? { inline_keyboard: keyboard } : undefined);
    })();
  }

  private prepareMedia(id: string, action: CloudAction, media: MediaJob): void {
    this.store.db.transaction(() => {
      this.engine.queue(`${id}:action`, { ...action, mediaPending: true });
      this.store.enqueue("media", `${media.chatId}:${media.threadId ?? 0}`, { ...media, action }, `${id}:media`);
    })();
  }

  /**
   * Telegram delivers an album as one update per file, with its caption on at most one of them. The first update
   * handled leads: it absorbs its siblings from its own lane, where no other worker can claim one while the leader
   * is pending or running, and waits a settling interval each time more arrive. A file delivered after the album
   * was handled joins whatever work the album started.
   */
  private collectAlbum(row: QueueRow, msg: any, chatId: string): AlbumIntake {
    const albumKey = `album:${chatId}:${msg.media_group_id}`;
    const album = this.store.get<{ leader: string; at: number }>(albumKey);
    if (album && album.leader !== row.id) {
      if (Date.now() - album.at > ALBUM_JOIN_MS) return { kind: "late" };
      const started = this.store.row(`${album.leader}:action`) ?? this.store.row(`${album.leader}:thread`);
      // Work that never reached Conductor cannot be joined: a send onto it would only dead-end differently.
      if (!started || started.state === "blocked") return { kind: "late" };
      const action = JSON.parse(started.payload) as CloudAction;
      const ws = getWorkspace(action.trackedId);
      if (!ws || ws.archivedAt || ws.telegramChatId !== chatId) return { kind: "late" };
      return { kind: "late", joined: { trackedId: ws.id, sessionId: action.sessionId } };
    }
    // Members are durable before their rows close, so a leader that retries later still has every file.
    const membersKey = `album-members:${row.id}`;
    const absorbed = this.store.db.transaction(() => {
      this.store.assertWriter?.();
      const { rowid } = this.store.db.prepare("SELECT rowid FROM gateway_queue WHERE id=?").get(row.id) as { rowid: number };
      const siblings = this.store.db.prepare(`SELECT id,payload FROM gateway_queue WHERE kind='update' AND conversation=? AND state='pending'
        AND rowid>? AND json_extract(payload,'$.message.media_group_id')=? AND json_extract(payload,'$.message.from.id') IS ? ORDER BY rowid`)
        .all(row.conversation, rowid, String(msg.media_group_id), msg.from?.id ?? null) as Array<{ id: string; payload: string }>;
      // Only a row still waiting in this lane may be closed; one already claimed elsewhere is never touched.
      const absorb = this.store.db.prepare("UPDATE gateway_queue SET state='done',result=?,error=NULL,completed_at=? WHERE id=? AND state='pending'");
      for (const sibling of siblings) absorb.run(JSON.stringify({ absorbedInto: row.id }), Date.now(), sibling.id);
      if (siblings.length) this.store.set(membersKey, [...(this.store.get<any[]>(membersKey) ?? []), ...siblings.map(s => JSON.parse(s.payload).message)]);
      this.store.set(albumKey, { leader: row.id, at: Date.now() });
      return siblings.length;
    })();
    const members = this.store.get<any[]>(membersKey) ?? [];
    // Settle: something just arrived, or nothing has yet. Either way more of the album may still be on its way.
    if ((absorbed > 0 || !members.length) && Date.now() - row.created_at < this.albumWaitMs) {
      this.store.retry(row.id, "Collecting album", this.albumSettleMs); return { kind: "wait" };
    }
    return { kind: "collected", messages: [msg, ...members] };
  }

  /** Telegram hands a bot at most 20 MB of any one file. It usually refuses up front, but a reported size can be
   * wrong, so the bytes are counted too. */
  private async download(file: MediaFile): Promise<Buffer> {
    let info: { file_path?: string; file_size?: number };
    try { info = await this.telegram("getFile", { file_id: file.fileId }); }
    catch (error) {
      if (/file is too big/i.test(telegramFailure(error).description)) throw new TerminalError(TOO_LARGE);
      throw error;
    }
    if ((info.file_size ?? 0) > TELEGRAM_DOWNLOAD_LIMIT) throw new TerminalError(TOO_LARGE);
    if (!info.file_path) throw new TerminalError("Telegram file unavailable");
    const token = process.env.BOT_TOKEN;
    if (!token) throw new TerminalError("Telegram credentials missing");
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`, { signal: AbortSignal.timeout(60_000), redirect: "error" });
    if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body as any) { size += chunk.length; if (size > TELEGRAM_DOWNLOAD_LIMIT) throw new TerminalError(TOO_LARGE); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }

  async media(row: QueueRow): Promise<void> {
    const cooldown = (this.store.get<number>("telegram-not-before") ?? 0) - Date.now();
    if (cooldown > 0) { this.store.retry(row.id, "Telegram cooldown", cooldown); return; }
    const job = JSON.parse(row.payload) as MediaJob;
    if (job.action && this.store.get(`stop:${job.action.trackedId}`)) return;
    const files = jobFiles(job);
    // Every file is prepared at most once, so a retry resumes where the last attempt stopped.
    const fileIds: string[] = [];
    const saved = new Array<string | undefined>(files.length);
    const attachments = files.map((file, i) => ({ file, i })).filter(({ file }) => !file.voice);
    if (attachments.length && !job.action) throw new TerminalError("Choose a workspace before sending this file");
    // One media worker serves every chat, so an album's files are fetched a few at a time rather than one by one.
    // A failure stops its own fetch only: every other fetch settles before the job fails, so none outlives the
    // attempt and saves a file the next attempt would save again.
    let next = 0;
    const failures: unknown[] = [];
    await Promise.all(Array.from({ length: Math.min(MEDIA_DOWNLOAD_CONCURRENCY, attachments.length) }, async () => {
      while (next < attachments.length && !failures.length) {
        const { file, i } = attachments[next++];
        // The first file keeps the key a single-file job used, so a job queued before albums is never saved twice.
        const key = i === 0 ? `media-file:${row.id}` : `media-file:${row.id}:${i}`;
        const existing = this.store.get<string>(key);
        if (existing) { saved[i] = existing; continue; }
        try {
          const bytes = await this.download(file);
          saved[i] = this.engine.bridge.save(job.action!.trackedId, file.fileName, bytes);
          this.store.set(key, saved[i]!);
        } catch (error) { failures.push(error); }
      }
    }));
    if (failures.length) throw failures[0];
    // Whisper is one CPU-bound process at a time; voice notes are transcribed in order, after the downloads.
    const transcripts: string[] = [];
    for (const [i, file] of files.entries()) {
      if (!file.voice) { if (saved[i]) fileIds.push(saved[i]!); continue; }
      const key = `media-transcript:${row.id}:${i}`;
      let transcript = this.store.get<string>(key);
      if (transcript === undefined) {
        const local = path.join(tmpdir(), `ct-voice-${createHash("sha256").update(`${process.pid}:${row.id}:${i}`).digest("hex")}`);
        writeFileSync(local, await this.download(file), { mode: 0o600 });
        try { transcript = await this.transcribe(local) ?? undefined; } finally { unlinkSync(local); }
        if (!transcript) throw new TerminalError("Voice transcription failed. Please retry or send text.");
        this.store.set(key, transcript);
      }
      transcripts.push(transcript);
    }
    if (!job.action) {
      const text = [job.text, ...transcripts].filter(Boolean).join("\n\n");
      this.store.enqueue("route", "native-router", { text, chatId: job.chatId, threadId: job.threadId, statusId: job.statusId }, `${row.id}:route`);
      return;
    }
    job.action.prompt = [job.action.prompt, ...transcripts].filter(Boolean).join("\n\n");
    if (fileIds.length) job.action.fileIds = fileIds;
    // A review already carries its instructions, and an answer is only ever the owner's own words.
    if (!job.decisionId && job.action.type !== "review" && !job.action.prompt.trim() && fileIds.length) job.action.prompt = ATTACHMENTS_ONLY_PROMPT;
    if (job.decisionId) {
      const decision = getDecision(job.decisionId);
      if (!decision || decision.workspaceId !== job.action.trackedId) throw new TerminalError("Question workspace mismatch");
      const links = (job.action.fileIds ?? []).map(id => `Attachment ${id}: ${this.engine.bridge.link(id, job.action!.trackedId)}`);
      if (!decision.answeredAt) answerDecision(job.decisionId, [job.action.prompt, ...links].filter(Boolean).join("\n"));
      enqueueText(this.store, `${row.id}:answered`, job.chatId, "Answer recorded.", { threadId: job.threadId }); return;
    }
    const reservedId = `${row.id.replace(/:media$/, "")}:action`;
    this.store.assertWriter?.();
    this.store.db.prepare("UPDATE gateway_queue SET payload=?,state='pending',available_at=0,error=NULL WHERE id=? AND state IN ('pending','running')")
      .run(JSON.stringify({ ...job.action, mediaPending: false }), reservedId);
  }
}
