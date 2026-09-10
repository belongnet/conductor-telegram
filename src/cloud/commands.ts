import { createHash } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { GatewayStore, QueueRow } from "./store.js";
import { CloudEngine, type CloudAction, type Provider } from "./engine.js";
import { gatewayHealth } from "./bridge.js";
import { enqueueTelegram, enqueueText, type TelegramCall } from "./telegram.js";
import { createWorkspace, getWorkspace, getWorkspaceByThreadId, getWorkspaceMessageTarget, getAllWorkspacesForChat,
  getRepoTopicByThreadId, updateWorkspaceThreadId, getDecision, answerDecision, getPendingDecisionsForChat, linkTelegramMessage } from "../store/queries.js";
import { transcribeVoiceMessage } from "../bot/ai-router.js";
import type { Workspace } from "../types/index.js";

const SHORTCUTS = new Set(["ship", "qa", "investigate", "retro", "health", "checkpoint", "document_release", "office_hours", "design_review", "gstack", "skill"]);
const HELP = "/projects or /repos — list Conductor repositories\n/run <project> <task> — start a task\n/send [workspace] <message> — follow up\n/review [PR URL] — native review in a separate thread\n/threads — list or select a thread\n/threads new <prompt> — start a thread\n/workspaces, /status, /ping — progress and health\n/prs — PR status\n/decisions — unanswered questions\n/stop, /archive — stop work\n/rename, /renamethread — rename\nReply to a forwarded message or use its workspace topic to target it. Photos, files, and voice notes are supported.";

interface MediaJob {
  action?: CloudAction; decisionId?: number; chatId: string; threadId?: number; text?: string;
  fileId: string; fileName: string; voice: boolean;
}

export class CloudCommands {
  constructor(readonly store: GatewayStore, readonly engine: CloudEngine, readonly telegram: TelegramCall,
    readonly ownerChatId: string, readonly ownerUserId?: string) {}

  async handle(row: QueueRow): Promise<void> {
    const update = JSON.parse(row.payload);
    const callback = update.callback_query;
    const msg = update.message ?? callback?.message;
    const from = callback?.from ?? msg?.from;
    if (!msg || String(msg.chat?.id) !== this.ownerChatId || (this.ownerUserId && String(from?.id) !== this.ownerUserId)) return;
    const chatId = String(msg.chat.id);
    const threadId = msg.message_thread_id;
    const attachment = msg.voice ?? msg.audio ?? msg.document ?? msg.photo?.at(-1);
    const media = attachment ? { fileId: attachment.file_id, fileName: attachment.file_name ?? (msg.photo ? "photo.jpg" : "voice.ogg"), voice: !!(msg.voice || msg.audio) } : undefined;
    const reply = (text: string, suffix = "reply", markup?: unknown) => enqueueText(this.store, `${row.id}:${suffix}`, chatId, text,
      { threadId, replyMarkup: markup });
    const replyTarget = msg.reply_to_message ? getWorkspaceMessageTarget(chatId, String(msg.reply_to_message.message_id)) : undefined;
    let target = replyTarget?.workspace ?? (threadId ? getWorkspaceByThreadId(chatId, threadId) : undefined);
    if (!replyTarget && target && !this.store.binding(target.id) && threadId && getRepoTopicByThreadId(chatId, threadId)) target = undefined;
    let sessionId = replyTarget?.sessionId ?? undefined;
    if (callback) {
      enqueueTelegram(this.store, `${row.id}:answer`, { method: "answerCallbackQuery", payload: { callback_query_id: callback.id } }, 0);
      const data = String(callback.data ?? "");
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
        this.store.bind(selection.trackedId, { ...binding, sessionId: selection.sessionId }); reply("Active thread updated."); return;
      }
      if (data.startsWith("route:")) {
        const proposed = this.store.get<{ chatId: string; action: CloudAction; media?: MediaJob }>(data);
        if (!proposed || proposed.chatId !== chatId) return;
        if (proposed.media) this.prepareMedia(`${data}:confirmed`, proposed.action, proposed.media);
        else this.engine.queue(`${data}:confirmed:action`, proposed.action);
        reply("Confirmed. Task queued."); return;
      }
      return;
    }
    const raw = String(msg.text ?? msg.caption ?? "").trim();
    const match = raw.match(/^\/([\w]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/);
    const addressedBot = match?.[2]?.toLowerCase();
    if (addressedBot && addressedBot !== this.store.get<string>("telegram-bot-username")?.toLowerCase()) return;
    const command = match?.[1]?.toLowerCase();
    let args = match?.[3]?.trim() ?? "";
    if (command === "ping") { const health = gatewayHealth(this.store); enqueueText(this.store, `${row.id}:reply`, chatId, `Gateway online · ${health.ready ? "ready" : "recovering"}\n${JSON.stringify(health.checks)}`, {threadId, priority: 0}); return; }
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
      reply(projects.map((p, i) => `${i + 1}. ${p.name}\n${p.id}\n${p.gitRemote}`).join("\n\n") || "No Conductor projects are available."); return;
    }
    if (["workspaces", "status", "prs", "ship_status"].includes(command ?? "")) {
      const rows = getAllWorkspacesForChat(chatId, -1);
      if (command === "prs" || command === "ship_status") {
        const lines: string[] = [];
        for (const ws of rows) {
          const binding = this.store.binding(ws.id); if (!binding?.prUrl) continue;
          try { const pr = await this.engine.github.pr(binding.repoSlug, binding.prUrl); lines.push(`${ws.name}: ${pr.merged ? "merged" : pr.state} ${pr.head.slice(0, 12)}\n${pr.url}`); }
          catch { lines.push(`${ws.name}: PR status unavailable`); }
        }
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
    if (command === "threads") {
      if (!target) { reply("Use /threads inside a workspace topic or reply to its message."); return; }
      const binding = this.store.binding(target.id);
      if (!binding) { reply("This is historical local work. Start a cloud task with /run first."); return; }
      if (args.startsWith("new ") || (args === "new" && media)) {
        const action: CloudAction = { type: "thread", trackedId: target.id, prompt: args.slice(4) };
        if (media) this.prepareMedia(row.id, action, {...media, chatId, threadId});
        else this.engine.queue(`${row.id}:thread`, action);
        reply("New thread queued."); return;
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
      const action: CloudAction = { type, trackedId: target.id, sessionId, prompt };
      if (["send", "review"].includes(type) && media) this.prepareMedia(row.id, action, { ...media, chatId, threadId });
      else this.engine.queue(`${row.id}:action`, action);
      reply(["stop", "archive"].includes(type) ? "Stop requested. Confirming with Conductor." : "Queued for Conductor."); return;
    }
    if (command && !["run", "cloud"].includes(command)) { reply(`Unknown command /${command}.\n\n${HELP}`); return; }

    let projectId: string | undefined;
    let prompt = command ? args : raw;
    if (["run", "cloud"].includes(command ?? "")) {
      const projectInput = args.match(/^\S+/)?.[0];
      prompt = projectInput ? args.slice(projectInput.length).trimStart() : "";
      if (!projectInput || (!prompt && !media)) { reply("Usage: /run <project ID or name> <task>"); return; }
      projectId = (await this.engine.catalog.resolve(projectInput)).id; target = undefined;
    }
    const repoTopic = !target && threadId ? getRepoTopicByThreadId(chatId, threadId) : undefined;
    if (repoTopic && !projectId) {
      // Migration stores verified identities; basenames from old Mac paths never authorize a match.
      projectId = this.store.get<string>(`repo-topic-project:${chatId}:${threadId}`);
      if (!projectId) { reply("This repository topic needs a verified Conductor project mapping. Use /run <project ID> meanwhile."); return; }
    }
    if (!target && !projectId) {
      if (media?.voice) {
        this.store.enqueue("media", `${chatId}:${threadId ?? 0}`, { ...media, text: prompt, chatId, threadId }, `${row.id}:media`);
        reply("Voice note received. Transcribing it before target confirmation."); return;
      }
      if (!prompt) { reply("Choose a workspace topic or /run <project> before sending attachments."); return; }
      this.store.enqueue("route", "native-router", { text: prompt, chatId, threadId, ...(media ? {media: {...media, chatId, threadId}} : {}) }, `${row.id}:route`);
      reply("Finding a target. I’ll ask you to confirm it before starting work."); return;
    }
    if (!target) {
      const existing = this.store.get<string>(`update-workspace:${row.id}`);
      if (existing) target = getWorkspace(existing);
      if (!target) this.store.db.transaction(() => {
        target = createWorkspace({ name: prompt.slice(0, 70) || "Telegram task", prompt, repoPath: `conductor-project:${projectId}`, telegramChatId: chatId });
        this.store.set(`update-workspace:${row.id}`, target.id);
        if (threadId) updateWorkspaceThreadId(target.id, threadId);
      })();
    }
    if (!target) throw new Error("Could not create workspace record");
    linkTelegramMessage(chatId, String(msg.message_id), target.id, sessionId);
    const action: CloudAction = { type: this.store.binding(target.id) ? "send" : "launch", trackedId: target.id, sessionId, projectId, prompt };
    if (media) {
      this.prepareMedia(row.id, action, { ...media, chatId, threadId });
    } else this.engine.queue(`${row.id}:action`, action);
    reply(media ? "Attachment received. Preparing it for Conductor." : "Task received and queued.");
  }

  private prepareMedia(id: string, action: CloudAction, media: MediaJob): void {
    this.store.db.transaction(() => {
      this.engine.queue(`${id}:action`, { ...action, mediaPending: true });
      this.store.enqueue("media", `${media.chatId}:${media.threadId ?? 0}`, { ...media, action }, `${id}:media`);
    })();
  }

  async media(row: QueueRow): Promise<void> {
    const cooldown = (this.store.get<number>("telegram-not-before") ?? 0) - Date.now();
    if (cooldown > 0) { this.store.retry(row.id, "Telegram cooldown", cooldown); return; }
    const job = JSON.parse(row.payload) as MediaJob;
    if (job.action && this.store.get(`stop:${job.action.trackedId}`)) return;
    const info = await this.telegram("getFile", { file_id: job.fileId });
    if (!info.file_path || info.file_size > 50 * 1024 * 1024) throw new Error("Telegram file unavailable or too large");
    const token = process.env.BOT_TOKEN;
    if (!token) throw new Error("Telegram credentials missing");
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`, { signal: AbortSignal.timeout(60_000), redirect: "error" });
    if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body as any) { size += chunk.length; if (size > 50 * 1024 * 1024) throw new Error("Attachment too large"); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    if (job.voice) {
      const local = path.join(tmpdir(), `ct-voice-${createHash("sha256").update(row.id).digest("hex")}`);
      writeFileSync(local, bytes, { mode: 0o600 });
      try {
        const transcript = await transcribeVoiceMessage(local);
        if (!transcript) throw new Error("Voice transcription failed. Please retry or send text.");
        if (job.action) job.action.prompt = [job.action.prompt, transcript].filter(Boolean).join("\n\n");
        else job.text = [job.text, transcript].filter(Boolean).join("\n\n");
      } finally { unlinkSync(local); }
    } else {
      if (!job.action) throw new Error("Choose a workspace before sending this file");
      let id = this.store.get<string>(`media-file:${row.id}`);
      if (!id) { id = this.engine.bridge.save(job.action.trackedId, job.fileName, bytes); this.store.set(`media-file:${row.id}`, id); }
      job.action.fileIds = [id];
    }
    if (!job.action) {
      this.store.enqueue("route", "native-router", { text: job.text, chatId: job.chatId, threadId: job.threadId }, `${row.id}:route`);
      return;
    }
    if (job.decisionId) {
      const decision = getDecision(job.decisionId);
      if (!decision || decision.workspaceId !== job.action.trackedId) throw new Error("Question workspace mismatch");
      const files = (job.action.fileIds ?? []).map(id => `Attachment ${id}: ${this.engine.bridge.link(id, job.action!.trackedId)}`);
      if (!decision.answeredAt) answerDecision(job.decisionId, [job.action.prompt, ...files].filter(Boolean).join("\n"));
      enqueueText(this.store, `${row.id}:answered`, job.chatId, "Answer recorded.", { threadId: job.threadId }); return;
    }
    const reservedId = `${row.id.replace(/:media$/, "")}:action`;
    this.store.assertWriter?.();
    this.store.db.prepare("UPDATE gateway_queue SET payload=?,state='pending',available_at=0,error=NULL WHERE id=? AND state IN ('pending','running')")
      .run(JSON.stringify({ ...job.action, mediaPending: false }), reservedId);
  }
}
