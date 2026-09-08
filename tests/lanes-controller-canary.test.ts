import test from "node:test";
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
import type { LaneStateStore } from "../src/lanes/state-store.js";
import type {
  GithubCommitChecksSnapshot,
  GithubPrPolicySnapshot,
} from "../src/bot/github.js";
import { LANE_ACTION_SETTLE_SECONDS } from "../src/lanes/controller-policy.js";

const HEAD = "1".repeat(40);
const UPDATED_HEAD = "3".repeat(40);
const FINAL_HEAD = "4".repeat(40);
const MERGED = "2".repeat(40);
const PR_URL = "https://github.com/belongnet/example/pull/7";

class FakeConductor implements ConductorLaneGateway {
  readonly mutations: string[] = [];
  readonly workspaces: ConductorApiWorkspace[] = [];
  readonly sessions = new Map<string, ConductorApiSession[]>();
  readonly messages = new Map<string, ConductorApiMessage[]>();
  archived = new Set<string>();
  readonly workingSessions = new Set<string>();
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
        gitRemote: "https://github.com/belongnet/example",
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
      : PR_URL;
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
      url: PR_URL,
      repoOwner: "belongnet",
      repoName: "example",
      prNumber: 7,
      state: this.merged ? "merged" : "open",
      isDraft: false,
      headBranch: "managed/example",
      baseBranch: "main",
      headSha: this.headSha,
      reviewDecision: null,
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
      checksStatus: "passing",
      checksSummary: "green",
      mergeCommitSha: this.merged ? MERGED : null,
      reviews: [...this.reviews],
    };
  }

  async refreshCommitChecks(): Promise<GithubCommitChecksSnapshot> {
    return {
      repoOwner: "belongnet",
      repoName: "example",
      sha: MERGED,
      status: "passing",
      summary: "green",
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

function canaryFixture() {
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
          codex: "gpt-5.6-sol",
          cursor: "grok-4.6",
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
          delivery_adapter: { kind: "github" },
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
    assert.ok(github.mutations.includes("merge_pr"));
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
    const controller = new LaneController({
      store,
      conductor,
      github: new FakeGithub(store),
      now: () => clock,
    });

    for (let tick = 0; tick < 100; tick += 1) {
      await controller.tick({ lease, manifest });
      snapshot = await store.snapshot();
      if (snapshot.runs[0]?.status === "validated") break;
    }
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
        const controller = new LaneController({
          store,
          conductor: new FakeConductor(
            store,
            new Set(),
            false,
            false,
            receiptMode
          ),
          github: new FakeGithub(store),
        });

        let rejected = false;
        for (let tick = 0; tick < 100; tick += 1) {
          await controller.tick({ lease, manifest });
          snapshot = await store.snapshot();
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
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(
        store,
        new Set(),
        false,
        false,
        "bash_tool"
      ),
      github: new FakeGithub(store),
    });

    for (let tick = 0; tick < 100; tick += 1) {
      await controller.tick({ lease, manifest });
      snapshot = await store.snapshot();
      if (snapshot.runs[0]?.status === "validated") break;
    }
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
          clock.getTime() + (LANE_ACTION_SETTLE_SECONDS + 1) * 1_000
        );
        await controller.tick({ lease, manifest });
        snapshot = await store.snapshot();
        assert.equal(snapshot.ambiguous_actions.length, 0);

        if (scenario.tamper || scenario.changeHead) {
          assert.notEqual(
            snapshot.attempts.find((attempt) => attempt.role === "review")?.status,
            "completed"
          );
          assert.equal(github.reviews.length, 1);
          return;
        }

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

test("an ambiguous merge is never reconciled against a different head", async () => {
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
    const github = new FakeGithub(store, true);
    const controller = new LaneController({
      store,
      conductor,
      github,
      now: () => clock,
    });

    for (let tick = 0; tick < 100; tick += 1) {
      await controller.tick({ lease, manifest });
      snapshot = await store.snapshot();
      if (snapshot.ambiguous_actions.some((action) => action.action_type === "merge_pr")) {
        break;
      }
    }
    assert.equal(snapshot.ambiguous_actions.length, 1);
    github.headSha = UPDATED_HEAD;
    clock = new Date(
      clock.getTime() + (LANE_ACTION_SETTLE_SECONDS + 1) * 1_000
    );
    await controller.tick({ lease, manifest });
    snapshot = await store.snapshot();
    assert.equal(snapshot.ambiguous_actions.length, 0);
    await controller.tick({ lease, manifest });
    snapshot = await store.snapshot();
    assert.equal(snapshot.runs[0]?.status, "quarantined");
    assert.equal(snapshot.runs[0]?.merged_sha, null);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
    const controller = new LaneController({
      store,
      conductor: new FakeConductor(store, new Set(), false, true),
      github: new FakeGithub(store),
    });
    for (let tick = 0; tick < 100; tick += 1) {
      await controller.tick({ lease, manifest });
      snapshot = await store.snapshot();
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
