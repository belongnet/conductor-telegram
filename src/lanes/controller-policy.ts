import { createHash } from "node:crypto";
import type { ManifestLane, ManifestProvider, LaneManifestV2 } from "./manifest.js";
import type {
  LaneAttemptRecord,
  LaneRunRecord,
  LaneSnapshotV2,
} from "./state-store.js";

export const LANE_LEASE_SECONDS = 75;
export const LANE_HEARTBEAT_SECONDS = 20;
export const LANE_ACTIVE_POLL_SECONDS = 30;
export const LANE_IDLE_POLL_SECONDS = 180;
export const LANE_FULL_RECONCILE_SECONDS = 900;
export const LANE_STANDBY_POLL_SECONDS = 20;
// One full lease window and longer than every lane mutation's client-side
// timeout. A standby never concludes that a crashed owner's pending mutation
// is absent while that owner's request can still be in flight.
export const LANE_ACTION_SETTLE_SECONDS = 75;

export const ACTIVE_ATTEMPT_STATUSES = new Set([
  "commissioned",
  "working",
  "awaiting_result",
]);
export const TERMINAL_RUN_STATUSES = new Set([
  "validated",
  "failed",
  "cancelled",
  "superseded",
]);

export function deterministicLaneId(prefix: string, ...parts: unknown[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => String(part)).join("\u001f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${digest}`;
}

export function deterministicUuid(...parts: unknown[]): string {
  const hex = createHash("sha256")
    .update(parts.map((part) => String(part)).join("\u001f"))
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function managedWorkspaceName(input: {
  laneId: string;
  runId: string;
  stage: string;
  attempt: number;
  title?: string;
}): string {
  const title = input.title?.replace(/\s+/g, " ").trim();
  return (
    `[managed:growth][lane:${input.laneId}][run:${input.runId}]` +
    `[stage:${input.stage}][attempt:${input.attempt}]` +
    (title ? ` ${title}` : "")
  );
}

export function managedSessionName(input: {
  laneId: string;
  runId: string;
  stage: string;
  attempt: number;
  provider: ManifestProvider;
}): string {
  return (
    `[managed:growth][lane:${input.laneId}][run:${input.runId}]` +
    `[stage:${input.stage}][attempt:${input.attempt}][provider:${input.provider}]`
  );
}

function breakerOpen(
  provider: ManifestProvider,
  snapshot: LaneSnapshotV2,
  now: Date
): boolean {
  const health = snapshot.providers.find(
    (entry) => entry.provider === provider
  );
  if (!health) return false;
  if (health.state === "disabled") return true;
  if (health.state !== "open") return false;
  const until = Date.parse(String(health.breaker_until ?? ""));
  return !Number.isFinite(until) || until > now.getTime();
}

export function selectProvider(input: {
  manifest: LaneManifestV2;
  lane: ManifestLane;
  snapshot: LaneSnapshotV2;
  role: "implementation" | "review" | "final" | "validation";
  authorProvider?: string | null;
  excluded?: ReadonlySet<string>;
  now?: Date;
}): ManifestProvider | null {
  const rotation = [
    ...input.lane.preferred_providers,
    ...input.lane.fallback_providers,
  ];
  const now = input.now ?? new Date();
  for (const provider of rotation) {
    if (input.excluded?.has(provider)) continue;
    if (
      (input.role === "review" || input.role === "validation") &&
      provider === input.authorProvider
    ) {
      continue;
    }
    if (breakerOpen(provider, input.snapshot, now)) continue;
    const capacity = input.snapshot.capacity[provider];
    const limit = input.manifest.global.provider_capacity[provider];
    if ((capacity?.active ?? 0) >= (capacity?.limit ?? limit)) continue;
    return provider;
  }
  return null;
}

export function attemptsForRun(
  snapshot: LaneSnapshotV2,
  runId: string
): LaneAttemptRecord[] {
  return snapshot.attempts
    .filter((attempt) => attempt.run_id === runId)
    .sort((left, right) => left.attempt_number - right.attempt_number);
}

export function nextAttemptNumber(
  snapshot: LaneSnapshotV2,
  runId: string,
  role?: LaneAttemptRecord["role"]
): number {
  return (
    Math.max(
      0,
      ...attemptsForRun(snapshot, runId)
        .filter((attempt) => !role || attempt.role === role)
        .map((attempt) => attempt.attempt_number)
    ) + 1
  );
}

export function activeAttempt(
  snapshot: LaneSnapshotV2,
  runId: string,
  role: LaneAttemptRecord["role"]
): LaneAttemptRecord | null {
  return (
    attemptsForRun(snapshot, runId)
      .filter(
        (attempt) =>
          attempt.role === role && ACTIVE_ATTEMPT_STATUSES.has(attempt.status)
      )
      .at(-1) ?? null
  );
}

export function runPriority(run: LaneRunRecord): number {
  const rank: Record<string, number> = {
    merging: 0,
    validating: 1,
    reviewing: 2,
    finals: 2,
    rework: 2,
    pr_bound: 3,
    implementing: 4,
    queued: 5,
    paused_safety: 6,
    quarantined: 7,
  };
  return (rank[run.status] ?? 8) * 1_000_000 - run.priority;
}

export function sortedActionableRuns(snapshot: LaneSnapshotV2): LaneRunRecord[] {
  return snapshot.runs
    .filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))
    .sort((left, right) => {
      const priority = runPriority(left) - runPriority(right);
      return priority || left.created_at.localeCompare(right.created_at);
    });
}

export function recurringIntervalMs(schedule: string): number | null {
  const normalized = schedule.trim().toLowerCase();
  if (normalized === "daily" || normalized === "@daily") return 86_400_000;
  if (normalized === "weekly" || normalized === "@weekly") return 604_800_000;
  const duration = normalized.match(/^every\s+(\d+)\s*(m|h|d)$/);
  if (!duration) return null;
  const value = Number(duration[1]);
  const multiplier =
    duration[2] === "m" ? 60_000 : duration[2] === "h" ? 3_600_000 : 86_400_000;
  return value > 0 ? value * multiplier : null;
}

export function laneGenerationDue(input: {
  lane: ManifestLane;
  runs: readonly LaneRunRecord[];
  now?: Date;
}): { due: boolean; generation: number; recurring: boolean } {
  const laneRuns = input.runs
    .filter((run) => run.lane_id === input.lane.id)
    .sort((left, right) => right.generation - left.generation);
  if (laneRuns.some((run) => !TERMINAL_RUN_STATUSES.has(run.status))) {
    return { due: false, generation: (laneRuns[0]?.generation ?? 0) + 1, recurring: false };
  }
  const next = (laneRuns[0]?.generation ?? 0) + 1;
  if (input.lane.policy.kind === "one_shot") {
    return { due: laneRuns.length === 0, generation: next, recurring: false };
  }
  const interval = recurringIntervalMs(input.lane.policy.schedule);
  if (interval === null) return { due: false, generation: next, recurring: true };
  const latest = laneRuns[0];
  if (!latest) return { due: true, generation: next, recurring: true };
  const completedAt = Date.parse(latest.terminal_at ?? latest.updated_at);
  return {
    due:
      Number.isFinite(completedAt) &&
      completedAt + interval <= (input.now ?? new Date()).getTime(),
    generation: next,
    recurring: true,
  };
}
