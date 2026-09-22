import { createHash, randomUUID } from "node:crypto";
import type { ConductorApiClient, ConductorApiMessage } from "../integrations/conductor-api.js";
import { ConductorApiError } from "../integrations/conductor-api.js";
import { deterministicUuid } from "../lanes/controller-policy.js";
import { assistantTextFromTranscriptEvent, GITHUB_PR_URL_RE, githubPrUrlMatchesRepo } from "../lanes/decide.js";
import { findSubmittedMessage, isSubmittedMessage, messageEnvelope, nativeTurnFailure, nativeSessionProvider } from "./messages.js";
import { repositoryRemoteIdentity } from "../lanes/repository-identity.js";
import { getWorkspace, updateWorkspaceConductorBinding, updateWorkspaceStatus, getNewEvents, getDecision,
  upsertThreadCursor, getThreadCursor, archiveWorkspaceLocally, pendingCloudMessageCanSend, getRepoTopicByThreadId,
  completePendingCloudMessageDelivery, completePendingCloudTerminalIntent, type PendingCloudTerminalIntent } from "../store/queries.js";
import { GatewayStore, type CloudBinding, type QueueRow } from "./store.js";
import { FileBridge } from "./bridge.js";
import { CloudGitHub, GitHubError, ProjectCatalog, type CloudPr } from "./catalog.js";
import { enqueueTelegram, enqueueText, enqueueStatus, TerminalError, safeDetail } from "./telegram.js";

export interface Provider { agent: "claude" | "codex" | "cursor"; model: string; effort: string }
export const DEFAULT_PROVIDERS: Provider[] = [
  { agent: "claude", model: "fable-5-1", effort: "high" },
  { agent: "codex", model: "gpt-5.6-sol", effort: "high" },
  { agent: "cursor", model: "grok-4.7", effort: "high" },
];
export interface CloudAction {
  type: "launch" | "send" | "thread" | "review" | "stop" | "archive" | "rename" | "renamethread";
  trackedId: string; prompt?: string; projectId?: string; sessionId?: string;
  provider?: Provider; fileIds?: string[]; reviewHead?: string; recovery?: boolean; episode?: string;
  previousMessageId?: string;
  mediaPending?: boolean; previousSessionId?: string;
  legacyRequestId?: string; legacyTerminal?: PendingCloudTerminalIntent;
  /** Queue row id of the acknowledgement that serves as this turn's status card. */
  statusId?: string;
}
interface SessionState {
  trackedId: string; agent: Provider["agent"]; model: string; effort: string;
  role: "task" | "review"; sentMessageId?: string; sentAt?: number; seenWorking?: boolean;
  seenReply?: boolean; awaitingWorkingEdge?: boolean; terminal?: boolean; reviewHead?: string; reviewUrl?: string;
  recoveryAttempted?: boolean; stopped?: boolean; episode?: string; taskPrompt?: string;
  reviewValid?: boolean; reviewBase?: string;
  turnId?: string; nativeCompleted?: boolean; nativeFailure?: string; statusId?: string;
}
/** A message to a sleeping workspace is queued and wakes it; only after this long is silence a stalled turn. */
const WAKE_GRACE_MS = 300_000;

export function transcriptText(message: ConductorApiMessage): string {
  // The native API wraps provider events, including hidden tool/lifecycle
  // events, in rawPayload. Reuse the lane parser's visible-text filtering.
  if (message.type === "agent") {
    let content = message.content;
    if (typeof content === "string") { try { content = JSON.parse(content); } catch {} }
    if (content && typeof content === "object" && "rawPayload" in content) {
      let rawPayload = content.rawPayload;
      if (typeof rawPayload === "string") {
        try { rawPayload = JSON.parse(rawPayload); } catch { return ""; }
      }
      return assistantTextFromTranscriptEvent({...message, content: {...content, rawPayload}});
    }
  }
  const parts: string[] = [];
  const envelope = (value: any): boolean => {
    if (Array.isArray(value)) return value.some(envelope);
    return !!value && typeof value === "object" && (["tool_use", "tool_result", "thinking", "reasoning"].includes(value.type) ||
      typeof value.text === "string" || typeof value.result === "string" || value.message?.content != null || value.content != null || typeof value.message?.text === "string");
  };
  const visit = (value: any, depth: number): void => {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      if (depth === 0) { try { const parsed = JSON.parse(value); if (envelope(parsed)) { visit(parsed, depth + 1); return; } } catch {} }
      parts.push(value); return;
    }
    if (Array.isArray(value)) { for (const part of value) visit(part, depth + 1); return; }
    if (typeof value !== "object" || ["tool_use", "tool_result", "thinking", "reasoning"].includes(value.type)) return;
    if (typeof value.text === "string") parts.push(value.text);
    else if (typeof value.result === "string") parts.push(value.result);
    else if (value.message?.content) visit(value.message.content, depth + 1);
    else if (value.content) visit(value.content, depth + 1);
    else if (value.message?.text) parts.push(value.message.text);
  };
  if (/user|tool|reasoning|system/i.test(message.type)) return "";
  visit(message.content, 0);
  return parts.join("\n");
}

export function recoverableProviderError(detail: string): boolean {
  return /(?:authentication|unauthorized|expired.*token|invalid.*credential|quota|rate.?limit|capacity|usage limit|out of (?:usage )?credits|hit.*limit|insufficient.*(?:credit|balance)|overloaded|disconnected|connection.*(?:closed|lost)|sandbox.*(?:stop|expired)|interrupted)/i.test(detail)
    || /\bmodel\b[^\n]*(?:unavailable|not (?:found|available|supported)|does not exist|may not exist|(?:do|may) not have access)/i.test(detail);
}

/** Conductor has already refused this request; retrying it cannot produce a different answer. */
export function conductorApiRejected(error: unknown): error is ConductorApiError {
  return error instanceof ConductorApiError && [400, 401, 403, 404, 410, 413, 422].includes(error.status ?? 0);
}

type ReviewPick =
  | { kind: "url"; url: string; explicit: boolean }
  | { kind: "choose"; urls: Array<{ url: string; number: number; head: string }> }
  | { kind: "none" }
  | { kind: "denied"; status: number };

/** GitHub outages must remain retryable instead of being cached as an empty PR search. */
function reviewLookupMustRetry(error: unknown): boolean {
  return !(error instanceof GitHubError && error.status === 404 && !error.rateLimited);
}

export class CloudEngine {
  readonly catalog: ProjectCatalog;
  constructor(readonly store: GatewayStore, readonly api: ConductorApiClient, readonly bridge: FileBridge,
    readonly github: CloudGitHub, readonly providers = DEFAULT_PROVIDERS, readonly nativeReviews = false,
    readonly reviewProvider: {agent?: Provider["agent"]; model?: string} = {}) {
    this.catalog = new ProjectCatalog(api, store);
  }

  notify(id: string, trackedId: string, text: string, sessionId?: string, options: { markdown?: boolean; silent?: boolean } = {}): void {
    const ws = getWorkspace(trackedId);
    if (ws) enqueueText(this.store, id, ws.telegramChatId, text, { workspaceId: trackedId, sessionId,
      threadId: ws.telegramThreadId, ...options });
  }

  /**
   * Repository access changes only when the owner edits the token, so it is remembered: an hour when
   * readable, five minutes when not. Only an owner command probes. Polling reads what was last learned.
   */
  async repoAccess(slug: string, fresh = false): Promise<{ ok: boolean; status: number }> {
    const key = `github-access:${slug.toLowerCase()}`;
    const cached = this.store.get<{ ok: boolean; status: number; at: number }>(key);
    if (cached && !fresh && Date.now() - cached.at < (cached.ok ? 3600_000 : 300_000)) return cached;
    const result = await this.github.access(slug);
    const value = { ok: result.readable, status: result.status, at: Date.now() };
    this.store.set(key, value);
    return value;
  }

  /** A refusal still fresh enough to act on without asking GitHub again. */
  githubDenied(slug: string): { status: number } | undefined {
    const cached = this.store.get<{ ok: boolean; status: number; at: number }>(`github-access:${slug.toLowerCase()}`);
    return cached && !cached.ok && Date.now() - cached.at < 300_000 ? cached : undefined;
  }

  /** Turn status is written onto the acknowledgement card; a turn without one gets a silent message. */
  private status(id: string, trackedId: string, anchorId: string | undefined, text: string, sessionId?: string): void {
    const ws = getWorkspace(trackedId);
    if (!ws) return;
    if (anchorId && this.store.row(anchorId)) enqueueStatus(this.store, id, { anchorId, chatId: ws.telegramChatId, workspaceId: trackedId, sessionId, text });
    else this.notify(id, trackedId, text, sessionId, { silent: true });
  }

  private stopped(row: QueueRow, action: CloudAction, submitted = false): boolean {
    if (!this.store.get(`stop:${action.trackedId}`)) return false;
    const mayBeSubmitted = submitted || this.store.get<boolean>(`send-attempted:${row.id}`);
    this.status(`${row.id}:stopped`, action.trackedId, action.statusId, mayBeSubmitted
      ? "Stop requested after submission. Use /status to check Conductor."
      : "Stopped before this was sent.");
    return true;
  }

  queue(id: string, action: CloudAction): void {
    // Stop fences are synchronous, ahead of any already-running network request.
    if (action.type === "stop" || action.type === "archive") {
      const binding = this.store.binding(action.trackedId);
      this.store.set(`stop:${action.trackedId}`, true);
      if (binding) this.store.bind(action.trackedId, { ...binding, stopped: true });
      updateWorkspaceStatus(action.trackedId, "stopped");
    }
    this.store.enqueue("cloud", `${action.trackedId}${["stop", "archive"].includes(action.type) ? ":control" : ""}`, action, id,
      ["stop", "archive"].includes(action.type) ? 0 : 10);
  }

  async action(row: QueueRow): Promise<void> {
    const action = JSON.parse(row.payload) as CloudAction;
    const ws = getWorkspace(action.trackedId);
    if (!ws) throw new TerminalError("This workspace's record no longer exists. Start again with /run <project> <task>.");
    if (!["stop", "archive"].includes(action.type) && this.stopped(row, action)) return;
    if (ws.archivedAt && !["stop", "archive"].includes(action.type)) {
      throw new TerminalError("This workspace is no longer available. Start again with /run <project> <task>.");
    }
    if (action.mediaPending) {
      const media = this.store.row(row.id.replace(/:action$/, ":media"));
      this.store.retry(row.id, media?.state === "blocked" ? "Attachment preparation failed. Resend the attachment." : "Waiting for attachment preparation", 1000, media?.state === "blocked"); return;
    }
    if (action.type === "launch") return this.launch(row, action);
    const binding = this.store.binding(ws.id);
    if (!binding) throw new TerminalError("This historical workspace has no verified cloud binding. Start a new task using /run <project>.");
    if (action.type === "stop" || action.type === "archive") {
      // Include in-flight creations discovered after a lost response. A session can disappear
      // between the list and cancel calls; that one is already stopped, so keep settling the rest.
      let sessions: Awaited<ReturnType<ConductorApiClient["listWorkspaceSessions"]>>;
      try { sessions = await this.api.listWorkspaceSessions(binding.workspaceId); }
      catch (error) {
        if (!(conductorApiRejected(error) && [404, 410].includes(error.status ?? 0))) throw error;
        sessions = [];
      }
      for (const session of sessions) {
        try {
          await this.api.cancelSession(session.id);
          const confirmed = await this.api.getSessionStatus(session.id);
          if (confirmed.status === "working") { this.store.retry(row.id, "Waiting for cancellation to settle", 2000); return; }
        } catch (error) {
          if (!(conductorApiRejected(error) && [404, 410].includes(error.status ?? 0))) throw error;
        }
        const state = this.store.get<SessionState>(`session:${session.id}`);
        if (state) this.store.set(`session:${session.id}`, { ...state, stopped: true, terminal: true });
      }
      if (action.type === "archive") {
        try { await this.api.archiveWorkspace(binding.workspaceId); }
        catch (error) {
          if (!(conductorApiRejected(error) && [404, 410].includes(error.status ?? 0))) throw error;
        }
      }
      if (action.type === "archive" && !ws.archivedAt) {
        this.store.assertWriter?.(); archiveWorkspaceLocally(ws.id);
        this.store.db.prepare("UPDATE gateway_credentials SET revoked=1 WHERE workspace_id=?").run(ws.id);
      }
      if (action.legacyTerminal) completePendingCloudTerminalIntent(ws.id, action.legacyTerminal);
      this.status(`${row.id}:done`, ws.id, action.statusId, action.type === "archive" ? "Cloud workspace archived." : "All cloud threads stopped.");
      return;
    }
    if (action.type === "rename") {
      await this.api.renameWorkspace(binding.workspaceId, action.prompt ?? "");
      this.store.assertWriter?.();
      this.store.db.prepare("UPDATE workspaces SET name=?,conductor_workspace_name=? WHERE id=?").run(action.prompt, action.prompt, ws.id);
      // A repo topic is named for its repository; a workspace living there never renames it.
      if (ws.telegramThreadId && !getRepoTopicByThreadId(ws.telegramChatId, ws.telegramThreadId)) enqueueTelegram(this.store, `topic:${row.id}`, {method: "editForumTopic", workspaceId: ws.id,
        payload: {chat_id: ws.telegramChatId, message_thread_id: ws.telegramThreadId, name: (action.prompt ?? "").slice(0,128)}}, 20);
      this.status(`${row.id}:done`, ws.id, action.statusId, "Cloud workspace renamed."); return;
    }
    if (action.type === "renamethread") {
      await this.api.renameSession(action.sessionId ?? binding.sessionId!, action.prompt ?? "");
      this.status(`${row.id}:done`, ws.id, action.statusId, "Cloud thread renamed."); return;
    }
    if (action.type === "review" && !this.nativeReviews) {
      this.offerReview(row, action, "Native cloud reviews are disabled.", [
        { text: "Ask the agent to review its own diff", prompt: "Use /review", ack: "Asking the agent to review its own diff." },
      ]);
      return;
    }
    if (action.type === "thread" || action.type === "review") {
      return this.newSession(row, action, binding);
    }
    const sessionId = action.sessionId ?? binding.sessionId;
    if (!sessionId) throw new TerminalError("This workspace has no active thread. Pick one with /threads.");
    let actual;
    try { actual = await this.api.getSessionStatus(sessionId); }
    catch (error) {
      if (conductorApiRejected(error) && [404, 410].includes(error.status ?? 0)) {
        throw new TerminalError("This thread no longer exists. Pick another with /threads, or /run <project> <task> to start fresh.");
      }
      throw error;
    }
    if (actual.workspaceId !== binding.workspaceId) throw new TerminalError("Session belongs to another cloud workspace");
    await this.send(row, action, binding, sessionId, actual.status === "working");
  }

  private async launch(row: QueueRow, action: CloudAction): Promise<void> {
    const ws = getWorkspace(action.trackedId)!;
    if (ws.telegramChatId.startsWith("-") && !ws.telegramThreadId) {
      this.store.set(`topic-required:${ws.id}`, true);
      enqueueTelegram(this.store, `create-topic:${ws.id}`, { method: "createForumTopic", workspaceId: ws.id,
        payload: { chat_id: ws.telegramChatId, name: ws.name.slice(0, 128) } }, 0);
    }
    // An unknown or ambiguous project is the same answer on every attempt. An API failure is not, and keeps its own retry policy.
    const project = await this.catalog.resolve(action.projectId ?? "").catch(error => {
      throw error instanceof ConductorApiError ? error : new TerminalError(error instanceof Error ? error.message : "Repository unavailable");
    });
    if (this.stopped(row, action)) return;
    const provider = action.provider ?? this.providers[0];
    let binding = this.store.binding(ws.id);
    if (!binding) {
      const name = `telegram-${ws.id}`;
      let created: { workspaceId: string; sessionId: string; deepLink: string };
      const previous = this.store.get<boolean>(`create-attempt:${row.id}`);
      if (previous) {
        const candidates = (await this.api.listProjectWorkspaces(project.id)).filter(w => w.name === name && w.creatorId === this.store.get<string>("conductor-user-id"));
        if (candidates.length !== 1) throw new Error("Workspace creation receipt is uncertain. Reconciliation found no unique workspace; creation will not be replayed.");
        const sessions = await this.api.listWorkspaceSessions(candidates[0].id);
        if (sessions.length !== 1) throw new Error("Workspace creation has ambiguous sessions; operator attention required");
        created = { workspaceId: candidates[0].id, sessionId: sessions[0].id, deepLink: candidates[0].deepLink };
      } else {
        const credential = this.bridge.issueCredential(ws.id);
        this.store.set(`bridge-token:${ws.id}`, credential);
        this.store.set(`create-attempt:${row.id}`, true);
        try { created = await this.api.createWorkspace({ projectId: project.id, name, agent: provider.agent, model: provider.model,
          ...(provider.agent !== "cursor" ? { effort: provider.effort } : {}),
          env: { TELEGRAM_BRIDGE_URL: this.bridge.publicUrl, TELEGRAM_BRIDGE_TOKEN: credential,
            TELEGRAM_TRACKED_WORKSPACE_ID: ws.id } }); }
        catch (error) {
          if (error instanceof ConductorApiError && error.status === 429) this.store.set(`create-attempt:${row.id}`, false);
          if (this.providerRejected(row, action, provider, error)) return;
          if (conductorApiRejected(error)) {
            this.store.set(`create-attempt:${row.id}`, false);
            throw new TerminalError(`Conductor refused this workspace: ${safeDetail(error.message)}`);
          }
          throw error;
        }
      }
      const remote = await this.api.getWorkspace(created.workspaceId);
      if (remote.repoUrl && repositoryRemoteIdentity(remote.repoUrl) !== repositoryRemoteIdentity(project.gitRemote)) throw new TerminalError("Created workspace repository identity mismatch");
      binding = { workspaceId: created.workspaceId, projectId: project.id, repoUrl: project.gitRemote,
        repoSlug: (repositoryRemoteIdentity(project.gitRemote) ?? "").replace(/^github.com\//, ""), branch: null, prUrl: null,
        sessionId: created.sessionId, ...provider, stopped: false };
      this.store.db.transaction(() => {
        this.store.bind(ws.id, binding!);
        updateWorkspaceConductorBinding(ws.id, { workspaceId: created.workspaceId, sessionId: created.sessionId, backendKind: "cloud-api" });
        this.store.db.prepare("UPDATE workspaces SET conductor_workspace_name=? WHERE id=?").run(remote.name, ws.id);
        this.store.set(`session:${created.sessionId}`, { trackedId: ws.id, ...provider, role: "task" } satisfies SessionState);
      })();
      this.notify(`${row.id}:created`, ws.id, `Conductor workspace created: ${created.deepLink}`, undefined, { silent: true });
    }
    if (this.stopped(row, action)) { this.queue(`stop-created:${row.id}`, { type: "stop", trackedId: ws.id }); return; }
    const lifecycle = await this.api.getWorkspaceStatus(binding.workspaceId);
    if (lifecycle.status === "initializing" || lifecycle.status === "updating") {
      this.status(`${row.id}:provisioning`, ws.id, action.statusId, "Conductor is preparing the workspace.");
      this.store.retry(row.id, "Waiting for cloud provisioning", 5000); return;
    }
    if (["archived", "deleted"].includes(lifecycle.status)) {
      // Conductor destroyed the workspace while provisioning. It will be the same on every attempt, and
      // Conductor's own reason is the only useful thing to tell the owner.
      const detail = safeDetail(lifecycle.errorMessage);
      this.retire(ws.id, "failed");
      throw new TerminalError(detail ? `Conductor could not create the workspace: ${detail}` : `Conductor could not create the workspace. It was ${lifecycle.status} while provisioning.`);
    }
    const session = await this.api.getSessionStatus(binding.sessionId!);
    if (session.workspaceId !== binding.workspaceId) throw new TerminalError("Session belongs to another cloud workspace");
    await this.send(row, action, binding, binding.sessionId!, session.status === "working");
  }

  /** A Conductor workspace that is gone stops being polled and stops owning its topic. Its history stays. */
  private retire(trackedId: string, status: "failed" | "archived"): void {
    const ws = getWorkspace(trackedId);
    if (!ws || ws.archivedAt) return;
    this.store.assertWriter?.();
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE gateway_credentials SET revoked=1 WHERE workspace_id=?").run(trackedId);
      // archived_at is what ends polling and frees the topic: a later message there is routed as a fresh request.
      this.store.db.prepare("UPDATE workspaces SET status=?,archived_at=? WHERE id=?").run(status, new Date().toISOString(), trackedId);
      // Only a topic this gateway opened for the workspace is touched, never an adopted or repository topic, and never by deletion.
      const opened = this.store.row(`create-topic:${trackedId}`);
      if (!opened) return;
      if (ws.telegramThreadId) {
        if (getRepoTopicByThreadId(ws.telegramChatId, ws.telegramThreadId)) return;
        // The close joins the topic's own message lane, so notices already queued for it are delivered first.
        this.store.enqueue("telegram", `${ws.telegramChatId}:${ws.telegramThreadId}`, { method: "closeForumTopic", workspaceId: trackedId,
          payload: { chat_id: ws.telegramChatId, message_thread_id: ws.telegramThreadId } }, `retire-topic:${trackedId}`, 20);
      } else if (opened.state === "pending") {
        // Conductor can destroy a workspace before Telegram has opened its topic. Nothing is owed to a topic that never
        // existed, and rows left waiting for it would hold their delivery lane forever. A creation already in flight is
        // closed by the delivery that completes it.
        this.store.finish(opened.id, { suppressed: "Workspace retired before its topic opened" });
        const waiting = this.store.db.prepare("SELECT id FROM gateway_queue WHERE kind='telegram' AND state='pending' AND json_extract(payload,'$.workspaceId')=?")
          .all(trackedId) as Array<{ id: string }>;
        for (const row of waiting) this.store.finish(row.id, { suppressed: "Workspace retired before its topic opened" });
      }
    })();
  }

  /**
   * Resolve which pull request `/review` should pin, without guessing when several
   * are open and without treating a GitHub token problem as "no PR".
   */
  private async reviewTarget(row: QueueRow, action: CloudAction, binding: CloudBinding): Promise<CloudPr | undefined> {
    const key = `review-pr:${row.id}`;
    const cached = this.store.get<ReviewPick>(key);
    if (cached) return this.settleReviewPick(row, action, binding, cached);
    const access = await this.repoAccess(binding.repoSlug, true);
    if (this.store.get(`stop:${action.trackedId}`)) return;
    if (!access.ok) {
      const pick: ReviewPick = { kind: "denied", status: access.status };
      this.store.set(key, pick);
      return this.settleReviewPick(row, action, binding, pick);
    }
    const pick = await this.resolveReviewPick(action, binding);
    if (!pick || this.store.get(`stop:${action.trackedId}`)) return;
    this.store.set(key, pick);
    return this.settleReviewPick(row, action, binding, pick);
  }

  private async resolveReviewPick(action: CloudAction, binding: CloudBinding): Promise<ReviewPick | undefined> {
    const prompt = action.prompt?.trim() ?? "";
    const urlInPrompt = prompt.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    if (urlInPrompt) return { kind: "url", url: urlInPrompt, explicit: true };
    const numbered = prompt.match(/^#?(\d+)(?:\s|$)/);
    if (numbered && binding.repoSlug) {
      return { kind: "url", url: `https://github.com/${binding.repoSlug}/pull/${numbered[1]}`, explicit: true };
    }
    if (binding.prUrl) {
      try {
        const pr = await this.github.pr(binding.repoSlug, binding.prUrl);
        if (this.store.get(`stop:${action.trackedId}`)) return;
        if (pr.state === "open") return { kind: "url", url: pr.url, explicit: false };
      } catch (error) {
        if (this.store.get(`stop:${action.trackedId}`)) return;
        if (reviewLookupMustRetry(error)) throw error;
      }
    }
    const scanned = await this.scanTranscriptPrs(action, binding);
    if (this.store.get(`stop:${action.trackedId}`)) return;
    const open: Array<{ url: string; number: number; head: string }> = [];
    for (const url of scanned) {
      if (this.store.get(`stop:${action.trackedId}`)) return;
      try {
        const pr = await this.github.pr(binding.repoSlug, url);
        if (pr.state === "open") open.push({ url: pr.url, number: pr.number, head: pr.head });
      } catch (error) {
        // A missing transcript PR is not a candidate. An outage or rate limit is
        // different: do not persist "no PR" while GitHub is unavailable.
        if (reviewLookupMustRetry(error)) throw error;
      }
    }
    if (this.store.get(`stop:${action.trackedId}`)) return;
    if (open.length === 1) return { kind: "url", url: open[0].url, explicit: false };
    if (open.length > 1) return { kind: "choose", urls: open.slice(0, 4) };
    if (binding.branch) {
      const pr = await this.github.find(binding.repoSlug, binding.branch);
      if (this.store.get(`stop:${action.trackedId}`)) return;
      if (pr) return { kind: "url", url: pr.url, explicit: false };
    }
    return { kind: "none" };
  }

  private async scanTranscriptPrs(action: CloudAction, binding: CloudBinding): Promise<string[]> {
    const sessions = await this.api.listWorkspaceSessions(binding.workspaceId);
    const ordered = [...sessions].sort((a, b) => Number(b.id === binding.sessionId) - Number(a.id === binding.sessionId));
    const repo = `https://github.com/${binding.repoSlug}`;
    const urls: string[] = [];
    const seen = new Set<string>();
    for (const session of ordered.slice(0, 5)) {
      if (this.store.get(`stop:${action.trackedId}`)) return urls;
      const state = this.store.get<SessionState>(`session:${session.id}`);
      if (state?.role === "review" || /^Review /.test(session.name ?? "")) continue;
      const tail = await this.api.getSessionMessageTail(session.id, 20);
      for (const message of tail) {
        const text = transcriptText(message);
        for (const match of text.matchAll(new RegExp(GITHUB_PR_URL_RE.source, "gi"))) {
          const url = match[0].replace(/[).,]+$/, "");
          const key = url.toLowerCase();
          if (seen.has(key) || !githubPrUrlMatchesRepo(url, repo)) continue;
          seen.add(key);
          urls.push(url);
          if (urls.length >= 6) return urls;
        }
      }
    }
    return urls;
  }

  private async settleReviewPick(row: QueueRow, action: CloudAction, binding: CloudBinding, pick: ReviewPick): Promise<CloudPr | undefined> {
    if (pick.kind === "denied") {
      this.offerReview(row, action, this.github.advice(binding.repoSlug, pick.status), [
        { text: "Ask the agent to review its own diff", prompt: "Use /review", ack: "Asking the agent to review its own diff." },
      ]);
      return;
    }
    if (pick.kind === "none") {
      this.offerReview(row, action, "No open pull request found for this workspace.", [
        { text: "Ask the agent to review its own diff", prompt: "Use /review", ack: "Asking the agent to review its own diff." },
        { text: "Open a PR first", prompt: "Use /ship", ack: "Asking the agent to open a pull request." },
      ]);
      return;
    }
    if (pick.kind === "choose") {
      this.offerReview(row, action, "Which pull request should be reviewed?", pick.urls.map(pr => ({
        text: `PR #${pr.number} (${pr.head.slice(0, 7)})`.slice(0, 64),
        reviewUrl: pr.url, ack: `Reviewing PR #${pr.number}.`,
      })));
      return;
    }
    try {
      const pr = await this.github.pr(binding.repoSlug, pick.url);
      if (this.store.get(`stop:${action.trackedId}`)) return;
      if (pr.state !== "open") {
        if (pick.explicit) throw new TerminalError("This PR is not open");
        this.offerReview(row, action, "No open pull request found for this workspace.", [
          { text: "Ask the agent to review its own diff", prompt: "Use /review", ack: "Asking the agent to review its own diff." },
          { text: "Open a PR first", prompt: "Use /ship", ack: "Asking the agent to open a pull request." },
        ]);
        return;
      }
      return pr;
    } catch (error) {
      if (error instanceof TerminalError) throw error;
      if (pick.explicit && error instanceof GitHubError && !error.rateLimited && error.status === 404) {
        throw new TerminalError(`That pull request was not found in ${binding.repoSlug}.`);
      }
      if (error instanceof GitHubError && !error.rateLimited && [401, 403].includes(error.status)) {
        throw new TerminalError(this.github.advice(binding.repoSlug, error.status));
      }
      if (pick.explicit && !(error instanceof GitHubError) && error instanceof Error && /PR belongs to another repository|invalid PR commit identities/i.test(error.message)) {
        throw new TerminalError(error.message);
      }
      throw error;
    }
  }

  /** Choice buttons live on the turn's card and reuse the router's confirm callback. */
  private offerReview(row: QueueRow, action: CloudAction, text: string,
    buttons: Array<{ text: string; prompt?: string; reviewUrl?: string; ack: string }>): void {
    const ws = getWorkspace(action.trackedId);
    if (!ws) return;
    const keyboard = buttons.map((button, i) => {
      const key = `route:${createHash("sha256").update(`${row.id}:${i}`).digest("hex").slice(0, 32)}`;
      const next: CloudAction = button.reviewUrl
        ? { type: "review", trackedId: action.trackedId, sessionId: action.sessionId, prompt: [button.reviewUrl, action.prompt].filter(Boolean).join("\n\n") }
        : { type: "send", trackedId: action.trackedId, sessionId: action.sessionId, prompt: button.prompt ?? "" };
      this.store.set(key, { chatId: ws.telegramChatId, action: next, ack: button.ack, choiceFence: `review-choice:${row.id}` });
      return [{ text: button.text, callback_data: key }];
    });
    const replyMarkup = { inline_keyboard: keyboard };
    if (action.statusId && this.store.row(action.statusId)) {
      enqueueStatus(this.store, `${row.id}:choose`, { anchorId: action.statusId, chatId: ws.telegramChatId, workspaceId: ws.id, text, replyMarkup });
    } else {
      enqueueText(this.store, `${row.id}:choose`, ws.telegramChatId, text, { workspaceId: ws.id, threadId: ws.telegramThreadId, replyMarkup });
    }
  }

  private async newSession(row: QueueRow, action: CloudAction, binding: CloudBinding): Promise<void> {
    const pr = action.type === "review" ? await this.reviewTarget(row, action, binding) : undefined;
    if (this.stopped(row, action) || (action.type === "review" && !pr)) return;
    if (action.type === "review" && binding.synced) {
      const author = nativeSessionProvider(await this.api.getSession(action.sessionId ?? binding.sessionId!));
      if (this.stopped(row, action)) return;
      binding = {...binding, ...author};
    }
    if (action.previousSessionId) {
      const previous = await this.api.getSessionStatus(action.previousSessionId);
      const previousState = this.store.get<SessionState>(`session:${action.previousSessionId}`);
      if (previous.workspaceId !== binding.workspaceId ||
          (previous.status !== "error" && !(previous.status === "idle" && previousState?.nativeFailure)) ||
          (action.previousMessageId && previousState?.sentMessageId !== action.previousMessageId)) {
        this.store.retry(row.id, "The previous attempt is no longer confirmed failed. Replacement requires reconciliation.", 0, true); return;
      }
    }
    let sessionId = this.store.get<string>(`created-session:${row.id}`);
    const selected = action.provider ?? this.providers.find(p => action.type !== "review" ||
      (p.agent !== binding.agent && (!this.reviewProvider.agent || p.agent === this.reviewProvider.agent)));
    const provider = selected && action.type === "review" && !action.provider && this.reviewProvider.model
      ? {...selected, model: this.reviewProvider.model} : selected;
    if (!provider || (action.type === "review" && (provider.agent === binding.agent || !this.providers.some(p => p.agent === provider.agent)))) {
      throw new TerminalError("No eligible review provider is enabled. Configure a provider different from the task author.");
    }
    let review = this.store.get<{ url: string; head: string; base: string }>(`review:${row.id}`);
    if (pr) {
      if (review && review.head !== pr.head) throw new TerminalError("PR head changed while starting review. Request a fresh review.");
      if (action.reviewHead && action.reviewHead !== pr.head) throw new TerminalError("PR head changed during recovery. Request a fresh review of the new head.");
      review = { url: pr.url, head: pr.head, base: pr.base }; this.store.set(`review:${row.id}`, review);
      this.store.bind(action.trackedId, { ...binding, prUrl: pr.url, branch: pr.branch });
    }
    if (!sessionId) {
      const name = `${action.type === "review" ? "Review" : "Task"} ${row.id}`;
      if (this.store.get(`session-attempt:${row.id}`)) {
        const matches = (await this.api.listWorkspaceSessions(binding.workspaceId)).filter(s => s.name === name);
        if (matches.length !== 1) throw new Error("Session creation is uncertain; no duplicate will be started");
        sessionId = matches[0].id;
      } else {
        if (this.stopped(row, action)) return;
        this.store.set(`session-attempt:${row.id}`, true);
        try {
          const created = await this.api.createSession({ workspaceId: binding.workspaceId, name,
            agent: provider.agent, model: provider.model, ...(provider.agent !== "cursor" ? { effort: provider.effort } : {}) });
          sessionId = created.id;
        } catch (error) {
          if (error instanceof ConductorApiError && error.status === 429) this.store.set(`session-attempt:${row.id}`, false);
          if (this.providerRejected(row, action, provider, error, binding)) return;
          if (conductorApiRejected(error)) {
            this.store.set(`session-attempt:${row.id}`, false);
            throw new TerminalError(`Conductor refused this thread: ${safeDetail(error.message)}`);
          }
          throw error;
        }
      }
      this.store.set(`created-session:${row.id}`, sessionId);
      this.store.set(`session:${sessionId}`, { trackedId: action.trackedId, ...provider, role: action.type === "review" ? "review" : "task",
        ...(review ? { reviewHead: review.head, reviewUrl: review.url, reviewBase: review.base, reviewValid: false } : {}) } satisfies SessionState);
      if (action.type !== "review") this.store.bind(action.trackedId, { ...this.store.binding(action.trackedId)!, sessionId, ...provider });
    }
    const prompt = review
      ? `Review ${review.url} at exact head ${review.head}, base ${review.base}. Verify these commits before reviewing; report a changed head instead of claiming completion. Report findings only. Do not edit files, push, approve, merge, or deploy. This session has normal Conductor permissions; these are review instructions.\n\n${action.prompt ?? ""}`
      : action.prompt ?? "";
    const session = await this.api.getSessionStatus(sessionId);
    if (session.workspaceId !== binding.workspaceId) throw new TerminalError("Session belongs to another cloud workspace");
    await this.send(row, { ...action, prompt }, binding, sessionId, session.status === "working");
  }

  private async send(row: QueueRow, action: CloudAction, binding: CloudBinding, sessionId: string, sessionWasWorking: boolean): Promise<void> {
    const nativeProvider = binding.synced ? nativeSessionProvider(await this.api.getSession(sessionId)) : undefined;
    if (action.legacyRequestId) {
      const gate = pendingCloudMessageCanSend(action.trackedId, action.legacyRequestId, binding.workspaceId, sessionId);
      if (gate === "mismatch") throw new TerminalError("Legacy pending message identity mismatch; reconcile before retrying");
      if (gate === "missing") return;
      if (gate === "suppressed") { completePendingCloudMessageDelivery(action.trackedId, action.legacyRequestId, binding.workspaceId, sessionId); return; }
    }
    if (this.stopped(row, action)) {
      await this.api.cancelSession(sessionId); return;
    }
    let payload = this.store.get<{ message: string; messageId: string }>(`send:${row.id}`);
    if (!payload) {
      const files = (action.fileIds ?? []).map(id => {
        const file = this.bridge.file(id, action.trackedId);
        if (!file) throw new TerminalError("Attachment missing from this workspace");
        return `${file.name} (attachment ID ${id}): ${this.bridge.link(id, action.trackedId)}`;
      });
      const bridged = !!this.store.db.prepare("SELECT 1 FROM gateway_credentials WHERE workspace_id=? AND revoked=0 LIMIT 1").get(action.trackedId);
      payload = { messageId: deterministicUuid("telegram", row.id), message: `${action.prompt ?? ""}${files.length ? `\n\nDownload these user attachments before work:\n${files.join("\n")}${bridged ? "" : "\nAttachment links expire after 15 minutes; download them first."}` : ""}\n\n${this.bridgeInstructions(bridged)}` };
      this.store.set(`send:${row.id}`, payload);
    }
    const existing = await findSubmittedMessage(this.api, sessionId, payload.messageId);
    if (existing && !messageContainsExactText(existing.content, payload.message)) throw new TerminalError("Message identity mismatch");
    if (this.stopped(row, action, !!existing)) { await this.api.cancelSession(sessionId); return; }
    let submissionQueued = false;
    if (!existing) {
      if (this.store.get(`send-attempted:${row.id}`)) {
        const first = this.store.get<string>(`send-error:${row.id}`);
        throw new Error(`Submission receipt is uncertain; no command will be replayed${first ? `: ${safeDetail(first)}` : ""}`);
      }
      this.bridge.refreshQueuedLinks(payload.message, action.trackedId);
      this.store.set(`send-attempted:${row.id}`, true);
      try {
        const receipt = await this.api.sendMessage({ sessionId, ...payload });
        submissionQueued = receipt.state === "queued";
      }
      catch (error) {
        if (error instanceof ConductorApiError && error.status === 429) this.store.set(`send-attempted:${row.id}`, false);
        else if (conductorApiRejected(error)) {
          this.store.set(`send-attempted:${row.id}`, false);
          throw new TerminalError(`Conductor refused this message: ${safeDetail(error.message)}`);
        } else if (!this.store.get(`send-error:${row.id}`)) {
          this.store.set(`send-error:${row.id}`, error instanceof Error ? error.message : "request failed");
        }
        throw error;
      }
    }
    if (this.stopped(row, action, true)) { await this.api.cancelSession(sessionId); return; }
    if (action.legacyRequestId) completePendingCloudMessageDelivery(action.trackedId, action.legacyRequestId, binding.workspaceId, sessionId);
    const state = {...(this.store.get<SessionState>(`session:${sessionId}`) ?? { trackedId: action.trackedId, ...binding, role: "task" as const }), ...nativeProvider};
    // A continuation keeps writing to the card of the turn it continues.
    const statusId = action.recovery ? action.statusId ?? state.statusId : action.statusId;
    if (state.sentMessageId === payload.messageId) {
      // The send state and status row are separate durable writes. Recreate the deterministic edit
      // after a restart in the narrow window between them; enqueueStatus makes this idempotent.
      this.status(`${row.id}:sent`, action.trackedId, statusId, this.sentCard(action, state), sessionId);
      return;
    }
    const episode = action.recovery ? (action.episode ?? state.episode ?? row.id) : row.id;
    const priorTurnPending = !!state.sentMessageId && state.sentMessageId !== payload.messageId && !state.terminal;
    const reconciledSubmission = !!existing && state.sentMessageId !== payload.messageId;
    // A synced or previously used session can receive work outside this gateway, so an asynchronous
    // or reconciled submission is conservatively fenced. Only the first prompt in a newly created
    // session has no possible predecessor and may use its next working observation immediately.
    const sharedSessionSubmission = (submissionQueued || reconciledSubmission) &&
      (!!binding.synced || !!state.sentMessageId);
    this.store.set(`session:${sessionId}`, { ...state, sentMessageId: payload.messageId, sentAt: Date.now(), terminal: false, episode, statusId,
      taskPrompt: action.recovery ? state.taskPrompt ?? action.prompt : action.prompt,
      seenWorking: false, seenReply: false,
      awaitingWorkingEdge: sessionWasWorking || sharedSessionSubmission || priorTurnPending ||
        (!state.terminal && (!!state.awaitingWorkingEdge || !!state.seenWorking)),
      recoveryAttempted: false, nativeCompleted: false, nativeFailure: undefined,
      turnId: existing ? messageEnvelope(existing.content)?.turnId : undefined });
    if (!action.recovery) {
      this.store.set(`recovery-providers:${episode}`, [state.agent]);
      this.store.set(`recovery-resumed:${episode}`, false);
    } else this.store.set(`recovery-providers:${episode}`, [...new Set([...(this.store.get<string[]>(`recovery-providers:${episode}`) ?? []), state.agent])]);
    updateWorkspaceStatus(action.trackedId, "running");
    this.store.set(`poll-after:${action.trackedId}`, 0);
    this.status(`${row.id}:sent`, action.trackedId, statusId, this.sentCard(action, state), sessionId);
  }

  private sentCard(action: CloudAction, state: SessionState): string {
    if (action.recovery) return `Continuing in ${state.agent} (${state.model}).`;
    if (action.type === "review" && state.reviewUrl && state.reviewHead) {
      const number = state.reviewUrl.match(/\/pull\/(\d+)/)?.[1];
      return `Reviewing PR #${number} (${state.reviewHead.slice(0, 7)}) in ${state.agent}`;
    }
    return `Sent to ${state.agent} (${state.model}).`;
  }

  /** Only a workspace this gateway created holds a bridge credential; any other agent is told to answer inline. */
  private bridgeInstructions(bridged: boolean): string {
    if (!bridged) return "Your replies in this session are forwarded to Telegram. Ask questions in your reply and wait for the user; do not treat a missing answer as approval. Report PR URLs explicitly. Preserve existing work when continuing an interrupted task.";
    return "For Telegram oversight use the conductor-telegram-mcp tools report_status, report_artifact and request_human when installed. The tools use TELEGRAM_BRIDGE_URL and TELEGRAM_BRIDGE_TOKEN from your environment; never print these values. If an attachment link has expired, use refresh_attachment with its ID. After a restart or lost question receipt, use list_human_decisions and read_human_decision before asking again; verify the answer applies to the current task. If tools are unavailable, ask questions in your response and wait for the user. Do not treat a missing answer as approval. Report PR URLs explicitly. Preserve existing work when continuing an interrupted task.";
  }

  private providerRejected(row: QueueRow, action: CloudAction, provider: Provider, error: unknown, binding?: CloudBinding): boolean {
    // Only an explicit rejection establishes that no run was created. Network,
    // timeout and server errors retain their intent and require reconciliation.
    if (!(error instanceof ConductorApiError) || ![400, 403, 422].includes(error.status ?? 0) || !/model|provider|quota|credential/i.test(error.message)) return false;
    const episode = action.episode ?? row.id;
    const used = [...new Set([...(this.store.get<string[]>(`recovery-providers:${episode}`) ?? []), provider.agent])];
    const next = this.providers.find(p => !used.includes(p.agent) && (action.type !== "review" || p.agent !== binding?.agent));
    this.store.db.transaction(() => {
      this.store.set(`recovery-providers:${episode}`, used);
      this.store.set(`${action.type === "launch" ? "create" : "session"}-attempt:${row.id}`, false);
      if (next) {
        this.store.db.prepare("UPDATE gateway_queue SET payload=? WHERE id=?").run(JSON.stringify({...action, provider: next, episode, recovery: true}), row.id);
        this.store.retry(row.id, `${provider.agent} unavailable; trying ${next.agent}`, 1000);
        this.status(`provider-rejected:${row.id}:${provider.agent}`, action.trackedId, action.statusId, `${provider.agent} rejected the run before it started. Trying ${next.agent} (${next.model}).`);
      } else this.store.retry(row.id, "All configured providers rejected this run before execution. Check provider credentials and model availability.", 0, true);
    })();
    return true;
  }

  async pollWorkspace(trackedId: string, binding: CloudBinding): Promise<void> {
    const ws = getWorkspace(trackedId); if (!ws || ws.archivedAt) { this.store.set(`poll-after:${trackedId}`, Date.now() + 60_000); return; }
    const due = this.store.get<number>(`poll-after:${trackedId}`) ?? 0;
    if (Date.now() < due) return;
    const lifecycle = await this.api.getWorkspaceStatus(binding.workspaceId);
    if (["deleted", "archived"].includes(lifecycle.status)) {
      this.store.set(`poll-after:${trackedId}`, Date.now() + 60_000);
      const detail = safeDetail(lifecycle.errorMessage);
      if (!binding.stopped && !["done", "stopped", "archived", "failed"].includes(ws.status)) this.notify(`unavailable:${trackedId}`, trackedId,
        `Conductor workspace is no longer available${detail ? `: ${detail}` : ""}. Its history is retained; no task has been replayed.`);
      // Queued after the notice, in the same topic lane, so the notice is delivered before the topic closes.
      this.retire(trackedId, lifecycle.status === "deleted" && detail ? "failed" : "archived");
      return;
    }
    const sessions = await this.api.listWorkspaceSessions(binding.workspaceId);
    let active = false;
    let backlog = false;
    const reportedPrUrls = new Set<string>();
    for (const session of sessions) {
      let state = this.store.get<SessionState>(`session:${session.id}`);
      if (!state) {
        // Observe existing threads without assigning them an inferred provider/recovery policy.
        if (binding.synced && !getThreadCursor(trackedId, session.id)) {
          // Discovery already anchored the old threads. A newly added native
          // thread must forward its first reply, including session index zero.
          upsertThreadCursor({workspaceId: trackedId, sessionId: session.id, backendKind: "cloud-api",
            lastForwardedRowid: -1, lastMessageId: null, title: session.name});
        }
        const latest = !getThreadCursor(trackedId, session.id) ? await this.api.getLatestSessionMessage(session.id) : null;
        if (latest) upsertThreadCursor({ workspaceId: trackedId, sessionId: session.id,
          backendKind: "cloud-api", lastForwardedRowid: latest.sessionIndex, lastMessageId: latest.id, title: session.name });
      }
      const cursor = getThreadCursor(trackedId, session.id);
      let messages: ConductorApiMessage[];
      const reanchor = this.store.get<number>(`reanchor:${session.id}`);
      try { messages = await this.api.listSessionMessages({ sessionId: session.id, after: reanchor === undefined ? cursor?.lastMessageId : undefined, offset: reanchor, limit: 100 }); }
      catch (error) {
        if (!(error instanceof ConductorApiError) || ![400, 404].includes(error.status ?? 0)) throw error;
        this.store.set(`reanchor:${session.id}`, 0);
        messages = await this.api.listSessionMessages({ sessionId: session.id, offset: 0, limit: 100 });
      }
      if (this.store.get(`reanchor:${session.id}`) !== undefined) {
        if (messages.some(m => m.sessionIndex > (cursor?.lastForwardedRowid ?? -1)) || messages.length < 100) {
          this.store.set(`reanchor:${session.id}`, null);
          this.store.db.prepare("DELETE FROM gateway_state WHERE key=?").run(`reanchor:${session.id}`);
        } else this.store.set(`reanchor:${session.id}`, (reanchor ?? 0) + messages.length);
      }
      backlog ||= messages.length === 100;
      const status = await this.api.getSessionStatus(session.id);
      if (status.workspaceId !== binding.workspaceId) throw new Error("Polled session moved to another workspace");
      // A send or stop can commit while either upstream read waits. Apply the
      // transcript to that current turn, never write back the pre-read snapshot.
      state = this.store.get<SessionState>(`session:${session.id}`);
      const turnStart = state?.sentMessageId ? messages.findIndex(m => isSubmittedMessage(m, state!.sentMessageId!)) : -1;
      if (state && turnStart >= 0) {
        const turnId = messageEnvelope(messages[turnStart].content)?.turnId;
        if (typeof turnId === "string") state.turnId = turnId;
      }
      for (const [index, message] of messages.entries()) {
        if (cursor && message.sessionIndex <= cursor.lastForwardedRowid) continue;
        const text = transcriptText(message);
        const envelope = message.type === "agent" ? messageEnvelope(message.content) : undefined;
        const nativeTurn = envelope?.turnId ?? envelope?.userMessageId;
        const currentReply = state && (typeof nativeTurn === "string"
          ? nativeTurn === (state.turnId ?? state.sentMessageId)
          : ((turnStart >= 0 && index > turnStart) || (turnStart < 0 && state.sentAt && Date.parse(message.receivedAt) >= state.sentAt)));
        if (state && currentReply) {
          if (text) state.seenReply = true;
          const raw = messageEnvelope(envelope?.rawPayload);
          if ((raw?.type === "command_lifecycle" && raw.state === "completed") ||
              (raw?.type === "result" && raw.subtype === "success" && !raw.is_error) ||
              raw?.event?.type === "turn.completed") state.nativeCompleted = true;
          const failure = nativeTurnFailure(raw);
          if (failure) state.nativeFailure = failure;
        }
        this.store.db.transaction(() => {
          if (text) this.notify(`transcript:${session.id}:${message.id}`, trackedId, `${sessions.length > 1 ? `${session.name ?? "Thread"}\n\n` : ""}${text}`, session.id, { markdown: true });
          if (state) this.store.set(`session:${session.id}`, state);
          upsertThreadCursor({ workspaceId: trackedId, sessionId: session.id, backendKind: "cloud-api", lastForwardedRowid: message.sessionIndex, lastMessageId: message.id, title: session.name });
        })();
        const prUrl = text.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/)?.[0];
        if (prUrl) reportedPrUrls.add(prUrl);
      }
      if (status.status === "working") {
        active = true;
        // Session status is not turn-scoped. If a follow-up was submitted while the prior turn was
        // already working, require an idle edge or current-turn output before treating it as started.
        if (state && !state.awaitingWorkingEdge) state.seenWorking = true;
      } else if (state) state.awaitingWorkingEdge = false;
      if (state) this.store.set(`session:${session.id}`, state);
      if (state?.role === "review" && state.terminal && state.reviewValid && state.reviewUrl) {
        const current = await this.github.pr(binding.repoSlug, state.reviewUrl);
        if (!this.currentTurn(session.id, state)) continue;
        if (current.head !== state.reviewHead || (state.reviewBase && current.base !== state.reviewBase)) {
          this.store.set(`session:${session.id}`, {...state, reviewValid: false});
          this.notify(`review-invalidated:${session.id}:${current.head}:${current.base}`, trackedId, "The PR commits changed after review. Previous review completion is invalid; run /review again.", session.id);
        }
      }
      if (!state || state.terminal || state.stopped || binding.stopped || this.store.get(`stop:${trackedId}`)) continue;
      const pendingQuestion = this.store.db.prepare("SELECT 1 FROM decisions WHERE workspace_id=? AND answered_at IS NULL LIMIT 1").get(trackedId);
      if (status.status === "idle" && !state.nativeFailure && messages.length < 100 && !pendingQuestion && state.seenReply && (lifecycle.status !== "sleeping" || state.nativeCompleted)) {
        let staleReview = false;
        if (state.role === "review" && state.reviewUrl) {
          const current = await this.github.pr(binding.repoSlug, state.reviewUrl);
          if (!this.currentTurn(session.id, state)) continue;
          staleReview = current.head !== state.reviewHead || !!(state.reviewBase && current.base !== state.reviewBase);
          state.reviewValid = !staleReview;
        }
        const recovered = !!state.episode && (this.store.get<string[]>(`recovery-providers:${state.episode}`)?.length ?? 0) > 1;
        // A changed head invalidates findings the user may already be reading, so it interrupts; every other outcome is the card's final state.
        if (staleReview) this.notify(`complete:${session.id}:${state.sentMessageId}`, trackedId, "The PR changed during review. These findings do not cover its current head; run /review again.", session.id);
        else this.status(`complete:${session.id}:${state.sentMessageId}`, trackedId, state.statusId, state.role === "review"
          ? `Review complete for ${state.reviewHead}. Findings do not bypass merge checks.` : recovered ? "Conductor task finished after recovery." : "Conductor task finished.", session.id);
        state.terminal = true; this.store.set(`session:${session.id}`, state);
      } else if (status.status === "error" || (status.status === "idle" && state.nativeFailure && messages.length < 100)) {
        const detail = state.nativeFailure ?? status.errorMessage ?? status.lastError ?? "Unknown Conductor session error";
        if (recoverableProviderError(detail)) await this.recover(trackedId, binding, session.id, state, detail);
        else this.notify(`error:${session.id}:${state.sentMessageId}`, trackedId, `Conductor reported an error: ${detail}\nUse /send to continue after addressing it.`, session.id);
      } else if (status.status === "idle" && lifecycle.status === "sleeping" && messages.length < 100 && !pendingQuestion && state.sentMessageId && !state.recoveryAttempted &&
          // Conductor queues a message to a sleeping workspace and wakes it itself. Only a turn seen running, or one
          // that already produced output, can have slept mid-task; a younger silent turn is still waiting to wake.
          (state.seenWorking || state.seenReply || Date.now() - (state.sentAt ?? 0) > WAKE_GRACE_MS)) {
        const wakeKey = `wake-attempted:${session.id}:${state.episode ?? state.sentMessageId}`;
        const wakeAt = this.store.get<number>(wakeKey);
        if (wakeAt !== undefined) {
          if (Date.now() - wakeAt > 120_000) this.notify(`${wakeKey}:attention`, trackedId,
            "Conductor is still sleeping after a continuation was submitted. No duplicate was sent; check the workspace before continuing.", session.id);
          continue;
        }
        // Wake with a continuation, not the original potentially side-effectful task.
        this.store.set(wakeKey, Date.now());
        state.recoveryAttempted = true; this.store.set(`session:${session.id}`, state);
        this.queue(`wake:${session.id}:${state.sentMessageId}`, { type: "send", trackedId, sessionId: session.id, recovery: true, episode: state.episode,
          prompt: "The workspace slept during this task. Inspect files and transcript, preserve completed work, and continue only unfinished work. Report uncertainty before repeating side effects." });
      }
    }
    // A repository the token cannot read fails every verification, so a known refusal skips GitHub until it expires.
    for (const prUrl of this.githubDenied(binding.repoSlug) ? [] : reportedPrUrls) {
      try { const pr = await this.github.pr(binding.repoSlug, prUrl); this.store.bind(trackedId, { ...this.store.binding(trackedId)!, prUrl: pr.url, branch: pr.branch }); }
      catch (error) {
        // Unverified transcript URLs never establish repository identity. A refusal is classified once, so the
        // owner can be told what to grant, and a poll never fails because that probe did.
        if (error instanceof GitHubError && !error.rateLimited && [401, 403, 404].includes(error.status)) await this.repoAccess(binding.repoSlug, true).catch(() => undefined);
      }
    }
    // PR reads can overlap a stop or the creation of another thread. The final
    // aggregate must include every currently persisted session for this task.
    const states = (this.store.db.prepare("SELECT value FROM gateway_state WHERE key LIKE 'session:%' AND json_extract(value,'$.trackedId')=?")
      .all(trackedId) as Array<{value: string}>).map(row => JSON.parse(row.value) as SessionState);
    const stopped = !!this.store.get(`stop:${trackedId}`) || !!this.store.binding(trackedId)?.stopped;
    const pendingAction = !!this.store.db.prepare("SELECT 1 FROM gateway_queue WHERE kind='cloud' AND state IN ('pending','running') AND json_extract(payload,'$.trackedId')=? LIMIT 1").get(trackedId);
    const currentWorkspace = getWorkspace(trackedId);
    if (currentWorkspace && !currentWorkspace.archivedAt && currentWorkspace.status !== "archived") {
      if (stopped) updateWorkspaceStatus(trackedId, "stopped");
      else if (binding.synced && !pendingAction && !states.length) updateWorkspaceStatus(trackedId, active ? "running" : "done");
      else if (!active && !pendingAction && states.length && states.every(s => s.terminal || s.stopped)) updateWorkspaceStatus(trackedId, "done");
    }
    const awaitingTurn = !stopped && (pendingAction || states.some(state => !state.terminal && !state.stopped));
    this.store.set(`poll-after:${trackedId}`, Date.now() + (backlog ? 1000 : (!stopped && active) || awaitingTurn ? 15_000 : 60_000));
    this.store.set(`poll-success:${trackedId}`, Date.now());
  }

  private currentTurn(sessionId: string, state: SessionState): boolean {
    const current = this.store.get<SessionState>(`session:${sessionId}`);
    return !!current && current.sentMessageId === state.sentMessageId && current.episode === state.episode &&
      !current.stopped && !this.store.get(`stop:${state.trackedId}`);
  }

  private async recover(trackedId: string, binding: CloudBinding, sessionId: string, state: SessionState, detail: string): Promise<void> {
    if (state.recoveryAttempted) return;
    const episode = state.episode ?? sessionId;
    // Require a second authoritative terminal observation immediately before replacement.
    const status = await this.api.getSessionStatus(sessionId);
    if (status.workspaceId !== binding.workspaceId ||
        (status.status !== "error" && !(status.status === "idle" && state.nativeFailure)) || !this.currentTurn(sessionId, state)) return;
    if (/disconnected|connection.*(?:closed|lost)|interrupted|sandbox.*(?:stop|expired)/i.test(detail) && !this.store.get(`recovery-resumed:${episode}`)) {
      this.store.db.transaction(() => {
        this.store.set(`recovery-resumed:${episode}`, true);
        this.store.set(`session:${sessionId}`, { ...state, recoveryAttempted: true });
        this.queue(`resume:${sessionId}:${state.sentMessageId}`, { type: "send", trackedId, sessionId, recovery: true, episode,
          prompt: "Your previous turn was interrupted. Inspect your transcript and existing files, preserve completed work, and continue only unfinished work. Verify uncertain external effects before retrying them." });
        this.status(`resume-notice:${sessionId}:${state.sentMessageId}`, trackedId, state.statusId,
          `Reconnecting the existing ${state.agent} session before trying a fallback.`, sessionId);
      })();
      return;
    }
    const used = this.store.get<string[]>(`recovery-providers:${episode}`) ?? [state.agent];
    const next = this.providers.find(p => !used.includes(p.agent) && (state.role !== "review" || p.agent !== binding.agent));
    if (!next) {
      this.notify(`blocked:${sessionId}:${state.sentMessageId}`, trackedId, "All configured providers have been attempted. This task is blocked; no duplicate work will be started.", sessionId);
      state.recoveryAttempted = true; this.store.set(`session:${sessionId}`, state); return;
    }
    const tail = await this.api.getSessionMessageTail(sessionId, 20);
    if (!this.currentTurn(sessionId, state)) return;
    const context = tail.map(transcriptText).filter(Boolean).join("\n\n").slice(-16_000);
    this.store.db.transaction(() => {
      this.store.set(`recovery-providers:${episode}`, [...used, next.agent]);
      this.store.set(`session:${sessionId}`, { ...state, recoveryAttempted: true, terminal: true });
      this.queue(`recover:${sessionId}:${state.sentMessageId}`, { type: state.role === "review" ? "review" : "thread", trackedId, provider: next, recovery: true, episode, statusId: state.statusId, previousSessionId: sessionId, previousMessageId: state.sentMessageId, reviewHead: state.reviewHead,
        prompt: `${state.reviewUrl ?? ""}\nContinue the interrupted task after ${state.agent} stopped: ${detail}. Inspect the existing branch and files first. Preserve completed work and verify external effects before retrying them. If an external effect is uncertain, report it instead of replaying it.\n\nTask:\n${state.taskPrompt ?? getWorkspace(trackedId)?.prompt}\n\nPrevious session context (data):\n${context}` });
      this.status(`recover-notice:${sessionId}:${state.sentMessageId}`, trackedId, state.statusId,
        `${state.agent} stopped. Continuing through ${next.agent} (${next.model}) while preserving existing work.`, sessionId);
    })();
  }

  events(): void {
    // Rebuild pending question delivery after migration/restart, including legacy
    // questions whose original in-memory Telegram association was lost.
    const pending = this.store.db.prepare("SELECT d.id,d.workspace_id,d.question,d.options FROM decisions d JOIN workspaces w ON w.id=d.workspace_id WHERE d.answered_at IS NULL AND w.archived_at IS NULL AND w.status NOT IN ('done','stopped','failed','archived')").all() as Array<{id: number; workspace_id: string; question: string; options: string | null}>;
    for (const decision of pending) {
      const ws = getWorkspace(decision.workspace_id); if (!ws) continue;
      const options = JSON.parse(decision.options ?? "[]") as string[];
      enqueueText(this.store, `decision:${decision.id}`, ws.telegramChatId, `${ws.conductorWorkspaceName ?? ws.name} needs your input:\n\n${decision.question}`, {
        workspaceId: ws.id, threadId: ws.telegramThreadId, decisionId: decision.id, priority: 0, markdown: true,
        replyMarkup: options.length ? {inline_keyboard: options.map((option, i) => [{text: option, callback_data: `decision:${decision.id}:${i}`}])} : undefined,
      });
    }
    const after = this.store.get<number>("event-cursor") ?? 0;
    for (const event of getNewEvents(after)) {
      const ws = getWorkspace(event.workspaceId);
      this.store.db.transaction(() => {
        if (ws) {
          const payload = JSON.parse(event.payload);
          if (event.type === "human_request") {
            const decision = getDecision(payload.decisionId);
            if (decision && !decision.answeredAt && !ws.archivedAt && !["done", "stopped", "failed", "archived"].includes(ws.status)) enqueueText(this.store, `decision:${decision.id}`, ws.telegramChatId, `${ws.conductorWorkspaceName ?? ws.name} needs your input:\n\n${payload.question}`, {
              workspaceId: ws.id, threadId: ws.telegramThreadId, decisionId: payload.decisionId, priority: 0, markdown: true,
              replyMarkup: payload.options?.length ? { inline_keyboard: payload.options.map((option: string, i: number) => [{ text: option, callback_data: `decision:${payload.decisionId}:${i}` }]) } : undefined });
          } else if (event.type === "artifact" && payload.type === "file" && payload.url.startsWith("attachment:")) {
            const file = this.bridge.file(payload.url.slice(11), ws.id);
            if (file) enqueueTelegram(this.store, `event:${event.id}`, { method: "sendDocument", workspaceId: ws.id, filePath: file.path,
              payload: { chat_id: ws.telegramChatId, ...(ws.telegramThreadId ? { message_thread_id: ws.telegramThreadId } : {}), filename: file.name, caption: payload.description.slice(0, 1000) } });
          } else if (event.type !== "human_response") this.notify(`event:${event.id}`, ws.id, event.type === "status" ? `${payload.status}: ${payload.message}` : `${payload.description}\n${payload.url}`, undefined, { markdown: true });
        }
        this.store.set("event-cursor", event.id);
      })();
    }
  }
}

export function messageContainsExactText(content: unknown, text: string, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof content === "string") {
    if (content === text) return true;
    try { return messageContainsExactText(JSON.parse(content), text, depth + 1); } catch { return false; }
  }
  if (Array.isArray(content)) return content.some(part => messageContainsExactText(part, text, depth + 1));
  if (!content || typeof content !== "object") return false;
  const value = content as Record<string, unknown>;
  return [value.text, value.content, value.message].some(part => part !== undefined && messageContainsExactText(part, text, depth + 1));
}
