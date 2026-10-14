import { createHash } from "node:crypto";
import {
  requiredChecksGate,
  type GithubCommitChecksSnapshot,
  type RequiredChecksGate,
} from "../bot/github.js";
import type { PrChecksStatus } from "../types/index.js";
import { blankForCommandCenter, type ManifestLane } from "./manifest.js";

// Command Center (belong-agents #537) accepts pre-merge evidence for a lane
// with named required checks only as an exact receipt: the Git host, project,
// base branch, commit and pipeline, plus one successful receipt per named
// check in manifest order. With canonical evidence, both the pre-merge and the
// merged-commit evidence must come from that host and project. A green summary
// from a mirror never counts.

export type CanonicalEvidenceIdentity = {
  kind: "github" | "gitlab";
  /** Lower-cased owner/repository or group/project. */
  projectPath: string;
  baseBranch: string;
};

type LaneDelivery = Pick<ManifestLane, "delivery_adapter">;
type RunIdentity = { repo_owner: string; repo_name: string; base_branch: string };

export function canonicalEvidenceIdentity(
  lane: LaneDelivery,
  run: RunIdentity
): CanonicalEvidenceIdentity {
  const configured = lane.delivery_adapter.canonical_evidence;
  if (configured) {
    return {
      kind: configured.kind,
      projectPath: configured.project_path.toLowerCase(),
      baseBranch: configured.base_branch,
    };
  }
  return {
    kind: lane.delivery_adapter.kind,
    projectPath: `${run.repo_owner}/${run.repo_name}`.toLowerCase(),
    baseBranch: run.base_branch,
  };
}

export function laneRequiredChecks(lane: LaneDelivery): string[] {
  return [...(lane.delivery_adapter.required_checks ?? [])];
}

export function requiresExactCheckReceipt(lane: LaneDelivery): boolean {
  return (
    laneRequiredChecks(lane).length > 0 ||
    Boolean(lane.delivery_adapter.canonical_evidence)
  );
}

/** What one Git host reported for one exact commit. */
export type CheckObservation = {
  source: "github" | "gitlab";
  /** Lower-cased owner/repository or group/project the host was asked about. */
  projectPath: string;
  sha: string;
  /** The pipeline, or for GitHub the check runs and statuses, behind the result; null when none exists yet. */
  pipelineId: string | number | null;
  status: PrChecksStatus;
  summary: string;
  checks: Array<{ name: string; status: PrChecksStatus; id?: string }>;
};

/** Command Center's bound on a pipeline identifier, counted in code points. */
export const MAX_PIPELINE_ID_LENGTH = 512;

export function validPipelineId(value: unknown): value is string | number {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
  return (
    typeof value === "string" &&
    !blankForCommandCenter(value) &&
    [...value].length <= MAX_PIPELINE_ID_LENGTH &&
    !/[\r\n\0]/.test(value)
  );
}

/** GitHub has no single pipeline: name the check runs and statuses behind the result. */
export function githubPipelineId(sourceIds: readonly string[]): string | null {
  const unique = [...new Set(sourceIds.filter(Boolean))].sort();
  if (unique.length === 0) return null;
  const joined = unique.map((id) => `github-${id}`).join("+");
  return joined.length <= MAX_PIPELINE_ID_LENGTH
    ? joined
    : `github-checks-${createHash("sha256").update(joined).digest("hex")}`;
}

export function githubCheckObservation(
  snapshot: GithubCommitChecksSnapshot,
  requiredChecks: readonly string[]
): CheckObservation {
  const checks = snapshot.checks ?? [];
  const behindResult =
    requiredChecks.length > 0
      ? checks.filter((check) => requiredChecks.includes(check.name))
      : checks;
  return {
    source: "github",
    projectPath: `${snapshot.repoOwner}/${snapshot.repoName}`.toLowerCase(),
    sha: snapshot.sha.toLowerCase(),
    pipelineId: githubPipelineId(
      behindResult.flatMap((check) => (check.id ? [check.id] : []))
    ),
    status: snapshot.status,
    summary: snapshot.summary,
    checks,
  };
}

export type CheckEvidence = {
  /** Never passing unless the evidence would be accepted as an exact receipt. */
  gate: RequiredChecksGate;
  identityMatches: boolean;
  payload: Record<string, unknown>;
};

/** The exact receipt for a lane that needs one (see requiresExactCheckReceipt). */
export function buildCheckEvidence(input: {
  lane: LaneDelivery;
  run: RunIdentity;
  sha: string;
  observation: CheckObservation;
}): CheckEvidence {
  const { lane, observation } = input;
  const sha = input.sha.toLowerCase();
  const identity = canonicalEvidenceIdentity(lane, input.run);
  const required = laneRequiredChecks(lane);
  const identityMatches =
    observation.source === identity.kind &&
    observation.projectPath.toLowerCase() === identity.projectPath &&
    observation.sha.toLowerCase() === sha;
  // Named checks alone decide, as in Command Center: the rest of the pipeline
  // is not consulted. check_allowlist needs no filter here: the manifest puts
  // every named check on it, and receipts only ever name the named checks.
  const named = requiredChecksGate(
    { checksStatus: observation.status, checks: observation.checks },
    required
  );
  const pipeline = `${identity.kind} pipeline`;
  let gate: RequiredChecksGate =
    required.length > 0
      ? named
      : observation.pipelineId === null
        ? { passing: false, missing: [pipeline], notPassing: [], pending: [], failed: [] }
        : observation.status === "passing"
          ? { passing: true, missing: [], notPassing: [], pending: [], failed: [] }
          : observation.status === "failing"
            ? { passing: false, missing: [], notPassing: [pipeline], pending: [], failed: [pipeline] }
            : { passing: false, missing: [], notPassing: [pipeline], pending: [pipeline], failed: [] };
  if (gate.passing && !(identityMatches && validPipelineId(observation.pipelineId))) {
    // Green checks without a provable receipt are waited on, never merged on.
    const receipt = `${pipeline} receipt`;
    gate = { passing: false, missing: [], notPassing: [receipt], pending: [receipt], failed: [] };
  }
  return {
    gate,
    identityMatches,
    payload: {
      all_green: gate.passing,
      pending: gate.missing.length + gate.pending.length,
      failed: gate.failed.length,
      summary: observation.summary,
      required_checks: required,
      missing_required_checks: required.length > 0 ? gate.missing : [],
      nonpassing_required_checks: required.length > 0 ? gate.notPassing : [],
      source: identity.kind,
      project_path: identity.projectPath,
      base_branch: identity.baseBranch,
      commit_sha: sha,
      pipeline_id: observation.pipelineId,
      // Each receipt reports what the gate decided for that check.
      checks: required.map((name) => ({
        name,
        status: named.missing.includes(name)
          ? "missing"
          : named.failed.includes(name)
            ? "failure"
            : named.pending.includes(name)
              ? "pending"
              : "success",
        commit_sha: sha,
      })),
    },
  };
}
