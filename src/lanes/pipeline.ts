import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  canMergePr,
  githubPrIdentity,
  refreshCommitChecks,
  refreshPrByUrl,
  type GithubCommitChecksSnapshot,
  type GithubPrPolicySnapshot,
} from "../bot/github.js";
import {
  conductorWorkspaceIsArchived,
  type ConductorApiClient,
  type ConductorApiMessage,
  type ConductorApiSession,
  type ConductorApiWorkspace,
} from "../integrations/conductor-api.js";
import {
  getLaneDeliveryState,
  getLaneProviderOutages,
  observeLaneSession,
  recordLaneAction,
  recordLaneSessionNudge,
  setLaneDeliveryState,
  setLaneProviderOutage,
} from "../store/queries.js";
import type {
  LaneConfig,
  LaneDeliveryConfig,
  LaneStageConfig,
  LanesConfig,
} from "./config.js";
import {
  assistantTextFromTranscriptEvent,
  githubPrUrlMatchesRepo,
  type LaneSnapshot,
} from "./decide.js";
import { rawExecutionReceipts } from "./validation-evidence.js";

export type DeliveryStage =
  | "review"
  | "review_fixes"
  | "finals"
  | "final_fixes"
  | "merge"
  | "validation"
  | "complete"
  | "validation_failed";

export type FinalVerdict = "approve" | "changes";

export type DeliveryRun = {
  role: "review" | "final" | "merge" | "validation";
  workspaceId: string;
  sessionId: string;
  provider: string;
  model: string;
  startedAt: string;
  nonce: string;
  commissionedHeadSha: string;
  round?: number;
  slot?: number;
  completedAt?: string;
  verdict?: FinalVerdict;
  marker?: string;
};

export type LaneDeliveryState = {
  version: 1;
  runId: string;
  laneId: string;
  prUrl: string;
  prOwner: string;
  prRepo: string;
  prNumber: number;
  headBranch: string;
  headSha: string;
  authorProvider: string;
  authorTurnAt: string;
  stage: DeliveryStage;
  round: number;
  feedbackSentAt?: string;
  feedbackMessageId?: string;
  review?: DeliveryRun;
  finals: DeliveryRun[];
  merge?: DeliveryRun;
  validation?: DeliveryRun;
  mergeHeadSha?: string;
  mergedSha?: string;
  validationResult?: "passed" | "failed";
};

export type FinalReviewMarker = {
  model: string;
  verdict: FinalVerdict;
  data: Record<string, unknown>;
  raw: string;
};

export type ReviewAttestationMarker = FinalReviewMarker & {
  kind: "review" | "final";
};

export type ValidationMarker = {
  result: "passed" | "failed";
  model: string;
  data: Record<string, unknown>;
  raw: string;
};

export type PipelineWorkspaceRole =
  | { role: "author"; laneId: string; provider: string }
  | { role: "review"; laneId: string; provider: string }
  | {
      role: "final";
      laneId: string;
      provider: string;
      round: number;
      slot: number;
    }
  | { role: "merge"; laneId: string; provider: string }
  | { role: "validation"; laneId: string; provider: string };

const FINAL_REVIEW_RE = /^FINAL-REVIEW \(([^)\n]+)\):\s*(\{[^\n]*\})\s*$/gim;
const ADVERSARIAL_REVIEW_RE =
  /^ADVERSARIAL-REVIEW \(([^)\n]+)\):\s*(\{[^\n]*\})\s*$/gim;
const MERGED_RE =
  /MERGED BY AGENTS(?:\s*:\s*(\{[^\n]*\})|\s+([0-9a-f]{7,40}))?/gi;
const VALIDATION_RE =
  /^(VALIDATED|VALIDATION FAILED) \(([^)\n]+)\)(?:\s*:\s*(\{[^\n]*\}))?/gim;
const RATE_LIMIT_ISO_RE =
  /(?:rate[ -]?limit|quota)[^\n]{0,160}?(?:reset(?:s)?(?:\s+at|\s+on)?|try again(?:\s+at|\s+after)?)\s*[:=-]?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)/gi;
const RATE_LIMIT_RELATIVE_RE =
  /(?:rate[ -]?limit|quota)[^\n]{0,160}?(?:reset(?:s)?|try again)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/gi;
const ABANDONED_TOKEN = "[abandoned";

export function parseFinalReviewMarkers(text: string): FinalReviewMarker[] {
  const markers: FinalReviewMarker[] = [];
  for (const match of text.matchAll(FINAL_REVIEW_RE)) {
    try {
      const data = JSON.parse(match[2]) as Record<string, unknown>;
      const verdict = data.verdict;
      if (verdict !== "approve" && verdict !== "changes") continue;
      markers.push({
        model: match[1].trim(),
        verdict,
        data,
        raw: match[0].trim(),
      });
    } catch {
      // Invalid JSON is not a machine-readable final marker.
    }
  }
  return markers;
}

export function parseAdversarialReviewMarkers(
  text: string
): ReviewAttestationMarker[] {
  const markers: ReviewAttestationMarker[] = [];
  for (const match of text.matchAll(ADVERSARIAL_REVIEW_RE)) {
    try {
      const data = JSON.parse(match[2]) as Record<string, unknown>;
      const verdict = data.verdict;
      if (verdict !== "approve" && verdict !== "changes") continue;
      markers.push({
        kind: "review",
        model: match[1].trim(),
        verdict,
        data,
        raw: match[0].trim(),
      });
    } catch {
      // Invalid JSON is not a commissioned attestation.
    }
  }
  return markers;
}

export function parseMergedSha(text: string): string | null {
  const matches = [...text.matchAll(MERGED_RE)];
  const match = matches[matches.length - 1];
  if (!match) return null;
  if (match[2] && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(match[2])) {
    return match[2].toLowerCase();
  }
  if (match[1]) {
    try {
      const payload = JSON.parse(match[1]) as Record<string, unknown>;
      const sha = typeof payload.sha === "string" ? payload.sha : null;
      if (sha && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
        return sha.toLowerCase();
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function parseValidationMarker(
  text: string,
): ValidationMarker | null {
  const matches = [...text.matchAll(VALIDATION_RE)];
  const match = matches[matches.length - 1];
  if (!match) return null;
  let data: Record<string, unknown> = {};
  if (match[3]) {
    try {
      data = JSON.parse(match[3]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return {
    result: match[1].toUpperCase() === "VALIDATED" ? "passed" : "failed",
    model: match[2].trim(),
    data,
    raw: match[0].trim(),
  };
}

export function parseRateLimitReset(
  text: string,
  now = new Date(),
  relativeTo = now,
): string | null {
  let latest: number | null = null;
  for (const match of text.matchAll(RATE_LIMIT_ISO_RE)) {
    const parsed = Date.parse(match[1]);
    if (Number.isFinite(parsed) && parsed > now.getTime()) {
      latest = Math.max(latest ?? parsed, parsed);
    }
  }
  for (const match of text.matchAll(RATE_LIMIT_RELATIVE_RE)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = match[2].toLowerCase();
    const durationMs = amount * (unit.startsWith("h") ? 3_600_000 : 60_000);
    const reset = relativeTo.getTime() + durationMs;
    if (reset > now.getTime()) latest = Math.max(latest ?? 0, reset);
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export function shouldRestartDeadSession(input: {
  unansweredNudges: number;
  lastAssistantAt: string | null;
  lastNudgeAt: string | null;
  rateLimitUntil?: string | null;
  now: Date;
}): boolean {
  if (input.unansweredNudges < 2) return false;
  if (
    input.rateLimitUntil &&
    Date.parse(input.rateLimitUntil) > input.now.getTime()
  ) {
    return false;
  }
  if (!input.lastNudgeAt) return true;
  if (!input.lastAssistantAt) return true;
  return Date.parse(input.lastAssistantAt) <= Date.parse(input.lastNudgeAt);
}

export function selectRotatedProvider(input: {
  rotation: readonly string[];
  exclude?: ReadonlySet<string>;
  occupied?: ReadonlySet<string>;
  outages?: ReadonlyMap<string, string>;
  now: Date;
}): string | null {
  for (const provider of input.rotation) {
    if (input.exclude?.has(provider)) continue;
    if (input.occupied?.has(provider)) continue;
    const unavailableUntil = input.outages?.get(provider);
    if (
      unavailableUntil &&
      Date.parse(unavailableUntil) > input.now.getTime()
    ) {
      continue;
    }
    return provider;
  }
  return null;
}

export function mergeDependencyBlockers(
  lane: LaneConfig,
  states: ReadonlyMap<string, LaneDeliveryState | null>,
  snapshots: readonly LaneSnapshot[] = [],
  lanes: readonly LaneConfig[] = [],
): string[] {
  return lane.after.filter((dependency) => {
    const state = states.get(dependency);
    if (state?.mergedSha) return false;
    const dependencyLane = lanes.find((entry) => entry.id === dependency);
    if (!dependencyLane?.delivery) {
      return snapshots.find((entry) => entry.id === dependency)?.state !== "done";
    }
    return true;
  });
}

export function parsePipelineWorkspaceName(
  name: string,
): PipelineWorkspaceRole | null {
  let match = name.match(/\[lane:([^:\]]+):final:r(\d+):s(\d+):([^:\]]+)\]/i);
  if (match) {
    return {
      role: "final",
      laneId: match[1],
      round: Number(match[2]),
      slot: Number(match[3]),
      provider: match[4],
    };
  }
  match = name.match(/\[lane:([^:\]]+):(review|merge|validation):([^:\]]+)\]/i);
  if (match) {
    return {
      role: match[2].toLowerCase() as "review" | "merge" | "validation",
      laneId: match[1],
      provider: match[3],
    };
  }
  match = name.match(/\[lane:([^:\]]+):([^:\]]+)\]/i);
  if (match) {
    return { role: "author", laneId: match[1], provider: match[2] };
  }
  return null;
}

export function pipelineWorkspaceName(input: {
  lane: LaneConfig;
  role: "review" | "final" | "merge" | "validation";
  provider: string;
  runId?: string;
  attempt?: number;
  round?: number;
  slot?: number;
}): string {
  const token =
    input.role === "final"
      ? `[lane:${input.lane.id}:final:r${input.round ?? 1}:s${input.slot ?? 1}:${input.provider}]`
      : `[lane:${input.lane.id}:${input.role}:${input.provider}]`;
  const managed = input.runId
    ? `[managed:growth][lane:${input.lane.id}][run:${input.runId}][stage:${input.role}][attempt:${input.attempt ?? input.slot ?? input.round ?? 1}]`
    : "";
  return `${managed}${token} ${input.lane.title}`;
}

export function isAbandonedWorkspace(name: string): boolean {
  return name.toLowerCase().includes(ABANDONED_TOKEN);
}

export function deliveryStageForLane(lane: LaneConfig): DeliveryStage | null {
  if (lane.delivery?.review) return "review";
  if (lane.delivery?.finals) return "finals";
  if (lane.delivery?.merge) return "merge";
  if (lane.delivery?.validation) return "validation";
  return null;
}

function stageAfter(
  delivery: LaneDeliveryConfig,
  completed: "review" | "finals" | "merge",
): DeliveryStage {
  if (completed === "review" && delivery.finals) return "finals";
  if ((completed === "review" || completed === "finals") && delivery.merge) {
    return "merge";
  }
  if (delivery.validation) return "validation";
  return "complete";
}

export async function runDeliveryPipeline(input: {
  client: ConductorApiClient;
  config: LanesConfig;
  snapshots: LaneSnapshot[];
  workspaces: ConductorApiWorkspace[];
  notify: (text: string) => Promise<void>;
  forceMergeLaneId?: string;
  refreshPr?: (prUrl: string) => Promise<GithubPrPolicySnapshot>;
  refreshMergedChecks?: (input: {
    repoOwner: string;
    repoName: string;
    sha: string;
  }) => Promise<GithubCommitChecksSnapshot>;
}): Promise<void> {
  const states = new Map<string, LaneDeliveryState | null>(
    input.config.lanes.map((lane) => [
      lane.id,
      getLaneDeliveryState<LaneDeliveryState>(lane.id),
    ]),
  );
  const occupied = new Set(
    input.snapshots
      .filter((snapshot) => snapshot.state === "working")
      .map((snapshot) => snapshot.assignedProvider)
      .filter((provider): provider is string => Boolean(provider)),
  );
  for (const state of states.values()) {
    if (!state) continue;
    const runs = [
      state.review,
      ...state.finals,
      state.merge,
      state.validation,
    ].filter((run): run is DeliveryRun => Boolean(run && !run.completedAt));
    for (const run of runs) {
      try {
        const sessions = await input.client.listWorkspaceSessions(
          run.workspaceId,
          { includeArchived: true },
        );
        const newest = newestSession(sessions);
        if (newest) run.sessionId = newest.id;
        if (
          newest &&
          (await input.client.getSessionStatus(newest.id)).status === "working"
        ) {
          occupied.add(run.provider);
        }
      } catch {
        // Fail closed for capacity: an unknown live run keeps its provider busy.
        occupied.add(run.provider);
      }
    }
  }

  for (const lane of input.config.lanes) {
    if (!lane.delivery) continue;
    if (input.forceMergeLaneId && lane.id !== input.forceMergeLaneId) continue;
    const snapshot = input.snapshots.find((entry) => entry.id === lane.id);
    if (!snapshot) continue;
    let state = states.get(lane.id) ?? null;

    if (!state && snapshot.prUrl && snapshot.lastAssistantAt) {
      const initial = deliveryStageForLane(lane);
      if (!initial) continue;
      const policy = await (input.refreshPr ?? refreshPrByUrl)(snapshot.prUrl);
      const identity = githubPrIdentity(policy.url);
      if (
        !identity ||
        !policy.headSha ||
        !policy.headBranch ||
        !policy.baseBranch ||
        !policy.prNumber ||
        policy.repoOwner !== identity.owner ||
        policy.repoName !== identity.repo ||
        identity.number !== policy.prNumber ||
        !githubPrUrlMatchesRepo(snapshot.prUrl, lane.repoUrl) ||
        !githubPrUrlMatchesRepo(policy.url, lane.repoUrl)
      ) {
        continue;
      }
      state = {
        version: 1,
        runId: randomUUID(),
        laneId: lane.id,
        prUrl: policy.url,
        prOwner: identity.owner,
        prRepo: identity.repo,
        prNumber: identity.number,
        headBranch: policy.headBranch,
        headSha: policy.headSha,
        authorProvider:
          snapshot.assignedProvider ??
          (lane.provider === "any" ? "unknown" : lane.provider),
        authorTurnAt: snapshot.lastAssistantAt,
        stage: initial,
        round: 1,
        finals: [],
      };
      saveState(state, states);
    }
    if (!state) continue;

    if (!state.runId || !state.prOwner || !state.prRepo || !state.headSha) {
      // Legacy local state has no commissioned-attempt identity. Leave it
      // inert for the one-time importer instead of silently trusting it.
      continue;
    }

    if (!state.mergedSha) {
      const currentPolicy = await (input.refreshPr ?? refreshPrByUrl)(state.prUrl);
      const identityStable =
        currentPolicy.prNumber === state.prNumber &&
        currentPolicy.repoOwner === state.prOwner &&
        currentPolicy.repoName === state.prRepo &&
        currentPolicy.headBranch === state.headBranch &&
        githubPrUrlMatchesRepo(currentPolicy.url, lane.repoUrl);
      if (!identityStable || !currentPolicy.headSha) {
        // Repository/branch identity drift is quarantined by inaction. The
        // durable worker reports it as a safety alert instead of guessing.
        continue;
      }
      if (currentPolicy.headSha !== state.headSha) {
        state.headSha = currentPolicy.headSha;
        state.round += 1;
        state.review = undefined;
        state.finals = [];
        state.merge = undefined;
        state.mergeHeadSha = undefined;
        state.feedbackSentAt = undefined;
        state.feedbackMessageId = undefined;
        state.stage = deliveryStageForLane(lane) ?? "review";
        saveState(state, states);
        continue;
      }
    }

    if (
      (state.stage === "review_fixes" || state.stage === "final_fixes") &&
      snapshot.lastAssistantAt &&
      state.feedbackSentAt &&
      Date.parse(snapshot.lastAssistantAt) > Date.parse(state.feedbackSentAt) &&
      snapshot.prUrl
    ) {
      state.prUrl = snapshot.prUrl;
      state.authorTurnAt = snapshot.lastAssistantAt;
      if (state.stage === "review_fixes") {
        state.stage = stageAfter(lane.delivery, "review");
      } else {
        state.stage = "finals";
        state.round += 1;
        state.finals = [];
        state.merge = undefined;
      }
      state.feedbackSentAt = undefined;
      state.feedbackMessageId = undefined;
      saveState(state, states);
    }

    if (input.forceMergeLaneId && state.stage !== "merge") continue;

    if (state.stage === "review" && lane.delivery.review) {
      await advanceReview(input, lane, snapshot, state, states, occupied);
    } else if (state.stage === "finals" && lane.delivery.finals) {
      await advanceFinals(input, lane, snapshot, state, states, occupied);
    } else if (state.stage === "merge" && lane.delivery.merge) {
      const blockers = mergeDependencyBlockers(
        lane,
        states,
        input.snapshots,
        input.config.lanes,
      );
      if (blockers.length === 0) {
        await advanceMerge(input, lane, snapshot, state, states, occupied);
      }
    } else if (state.stage === "validation" && lane.delivery.validation) {
      await advanceValidation(input, lane, snapshot, state, states, occupied);
    }
  }
}

function prBindingMatches(
  state: LaneDeliveryState,
  policy: GithubPrPolicySnapshot,
  lane: LaneConfig
): boolean {
  return Boolean(
    policy.prNumber === state.prNumber &&
      policy.repoOwner === state.prOwner &&
      policy.repoName === state.prRepo &&
      policy.headBranch === state.headBranch &&
      policy.headSha === state.headSha &&
      githubPrUrlMatchesRepo(policy.url, lane.repoUrl) &&
      githubPrUrlMatchesRepo(state.prUrl, lane.repoUrl)
  );
}

function markerMatchesCommission(
  marker: FinalReviewMarker,
  run: DeliveryRun,
  state: LaneDeliveryState,
  stage: "review" | "final"
): boolean {
  return Boolean(
    marker.model === run.model &&
      marker.data.nonce === run.nonce &&
      marker.data.run === state.runId &&
      marker.data.stage === stage &&
      marker.data.headSha === run.commissionedHeadSha &&
      marker.data.provider === run.provider
  );
}

function commissionedGithubAttestation(input: {
  policy: GithubPrPolicySnapshot;
  state: LaneDeliveryState;
  run: DeliveryRun;
  stage: "review" | "final";
}): FinalReviewMarker | null {
  if (
    input.policy.prNumber !== input.state.prNumber ||
    input.policy.repoOwner !== input.state.prOwner ||
    input.policy.repoName !== input.state.prRepo ||
    input.policy.headBranch !== input.state.headBranch ||
    input.policy.headSha !== input.state.headSha
  ) {
    return null;
  }
  const parser =
    input.stage === "review"
      ? parseAdversarialReviewMarkers
      : parseFinalReviewMarkers;
  const candidates = input.policy.reviews
    .filter((review) => review.commitSha === input.state.headSha)
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
  for (const review of candidates) {
    const marker = parser(review.body)
      .filter((candidate) => markerMatchesCommission(candidate, input.run, input.state, input.stage))
      .at(-1);
    if (marker && review.body.trimStart().startsWith(marker.raw)) return marker;
  }
  return null;
}

async function advanceReview(
  input: Parameters<typeof runDeliveryPipeline>[0],
  lane: LaneConfig,
  author: LaneSnapshot,
  state: LaneDeliveryState,
  states: Map<string, LaneDeliveryState | null>,
  occupied: Set<string>,
): Promise<void> {
  if (!state.review) {
    state.review = await ensureRun({
      ...input,
      lane,
      author,
      state,
      role: "review",
      stage: lane.delivery!.review!,
      occupied,
      exclude: new Set([state.authorProvider]),
    });
    if (state.review) saveState(state, states);
    return;
  }
  const observation = await observeRun(input.client, state.review, lane.id);
  if (observation.status === "working") {
    occupied.add(state.review.provider);
    return;
  }
  const policy = await (input.refreshPr ?? refreshPrByUrl)(state.prUrl);
  const attestation = commissionedGithubAttestation({
    policy,
    state,
    run: state.review,
    stage: "review",
  });
  if (!attestation) {
    await keepRunAlive(
      input,
      lane,
      state.review,
      observation,
      `Finish the commissioned adversarial review of ${state.prUrl}. Post the exact nonce/run/head-bound GitHub attestation from your instructions.`,
      occupied,
    );
    return;
  }
  state.review.verdict = attestation.verdict;
  state.review.marker = attestation.raw;
  state.review.completedAt = observation.latestAssistantAt ?? new Date().toISOString();
  if (!state.feedbackSentAt) {
    state.feedbackMessageId ??= randomUUID();
    saveState(state, states);
    const sent = await messageAuthor(
      input.client,
      author,
      `Address the adversarial GitHub review on ${state.prUrl}. Push the fixes and end your turn with the PR URL.`,
      state.feedbackMessageId,
    );
    if (!sent) return;
    state.feedbackSentAt = new Date().toISOString();
    state.stage = "review_fixes";
    recordLaneAction({
      laneId: lane.id,
      provider: state.authorProvider,
      action: "review_feedback",
      detail: state.review.workspaceId,
    });
    await safeNotify(
      input.notify,
      `🚦 ${lane.id} adversarial review sent to the author`,
    );
    saveState(state, states);
  }
}

async function advanceFinals(
  input: Parameters<typeof runDeliveryPipeline>[0],
  lane: LaneConfig,
  author: LaneSnapshot,
  state: LaneDeliveryState,
  states: Map<string, LaneDeliveryState | null>,
  occupied: Set<string>,
): Promise<void> {
  const stage = lane.delivery!.finals!;
  const current = state.finals.filter((run) => run.round === state.round);
  const slot = current.length + 1;
  if (slot <= 2 && current.every((run) => run.verdict === "approve")) {
    const exclude = new Set([
      state.authorProvider,
      ...current.map((run) => run.provider),
    ]);
    const created = await ensureRun({
      ...input,
      lane,
      author,
      state,
      role: "final",
      stage,
      occupied,
      exclude,
      round: state.round,
      slot,
      previousMarker: current[0]?.marker,
    });
    if (created) {
      state.finals.push(created);
      saveState(state, states);
    }
    return;
  }

  const pending = current.find((run) => !run.verdict);
  if (pending) {
    const observation = await observeRun(input.client, pending, lane.id);
    if (observation.status === "working") {
      occupied.add(pending.provider);
      return;
    }
    const policy = await (input.refreshPr ?? refreshPrByUrl)(state.prUrl);
    const marker = commissionedGithubAttestation({
      policy,
      state,
      run: pending,
      stage: "final",
    });
    if (!marker) {
      await keepRunAlive(
        input,
        lane,
        pending,
        observation,
        `Post the exact commissioned FINAL-REVIEW attestation on ${state.prUrl}; preserve its run, nonce, provider, stage, and current head SHA fields.`,
        occupied,
      );
      return;
    }
    pending.verdict = marker.verdict;
    pending.marker = marker.raw;
    pending.completedAt =
      observation.latestAssistantAt ?? new Date().toISOString();
    if (marker.verdict === "changes") {
      state.feedbackMessageId ??= randomUUID();
      saveState(state, states);
      const sent = await messageAuthor(
        input.client,
        author,
        `Address final review round ${state.round} on ${state.prUrl}. Push the fixes and end your turn with the PR URL.`,
        state.feedbackMessageId,
      );
      if (!sent) return;
      state.feedbackSentAt = new Date().toISOString();
      state.stage = "final_fixes";
      recordLaneAction({
        laneId: lane.id,
        provider: state.authorProvider,
        action: "final_feedback",
        detail: `round ${state.round}`,
      });
      await safeNotify(
        input.notify,
        `🚦 ${lane.id} final changes sent to the author`,
      );
    } else if (
      current.length === 2 &&
      current.every((run) => run.verdict === "approve")
    ) {
      state.stage = lane.delivery?.merge
        ? "merge"
        : stageAfter(lane.delivery!, "finals");
    }
    saveState(state, states);
  }
}

async function advanceMerge(
  input: Parameters<typeof runDeliveryPipeline>[0],
  lane: LaneConfig,
  author: LaneSnapshot,
  state: LaneDeliveryState,
  states: Map<string, LaneDeliveryState | null>,
  occupied: Set<string>,
): Promise<void> {
  if (
    state.finals.filter(
      (run) => run.round === state.round && run.verdict === "approve",
    ).length < 2
  ) {
    return;
  }
  const policy = await (input.refreshPr ?? refreshPrByUrl)(state.prUrl);
  if (
    !prBindingMatches(state, policy, lane) ||
    !githubPrUrlMatchesRepo(state.prUrl, lane.repoUrl) ||
    !githubPrUrlMatchesRepo(policy.url, lane.repoUrl)
  ) {
    return;
  }

  if (policy.state === "merged") {
    if (!policy.mergeCommitSha) return;
    if (!state.merge) {
      await recordVerifiedMerge(input, lane, state, states, policy.mergeCommitSha);
      return;
    }
    const observation = await observeRun(input.client, state.merge, lane.id);
    if (observation.status === "working") {
      occupied.add(state.merge.provider);
      return;
    }
    const reportedSha = parseMergedSha(observation.assistantText);
    if (reportedSha !== policy.mergeCommitSha) {
      await keepRunAlive(
        input,
        lane,
        state.merge,
        observation,
        `GitHub reports merge commit ${policy.mergeCommitSha}. Post the configured MERGED BY AGENTS comment and end with MERGED BY AGENTS: {"sha":"${policy.mergeCommitSha}"}.`,
        occupied,
      );
      return;
    }
    state.merge.completedAt =
      observation.latestAssistantAt ?? new Date().toISOString();
    await recordVerifiedMerge(input, lane, state, states, policy.mergeCommitSha);
    return;
  }

  if (policy.mergeable?.toUpperCase() === "CONFLICTING") {
    await returnMergeConflict(input, lane, author, state, states);
    return;
  }

  if (
    state.mergeHeadSha &&
    policy.headSha &&
    state.mergeHeadSha !== policy.headSha
  ) {
    state.round += 1;
    state.finals = [];
    state.merge = undefined;
    state.mergeHeadSha = undefined;
    state.stage = "finals";
    saveState(state, states);
    return;
  }

  const attestedApproval = hasCurrentFinalApprovals(state, policy);
  if (!canMergePr(policy, { attestedApproval }) || !attestedApproval) {
    return;
  }
  if (!state.merge) {
    state.mergeHeadSha = policy.headSha ?? undefined;
    state.merge = await ensureRun({
      ...input,
      lane,
      author,
      state,
      role: "merge",
      stage: lane.delivery!.merge!,
      occupied,
      exclude: new Set([state.authorProvider]),
    });
    if (state.merge) saveState(state, states);
    return;
  }
  const observation = await observeRun(input.client, state.merge, lane.id);
  if (observation.status === "working") {
    occupied.add(state.merge.provider);
    return;
  }
  await keepRunAlive(
    input,
    lane,
    state.merge,
    observation,
    `Re-check the open PR ${state.prUrl}. Merge only if policy allows, or report MERGE BLOCKED with the reason.`,
    occupied,
  );
}

export function hasCurrentFinalApprovals(
  state: LaneDeliveryState,
  policy: GithubPrPolicySnapshot,
): boolean {
  if (
    !policy.headSha ||
    policy.headSha !== state.headSha ||
    policy.prNumber !== state.prNumber ||
    policy.repoOwner !== state.prOwner ||
    policy.repoName !== state.prRepo ||
    policy.headBranch !== state.headBranch
  ) {
    return false;
  }
  const expected = state.finals
    .filter(
      (run) =>
        run.round === state.round && run.verdict === "approve" && run.marker,
    );
  if (expected.length !== 2 || new Set(expected.map((run) => run.provider)).size !== 2) {
    return false;
  }
  return expected.every((run) => {
    const attestation = commissionedGithubAttestation({
      policy,
      state,
      run,
      stage: "final",
    });
    return attestation?.verdict === "approve" && attestation.raw === run.marker;
  });
}

async function returnMergeConflict(
  input: Parameters<typeof runDeliveryPipeline>[0],
  lane: LaneConfig,
  author: LaneSnapshot,
  state: LaneDeliveryState,
  states: Map<string, LaneDeliveryState | null>,
): Promise<void> {
  state.feedbackMessageId ??= randomUUID();
  saveState(state, states);
  const sent = await messageAuthor(
    input.client,
    author,
    `Rebase ${state.prUrl} onto its target branch, resolve conflicts, push, and end your turn with the PR URL.`,
    state.feedbackMessageId,
  );
  if (!sent) return;
  state.feedbackSentAt = new Date().toISOString();
  state.stage = "final_fixes";
  if (state.merge) state.merge.completedAt = state.feedbackSentAt;
  recordLaneAction({
    laneId: lane.id,
    provider: state.authorProvider,
    action: "final_feedback",
    detail: `GitHub reports merge conflict after round ${state.round}`,
  });
  await safeNotify(input.notify, `🚦 ${lane.id} merge conflict sent to the author`);
  saveState(state, states);
}

async function recordVerifiedMerge(
  input: Parameters<typeof runDeliveryPipeline>[0],
  lane: LaneConfig,
  state: LaneDeliveryState,
  states: Map<string, LaneDeliveryState | null>,
  mergedSha: string,
): Promise<void> {
  state.mergedSha = mergedSha;
  state.stage = lane.delivery?.validation ? "validation" : "complete";
  recordLaneAction({
    laneId: lane.id,
    provider: state.merge?.provider ?? "github",
    action: "merge_feedback",
    detail: mergedSha,
  });
  await safeNotify(input.notify, `✅ ${lane.id} merged (${mergedSha})`);
  saveState(state, states);
}

async function advanceValidation(
  input: Parameters<typeof runDeliveryPipeline>[0],
  lane: LaneConfig,
  author: LaneSnapshot,
  state: LaneDeliveryState,
  states: Map<string, LaneDeliveryState | null>,
  occupied: Set<string>,
): Promise<void> {
  if (!state.validation) {
    state.validation = await ensureRun({
      ...input,
      lane,
      author,
      state,
      role: "validation",
      stage: lane.delivery!.validation!,
      occupied,
      exclude: new Set([
        state.authorProvider,
        ...(state.merge
          ? [state.merge.provider]
          : [
              state.finals.filter((run) => run.round === state.round).at(-1)
                ?.provider,
            ]
        ).filter((provider): provider is string => Boolean(provider)),
      ]),
    });
    if (state.validation) saveState(state, states);
    return;
  }
  const observation = await observeRun(input.client, state.validation, lane.id);
  if (observation.status === "working") {
    occupied.add(state.validation.provider);
    return;
  }
  const marker = parseValidationMarker(observation.assistantText);
  if (
    !marker ||
    !validationMarkerMatches(
      marker,
      state.validation,
      state,
      lane.delivery!.validation!.verification,
      observation.messages,
    )
  ) {
    await keepRunAlive(
      input,
      lane,
      state.validation,
      observation,
      `Finish validation and post the exact commissioned marker with run, nonce, provider, merged SHA, and command/probe evidence.`,
      occupied,
    );
    return;
  }
  if (marker.result === "passed") {
    const checks = await (input.refreshMergedChecks ?? refreshCommitChecks)({
      repoOwner: state.prOwner,
      repoName: state.prRepo,
      sha: state.mergedSha!,
    });
    if (
      checks.repoOwner !== state.prOwner ||
      checks.repoName !== state.prRepo ||
      checks.sha !== state.mergedSha ||
      checks.status !== "passing"
    ) {
      return;
    }
  }
  state.validation.completedAt =
    observation.latestAssistantAt ?? new Date().toISOString();
  state.validation.marker = marker.raw;
  state.validationResult = marker.result;
  state.stage = marker.result === "passed" ? "complete" : "validation_failed";
  recordLaneAction({
    laneId: lane.id,
    provider: state.validation.provider,
    action: "validation_complete",
    detail: marker.result,
  });
  await safeNotify(
    input.notify,
    `${marker.result === "passed" ? "✅" : "❌"} ${lane.id} validation ${marker.result}`,
  );
  saveState(state, states);
}

export function validationMarkerMatches(
  marker: ValidationMarker,
  run: DeliveryRun,
  state: LaneDeliveryState,
  verification?: string,
  messages: readonly ConductorApiMessage[] = [],
): boolean {
  if (
    marker.model !== run.model ||
    marker.data.run !== state.runId ||
    marker.data.nonce !== run.nonce ||
    marker.data.stage !== "validation" ||
    marker.data.mergedSha !== state.mergedSha ||
    marker.data.headSha !== state.mergedSha ||
    run.commissionedHeadSha !== state.mergedSha ||
    marker.data.provider !== run.provider
  ) {
    return false;
  }
  if (!verification) return false;
  const commands = Array.isArray(marker.data.commands)
    ? marker.data.commands
    : [];
  if (commands.length !== 1 || !commands[0] || typeof commands[0] !== "object") {
    return false;
  }
  const command = commands[0] as Record<string, unknown>;
  const markerExitCode = command.exitCode ?? command.exit_code;
  if (
    command.command !== verification ||
    typeof markerExitCode !== "number" ||
    !Number.isInteger(markerExitCode)
  ) {
    return false;
  }
  const receipts = rawExecutionReceipts(messages);
  if (receipts.length !== 1 || receipts[0]!.exit_code !== markerExitCode) {
    return false;
  }
  return marker.result === "passed" ? markerExitCode === 0 : markerExitCode !== 0;
}

type EnsureRunInput = Parameters<typeof runDeliveryPipeline>[0] & {
  lane: LaneConfig;
  author: LaneSnapshot;
  state: LaneDeliveryState;
  role: DeliveryRun["role"];
  stage: LaneStageConfig;
  occupied: Set<string>;
  exclude: Set<string>;
  round?: number;
  slot?: number;
  previousMarker?: string;
};

async function ensureRun(
  input: EnsureRunInput,
): Promise<DeliveryRun | undefined> {
  const token = roleToken(input.lane.id, input.role, input.round, input.slot);
  const matches = input.workspaces
    .filter((workspace) => !isAbandonedWorkspace(workspace.name))
    .filter((workspace) => workspace.name.includes(token))
    .sort(compareNewest);
  const existing = matches.find(
    (workspace) => !conductorWorkspaceIsArchived(workspace)
  );
  if (!existing && matches.length > 0) return undefined;
  if (existing) {
    const parsed = parsePipelineWorkspaceName(existing.name);
    const selected = selectRotatedProvider({
      rotation: input.stage.rotation,
      exclude: input.exclude,
      occupied: input.occupied,
      outages: getLaneProviderOutages(),
      now: new Date(),
    });
    const provider = selected ?? parsed?.provider;
    const providerConfig = provider ? input.config.providers[provider] : undefined;
    if (!provider || !providerConfig) return undefined;
    const created = await input.client.createSession({
      workspaceId: existing.id,
      name: `${input.role} attempt ${input.slot ?? input.round ?? input.state.round}`,
      agent: providerConfig.agent,
      model: providerConfig.model,
      effort: providerConfig.effort,
    });
    const run: DeliveryRun = {
      role: input.role,
      workspaceId: existing.id,
      sessionId: created.id,
      provider,
      model: providerConfig.model,
      startedAt: new Date().toISOString(),
      nonce: randomUUID(),
      commissionedHeadSha:
        input.role === "validation"
          ? input.state.mergedSha!
          : input.state.headSha,
      round: input.round,
      slot: input.slot,
    };
    await input.client.sendMessage({
      sessionId: created.id,
      message: renderRunPrompt(input, run),
      messageId: randomUUID(),
    });
    observeLaneSession({
      sessionId: created.id,
      laneId: input.lane.id,
      role: input.role,
      lastAssistantAt: null,
    });
    input.occupied.add(provider);
    return run;
  }

  const provider = selectRotatedProvider({
    rotation: input.stage.rotation,
    exclude: input.exclude,
    occupied: input.occupied,
    outages: getLaneProviderOutages(),
    now: new Date(),
  });
  if (!provider) return undefined;
  const providerConfig = input.config.providers[provider];
  const name = pipelineWorkspaceName({
    lane: input.lane,
    role: input.role,
    provider,
    runId: input.state.runId,
    attempt: input.slot ?? input.round ?? input.state.round,
    round: input.round,
    slot: input.slot,
  });
  const created = input.lane.projectId
    ? await input.client.createWorkspace({
        projectId: input.lane.projectId,
        name,
        agent: providerConfig.agent,
        model: providerConfig.model,
        effort: providerConfig.effort,
      })
    : await input.client.createWorkspace({
        repositoryUrl: input.lane.repoUrl,
        name,
        agent: providerConfig.agent,
        model: providerConfig.model,
        effort: providerConfig.effort,
      });
  const startedAt = new Date().toISOString();
  const run: DeliveryRun = {
    role: input.role,
    workspaceId: created.workspaceId,
    sessionId: created.sessionId,
    provider,
    model: providerConfig.model,
    startedAt,
    nonce: randomUUID(),
    commissionedHeadSha:
      input.role === "validation"
        ? input.state.mergedSha!
        : input.state.headSha,
    round: input.round,
    slot: input.slot,
  };
  const prompt = renderRunPrompt(input, run);
  await input.client.sendMessage({
    sessionId: created.sessionId,
    message: prompt,
    messageId: randomUUID(),
  });
  observeLaneSession({
    sessionId: created.sessionId,
    laneId: input.lane.id,
    role: input.role,
    lastAssistantAt: null,
  });
  input.occupied.add(provider);
  recordLaneAction({
    laneId: input.lane.id,
    provider,
    action:
      input.role === "review"
        ? "review_create"
        : input.role === "final"
          ? "final_create"
          : input.role === "merge"
            ? "merge_create"
            : "validation_create",
    detail: created.workspaceId,
  });
  await safeNotify(
    input.notify,
    `🚦 ${input.lane.id} ${input.role} started on ${provider}`,
  );
  return run;
}

function renderRunPrompt(input: EnsureRunInput, run: DeliveryRun): string {
  const template = readTemplate(input.config, input.stage.prompt);
  const merge = input.lane.delivery?.merge;
  const values: Record<string, string> = {
    laneId: input.lane.id,
    laneTitle: input.lane.title,
    prUrl: input.state.prUrl,
    round: String(input.round ?? input.state.round),
    slot: String(input.slot ?? ""),
    model: run.model,
    previousFinalReview: input.previousMarker ?? "",
    mergeMethod: merge?.method ?? "squash",
    deployNotes: merge?.deployNotes ?? "",
    replayNotes: merge?.replayNotes ?? "",
    verification: input.lane.delivery?.validation?.verification ?? "",
    mergeHeadSha: input.state.mergeHeadSha ?? "",
    runId: input.state.runId,
    nonce: run.nonce,
    headSha: run.commissionedHeadSha,
    provider: run.provider,
  };
  let rendered = template.replace(
    /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g,
    (_match, key: string) => values[key] ?? "",
  );
  const invariants = invariantPrompt(input, run);
  rendered = `${rendered.trim()}\n\n${invariants}`;
  return rendered;
}

function invariantPrompt(input: EnsureRunInput, run: DeliveryRun): string {
  if (input.role === "review") {
    return `Review ${input.state.prUrl} adversarially from this isolated workspace. Use GitHub to post exactly one pull-request review whose first line is ADVERSARIAL-REVIEW (${run.model}): {\"verdict\":\"approve\"|\"changes\",\"nonce\":\"${run.nonce}\",\"run\":\"${input.state.runId}\",\"stage\":\"review\",\"headSha\":\"${run.commissionedHeadSha}\",\"provider\":\"${run.provider}\"}. Preserve every identity field exactly. End your response with REVIEW POSTED; that transcript marker is advisory only.`;
  }
  if (input.role === "final") {
    const decidingContext =
      input.slot === 2
        ? ` You are the deciding second reviewer. The first final marker was: ${input.previousMarker ?? "missing"}.`
        : "";
    return `Review ${input.state.prUrl} and post exactly one GitHub review whose first line is FINAL-REVIEW (${run.model}): {\"verdict\":\"approve\"|\"changes\",\"nonce\":\"${run.nonce}\",\"run\":\"${input.state.runId}\",\"stage\":\"final\",\"headSha\":\"${run.commissionedHeadSha}\",\"provider\":\"${run.provider}\"}. Preserve every identity field exactly; the model label must be your real configured model.${decidingContext}`;
  }
  if (input.role === "merge") {
    const merge = input.lane.delivery!.merge!;
    return `The scheduler verified that ${input.state.prUrl} is open, mergeable, passing, approved, and at exact head ${input.state.mergeHeadSha}. Recheck those conditions and merge only that head using ${merge.method}; use --match-head-commit when supported. If GitHub now reports a conflict, do not merge; report MERGE BLOCKED: conflict. Comment \"MERGED BY AGENTS\" with the full merge SHA, deploy notes \"${merge.deployNotes}\", and replay notes \"${merge.replayNotes}\". End with MERGED BY AGENTS: {\"sha\":\"<full merge sha>\"}.`;
  }
  const validation = input.lane.delivery!.validation!;
  return `Validate the merged base containing ${input.state.mergedSha ?? "the merge"} by executing this exact configured command once, without wrapping, chaining, prefixing, suffixing, substituting, or repeating it: ${JSON.stringify(validation.verification)}. Post a GitHub comment and end with VALIDATED (${run.model}): {\"run\":\"${input.state.runId}\",\"nonce\":\"${run.nonce}\",\"stage\":\"validation\",\"headSha\":\"${input.state.mergedSha ?? ""}\",\"mergedSha\":\"${input.state.mergedSha ?? ""}\",\"provider\":\"${run.provider}\",\"commands\":[{\"command\":${JSON.stringify(validation.verification)},\"exitCode\":0}]} or VALIDATION FAILED with the same identity fields and the real nonzero exit code. Agent prose and the marker are advisory: the scheduler requires the matching terminal Conductor command/tool event plus green CI on the merged SHA. If validation fails, open a repair PR rather than deploying directly.`;
}

type RunObservation = {
  status: "idle" | "working" | "error";
  assistantText: string;
  latestAssistantAt: string | null;
  messages: ConductorApiMessage[];
  health: ReturnType<typeof observeLaneSession>;
};

async function observeRun(
  client: ConductorApiClient,
  run: DeliveryRun,
  laneId: string,
): Promise<RunObservation> {
  const sessions = await client.listWorkspaceSessions(run.workspaceId, {
    includeArchived: true,
  });
  const newest = newestSession(sessions);
  if (newest) run.sessionId = newest.id;
  const status = (await client.getSessionStatus(run.sessionId)).status;
  const messages = await listAllMessages(client, run.sessionId);
  const assistantMessages = messages.filter(
    (message) => assistantTextFromTranscriptEvent(message).trim().length > 0,
  );
  const latestAssistantAt = assistantMessages.at(-1)?.receivedAt ?? null;
  const latestAssistantText = assistantMessages.at(-1)
    ? assistantTextFromTranscriptEvent(assistantMessages.at(-1)!)
    : "";
  const assistantText = assistantMessages
    .map((message) => assistantTextFromTranscriptEvent(message))
    .join("\n");
  const rateLimitUntil = parseRateLimitReset(
    latestAssistantText,
    new Date(),
    latestAssistantAt ? new Date(latestAssistantAt) : new Date(),
  );
  if (rateLimitUntil) setLaneProviderOutage(run.provider, rateLimitUntil);
  const health = observeLaneSession({
    sessionId: run.sessionId,
    laneId,
    role: run.role,
    lastAssistantAt: latestAssistantAt,
    rateLimitUntil,
  });
  return { status, assistantText, latestAssistantAt, messages, health };
}

async function keepRunAlive(
  input: Parameters<typeof runDeliveryPipeline>[0],
  lane: LaneConfig,
  run: DeliveryRun,
  observation: RunObservation,
  message: string,
  occupied: Set<string>,
): Promise<void> {
  const provider = input.config.providers[run.provider];
  const now = new Date();
  if (
    observation.health.rateLimitUntil &&
    Date.parse(observation.health.rateLimitUntil) > now.getTime()
  ) {
    return;
  }
  if (observation.status === "working") return;
  const lastActivity = observation.health.lastNudgeAt ?? run.startedAt;
  if (
    now.getTime() - Date.parse(lastActivity) <
    provider.gapHours * 3_600_000
  ) {
    return;
  }
  if (
    shouldRestartDeadSession({
      unansweredNudges: observation.health.unansweredNudges,
      lastAssistantAt: observation.health.lastAssistantAt,
      lastNudgeAt: observation.health.lastNudgeAt,
      rateLimitUntil: observation.health.rateLimitUntil,
      now,
    })
  ) {
    const session = await input.client.createSession({
      workspaceId: run.workspaceId,
      name: `${run.role} recovery`,
      agent: provider.agent,
      model: provider.model,
      effort: provider.effort,
    });
    run.sessionId = session.id;
    await input.client.sendMessage({
      sessionId: session.id,
      message: `${message}\n\nThis is a recovery session in the same workspace. Inspect the existing branch and transcript context before acting.`,
      messageId: randomUUID(),
    });
    observeLaneSession({
      sessionId: session.id,
      laneId: lane.id,
      role: run.role,
      lastAssistantAt: null,
    });
    occupied.add(run.provider);
    recordLaneAction({
      laneId: lane.id,
      provider: run.provider,
      action: "restart",
      detail: `${run.role}:${session.id}`,
    });
    return;
  }
  await input.client.sendMessage({
    sessionId: run.sessionId,
    message,
    messageId: randomUUID(),
  });
  // A queued nudge immediately consumes this provider for the remainder of
  // the tick. Waiting for the next transcript/status poll caused same-tick
  // over-commit when maxActive was greater than one.
  occupied.add(run.provider);
  recordLaneSessionNudge(run.sessionId);
  recordLaneAction({
    laneId: lane.id,
    provider: run.provider,
    action: "nudge",
    detail: `${run.role}:${run.sessionId}`,
  });
}

async function messageAuthor(
  client: ConductorApiClient,
  author: LaneSnapshot,
  message: string,
  messageId: string,
): Promise<boolean> {
  if (!author.workspaceId) return false;
  const sessions = await client.listWorkspaceSessions(author.workspaceId, {
    includeArchived: true,
  });
  const newest = newestSession(sessions);
  if (!newest) return false;
  await client.sendMessage({
    sessionId: newest.id,
    message,
    messageId,
  });
  return true;
}

export async function runLaneHygiene(input: {
  client: ConductorApiClient;
  config: LanesConfig;
  workspaces: ConductorApiWorkspace[];
  notify: (text: string) => Promise<void>;
}): Promise<number> {
  let archived = 0;
  for (const workspace of input.workspaces) {
    try {
      if (isAbandonedWorkspace(workspace.name)) continue;
      const role = parsePipelineWorkspaceName(workspace.name);
      if (!role) continue;
      const lane = input.config.lanes.find((entry) => entry.id === role.laneId);
      if (!lane) continue;
      const state = getLaneDeliveryState<LaneDeliveryState>(lane.id);
      if (!state || !shouldArchiveWorkspace(role, state)) continue;
      if (conductorWorkspaceIsArchived(workspace)) continue;
      const sessions = await input.client.listWorkspaceSessions(workspace.id, {
        includeArchived: true,
      });
      const newest = newestSession(sessions);
      if (newest && !newest.archivedAt) {
        try {
          if (
            (await input.client.getSessionStatus(newest.id)).status ===
            "working"
          ) {
            continue;
          }
        } catch {
          continue;
        }
      }
      try {
        const status = await input.client.getWorkspaceStatus(workspace.id);
        if (status.status === "archived" || status.status === "deleted")
          continue;
        if (status.status === "initializing" || status.status === "updating")
          continue;
      } catch {
        continue;
      }
      await input.client.archiveWorkspace(workspace.id);
      archived += 1;
      recordLaneAction({
        laneId: lane.id,
        provider: role.provider,
        action: "archive",
        detail: workspace.id,
      });
    } catch {
      // Hygiene is best-effort per workspace; one outage must not block others.
      continue;
    }
  }
  if (archived > 0) {
    await safeNotify(
      input.notify,
      `🗄️ lanes archived ${archived} finished workspace${archived === 1 ? "" : "s"}`,
    );
  }
  return archived;
}

export function shouldArchiveWorkspace(
  role: PipelineWorkspaceRole,
  state: LaneDeliveryState,
): boolean {
  if (state.mergedSha) {
    if (role.role === "validation") {
      return ["complete", "validation_failed"].includes(state.stage);
    }
    return true;
  }
  if (role.role === "author") return false;
  if (role.role === "review") return state.stage !== "review";
  if (role.role === "final") {
    if (role.round < state.round) return true;
    return Boolean(
      state.finals.find(
        (run) =>
          run.round === role.round && run.slot === role.slot && run.completedAt,
      ),
    );
  }
  if (role.role === "merge") {
    return ["validation", "complete", "validation_failed"].includes(
      state.stage,
    );
  }
  return ["complete", "validation_failed"].includes(state.stage);
}

export function getLaneStageView(lane: LaneConfig): string {
  const state = getLaneDeliveryState<LaneDeliveryState>(lane.id);
  if (!lane.delivery) return "author";
  if (!state) return "author → waiting";
  const finalSummary = state.finals
    .filter((run) => run.round === state.round)
    .map((run) => run.verdict ?? "running")
    .join("+");
  const parts = ["author"];
  if (lane.delivery.review)
    parts.push(state.review?.completedAt ? "review✓" : "review");
  if (lane.delivery.finals)
    parts.push(
      finalSummary ? `finals(${finalSummary})` : `finals r${state.round}`,
    );
  if (lane.delivery.merge) parts.push(state.mergedSha ? "merge✓" : "merge");
  if (lane.delivery.validation) {
    parts.push(
      state.validationResult === "passed"
        ? "validation✓"
        : state.validationResult === "failed"
          ? "validation✗"
          : "validation",
    );
  }
  return `${parts.join(" → ")} · ${state.stage}`;
}

function roleToken(
  laneId: string,
  role: DeliveryRun["role"],
  round?: number,
  slot?: number,
): string {
  return role === "final"
    ? `[lane:${laneId}:final:r${round ?? 1}:s${slot ?? 1}:`
    : `[lane:${laneId}:${role}:`;
}

function readTemplate(config: LanesConfig, templatePath: string): string {
  const resolved = path.isAbsolute(templatePath)
    ? templatePath
    : path.join(path.dirname(config.configPath), templatePath);
  return readFileSync(resolved, "utf8");
}

function newestSession(
  sessions: ConductorApiSession[],
): ConductorApiSession | null {
  const active = sessions.filter((session) => !session.archivedAt);
  if (active.length === 0) return null;
  return active
    .map((session, index) => ({ session, index }))
    .sort((a, b) => {
      const byDate = (b.session.createdAt ?? "").localeCompare(
        a.session.createdAt ?? "",
      );
      return byDate || a.index - b.index;
    })[0].session;
}

function compareNewest(
  a: ConductorApiWorkspace,
  b: ConductorApiWorkspace,
): number {
  return (b.lastActivityAt ?? b.createdAt).localeCompare(
    a.lastActivityAt ?? a.createdAt,
  );
}

async function listAllMessages(
  client: ConductorApiClient,
  sessionId: string,
): Promise<ConductorApiMessage[]> {
  const messages: ConductorApiMessage[] = [];
  let after: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const batch = await client.listSessionMessages({
      sessionId,
      after,
      limit: 100,
    });
    if (batch.length === 0) break;
    messages.push(...batch);
    after = batch.at(-1)?.id;
    if (batch.length < 100) break;
  }
  return messages;
}

function saveState(
  state: LaneDeliveryState,
  states: Map<string, LaneDeliveryState | null>,
): void {
  setLaneDeliveryState(state.laneId, state);
  states.set(state.laneId, state);
}

async function safeNotify(
  notify: (text: string) => Promise<void>,
  text: string,
): Promise<void> {
  try {
    await notify(text);
  } catch {
    // A Telegram outage must not roll back scheduler state.
  }
}
