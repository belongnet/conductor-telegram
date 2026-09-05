import path from "node:path";
import os from "node:os";
import type { LaneManifestV2, ManifestProvider } from "./manifest.js";

export type LeaseCredentials = {
  lease_name: string;
  lease_token: string;
  fence: number;
};

export type LaneLease = LeaseCredentials & {
  owner_id: string;
  owner_site: "mac" | "ovh";
  expires_at: string;
  heartbeat_at: string;
  row_version: number;
};

export type LaneRunRecord = {
  run_id: string;
  manifest_revision_id: string;
  lane_id: string;
  generation: number;
  status: string;
  stage: string;
  priority: number;
  repo_owner: string;
  repo_name: string;
  base_branch: string;
  author_provider: string | null;
  provider: string | null;
  model: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  session_id: string | null;
  pr_number: number | null;
  pr_url: string | null;
  head_branch: string | null;
  head_sha: string | null;
  merged_sha: string | null;
  progress_cursor: string | null;
  nudge_cursor: string | null;
  ineffective_nudges: number;
  retry_at: string | null;
  ambiguous_action_id: string | null;
  legacy_verified: boolean;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  row_version: number;
};

export type LaneAttemptRecord = {
  attempt_id: string;
  run_id: string;
  stage: string;
  attempt_number: number;
  role: "implementation" | "review" | "final" | "validation";
  provider: ManifestProvider;
  model: string;
  status: string;
  nonce: string;
  head_sha: string | null;
  workspace_id: string | null;
  session_id: string | null;
  progress_cursor: string | null;
  nudge_cursor: string | null;
  ineffective_nudges: number;
  result_json: Record<string, unknown>;
  row_version: number;
};

export type LaneActionRecordV2 = {
  action_id: string;
  deterministic_tag: string;
  run_id: string;
  stage: string;
  attempt_id: string | null;
  action_type: string;
  status: "pending" | "succeeded" | "failed" | "ambiguous" | "reconciled";
  request_json: Record<string, unknown>;
  result_json: Record<string, unknown>;
  external_ref: string | null;
  error: string | null;
  started_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  row_version: number;
};

export type LaneControlRecord = {
  control_id: string;
  idempotency_key: string;
  kind: string;
  lane_id: string | null;
  requested_by: string;
  payload_json: Record<string, unknown>;
  status: "pending" | "applied" | "rejected";
  human_approved: boolean;
  row_version: number;
};

export type LaneSnapshotV2 = {
  manifest: null | {
    revision_id: string;
    manifest_hash: string;
    source_ref: string;
    manifest_json: Record<string, unknown>;
    state: string;
    row_version: number;
  };
  controller: null | {
    state_id: 1;
    mode: "disabled" | "shadow" | "active" | "paused_safety";
    active_revision_id: string | null;
    reason: string | null;
    updated_at: string;
    row_version: number;
  };
  lease: null | Record<string, unknown>;
  capacity: Record<string, { active: number; limit: number }>;
  providers: Array<Record<string, unknown>>;
  runs: LaneRunRecord[];
  attempts: LaneAttemptRecord[];
  ambiguous_actions: LaneActionRecordV2[];
  pending_actions: LaneActionRecordV2[];
  pending_controls: LaneControlRecord[];
  dependencies: Record<
    string,
    {
      ready: boolean;
      requirements: Array<{
        lane_id: string;
        milestone: "pr_opened" | "merged" | "validated";
        reached: boolean;
      }>;
    }
  >;
  duplicates: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  next_event_seq: number;
};

export type CreateRunInput = {
  run_id: string;
  manifest_revision_id: string;
  lane_id: string;
  generation: number;
  priority: number;
  metadata?: Record<string, unknown>;
  legacy_verified?: boolean;
};

export type TransitionRunInput = {
  expected_version: number;
  from_status: string;
  to_status: string;
  stage: string;
  patch?: Record<string, unknown>;
};

export type BeginAttemptInput = {
  attempt_id: string;
  expected_run_version: number;
  stage: string;
  attempt_number: number;
  role: LaneAttemptRecord["role"];
  provider: ManifestProvider;
  model: string;
  nonce: string;
  head_sha?: string;
  workspace_id?: string;
  session_id?: string;
};

export type UpdateAttemptInput = {
  expected_attempt_version: number;
  expected_run_version: number;
  status: string;
  workspace_id?: string;
  session_id?: string;
  progress_cursor?: string;
  nudge_cursor?: string;
  ineffective_nudges?: number;
  result?: Record<string, unknown>;
};

export type BeginActionInput = {
  action_id: string;
  deterministic_tag: string;
  expected_run_version: number;
  stage: string;
  attempt_id?: string;
  action_type: string;
  request: Record<string, unknown>;
};

export type FinishActionInput = {
  expected_action_version: number;
  expected_run_version: number;
  status: LaneActionRecordV2["status"];
  result?: Record<string, unknown>;
  external_ref?: string;
  error?: string;
};

export type EvidenceInput = {
  evidence_id: string;
  external_key: string;
  expected_run_version: number;
  attempt_id?: string;
  evidence_type: string;
  provider?: string;
  nonce?: string;
  repo_owner: string;
  repo_name: string;
  head_sha: string;
  evidence: Record<string, unknown>;
  observed_at?: string;
};

export type ProviderHealthInput = {
  expected_version: number;
  provider: ManifestProvider;
  outcome:
    | "success"
    | "transient_failure"
    | "quota_failure"
    | "auth_failure"
    | "disable"
    | "enable";
  error_code?: string;
  breaker_seconds?: number;
};

export type NotificationClaimInput = {
  notification_key: string;
  message_hash: string;
  expected_controller_version: number;
};

export type LaneNotificationClaim = {
  notification_key: string;
  message_hash: string;
  claimed: boolean;
  claimed_by: string;
  lease_fence: number;
  claimed_at: string;
  row_version: number;
};

export interface LaneStateStore {
  readonly kind: "http" | "sqlite";
  claimLease(input: {
    ownerId: string;
    ownerSite: "mac" | "ovh";
    leaseSeconds?: number;
  }): Promise<LaneLease | null>;
  renewLease(
    lease: LeaseCredentials,
    heartbeat: Record<string, unknown>,
    leaseSeconds?: number
  ): Promise<LaneLease>;
  releaseLease(lease: LeaseCredentials): Promise<void>;
  snapshot(sinceEventSeq?: number): Promise<LaneSnapshotV2>;
  stageManifest(
    lease: LeaseCredentials,
    input: {
      revisionId: string;
      sourceRef: string;
      manifest: LaneManifestV2;
      createdBy: string;
    }
  ): Promise<Record<string, unknown>>;
  activateManifest(
    lease: LeaseCredentials,
    revisionId: string,
    expectedManifestVersion: number
  ): Promise<Record<string, unknown>>;
  createRun(
    lease: LeaseCredentials,
    input: CreateRunInput
  ): Promise<LaneRunRecord>;
  transitionRun(
    lease: LeaseCredentials,
    runId: string,
    input: TransitionRunInput
  ): Promise<LaneRunRecord>;
  beginAttempt(
    lease: LeaseCredentials,
    runId: string,
    input: BeginAttemptInput
  ): Promise<LaneAttemptRecord>;
  updateAttempt(
    lease: LeaseCredentials,
    attemptId: string,
    input: UpdateAttemptInput
  ): Promise<LaneAttemptRecord>;
  beginAction(
    lease: LeaseCredentials,
    runId: string,
    input: BeginActionInput
  ): Promise<LaneActionRecordV2>;
  finishAction(
    lease: LeaseCredentials,
    actionId: string,
    input: FinishActionInput
  ): Promise<LaneActionRecordV2>;
  recordEvidence(
    lease: LeaseCredentials,
    runId: string,
    input: EvidenceInput
  ): Promise<Record<string, unknown>>;
  recordProviderHealth(
    lease: LeaseCredentials,
    input: ProviderHealthInput
  ): Promise<Record<string, unknown>>;
  claimNotification(
    lease: LeaseCredentials,
    input: NotificationClaimInput
  ): Promise<LaneNotificationClaim>;
  createControl(input: {
    control_id: string;
    idempotency_key: string;
    kind: string;
    lane_id?: string;
    requested_by: string;
    payload?: Record<string, unknown>;
    approvalKey?: string;
  }): Promise<LaneControlRecord>;
  finishControl(
    lease: LeaseCredentials,
    controlId: string,
    input: {
      expected_version: number;
      expected_controller_version: number;
      status: "applied" | "rejected";
      result?: Record<string, unknown>;
    }
  ): Promise<LaneControlRecord>;
  close(): Promise<void>;
}

export class LaneStateStoreError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "LaneStateStoreError";
  }

  get conflict(): boolean {
    return this.status === 409;
  }
}

export const DEFAULT_LANE_SQLITE_PATH = path.join(
  os.homedir(),
  ".conductor-telegram",
  "lanes-standalone.db"
);

export async function createLaneStateStore(
  env: NodeJS.ProcessEnv = process.env
): Promise<LaneStateStore> {
  const backend = env.LANES_STATE_BACKEND?.trim().toLowerCase();
  if (backend === "http") {
    const baseUrl = env.COMMAND_CENTER_API_BASE_URL?.trim();
    const apiKey =
      env.COMMAND_CENTER_API_KEY?.trim() || env.BELONG_AGENTS_API_KEY?.trim();
    if (!baseUrl || !apiKey) {
      throw new LaneStateStoreError(
        "HTTP lane state requires COMMAND_CENTER_API_BASE_URL and COMMAND_CENTER_API_KEY (or BELONG_AGENTS_API_KEY)"
      );
    }
    const { HttpLaneStateStore } = await import("./state-store-http.js");
    return new HttpLaneStateStore({ baseUrl, apiKey });
  }
  if (backend === "sqlite") {
    if (!/^(1|true|yes)$/i.test(env.LANES_STANDALONE ?? "")) {
      throw new LaneStateStoreError(
        "SQLite lane state is standalone/test only; set LANES_STANDALONE=1 explicitly"
      );
    }
    const { SqliteLaneStateStore } = await import("./state-store-sqlite.js");
    return new SqliteLaneStateStore(
      env.LANES_SQLITE_PATH?.trim() || DEFAULT_LANE_SQLITE_PATH
    );
  }
  throw new LaneStateStoreError(
    "LANES_STATE_BACKEND must be explicitly set to http or sqlite; there is no production fallback"
  );
}
