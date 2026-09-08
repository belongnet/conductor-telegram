import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  githubPrIdentity,
  mergePrByUrl,
  postPrComment,
  postPrReviewComment,
  prHasCommentTag,
  requiredChecksGate,
  refreshCommitChecks,
  refreshPrByUrl,
  type GithubCommitChecksSnapshot,
  type GithubPrPolicySnapshot,
} from "../bot/github.js";
import { gitlabMrIdentity } from "../bot/gitlab.js";
import {
  ConductorApiError,
  conductorWorkspaceIsArchived,
  type ConductorApiAgent,
  type ConductorApiClient,
  type ConductorApiMessage,
  type ConductorApiProject,
  type ConductorApiSession,
  type ConductorApiSessionStatus,
  type ConductorApiWorkspace,
  type ConductorApiWorkspaceStatus,
} from "../integrations/conductor-api.js";
import { assistantTextFromTranscriptEvent } from "./decide.js";
import type {
  LaneManifestV2,
  ManifestLane,
  ManifestProvider,
} from "./manifest.js";
import { canonicalManifestJson, resolveLanePromptPath } from "./manifest.js";
import {
  ACTIVE_ATTEMPT_STATUSES,
  activeAttempt,
  attemptsForRun,
  deterministicLaneId,
  deterministicUuid,
  LANE_ACTION_SETTLE_SECONDS,
  LANE_LEASE_SECONDS,
  laneGenerationDue,
  managedSessionName,
  managedWorkspaceName,
  nextAttemptNumber,
  selectProvider,
  sortedActionableRuns,
  TERMINAL_RUN_STATUSES,
} from "./controller-policy.js";
import {
  parseAdversarialReviewMarkers,
  parseFinalReviewMarkers,
  parseValidationMarker,
  type ValidationMarker,
} from "./pipeline.js";
import type {
  LaneActionRecordV2,
  LaneAttemptRecord,
  LaneControlRecord,
  LaneLease,
  LaneRunRecord,
  LaneSnapshotV2,
  LaneStateStore,
  LeaseCredentials,
} from "./state-store.js";
import {
  rawExecutionReceipts,
  type RawExecutionReceipt,
} from "./validation-evidence.js";
import {
  laneRepositoryIdentity,
  repositoryRemoteIdentity,
} from "./repository-identity.js";

const DELIVERY_PR_RE =
  /https:\/\/(?:github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+|gitlab\.com\/[A-Za-z0-9_.\/-]+\/-\/merge_requests\/\d+)/gi;
const FULL_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const ARCHIVE_GRACE_MS = 60 * 60 * 1000;
const NUDGE_MESSAGE =
  "Continue the commissioned task from the current workspace state. Follow the original controller protocol and finish with the required structured result.";

type Role = LaneAttemptRecord["role"];

export interface ConductorLaneGateway {
  listProjects(options?: { signal?: AbortSignal }): Promise<ConductorApiProject[]>;
  listProjectWorkspaces(projectId: string): Promise<ConductorApiWorkspace[]>;
  listWorkspaces(options?: {
    mine?: boolean;
    name?: string;
    includeArchived?: boolean;
    signal?: AbortSignal;
  }): Promise<ConductorApiWorkspace[]>;
  listWorkspaceSessions(
    workspaceId: string,
    options?: { includeArchived?: boolean }
  ): Promise<ConductorApiSession[]>;
  getWorkspace(workspaceId: string): Promise<ConductorApiWorkspace>;
  getWorkspaceStatus(workspaceId: string): Promise<ConductorApiWorkspaceStatus>;
  getSessionStatus(sessionId: string): Promise<ConductorApiSessionStatus>;
  getSessionMessageTail(sessionId: string, limit: number): Promise<ConductorApiMessage[]>;
  getMessage(messageId: string): Promise<ConductorApiMessage>;
  sendMessage(input: {
    sessionId: string;
    message: string;
    messageId: string;
  }): Promise<{ messageId: string; state: "queued" | "sent" }>;
  createSession(input: {
    workspaceId: string;
    name?: string;
    agent: ConductorApiAgent;
    model?: string;
    effort?: string;
    fastMode?: boolean;
  }): Promise<ConductorApiSession>;
  createWorkspace(input: {
    projectId: string;
    branch?: string;
    name?: string;
    sessionName?: string;
    agent?: ConductorApiAgent;
    model?: string;
    effort?: string;
    env?: Record<string, string>;
  }): Promise<{ workspaceId: string; sessionId: string; deepLink: string }>;
  archiveWorkspace(workspaceId: string): Promise<{ workspaceId: string; status: "archived" }>;
}

export interface GithubLaneGateway {
  refreshPr(prUrl: string): Promise<GithubPrPolicySnapshot>;
  refreshCommitChecks(input: {
    repoOwner: string;
    repoName: string;
    sha: string;
  }): Promise<GithubCommitChecksSnapshot>;
  postReview(
    prUrl: string,
    body: string,
    expectedHeadSha: string
  ): Promise<{ reviewId: string; body: string; commitSha: string }>;
  postComment(prUrl: string, body: string): Promise<void>;
  hasCommentTag(
    prUrl: string,
    tag: string,
    expectedBodyHash?: string
  ): Promise<boolean>;
  merge(input: {
    prUrl: string;
    method: "squash" | "merge" | "rebase";
    expectedHeadSha: string;
  }): Promise<{ mergedSha: string }>;
}

export const defaultGithubLaneGateway: GithubLaneGateway = {
  refreshPr: refreshPrByUrl,
  refreshCommitChecks,
  postReview: postPrReviewComment,
  postComment: postPrComment,
  hasCommentTag: prHasCommentTag,
  merge: mergePrByUrl,
};

export type LaneControllerResult = {
  acted: boolean;
  active: boolean;
  reason: string;
  runId?: string;
  fullReconcileComplete?: boolean;
};

type ControllerOptions = {
  store: LaneStateStore;
  conductor: ConductorLaneGateway;
  github?: GithubLaneGateway;
  gitlab?: GithubLaneGateway;
  notify?: (message: string, dedupeKey: string) => Promise<void>;
  now?: () => Date;
};

type ActionExecution = {
  action: LaneActionRecordV2;
  result: Record<string, unknown>;
};

class NoExternalMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoExternalMutationError";
  }
}

function asProvider(value: string): ManifestProvider {
  if (value !== "claude" && value !== "codex" && value !== "cursor") {
    throw new Error(`Unsupported provider ${value}`);
  }
  return value;
}

function textForMessages(messages: readonly ConductorApiMessage[]): string {
  return messages
    .map((message) => assistantTextFromTranscriptEvent(message))
    .filter(Boolean)
    .join("\n");
}

function lastProgressCursor(messages: readonly ConductorApiMessage[]): string | null {
  // The append-only transcript position is the cursor, not just assistant
  // prose. A deterministic nudge therefore creates a new observable cursor
  // even when a dead provider never replies, allowing exactly one further
  // nudge before the two-ineffective-nudge replacement policy takes over.
  return messages.at(-1)?.id ?? null;
}

function canonicalRepoUrl(lane: ManifestLane): string {
  const host = lane.delivery_adapter.kind === "gitlab" ? "gitlab.com" : "github.com";
  return `https://${host}/${lane.repository.owner}/${lane.repository.name}`;
}

function deliveryPrIdentity(
  lane: ManifestLane,
  url: string
): { owner: string; repo: string; number: number } | null {
  return lane.delivery_adapter.kind === "gitlab"
    ? gitlabMrIdentity(url)
    : githubPrIdentity(url);
}

function extractBoundPr(
  text: string,
  lane: ManifestLane
): string | null {
  const urls = [...text.matchAll(DELIVERY_PR_RE)].map((match) => match[0]);
  for (const url of urls.reverse()) {
    const identity = deliveryPrIdentity(lane, url);
    if (
      identity?.owner === lane.repository.owner.toLowerCase() &&
      identity.repo === lane.repository.name.toLowerCase()
    ) {
      return url;
    }
  }
  return null;
}

function roleStage(role: Role, slot = 1): string {
  return role === "final" ? `final-${slot}` : role;
}

function rolePrompt(input: {
  role: Role;
  run: LaneRunRecord;
  lane: ManifestLane;
  attempt: LaneAttemptRecord;
  originalPrompt?: string;
}): string {
  const identity = JSON.stringify({
    nonce: input.attempt.nonce,
    run: input.run.run_id,
    stage: input.role === "final" ? "final" : input.role === "review" ? "review" : input.role,
    headSha: input.attempt.head_sha,
    provider: input.attempt.provider,
  });
  if (input.role === "implementation") {
    const deliveryName =
      input.lane.delivery_adapter.kind === "gitlab"
        ? "GitLab merge request"
        : "GitHub PR";
    const rework = input.run.metadata_json.rework_requested
      ? `\n- This is a repair/rework attempt. Resolve this durable controller feedback before delivery: ${JSON.stringify(
          input.run.metadata_json.rework_feedback ??
            input.run.metadata_json.validation_failure ??
            input.run.metadata_json.repair_reason ??
            "Prior gate failed"
        )}.`
      : "";
    return `${input.originalPrompt ?? ""}\n\n---\nController protocol (append-only; the lane brief above is unchanged):\n- Follow the repository AGENTS.md and use the applicable Gstack /spec, /autoplan, /qa, /review, and /ship skills.\n- Work only in this existing workspace. Commit and push your branch, then open or update one ${deliveryName} into ${input.lane.repository.base_branch}.\n- Do not deploy, publish, perform outreach, spend money, or change secrets.\n- Finish with the canonical ${deliveryName} URL on its own line.\n- This commissioned run is ${input.run.run_id}; do not create another workspace.${rework}\n`;
  }
  if (input.role === "review" || input.role === "final") {
    const label = input.role === "review" ? "ADVERSARIAL-REVIEW" : "FINAL-REVIEW";
    return `Review ${input.run.pr_url} at the exact head ${input.attempt.head_sha}. Follow the repository AGENTS.md and Gstack /review workflow. Inspect the full diff, tests, and required checks. Do not push, merge, deploy, publish, post to GitHub, or alter the checkout.\n\nReturn exactly one final machine-readable line and put all findings into the JSON summary/blocking fields:\n${label} (${input.attempt.model}): {"verdict":"approve|changes",${identity.slice(1, -1)},"summary":"...","blocking":["..."]}\n`;
  }
  const validation = input.lane.validation_profile;
  const preflightCommands = validationPreflightCommands(input.run.merged_sha!);
  const shellCommands = validation.commands.map(argvToShellCommand);
  const probeCommands = validation.probes.map(probeToShellCommand);
  return `Validate merged SHA ${input.run.merged_sha} for ${canonicalRepoUrl(input.lane)}. Follow AGENTS.md and Gstack /qa (plus /investigate or /canary when applicable). First align and prove the checkout by running each of these preflight commands exactly once, in order: ${JSON.stringify(preflightCommands)}. Then run every deterministic command exactly once, in order, using these exact shell command strings: ${JSON.stringify(shellCommands)}. The authoritative argv arrays are: ${JSON.stringify(validation.commands)}. Execute every configured read-only probe exactly once, in order, using these exact shell command strings: ${JSON.stringify(probeCommands)}. The authoritative probe definitions are: ${JSON.stringify(validation.probes)}. Do not wrap, chain, prefix, suffix, substitute, or repeat the commissioned preflight commands, validation commands, or probes. Do not deploy, publish, perform outreach, spend money, change secrets, push, or merge. A detached checkout at the merged SHA is required; do not restore or otherwise alter it after validation. The controller verifies terminal Conductor command/tool events; commentary and the result line are advisory summaries and cannot complete validation without those raw execution receipts.\n\nReturn exactly one line after the executions:\nVALIDATED (${input.attempt.model}): {${identity.slice(1, -1)},"mergedSha":"${input.run.merged_sha}","passed":true,"commands":[{"argv":["exact","configured","argv"],"exit_code":0}],"probes":[{"url":"exact configured URL","method":"GET","read_only":true,"passed":true}]}\nor VALIDATION FAILED with the same identity and complete evidence. Use [] only when that evidence class is empty in the profile.\n`;
}

function providerFailure(error: unknown): {
  outcome: "auth_failure" | "quota_failure" | "transient_failure";
  code: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    (error instanceof ConductorApiError && [401, 403].includes(error.status ?? 0)) ||
    /auth|unauthori[sz]ed|forbidden|credential/.test(normalized)
  ) {
    return { outcome: "auth_failure", code: "auth" };
  }
  if (
    (error instanceof ConductorApiError && error.status === 429) ||
    /quota|rate.?limit|out of (?:usage )?credits|session limit/.test(normalized)
  ) {
    return { outcome: "quota_failure", code: "quota" };
  }
  return { outcome: "transient_failure", code: "transient" };
}

function responseMayBeAmbiguous(error: unknown): boolean {
  if (error instanceof NoExternalMutationError) return false;
  if (error instanceof ConductorApiError) {
    return error.status === null || error.status >= 500;
  }
  return true;
}

function exactReviewMarker(input: {
  attempt: LaneAttemptRecord;
  run: LaneRunRecord;
  text: string;
}): { raw: string; verdict: "approve" | "changes"; data: Record<string, unknown> } | null {
  const markers =
    input.attempt.role === "review"
      ? parseAdversarialReviewMarkers(input.text)
      : parseFinalReviewMarkers(input.text);
  const stage = input.attempt.role === "review" ? "review" : "final";
  return (
    markers
      .filter(
        (marker) =>
          marker.model === input.attempt.model &&
          marker.data.nonce === input.attempt.nonce &&
          marker.data.run === input.run.run_id &&
          marker.data.stage === stage &&
          marker.data.headSha === input.run.head_sha &&
          marker.data.provider === input.attempt.provider
      )
      .at(-1) ?? null
  );
}

type ValidationExecutionReceipt = RawExecutionReceipt & {
  kind: "preflight" | "command" | "probe";
  index: number;
};

type VerifiedValidationMarker = {
  marker: ValidationMarker;
  receipts: ValidationExecutionReceipt[];
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  if (!value) return "''";
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function argvToShellCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

function probeToShellCommand(probe: ManifestLane["validation_profile"]["probes"][number]): string {
  return [
    "curl",
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--request",
    probe.method,
    "--output",
    "/dev/null",
    shellQuote(probe.url),
  ].join(" ");
}

function validationPreflightCommands(mergedSha: string): string[] {
  const sha = shellQuote(mergedSha);
  return [
    `git fetch --quiet origin ${sha}`,
    `git checkout --quiet --detach ${sha}`,
    `test "$(git rev-parse HEAD)" = ${sha}`,
    `test -z "$(git status --porcelain --untracked-files=all)"`,
  ];
}

function validationExecutionReceipts(input: {
  lane: ManifestLane;
  mergedSha: string;
  messages: readonly ConductorApiMessage[];
}): ValidationExecutionReceipt[] | null {
  const expected = [
    ...validationPreflightCommands(input.mergedSha).map((command, index) => ({
      command,
      kind: "preflight" as const,
      index,
    })),
    ...input.lane.validation_profile.commands.map((argv, index) => ({
      command: argvToShellCommand(argv),
      kind: "command" as const,
      index,
    })),
    ...input.lane.validation_profile.probes.map((probe, index) => ({
      command: probeToShellCommand(probe),
      kind: "probe" as const,
      index,
    })),
  ];
  const observed = rawExecutionReceipts(input.messages);
  if (
    observed.length !== expected.length ||
    observed.some((receipt, index) => receipt.command !== expected[index]?.command)
  ) {
    return null;
  }
  return observed.map((receipt, index) => ({
    ...receipt,
    kind: expected[index]!.kind,
    index: expected[index]!.index,
  }));
}

function exactValidationMarker(input: {
  attempt: LaneAttemptRecord;
  run: LaneRunRecord;
  lane: ManifestLane;
  text: string;
  messages: readonly ConductorApiMessage[];
}): VerifiedValidationMarker | null {
  const marker = parseValidationMarker(input.text);
  if (!marker || marker.result !== "passed") return null;
  const data = marker.data;
  if (
    marker.model !== input.attempt.model ||
    data.nonce !== input.attempt.nonce ||
    data.run !== input.run.run_id ||
    data.stage !== "validation" ||
    data.provider !== input.attempt.provider ||
    data.headSha !== input.run.merged_sha ||
    data.mergedSha !== input.run.merged_sha
  ) {
    return null;
  }
  const commands = Array.isArray(data.commands) ? data.commands : [];
  const probes = Array.isArray(data.probes) ? data.probes : [];
  const commandEvidence =
    commands.length === input.lane.validation_profile.commands.length &&
    commands.every(
      (entry, index) =>
        entry &&
        typeof entry === "object" &&
        Array.isArray((entry as Record<string, unknown>).argv) &&
        JSON.stringify((entry as Record<string, unknown>).argv) ===
          JSON.stringify(input.lane.validation_profile.commands[index]) &&
        (entry as Record<string, unknown>).exit_code === 0
    );
  const probeEvidence =
    probes.length === input.lane.validation_profile.probes.length &&
    probes.every(
      (entry, index) =>
        entry &&
        typeof entry === "object" &&
        (entry as Record<string, unknown>).url ===
          input.lane.validation_profile.probes[index]?.url &&
        (entry as Record<string, unknown>).method ===
          input.lane.validation_profile.probes[index]?.method &&
        (entry as Record<string, unknown>).read_only === true &&
        (entry as Record<string, unknown>).passed === true
    );
  const receipts = validationExecutionReceipts({
    ...input,
    mergedSha: input.run.merged_sha!,
  });
  const rawPassed = receipts?.every((receipt) => receipt.exit_code === 0) ?? false;
  return data.passed === true && commandEvidence && probeEvidence && rawPassed
    ? { marker, receipts: receipts! }
    : null;
}

function exactFailedValidationMarker(input: {
  attempt: LaneAttemptRecord;
  run: LaneRunRecord;
  lane: ManifestLane;
  text: string;
  messages: readonly ConductorApiMessage[];
}): VerifiedValidationMarker | null {
  const marker = parseValidationMarker(input.text);
  if (!marker || marker.result !== "failed") return null;
  const data = marker.data;
  if (
    marker.model !== input.attempt.model ||
    data.nonce !== input.attempt.nonce ||
    data.run !== input.run.run_id ||
    data.stage !== "validation" ||
    data.provider !== input.attempt.provider ||
    data.headSha !== input.run.merged_sha ||
    data.mergedSha !== input.run.merged_sha ||
    data.passed !== false
  ) {
    return null;
  }
  const commands = Array.isArray(data.commands) ? data.commands : [];
  const probes = Array.isArray(data.probes) ? data.probes : [];
  const commandEvidence =
    commands.length === input.lane.validation_profile.commands.length &&
    commands.every(
      (entry, index) =>
        entry &&
        typeof entry === "object" &&
        Array.isArray((entry as Record<string, unknown>).argv) &&
        JSON.stringify((entry as Record<string, unknown>).argv) ===
          JSON.stringify(input.lane.validation_profile.commands[index]) &&
        Number.isInteger((entry as Record<string, unknown>).exit_code)
    );
  const probeEvidence =
    probes.length === input.lane.validation_profile.probes.length &&
    probes.every(
      (entry, index) =>
        entry &&
        typeof entry === "object" &&
        (entry as Record<string, unknown>).url ===
          input.lane.validation_profile.probes[index]?.url &&
        (entry as Record<string, unknown>).method ===
          input.lane.validation_profile.probes[index]?.method &&
        (entry as Record<string, unknown>).read_only === true &&
        typeof (entry as Record<string, unknown>).passed === "boolean"
    );
  const observedFailure =
    commands.some(
      (entry) => (entry as Record<string, unknown> | undefined)?.exit_code !== 0
    ) ||
    probes.some(
      (entry) => (entry as Record<string, unknown> | undefined)?.passed !== true
    );
  const receipts = validationExecutionReceipts({
    ...input,
    mergedSha: input.run.merged_sha!,
  });
  const rawFailure = receipts?.some((receipt) => receipt.exit_code !== 0) ?? false;
  return commandEvidence && probeEvidence && observedFailure && rawFailure
    ? { marker, receipts: receipts! }
    : null;
}

function active(snapshot: LaneSnapshotV2): boolean {
  return snapshot.runs.some(
    (run) => !TERMINAL_RUN_STATUSES.has(run.status)
  );
}

function recognizedManagedWorkspace(run: LaneRunRecord): boolean {
  const name = String(run.workspace_name ?? "");
  return [
    "[managed:growth]",
    `[lane:${run.lane_id}]`,
    `[run:${run.run_id}]`,
  ].every((tag) => name.includes(tag));
}

function archiveApprovalIsActive(run: LaneRunRecord, now: Date): boolean {
  const expiresAt = Date.parse(
    String(run.metadata_json.archive_approved_until ?? "")
  );
  return (
    run.metadata_json.archive_approved_workspace_id === run.workspace_id &&
    Number.isFinite(expiresAt) &&
    expiresAt > now.getTime()
  );
}

function evidenceWasAccepted(record: Record<string, unknown>): boolean {
  return record.accepted === true || record.accepted === 1;
}

function textHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readVerifiedLanePrompt(
  manifest: LaneManifestV2,
  lane: ManifestLane
): string {
  const promptPath = resolveLanePromptPath(
    manifest.manifestPath,
    lane.prompt.path
  );
  const content = readFileSync(promptPath);
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== lane.prompt.sha256) {
    throw new Error(
      `lane ${lane.id} prompt hash changed after manifest activation: ` +
        `expected ${lane.prompt.sha256}, got ${digest}`
    );
  }
  return content.toString("utf8");
}

export class LaneController {
  private readonly github: GithubLaneGateway;
  private readonly gitlab?: GithubLaneGateway;
  private readonly notify: (message: string, dedupeKey: string) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly options: ControllerOptions) {
    this.github = options.github ?? defaultGithubLaneGateway;
    this.gitlab = options.gitlab;
    this.notify = options.notify ?? (async () => undefined);
    this.now = options.now ?? (() => new Date());
  }

  private get store(): LaneStateStore {
    return this.options.store;
  }

  private get conductor(): ConductorLaneGateway {
    return this.options.conductor;
  }

  private gitHostForLane(lane: ManifestLane): GithubLaneGateway {
    if (lane.delivery_adapter.kind === "github") return this.github;
    if (!this.gitlab) {
      throw new Error("GitLab lane delivery is configured but its gateway is unavailable");
    }
    return this.gitlab;
  }

  private gitHostForUrl(prUrl: string): GithubLaneGateway {
    if (githubPrIdentity(prUrl)) return this.github;
    if (gitlabMrIdentity(prUrl) && this.gitlab) return this.gitlab;
    throw new Error(`No configured Git-host gateway accepts ${prUrl}`);
  }

  async tick(input: {
    lease: LaneLease;
    manifest: LaneManifestV2;
    fullReconcile?: boolean;
    expectedRevisionId?: string;
    expectedManifestVersion?: number;
  }): Promise<LaneControllerResult> {
    let snapshot = await this.store.snapshot();
    const unresolved = snapshot.ambiguous_actions[0] ?? snapshot.pending_actions[0];
    if (unresolved) {
      const startedAt = Date.parse(unresolved.started_at ?? "");
      const ageMs = Number.isFinite(startedAt)
        ? this.now().getTime() - startedAt
        : 0;
      if (ageMs < LANE_ACTION_SETTLE_SECONDS * 1000) {
        return {
          acted: false,
          active: true,
          reason: `waiting for ${unresolved.action_type} reconciliation window`,
          runId: unresolved.run_id,
        };
      }
      await this.reconcileAction(input.lease, unresolved);
      return {
        acted: true,
        active: true,
        reason: `reconciled ${unresolved.action_type}`,
        runId: unresolved.run_id,
      };
    }
    if (snapshot.pending_controls.length > 0) {
      await this.applyControl(
        input.lease,
        snapshot.pending_controls[0],
        snapshot,
        input.expectedRevisionId,
        input.expectedManifestVersion
      );
      return { acted: true, active: active(snapshot), reason: "control applied" };
    }
    // A pause control and its controller-state transition commit atomically in
    // Command Center, but the HTTP response to finishControl can still be
    // lost. Derive the alert identity from the durable pause reason so the
    // next lease holder emits the same notification exactly once.
    if (snapshot.controller?.mode === "paused_safety") {
      await this.notifyPausedSafety(snapshot);
    }
    const capacityBreach = Object.entries(snapshot.capacity).find(
      ([, capacity]) => capacity.active > capacity.limit
    );
    if (capacityBreach) {
      const [provider, capacity] = capacityBreach;
      await this.pauseForSafety(
        input.lease,
        snapshot,
        `provider capacity breach ${provider} ${capacity.active}/${capacity.limit}`
      );
      return { acted: true, active: true, reason: "paused on capacity breach" };
    }
    if (snapshot.duplicates.length > 0) {
      await this.pauseForSafety(input.lease, snapshot, "durable duplicate binding detected");
      return { acted: true, active: true, reason: "paused on duplicate binding" };
    }
    if (
      snapshot.controller?.mode === "active" ||
      snapshot.controller?.mode === "shadow"
    ) {
      if (
        !snapshot.manifest ||
        snapshot.manifest.manifest_hash !== input.manifest.manifestHash ||
        snapshot.controller.active_revision_id !== snapshot.manifest.revision_id
      ) {
        await this.pauseForSafety(input.lease, snapshot, "active manifest revision drift");
        return { acted: true, active: true, reason: "paused on manifest drift" };
      }
    }
    if (snapshot.controller?.mode === "shadow") {
      if (input.fullReconcile) {
        return {
          ...(await this.observeShadow(snapshot, input.manifest)),
          fullReconcileComplete: true,
        };
      }
      return {
        acted: false,
        active: active(snapshot),
        reason: "controller is shadow; awaiting read-only reconciliation",
      };
    }
    if (snapshot.controller?.mode !== "active") {
      return {
        acted: false,
        active: active(snapshot),
        reason: `controller is ${snapshot.controller?.mode ?? "disabled"}`,
        fullReconcileComplete: Boolean(input.fullReconcile),
      };
    }

    let fullReconcileComplete = false;
    if (input.fullReconcile) {
      const reconciliation = await this.reconcileBindings(input.lease, snapshot, input.manifest);
      if (reconciliation) return reconciliation;
      snapshot = await this.store.snapshot();
      fullReconcileComplete = true;
    }

    const completedReconciliation = (result: LaneControllerResult) =>
      input.fullReconcile
        ? { ...result, fullReconcileComplete }
        : result;

    for (const run of sortedActionableRuns(snapshot)) {
      if (run.status === "paused_safety" || run.status === "quarantined") continue;
      if (run.retry_at && Date.parse(run.retry_at) > this.now().getTime()) continue;
      if (
        !snapshot.manifest ||
        run.manifest_revision_id !== snapshot.manifest.revision_id
      ) {
        await this.pauseForSafety(
          input.lease,
          snapshot,
          `run ${run.run_id} is bound to inactive manifest ${run.manifest_revision_id}`
        );
        return completedReconciliation({
          acted: true,
          active: true,
          reason: "paused on run manifest drift",
          runId: run.run_id,
        });
      }
      const lane = input.manifest.lanes.find((candidate) => candidate.id === run.lane_id);
      if (!lane) {
        await this.pauseForSafety(input.lease, snapshot, `run ${run.run_id} missing from manifest`);
        return completedReconciliation({
          acted: true,
          active: true,
          reason: "paused on orphan run",
        });
      }
      const result = await this.advanceRun(input.lease, snapshot, input.manifest, lane, run);
      if (result.acted) return completedReconciliation(result);
      snapshot = await this.store.snapshot();
    }

    const created = await this.createNextRun(input.lease, snapshot, input.manifest);
    if (created) return completedReconciliation(created);
    const archived = await this.archiveTerminal(input.lease, snapshot);
    if (archived) return completedReconciliation(archived);
    return completedReconciliation({
      acted: false,
      active: active(snapshot),
      reason: "no eligible lane action",
    });
  }

  private async pauseForSafety(
    lease: LeaseCredentials,
    snapshot: LaneSnapshotV2,
    reason: string
  ): Promise<void> {
    if (snapshot.controller?.mode === "paused_safety") return;
    // Keep the control identity stable across a lost createControl response.
    // Appending the control-requested event advances next_event_seq, while the
    // controller row itself remains unchanged; keying on that mutable cursor
    // would mint a second pause intent on restart.
    const key = deterministicLaneId(
      "safety",
      reason,
      snapshot.controller?.mode ?? "missing",
      snapshot.controller?.active_revision_id ?? "none",
      snapshot.controller?.row_version ?? 0
    );
    const control = await this.store.createControl({
      control_id: key,
      idempotency_key: key,
      kind: "pause",
      requested_by: "lane-controller",
      payload: { reason },
    });
    const current = await this.store.snapshot();
    await this.store.finishControl(lease, control.control_id, {
      expected_version: control.row_version,
      expected_controller_version: current.controller?.row_version ?? 1,
      status: "applied",
      result: { reason },
    });
    await this.notifyPausedSafety(await this.store.snapshot());
  }

  private async notifyPausedSafety(snapshot: LaneSnapshotV2): Promise<void> {
    const controller = snapshot.controller;
    if (controller?.mode !== "paused_safety") return;
    const durableReason = String(
      controller.reason ?? "controller safety condition"
    );
    const messageReason = durableReason.replace(
      /^paused from [^:]+:\s*(?:\[control:[^\]]+\]\s*)?/,
      ""
    );
    await this.notify(
      `Growth lanes paused for safety: ${messageReason}`,
      `safety-state:${textHash(durableReason)}`
    );
  }

  private async applyControl(
    lease: LeaseCredentials,
    control: LaneControlRecord,
    snapshot: LaneSnapshotV2,
    expectedRevisionId?: string,
    expectedManifestVersion?: number
  ): Promise<void> {
    let result: Record<string, unknown> = {};
    if (control.kind === "cutover" || control.kind === "shadow") {
      const revision = String(control.payload_json.revision_id ?? "");
      if (!revision) throw new Error(`${control.kind} control lacks revision_id`);
      if (expectedRevisionId && revision !== expectedRevisionId) {
        const current = await this.store.snapshot();
        const refreshed =
          current.pending_controls.find(
            (candidate) => candidate.control_id === control.control_id
          ) ?? control;
        await this.store.finishControl(lease, control.control_id, {
          expected_version: refreshed.row_version,
          expected_controller_version: current.controller?.row_version ?? 1,
          status: "rejected",
          result: {
            reason: "control revision does not match this worker's loaded manifest",
            requested_revision: revision,
            worker_revision: expectedRevisionId,
          },
        });
        return;
      }
      if (!expectedManifestVersion) {
        throw new Error("manifest activation requires the staged row version");
      }
      await this.store.activateManifest(lease, revision, expectedManifestVersion);
      result = { revision_id: revision };
    } else if (control.kind === "provider_disable" || control.kind === "provider_enable") {
      const provider = asProvider(String(control.payload_json.provider ?? ""));
      const current = snapshot.providers.find((entry) => entry.provider === provider);
      await this.store.recordProviderHealth(lease, {
        provider,
        expected_version: Number(current?.row_version ?? 0),
        outcome: control.kind === "provider_disable" ? "disable" : "enable",
        error_code: control.kind,
      });
      result = { provider };
    } else if (control.kind === "retry" && control.lane_id) {
      const run = snapshot.runs
        .filter((candidate) => candidate.lane_id === control.lane_id)
        .sort((left, right) => right.generation - left.generation)[0];
      if (run) {
        if (TERMINAL_RUN_STATUSES.has(run.status)) {
          const generation =
            Math.max(
              ...snapshot.runs
                .filter((candidate) => candidate.lane_id === control.lane_id)
                .map((candidate) => candidate.generation)
            ) + 1;
          const retried = await this.store.createRun(lease, {
            run_id: deterministicLaneId(
              "run",
              run.manifest_revision_id,
              run.lane_id,
              generation,
              control.control_id
            ),
            manifest_revision_id: run.manifest_revision_id,
            lane_id: run.lane_id,
            generation,
            priority: run.priority,
            metadata: {
              retried_from: run.run_id,
              retry_control_id: control.control_id,
            },
          });
          result = { run_id: retried.run_id, generation };
        } else {
          const toStatus =
            run.status === "paused_safety"
              ? String(run.metadata_json.resume_status ?? "queued")
              : run.status === "quarantined"
                ? "queued"
                : run.status;
          const retried = await this.store.transitionRun(lease, run.run_id, {
            expected_version: run.row_version,
            from_status: run.status,
            to_status: toStatus,
            stage: toStatus === "queued" ? "queued" : run.stage,
            patch: {
              retry_at: null,
              metadata: {
                ...run.metadata_json,
                retry_control_id: control.control_id,
              },
            },
          });
          result = { run_id: retried.run_id };
        }
      }
    } else if (control.kind === "archive_approval") {
      const workspaceIds = new Set(
        Array.isArray(control.payload_json.workspace_ids)
          ? control.payload_json.workspace_ids.map(String)
          : []
      );
      const expiresAt = String(control.payload_json.expires_at ?? "");
      let approved = 0;
      for (const candidate of snapshot.runs.filter(
        (run) =>
          Boolean(run.workspace_id) &&
          workspaceIds.has(run.workspace_id!) &&
          (!control.lane_id || run.lane_id === control.lane_id)
      )) {
        const current = await this.freshRun(candidate.run_id);
        await this.transition(
          lease,
          current.run,
          current.run.status,
          current.run.stage,
          {
            metadata: {
              ...current.run.metadata_json,
              archive_approved_until: expiresAt,
              archive_approved_workspace_id: current.run.workspace_id,
              archive_approval_control_id: control.control_id,
            },
          }
        );
        approved += 1;
      }
      result = { approved, expires_at: expiresAt };
    }
    const current = await this.store.snapshot();
    const refreshed = current.pending_controls.find(
      (candidate) => candidate.control_id === control.control_id
    ) ?? control;
    await this.store.finishControl(lease, control.control_id, {
      expected_version: refreshed.row_version,
      expected_controller_version: current.controller?.row_version ?? 1,
      status: "applied",
      result,
    });
    if (control.kind === "pause") {
      await this.notifyPausedSafety(await this.store.snapshot());
    }
  }

  private async freshRun(runId: string): Promise<{ run: LaneRunRecord; snapshot: LaneSnapshotV2 }> {
    const snapshot = await this.store.snapshot();
    const run = snapshot.runs.find((candidate) => candidate.run_id === runId);
    if (!run) throw new Error(`lane run disappeared: ${runId}`);
    return { run, snapshot };
  }

  private async invalidateHeadAttempts(
    lease: LeaseCredentials,
    runId: string,
    nextHeadSha: string
  ): Promise<LaneRunRecord> {
    let current = await this.freshRun(runId);
    for (const attempt of current.snapshot.attempts.filter(
      (candidate) =>
        candidate.run_id === runId &&
        candidate.head_sha !== nextHeadSha &&
        ["review", "final"].includes(candidate.role) &&
        ["commissioned", "working", "awaiting_result", "completed"].includes(candidate.status)
    )) {
      const latestAttempt = current.snapshot.attempts.find(
        (candidate) => candidate.attempt_id === attempt.attempt_id
      );
      if (!latestAttempt) continue;
      await this.store.updateAttempt(lease, latestAttempt.attempt_id, {
        expected_attempt_version: latestAttempt.row_version,
        expected_run_version: current.run.row_version,
        status: "superseded",
        progress_cursor: latestAttempt.progress_cursor ?? undefined,
        nudge_cursor: latestAttempt.nudge_cursor ?? undefined,
        ineffective_nudges: latestAttempt.ineffective_nudges,
        result: {
          ...latestAttempt.result_json,
          invalidated_by_head: nextHeadSha,
        },
      });
      current = await this.freshRun(runId);
    }
    return current.run;
  }

  private async replaceUnusableWorkspace(
    lease: LeaseCredentials,
    run: LaneRunRecord,
    reason: string,
    archived: boolean
  ): Promise<LaneRunRecord> {
    if (!run.workspace_id) return run;
    let current = await this.freshRun(run.run_id);
    await this.store.recordEvidence(lease, run.run_id, {
      evidence_id: deterministicLaneId(
        "evidence",
        "workspace-unusable",
        run.run_id,
        run.workspace_id
      ),
      external_key: `workspace-state:${run.workspace_id}:unusable`,
      expected_run_version: current.run.row_version,
      evidence_type: "workspace_state",
      repo_owner: run.repo_owner,
      repo_name: run.repo_name,
      head_sha: run.head_sha ?? run.merged_sha ?? "0".repeat(40),
      evidence: {
        workspace_id: run.workspace_id,
        archived,
        unusable: true,
        working_session: false,
        grace_period_elapsed: false,
        reason,
      },
    });
    current = await this.freshRun(run.run_id);
    for (const attempt of current.snapshot.attempts.filter(
      (candidate) =>
        candidate.run_id === run.run_id &&
        ["commissioned", "working", "awaiting_result"].includes(candidate.status)
    )) {
      await this.store.updateAttempt(lease, attempt.attempt_id, {
        expected_attempt_version: attempt.row_version,
        expected_run_version: current.run.row_version,
        status: "superseded",
        progress_cursor: attempt.progress_cursor ?? undefined,
        nudge_cursor: attempt.nudge_cursor ?? undefined,
        ineffective_nudges: attempt.ineffective_nudges,
        result: { ...attempt.result_json, superseded_workspace: run.workspace_id, reason },
      });
      current = await this.freshRun(run.run_id);
    }
    const history = Array.isArray(current.run.metadata_json.superseded_workspaces)
      ? current.run.metadata_json.superseded_workspaces
      : [];
    return this.transition(
      lease,
      current.run,
      current.run.status,
      current.run.stage,
      {
        workspace_id: null,
        workspace_name: null,
        session_id: null,
        metadata: {
          ...current.run.metadata_json,
          superseded_workspaces: [
            ...history,
            { workspace_id: run.workspace_id, reason, observed_at: this.now().toISOString() },
          ],
        },
      }
    );
  }

  private async quarantineRun(
    lease: LeaseCredentials,
    runId: string,
    stage: string,
    reason: string
  ): Promise<LaneRunRecord> {
    let current = await this.freshRun(runId);
    for (const attempt of current.snapshot.attempts.filter(
      (candidate) =>
        candidate.run_id === runId &&
        ["commissioned", "working", "awaiting_result"].includes(candidate.status)
    )) {
      await this.store.updateAttempt(lease, attempt.attempt_id, {
        expected_attempt_version: attempt.row_version,
        expected_run_version: current.run.row_version,
        status: "superseded",
        progress_cursor: attempt.progress_cursor ?? undefined,
        nudge_cursor: attempt.nudge_cursor ?? undefined,
        ineffective_nudges: attempt.ineffective_nudges,
        result: { ...attempt.result_json, quarantine_reason: reason },
      });
      current = await this.freshRun(runId);
    }
    return this.transition(lease, current.run, "quarantined", stage, {
      metadata: { ...current.run.metadata_json, quarantine_reason: reason },
    });
  }

  private async transition(
    lease: LeaseCredentials,
    run: LaneRunRecord,
    toStatus: string,
    stage: string,
    patch: Record<string, unknown> = {}
  ): Promise<LaneRunRecord> {
    return this.store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: run.status,
      to_status: toStatus,
      stage,
      patch,
    });
  }

  private async performAction(input: {
    lease: LeaseCredentials;
    run: LaneRunRecord;
    stage: string;
    attemptId?: string;
    actionType: string;
    request: Record<string, unknown>;
    mutate: () => Promise<Record<string, unknown>>;
  }): Promise<ActionExecution> {
    // Every external mutation begins with a full lease window. Conductor and
    // Git-host mutation clients are bounded below this TTL, so an OVH standby
    // cannot acquire the fence while the Mac still has a mutation in flight.
    // A renewal failure exits before an action intent or external side effect.
    await this.store.renewLease(
      input.lease,
      {
        phase: "external_action",
        run_id: input.run.run_id,
        stage: input.stage,
        action_type: input.actionType,
      },
      LANE_LEASE_SECONDS
    );
    // The logical request, not the mutable run row version, is the durable
    // idempotency boundary. If finishAction commits and its HTTP response is
    // lost, a restarted worker must retrieve that finished action rather than
    // mint a second intent for the same external side effect.
    const requestDigest = textHash(canonicalManifestJson(input.request));
    let action: LaneActionRecordV2 | null = null;
    let currentRun = input.run;
    // Failed attempts remain immutable audit records. Probe their stable retry
    // ordinals so a restart can find a committed success after a lost reply,
    // while a genuinely failed prior attempt advances to a new intent.
    for (let retryOrdinal = 1; retryOrdinal <= 10; retryOrdinal += 1) {
      const tag = deterministicLaneId(
        "action-tag",
        input.run.run_id,
        input.stage,
        input.attemptId ?? "run",
        input.actionType,
        requestDigest,
        retryOrdinal
      );
      action = await this.store.beginAction(input.lease, input.run.run_id, {
        action_id: deterministicLaneId("action", tag),
        deterministic_tag: tag,
        expected_run_version: currentRun.row_version,
        stage: input.stage,
        attempt_id: input.attemptId,
        action_type: input.actionType,
        request: input.request,
      });
      if (action.status !== "failed") break;
      currentRun = (await this.freshRun(input.run.run_id)).run;
    }
    if (!action || action.status === "failed") {
      await this.pauseForSafety(
        input.lease,
        await this.store.snapshot(),
        `logical ${input.actionType} action exceeded ten durable retry attempts`
      );
      throw new Error(
        `logical ${input.actionType} action exceeded ten durable retry attempts`
      );
    }
    if (action.status !== "pending") {
      return { action, result: action.result_json };
    }
    // Beginning the durable intent is itself an HTTP round trip. Refresh the
    // full lease again so every external mutation starts with all 75 seconds,
    // even when Command Center was slow to commit the intent.
    await this.store.renewLease(
      input.lease,
      {
        phase: "external_mutation",
        run_id: input.run.run_id,
        stage: input.stage,
        action_type: input.actionType,
        action_id: action.action_id,
      },
      LANE_LEASE_SECONDS
    );
    try {
      const result = await input.mutate();
      // Mutation clients are bounded to 30 seconds. Renew before the snapshot
      // and result CAS so a slow state round trip cannot make the worker stale
      // after the external side effect has already happened.
      await this.store.renewLease(
        input.lease,
        {
          phase: "external_result",
          run_id: input.run.run_id,
          stage: input.stage,
          action_type: input.actionType,
          action_id: action.action_id,
        },
        LANE_LEASE_SECONDS
      );
      const fresh = await this.freshRun(input.run.run_id);
      const finished = await this.store.finishAction(input.lease, action.action_id, {
        expected_action_version: action.row_version,
        expected_run_version: fresh.run.row_version,
        status: "succeeded",
        result,
        external_ref:
          typeof result.external_ref === "string" ? result.external_ref : undefined,
      });
      return { action: finished, result };
    } catch (error) {
      await this.store.renewLease(
        input.lease,
        {
          phase: "external_error",
          run_id: input.run.run_id,
          stage: input.stage,
          action_type: input.actionType,
          action_id: action.action_id,
        },
        LANE_LEASE_SECONDS
      );
      const fresh = await this.freshRun(input.run.run_id);
      const ambiguous = responseMayBeAmbiguous(error);
      const finished = await this.store.finishAction(input.lease, action.action_id, {
        expected_action_version: action.row_version,
        expected_run_version: fresh.run.row_version,
        status: ambiguous ? "ambiguous" : "failed",
        error: error instanceof Error ? error.message : String(error),
        result: {},
      });
      if (ambiguous) {
        await this.notify(
          `Growth lane ${input.run.lane_id} has an ambiguous ${input.actionType} response; retries are fenced until reconciliation.`,
          `ambiguous:${action.action_id}`
        );
      }
      return { action: finished, result: {} };
    }
  }

  private async failProviderAttempt(
    lease: LeaseCredentials,
    runId: string,
    attemptId: string | null,
    error: unknown
  ): Promise<void> {
    if (!attemptId) return;
    const fresh = await this.freshRun(runId);
    const attempt = fresh.snapshot.attempts.find(
      (candidate) => candidate.attempt_id === attemptId
    );
    if (
      !attempt ||
      !["commissioned", "working", "awaiting_result"].includes(attempt.status)
    ) {
      return;
    }
    const failure = providerFailure(error);
    await this.store.updateAttempt(lease, attempt.attempt_id, {
      expected_attempt_version: attempt.row_version,
      expected_run_version: fresh.run.row_version,
      status: "failed",
      progress_cursor: attempt.progress_cursor ?? undefined,
      nudge_cursor: attempt.nudge_cursor ?? undefined,
      ineffective_nudges: attempt.ineffective_nudges,
      result: {
        ...attempt.result_json,
        error: error instanceof Error ? error.message : String(error),
        provider_failure: failure.outcome,
      },
    });
    const healthSnapshot = await this.store.snapshot();
    const health = healthSnapshot.providers.find(
      (entry) => entry.provider === attempt.provider
    );
    const providerHealth = await this.store.recordProviderHealth(lease, {
      expected_version: Number(health?.row_version ?? 0),
      provider: attempt.provider,
      outcome: failure.outcome,
      error_code: failure.code,
    });
    if (
      (providerHealth.state === "open" || providerHealth.state === "disabled") &&
      health?.state !== providerHealth.state
    ) {
      await this.notify(
        `Growth lane provider ${attempt.provider} is ${String(providerHealth.state)} after ${failure.outcome}; eligible work will rotate.`,
        `provider-breaker:${attempt.provider}:${String(providerHealth.breaker_until ?? providerHealth.state)}`
      );
    }
  }

  private async observeShadow(
    snapshot: LaneSnapshotV2,
    manifest: LaneManifestV2
  ): Promise<LaneControllerResult> {
    const projects = await this.conductor.listProjects();
    const projectsByRepository = new Map<string, ConductorApiProject[]>();
    for (const project of projects) {
      const identity = repositoryRemoteIdentity(project.gitRemote);
      if (!identity) continue;
      const matches = projectsByRepository.get(identity) ?? [];
      matches.push(project);
      projectsByRepository.set(identity, matches);
    }

    const projectWorkspaces = new Map<string, ConductorApiWorkspace[]>();
    let missingProjects = 0;
    let ambiguousProjects = 0;
    let managedWorkspaces = 0;
    let duplicateManagedNames = 0;
    const laneProject = new Map<string, ConductorApiProject>();
    for (const lane of manifest.lanes) {
      const matches = projectsByRepository.get(laneRepositoryIdentity(lane)) ?? [];
      if (matches.length === 0) {
        missingProjects += 1;
        continue;
      }
      if (matches.length > 1) {
        ambiguousProjects += 1;
        continue;
      }
      const project = matches[0]!;
      laneProject.set(lane.id, project);
      let workspaces = projectWorkspaces.get(project.id);
      if (!workspaces) {
        workspaces = await this.conductor.listProjectWorkspaces(project.id);
        projectWorkspaces.set(project.id, workspaces);
      }
      const laneManaged = workspaces.filter(
        (workspace) =>
          !conductorWorkspaceIsArchived(workspace) &&
          workspace.name.includes("[managed:growth]") &&
          workspace.name.includes(`[lane:${lane.id}]`)
      );
      managedWorkspaces += laneManaged.length;
      const names = new Map<string, number>();
      for (const workspace of laneManaged) {
        names.set(workspace.name, (names.get(workspace.name) ?? 0) + 1);
      }
      duplicateManagedNames += [...names.values()].filter((count) => count > 1).length;
    }

    let boundWorkspaceDrift = 0;
    let prDrift = 0;
    let readErrors = 0;
    for (const run of snapshot.runs) {
      if (run.manifest_revision_id !== snapshot.manifest?.revision_id) {
        boundWorkspaceDrift += 1;
        continue;
      }
      if (run.workspace_id) {
        const project = laneProject.get(run.lane_id);
        const workspaces = project ? projectWorkspaces.get(project.id) ?? [] : [];
        const workspace = workspaces.find((candidate) => candidate.id === run.workspace_id);
        if (
          !workspace ||
          (conductorWorkspaceIsArchived(workspace) &&
            !TERMINAL_RUN_STATUSES.has(run.status))
        ) {
          boundWorkspaceDrift += 1;
        }
      }
      if (run.pr_url && run.head_sha && !run.merged_sha) {
        try {
          const policy = await this.gitHostForUrl(run.pr_url).refreshPr(run.pr_url);
          if (
            policy.repoOwner !== run.repo_owner.toLowerCase() ||
            policy.repoName !== run.repo_name.toLowerCase() ||
            policy.prNumber !== run.pr_number ||
            policy.baseBranch !== run.base_branch ||
            policy.headBranch !== run.head_branch ||
            policy.headSha !== run.head_sha ||
            policy.state !== "open"
          ) {
            prDrift += 1;
          }
        } catch {
          readErrors += 1;
        }
      }
    }
    const comparison = {
      repositories: new Set(manifest.lanes.map(laneRepositoryIdentity)).size,
      missing_projects: missingProjects,
      ambiguous_projects: ambiguousProjects,
      managed_workspaces: managedWorkspaces,
      duplicate_managed_names: duplicateManagedNames,
      bound_workspace_drift: boundWorkspaceDrift,
      pr_drift: prDrift,
      read_errors: readErrors,
    };
    return {
      acted: false,
      active: active(snapshot),
      reason: `shadow comparison ${JSON.stringify(comparison)}`,
    };
  }

  private async recordProviderSuccess(
    lease: LeaseCredentials,
    provider: ManifestProvider
  ): Promise<void> {
    const snapshot = await this.store.snapshot();
    const health = snapshot.providers.find(
      (entry) => entry.provider === provider
    );
    await this.store.recordProviderHealth(lease, {
      expected_version: Number(health?.row_version ?? 0),
      provider,
      outcome: "success",
    });
  }

  private async reconcileAction(
    lease: LeaseCredentials,
    action: LaneActionRecordV2
  ): Promise<void> {
    const request = action.request_json;
    let found = false;
    let result: Record<string, unknown> = { reconciled: true, found: false };
    try {
      if (action.action_type === "create_workspace") {
        const expectedName = String(request.workspace_name ?? "");
        const projectId = String(request.project_id ?? "");
        const matches = (
          await this.conductor.listProjectWorkspaces(projectId)
        ).filter((workspace) => workspace.name === expectedName);
        if (matches.length > 1) {
          await this.pauseForSafety(lease, await this.store.snapshot(), `multiple workspaces match ${expectedName}`);
          return;
        }
        if (matches[0]) {
          const sessions = await this.conductor.listWorkspaceSessions(matches[0].id, {
            includeArchived: true,
          });
          const sessionMatches = sessions.filter(
            (session) => session.name === String(request.session_name)
          );
          if (sessionMatches.length > 1) {
            await this.pauseForSafety(
              lease,
              await this.store.snapshot(),
              `multiple sessions match ${String(request.session_name)}`
            );
            return;
          }
          found = true;
          result = {
            reconciled: true,
            found: true,
            workspace_id: matches[0].id,
            workspace_name: matches[0].name,
            session_id: sessionMatches[0]?.id ?? null,
            session_name: sessionMatches[0]?.name ?? null,
          };
          if (!sessionMatches[0]) {
            // createWorkspace commissions the initial session as part of the
            // same external mutation. A workspace-only observation is a
            // partial result, not proof that retrying session creation is safe.
            await this.notify(
              `Growth lane ${action.run_id} has a partial workspace create result; the commissioned session is not yet visible and the action remains ambiguous.`,
              `partial-create:${action.action_id}`
            );
            return;
          }
        }
      } else if (action.action_type === "create_session") {
        const sessions = await this.conductor.listWorkspaceSessions(
          String(request.workspace_id),
          { includeArchived: true }
        );
        const matches = sessions.filter(
          (session) => session.name === String(request.session_name)
        );
        if (matches.length > 1) {
          await this.pauseForSafety(lease, await this.store.snapshot(), `multiple sessions match ${String(request.session_name)}`);
          return;
        }
        if (matches[0]) {
          found = true;
          result = {
            reconciled: true,
            found: true,
            session_id: matches[0].id,
            session_name: matches[0].name,
            workspace_id: request.workspace_id,
          };
        }
      } else if (action.action_type === "send_prompt" || action.action_type === "nudge_session") {
        const message = await this.conductor.getMessage(String(request.message_id));
        const content = typeof message.content === "string" ? message.content : "";
        const contentMatches =
          message.sessionId === request.session_id &&
          textHash(content) === request.message_hash;
        found = message.id === request.message_id && contentMatches;
        result = {
          reconciled: true,
          found,
          message_id: message.id,
          content_matches: contentMatches,
        };
      } else if (action.action_type === "post_attestation") {
        const policy = await this.gitHostForUrl(String(request.pr_url)).refreshPr(
          String(request.pr_url)
        );
        found =
          policy.headSha === request.head_sha &&
          policy.reviews.some(
            (review) =>
              review.commitSha === request.head_sha &&
              review.body.includes(String(request.attestation_tag)) &&
              textHash(review.body) === request.attestation_body_hash
          );
        result = {
          reconciled: true,
          found,
          ...(found
            ? {
                commit_sha: request.head_sha,
                attestation_tag: request.attestation_tag,
                attestation_body_hash: request.attestation_body_hash,
              }
            : {}),
        };
      } else if (action.action_type === "post_notice") {
        found = await this.gitHostForUrl(String(request.pr_url)).hasCommentTag(
          String(request.pr_url),
          String(request.notice_tag),
          String(request.notice_body_hash)
        );
        result = {
          reconciled: true,
          found,
          ...(found
            ? {
                notice_tag: request.notice_tag,
                notice_body_hash: request.notice_body_hash,
              }
            : {}),
        };
      } else if (action.action_type === "merge_pr") {
        const policy = await this.gitHostForUrl(String(request.pr_url)).refreshPr(
          String(request.pr_url)
        );
        const expectedHead = String(request.expected_head_sha ?? "").toLowerCase();
        found =
          policy.state === "merged" &&
          policy.headSha?.toLowerCase() === expectedHead &&
          Boolean(policy.mergeCommitSha && FULL_SHA_RE.test(policy.mergeCommitSha));
        result = {
          reconciled: true,
          found,
          ...(found ? { merged_sha: policy.mergeCommitSha } : {}),
        };
      } else if (action.action_type === "archive_workspace") {
        const status = await this.conductor.getWorkspaceStatus(String(request.workspace_id));
        found = status.status === "archived";
        result = { reconciled: true, found, workspace_id: status.workspaceId };
      }
    } catch (error) {
      if (!(error instanceof ConductorApiError && error.status === 404)) throw error;
    }
    const fresh = await this.freshRun(action.run_id);
    const finished = await this.store.finishAction(lease, action.action_id, {
      expected_action_version: action.row_version,
      expected_run_version: fresh.run.row_version,
      status: found ? "reconciled" : "failed",
      result,
      error: found ? undefined : "authoritative reconciliation found no external result",
    });
    if (
      !found &&
      ["create_workspace", "create_session", "send_prompt", "nudge_session"].includes(
        action.action_type
      )
    ) {
      await this.failProviderAttempt(
        lease,
        action.run_id,
        action.attempt_id,
        action.error ?? finished.error ?? "unconfirmed external provider action"
      );
    }
  }

  private async reconcileBindings(
    lease: LeaseCredentials,
    snapshot: LaneSnapshotV2,
    manifest: LaneManifestV2
  ): Promise<LaneControllerResult | null> {
    const pauseInventory = async (
      reason: string,
      runId?: string
    ): Promise<LaneControllerResult> => {
      await this.pauseForSafety(lease, await this.store.snapshot(), reason);
      return {
        acted: true,
        active: true,
        reason: "paused on Conductor workspace inventory drift",
        ...(runId ? { runId } : {}),
      };
    };
    const projects = await this.conductor.listProjects();
    const projectsByRepository = new Map<string, ConductorApiProject[]>();
    for (const project of projects) {
      const identity = repositoryRemoteIdentity(project.gitRemote);
      if (!identity) continue;
      const matches = projectsByRepository.get(identity) ?? [];
      matches.push(project);
      projectsByRepository.set(identity, matches);
    }
    const workspacesByRepository = new Map<string, ConductorApiWorkspace[]>();
    for (const repository of new Set(manifest.lanes.map(laneRepositoryIdentity))) {
      const matchingProjects = projectsByRepository.get(repository) ?? [];
      if (matchingProjects.length !== 1) {
        return pauseInventory(
          matchingProjects.length === 0
            ? `Conductor project missing for manifest repository ${repository}`
            : `multiple Conductor projects match manifest repository ${repository}`
        );
      }
      workspacesByRepository.set(
        repository,
        await this.conductor.listProjectWorkspaces(matchingProjects[0]!.id)
      );
    }

    const runsById = new Map(snapshot.runs.map((run) => [run.run_id, run]));
    const lanesById = new Map(manifest.lanes.map((lane) => [lane.id, lane]));
    for (const [repository, workspaces] of workspacesByRepository) {
      const managed = workspaces.filter(
        (workspace) =>
          !conductorWorkspaceIsArchived(workspace) &&
          workspace.name.includes("[managed:growth]")
      );
      const names = new Map<string, ConductorApiWorkspace[]>();
      const byRun = new Map<string, ConductorApiWorkspace[]>();
      for (const workspace of managed) {
        const sameName = names.get(workspace.name) ?? [];
        sameName.push(workspace);
        names.set(workspace.name, sameName);
        const runTokens = [
          ...workspace.name.matchAll(/\[run:([^\]\r\n]+)\]/g),
        ].map((match) => match[1]!);
        const laneTokens = [
          ...workspace.name.matchAll(/\[lane:([^\]\r\n]+)\]/g),
        ].map((match) => match[1]!);
        if (runTokens.length !== 1 || laneTokens.length !== 1) {
          return pauseInventory(
            `managed workspace ${workspace.id} has malformed run/lane tags`
          );
        }
        const runId = runTokens[0]!;
        const laneId = laneTokens[0]!;
        const sameRun = byRun.get(runId) ?? [];
        sameRun.push(workspace);
        byRun.set(runId, sameRun);
        const run = runsById.get(runId);
        if (!run) {
          return pauseInventory(
            `live managed workspace ${workspace.id} references unknown run ${runId}`
          );
        }
        if (run.lane_id !== laneId) {
          return pauseInventory(
            `managed workspace ${workspace.id} lane tag does not match run ${runId}`,
            runId
          );
        }
        const lane = lanesById.get(laneId);
        const runRepository = `${run.repo_owner}/${run.repo_name}`.toLowerCase();
        const repositoryPath = repository.split("/").slice(1).join("/");
        if (
          runRepository !== repositoryPath ||
          (lane !== undefined && laneRepositoryIdentity(lane) !== repository)
        ) {
          return pauseInventory(
            `managed workspace ${workspace.id} is outside run ${runId}'s repository`,
            runId
          );
        }
        if (run.workspace_id && run.workspace_id !== workspace.id) {
          return pauseInventory(
            `run ${runId} has an unexpected second managed workspace ${workspace.id}`,
            runId
          );
        }
        if (!run.workspace_id) {
          const recoverableCreate = snapshot.attempts.some(
            (attempt) =>
              attempt.run_id === runId &&
              ACTIVE_ATTEMPT_STATUSES.has(attempt.status) &&
              managedWorkspaceName({
                laneId,
                runId,
                stage: attempt.stage,
                attempt: attempt.attempt_number,
                title: lane?.title,
              }) === workspace.name
          );
          if (!recoverableCreate) {
            return pauseInventory(
              `unbound managed workspace ${workspace.id} has no recoverable create attempt`,
              runId
            );
          }
        }
        if (run.metadata_json.workspace_archived === true) {
          return pauseInventory(
            `run ${runId} records workspace ${workspace.id} archived but Conductor reports it live`,
            runId
          );
        }
      }
      const duplicateName = [...names.entries()].find(([, values]) => values.length > 1);
      if (duplicateName) {
        return pauseInventory(
          `duplicate live managed workspace name ${duplicateName[0]}`
        );
      }
      const duplicateRun = [...byRun.entries()].find(([, values]) => values.length > 1);
      if (duplicateRun) {
        return pauseInventory(
          `run ${duplicateRun[0]} has ${duplicateRun[1].length} live managed workspaces`,
          duplicateRun[0]
        );
      }
    }

    for (const run of sortedActionableRuns(snapshot)) {
      const lane = manifest.lanes.find((candidate) => candidate.id === run.lane_id);
      if (!lane) continue;
      if (run.workspace_id) {
        const repositoryWorkspaces =
          workspacesByRepository.get(laneRepositoryIdentity(lane)) ?? [];
        const workspace = repositoryWorkspaces.find(
          (candidate) => candidate.id === run.workspace_id
        );
        if (
          workspace &&
          conductorWorkspaceIsArchived(workspace) &&
          !TERMINAL_RUN_STATUSES.has(run.status)
        ) {
          const changed = await this.replaceUnusableWorkspace(
            lease,
            run,
            "bound workspace is archived",
            true
          );
          return { acted: true, active: true, reason: "released archived binding", runId: changed.run_id };
        }
        if (!workspace) {
          try {
            const outsideRepository = await this.conductor.getWorkspace(
              run.workspace_id
            );
            if (!conductorWorkspaceIsArchived(outsideRepository)) {
              return pauseInventory(
                `bound workspace ${run.workspace_id} is absent from the manifest repository project`,
                run.run_id
              );
            }
          } catch (error) {
            if (!(error instanceof ConductorApiError && error.status === 404)) {
              throw error;
            }
          }
          const changed = await this.replaceUnusableWorkspace(
            lease,
            run,
            "bound workspace is archived, missing, or outside the repository inventory",
            true
          );
          return {
            acted: true,
            active: true,
            reason: "released unavailable binding",
            runId: changed.run_id,
          };
        }
      }
      if (run.pr_url && !run.merged_sha) {
        const policy = await this.gitHostForLane(lane).refreshPr(run.pr_url);
        const identity = deliveryPrIdentity(lane, policy.url);
        if (
          !identity ||
          identity.owner !== run.repo_owner.toLowerCase() ||
          identity.repo !== run.repo_name.toLowerCase() ||
          policy.prNumber !== run.pr_number ||
          policy.headBranch !== run.head_branch ||
          policy.baseBranch !== run.base_branch
        ) {
          const changed = await this.quarantineRun(
            lease,
            run.run_id,
            "reconcile",
            "PR repository or branch identity drift"
          );
          return { acted: true, active: true, reason: "quarantined PR identity drift", runId: changed.run_id };
        }
        if (policy.headSha && policy.headSha !== run.head_sha) {
          const current = await this.invalidateHeadAttempts(lease, run.run_id, policy.headSha);
          const restartReview = ["finals", "merging"].includes(current.status);
          const changed = await this.transition(
            lease,
            current,
            restartReview ? "reviewing" : current.status,
            restartReview ? "review" : current.stage,
            {
              head_sha: policy.headSha,
              metadata: {
                ...current.metadata_json,
                head_changed_at: this.now().toISOString(),
              },
            }
          );
          return { acted: true, active: true, reason: "adopted new PR head", runId: changed.run_id };
        }
      }
    }
    return null;
  }

  private async advanceRun(
    lease: LeaseCredentials,
    snapshot: LaneSnapshotV2,
    manifest: LaneManifestV2,
    lane: ManifestLane,
    run: LaneRunRecord
  ): Promise<LaneControllerResult> {
    if (run.status === "queued") {
      const provider = selectProvider({
        manifest,
        lane,
        snapshot,
        role: "implementation",
      });
      if (!provider) return { acted: false, active: true, reason: "provider capacity unavailable" };
      const changed = await this.transition(lease, run, "implementing", "implementation", {
        author_provider: provider,
        provider,
        model: manifest.global.provider_models[provider],
      });
      return { acted: true, active: true, reason: "implementation selected", runId: changed.run_id };
    }
    if (run.status === "implementing") {
      return this.advanceImplementation(lease, snapshot, manifest, lane, run);
    }
    if (run.status === "pr_bound") {
      const changed = await this.transition(lease, run, "reviewing", "review");
      return { acted: true, active: true, reason: "review stage entered", runId: changed.run_id };
    }
    if (run.status === "reviewing") {
      return this.advanceReviewOrFinal(lease, snapshot, manifest, lane, run, "review");
    }
    if (run.status === "finals") {
      return this.advanceReviewOrFinal(lease, snapshot, manifest, lane, run, "final");
    }
    if (run.status === "rework") {
      const postMergeRepair = run.stage === "repair" && Boolean(run.merged_sha);
      const priorMergedShas = Array.isArray(
        run.metadata_json.prior_merged_shas
      )
        ? run.metadata_json.prior_merged_shas.map(String)
        : [];
      const changed = await this.transition(lease, run, "implementing", "implementation", {
        session_id: String(run.metadata_json.author_session_id ?? run.session_id ?? "") || null,
        provider: run.author_provider,
        model: run.author_provider
          ? manifest.global.provider_models[asProvider(run.author_provider)]
          : run.model,
        ...(postMergeRepair
          ? {
              pr_number: null,
              pr_url: null,
              head_branch: null,
              head_sha: null,
              merged_sha: null,
            }
          : {}),
        metadata: {
          ...run.metadata_json,
          rework_requested: true,
          ...(postMergeRepair
            ? {
                repair_from_merged_sha: run.merged_sha,
                prior_merged_shas: [
                  ...new Set([...priorMergedShas, run.merged_sha!]),
                ],
                merge_notice_posted: false,
              }
            : {}),
        },
      });
      return { acted: true, active: true, reason: "rework returned to author", runId: changed.run_id };
    }
    if (run.status === "merging") {
      return this.advanceMerge(lease, snapshot, lane, run);
    }
    if (run.status === "validating") {
      return this.advanceValidation(lease, snapshot, manifest, lane, run);
    }
    return { acted: false, active: true, reason: `stage ${run.status} is inert` };
  }

  private async ensureWorkspace(
    lease: LeaseCredentials,
    manifest: LaneManifestV2,
    lane: ManifestLane,
    run: LaneRunRecord,
    attempt: LaneAttemptRecord
  ): Promise<LaneControllerResult | null> {
    if (run.workspace_id) return null;
    const provider = attempt.provider;
    const workspaceName = managedWorkspaceName({
      laneId: lane.id,
      runId: run.run_id,
      stage: attempt.stage,
      attempt: attempt.attempt_number,
      title: lane.title,
    });
    const projects = await this.conductor.listProjects();
    const repositoryIdentity = laneRepositoryIdentity(lane);
    const matchingProjects = projects.filter(
      (candidate) =>
        repositoryRemoteIdentity(candidate.gitRemote) === repositoryIdentity
    );
    if (matchingProjects.length > 1) {
      const changed = await this.quarantineRun(
        lease,
        run.run_id,
        "implementation",
        `multiple Conductor projects match ${repositoryIdentity}`
      );
      return {
        acted: true,
        active: true,
        reason: "quarantined ambiguous project",
        runId: changed.run_id,
      };
    }
    const project = matchingProjects[0];
    if (!project) {
      const changed = await this.quarantineRun(
        lease,
        run.run_id,
        "implementation",
        `Conductor project unavailable: ${repositoryIdentity}`
      );
      return { acted: true, active: true, reason: "quarantined missing project", runId: changed.run_id };
    }
    const matches = (await this.conductor.listProjectWorkspaces(project.id)).filter(
      (workspace) => workspace.name === workspaceName
    );
    if (matches.length > 1) {
      await this.pauseForSafety(lease, await this.store.snapshot(), `duplicate managed workspace for ${run.run_id}`);
      return { acted: true, active: true, reason: "paused on duplicate workspace", runId: run.run_id };
    }
    if (matches[0] && !conductorWorkspaceIsArchived(matches[0])) {
      const sessions = await this.conductor.listWorkspaceSessions(matches[0].id, {
        includeArchived: true,
      });
      const changed = await this.transition(lease, run, run.status, run.stage, {
        workspace_id: matches[0].id,
        workspace_name: matches[0].name,
        session_id: null,
        metadata: {
          ...run.metadata_json,
          adopted_by_tag: true,
          adopted_session_candidates: sessions.map((session) => session.id),
        },
      });
      return { acted: true, active: true, reason: "adopted managed workspace", runId: changed.run_id };
    }
    const sessionName = managedSessionName({
      laneId: lane.id,
      runId: run.run_id,
      stage: attempt.stage,
      attempt: attempt.attempt_number,
      provider,
    });
    const execution = await this.performAction({
      lease,
      run,
      stage: "implementation-workspace",
      attemptId: attempt.attempt_id,
      actionType: "create_workspace",
      request: {
        project_id: project.id,
        base_branch: lane.repository.base_branch,
        workspace_name: workspaceName,
        session_name: sessionName,
        provider,
        model: manifest.global.provider_models[provider],
      },
      mutate: async () => {
        const created = await this.conductor.createWorkspace({
          projectId: project.id,
          branch: lane.repository.base_branch,
          name: workspaceName,
          sessionName,
          agent: provider,
          model: manifest.global.provider_models[provider],
        });
        return {
          workspace_id: created.workspaceId,
          workspace_name: workspaceName,
          session_id: created.sessionId,
          session_name: sessionName,
          external_ref: created.deepLink,
        };
      },
    });
    if (execution.action.status === "succeeded" || execution.action.status === "reconciled") {
      await this.recordProviderSuccess(lease, provider);
      const fresh = await this.freshRun(run.run_id);
      if (execution.result.workspace_id) {
        const changed = await this.transition(lease, fresh.run, fresh.run.status, fresh.run.stage, {
          workspace_id: execution.result.workspace_id,
          workspace_name: execution.result.workspace_name ?? workspaceName,
          session_id: execution.result.session_id ?? null,
          metadata: {
            ...fresh.run.metadata_json,
            author_session_id: execution.result.session_id ?? null,
          },
        });
        return { acted: true, active: true, reason: "workspace bound", runId: changed.run_id };
      }
    }
    if (execution.action.status === "failed") {
      await this.failProviderAttempt(
        lease,
        run.run_id,
        attempt.attempt_id,
        execution.action.error ?? "workspace creation failed"
      );
    }
    return { acted: true, active: true, reason: `workspace action ${execution.action.status}`, runId: run.run_id };
  }

  private async ensureRoleSession(input: {
    lease: LeaseCredentials;
    manifest: LaneManifestV2;
    lane: ManifestLane;
    run: LaneRunRecord;
    attempt: LaneAttemptRecord;
  }): Promise<{ run: LaneRunRecord; sessionId: string; acted: boolean }> {
    if (!input.run.workspace_id) throw new Error("role session requires workspace binding");
    const stage = input.attempt.stage;
    const sessionName = managedSessionName({
      laneId: input.lane.id,
      runId: input.run.run_id,
      stage,
      attempt: input.attempt.attempt_number,
      provider: input.attempt.provider,
    });
    const sessions = await this.conductor.listWorkspaceSessions(input.run.workspace_id, {
      includeArchived: true,
    });
    const existing = sessions.filter((session) => session.name === sessionName);
    if (existing.length > 1) {
      await this.pauseForSafety(input.lease, await this.store.snapshot(), `duplicate role session ${sessionName}`);
      throw new Error(`duplicate role session ${sessionName}`);
    }
    if (existing[0] && !existing[0].archivedAt) {
      if (
        input.run.session_id === existing[0].id &&
        input.attempt.session_id === existing[0].id &&
        input.attempt.workspace_id === input.run.workspace_id
      ) {
        return { run: input.run, sessionId: existing[0].id, acted: false };
      }
      const fresh = await this.freshRun(input.run.run_id);
      const current = fresh.snapshot.attempts.find(
        (candidate) => candidate.attempt_id === input.attempt.attempt_id
      );
      if (!current) throw new Error(`attempt disappeared: ${input.attempt.attempt_id}`);
      await this.store.updateAttempt(input.lease, current.attempt_id, {
        expected_attempt_version: current.row_version,
        expected_run_version: fresh.run.row_version,
        status: current.status,
        workspace_id: input.run.workspace_id,
        session_id: existing[0].id,
        progress_cursor: current.progress_cursor ?? undefined,
        nudge_cursor: current.nudge_cursor ?? undefined,
        ineffective_nudges: current.ineffective_nudges,
        result: current.result_json,
      });
      const changed = await this.freshRun(input.run.run_id);
      return { run: changed.run, sessionId: existing[0].id, acted: true };
    }
    const execution = await this.performAction({
      lease: input.lease,
      run: input.run,
      stage: `${stage}-session`,
      attemptId: input.attempt.attempt_id,
      actionType: "create_session",
      request: {
        workspace_id: input.run.workspace_id,
        session_name: sessionName,
        provider: input.attempt.provider,
        model: input.manifest.global.provider_models[input.attempt.provider],
      },
      mutate: async () => {
        const session = await this.conductor.createSession({
          workspaceId: input.run.workspace_id!,
          name: sessionName,
          agent: input.attempt.provider,
          model: input.manifest.global.provider_models[input.attempt.provider],
        });
        return {
          session_id: session.id,
          session_name: sessionName,
          workspace_id: input.run.workspace_id,
          external_ref: session.deepLink,
        };
      },
    });
    if (!execution.result.session_id) {
      if (execution.action.status === "failed") {
        await this.failProviderAttempt(
          input.lease,
          input.run.run_id,
          input.attempt.attempt_id,
          execution.action.error ?? "session creation failed"
        );
      }
      return { run: input.run, sessionId: "", acted: true };
    }
    await this.recordProviderSuccess(input.lease, input.attempt.provider);
    const fresh = await this.freshRun(input.run.run_id);
    const current = fresh.snapshot.attempts.find(
      (candidate) => candidate.attempt_id === input.attempt.attempt_id
    );
    if (!current) throw new Error(`attempt disappeared: ${input.attempt.attempt_id}`);
    await this.store.updateAttempt(input.lease, current.attempt_id, {
      expected_attempt_version: current.row_version,
      expected_run_version: fresh.run.row_version,
      status: current.status,
      workspace_id: input.run.workspace_id,
      session_id: String(execution.result.session_id),
      progress_cursor: current.progress_cursor ?? undefined,
      nudge_cursor: current.nudge_cursor ?? undefined,
      ineffective_nudges: current.ineffective_nudges,
      result: current.result_json,
    });
    const changed = await this.freshRun(input.run.run_id);
    return { run: changed.run, sessionId: String(execution.result.session_id), acted: true };
  }

  private async beginRoleAttempt(input: {
    lease: LeaseCredentials;
    manifest: LaneManifestV2;
    lane: ManifestLane;
    run: LaneRunRecord;
    snapshot: LaneSnapshotV2;
    role: Role;
    provider: ManifestProvider;
    attemptNumber: number;
    sessionId?: string;
  }): Promise<LaneAttemptRecord> {
    const stage = roleStage(input.role, input.attemptNumber);
    return this.store.beginAttempt(input.lease, input.run.run_id, {
      attempt_id: deterministicLaneId("attempt", input.run.run_id, stage, input.attemptNumber, input.provider, input.run.head_sha ?? "none"),
      expected_run_version: input.run.row_version,
      stage,
      attempt_number: input.attemptNumber,
      role: input.role,
      provider: input.provider,
      model: input.manifest.global.provider_models[input.provider],
      nonce: deterministicLaneId("nonce", input.run.run_id, stage, input.attemptNumber, input.provider, input.run.head_sha ?? "none"),
      head_sha:
        input.role === "implementation"
          ? undefined
          : input.role === "validation"
            ? input.run.merged_sha ?? undefined
            : input.run.head_sha ?? undefined,
      workspace_id: input.run.workspace_id ?? undefined,
      session_id: input.sessionId,
    });
  }

  private async sendAttemptPrompt(input: {
    lease: LeaseCredentials;
    lane: ManifestLane;
    run: LaneRunRecord;
    attempt: LaneAttemptRecord;
    originalPrompt?: string;
  }): Promise<LaneControllerResult> {
    if (!input.attempt.session_id) throw new Error("attempt has no session binding");
    const messageId = deterministicUuid(input.attempt.attempt_id, "initial-prompt");
    const message = rolePrompt({
      role: input.attempt.role,
      run: input.run,
      lane: input.lane,
      attempt: input.attempt,
      originalPrompt: input.originalPrompt,
    });
    const messageHash = textHash(message);
    try {
      const existing = await this.conductor.getMessage(messageId);
      if (existing.id === messageId) {
        if (
          existing.sessionId !== input.attempt.session_id ||
          typeof existing.content !== "string" ||
          textHash(existing.content) !== messageHash
        ) {
          await this.pauseForSafety(
            input.lease,
            await this.store.snapshot(),
            `deterministic prompt message ${messageId} has mismatched content or session`
          );
          return {
            acted: true,
            active: true,
            reason: "paused on deterministic prompt mismatch",
            runId: input.run.run_id,
          };
        }
        const fresh = await this.freshRun(input.run.run_id);
        const current = fresh.snapshot.attempts.find(
          (attempt) => attempt.attempt_id === input.attempt.attempt_id
        )!;
        if (current.status === "commissioned") {
          await this.store.updateAttempt(input.lease, current.attempt_id, {
            expected_attempt_version: current.row_version,
            expected_run_version: fresh.run.row_version,
            status: "working",
            result: {},
          });
        }
        return { acted: true, active: true, reason: "adopted delivered prompt", runId: input.run.run_id };
      }
    } catch (error) {
      if (!(error instanceof ConductorApiError && error.status === 404)) {
        throw error;
      }
      // An explicitly absent deterministic message is safe to send after the
      // ledger intent begins. An uncertain lookup fails closed.
    }
    const execution = await this.performAction({
      lease: input.lease,
      run: input.run,
      stage: `${input.attempt.stage}-prompt`,
      attemptId: input.attempt.attempt_id,
      actionType: "send_prompt",
      request: {
        session_id: input.attempt.session_id,
        message_id: messageId,
        message_hash: messageHash,
        authorized_git_actions:
          input.attempt.role === "implementation"
            ? ["push_managed_branch", "create_or_update_bound_pr"]
            : [],
      },
      mutate: async () => {
        const delivered = await this.conductor.sendMessage({
          sessionId: input.attempt.session_id!,
          messageId,
          message,
        });
        return { message_id: delivered.messageId, state: delivered.state };
      },
    });
    if (execution.action.status === "succeeded" || execution.action.status === "reconciled") {
      await this.recordProviderSuccess(input.lease, input.attempt.provider);
      const fresh = await this.freshRun(input.run.run_id);
      const attempt = fresh.snapshot.attempts.find(
        (candidate) => candidate.attempt_id === input.attempt.attempt_id
      );
      if (attempt?.status === "commissioned") {
        await this.store.updateAttempt(input.lease, attempt.attempt_id, {
          expected_attempt_version: attempt.row_version,
          expected_run_version: fresh.run.row_version,
          status: "working",
          result: {},
        });
      }
    }
    if (execution.action.status === "failed") {
      await this.failProviderAttempt(
        input.lease,
        input.run.run_id,
        input.attempt.attempt_id,
        execution.action.error ?? "prompt delivery failed"
      );
    }
    return { acted: true, active: true, reason: `prompt ${execution.action.status}`, runId: input.run.run_id };
  }

  private async pollAttempt(input: {
    lease: LeaseCredentials;
    lane: ManifestLane;
    run: LaneRunRecord;
    attempt: LaneAttemptRecord;
  }): Promise<{ status: ConductorApiSessionStatus; messages: ConductorApiMessage[]; text: string; cursor: string | null }> {
    if (!input.attempt.session_id) throw new Error("attempt has no session");
    const [status, messages] = await Promise.all([
      this.conductor.getSessionStatus(input.attempt.session_id),
      this.conductor.getSessionMessageTail(
        input.attempt.session_id,
        input.attempt.role === "validation" ? 1_000 : 100
      ),
    ]);
    const orderedMessages = [...messages].sort(
      (left, right) =>
        left.sessionIndex - right.sessionIndex || left.id.localeCompare(right.id)
    );
    return {
      status,
      messages: orderedMessages,
      text: textForMessages(orderedMessages),
      cursor: lastProgressCursor(orderedMessages),
    };
  }

  private async updateProgressOrNudge(input: {
    lease: LeaseCredentials;
    run: LaneRunRecord;
    attempt: LaneAttemptRecord;
    polled: Awaited<ReturnType<LaneController["pollAttempt"]>>;
  }): Promise<LaneControllerResult> {
    const { run: freshRun, snapshot } = await this.freshRun(input.run.run_id);
    const attempt = snapshot.attempts.find(
      (candidate) => candidate.attempt_id === input.attempt.attempt_id
    )!;
    const replaceAttempt = async (cursor: string): Promise<LaneControllerResult> => {
      await this.store.updateAttempt(input.lease, attempt.attempt_id, {
        expected_attempt_version: attempt.row_version,
        expected_run_version: freshRun.row_version,
        status: "superseded",
        progress_cursor: cursor,
        nudge_cursor: attempt.nudge_cursor ?? cursor,
        ineffective_nudges: attempt.ineffective_nudges,
        result: { reason: "two ineffective nudges" },
      });
      const after = await this.freshRun(freshRun.run_id);
      await this.transition(input.lease, after.run, after.run.status, after.run.stage, {
        session_id: null,
      });
      return {
        acted: true,
        active: true,
        reason: "attempt replaced in workspace",
        runId: freshRun.run_id,
      };
    };
    if (input.polled.cursor && input.polled.cursor !== attempt.progress_cursor) {
      if (
        input.polled.status.status !== "working" &&
        attempt.ineffective_nudges >= 2 &&
        attempt.nudge_cursor
      ) {
        return replaceAttempt(input.polled.cursor);
      }
      const previousCursor = attempt.progress_cursor;
      const lastMessage = input.polled.messages.at(-1);
      const recoveredNudge = Boolean(
        previousCursor &&
          attempt.nudge_cursor !== previousCursor &&
          lastMessage?.id ===
            deterministicUuid(attempt.attempt_id, "nudge", previousCursor) &&
          lastMessage.sessionId === attempt.session_id &&
          typeof lastMessage.content === "string" &&
          textHash(lastMessage.content) === textHash(NUDGE_MESSAGE)
      );
      await this.store.updateAttempt(input.lease, attempt.attempt_id, {
        expected_attempt_version: attempt.row_version,
        expected_run_version: freshRun.row_version,
        status: input.polled.status.status === "working" ? "working" : "awaiting_result",
        progress_cursor: input.polled.cursor,
        nudge_cursor: recoveredNudge
          ? previousCursor ?? undefined
          : attempt.nudge_cursor ?? undefined,
        // A cursor advance permits one nudge at the new cursor, but a nudge is
        // only proven effective by the commissioned terminal result.
        ineffective_nudges:
          attempt.ineffective_nudges + (recoveredNudge ? 1 : 0),
        result: recoveredNudge
          ? { ...attempt.result_json, recovered_nudge_receipt: lastMessage!.id }
          : attempt.result_json,
      });
      return { acted: true, active: true, reason: "progress cursor recorded", runId: freshRun.run_id };
    }
    if (input.polled.status.status === "working") {
      return { acted: false, active: true, reason: "attempt working", runId: freshRun.run_id };
    }
    if (input.polled.status.status === "error") {
      await this.failProviderAttempt(
        input.lease,
        freshRun.run_id,
        attempt.attempt_id,
        input.polled.status.errorMessage ??
          input.polled.status.lastError ??
          "session error"
      );
      return { acted: true, active: true, reason: "attempt failed; provider rotated", runId: freshRun.run_id };
    }
    const cursor = input.polled.cursor ?? attempt.progress_cursor;
    if (!cursor) return { acted: false, active: true, reason: "idle without progress cursor", runId: freshRun.run_id };
    if (attempt.ineffective_nudges >= 2 && attempt.nudge_cursor === cursor) {
      return replaceAttempt(cursor);
    }
    if (attempt.nudge_cursor === cursor) {
      return { acted: false, active: true, reason: "cursor already nudged", runId: freshRun.run_id };
    }
    const messageId = deterministicUuid(attempt.attempt_id, "nudge", cursor);
    const message = NUDGE_MESSAGE;
    let observedMessage: ConductorApiMessage | null = null;
    try {
      const existing = await this.conductor.getMessage(messageId);
      if (
        existing.sessionId !== attempt.session_id ||
        typeof existing.content !== "string" ||
        textHash(existing.content) !== textHash(message)
      ) {
        await this.pauseForSafety(
          input.lease,
          await this.store.snapshot(),
          `deterministic nudge message ${messageId} has mismatched content or session`
        );
        return {
          acted: true,
          active: true,
          reason: "paused on deterministic nudge mismatch",
          runId: freshRun.run_id,
        };
      }
      observedMessage = existing;
    } catch (error) {
      if (!(error instanceof ConductorApiError && error.status === 404)) {
        throw error;
      }
    }
    const execution = await this.performAction({
      lease: input.lease,
      run: freshRun,
      stage: `${attempt.stage}-nudge`,
      attemptId: attempt.attempt_id,
      actionType: "nudge_session",
      request: {
        session_id: attempt.session_id,
        message_id: messageId,
        message_hash: textHash(message),
        progress_cursor: cursor,
      },
      mutate: async () => {
        if (observedMessage) {
          return {
            message_id: observedMessage.id,
            state: "sent",
            adopted: true,
          };
        }
        const delivered = await this.conductor.sendMessage({
          sessionId: attempt.session_id!,
          messageId,
          message,
        });
        return { message_id: delivered.messageId, state: delivered.state };
      },
    });
    if (execution.action.status === "succeeded" || execution.action.status === "reconciled") {
      await this.recordProviderSuccess(input.lease, attempt.provider);
      const latest = await this.freshRun(freshRun.run_id);
      const current = latest.snapshot.attempts.find(
        (candidate) => candidate.attempt_id === attempt.attempt_id
      )!;
      await this.store.updateAttempt(input.lease, current.attempt_id, {
        expected_attempt_version: current.row_version,
        expected_run_version: latest.run.row_version,
        status: "working",
        progress_cursor: cursor,
        nudge_cursor: cursor,
        ineffective_nudges: current.ineffective_nudges + 1,
        result: current.result_json,
      });
    }
    if (execution.action.status === "failed") {
      await this.failProviderAttempt(
        input.lease,
        freshRun.run_id,
        attempt.attempt_id,
        execution.action.error ?? "nudge delivery failed"
      );
    }
    return { acted: true, active: true, reason: `nudge ${execution.action.status}`, runId: freshRun.run_id };
  }

  private async advanceImplementation(
    lease: LeaseCredentials,
    snapshot: LaneSnapshotV2,
    manifest: LaneManifestV2,
    lane: ManifestLane,
    run: LaneRunRecord
  ): Promise<LaneControllerResult> {
    let attempt = activeAttempt(snapshot, run.run_id, "implementation");
    if (!attempt) {
      const provider = selectProvider({
        manifest,
        lane,
        snapshot,
        role: "implementation",
      });
      if (!provider) return { acted: false, active: true, reason: "implementation provider unavailable" };
      if (run.author_provider !== provider) {
        const changed = await this.transition(lease, run, run.status, run.stage, {
          author_provider: provider,
          provider,
          model: manifest.global.provider_models[provider],
        });
        return {
          acted: true,
          active: true,
          reason: "implementation provider rotated",
          runId: changed.run_id,
        };
      }
      const number = nextAttemptNumber(snapshot, run.run_id, "implementation");
      attempt = await this.beginRoleAttempt({
        lease,
        manifest,
        lane,
        run,
        snapshot,
        role: "implementation",
        provider,
        attemptNumber: number,
        sessionId:
          run.metadata_json.adopt_existing_session === true &&
          run.metadata_json.legacy_session_provider === provider &&
          run.workspace_id &&
          run.session_id
            ? run.session_id
            : undefined,
      });
      if (attempt.session_id && attempt.workspace_id === run.workspace_id) {
        const fresh = await this.freshRun(run.run_id);
        const current = fresh.snapshot.attempts.find(
          (candidate) => candidate.attempt_id === attempt!.attempt_id
        )!;
        await this.store.updateAttempt(lease, current.attempt_id, {
          expected_attempt_version: current.row_version,
          expected_run_version: fresh.run.row_version,
          status: "working",
          workspace_id: current.workspace_id ?? undefined,
          session_id: current.session_id ?? undefined,
          result: { adopted_legacy_session: true },
        });
        return {
          acted: true,
          active: true,
          reason: "verified legacy session resumed without prompt replay",
          runId: run.run_id,
        };
      }
      return { acted: true, active: true, reason: "implementation attempt commissioned", runId: run.run_id };
    }
    const workspace = await this.ensureWorkspace(lease, manifest, lane, run, attempt);
    if (workspace) return workspace;
    if (!attempt.session_id || attempt.workspace_id !== run.workspace_id) {
      const session = await this.ensureRoleSession({
        lease,
        manifest,
        lane,
        run,
        attempt,
      });
      return {
        acted: true,
        active: true,
        reason: session.sessionId ? "implementation session bound" : "implementation session action unresolved",
        runId: run.run_id,
      };
    }
    if (attempt.status === "commissioned") {
      let originalPrompt: string;
      try {
        originalPrompt = readVerifiedLanePrompt(manifest, lane);
      } catch (error) {
        await this.pauseForSafety(
          lease,
          await this.store.snapshot(),
          error instanceof Error ? error.message : String(error)
        );
        return {
          acted: true,
          active: true,
          reason: "paused on prompt integrity drift",
          runId: run.run_id,
        };
      }
      return this.sendAttemptPrompt({
        lease,
        lane,
        run,
        attempt,
        originalPrompt,
      });
    }
    const polled = await this.pollAttempt({ lease, lane, run, attempt });
    // A canonical URL can appear before the author has finished pushing or
    // updating the PR. Do not free the author slot or commission review work
    // until Conductor itself reports the purpose-built session idle.
    const prUrl =
      polled.status.status === "idle" ? extractBoundPr(polled.text, lane) : null;
    if (prUrl) {
      const policy = await this.gitHostForLane(lane).refreshPr(prUrl);
      const identity = deliveryPrIdentity(lane, policy.url);
      if (
        identity?.owner !== lane.repository.owner.toLowerCase() ||
        identity.repo !== lane.repository.name.toLowerCase() ||
        policy.baseBranch !== lane.repository.base_branch ||
        !policy.headBranch ||
        !policy.headSha ||
        policy.prNumber !== identity.number
      ) {
        const changed = await this.quarantineRun(
          lease,
          run.run_id,
          "pr",
          "candidate PR identity mismatch"
        );
        return { acted: true, active: true, reason: "quarantined mismatched PR", runId: changed.run_id };
      }
      const fresh = await this.freshRun(run.run_id);
      const current = fresh.snapshot.attempts.find(
        (candidate) => candidate.attempt_id === attempt!.attempt_id
      )!;
      await this.store.updateAttempt(lease, current.attempt_id, {
        expected_attempt_version: current.row_version,
        expected_run_version: fresh.run.row_version,
        status: "completed",
        progress_cursor: polled.cursor ?? undefined,
        result: { pr_url: policy.url, head_sha: policy.headSha },
      });
      const after = await this.freshRun(run.run_id);
      const changed = await this.transition(lease, after.run, "pr_bound", "pr", {
        pr_number: identity.number,
        pr_url: policy.url,
        head_branch: policy.headBranch,
        head_sha: policy.headSha,
        metadata: {
          ...after.run.metadata_json,
          author_session_id: attempt.session_id,
        },
      });
      const recordedBinding = await this.store.recordEvidence(
        lease,
        run.run_id,
        {
          evidence_id: deterministicLaneId(
            "evidence",
            "pr-binding",
            policy.url,
            policy.headSha
          ),
          external_key: `pr-binding:${run.run_id}:${policy.url}:${policy.headSha}`,
          expected_run_version: changed.row_version,
          attempt_id: attempt.attempt_id,
          evidence_type: "pr_binding",
          provider: attempt.provider,
          nonce: attempt.nonce,
          repo_owner: run.repo_owner,
          repo_name: run.repo_name,
          head_sha: policy.headSha,
          evidence: {
            owner: run.repo_owner,
            repo: run.repo_name,
            base_branch: run.base_branch,
            head_branch: policy.headBranch,
            head_sha: policy.headSha,
            pr_url: policy.url,
            pr_number: identity.number,
          },
        }
      );
      if (!evidenceWasAccepted(recordedBinding)) {
        await this.pauseForSafety(
          lease,
          await this.store.snapshot(),
          "PR binding evidence was rejected by the durable state gate"
        );
        return {
          acted: true,
          active: true,
          reason: "paused on rejected PR binding evidence",
          runId: changed.run_id,
        };
      }
      return { acted: true, active: true, reason: "PR bound", runId: changed.run_id };
    }
    return this.updateProgressOrNudge({ lease, run, attempt, polled });
  }

  private async advanceReviewOrFinal(
    lease: LeaseCredentials,
    snapshot: LaneSnapshotV2,
    manifest: LaneManifestV2,
    lane: ManifestLane,
    run: LaneRunRecord,
    role: "review" | "final"
  ): Promise<LaneControllerResult> {
    if (!run.pr_url || !run.head_sha) throw new Error(`${role} requires PR binding`);
    const gitHost = this.gitHostForLane(lane);
    const policy = await gitHost.refreshPr(run.pr_url);
    if (
      policy.headSha !== run.head_sha ||
      policy.headBranch !== run.head_branch ||
      policy.baseBranch !== run.base_branch ||
      policy.repoOwner !== run.repo_owner.toLowerCase() ||
      policy.repoName !== run.repo_name.toLowerCase()
    ) {
      if (policy.headSha && policy.headBranch === run.head_branch && policy.baseBranch === run.base_branch) {
        const current = await this.invalidateHeadAttempts(lease, run.run_id, policy.headSha);
        const restartReview = ["finals", "merging"].includes(current.status);
        const changed = await this.transition(
          lease,
          current,
          restartReview ? "reviewing" : current.status,
          restartReview ? "review" : current.stage,
          { head_sha: policy.headSha }
        );
        return { acted: true, active: true, reason: "new PR head invalidated attestations", runId: changed.run_id };
      }
      const changed = await this.quarantineRun(
        lease,
        run.run_id,
        role,
        "PR identity changed"
      );
      return { acted: true, active: true, reason: "quarantined PR drift", runId: changed.run_id };
    }
    if (policy.state !== "open" || policy.isDraft) {
      const changed = await this.quarantineRun(
        lease,
        run.run_id,
        role,
        policy.state === "merged"
          ? "PR merged outside commissioned lane gates"
          : "PR is not an open, reviewable head"
      );
      return {
        acted: true,
        active: true,
        reason: "quarantined non-reviewable PR",
        runId: changed.run_id,
      };
    }
    const completed = attemptsForRun(snapshot, run.run_id).filter(
      (attempt) =>
        attempt.role === role &&
        attempt.head_sha === run.head_sha &&
        attempt.status === "completed"
    );
    const changes = completed.find(
      (attempt) => attempt.result_json.verdict === "changes"
    );
    if (changes) {
      const changed = await this.transition(lease, run, "rework", "rework", {
        metadata: {
          ...run.metadata_json,
          rework_feedback: changes.result_json,
          resume_status: role === "review" ? "reviewing" : "finals",
        },
      });
      return { acted: true, active: true, reason: `${role} requested rework`, runId: changed.run_id };
    }
    const required = role === "review" ? 1 : 2;
    const approved = completed.filter(
      (attempt) => attempt.result_json.verdict === "approve"
    );
    if (approved.length >= required) {
      if (role === "review") {
        const changed = await this.transition(lease, run, "finals", "finals");
        return { acted: true, active: true, reason: "adversarial review approved", runId: changed.run_id };
      }
      const recorded = await this.recordMergeEvidence(lease, run, policy, lane);
      if (recorded) return recorded;
      const current = await this.freshRun(run.run_id);
      const changed = await this.transition(lease, current.run, "merging", "merge");
      return { acted: true, active: true, reason: "merge gates satisfied", runId: changed.run_id };
    }
    let attempt = activeAttempt(snapshot, run.run_id, role);
    if (!attempt) {
      const used = new Set(
        completed.map((candidate) => candidate.provider)
      );
      const provider = selectProvider({
        manifest,
        lane,
        snapshot,
        role,
        authorProvider: run.author_provider,
        excluded: used,
      });
      if (!provider) return { acted: false, active: true, reason: `${role} provider unavailable` };
      const number = nextAttemptNumber(snapshot, run.run_id, role);
      attempt = await this.beginRoleAttempt({
        lease,
        manifest,
        lane,
        run,
        snapshot,
        role,
        provider,
        attemptNumber: number,
      });
      return { acted: true, active: true, reason: `${role} attempt commissioned`, runId: run.run_id };
    }
    const workspace = await this.ensureWorkspace(lease, manifest, lane, run, attempt);
    if (workspace) return workspace;
    if (!attempt.session_id || attempt.workspace_id !== run.workspace_id) {
      const session = await this.ensureRoleSession({
        lease,
        manifest,
        lane,
        run,
        attempt,
      });
      return {
        acted: true,
        active: true,
        reason: session.sessionId ? `${role} session bound` : `${role} session action unresolved`,
        runId: run.run_id,
      };
    }
    if (attempt.status === "commissioned") {
      return this.sendAttemptPrompt({ lease, lane, run, attempt });
    }
    const polled = await this.pollAttempt({ lease, lane, run, attempt });
    // Transcript content is advisory while the commissioned session is still
    // working. Waiting for the terminal idle state prevents a reviewer from
    // racing a still-running author/reviewer in the shared workspace.
    const marker =
      polled.status.status === "idle"
        ? exactReviewMarker({ attempt, run, text: polled.text })
        : null;
    if (!marker) return this.updateProgressOrNudge({ lease, run, attempt, polled });
    const tag = `[lane-attestation:${attempt.nonce}]`;
    const body = `${marker.raw}\n${tag}\n\n${String(marker.data.summary ?? "Commissioned review completed.")}`;
    const bodyHash = textHash(body);
    const alreadyPublished = policy.reviews.some(
      (review) =>
        review.commitSha === run.head_sha &&
        review.body.includes(tag) &&
        textHash(review.body) === bodyHash
    );
    if (!alreadyPublished) {
      const fresh = await this.freshRun(run.run_id);
      const execution = await this.performAction({
        lease,
        run: fresh.run,
        stage: `${attempt.stage}-attestation`,
        attemptId: attempt.attempt_id,
        actionType: "post_attestation",
        request: {
          pr_url: run.pr_url,
          head_sha: run.head_sha,
          attestation_tag: tag,
          attestation_body_hash: bodyHash,
          nonce: attempt.nonce,
          provider: attempt.provider,
        },
        mutate: async () => {
          const receipt = await gitHost.postReview(run.pr_url!, body, run.head_sha!);
          return {
            posted: true,
            review_id: receipt.reviewId,
            commit_sha: receipt.commitSha,
            attestation_tag: tag,
            attestation_body_hash: bodyHash,
          };
        },
      });
      if (
        execution.action.status !== "succeeded" &&
        execution.action.status !== "reconciled"
      ) {
        return {
          acted: true,
          active: true,
          reason: `attestation ${execution.action.status}`,
          runId: run.run_id,
        };
      }
    }
    const afterPost = await this.freshRun(run.run_id);
    const evidenceType = role === "review" ? "adversarial_review" : "final_attestation";
    const recordedAttestation = await this.store.recordEvidence(lease, run.run_id, {
      evidence_id: deterministicLaneId("evidence", attempt.attempt_id, evidenceType),
      external_key: `github-review:${attempt.nonce}:${run.head_sha}`,
      expected_run_version: afterPost.run.row_version,
      attempt_id: attempt.attempt_id,
      evidence_type: evidenceType,
      provider: attempt.provider,
      nonce: attempt.nonce,
      repo_owner: run.repo_owner,
      repo_name: run.repo_name,
      head_sha: run.head_sha,
      evidence: {
        verdict: marker.verdict,
        nonce: attempt.nonce,
        run: run.run_id,
        stage: role,
        head_sha: run.head_sha,
        provider: attempt.provider,
        github_attestation_tag: tag,
        attestation_body_hash: bodyHash,
      },
    });
    if (marker.verdict === "approve" && !evidenceWasAccepted(recordedAttestation)) {
      await this.pauseForSafety(
        lease,
        await this.store.snapshot(),
        `commissioned ${role} attestation was rejected by the durable state gate`
      );
      return {
        acted: true,
        active: true,
        reason: "paused on rejected attestation evidence",
        runId: run.run_id,
      };
    }
    const beforeComplete = await this.freshRun(run.run_id);
    const currentAttempt = beforeComplete.snapshot.attempts.find(
      (candidate) => candidate.attempt_id === attempt!.attempt_id
    )!;
    await this.store.updateAttempt(lease, currentAttempt.attempt_id, {
      expected_attempt_version: currentAttempt.row_version,
      expected_run_version: beforeComplete.run.row_version,
      status: "completed",
      progress_cursor: polled.cursor ?? undefined,
      result: { verdict: marker.verdict, marker: marker.raw, summary: marker.data.summary ?? "" },
    });
    return { acted: true, active: true, reason: `${role} attested`, runId: run.run_id };
  }

  private async recordMergeEvidence(
    lease: LeaseCredentials,
    run: LaneRunRecord,
    policy: GithubPrPolicySnapshot,
    lane: ManifestLane
  ): Promise<LaneControllerResult | null> {
    const checksGate = requiredChecksGate(
      policy,
      lane.delivery_adapter.required_checks ?? []
    );
    const checksPayload = {
      all_green: checksGate.passing,
      pending: checksGate.missing.length + checksGate.pending.length,
      failed: checksGate.failed.length,
      summary: policy.checksSummary,
      required_checks: lane.delivery_adapter.required_checks ?? [],
      missing_required_checks: checksGate.missing,
      nonpassing_required_checks: checksGate.notPassing,
    };
    const mergeabilityPayload = {
      mergeable:
        policy.mergeable?.toUpperCase() === "MERGEABLE" &&
        ["CLEAN", "HAS_HOOKS"].includes(
          policy.mergeStateStatus?.toUpperCase() ?? ""
        ),
      mergeable_state: policy.mergeable,
      merge_state_status: policy.mergeStateStatus,
    };
    const evidence = [
      {
        type: "required_checks",
        key: `git-checks:${run.run_id}:${run.head_sha}:${textHash(JSON.stringify(checksPayload))}`,
        payload: checksPayload,
      },
      {
        type: "mergeability",
        key: `git-mergeability:${run.run_id}:${run.head_sha}:${textHash(JSON.stringify(mergeabilityPayload))}`,
        payload: mergeabilityPayload,
      },
    ];
    for (const item of evidence) {
      const fresh = await this.freshRun(run.run_id);
      const recorded = await this.store.recordEvidence(lease, run.run_id, {
        evidence_id: deterministicLaneId("evidence", item.key),
        external_key: item.key,
        expected_run_version: fresh.run.row_version,
        evidence_type: item.type,
        repo_owner: run.repo_owner,
        repo_name: run.repo_name,
        head_sha: run.head_sha!,
        evidence: item.payload,
      });
      const expectedAccepted =
        (item.type === "required_checks" && checksGate.passing) ||
        (item.type === "mergeability" && mergeabilityPayload.mergeable);
      if (expectedAccepted && !evidenceWasAccepted(recorded)) {
        await this.pauseForSafety(
          lease,
          await this.store.snapshot(),
          `${item.type} evidence was rejected by the durable state gate`
        );
        return {
          acted: true,
          active: true,
          reason: `paused on rejected ${item.type} evidence`,
          runId: run.run_id,
        };
      }
    }
    if (!checksGate.passing) {
      const detail = checksGate.missing.length
        ? `missing ${checksGate.missing.join(", ")}`
        : checksGate.notPassing.length
          ? `not passing ${checksGate.notPassing.join(", ")}`
          : policy.checksStatus;
      return { acted: false, active: true, reason: `required checks ${detail}`, runId: run.run_id };
    }
    if (policy.state !== "open" || policy.isDraft) {
      return {
        acted: false,
        active: true,
        reason: policy.isDraft ? "PR is draft" : `PR is ${policy.state}`,
        runId: run.run_id,
      };
    }
    if (
      policy.mergeable?.toUpperCase() !== "MERGEABLE" ||
      !["CLEAN", "HAS_HOOKS"].includes(policy.mergeStateStatus?.toUpperCase() ?? "")
    ) {
      return { acted: false, active: true, reason: "PR not mergeable", runId: run.run_id };
    }
    return null;
  }

  private async advanceMerge(
    lease: LeaseCredentials,
    snapshot: LaneSnapshotV2,
    lane: ManifestLane,
    run: LaneRunRecord
  ): Promise<LaneControllerResult> {
    if (!run.pr_url || !run.head_sha) throw new Error("merge requires bound PR");
    if (!run.merged_sha) {
      const gitHost = this.gitHostForLane(lane);
      const policy = await gitHost.refreshPr(run.pr_url);
      if (policy.state === "merged" && policy.mergeCommitSha) {
        if (policy.headSha !== run.head_sha) {
          const changed = await this.quarantineRun(
            lease,
            run.run_id,
            "merge",
            "merged PR head differs from the commissioned expected SHA"
          );
          return {
            acted: true,
            active: true,
            reason: "quarantined externally changed merge",
            runId: changed.run_id,
          };
        }
        const execution = await this.performAction({
          lease,
          run,
          stage: "merge",
          actionType: "merge_pr",
          request: { pr_url: run.pr_url, expected_head_sha: run.head_sha },
          mutate: async () => ({ merged_sha: policy.mergeCommitSha!, adopted: true }),
        });
        return { acted: true, active: true, reason: `adopted merge ${execution.action.status}`, runId: run.run_id };
      }
      if (
        policy.state !== "open" ||
        policy.isDraft ||
        policy.headSha !== run.head_sha ||
        !requiredChecksGate(
          policy,
          lane.delivery_adapter.required_checks ?? []
        ).passing ||
        policy.mergeable?.toUpperCase() !== "MERGEABLE" ||
        !["CLEAN", "HAS_HOOKS"].includes(policy.mergeStateStatus?.toUpperCase() ?? "")
      ) {
        return { acted: false, active: true, reason: "merge gate changed", runId: run.run_id };
      }
      const execution = await this.performAction({
        lease,
        run,
        stage: "merge",
        actionType: "merge_pr",
        request: {
          pr_url: run.pr_url,
          expected_head_sha: run.head_sha,
          method: lane.merge_policy.method,
        },
        mutate: async () => {
          const merged = await gitHost.merge({
            prUrl: run.pr_url!,
            method: lane.merge_policy.method,
            expectedHeadSha: run.head_sha!,
          });
          return { merged_sha: merged.mergedSha, external_ref: run.pr_url! };
        },
      });
      return { acted: true, active: true, reason: `merge ${execution.action.status}`, runId: run.run_id };
    }
    const noticeTag = `[lane-merge:${run.run_id}:${run.merged_sha}]`;
    if (!Boolean(run.metadata_json.merge_notice_posted)) {
      const gitHost = this.gitHostForLane(lane);
      const finalNotes = attemptsForRun(snapshot, run.run_id)
        .filter(
          (attempt) =>
            attempt.role === "final" &&
            attempt.head_sha === run.head_sha &&
            attempt.status === "completed" &&
            attempt.result_json.verdict === "approve"
        )
        .slice(0, 2)
        .map((attempt) => {
          const summary = String(
            attempt.result_json.summary || "Approved the commissioned current-head diff."
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 500);
          return `- ${attempt.provider}/${attempt.model}: ${summary}`;
        });
      const copyProductNotes =
        finalNotes.length > 0
          ? finalNotes.join("\n")
          : "- No additional copy/product note was supplied.";
      const body = `MERGED BY AGENTS\n${noticeTag}\n\nMerged SHA: ${run.merged_sha}\nCopy/product notes:\n${copyProductNotes}\nDeployment notes: ${lane.merge_policy.deploy_notes || "Observe repository-native CI only; no deployment was invoked."}\nReplay notes: ${lane.merge_policy.replay_notes || "None."}`;
      const bodyHash = textHash(body);
      const alreadyPosted = await gitHost.hasCommentTag(
        run.pr_url,
        noticeTag,
        bodyHash
      );
      const execution = await this.performAction({
        lease,
        run,
        stage: "merge-notice",
        actionType: "post_notice",
        request: {
          pr_url: run.pr_url,
          notice_tag: noticeTag,
          notice_body_hash: bodyHash,
        },
        mutate: async () => {
          if (!alreadyPosted) {
            await gitHost.postComment(run.pr_url!, body);
          }
          return {
            posted: true,
            notice_tag: noticeTag,
            notice_body_hash: bodyHash,
            adopted: alreadyPosted,
          };
        },
      });
      if (execution.action.status === "succeeded" || execution.action.status === "reconciled") {
        const fresh = await this.freshRun(run.run_id);
        await this.transition(lease, fresh.run, fresh.run.status, fresh.run.stage, {
          metadata: { ...fresh.run.metadata_json, merge_notice_posted: true },
        });
      }
      return { acted: true, active: true, reason: `merge notice ${execution.action.status}`, runId: run.run_id };
    }
    const fresh = await this.freshRun(run.run_id);
    const changed = await this.transition(lease, fresh.run, "validating", "validation");
    return { acted: true, active: true, reason: "validation stage entered", runId: changed.run_id };
  }

  private async advanceValidation(
    lease: LeaseCredentials,
    snapshot: LaneSnapshotV2,
    manifest: LaneManifestV2,
    lane: ManifestLane,
    run: LaneRunRecord
  ): Promise<LaneControllerResult> {
    if (!run.merged_sha || !FULL_SHA_RE.test(run.merged_sha)) {
      throw new Error("validation requires merged SHA");
    }
    const checks = await this.gitHostForLane(lane).refreshCommitChecks({
      repoOwner: run.repo_owner,
      repoName: run.repo_name,
      sha: run.merged_sha,
    });
    if (
      checks.repoOwner !== run.repo_owner.toLowerCase() ||
      checks.repoName !== run.repo_name.toLowerCase() ||
      checks.sha.toLowerCase() !== run.merged_sha.toLowerCase()
    ) {
      const current = await this.freshRun(run.run_id);
      const changed = await this.quarantineRun(
        lease,
        current.run.run_id,
        "validation",
        "merged-SHA check response identity mismatch"
      );
      return {
        acted: true,
        active: true,
        reason: "quarantined mismatched merged-SHA checks",
        runId: changed.run_id,
      };
    }
    const freshForCi = await this.freshRun(run.run_id);
    const ciPayload = {
      all_green: checks.status === "passing",
      pending: checks.status === "pending" ? 1 : 0,
      failed: checks.status === "failing" ? 1 : 0,
      summary: checks.summary,
    };
    const recordedCi = await this.store.recordEvidence(lease, run.run_id, {
      evidence_id: deterministicLaneId(
        "evidence",
        "merged-ci",
        run.run_id,
        run.merged_sha,
        JSON.stringify(ciPayload)
      ),
      external_key: `git-merged-ci:${run.run_id}:${run.merged_sha}:${textHash(JSON.stringify(ciPayload))}`,
      expected_run_version: freshForCi.run.row_version,
      evidence_type: "merged_ci",
      repo_owner: run.repo_owner,
      repo_name: run.repo_name,
      head_sha: run.merged_sha!,
      evidence: ciPayload,
    });
    if (checks.status === "pending") {
      return { acted: false, active: true, reason: "merged SHA CI pending", runId: run.run_id };
    }
    if (checks.status === "failing") {
      const current = await this.freshRun(run.run_id);
      const changed = await this.transition(lease, current.run, "rework", "repair", {
        metadata: { ...current.run.metadata_json, repair_reason: "merged SHA CI failed" },
      });
      return { acted: true, active: true, reason: "repair attempt required", runId: changed.run_id };
    }
    if (checks.status !== "passing") {
      return {
        acted: false,
        active: true,
        reason: "merged SHA CI unavailable",
        runId: run.run_id,
      };
    }
    if (!evidenceWasAccepted(recordedCi)) {
      await this.pauseForSafety(
        lease,
        await this.store.snapshot(),
        "merged-SHA CI evidence was rejected by the durable state gate"
      );
      return {
        acted: true,
        active: true,
        reason: "paused on rejected merged-SHA CI evidence",
        runId: run.run_id,
      };
    }
    snapshot = await this.store.snapshot();
    run = snapshot.runs.find((candidate) => candidate.run_id === run.run_id) ?? run;
    const completed = attemptsForRun(snapshot, run.run_id).find(
      (attempt) =>
        attempt.role === "validation" &&
        attempt.head_sha === run.merged_sha &&
        attempt.status === "completed" &&
        attempt.result_json.passed === true
    );
    if (completed) {
      const current = await this.freshRun(run.run_id);
      const changed = await this.transition(lease, current.run, "validated", "terminal");
      return { acted: true, active: false, reason: "lane validated", runId: changed.run_id };
    }
    let attempt = activeAttempt(snapshot, run.run_id, "validation");
    if (!attempt) {
      const provider = selectProvider({
        manifest,
        lane,
        snapshot,
        role: "validation",
        authorProvider: run.author_provider,
      });
      if (!provider) return { acted: false, active: true, reason: "validation provider unavailable" };
      const number = nextAttemptNumber(snapshot, run.run_id, "validation");
      attempt = await this.beginRoleAttempt({
        lease,
        manifest,
        lane,
        run,
        snapshot,
        role: "validation",
        provider,
        attemptNumber: number,
      });
      return { acted: true, active: true, reason: "validation commissioned", runId: run.run_id };
    }
    const workspace = await this.ensureWorkspace(lease, manifest, lane, run, attempt);
    if (workspace) return workspace;
    if (!attempt.session_id || attempt.workspace_id !== run.workspace_id) {
      const session = await this.ensureRoleSession({
        lease,
        manifest,
        lane,
        run,
        attempt,
      });
      return {
        acted: true,
        active: true,
        reason: session.sessionId ? "validation session bound" : "validation session action unresolved",
        runId: run.run_id,
      };
    }
    if (attempt.status === "commissioned") return this.sendAttemptPrompt({ lease, lane, run, attempt });
    const polled = await this.pollAttempt({ lease, lane, run, attempt });
    const failedValidation =
      polled.status.status === "idle"
        ? exactFailedValidationMarker({
            attempt,
            run,
            lane,
            text: polled.text,
            messages: polled.messages,
          })
        : null;
    if (failedValidation) {
      const beforeFailure = await this.freshRun(run.run_id);
      const currentAttempt = beforeFailure.snapshot.attempts.find(
        (candidate) => candidate.attempt_id === attempt!.attempt_id
      )!;
      await this.store.updateAttempt(lease, currentAttempt.attempt_id, {
        expected_attempt_version: currentAttempt.row_version,
        expected_run_version: beforeFailure.run.row_version,
        status: "failed",
        progress_cursor: polled.cursor ?? undefined,
        result: {
          passed: false,
          marker: failedValidation.marker.raw,
          evidence: failedValidation.marker.data,
          source: "conductor_tool_events",
          receipts: failedValidation.receipts,
        },
      });
      const beforeRepair = await this.freshRun(run.run_id);
      const changed = await this.transition(
        lease,
        beforeRepair.run,
        "rework",
        "repair",
        {
          metadata: {
            ...beforeRepair.run.metadata_json,
            validation_failure: {
              ...failedValidation.marker.data,
              source: "conductor_tool_events",
              receipts: failedValidation.receipts,
            },
          },
        }
      );
      return {
        acted: true,
        active: true,
        reason: "validation failed; repair attempt required",
        runId: changed.run_id,
      };
    }
    const validation =
      polled.status.status === "idle"
        ? exactValidationMarker({
            attempt,
            run,
            lane,
            text: polled.text,
            messages: polled.messages,
          })
        : null;
    if (!validation) return this.updateProgressOrNudge({ lease, run, attempt, polled });
    const beforeEvidence = await this.freshRun(run.run_id);
    const recordedValidation = await this.store.recordEvidence(lease, run.run_id, {
      evidence_id: deterministicLaneId("evidence", "validation", attempt.attempt_id, run.merged_sha),
      external_key: `validation:${attempt.nonce}:${run.merged_sha}`,
      expected_run_version: beforeEvidence.run.row_version,
      attempt_id: attempt.attempt_id,
      evidence_type: "deterministic_validation",
      provider: attempt.provider,
      nonce: attempt.nonce,
      repo_owner: run.repo_owner,
      repo_name: run.repo_name,
      head_sha: run.merged_sha!,
      evidence: {
        nonce: attempt.nonce,
        run: run.run_id,
        stage: "validation",
        head_sha: run.merged_sha,
        merged_sha: run.merged_sha,
        provider: attempt.provider,
        passed: true,
        source: "conductor_tool_events",
        commands: validation.marker.data.commands,
        probes: validation.marker.data.probes,
        receipts: validation.receipts,
      },
    });
    if (!evidenceWasAccepted(recordedValidation)) {
      await this.pauseForSafety(
        lease,
        await this.store.snapshot(),
        "deterministic validation receipts were rejected by the durable state gate"
      );
      return {
        acted: true,
        active: true,
        reason: "paused on rejected validation evidence",
        runId: run.run_id,
      };
    }
    const beforeComplete = await this.freshRun(run.run_id);
    const current = beforeComplete.snapshot.attempts.find(
      (candidate) => candidate.attempt_id === attempt!.attempt_id
    )!;
    await this.store.updateAttempt(lease, current.attempt_id, {
      expected_attempt_version: current.row_version,
      expected_run_version: beforeComplete.run.row_version,
      status: "completed",
      progress_cursor: polled.cursor ?? undefined,
      result: {
        passed: true,
        marker: validation.marker.raw,
        evidence: validation.marker.data,
        source: "conductor_tool_events",
        receipts: validation.receipts,
      },
    });
    return { acted: true, active: true, reason: "deterministic validation recorded", runId: run.run_id };
  }

  private async createNextRun(
    lease: LeaseCredentials,
    snapshot: LaneSnapshotV2,
    manifest: LaneManifestV2
  ): Promise<LaneControllerResult | null> {
    const candidates = manifest.lanes
      .map((lane) => ({ lane, generation: laneGenerationDue({ lane, runs: snapshot.runs, now: this.now() }) }))
      .filter(
        ({ lane, generation }) =>
          generation.due && snapshot.dependencies[lane.id]?.ready !== false
      )
      .sort((left, right) => {
        if (left.generation.recurring !== right.generation.recurring) {
          return left.generation.recurring ? 1 : -1;
        }
        return right.lane.priority - left.lane.priority;
      });
    const candidate = candidates[0];
    if (!candidate || !snapshot.manifest) return null;
    const run = await this.store.createRun(lease, {
      run_id: deterministicLaneId(
        "run",
        snapshot.manifest.revision_id,
        candidate.lane.id,
        candidate.generation.generation
      ),
      manifest_revision_id: snapshot.manifest.revision_id,
      lane_id: candidate.lane.id,
      generation: candidate.generation.generation,
      priority: candidate.lane.priority,
      metadata: { created_by: "durable-controller", recurring: candidate.generation.recurring },
    });
    return { acted: true, active: true, reason: "lane generation queued", runId: run.run_id };
  }

  private async archiveTerminal(
    lease: LeaseCredentials,
    snapshot: LaneSnapshotV2
  ): Promise<LaneControllerResult | null> {
    for (const run of snapshot.runs) {
      if (!TERMINAL_RUN_STATUSES.has(run.status) || !run.workspace_id) continue;
      if (run.metadata_json.workspace_archived === true) continue;
      const terminalAt = Date.parse(run.terminal_at ?? run.updated_at);
      if (!Number.isFinite(terminalAt) || terminalAt + ARCHIVE_GRACE_MS > this.now().getTime()) continue;
      if (
        !recognizedManagedWorkspace(run) &&
        !run.legacy_verified &&
        !archiveApprovalIsActive(run, this.now())
      ) {
        const workspaceIds = snapshot.runs
          .filter((candidate) => {
            const candidateTerminalAt = Date.parse(
              candidate.terminal_at ?? candidate.updated_at
            );
            return (
              TERMINAL_RUN_STATUSES.has(candidate.status) &&
              Boolean(candidate.workspace_id) &&
              !recognizedManagedWorkspace(candidate) &&
              !candidate.legacy_verified &&
              !archiveApprovalIsActive(candidate, this.now()) &&
              Number.isFinite(candidateTerminalAt) &&
              candidateTerminalAt + ARCHIVE_GRACE_MS <= this.now().getTime()
            );
          })
          .map((candidate) => candidate.workspace_id!)
          .sort();
        await this.notify(
          `Legacy untagged workspaces await one expiring archive approval (${workspaceIds.length}): ${workspaceIds.join(", ")}. Use /lanes archive-approval batch.`,
          `archive-approval:${deterministicLaneId("batch", ...workspaceIds)}`
        );
        return null;
      }
      try {
        const workspace = await this.conductor.getWorkspaceStatus(run.workspace_id);
        if (workspace.status === "archived") {
          const current = await this.freshRun(run.run_id);
          const changed = await this.transition(
            lease,
            current.run,
            current.run.status,
            current.run.stage,
            {
              metadata: {
                ...current.run.metadata_json,
                workspace_archived: true,
                archive_reconciled: true,
              },
            }
          );
          return {
            acted: true,
            active: false,
            reason: "archive already reconciled",
            runId: changed.run_id,
          };
        }
      } catch (error) {
        if (!(error instanceof ConductorApiError && error.status === 404)) {
          throw error;
        }
        const current = await this.freshRun(run.run_id);
        const changed = await this.transition(
          lease,
          current.run,
          current.run.status,
          current.run.stage,
          {
            metadata: {
              ...current.run.metadata_json,
              workspace_archived: true,
              archive_reconciled: true,
              workspace_missing: true,
            },
          }
        );
        return {
          acted: true,
          active: false,
          reason: "missing terminal workspace reconciled",
          runId: changed.run_id,
        };
      }
      const sessions = await this.conductor.listWorkspaceSessions(run.workspace_id, {
        includeArchived: true,
      });
      let working = false;
      for (const session of sessions.filter((candidate) => !candidate.archivedAt)) {
        try {
          if ((await this.conductor.getSessionStatus(session.id)).status === "working") working = true;
        } catch {
          working = true;
        }
      }
      const fresh = await this.freshRun(run.run_id);
      const workspaceEvidence = {
        workspace_id: run.workspace_id,
        archived: false,
        unusable: false,
        working_session: working,
        grace_period_elapsed: true,
      };
      await this.store.recordEvidence(lease, run.run_id, {
        evidence_id: deterministicLaneId(
          "evidence",
          "archive",
          run.run_id,
          terminalAt,
          fresh.run.row_version,
          JSON.stringify(workspaceEvidence)
        ),
        external_key:
          `workspace-state:${run.workspace_id}:archive:${terminalAt}:` +
          `v${fresh.run.row_version}:${textHash(JSON.stringify(workspaceEvidence))}`,
        expected_run_version: fresh.run.row_version,
        evidence_type: "workspace_state",
        repo_owner: run.repo_owner,
        repo_name: run.repo_name,
        head_sha: run.head_sha ?? run.merged_sha ?? "0".repeat(40),
        evidence: workspaceEvidence,
      });
      if (working) {
        await this.pauseForSafety(
          lease,
          await this.store.snapshot(),
          `terminal workspace ${run.workspace_id} still has a working session`
        );
        return {
          acted: true,
          active: true,
          reason: "paused on unsafe archive candidate",
          runId: run.run_id,
        };
      }
      const beforeAction = await this.freshRun(run.run_id);
      const execution = await this.performAction({
        lease,
        run: beforeAction.run,
        stage: "hygiene",
        actionType: "archive_workspace",
        request: { workspace_id: run.workspace_id, workspace_name: run.workspace_name },
        mutate: async () => {
          try {
            const currentSessions = await this.conductor.listWorkspaceSessions(
              run.workspace_id!,
              { includeArchived: true }
            );
            for (const session of currentSessions.filter(
              (candidate) => !candidate.archivedAt
            )) {
              if (
                (await this.conductor.getSessionStatus(session.id)).status ===
                "working"
              ) {
                throw new NoExternalMutationError(
                  `archive preflight found working session ${session.id}`
                );
              }
            }
          } catch (error) {
            if (error instanceof NoExternalMutationError) throw error;
            throw new NoExternalMutationError(
              `archive preflight could not prove every session idle: ${
                error instanceof Error ? error.message : error
              }`
            );
          }
          const archived = await this.conductor.archiveWorkspace(run.workspace_id!);
          return { workspace_id: archived.workspaceId, archived: true };
        },
      });
      if (
        execution.action.status === "failed" &&
        String(execution.action.error ?? "").startsWith("archive preflight ")
      ) {
        await this.pauseForSafety(
          lease,
          await this.store.snapshot(),
          `terminal workspace ${run.workspace_id} became unsafe during archive preflight`
        );
        return {
          acted: true,
          active: true,
          reason: "paused on archive preflight race",
          runId: run.run_id,
        };
      }
      if (execution.action.status === "succeeded" || execution.action.status === "reconciled") {
        const after = await this.freshRun(run.run_id);
        await this.transition(lease, after.run, after.run.status, after.run.stage, {
          metadata: { ...after.run.metadata_json, workspace_archived: true },
        });
      }
      return { acted: true, active: false, reason: `archive ${execution.action.status}`, runId: run.run_id };
    }
    return null;
  }
}

export function asConductorLaneGateway(client: ConductorApiClient): ConductorLaneGateway {
  return client;
}
