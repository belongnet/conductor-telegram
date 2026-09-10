import type {ConductorApiProject, ConductorApiWorkspace, ConductorApiSession, ConductorApiSessionStatus, ConductorApiMessage} from "../integrations/conductor-api.js";
import {repositoryRemoteIdentity} from "../lanes/repository-identity.js";
import {createWorkspace, getWorkspace, updateWorkspaceConductorBinding, upsertThreadCursor} from "../store/queries.js";
import {CloudEngine, transcriptText} from "./engine.js";
import {nativeSessionProvider} from "./messages.js";
import {enqueueTelegram} from "./telegram.js";

/** Discovery only attaches existing work; it never sends, wakes, cancels, or creates native work. */
export class CloudWorkspaceSync {
  private running?: Promise<void>;
  constructor(readonly engine: CloudEngine, readonly chatId: string, readonly concurrency = 4) {
    if (!/^-[1-9]\d*$/.test(chatId)) throw new Error("Cloud workspace sync requires a Telegram forum group ID");
  }

  tick(now = Date.now()): void {
    if (this.running || (this.engine.store.get<number>("cloud-sync-after") ?? 0) > now) return;
    this.running = this.sync().catch(() => {
      this.engine.store.set("cloud-sync-error-at", Date.now());
    }).catch(() => { /* Lease loss already fences the runtime. */ }).finally(() => { this.running = undefined; });
  }
  async settled(): Promise<void> { await this.running; }

  async sync(): Promise<void> {
    const {store, api} = this.engine;
    store.set("cloud-sync-after", Date.now() + 60_000);
    const [projects, workspaces] = await Promise.all([this.engine.catalog.projects(true), api.listWorkspaces({mine: true})]);
    const routerId = store.get<{workspaceId: string}>("router-binding")?.workspaceId;
    const active = workspaces.filter(w => w.id !== routerId && !w.archivedAt && !["archived", "deleted"].includes(w.state ?? ""));
    const seen = new Set(active.map(w => w.id));
    const jobs: Array<{id: string; run: () => Promise<void>}> = active.map(w => ({id: w.id, run: () => this.attach(w, projects)}));
    for (const {id, binding} of store.bindings()) {
      if (getWorkspace(id)?.telegramChatId !== this.chatId || !store.get(`cloud-synced:${id}`) || seen.has(binding.workspaceId)) continue;
      jobs.push({id: binding.workspaceId, run: async () => {
        const lifecycle = await api.getWorkspaceStatus(binding.workspaceId);
        if (["archived", "deleted"].includes(lifecycle.status)) this.close(id);
      }});
    }
    let index = 0;
    const errors: Array<{workspaceId: string; message: string}> = [];
    await Promise.all(Array.from({length: Math.min(this.concurrency, jobs.length)}, async () => {
      while (index < jobs.length) {
        const job = jobs[index++];
        try { await job.run(); } catch (error) {
          errors.push({workspaceId: job.id, message: error instanceof Error ? error.message.replace(/bot\d+:[\w-]+/g, "bot[redacted]").slice(0, 500) : "Workspace sync failed"});
        }
      }
    }));
    store.set("cloud-sync-errors", errors);
    store.set("cloud-sync-status", {at: Date.now(), discovered: active.length, failures: errors.length,
      linked: store.bindings().filter(({id}) => getWorkspace(id)?.telegramChatId === this.chatId && store.get(`cloud-synced:${id}`)).length});
    if (!errors.length) store.set("cloud-sync-last-success", Date.now());
  }

  private async attach(remote: ConductorApiWorkspace, projects: ConductorApiProject[]): Promise<void> {
    const {store, api} = this.engine;
    const identity = repositoryRemoteIdentity(remote.repoUrl ?? "");
    const candidates = projects.filter(p => identity && repositoryRemoteIdentity(p.gitRemote) === identity && (!remote.projectId || remote.projectId === p.id));
    if (candidates.length !== 1) throw new Error("Workspace requires a unique verified native project and repository identity");
    const project = candidates[0];
    const matches = store.bindings().filter(({binding}) => binding.workspaceId === remote.id);
    if (matches.length > 1) throw new Error("Workspace has multiple persisted bindings; reconcile before syncing");
    if (matches.length) {
      const {id} = matches[0], ws = getWorkspace(id);
      if (!ws || ws.telegramChatId !== this.chatId || store.get(`stop:${id}`) || ws.archivedAt) return;
      store.set(`cloud-synced:${id}`, true);
      if (ws.name !== remote.name) {
        store.db.transaction(() => {
          const revision = (store.get<number>(`sync-revision:${id}`) ?? 0) + 1;
          store.set(`sync-revision:${id}`, revision);
          store.db.prepare("UPDATE workspaces SET name=?,conductor_workspace_name=? WHERE id=?").run(remote.name, remote.name, id);
          if (ws.telegramThreadId) enqueueTelegram(store, `sync-rename:${id}:${revision}`, {method: "editForumTopic", workspaceId: id,
            payload: {chat_id: this.chatId, message_thread_id: ws.telegramThreadId, name: remote.name.slice(0, 128)}}, 20);
        })();
      }
      this.topic(id, remote.name);
      return;
    }
    const sessions = (await api.listWorkspaceSessions(remote.id)).filter(s => !s.archivedAt);
    if (!sessions.length) return; // Provisioning may not have created the first session yet.
    const snapshots: Array<{session: ConductorApiSession; status: ConductorApiSessionStatus; tail: ConductorApiMessage[]}> = [];
    for (const session of sessions) {
      const status = await api.getSessionStatus(session.id);
      if (status.workspaceId !== remote.id) throw new Error("Native session belongs to another workspace");
      const tail = await api.getSessionMessageTail(session.id, 20);
      snapshots.push({session, status, tail});
    }
    snapshots.sort((a, b) => Number(b.status.status === "working") - Number(a.status.status === "working") ||
      (Date.parse(b.status.updatedAt) || 0) - (Date.parse(a.status.updatedAt) || 0) || a.session.id.localeCompare(b.session.id));
    const selected = snapshots[0];
    const provider = nativeSessionProvider(selected.session);
    // Network reads can overlap a gateway launch. Recheck the canonical identity before inserting.
    if (store.bindings().some(({binding}) => binding.workspaceId === remote.id)) return;
    store.db.transaction(() => {
      const ws = createWorkspace({name: remote.name, prompt: "Existing Conductor cloud workspace", repoPath: `conductor-project:${project.id}`, telegramChatId: this.chatId});
      store.bind(ws.id, {workspaceId: remote.id, projectId: project.id, repoUrl: project.gitRemote,
        repoSlug: identity!.replace(/^github.com\//, ""), branch: null, prUrl: null, sessionId: selected.session.id, ...provider, stopped: false, synced: true});
      updateWorkspaceConductorBinding(ws.id, {workspaceId: remote.id, sessionId: selected.session.id, backendKind: "cloud-api"});
      store.db.prepare("UPDATE workspaces SET conductor_workspace_name=?,status=? WHERE id=?")
        .run(remote.name, snapshots.some(s => s.status.status === "working") ? "running" : "done", ws.id);
      store.set(`cloud-synced:${ws.id}`, true);
      for (const {session, tail} of snapshots) {
        const last = tail.at(-1);
        upsertThreadCursor({workspaceId: ws.id, sessionId: session.id, backendKind: "cloud-api",
          lastForwardedRowid: last?.sessionIndex ?? -1, lastMessageId: last?.id ?? null, title: session.name});
      }
      this.topic(ws.id, remote.name);
      const input = store.get("cloud-sync-input") === "commands"
        ? `During migration use /send@${store.get<string>("telegram-bot-username")} <text> and /threads@${store.get<string>("telegram-bot-username")} to select a thread. Ordinary text and voice replies activate after the old gateway is disabled.`
        : "Use /threads to choose a thread. Send text or a voice reply here to continue it; replying to a forwarded message targets that message’s thread.";
      this.engine.notify(`sync-intro:${remote.id}`, ws.id,
        `Connected to ${remote.name}\n${remote.deepLink}\n\nDefault thread: ${selected.session.name ?? selected.session.id}\n${input}\nExisting work continues unchanged.`, selected.session.id);
      const latest = [...selected.tail].reverse().find(m => transcriptText(m));
      if (latest) this.engine.notify(`sync-snapshot:${remote.id}`, ws.id, `Latest Conductor reply\n\n${transcriptText(latest)}`, selected.session.id);
    })();
  }

  private topic(id: string, name: string): void {
    const ws = getWorkspace(id);
    if (!ws || ws.telegramThreadId) return;
    this.engine.store.set(`topic-required:${id}`, true);
    enqueueTelegram(this.engine.store, `create-topic:${id}`, {method: "createForumTopic", workspaceId: id,
      payload: {chat_id: this.chatId, name: name.slice(0, 128)}}, 20);
  }

  private close(id: string): void {
    const {store} = this.engine, ws = getWorkspace(id);
    if (!ws || ws.archivedAt || store.get(`stop:${id}`)) return;
    store.assertWriter?.();
    store.db.transaction(() => {
      store.db.prepare("UPDATE workspaces SET status='archived',archived_at=? WHERE id=?").run(new Date().toISOString(), id);
      if (ws.telegramThreadId) enqueueTelegram(store, `sync-close:${id}`, {method: "closeForumTopic", workspaceId: id,
        payload: {chat_id: this.chatId, message_thread_id: ws.telegramThreadId}}, 20);
    })();
  }
}
