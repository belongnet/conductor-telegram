import test from "node:test";
import Database from "better-sqlite3";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ConductorApiMessage,
  ConductorApiSession,
  ConductorApiWorkspace,
} from "../src/integrations/conductor-api.js";
import { ConductorApiError } from "../src/integrations/conductor-api.js";
import {
  LaneController,
  type ConductorLaneGateway,
  type GithubLaneGateway,
} from "../src/lanes/controller.js";
import {
  parseLaneManifest,
  type ManifestProvider,
} from "../src/lanes/manifest.js";
import { SqliteLaneStateStore } from "../src/lanes/state-store-sqlite.js";
import { LaneStateStoreError, type LaneStateStore } from "../src/lanes/state-store.js";
import type {
  GithubCommitChecksSnapshot,
  GithubPrPolicySnapshot,
} from "../src/bot/github.js";
import { LANE_ACTION_SETTLE_SECONDS } from "../src/lanes/controller-policy.js";
import type { CheckObservation } from "../src/lanes/check-evidence.js";

const HEAD = "1".repeat(40);
const UPDATED_HEAD = "3".repeat(40);
const FINAL_HEAD = "4".repeat(40);
const MERGED = "2".repeat(40);
const PR_URL = "https://github.com/belongnet/example/pull/7";
const MR_URL = "https://gitlab.com/belongnet/example/-/merge_requests/7";

class FakeConductor implements ConductorLaneGateway {
  readonly mutations: string[] = [];
  readonly workspaces: ConductorApiWorkspace[] = [];
  readonly sessions = new Map<string, ConductorApiSession[]>();
  readonly messages = new Map<string, ConductorApiMessage[]>();
  archived = new Set<string>();
  readonly workingSessions = new Set<string>();
  /** The project's remote, and the pull request an implementation reports. */
  gitRemote = "https://github.com/belongnet/example";
  deliveryUrl = PR_URL;
  private sequence = 0;
  private archiveSafeReadsRemaining: number | null = null;

  constructor(
    private readonly store: LaneStateStore,
    private readonly failWorkspaceFor: ReadonlySet<ManifestProvider> = new Set(),
    private readonly stallMessages = false,
    private readonly validationFails = false,
    private readonly validationReceiptMode:
      | "command_execution"
      | "bash_tool"
      | "missing"
      | "substituted"
      | "extra" = "command_execution",
    private readonly dropReplies = false,
    private readonly reverseTranscriptReads = false
  ) {}

  private async assertIntent(type: string, provider?: string): Promise<void> {
    const snapshot = await this.store.snapshot();
    const action = snapshot.pending_actions.find(
      (candidate) => candidate.action_type === type
    );
    assert.ok(
      action,
      `${type} mutation must have a durable pending intent`
    );
    assert.ok(
      Date.parse(String(snapshot.lease?.expires_at ?? "")) - Date.now() > 60_000,
      `${type} mutation must begin inside a freshly renewed 75-second fence`
    );
    if (provider) {
      assert.ok(action.attempt_id, `${type} must be tied to a reserved attempt`);
      assert.ok(
        (snapshot.capacity[provider]?.active ?? 0) >= 1,
        `${type} must occur only after ${provider} capacity is reserved`
      );
    }
    this.mutations.push(type);
  }

  async listProjects() {
    return [
      {
        id: "project-1",
        name: "example",
        gitRemote: this.gitRemote,
      },
    ];
  }

  async listProjectWorkspaces() {
    return this.workspaces;
  }

  async listWorkspaces(options: { name?: string; includeArchived?: boolean } = {}) {
    return this.workspaces.filter(
      (workspace) =>
        (!options.name || workspace.name.includes(options.name)) &&
        (options.includeArchived || !this.archived.has(workspace.id))
    );
  }

  async getWorkspace(workspaceId: string) {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new ConductorApiError("missing", 404);
    return { ...workspace, archivedAt: this.archived.has(workspaceId) ? new Date().toISOString() : null };
  }

  async getWorkspaceStatus(workspaceId: string) {
    await this.getWorkspace(workspaceId);
    return {
      workspaceId,
      status: this.archived.has(workspaceId) ? ("archived" as const) : ("ready" as const),
      updatedAt: new Date().toISOString(),
    };
  }

  async listWorkspaceSessions(workspaceId: string) {
    return this.sessions.get(workspaceId) ?? [];
  }

  async getSessionStatus(sessionId: string) {
    let status: "idle" | "working" = this.workingSessions.has(sessionId)
      ? "working"
      : "idle";
    if (this.archiveSafeReadsRemaining !== null) {
      if (this.archiveSafeReadsRemaining > 0) {
        this.archiveSafeReadsRemaining -= 1;
      } else {
        status = "working";
      }
    }
    return {
      workspaceId: this.workspaceForSession(sessionId),
      sessionId,
      status,
      updatedAt: new Date().toISOString(),
    };
  }

  armArchivePreflightRace(): void {
    this.archiveSafeReadsRemaining = [...this.sessions.values()]
      .flat()
      .filter((session) => !session.archivedAt).length;
  }

  disarmArchivePreflightRace(): void {
    this.archiveSafeReadsRemaining = null;
  }

  setSessionWorking(sessionId: string, working: boolean): void {
    if (working) this.workingSessions.add(sessionId);
    else this.workingSessions.delete(sessionId);
  }

  async getSessionMessageTail(sessionId: string, limit: number) {
    const messages = (this.messages.get(sessionId) ?? []).slice(-limit);
    return this.reverseTranscriptReads ? messages.reverse() : messages;
  }

  async getMessage(messageId: string) {
    for (const messages of this.messages.values()) {
      const message = messages.find((candidate) => candidate.id === messageId);
      if (message) return message;
    }
    throw new ConductorApiError("message missing", 404);
  }

  async createWorkspace(input: {
    projectId: string;
    branch?: string;
    name?: string;
    sessionName?: string;
    agent?: "claude" | "codex" | "cursor";
    model?: string;
  }) {
    await this.assertIntent("create_workspace", input.agent);
    if (input.agent && this.failWorkspaceFor.has(input.agent)) {
      throw new ConductorApiError(`${input.agent} quota exceeded`, 429);
    }
    const workspaceId = `workspace-${++this.sequence}`;
    const sessionId = `session-${++this.sequence}`;
    const workspace: ConductorApiWorkspace = {
      id: workspaceId,
      name: input.name!,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      deepLink: `conductor://workspace/${workspaceId}`,
      archivedAt: null,
    };
    const session: ConductorApiSession = {
      id: sessionId,
      name: input.sessionName,
      deepLink: `conductor://session/${sessionId}`,
      createdAt: new Date().toISOString(),
      model: input.model,
      archivedAt: null,
    };
    this.workspaces.push(workspace);
    this.sessions.set(workspaceId, [session]);
    this.messages.set(sessionId, []);
    return { workspaceId, sessionId, deepLink: workspace.deepLink };
  }

  async createSession(input: {
    workspaceId: string;
    name?: string;
    agent: "claude" | "codex" | "cursor";
    model?: string;
  }) {
    await this.assertIntent("create_session", input.agent);
    const session: ConductorApiSession = {
      id: `session-${++this.sequence}`,
      name: input.name,
      deepLink: `conductor://session/${this.sequence}`,
      createdAt: new Date().toISOString(),
      model: input.model,
      archivedAt: null,
    };
    const sessions = this.sessions.get(input.workspaceId) ?? [];
    sessions.push(session);
    this.sessions.set(input.workspaceId, sessions);
    this.messages.set(session.id, []);
    return session;
  }

  async sendMessage(input: { sessionId: string; message: string; messageId: string }) {
    const snapshot = await this.store.snapshot();
    const action = snapshot.pending_actions.find(
      (candidate) => candidate.request_json.message_id === input.messageId
    );
    assert.ok(action, "message mutation must have its exact durable intent");
    const attempt = snapshot.attempts.find(
      (candidate) => candidate.attempt_id === action.attempt_id
    );
    assert.ok(attempt, "message mutation must retain its provider reservation");
    assert.ok((snapshot.capacity[attempt.provider]?.active ?? 0) >= 1);
    this.mutations.push(action.action_type);
    const messages = this.messages.get(input.sessionId) ?? [];
    messages.push({
      id: input.messageId,
      sessionId: input.sessionId,
      sessionIndex: messages.length,
      type: "user",
      content: input.message,
      receivedAt: new Date().toISOString(),
    });
    if (this.dropReplies) {
      this.messages.set(input.sessionId, messages);
      return { messageId: input.messageId, state: "sent" as const };
    }
    const identity = (key: string) =>
      input.message.match(new RegExp(`"${key}":"([^"]+)"`))?.[1] ?? "";
    let response = this.stallMessages
      ? `progress without terminal result ${this.sequence}:${messages.length}`
      : this.deliveryUrl;
    if (input.message.includes("ADVERSARIAL-REVIEW")) {
      const model = input.message.match(/ADVERSARIAL-REVIEW \(([^)]+)\)/)?.[1];
      response = `ADVERSARIAL-REVIEW (${model}): ${JSON.stringify({
        verdict: "approve",
        nonce: identity("nonce"),
        run: identity("run"),
        stage: "review",
        headSha: identity("headSha"),
        provider: identity("provider"),
        summary: "reviewed",
        blocking: [],
      })}`;
    } else if (input.message.includes("FINAL-REVIEW")) {
      const model = input.message.match(/FINAL-REVIEW \(([^)]+)\)/)?.[1];
      response = `FINAL-REVIEW (${model}): ${JSON.stringify({
        verdict: "approve",
        nonce: identity("nonce"),
        run: identity("run"),
        stage: "final",
        headSha: identity("headSha"),
        provider: identity("provider"),
        summary: "final approved",
        blocking: [],
      })}`;
    } else if (input.message.includes("VALIDATED (")) {
      const model = input.message.match(/VALIDATED \(([^)]+)\)/)?.[1];
      const receiptCommands = [
        `git fetch --quiet origin ${MERGED}`,
        `git checkout --quiet --detach ${MERGED}`,
        `test "$(git rev-parse HEAD)" = ${MERGED}`,
        `test -z "$(git status --porcelain --untracked-files=all)"`,
        this.validationReceiptMode === "substituted" ? "npm run test" : "npm test",
      ];
      if (
        this.validationReceiptMode === "command_execution" ||
        this.validationReceiptMode === "substituted" ||
        this.validationReceiptMode === "extra"
      ) {
        for (const [index, command] of receiptCommands.entries()) {
          const failed = this.validationFails && index === receiptCommands.length - 1;
          messages.push({
            id: `tool-${++this.sequence}`,
            sessionId: input.sessionId,
            sessionIndex: messages.length,
            type: "agent",
            content: {
              event: {
                item: {
                  type: "commandExecution",
                  id: `execution-${this.sequence}`,
                  command,
                  status: failed ? "failed" : "completed",
                  exitCode: failed ? 1 : 0,
                },
              },
            },
            receivedAt: new Date().toISOString(),
          });
        }
        if (this.validationReceiptMode === "extra") {
          messages.push({
            id: `tool-${++this.sequence}`,
            sessionId: input.sessionId,
            sessionIndex: messages.length,
            type: "agent",
            content: {
              event: {
                item: {
                  type: "commandExecution",
                  id: `execution-${this.sequence}`,
                  command: "git status --short",
                  status: "completed",
                  exitCode: 0,
                },
              },
            },
            receivedAt: new Date().toISOString(),
          });
        }
      } else if (this.validationReceiptMode === "bash_tool") {
        for (const [index, command] of receiptCommands.entries()) {
          const failed = this.validationFails && index === receiptCommands.length - 1;
          const toolId = `bash-${++this.sequence}`;
          messages.push({
            id: `tool-use-${this.sequence}`,
            sessionId: input.sessionId,
            sessionIndex: messages.length,
            type: "agent",
            content: {
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: toolId,
                    name: "Bash",
                    input: { command },
                  },
                ],
              },
            },
            receivedAt: new Date().toISOString(),
          });
          messages.push({
            id: `tool-result-${++this.sequence}`,
            sessionId: input.sessionId,
            sessionIndex: messages.length,
            type: "user",
            content: {
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: toolId,
                    is_error: failed,
                    content: failed ? "failed" : "passed",
                  },
                ],
              },
            },
            receivedAt: new Date().toISOString(),
          });
        }
      }
      response = `${this.validationFails ? "VALIDATION FAILED" : "VALIDATED"} (${model}): ${JSON.stringify({
        nonce: identity("nonce"),
        run: identity("run"),
        stage: "validation",
        headSha: identity("headSha"),
        mergedSha: MERGED,
        provider: identity("provider"),
        passed: !this.validationFails,
        commands: [
          { argv: ["npm", "test"], exit_code: this.validationFails ? 1 : 0 },
        ],
        probes: [],
      })}`;
    }
    messages.push({
      id: `assistant-${++this.sequence}`,
      sessionId: input.sessionId,
      sessionIndex: messages.length,
      type: "assistant",
      content: response,
      receivedAt: new Date().toISOString(),
    });
    this.messages.set(input.sessionId, messages);
    return { messageId: input.messageId, state: "sent" as const };
  }

  async archiveWorkspace(workspaceId: string) {
    await this.assertIntent("archive_workspace");
    this.archived.add(workspaceId);
    return { workspaceId, status: "archived" as const };
  }

  private workspaceForSession(sessionId: string): string {
    for (const [workspaceId, sessions] of this.sessions) {
      if (sessions.some((session) => session.id === sessionId)) return workspaceId;
    }
    throw new ConductorApiError("session missing", 404);
  }
}

class FakeGithub implements GithubLaneGateway {
  readonly mutations: string[] = [];
  readonly reviews: GithubPrPolicySnapshot["reviews"] = [];
  readonly comments: string[] = [];
  merged = false;
  headSha = HEAD;
  headBranch = "managed/example";
  baseBranch = "main";
  prUrl = PR_URL;
  private loseReviewResponseOnce: boolean;

  constructor(
    private readonly store: LaneStateStore,
    private readonly loseMergeResponse = false,
    loseReviewResponseOnce = false
  ) {
    this.loseReviewResponseOnce = loseReviewResponseOnce;
  }

  async refreshPr(): Promise<GithubPrPolicySnapshot> {
    return {
      url: this.prUrl,
      repoOwner: "belongnet",
      repoName: "example",
      prNumber: 7,
      state: this.merged ? "merged" : "open",
      isDraft: false,
      headBranch: this.headBranch,
      baseBranch: this.baseBranch,
      headSha: this.headSha,
      reviewDecision: null,
      mergeStateStatus: this.mergeStateStatus,
      mergeable: "MERGEABLE",
      checksStatus: "passing",
      checksSummary: "green",
      mergeCommitSha: this.merged ? MERGED : null,
      reviews: [...this.reviews],
    };
  }

  commitChecks?: GithubCommitChecksSnapshot["checks"];
  commitChecksStatus: GithubCommitChecksSnapshot["status"] = "passing";
  /** Answers every commit-check read as if for this commit instead. */
  commitChecksAnswerSha?: string;
  readonly commitCheckReads: string[] = [];
  readonly commitCheckRepositories: string[] = [];
  mergeStateStatus = "CLEAN";

  async refreshCommitChecks(input: {
    repoOwner: string;
    repoName: string;
    sha: string;
  }): Promise<GithubCommitChecksSnapshot> {
    this.commitCheckReads.push(input.sha);
    this.commitCheckRepositories.push(`${input.repoOwner}/${input.repoName}`.toLowerCase());
    return {
      repoOwner: input.repoOwner.toLowerCase(),
      repoName: input.repoName.toLowerCase(),
      sha: this.commitChecksAnswerSha ?? input.sha,
      status: this.commitChecksStatus,
      summary: this.commitChecksStatus === "passing" ? "green" : this.commitChecksStatus,
      ...(this.commitChecks ? { checks: this.commitChecks } : {}),
    };
  }

  async postReview(_prUrl: string, body: string, expectedHeadSha: string) {
    await this.assertIntent("post_attestation");
    this.reviews.push({
      body,
      state: "COMMENTED",
      submittedAt: new Date().toISOString(),
      commitSha: expectedHeadSha,
    });
    if (this.loseReviewResponseOnce) {
      this.loseReviewResponseOnce = false;
      throw new Error("review response timed out after publication");
    }
    return { reviewId: `review-${this.reviews.length}`, body, commitSha: expectedHeadSha };
  }

  async postComment(_prUrl: string, body: string): Promise<void> {
    await this.assertIntent("post_notice");
    this.comments.push(body);
  }

  async hasCommentTag(
    _prUrl: string,
    tag: string,
    expectedBodyHash?: string
  ): Promise<boolean> {
    return this.comments.some(
      (comment) =>
        comment.includes(tag) &&
        (!expectedBodyHash ||
          createHash("sha256").update(comment).digest("hex") ===
            expectedBodyHash)
    );
  }

  async merge(): Promise<{ mergedSha: string }> {
    await this.assertIntent("merge_pr");
    this.merged = true;
    this.mutations.push("merge_pr");
    if (this.loseMergeResponse) throw new Error("merge response timed out");
    return { mergedSha: MERGED };
  }

  private async assertIntent(type: string): Promise<void> {
    const snapshot = await this.store.snapshot();
    assert.ok(
      snapshot.pending_actions.some((action) => action.action_type === type),
      `${type} GitHub mutation must have a durable pending intent`
    );
    assert.ok(
      Date.parse(String(snapshot.lease?.expires_at ?? "")) - Date.now() > 60_000,
      `${type} GitHub mutation must begin inside a freshly renewed fence`
    );
    this.mutations.push(type);
  }
}

class FakeGitlabCi implements GithubLaneGateway {
  readonly reads: Array<{ projectPath: string; sha: string; ref?: string; baseBranch?: string; expectedMrIid?: number }> = [];
  status: CheckObservation["status"] = "passing";
  /** The last run of each of the pipeline's jobs. */
  jobs: CheckObservation["checks"] = [];
  /** Answers every pipeline read as if for this commit instead. */
  answerSha?: string;
  /** The canonical project has run no pipeline for the commit. */
  missing = false;
  /** Like GitLab, the newest pipeline for a commit keeps its id from read to read. */
  private readonly pipelineIds = new Map<string, number>();

  async commitPipeline(input: {
    projectPath: string;
    sha: string;
    ref?: string;
    baseBranch?: string;
    expectedMrIid?: number;
  }): Promise<CheckObservation> {
    this.reads.push({ ...input });
    const sha = this.answerSha ?? input.sha;
    if (this.missing) {
      return {
        source: "gitlab",
        projectPath: input.projectPath,
        sha,
        pipelineId: null,
        status: "pending",
        summary: `no GitLab pipeline for ${sha.slice(0, 12)}`,
        checks: [],
      };
    }
    const pipelineId = this.pipelineIds.get(sha) ?? 800 + this.pipelineIds.size;
    this.pipelineIds.set(sha, pipelineId);
    return {
      source: "gitlab",
      projectPath: input.projectPath,
      sha,
      pipelineId,
      status: this.status,
      summary: `GitLab pipeline ${this.status}`,
      checks: this.jobs,
    };
  }

  private unused(): never {
    throw new Error("canonical CI evidence never delivers through GitLab");
  }
  async refreshPr(): Promise<GithubPrPolicySnapshot> {
    return this.unused();
  }
  async refreshCommitChecks(): Promise<GithubCommitChecksSnapshot> {
    return this.unused();
  }
  async postReview(): Promise<{ reviewId: string; body: string; commitSha: string }> {
    return this.unused();
  }
  async postComment(): Promise<void> {
    return this.unused();
  }
  async hasCommentTag(): Promise<boolean> {
    return this.unused();
  }
  async merge(): Promise<{ mergedSha: string }> {
    return this.unused();
  }
}

/** A GitLab-delivered lane: its merge request, and its project's pipelines. */
class FakeGitlabDelivery extends FakeGithub {
  readonly ci = new FakeGitlabCi();

  constructor(store: LaneStateStore) {
    super(store);
    this.prUrl = MR_URL;
  }

  async commitPipeline(input: {
    projectPath: string;
    sha: string;
    ref?: string;
    baseBranch?: string;
    expectedMrIid?: number;
  }): Promise<CheckObservation> {
    return this.ci.commitPipeline(input);
  }
}

function canaryFixture(
  deliveryAdapter: Record<string, unknown> = { kind: "github" }
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-canary-"));
  const promptPath = path.join(root, "prompt.md");
  fs.writeFileSync(promptPath, "Implement the disposable canary.\n");
  const promptHash = createHash("sha256")
    .update(fs.readFileSync(promptPath))
    .digest("hex");
  const manifest = parseLaneManifest(
    {
      version: 2,
      global: {
        provider_capacity: { claude: 3, codex: 2, cursor: 2 },
        provider_models: {
          claude: "fable-5-1",
          codex: "gpt-6-astra",
          cursor: "grok-4.7",
        },
      },
      lanes: [
        {
          id: "CANARY",
          title: "Disposable canary",
          repository: { owner: "belongnet", name: "example", base_branch: "main" },
          prompt: { path: "prompt.md", sha256: promptHash },
          priority: 100,
          preferred_providers: ["claude", "codex", "cursor"],
          fallback_providers: [],
          dependencies: [],
          policy: { kind: "one_shot" },
          delivery_adapter: deliveryAdapter,
          merge_policy: {
            method: "squash",
            auto_merge: true,
            deploy_notes: "none",
            replay_notes: "none",
          },
          validation_profile: { commands: [["npm", "test"]], probes: [] },
          managed_tags: ["managed:growth", "lane:CANARY"],
        },
      ],
    },
    path.join(root, "manifest.json")
  );
  return { root, promptPath, manifest };
}

test("a lost pause-control response is recovered with one stable safety-alert identity", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await store.claimLease({
      ownerId: "mac:lost-pause-response",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    let snapshot = await store.snapshot();
    const cutover = await store.createControl({
      control_id: "control-lost-pause-cutover",
      idempotency_key: "control-lost-pause-cutover",
      kind: "cutover",
      requested_by: "human:test",
      payload: { revision_id: "canary-v2" },
      approvalKey: "separate-human-key",
    });
    await store.finishControl(lease, cutover.control_id, {
      expected_version: cutover.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
    });
    await store.createControl({
      control_id: "control-lost-pause",
      idempotency_key: "control-lost-pause",
      kind: "pause",
      requested_by: "lane-controller",
      payload: { reason: "simulated safety condition" },
    });

    let dropped = false;
    const lossyStore = new Proxy(store, {
      get(target, property) {
        if (property === "finishControl") {
          return async (
            actionLease: Parameters<LaneStateStore["finishControl"]>[0],
            controlId: Parameters<LaneStateStore["finishControl"]>[1],
            input: Parameters<LaneStateStore["finishControl"]>[2]
          ) => {
            const result = await target.finishControl(actionLease, controlId, input);
            if (controlId === "control-lost-pause" && !dropped) {
              dropped = true;
              throw new Error("simulated lost pause response after commit");
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as LaneStateStore;
    const alerts: Array<{ message: string; key: string }> = [];
    const controller = new LaneController({
      store: lossyStore,
      conductor: new FakeConductor(lossyStore),
      github: new FakeGithub(lossyStore),
      notify: async (message, key) => {
        alerts.push({ message, key });
      },
    });

    await assert.rejects(
      controller.tick({ lease, manifest }),
      /lost pause response after commit/
    );
    assert.equal(alerts.length, 0);
    snapshot = await store.snapshot();
    assert.equal(snapshot.controller?.mode, "paused_safety");
    assert.match(snapshot.controller?.reason ?? "", /\[control:control-lost-pause\]/);

    await controller.tick({ lease, manifest });
    await controller.tick({ lease, manifest });
    assert.equal(alerts.length, 2);
    assert.equal(alerts[0]?.key, alerts[1]?.key);
    assert.match(alerts[0]?.key ?? "", /^safety-state:[0-9a-f]{64}$/);
    assert.equal(
      alerts[0]?.message,
      "Growth lanes paused for safety: simulated safety condition"
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("disposable canary traverses create → review → two finals → merge → validation → archive", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  let clock = new Date();
  const receiptsToDrop = new Set([
    "post_attestation",
    "post_notice",
    "archive_workspace",
  ]);
  const droppedReceipts = new Set<string>();
  const observedDroppedReceipts = new Set<string>();
  const actionTagsByType = new Map<string, Set<string>>();
  try {
    const lease = await store.claimLease({
      ownerId: "mac:canary",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    const control = await store.createControl({
      control_id: "control-cutover",
      idempotency_key: "canary-cutover",
      kind: "cutover",
      requested_by: "human:test",
      payload: { revision_id: "canary-v2" },
      approvalKey: "separate-human-key",
    });
    const snapshot = await store.snapshot();
    await store.finishControl(lease, control.control_id, {
      expected_version: control.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
      result: { canary: true },
    });

    const lossyStore = new Proxy(store, {
      get(target, property) {
        if (property === "beginAction") {
          return async (
            actionLease: Parameters<LaneStateStore["beginAction"]>[0],
            runId: Parameters<LaneStateStore["beginAction"]>[1],
            input: Parameters<LaneStateStore["beginAction"]>[2]
          ) => {
            const tags = actionTagsByType.get(input.action_type) ?? new Set();
            tags.add(input.deterministic_tag);
            actionTagsByType.set(input.action_type, tags);
            return target.beginAction(actionLease, runId, input);
          };
        }
        if (property === "finishAction") {
          return async (
            actionLease: Parameters<LaneStateStore["finishAction"]>[0],
            actionId: Parameters<LaneStateStore["finishAction"]>[1],
            input: Parameters<LaneStateStore["finishAction"]>[2]
          ) => {
            const actionSnapshot = await target.snapshot();
            const action = [
              ...actionSnapshot.pending_actions,
              ...actionSnapshot.ambiguous_actions,
            ].find((candidate) => candidate.action_id === actionId);
            const result = await target.finishAction(actionLease, actionId, input);
            if (
              action &&
              receiptsToDrop.has(action.action_type) &&
              !droppedReceipts.has(action.action_type) &&
              input.status === "succeeded"
            ) {
              droppedReceipts.add(action.action_type);
              throw new Error("simulated lost Command Center response after commit");
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as LaneStateStore;
    const conductor = new FakeConductor(
      lossyStore,
      new Set(),
      false,
      false,
      "command_execution",
      false,
      true
    );
    const github = new FakeGithub(lossyStore);
    const controller = new LaneController({
      store: lossyStore,
      conductor,
      github,
      now: () => clock,
    });
    let validated = false;
    let changedHead = false;
    let changedAfterFinals = false;
    for (let tick = 0; tick < 160; tick += 1) {
      let result: Awaited<ReturnType<LaneController["tick"]>>;
      try {
        result = await controller.tick({
          lease,
          manifest,
          fullReconcile: tick % 15 === 0,
        });
      } catch (error) {
        const unseen = [...droppedReceipts].find(
          (actionType) => !observedDroppedReceipts.has(actionType)
        );
        if (unseen) {
          observedDroppedReceipts.add(unseen);
          continue;
        }
        throw error;
      }
      const state = await store.snapshot();
      if (
        !changedHead &&
        state.attempts.some(
          (attempt) =>
            attempt.role === "review" &&
            attempt.head_sha === HEAD &&
            attempt.status === "completed"
        )
      ) {
        github.headSha = UPDATED_HEAD;
        changedHead = true;
      }
      if (
        changedHead &&
        !changedAfterFinals &&
        state.attempts.filter(
          (attempt) =>
            attempt.role === "final" &&
            attempt.head_sha === UPDATED_HEAD &&
            attempt.status === "completed"
        ).length === 2
      ) {
        github.headSha = FINAL_HEAD;
        changedAfterFinals = true;
      }
      if (state.runs[0]?.status === "merging" && !github.merged) {
        assert.equal(github.mutations.includes("merge_pr"), false);
        github.merged = true; // The operator merges after the worker reaches the hold.
      }
      if (state.runs[0]?.status === "validated") {
        validated = true;
        break;
      }
      assert.ok(result.acted || result.active, `controller stalled at tick ${tick}: ${result.reason}`);
    }
    assert.equal(validated, true);
    const state = await store.snapshot();
    const run = state.runs[0];
    assert.equal(changedHead, true);
    assert.equal(changedAfterFinals, true);
    assert.equal(run.pr_url, PR_URL);
    assert.equal(run.head_sha, FINAL_HEAD);
    assert.equal(run.merged_sha, MERGED);
    const finals = state.attempts.filter(
      (attempt) => attempt.role === "final" && attempt.status === "completed"
    );
    assert.equal(finals.length, 2);
    assert.ok(
      state.attempts.some(
        (attempt) =>
          attempt.role === "review" &&
          attempt.head_sha === HEAD &&
          attempt.status === "superseded"
      ),
      "a new commit must explicitly supersede completed old-head attestations"
    );
    assert.ok(
      state.attempts.some(
        (attempt) =>
          attempt.role === "final" &&
          attempt.head_sha === UPDATED_HEAD &&
          attempt.status === "superseded"
      ),
      "a head change after finals must roll back to review and supersede both finals"
    );
    assert.ok(
      state.attempts.some(
        (attempt) =>
          attempt.role === "review" &&
          attempt.head_sha === FINAL_HEAD &&
          attempt.status === "completed"
      ),
      "the new final head must receive a fresh adversarial review"
    );
    assert.equal(new Set(finals.map((attempt) => attempt.provider)).size, 2);
    const validation = state.attempts.find((attempt) => attempt.role === "validation");
    assert.notEqual(validation?.provider, run.author_provider);
    assert.equal(validation?.result_json.source, "conductor_tool_events");
    assert.deepEqual(
      (validation?.result_json.receipts as Array<Record<string, unknown>>)?.map(
        (receipt) => [receipt.command, receipt.exit_code]
      ),
      [
        [`git fetch --quiet origin ${MERGED}`, 0],
        [`git checkout --quiet --detach ${MERGED}`, 0],
        [`test "$(git rev-parse HEAD)" = ${MERGED}`, 0],
        [`test -z "$(git status --porcelain --untracked-files=all)"`, 0],
        ["npm test", 0],
      ]
    );
    assert.equal(github.merged, true);
    assert.equal(state.duplicates.length, 0);
    assert.ok(observedDroppedReceipts.has("post_attestation"));
    const attestationTags = github.reviews.map(
      (review) => review.body.match(/\[lane-attestation:[^\]]+\]/)?.[0]
    );
    assert.equal(
      new Set(attestationTags).size,
      attestationTags.length,
      "a lost state response must not duplicate an already-persisted Git-host review"
    );

    clock = new Date(clock.getTime() + 2 * 60 * 60 * 1000);
    for (let tick = 0; tick < 10 && conductor.archived.size === 0; tick += 1) {
      try {
        await controller.tick({ lease, manifest });
      } catch (error) {
        const unseen = [...droppedReceipts].find(
          (actionType) => !observedDroppedReceipts.has(actionType)
        );
        if (unseen) {
          observedDroppedReceipts.add(unseen);
          continue;
        }
        throw error;
      }
    }
    assert.equal(conductor.archived.size, 1);
    assert.deepEqual(
      [...observedDroppedReceipts].sort(),
      [...receiptsToDrop].sort()
    );
    assert.equal(github.comments.length, 1);
    assert.equal(
      actionTagsByType.get("post_notice")?.size,
      1,
      "a lost durable result reply must reuse the same logical action tag"
    );
    assert.equal(
      conductor.mutations.filter((mutation) => mutation === "archive_workspace").length,
      1
    );
    assert.ok(conductor.mutations.includes("create_workspace"));
    assert.ok(conductor.mutations.includes("archive_workspace"));
    assert.ok(github.mutations.includes("post_attestation"));
    assert.equal(github.mutations.includes("merge_pr"), false);
    assert.match(github.comments[0] ?? "", /^MERGED BY AGENTS/m);
    assert.match(github.comments[0] ?? "", /Copy\/product notes:\n- /);
    assert.match(github.comments[0] ?? "", /Deployment notes: none/);
    assert.match(github.comments[0] ?? "", /Replay notes: none/);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive rechecks sessions after intent and recovers with fresh evidence", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  let clock = new Date();
  try {
    const lease = await store.claimLease({
      ownerId: "mac:archive-preflight",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    const cutover = await store.createControl({
      control_id: "control-archive-preflight-cutover",
      idempotency_key: "archive-preflight-cutover",
      kind: "cutover",
      requested_by: "human:test",
      payload: { revision_id: "canary-v2" },
      approvalKey: "separate-human-key",
    });
    let snapshot = await store.snapshot();
    await store.finishControl(lease, cutover.control_id, {
      expected_version: cutover.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
    });
    const conductor = new FakeConductor(store);
    const github = new FakeGithub(store);
    const controller = new LaneController({
      store,
      conductor,
      github,
      now: () => clock,
    });
    snapshot = await tickUntil(controller, store, lease, manifest, "validated", 100, github);
    assert.equal(snapshot.runs[0]?.status, "validated");

    clock = new Date(clock.getTime() + 2 * 60 * 60 * 1000);
    conductor.armArchivePreflightRace();
    const raced = await controller.tick({ lease, manifest });
    snapshot = await store.snapshot();
    assert.equal(raced.reason, "paused on archive preflight race");
    assert.equal(snapshot.controller?.mode, "paused_safety");
    assert.equal(conductor.archived.size, 0);
    assert.equal(
      conductor.mutations.filter(
        (mutation) => mutation === "archive_workspace"
      ).length,
      0,
      "the mutation must not begin when the second preflight observes work"
    );

    conductor.disarmArchivePreflightRace();
    await store.createControl({
      control_id: "control-archive-preflight-resume",
      idempotency_key: "archive-preflight-resume",
      kind: "resume",
      requested_by: "operator:test",
    });
    await controller.tick({ lease, manifest });
    for (let tick = 0; tick < 5 && conductor.archived.size === 0; tick += 1) {
      await controller.tick({ lease, manifest });
    }
    assert.equal(conductor.archived.size, 1);
    assert.equal((await store.snapshot()).controller?.mode, "active");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prompt bytes are rehashed immediately before commissioned delivery", async () => {
  const { root, promptPath, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await store.claimLease({
      ownerId: "mac:prompt-integrity",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    const cutover = await store.createControl({
      control_id: "control-prompt-integrity-cutover",
      idempotency_key: "prompt-integrity-cutover",
      kind: "cutover",
      requested_by: "human:test",
      payload: { revision_id: "canary-v2" },
      approvalKey: "separate-human-key",
    });
    let snapshot = await store.snapshot();
    await store.finishControl(lease, cutover.control_id, {
      expected_version: cutover.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
    });
    const conductor = new FakeConductor(store);
    const controller = new LaneController({
      store,
      conductor,
      github: new FakeGithub(store),
    });

    for (let tick = 0; tick < 10; tick += 1) {
      await controller.tick({ lease, manifest });
      snapshot = await store.snapshot();
      if (
        snapshot.attempts.some(
          (attempt) =>
            attempt.role === "implementation" &&
            attempt.status === "commissioned" &&
            Boolean(attempt.session_id)
        )
      ) {
        break;
      }
    }
    fs.writeFileSync(promptPath, "silently changed after activation\n");
    const result = await controller.tick({ lease, manifest });
    snapshot = await store.snapshot();
    assert.equal(result.reason, "paused on prompt integrity drift");
    assert.equal(snapshot.controller?.mode, "paused_safety");
    assert.equal(conductor.mutations.includes("send_prompt"), false);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a PR URL is not bound until the author session is idle", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await store.claimLease({
      ownerId: "mac:terminal-author",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    const cutover = await store.createControl({
      control_id: "control-terminal-author-cutover",
      idempotency_key: "terminal-author-cutover",
      kind: "cutover",
      requested_by: "human:test",
      payload: { revision_id: "canary-v2" },
      approvalKey: "separate-human-key",
    });
    let snapshot = await store.snapshot();
    await store.finishControl(lease, cutover.control_id, {
      expected_version: cutover.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
    });
    const conductor = new FakeConductor(store);
    const controller = new LaneController({
      store,
      conductor,
      github: new FakeGithub(store),
    });

    for (let tick = 0; tick < 12; tick += 1) {
      await controller.tick({ lease, manifest });
      snapshot = await store.snapshot();
      if (conductor.mutations.includes("send_prompt")) break;
    }
    const run = snapshot.runs[0]!;
    assert.ok(run.session_id);
    conductor.setSessionWorking(run.session_id, true);
    await controller.tick({ lease, manifest });
    snapshot = await store.snapshot();
    assert.equal(snapshot.runs[0]?.status, "implementing");
    assert.equal(snapshot.runs[0]?.pr_url, null);

    conductor.setSessionWorking(run.session_id, false);
    await controller.tick({ lease, manifest });
    snapshot = await store.snapshot();
    assert.equal(snapshot.runs[0]?.status, "pr_bound");
    assert.equal(snapshot.runs[0]?.pr_url, PR_URL);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shadow reconciliation observes projects without dispatching", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await store.claimLease({
      ownerId: "mac:shadow",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    const control = await store.createControl({
      control_id: "control-shadow",
      idempotency_key: "control-shadow",
      kind: "shadow",
      requested_by: "telegram:test",
      payload: { revision_id: "canary-v2" },
    });
    let snapshot = await store.snapshot();
    await store.finishControl(lease, control.control_id, {
      expected_version: control.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
    });
    const conductor = new FakeConductor(store);
    const controller = new LaneController({
      store,
      conductor,
      github: new FakeGithub(store),
    });
    const result = await controller.tick({
      lease,
      manifest,
      fullReconcile: true,
    });
    snapshot = await store.snapshot();
    assert.equal(result.acted, false);
    assert.equal(result.fullReconcileComplete, true);
    assert.match(result.reason, /^shadow comparison /);
    assert.match(result.reason, /"missing_projects":0/);
    assert.equal(snapshot.runs.length, 0);
    assert.deepEqual(conductor.mutations, []);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("active full reconciliation pauses on duplicate live managed workspaces", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await store.claimLease({
      ownerId: "mac:active-inventory",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    const cutover = await store.createControl({
      control_id: "control-active-inventory",
      idempotency_key: "control-active-inventory",
      kind: "cutover",
      requested_by: "human:test",
      payload: { revision_id: "canary-v2" },
      approvalKey: "separate-human-key",
    });
    let snapshot = await store.snapshot();
    await store.finishControl(lease, cutover.control_id, {
      expected_version: cutover.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
    });
    const conductor = new FakeConductor(store);
    const controller = new LaneController({
      store,
      conductor,
      github: new FakeGithub(store),
    });
    await controller.tick({ lease, manifest });
    await controller.tick({ lease, manifest });
    await controller.tick({ lease, manifest });
    snapshot = await store.snapshot();
    const run = snapshot.runs[0]!;
    const attempt = snapshot.attempts.find(
      (candidate) => candidate.run_id === run.run_id
    )!;
    const duplicateName =
      `[managed:growth][lane:CANARY][run:${run.run_id}]` +
      `[stage:${attempt.stage}][attempt:${attempt.attempt_number}] Disposable canary`;
    for (const id of ["workspace-duplicate-a", "workspace-duplicate-b"]) {
      conductor.workspaces.push({
        id,
        name: duplicateName,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        deepLink: `conductor://workspace/${id}`,
        state: "ready",
        archivedAt: null,
      });
    }

    const result = await controller.tick({
      lease,
      manifest,
      fullReconcile: true,
    });
    snapshot = await store.snapshot();
    assert.equal(result.reason, "paused on Conductor workspace inventory drift");
    assert.notEqual(result.fullReconcileComplete, true);
    assert.equal(snapshot.controller?.mode, "paused_safety");
    assert.match(snapshot.controller?.reason ?? "", /unexpected second managed workspace|duplicate live managed workspace/);
    assert.equal(
      conductor.mutations.filter((mutation) => mutation === "create_workspace")
        .length,
      0
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validation summary without exact raw execution receipts cannot complete", async (t) => {
  for (const receiptMode of ["missing", "substituted", "extra"] as const) {
    await t.test(receiptMode, async () => {
      const { root, manifest } = canaryFixture();
      const store = new SqliteLaneStateStore(path.join(root, "state.db"));
      try {
        const lease = await store.claimLease({
          ownerId: `mac:${receiptMode}`,
          ownerSite: "mac",
          leaseSeconds: 75,
        });
        assert.ok(lease);
        await store.stageManifest(lease, {
          revisionId: "canary-v2",
          sourceRef: "test",
          manifest,
          createdBy: "test",
        });
        await store.activateManifest(lease, "canary-v2", 1);
        const control = await store.createControl({
          control_id: `control-${receiptMode}`,
          idempotency_key: `cutover-${receiptMode}`,
          kind: "cutover",
          requested_by: "human:test",
          payload: { revision_id: "canary-v2" },
          approvalKey: "separate-human-key",
        });
        let snapshot = await store.snapshot();
        await store.finishControl(lease, control.control_id, {
          expected_version: control.row_version,
          expected_controller_version: snapshot.controller!.row_version,
          status: "applied",
        });
        const github = new FakeGithub(store);
        const controller = new LaneController({
          store,
          conductor: new FakeConductor(
            store,
            new Set(),
            false,
            false,
            receiptMode
          ),
          github,
        });

        let rejected = false;
        for (let tick = 0; tick < 100; tick += 1) {
          await controller.tick({ lease, manifest });
          snapshot = await store.snapshot();
          if (snapshot.runs[0]?.status === "merging" && !github.merged) {
            github.merged = true;
          }
          const validation = snapshot.attempts.find(
            (attempt) =>
              attempt.role === "validation" && Boolean(attempt.progress_cursor)
          );
          if (validation) {
            assert.equal(snapshot.runs[0]?.status, "validating");
            assert.notEqual(validation.status, "completed");
            assert.notEqual(validation.result_json.passed, true);
            rejected = true;
            break;
          }
        }
        assert.equal(rejected, true);
      } finally {
        await store.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("Claude/Cursor Bash tool receipts can prove deterministic validation", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await store.claimLease({
      ownerId: "mac:bash-receipts",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    const control = await store.createControl({
      control_id: "control-bash-receipts",
      idempotency_key: "cutover-bash-receipts",
      kind: "cutover",
      requested_by: "human:test",
      payload: { revision_id: "canary-v2" },
      approvalKey: "separate-human-key",
    });
    let snapshot = await store.snapshot();
    await store.finishControl(lease, control.control_id, {
      expected_version: control.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
    });
    const github = new FakeGithub(store);
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(
        store,
        new Set(),
        false,
        false,
        "bash_tool"
      ),
      github,
    });
    snapshot = await tickUntil(controller, store, lease, manifest, "validated", 100, github);
    assert.equal(snapshot.runs[0]?.status, "validated");
    const validation = snapshot.attempts.find(
      (attempt) => attempt.role === "validation"
    );
    assert.equal(validation?.result_json.source, "conductor_tool_events");
    assert.match(
      String(
        (validation?.result_json.receipts as Array<Record<string, unknown>>)?.[0]
          ?.execution_id
      ),
      /^bash-/
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hard provider failure opens one breaker and rotates before workspace creation retries", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await store.claimLease({
      ownerId: "mac:rotation",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    const control = await store.createControl({
      control_id: "control-cutover",
      idempotency_key: "rotation-cutover",
      kind: "cutover",
      requested_by: "human:test",
      payload: { revision_id: "canary-v2" },
      approvalKey: "separate-human-key",
    });
    let snapshot = await store.snapshot();
    await store.finishControl(lease, control.control_id, {
      expected_version: control.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
      result: { canary: true },
    });

    const conductor = new FakeConductor(store, new Set(["claude"]));
    const controller = new LaneController({
      store,
      conductor,
      github: new FakeGithub(store),
    });
    for (let tick = 0; tick < 20; tick += 1) {
      await controller.tick({ lease, manifest });
      snapshot = await store.snapshot();
      if (
        snapshot.runs[0]?.workspace_id &&
        snapshot.runs[0]?.author_provider === "codex"
      ) {
        break;
      }
    }

    const run = snapshot.runs[0];
    assert.equal(run.author_provider, "codex");
    assert.ok(run.workspace_id);
    assert.equal(
      snapshot.attempts.filter(
        (attempt) => attempt.provider === "claude" && attempt.status === "failed"
      ).length,
      1
    );
    assert.equal(
      snapshot.attempts.filter(
        (attempt) =>
          attempt.provider === "codex" &&
          ["commissioned", "working", "awaiting_result"].includes(attempt.status)
      ).length,
      1
    );
    const claude = snapshot.providers.find((provider) => provider.provider === "claude");
    assert.equal(claude?.state, "open");
    assert.equal(claude?.last_error_code, "quota");
    assert.equal(
      snapshot.events.filter(
        (event) =>
          event.event_type === "provider_breaker_changed" &&
          (event.data_json as Record<string, unknown>).provider === "claude"
      ).length,
      1
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two ineffective cursor-scoped nudges replace only the session in the bound workspace", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await store.claimLease({
      ownerId: "mac:nudge-replacement",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    const control = await store.createControl({
      control_id: "control-cutover",
      idempotency_key: "nudge-cutover",
      kind: "cutover",
      requested_by: "human:test",
      payload: { revision_id: "canary-v2" },
      approvalKey: "separate-human-key",
    });
    let snapshot = await store.snapshot();
    await store.finishControl(lease, control.control_id, {
      expected_version: control.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
    });

    const conductor = new FakeConductor(store, new Set(), true);
    const controller = new LaneController({
      store,
      conductor,
      github: new FakeGithub(store),
    });
    for (let tick = 0; tick < 40; tick += 1) {
      await controller.tick({ lease, manifest });
      snapshot = await store.snapshot();
      const superseded = snapshot.attempts.find(
        (attempt) =>
          attempt.role === "implementation" && attempt.status === "superseded"
      );
      const replacement = snapshot.attempts.find(
        (attempt) =>
          attempt.role === "implementation" &&
          ["commissioned", "working", "awaiting_result"].includes(attempt.status) &&
          attempt.attempt_id !== superseded?.attempt_id &&
          Boolean(attempt.session_id)
      );
      if (superseded && replacement) break;
    }

    const implementationAttempts = snapshot.attempts.filter(
      (attempt) => attempt.role === "implementation"
    );
    assert.equal(
      implementationAttempts.filter((attempt) => attempt.status === "superseded")
        .length,
      1
    );
    assert.ok(
      implementationAttempts.some(
        (attempt) =>
          ["commissioned", "working", "awaiting_result"].includes(attempt.status) &&
          Boolean(attempt.session_id)
      )
    );
    assert.equal(
      conductor.mutations.filter((mutation) => mutation === "nudge_session").length,
      2
    );
    assert.equal(
      conductor.mutations.filter((mutation) => mutation === "create_workspace").length,
      1,
      "provider/session replacement must reuse the workspace"
    );
    assert.equal(conductor.workspaces.length, 1);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two unanswered cursor-scoped nudges replace a dead session without replacing its workspace", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await store.claimLease({
      ownerId: "mac:unanswered-nudges",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    const control = await store.createControl({
      control_id: "control-unanswered-nudges",
      idempotency_key: "cutover-unanswered-nudges",
      kind: "cutover",
      requested_by: "human:test",
      payload: { revision_id: "canary-v2" },
      approvalKey: "separate-human-key",
    });
    let snapshot = await store.snapshot();
    await store.finishControl(lease, control.control_id, {
      expected_version: control.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
    });
    let droppedNudgeReceipt = false;
    let observedDroppedNudgeReceipt = false;
    const lossyStore = new Proxy(store, {
      get(target, property) {
        if (property === "finishAction") {
          return async (
            actionLease: Parameters<LaneStateStore["finishAction"]>[0],
            actionId: Parameters<LaneStateStore["finishAction"]>[1],
            input: Parameters<LaneStateStore["finishAction"]>[2]
          ) => {
            const actionSnapshot = await target.snapshot();
            const action = actionSnapshot.pending_actions.find(
              (candidate) => candidate.action_id === actionId
            );
            const result = await target.finishAction(actionLease, actionId, input);
            if (
              !droppedNudgeReceipt &&
              action?.action_type === "nudge_session" &&
              input.status === "succeeded"
            ) {
              droppedNudgeReceipt = true;
              throw new Error("simulated lost nudge state response");
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as LaneStateStore;
    const conductor = new FakeConductor(
      lossyStore,
      new Set(),
      false,
      false,
      "command_execution",
      true
    );
    const controller = new LaneController({
      store: lossyStore,
      conductor,
      github: new FakeGithub(lossyStore),
    });

    for (let tick = 0; tick < 40; tick += 1) {
      try {
        await controller.tick({ lease, manifest });
      } catch (error) {
        if (droppedNudgeReceipt && !observedDroppedNudgeReceipt) {
          observedDroppedNudgeReceipt = true;
          continue;
        }
        throw error;
      }
      snapshot = await store.snapshot();
      if (
        snapshot.attempts.some(
          (attempt) =>
            attempt.role === "implementation" &&
            attempt.status === "superseded"
        )
      ) {
        break;
      }
    }
    assert.equal(
      conductor.mutations.filter((mutation) => mutation === "nudge_session")
        .length,
      2
    );
    assert.equal(
      snapshot.attempts.filter(
        (attempt) =>
          attempt.role === "implementation" && attempt.status === "superseded"
      ).length,
      1
    );
    assert.equal(conductor.workspaces.length, 1);
    assert.equal(observedDroppedNudgeReceipt, true);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous attestation reconciliation requires the exact published body", async (t) => {
  for (const scenario of [
    {
      name: "exact lost response is adopted once",
      slug: "exact",
      tamper: false,
      changeHead: false,
    },
    {
      name: "same tag with a changed body is rejected",
      slug: "tampered",
      tamper: true,
      changeHead: false,
    },
    {
      name: "exact old-head body is rejected after the PR head changes",
      slug: "changed-head",
      tamper: false,
      changeHead: true,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const { root, manifest } = canaryFixture();
      const store = new SqliteLaneStateStore(path.join(root, "state.db"));
      let clock = new Date();
      try {
        const lease = await store.claimLease({
          ownerId: `mac:ambiguous-attestation:${scenario.slug}`,
          ownerSite: "mac",
          leaseSeconds: 75,
        });
        assert.ok(lease);
        await store.stageManifest(lease, {
          revisionId: "canary-v2",
          sourceRef: "test",
          manifest,
          createdBy: "test",
        });
        await store.activateManifest(lease, "canary-v2", 1);
        const control = await store.createControl({
          control_id: `control-cutover-${scenario.slug}`,
          idempotency_key: `ambiguous-attestation-${scenario.slug}`,
          kind: "cutover",
          requested_by: "human:test",
          payload: { revision_id: "canary-v2" },
          approvalKey: "separate-human-key",
        });
        let snapshot = await store.snapshot();
        await store.finishControl(lease, control.control_id, {
          expected_version: control.row_version,
          expected_controller_version: snapshot.controller!.row_version,
          status: "applied",
        });
        const conductor = new FakeConductor(store);
        const github = new FakeGithub(store, false, true);
        const controller = new LaneController({
          store,
          conductor,
          github,
          now: () => clock,
        });

        for (let tick = 0; tick < 100; tick += 1) {
          await controller.tick({ lease, manifest });
          snapshot = await store.snapshot();
          if (
            snapshot.ambiguous_actions.some(
              (action) => action.action_type === "post_attestation"
            )
          ) {
            break;
          }
        }
        assert.equal(snapshot.ambiguous_actions.length, 1);
        assert.equal(github.reviews.length, 1);
        if (scenario.tamper) {
          github.reviews[0]!.body += "\nbody changed after publication";
        }
        if (scenario.changeHead) github.headSha = UPDATED_HEAD;

        clock = new Date(
          Date.parse(snapshot.ambiguous_actions[0]!.started_at!) + (LANE_ACTION_SETTLE_SECONDS + 1) * 1_000
        );
        await controller.tick({ lease, manifest });
        snapshot = await store.snapshot();

        if (scenario.tamper || scenario.changeHead) {
          assert.equal(snapshot.ambiguous_actions.length, 1);
          assert.equal(snapshot.controller?.mode, "paused_safety");
          const mutations = [...github.mutations];
          const retry = await controller.tick({ lease, manifest });
          assert.match(retry.reason, /remains unresolved/);
          assert.deepEqual(github.mutations, mutations);
          assert.notEqual(
            snapshot.attempts.find((attempt) => attempt.role === "review")?.status,
            "completed"
          );
          assert.equal(github.reviews.length, 1);
          // Exact evidence can still reconcile while paused; it cannot
          // silently resume dispatch after an operator-visible safety pause.
          if (scenario.tamper) {
            github.reviews[0]!.body = github.reviews[0]!.body.replace("\nbody changed after publication", "");
          }
          github.headSha = HEAD;
          await controller.tick({ lease, manifest });
          snapshot = await store.snapshot();
          assert.equal(snapshot.ambiguous_actions.length, 0);
          assert.equal(snapshot.controller?.mode, "paused_safety");
          return;
        }
        assert.equal(snapshot.ambiguous_actions.length, 0);

        for (let tick = 0; tick < 5; tick += 1) {
          await controller.tick({ lease, manifest });
          snapshot = await store.snapshot();
          if (
            snapshot.attempts.some(
              (attempt) =>
                attempt.role === "review" && attempt.status === "completed"
            )
          ) {
            break;
          }
        }
        assert.ok(
          snapshot.attempts.some(
            (attempt) =>
              attempt.role === "review" && attempt.status === "completed"
          ),
          "an exact reconciled publication must authorize evidence acceptance"
        );
        assert.equal(
          github.reviews.length,
          1,
          "the lost response must not duplicate the external review"
        );
      } finally {
        await store.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("unresolved external intent takes precedence over pending controls", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await store.claimLease({
      ownerId: "mac:reconciliation-priority",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    const cutover = await store.createControl({
      control_id: "priority-cutover", idempotency_key: "priority-cutover",
      kind: "cutover", requested_by: "human:test",
      payload: { revision_id: "canary-v2" }, approvalKey: "separate-human-key",
    });
    await store.finishControl(lease, cutover.control_id, {
      expected_version: cutover.row_version,
      expected_controller_version: (await store.snapshot()).controller!.row_version,
      status: "applied",
    });
    let run = await store.createRun(lease, {
      run_id: "priority-run",
      manifest_revision_id: "canary-v2",
      lane_id: "CANARY",
      generation: 1,
      priority: 100,
    });
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "queued",
      to_status: "implementing",
      stage: "implementation",
      patch: {
        author_provider: "claude",
        provider: "claude",
        model: "fable-5-1",
        workspace_id: "priority-workspace",
        workspace_name:
          "[managed:growth][lane:CANARY][run:priority-run][stage:implementation][attempt:1]",
      },
    });
    const attempt = await store.beginAttempt(lease, run.run_id, {
      attempt_id: "priority-attempt",
      expected_run_version: run.row_version,
      stage: "implementation",
      attempt_number: 1,
      role: "implementation",
      provider: "claude",
      model: "fable-5-1",
      nonce: "priority-attempt-nonce",
      workspace_id: "priority-workspace",
    });
    run = (await store.snapshot()).runs[0]!;
    await store.beginAction(lease, run.run_id, {
      action_id: "priority-action",
      deterministic_tag: "priority-action-tag",
      expected_run_version: run.row_version,
      stage: "implementation-session",
      attempt_id: attempt.attempt_id,
      action_type: "create_session",
      request: {
        workspace_id: "priority-workspace",
        session_name:
          "[managed:growth][lane:CANARY][run:priority-run][stage:implementation][attempt:1][provider:claude]",
        provider: "claude",
        model: "fable-5-1",
      },
    });
    await store.createControl({
      control_id: "pending-pause",
      idempotency_key: "pending-pause",
      kind: "pause",
      requested_by: "human:test",
      payload: { reason: "operator pause" },
    });

    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github: new FakeGithub(store),
    });
    const result = await controller.tick({ lease, manifest });
    assert.match(result.reason, /waiting for create_session reconciliation window/);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.pending_actions.length, 1);
    assert.equal(snapshot.pending_controls.length, 1);
    assert.notEqual(snapshot.controller?.mode, "paused_safety");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const drift of ["head", "base"] as const) {
test(`a pre-upgrade ambiguous merge is never reconciled against a different ${drift}`, async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  let clock = new Date();
  try {
    const lease = await store.claimLease({
      ownerId: "mac:ambiguous-merge",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    const control = await store.createControl({
      control_id: "control-cutover",
      idempotency_key: "ambiguous-merge-cutover",
      kind: "cutover",
      requested_by: "human:test",
      payload: { revision_id: "canary-v2" },
      approvalKey: "separate-human-key",
    });
    let snapshot = await store.snapshot();
    await store.finishControl(lease, control.control_id, {
      expected_version: control.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
    });
    const conductor = new FakeConductor(store);
    const github = new FakeGithub(store);
    const controller = new LaneController({
      store,
      conductor,
      github,
      now: () => clock,
    });

    snapshot = await tickUntil(controller, store, lease, manifest, "merging", 100);
    assert.equal(snapshot.runs[0]?.status, "merging");
    assert.equal(github.mutations.includes("merge_pr"), false, "the current worker does not merge");
    const run = snapshot.runs[0]!;
    const action = await store.beginAction(lease, run.run_id, {
      action_id: `pre-upgrade-merge-${drift}`,
      deterministic_tag: `pre-upgrade-merge-${drift}`,
      expected_run_version: run.row_version,
      stage: "merge",
      action_type: "merge_pr",
      request: { pr_url: run.pr_url, expected_head_sha: run.head_sha },
    });
    const currentRun = (await store.snapshot()).runs[0]!;
    await store.finishAction(lease, action.action_id, {
      expected_action_version: action.row_version,
      expected_run_version: currentRun.row_version,
      status: "ambiguous",
      error: "pre-upgrade response was lost",
    });
    github.merged = true;
    snapshot = await store.snapshot();
    assert.equal(snapshot.ambiguous_actions.length, 1);
    if (drift === "head") github.headSha = UPDATED_HEAD;
    else github.baseBranch = "release";
    clock = new Date(
      Date.parse(snapshot.ambiguous_actions[0]!.started_at!) + (LANE_ACTION_SETTLE_SECONDS + 1) * 1_000
    );
    await controller.tick({ lease, manifest });
    snapshot = await store.snapshot();
    assert.equal(snapshot.ambiguous_actions.length, 1);
    assert.equal(snapshot.controller?.mode, "paused_safety");
    const mutations = [...github.mutations];
    await controller.tick({ lease, manifest });
    snapshot = await store.snapshot();
    assert.equal(snapshot.ambiguous_actions.length, 1);
    assert.deepEqual(github.mutations, mutations);
    assert.equal(snapshot.runs[0]?.merged_sha, null);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
}

test("structured deterministic validation failure creates a repair transition", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await store.claimLease({
      ownerId: "mac:failed-validation",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    const control = await store.createControl({
      control_id: "control-cutover",
      idempotency_key: "failed-validation-cutover",
      kind: "cutover",
      requested_by: "human:test",
      payload: { revision_id: "canary-v2" },
      approvalKey: "separate-human-key",
    });
    let snapshot = await store.snapshot();
    await store.finishControl(lease, control.control_id, {
      expected_version: control.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
    });
    const github = new FakeGithub(store);
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store, new Set(), false, true),
      github,
    });
    for (let tick = 0; tick < 100; tick += 1) {
      await controller.tick({ lease, manifest });
      snapshot = await store.snapshot();
      if (snapshot.runs[0]?.status === "merging" && !github.merged) {
        github.merged = true;
      }
      if (snapshot.runs[0]?.status === "rework") break;
    }
    assert.equal(snapshot.runs[0]?.status, "rework");
    assert.equal(snapshot.runs[0]?.stage, "repair");
    assert.ok(snapshot.runs[0]?.metadata_json.validation_failure);
    assert.ok(
      snapshot.attempts.some(
        (attempt) =>
          attempt.role === "validation" &&
          attempt.status === "failed" &&
          attempt.result_json.passed === false
        )
    );
    await controller.tick({ lease, manifest });
    snapshot = await store.snapshot();
    assert.equal(snapshot.runs[0]?.status, "implementing");
    assert.equal(snapshot.runs[0]?.pr_url, null);
    assert.equal(snapshot.runs[0]?.head_sha, null);
    assert.equal(snapshot.runs[0]?.merged_sha, null);
    assert.equal(snapshot.runs[0]?.metadata_json.repair_from_merged_sha, MERGED);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retry control creates a fresh generation for a terminal run", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await store.claimLease({
      ownerId: "mac:retry-control",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "canary-v2",
      sourceRef: "test",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "canary-v2", 1);
    const cutover = await store.createControl({
      control_id: "retry-cutover", idempotency_key: "retry-cutover",
      kind: "cutover", requested_by: "human:test",
      payload: { revision_id: "canary-v2" }, approvalKey: "separate-human-key",
    });
    await store.finishControl(lease, cutover.control_id, {
      expected_version: cutover.row_version,
      expected_controller_version: (await store.snapshot()).controller!.row_version,
      status: "applied",
    });
    let run = await store.createRun(lease, {
      run_id: "failed-canary-run",
      manifest_revision_id: "canary-v2",
      lane_id: "CANARY",
      generation: 1,
      priority: 100,
    });
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "queued",
      to_status: "failed",
      stage: "terminal",
      patch: {},
    });
    await store.createControl({
      control_id: "control-retry",
      idempotency_key: "control-retry",
      kind: "retry",
      lane_id: "CANARY",
      requested_by: "telegram:test",
    });
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github: new FakeGithub(store),
    });
    await controller.tick({ lease, manifest });
    const snapshot = await store.snapshot();
    assert.deepEqual(
      snapshot.runs.map((candidate) => [candidate.generation, candidate.status]),
      [
        [1, "failed"],
        [2, "queued"],
      ]
    );
    assert.equal(
      snapshot.runs[1]?.metadata_json.retried_from,
      "failed-canary-run"
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function activateCanary(
  store: SqliteLaneStateStore,
  manifest: ReturnType<typeof canaryFixture>["manifest"],
  label: string
) {
  const lease = await store.claimLease({
    ownerId: `mac:${label}`,
    ownerSite: "mac",
    leaseSeconds: 75,
  });
  assert.ok(lease);
  await store.stageManifest(lease, {
    revisionId: "canary-v2",
    sourceRef: "test",
    manifest,
    createdBy: "test",
  });
  await store.activateManifest(lease, "canary-v2", 1);
  const dedupe = `${label}-cutover`;
  const cutover = await store.createControl({
    control_id: `control-${label}-cutover`,
    idempotency_key: dedupe,
    kind: "cutover",
    requested_by: "human:test",
    payload: { revision_id: "canary-v2" },
    approvalKey: "separate-human-key",
  });
  const snapshot = await store.snapshot();
  await store.finishControl(lease, cutover.control_id, {
    expected_version: cutover.row_version,
    expected_controller_version: snapshot.controller!.row_version,
    status: "applied",
  });
  return lease;
}

function storedCheckEvidence(root: string) {
  const db = new Database(path.join(root, "state.db"), { readonly: true });
  try {
    return (
      db
        .prepare(
          "SELECT evidence_type, head_sha, accepted, payload_json FROM lane_v2_evidence WHERE evidence_type IN ('required_checks', 'merged_ci') ORDER BY rowid"
        )
        .all() as Array<{
        evidence_type: string;
        head_sha: string;
        accepted: number;
        payload_json: string;
      }>
    ).map((row) => ({
      type: row.evidence_type,
      sha: row.head_sha,
      accepted: row.accepted === 1,
      evidence: (JSON.parse(row.payload_json) as { evidence: Record<string, unknown> })
        .evidence,
    }));
  } finally {
    db.close();
  }
}

async function tickUntil(
  controller: LaneController,
  store: SqliteLaneStateStore,
  lease: Awaited<ReturnType<typeof activateCanary>>,
  manifest: ReturnType<typeof canaryFixture>["manifest"],
  status: string,
  limit: number,
  externalMerge?: { merged: boolean }
) {
  let snapshot = await store.snapshot();
  for (let tick = 0; tick < limit && snapshot.runs[0]?.status !== status; tick += 1) {
    await controller.tick({ lease, manifest });
    snapshot = await store.snapshot();
    if (externalMerge && snapshot.runs[0]?.status === "merging" && !externalMerge.merged) {
      assert.equal(externalMerge.merged, false, "the worker must not have merged the PR");
      externalMerge.merged = true;
    }
  }
  return snapshot;
}

async function tickTimes(
  controller: LaneController,
  lease: Awaited<ReturnType<typeof activateCanary>>,
  manifest: ReturnType<typeof canaryFixture>["manifest"],
  count: number
) {
  for (let tick = 0; tick < count; tick += 1) {
    await controller.tick({ lease, manifest });
  }
}

test("named GitHub checks merge and validate only on Command Center's exact receipts", async () => {
  const { root, manifest } = canaryFixture({
    kind: "github",
    required_checks: ["gitlab/lint-and-test"],
    check_allowlist: ["gitlab/lint-and-test"],
  });
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "named-checks");
    const github = new FakeGithub(store);
    github.commitChecks = [
      { name: "gitlab/lint-and-test", status: "passing", id: "status-81" },
      { name: "preview", status: "failing", id: "check-run-7" },
    ];
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github,
    });
    const snapshot = await tickUntil(controller, store, lease, manifest, "validated", 100, github);
    assert.equal(snapshot.runs[0]?.status, "validated");
    assert.equal(github.merged, true);
    assert.ok(github.commitCheckReads.includes(HEAD), "pre-merge checks read the exact head");
    assert.ok(github.commitCheckReads.includes(MERGED), "merged CI reads the exact merged commit");
    const evidence = storedCheckEvidence(root);
    const preMerge = evidence.find(
      (item) => item.type === "required_checks" && item.accepted
    );
    assert.deepEqual(
      {
        source: preMerge?.evidence.source,
        project_path: preMerge?.evidence.project_path,
        base_branch: preMerge?.evidence.base_branch,
        commit_sha: preMerge?.evidence.commit_sha,
        pipeline_id: preMerge?.evidence.pipeline_id,
        checks: preMerge?.evidence.checks,
      },
      {
        source: "github",
        project_path: "belongnet/example",
        base_branch: "main",
        commit_sha: HEAD,
        pipeline_id: "github-status-81",
        checks: [{ name: "gitlab/lint-and-test", status: "success", commit_sha: HEAD }],
      }
    );
    assert.ok(
      evidence.some((item) => item.type === "merged_ci" && item.accepted && item.sha === MERGED),
      "merged CI is accepted for the exact merged commit"
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("green named checks without a receipt hold the merge gate closed", async () => {
  const { root, manifest } = canaryFixture({
    kind: "github",
    required_checks: ["gitlab/lint-and-test"],
  });
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "unprovable-checks");
    const github = new FakeGithub(store);
    github.commitChecks = [{ name: "gitlab/lint-and-test", status: "passing" }];
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github,
    });
    await tickTimes(controller, lease, manifest, 60);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.runs[0]?.status, "finals");
    assert.equal(snapshot.controller?.mode, "active");
    assert.equal(github.merged, false);
    const evidence = storedCheckEvidence(root);
    assert.ok(evidence.length > 0, "the unprovable gate is still recorded");
    assert.ok(evidence.every((item) => !item.accepted));
    assert.deepEqual(evidence[0]?.evidence.nonpassing_required_checks, [
      "github pipeline receipt",
    ]);
    assert.equal(evidence[0]?.evidence.all_green, false);
    assert.equal(evidence[0]?.sha, HEAD);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GitLab canonical evidence gates merge and validation on the canonical pipeline", async () => {
  const { root, manifest } = canaryFixture({
    kind: "github",
    canonical_evidence: { kind: "gitlab", project_path: "nomadhub/mvp", base_branch: "dev" },
  });
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "gitlab-canonical");
    const github = new FakeGithub(store);
    const gitlab = new FakeGitlabCi();
    gitlab.status = "pending";
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github,
      gitlab,
    });
    await tickTimes(controller, lease, manifest, 60);
    let snapshot = await store.snapshot();
    assert.equal(snapshot.runs[0]?.status, "finals", "a running canonical pipeline holds the gate");
    assert.equal(github.merged, false);

    gitlab.status = "passing";
    snapshot = await tickUntil(controller, store, lease, manifest, "validated", 100, github);
    assert.equal(snapshot.runs[0]?.status, "validated");
    assert.equal(github.merged, true);
    assert.equal(
      github.commitCheckReads.length,
      0,
      "a green GitHub mirror is never read as canonical CI"
    );
    assert.ok(
      gitlab.reads.some(
        (read) => read.projectPath === "nomadhub/mvp" && read.sha === HEAD &&
          read.ref === "managed/example" && read.baseBranch === "dev"
      ),
      "the head pipeline is bound to the reviewed branch and canonical target"
    );
    assert.ok(
      gitlab.reads.some(
        (read) => read.projectPath === "nomadhub/mvp" && read.sha === MERGED &&
          read.ref === "dev" && read.baseBranch === undefined
      ),
      "the merged pipeline is read from the canonical base branch"
    );
    const mergedCi = storedCheckEvidence(root).find(
      (item) => item.type === "merged_ci" && item.accepted
    );
    assert.equal(mergedCi?.evidence.source, "gitlab");
    assert.equal(mergedCi?.evidence.project_path, "nomadhub/mvp");
    assert.equal(mergedCi?.evidence.base_branch, "dev");
    assert.equal(mergedCi?.evidence.commit_sha, MERGED);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a retargeted PR is quarantined before its stored CI receipt can merge it", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "retargeted-pr");
    const github = new FakeGithub(store);
    const notifications = new Map<string, string>();
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github,
      notify: async (message, key) => { notifications.set(key, message); },
    });
    const before = await tickUntil(controller, store, lease, manifest, "merging", 100);
    assert.equal(before.runs[0]?.status, "merging");
    await tickTimes(controller, lease, manifest, 2);
    assert.equal(notifications.size, 1, "the operator receives one stable manual-merge alert key");
    assert.match([...notifications.values()][0]!, /Verify the repository, source and target branches/);
    github.baseBranch = "release";
    await tickTimes(controller, lease, manifest, 3);
    const after = await store.snapshot();
    assert.equal(after.runs[0]?.status, "quarantined");
    assert.equal(github.merged, false);
    assert.equal(github.mutations.includes("merge_pr"), false);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Generated by /ship coverage audit
// Value: protects=a red canonical GitLab pipeline stops the merge recheck despite a green GitHub mirror, and a red merged pipeline sends the lane to repair;
//   fails_when=the merge recheck reads the PR's mirror rollup instead of the canonical receipt, or a failed merged pipeline is held or validated, not repaired;
//   why_new=the canonical lifecycle holds only at finals and then runs green, so neither the merge recheck nor merged CI ever sees a red pipeline; seam=none
test("a red canonical pipeline holds the merge recheck and sends a red merged commit to repair", async () => {
  const { root, manifest } = canaryFixture({
    kind: "github",
    canonical_evidence: { kind: "gitlab", project_path: "nomadhub/mvp", base_branch: "dev" },
  });
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "gitlab-red-pipeline");
    const github = new FakeGithub(store);
    const gitlab = new FakeGitlabCi();
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github,
      gitlab,
    });
    assert.equal(
      (await tickUntil(controller, store, lease, manifest, "merging", 100)).runs[0]?.status,
      "merging"
    );
    gitlab.status = "failing";
    const readsBeforeRecheck = gitlab.reads.length;
    await tickTimes(controller, lease, manifest, 3);
    assert.equal((await store.snapshot()).runs[0]?.status, "merging");
    assert.equal(github.merged, false, "a green GitHub mirror never outvotes the canonical pipeline");
    assert.ok(
      gitlab.reads
        .slice(readsBeforeRecheck)
        .some((read) => read.sha === HEAD && read.ref === "managed/example"),
      "the merge recheck reads the canonical head pipeline again"
    );

    gitlab.status = "passing";
    assert.equal(
      (await tickUntil(controller, store, lease, manifest, "validating", 100, github)).runs[0]?.status,
      "validating"
    );
    assert.equal(github.merged, true);
    gitlab.status = "failing";
    const repaired = (await tickUntil(controller, store, lease, manifest, "rework", 5)).runs[0];
    assert.equal(repaired?.status, "rework");
    assert.equal(repaired?.stage, "repair");
    assert.match(
      String(repaired?.metadata_json.repair_reason),
      /merged SHA required checks failed: gitlab pipeline/
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a check response for another commit quarantines the run instead of gating on it", async () => {
  const { root, manifest } = canaryFixture({
    kind: "github",
    required_checks: ["gitlab/lint-and-test"],
  });
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "mismatched-checks");
    const github = new FakeGithub(store);
    github.commitChecks = [{ name: "gitlab/lint-and-test", status: "passing", id: "status-81" }];
    github.commitChecksAnswerSha = UPDATED_HEAD;
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github,
    });
    const snapshot = await tickUntil(controller, store, lease, manifest, "quarantined", 100);
    assert.equal(snapshot.runs[0]?.status, "quarantined");
    assert.ok(github.commitCheckReads.includes(HEAD), "the gate asked for the exact head");
    assert.equal(github.merged, false);
    assert.equal(
      storedCheckEvidence(root).length,
      0,
      "evidence about another commit is never recorded for this one"
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("named GitLab jobs gate a canonical lane on each job's own receipt", async () => {
  const { root, manifest } = canaryFixture({
    kind: "github",
    required_checks: ["lint-and-test"],
    canonical_evidence: { kind: "gitlab", project_path: "nomadhub/mvp", base_branch: "dev" },
  });
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "gitlab-named-jobs");
    const github = new FakeGithub(store);
    const gitlab = new FakeGitlabCi();
    // An unnamed job failed, so the pipeline as a whole is red.
    gitlab.status = "failing";
    gitlab.jobs = [
      { name: "lint-and-test", status: "pending", id: "gitlab-job-1" },
      { name: "deploy-review", status: "failing", id: "gitlab-job-2" },
    ];
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github,
      gitlab,
    });
    await tickTimes(controller, lease, manifest, 60);
    let snapshot = await store.snapshot();
    assert.equal(snapshot.runs[0]?.status, "finals", "a running named job holds the gate");
    assert.ok(gitlab.reads.length > 0, "the gate reads the canonical pipeline");

    gitlab.jobs = [
      { name: "lint-and-test", status: "passing", id: "gitlab-job-3" },
      { name: "deploy-review", status: "failing", id: "gitlab-job-4" },
    ];
    snapshot = await tickUntil(controller, store, lease, manifest, "validated", 100, github);
    assert.equal(snapshot.runs[0]?.status, "validated", "an unnamed failing job never blocks");
    const preMerge = storedCheckEvidence(root).find(
      (item) => item.type === "required_checks" && item.accepted
    );
    assert.deepEqual(preMerge?.evidence.checks, [
      { name: "lint-and-test", status: "success", commit_sha: HEAD },
    ]);
    assert.equal(preMerge?.evidence.source, "gitlab");
    assert.equal(preMerge?.evidence.project_path, "nomadhub/mvp");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub canonical evidence reads checks only from the canonical repository", async () => {
  const { root, manifest } = canaryFixture({
    kind: "github",
    required_checks: ["ci"],
    canonical_evidence: { kind: "github", project_path: "belongnet/canonical", base_branch: "release" },
  });
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "github-canonical");
    const github = new FakeGithub(store);
    github.commitChecks = [{ name: "ci", status: "passing", id: "check-run-5" }];
    const controller = new LaneController({ store, conductor: new FakeConductor(store), github });
    const snapshot = await tickUntil(controller, store, lease, manifest, "validated", 100, github);
    assert.equal(snapshot.runs[0]?.status, "validated");
    assert.ok(github.commitCheckRepositories.length > 0);
    assert.ok(
      github.commitCheckRepositories.every((repository) => repository === "belongnet/canonical"),
      github.commitCheckRepositories.join(", ")
    );
    const mergedCi = storedCheckEvidence(root).find(
      (item) => item.type === "merged_ci" && item.accepted
    );
    assert.equal(mergedCi?.evidence.project_path, "belongnet/canonical");
    assert.equal(mergedCi?.evidence.base_branch, "release");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a merged-commit receipt for another commit quarantines an exact-receipt lane", async () => {
  const { root, manifest } = canaryFixture({
    kind: "github",
    canonical_evidence: { kind: "gitlab", project_path: "nomadhub/mvp", base_branch: "dev" },
  });
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "gitlab-merged-mismatch");
    const gitlab = new FakeGitlabCi();
    const github = new FakeGithub(store);
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github,
      gitlab,
    });
    assert.equal(
      (await tickUntil(controller, store, lease, manifest, "validating", 100, github)).runs[0]?.status,
      "validating"
    );
    gitlab.answerSha = UPDATED_HEAD;
    const snapshot = await tickUntil(controller, store, lease, manifest, "quarantined", 5);
    assert.equal(snapshot.runs[0]?.status, "quarantined");
    assert.equal(
      storedCheckEvidence(root).some((item) => item.type === "merged_ci"),
      false,
      "a receipt for another commit is never recorded"
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a check response for another commit at the merge recheck quarantines the run", async () => {
  const { root, manifest } = canaryFixture({ kind: "github", required_checks: ["gitlab/lint-and-test"] });
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "merge-recheck-mismatch");
    const github = new FakeGithub(store);
    github.commitChecks = [{ name: "gitlab/lint-and-test", status: "passing", id: "status-81" }];
    const controller = new LaneController({ store, conductor: new FakeConductor(store), github });
    assert.equal(
      (await tickUntil(controller, store, lease, manifest, "merging", 100)).runs[0]?.status,
      "merging"
    );
    github.commitChecksAnswerSha = UPDATED_HEAD;
    const snapshot = await tickUntil(controller, store, lease, manifest, "quarantined", 5);
    assert.equal(snapshot.runs[0]?.status, "quarantined");
    assert.equal(github.merged, false);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Extended by /ship coverage audit with a merged commit that has no checks yet ("unknown"), the first state after a merge.
// Value: protects=a legacy lane holds while its merged commit has no checks yet or CI still runs, instead of pausing every lane;
//   fails_when=the merged-CI hold narrows to "pending", so a merged commit with no checks attached yet pauses the controller;
//   why_new=only "pending" was driven; "unknown" (no checks reported, the state right after every merge) never reached the hold; seam=none
test("a legacy lane waits for merged-commit CI instead of pausing every lane", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "legacy-merged-pending");
    const github = new FakeGithub(store);
    const controller = new LaneController({ store, conductor: new FakeConductor(store), github });
    github.commitChecksStatus = "unknown";
    assert.equal(
      (await tickUntil(controller, store, lease, manifest, "validating", 100, github)).runs[0]?.status,
      "validating"
    );
    let snapshot = await store.snapshot();
    // Right after a merge the commit has no checks yet; then its CI runs.
    for (const status of ["unknown", "pending"] as const) {
      github.commitChecksStatus = status;
      await tickTimes(controller, lease, manifest, 5);
      snapshot = await store.snapshot();
      assert.equal(snapshot.controller?.mode, "active", `${status} merged CI never pauses the controller`);
      assert.equal(snapshot.runs[0]?.status, "validating", `${status} merged CI holds validation`);
    }

    github.commitChecksStatus = "passing";
    snapshot = await tickUntil(controller, store, lease, manifest, "validated", 50, github);
    assert.equal(snapshot.runs[0]?.status, "validated");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unchanged green receipt stays fresh while the merge waits on GitHub", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    let lease = await activateCanary(store, manifest, "fresh-receipt");
    const github = new FakeGithub(store);
    github.mergeStateStatus = "BLOCKED";
    const controller = new LaneController({ store, conductor: new FakeConductor(store), github });
    let snapshot = await store.snapshot();
    for (
      let tick = 0;
      tick < 100 && !storedCheckEvidence(root).some((item) => item.type === "required_checks");
      tick += 1
    ) {
      await controller.tick({ lease, manifest });
    }
    snapshot = await store.snapshot();
    assert.equal(snapshot.runs[0]?.status, "finals", "a blocked PR holds the merge gate");

    // Command Center counts merge evidence as fresh for five minutes from the
    // row's first write and answers a repeated key with that original row.
    t.mock.timers.tick(6 * 60_000);
    const renewed = await store.claimLease({
      ownerId: "mac:fresh-receipt",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(renewed);
    lease = renewed;
    github.mergeStateStatus = "CLEAN";
    snapshot = await tickUntil(controller, store, lease, manifest, "validated", 50, github);
    assert.equal(snapshot.runs[0]?.status, "validated");
    assert.equal(github.merged, true);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Generated by /ship coverage audit
// Value: protects=merged-SHA CI evidence is rewritten each 4-minute window, so a validation outlasting its 15-minute freshness still completes;
//   fails_when=the merged-CI key or id drops its window, so the store answers with the first, stale row and refuses the validated transition;
//   why_new=only pre-merge evidence was aged (6 minutes); no test lets merged-SHA CI age past 15 minutes before validation ends; seam=none
test("merged-commit CI evidence stays fresh while a long validation runs", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    let lease = await activateCanary(store, manifest, "fresh-merged-ci");
    const github = new FakeGithub(store);
    const controller = new LaneController({ store, conductor: new FakeConductor(store), github });
    for (
      let tick = 0;
      tick < 100 && !storedCheckEvidence(root).some((item) => item.type === "merged_ci");
      tick += 1
    ) {
      await controller.tick({ lease, manifest });
      if ((await store.snapshot()).runs[0]?.status === "merging" && !github.merged) {
        github.merged = true;
      }
    }
    let snapshot = await store.snapshot();
    assert.equal(snapshot.runs[0]?.status, "validating", "merged CI is first recorded as validation begins");
    assert.equal(
      snapshot.attempts.some((attempt) => attempt.role === "validation" && attempt.status === "completed"),
      false,
      "the validation is still running"
    );

    // Command Center counts merged-SHA CI evidence as fresh for 15 minutes
    // from the row's first write and answers a repeated key with that row.
    t.mock.timers.tick(16 * 60_000);
    const renewed = await store.claimLease({
      ownerId: "mac:fresh-merged-ci",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(renewed, "the worker reclaims its lease after the long validation");
    lease = renewed;
    snapshot = await tickUntil(controller, store, lease, manifest, "validated", 50);
    assert.equal(snapshot.runs[0]?.status, "validated");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a green to pending to green merged CI flap waits without restarting validation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    let lease = await activateCanary(store, manifest, "merged-ci-flap");
    const github = new FakeGithub(store);
    const controller = new LaneController({ store, conductor: new FakeConductor(store), github });
    let snapshot = await store.snapshot();
    for (let tick = 0; tick < 100; tick += 1) {
      await controller.tick({ lease, manifest });
      snapshot = await store.snapshot();
      if (snapshot.runs[0]?.status === "merging" && !github.merged) {
        github.merged = true;
      }
      if (
        snapshot.runs[0]?.status === "validating" &&
        snapshot.attempts.some((attempt) => attempt.role === "validation" && attempt.status === "completed")
      ) break;
    }
    assert.equal(snapshot.runs[0]?.status, "validating");
    assert.equal(
      snapshot.attempts.some((attempt) => attempt.role === "validation" && attempt.status === "completed"),
      true
    );

    github.commitChecksStatus = "pending";
    await controller.tick({ lease, manifest });
    github.commitChecksStatus = "passing";
    await controller.tick({ lease, manifest });
    snapshot = await store.snapshot();
    assert.equal(snapshot.controller?.mode, "active", "the worker never pauses every lane");
    assert.equal(snapshot.runs[0]?.status, "validating", "the stale green row cannot validate");

    t.mock.timers.tick(5 * 60_000);
    const renewed = await store.claimLease({
      ownerId: "mac:merged-ci-flap",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(renewed);
    lease = renewed;
    snapshot = await tickUntil(controller, store, lease, manifest, "validated", 5);
    assert.equal(snapshot.runs[0]?.status, "validated");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Generated by /ship coverage audit
// Value: protects=an exact-receipt lane reads its canonical pipeline only once the PR could merge, and a blocked PR holds without a pause;
//   fails_when=the receipt read moves ahead of the mergeability check, so every tick re-reads GitLab while the PR stays blocked;
//   why_new=every exact-receipt canary keeps its PR CLEAN; only a legacy lane, which reads no canonical receipt, is ever blocked; seam=none
test("a blocked pull request holds an exact-receipt lane without reading its canonical pipeline", async () => {
  const { root, manifest } = canaryFixture({
    kind: "github",
    canonical_evidence: { kind: "gitlab", project_path: "nomadhub/mvp", base_branch: "dev" },
  });
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "blocked-canonical");
    const github = new FakeGithub(store);
    github.mergeStateStatus = "BLOCKED";
    const gitlab = new FakeGitlabCi();
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github,
      gitlab,
    });
    const blockedGates = () => {
      const db = new Database(path.join(root, "state.db"), { readonly: true });
      try {
        return (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM lane_v2_evidence WHERE evidence_type = 'mergeability' AND accepted = 0"
            )
            .get() as { count: number }
        ).count;
      } finally {
        db.close();
      }
    };
    for (let tick = 0; tick < 100 && blockedGates() === 0; tick += 1) {
      await controller.tick({ lease, manifest });
    }
    await tickTimes(controller, lease, manifest, 5);
    let snapshot = await store.snapshot();
    assert.equal(blockedGates() > 0, true, "the merge gate saw the blocked PR");
    assert.equal(snapshot.runs[0]?.status, "finals", "a blocked PR holds the merge gate");
    assert.equal(snapshot.controller?.mode, "active", "a blocked PR never pauses the controller");
    assert.equal(gitlab.reads.length, 0, "the canonical pipeline is not read while the PR cannot merge");
    assert.equal(storedCheckEvidence(root).length, 0, "no receipt is recorded for a PR that cannot merge");

    github.mergeStateStatus = "CLEAN";
    snapshot = await tickUntil(controller, store, lease, manifest, "validated", 100, github);
    assert.equal(snapshot.runs[0]?.status, "validated");
    assert.equal(github.merged, true);
    assert.equal(
      gitlab.reads.some((read) => read.sha === HEAD && read.ref === "managed/example"),
      true,
      "once the PR can merge, the gate reads the canonical head pipeline"
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a moment of unmergeability while merging never triggers an automatic merge", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "merge-flap");
    const github = new FakeGithub(store);
    const controller = new LaneController({ store, conductor: new FakeConductor(store), github });
    assert.equal(
      (await tickUntil(controller, store, lease, manifest, "merging", 100)).runs[0]?.status,
      "merging"
    );
    // GitHub reports UNKNOWN for a moment after the base moves.
    github.mergeStateStatus = "UNKNOWN";
    await controller.tick({ lease, manifest });
    github.mergeStateStatus = "CLEAN";
    await controller.tick({ lease, manifest });
    assert.equal(github.merged, false, "the worker keeps the manual merge hold");
    assert.equal(github.mutations.includes("merge_pr"), false);
    github.merged = true;
    const snapshot = await tickUntil(controller, store, lease, manifest, "validated", 50);
    assert.equal(snapshot.runs[0]?.status, "validated");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a durable merge gate refusal retries without issuing a merge action", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "merge-gate-race");
    let transitionRefused = false;
    const racingStore = new Proxy(store, {
      get(target, property) {
        if (property === "transitionRun") {
          return async (
            actionLease: Parameters<LaneStateStore["transitionRun"]>[0],
            runId: Parameters<LaneStateStore["transitionRun"]>[1],
            input: Parameters<LaneStateStore["transitionRun"]>[2]
          ) => {
            if (input.to_status === "merging" && !transitionRefused) {
              transitionRefused = true;
              throw new LaneStateStoreError("required checks are not green", 409);
            }
            return target.transitionRun(actionLease, runId, input);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as LaneStateStore;
    const github = new FakeGithub(racingStore);
    const controller = new LaneController({
      store: racingStore,
      conductor: new FakeConductor(racingStore),
      github,
    });
    for (let tick = 0; tick < 100 && !transitionRefused; tick += 1) {
      await controller.tick({ lease, manifest });
    }
    assert.equal(transitionRefused, true);
    assert.equal((await store.snapshot()).runs[0]?.status, "finals");
    assert.equal((await tickUntil(controller, store, lease, manifest, "merging", 5)).runs[0]?.status, "merging");
    await controller.tick({ lease, manifest });
    assert.equal(github.merged, false, "the worker never starts a GitHub merge");
    assert.equal((await store.snapshot()).pending_actions.length, 0);
    github.merged = true;
    const snapshot = await tickUntil(controller, store, lease, manifest, "validated", 50);
    assert.equal(snapshot.runs[0]?.status, "validated");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a run that waits in merging past freshness refreshes its receipt before manual merge", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { root, manifest } = canaryFixture({ kind: "github", required_checks: ["gitlab/lint-and-test"] });
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    let lease = await activateCanary(store, manifest, "merging-wait");
    const github = new FakeGithub(store);
    github.commitChecks = [{ name: "gitlab/lint-and-test", status: "passing", id: "status-81" }];
    const controller = new LaneController({ store, conductor: new FakeConductor(store), github });
    assert.equal(
      (await tickUntil(controller, store, lease, manifest, "merging", 100)).runs[0]?.status,
      "merging"
    );
    github.mergeStateStatus = "BLOCKED";
    await tickTimes(controller, lease, manifest, 3);
    assert.equal((await store.snapshot()).runs[0]?.status, "merging");
    t.mock.timers.tick(6 * 60_000);
    const renewed = await store.claimLease({
      ownerId: "mac:merging-wait",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(renewed, "the lease is claimed again after the wait");
    lease = renewed;
    github.mergeStateStatus = "CLEAN";
    await controller.tick({ lease, manifest });
    assert.equal(github.merged, false);
    github.merged = true;
    const snapshot = await tickUntil(controller, store, lease, manifest, "validated", 50);
    assert.equal(snapshot.runs[0]?.status, "validated");
    assert.equal(github.merged, true);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy lane sends a red merged commit to repair instead of pausing every lane", async () => {
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "legacy-merged-red");
    const github = new FakeGithub(store);
    const controller = new LaneController({ store, conductor: new FakeConductor(store), github });
    github.commitChecksStatus = "pending";
    assert.equal(
      (await tickUntil(controller, store, lease, manifest, "validating", 100, github)).runs[0]?.status,
      "validating"
    );
    github.commitChecksStatus = "failing";
    const snapshot = await tickUntil(controller, store, lease, manifest, "rework", 5);
    assert.equal(snapshot.controller?.mode, "active", "a red merged commit never pauses the controller");
    assert.equal(snapshot.runs[0]?.status, "rework");
    assert.equal(snapshot.runs[0]?.stage, "repair");
    assert.match(
      String(snapshot.runs[0]?.metadata_json.repair_reason),
      /merged SHA required checks failed: merged commit checks/
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical CI that never decides a commit raises one alert an hour in", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { root, manifest } = canaryFixture({
    kind: "github",
    canonical_evidence: { kind: "gitlab", project_path: "nomadhub/mvp", base_branch: "dev" },
  });
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    let lease = await activateCanary(store, manifest, "stalled-ci");
    const reclaim = async () => {
      const renewed = await store.claimLease({
        ownerId: "mac:stalled-ci",
        ownerSite: "mac",
        leaseSeconds: 75,
      });
      assert.ok(renewed, "the worker reclaims its lease after the wait");
      return renewed;
    };
    const gitlab = new FakeGitlabCi();
    gitlab.missing = true;
    const alerts: Array<{ message: string; key: string }> = [];
    const github = new FakeGithub(store);
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github,
      gitlab,
      notify: async (message, key) => {
        alerts.push({ message, key });
      },
    });
    await tickTimes(controller, lease, manifest, 60);
    let snapshot = await store.snapshot();
    const runId = snapshot.runs[0]!.run_id;
    assert.equal(snapshot.runs[0]?.status, "finals", "a commit with no canonical pipeline holds the gate");
    assert.equal(alerts.length, 0, "no alert inside the hour");

    t.mock.timers.tick(59 * 60_000);
    lease = await reclaim();
    await tickTimes(controller, lease, manifest, 3);
    assert.equal(alerts.length, 0, "still no alert at 59 minutes");
    t.mock.timers.tick(2 * 60_000);
    lease = await reclaim();
    await tickTimes(controller, lease, manifest, 3);
    assert.deepEqual(
      alerts.map((alert) => alert.key),
      [`checks-stalled:${runId}:head:${HEAD}`],
      "one alert, once, for the exact head"
    );
    assert.equal(
      alerts[0]?.message,
      `Growth lane CANARY has waited over 60 minutes for gitlab CI on nomadhub/mvp to decide its pull request head ${HEAD.slice(0, 12)}: no GitLab pipeline for ${HEAD.slice(0, 12)}. The gate keeps waiting.`
    );

    // The pipeline arrives; the operator merges, but merged-commit CI never does.
    gitlab.missing = false;
    snapshot = await tickUntil(controller, store, lease, manifest, "validating", 100, github);
    assert.equal(snapshot.runs[0]?.status, "validating");
    gitlab.missing = true;
    await tickTimes(controller, lease, manifest, 3);
    t.mock.timers.tick(61 * 60_000);
    lease = await reclaim();
    await tickTimes(controller, lease, manifest, 3);
    assert.deepEqual(alerts.map((alert) => alert.key), [
      `checks-stalled:${runId}:head:${HEAD}`,
      `checks-stalled:${runId}:merged:${MERGED}`,
    ]);
    snapshot = await store.snapshot();
    assert.equal(snapshot.runs[0]?.status, "validating", "the gate keeps waiting after the alert");
    assert.equal(snapshot.controller?.mode, "active");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a GitLab-delivered lane gates its merge request on its own project's named jobs", async () => {
  const { root, manifest } = canaryFixture({ kind: "gitlab", required_checks: ["lint-and-test"] });
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "gitlab-delivery");
    const conductor = new FakeConductor(store);
    conductor.gitRemote = "https://gitlab.com/belongnet/example";
    conductor.deliveryUrl = MR_URL;
    const github = new FakeGithub(store);
    const gitlab = new FakeGitlabDelivery(store);
    gitlab.ci.jobs = [{ name: "lint-and-test", status: "pending", id: "gitlab-job-1" }];
    const controller = new LaneController({ store, conductor, github, gitlab });
    await tickTimes(controller, lease, manifest, 60);
    let snapshot = await store.snapshot();
    assert.equal(snapshot.runs[0]?.pr_url, MR_URL, "the run is bound to the merge request");
    assert.equal(snapshot.runs[0]?.status, "finals", "a running named job holds the merge request");
    assert.equal(gitlab.merged, false);

    gitlab.ci.jobs = [{ name: "lint-and-test", status: "passing", id: "gitlab-job-2" }];
    snapshot = await tickUntil(controller, store, lease, manifest, "validated", 100, gitlab);
    assert.equal(snapshot.runs[0]?.status, "validated");
    assert.equal(gitlab.merged, true);
    assert.deepEqual(github.mutations, [], "nothing is delivered through GitHub");
    assert.equal(github.commitCheckReads.length + gitlab.commitCheckReads.length, 0);
    assert.ok(
      gitlab.ci.reads.some(
        (read) => read.projectPath === "belongnet/example" && read.sha === HEAD &&
          read.ref === "managed/example" && read.expectedMrIid === 7
      ),
      "the head is bound to the delivery merge request in its own project"
    );
    assert.ok(
      gitlab.ci.reads.some(
        (read) => read.projectPath === "belongnet/example" && read.sha === MERGED && read.ref === "main"
      ),
      "the merged commit is read from the project's base branch"
    );
    const evidence = storedCheckEvidence(root);
    const preMerge = evidence.find((item) => item.type === "required_checks" && item.accepted);
    assert.deepEqual(
      {
        source: preMerge?.evidence.source,
        project_path: preMerge?.evidence.project_path,
        base_branch: preMerge?.evidence.base_branch,
        commit_sha: preMerge?.evidence.commit_sha,
        checks: preMerge?.evidence.checks,
      },
      {
        source: "gitlab",
        project_path: "belongnet/example",
        base_branch: "main",
        commit_sha: HEAD,
        checks: [{ name: "lint-and-test", status: "success", commit_sha: HEAD }],
      }
    );
    assert.ok(
      evidence.some((item) => item.type === "merged_ci" && item.accepted && item.sha === MERGED),
      "merged CI is accepted for the exact merged commit"
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a different canonical GitLab project does not inherit the delivery MR number", async () => {
  const { root, manifest } = canaryFixture({
    kind: "gitlab",
    canonical_evidence: { kind: "gitlab", project_path: "nomadhub/mvp", base_branch: "dev" },
  });
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activateCanary(store, manifest, "cross-project-gitlab");
    const conductor = new FakeConductor(store);
    conductor.gitRemote = "https://gitlab.com/belongnet/example";
    conductor.deliveryUrl = MR_URL;
    const gitlab = new FakeGitlabDelivery(store);
    const controller = new LaneController({
      store,
      conductor,
      github: new FakeGithub(store),
      gitlab,
    });
    await tickTimes(controller, lease, manifest, 60);
    assert.ok(gitlab.ci.reads.some((read) => read.sha === HEAD));
    assert.ok(
      gitlab.ci.reads.filter((read) => read.sha === HEAD).every((read) =>
        read.projectPath === "nomadhub/mvp" && read.expectedMrIid === undefined
      ),
      "a canonical project has its own merge request numbering"
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function canonicalGitlabCanary(label: string) {
  const fixture = canaryFixture({
    kind: "github",
    canonical_evidence: { kind: "gitlab", project_path: "nomadhub/mvp", base_branch: "dev" },
  });
  const store = new SqliteLaneStateStore(path.join(fixture.root, "state.db"));
  const reclaim = async () => {
    const renewed = await store.claimLease({ ownerId: `mac:${label}`, ownerSite: "mac", leaseSeconds: 75 });
    assert.ok(renewed, "the worker reclaims its lease after the wait");
    return renewed;
  };
  return { ...fixture, store, reclaim };
}

test("a new head restarts the stall clock and gets its own alert", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { root, manifest, store, reclaim } = canonicalGitlabCanary("stall-new-head");
  try {
    let lease = await activateCanary(store, manifest, "stall-new-head");
    const github = new FakeGithub(store);
    const gitlab = new FakeGitlabCi();
    gitlab.missing = true;
    const alerts: string[] = [];
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github,
      gitlab,
      notify: async (_message, key) => {
        alerts.push(key);
      },
    });
    for (let tick = 0; tick < 100 && !gitlab.reads.some((read) => read.sha === HEAD); tick += 1) {
      await controller.tick({ lease, manifest });
    }
    assert.ok(gitlab.reads.some((read) => read.sha === HEAD), "the head's gate is read");

    // The author pushes while CI is still undecided, 50 minutes in.
    t.mock.timers.tick(50 * 60_000);
    lease = await reclaim();
    github.headSha = UPDATED_HEAD;
    for (let tick = 0; tick < 150 && !gitlab.reads.some((read) => read.sha === UPDATED_HEAD); tick += 1) {
      await controller.tick({ lease, manifest });
    }
    assert.ok(gitlab.reads.some((read) => read.sha === UPDATED_HEAD), "the new head's gate is read");
    t.mock.timers.tick(15 * 60_000);
    lease = await reclaim();
    await tickTimes(controller, lease, manifest, 3);
    assert.deepEqual(alerts, [], "the new head's hour starts when it is first seen");

    t.mock.timers.tick(50 * 60_000);
    lease = await reclaim();
    await tickTimes(controller, lease, manifest, 3);
    const runId = (await store.snapshot()).runs[0]!.run_id;
    assert.deepEqual(alerts, [`checks-stalled:${runId}:head:${UPDATED_HEAD}`]);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a red pipeline is decided and never raises the stalled-CI alert", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { root, manifest, store, reclaim } = canonicalGitlabCanary("stall-red-head");
  try {
    let lease = await activateCanary(store, manifest, "stall-red-head");
    const gitlab = new FakeGitlabCi();
    gitlab.status = "failing";
    const alerts: string[] = [];
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github: new FakeGithub(store),
      gitlab,
      notify: async (_message, key) => {
        alerts.push(key);
      },
    });
    await tickTimes(controller, lease, manifest, 60);
    assert.ok(gitlab.reads.some((read) => read.sha === HEAD), "the red head pipeline is read");
    t.mock.timers.tick(2 * 60 * 60_000);
    lease = await reclaim();
    await tickTimes(controller, lease, manifest, 3);
    assert.ok(gitlab.reads.length > 1, "the gate keeps reading the red pipeline");
    assert.deepEqual(alerts.filter((key) => key.startsWith("checks-stalled:")), []);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lane without named checks whose merged commit never gets CI raises the stall alert", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { root, manifest } = canaryFixture();
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    let lease = await activateCanary(store, manifest, "legacy-stall");
    const github = new FakeGithub(store);
    const alerts: Array<{ message: string; key: string }> = [];
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store),
      github,
      notify: async (message, key) => {
        alerts.push({ message, key });
      },
    });
    // A repository whose CI runs only on pull requests: the merged commit never gets a check.
    github.commitChecksStatus = "unknown";
    assert.equal(
      (await tickUntil(controller, store, lease, manifest, "validating", 100, github)).runs[0]?.status,
      "validating"
    );
    await tickTimes(controller, lease, manifest, 3);
    t.mock.timers.tick(61 * 60_000);
    const renewed = await store.claimLease({ ownerId: "mac:legacy-stall", ownerSite: "mac", leaseSeconds: 75 });
    assert.ok(renewed, "the worker reclaims its lease after the wait");
    lease = renewed;
    await tickTimes(controller, lease, manifest, 3);
    const snapshot = await store.snapshot();
    const runId = snapshot.runs[0]!.run_id;
    assert.deepEqual(
      alerts.map((alert) => alert.key),
      [`checks-stalled:${runId}:merged:${MERGED}`]
    );
    assert.match(alerts[0]!.message, /github CI on belongnet\/example to decide its merged commit/);
    assert.equal(snapshot.runs[0]?.status, "validating", "the gate keeps waiting after the alert");
    assert.equal(snapshot.controller?.mode, "active");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
