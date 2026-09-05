import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { LaneManifestV2, ManifestProvider } from "./manifest.js";
import type {
  BeginActionInput,
  BeginAttemptInput,
  CreateRunInput,
  EvidenceInput,
  FinishActionInput,
  LaneActionRecordV2,
  LaneAttemptRecord,
  LaneControlRecord,
  LaneLease,
  LaneNotificationClaim,
  LaneRunRecord,
  LaneSnapshotV2,
  LaneStateStore,
  LeaseCredentials,
  NotificationClaimInput,
  ProviderHealthInput,
  TransitionRunInput,
  UpdateAttemptInput,
} from "./state-store.js";
import { LaneStateStoreError } from "./state-store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lane_v2_lease (
  lease_name TEXT PRIMARY KEY, owner_id TEXT, owner_site TEXT, lease_token TEXT,
  fence INTEGER NOT NULL DEFAULT 0, expires_at TEXT, heartbeat_at TEXT,
  heartbeat_json TEXT NOT NULL DEFAULT '{}', row_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lane_v2_controller (
  state_id INTEGER PRIMARY KEY CHECK (state_id = 1), mode TEXT NOT NULL,
  active_revision_id TEXT, reason TEXT, updated_at TEXT NOT NULL,
  row_version INTEGER NOT NULL
);
INSERT OR IGNORE INTO lane_v2_controller
  (state_id, mode, active_revision_id, reason, updated_at, row_version)
VALUES (1, 'disabled', NULL, 'awaiting cutover approval', datetime('now'), 1);
CREATE TABLE IF NOT EXISTS lane_v2_manifests (
  revision_id TEXT PRIMARY KEY, manifest_hash TEXT NOT NULL UNIQUE,
  source_ref TEXT NOT NULL, manifest_json TEXT NOT NULL, state TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, activated_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS lane_v2_one_manifest
  ON lane_v2_manifests(state) WHERE state = 'active';
CREATE TABLE IF NOT EXISTS lane_v2_runs (
  run_id TEXT PRIMARY KEY, lane_id TEXT NOT NULL, generation INTEGER NOT NULL,
  status TEXT NOT NULL, row_version INTEGER NOT NULL, payload_json TEXT NOT NULL,
  UNIQUE(lane_id, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS lane_v2_one_active_run
  ON lane_v2_runs(lane_id)
  WHERE status NOT IN ('validated','failed','cancelled','superseded');
CREATE TABLE IF NOT EXISTS lane_v2_attempts (
  attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, stage TEXT NOT NULL,
  provider TEXT NOT NULL, status TEXT NOT NULL, row_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS lane_v2_one_active_attempt
  ON lane_v2_attempts(run_id, stage)
  WHERE status IN ('commissioned','working','awaiting_result');
CREATE TABLE IF NOT EXISTS lane_v2_actions (
  action_id TEXT PRIMARY KEY, deterministic_tag TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL,
  row_version INTEGER NOT NULL, payload_json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS lane_v2_one_unresolved_action
  ON lane_v2_actions(run_id, stage) WHERE status IN ('pending','ambiguous');
CREATE TABLE IF NOT EXISTS lane_v2_evidence (
  evidence_id TEXT PRIMARY KEY, external_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL, head_sha TEXT NOT NULL, evidence_type TEXT NOT NULL,
  accepted INTEGER NOT NULL, payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lane_v2_providers (
  provider TEXT PRIMARY KEY, row_version INTEGER NOT NULL, payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lane_v2_controls (
  control_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, row_version INTEGER NOT NULL, payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lane_v2_notifications (
  notification_key TEXT PRIMARY KEY, message_hash TEXT NOT NULL,
  claimed_by TEXT NOT NULL, lease_fence INTEGER NOT NULL,
  claimed_at TEXT NOT NULL, row_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lane_v2_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
  run_id TEXT, data_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS lane_v2_events_no_update
BEFORE UPDATE ON lane_v2_events
BEGIN SELECT RAISE(ABORT, 'lane events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS lane_v2_events_no_delete
BEFORE DELETE ON lane_v2_events
BEGIN SELECT RAISE(ABORT, 'lane events are append-only'); END;
`;

const TERMINAL = new Set(["validated", "failed", "cancelled", "superseded"]);
const ACTIVE_ATTEMPT = new Set(["commissioned", "working", "awaiting_result"]);
const GIT_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;

function safeIdentifier(value: string, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!SAFE_ID_RE.test(normalized)) {
    throw new LaneStateStoreError(`${field} has an unsupported format`, 400);
  }
  return normalized;
}

function fullGitSha(value: string, field: string): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!GIT_SHA_RE.test(normalized)) {
    throw new LaneStateStoreError(
      `${field} must be a full hexadecimal Git SHA`,
      400
    );
  }
  return normalized;
}
const ATTEMPT_STATUSES = new Set([
  "commissioned",
  "working",
  "awaiting_result",
  "completed",
  "failed",
  "superseded",
  "cancelled",
]);
const ATTEMPT_TRANSITIONS: Record<string, Set<string>> = {
  commissioned: new Set(ATTEMPT_STATUSES),
  working: new Set(["working", "awaiting_result", "completed", "failed", "superseded", "cancelled"]),
  awaiting_result: new Set(["awaiting_result", "working", "completed", "failed", "superseded", "cancelled"]),
  completed: new Set(["completed", "superseded"]),
  failed: new Set(["failed"]),
  superseded: new Set(["superseded"]),
  cancelled: new Set(["cancelled"]),
};
const ALLOWED_ACTIONS = new Set([
  "create_workspace",
  "create_session",
  "nudge_session",
  "archive_workspace",
  "send_prompt",
  "post_attestation",
  "post_notice",
  "merge_pr",
]);
const ALLOWED_EVIDENCE = new Set([
  "adversarial_review",
  "final_attestation",
  "required_checks",
  "mergeability",
  "merged_ci",
  "deterministic_validation",
  "workspace_state",
  "pr_binding",
]);
const TRANSITIONS: Record<string, Set<string>> = {
  queued: new Set(["implementing", "validating", "paused_safety", "quarantined", "failed"]),
  implementing: new Set(["pr_bound", "paused_safety", "quarantined", "failed"]),
  pr_bound: new Set(["reviewing", "paused_safety", "quarantined", "failed"]),
  reviewing: new Set(["rework", "finals", "paused_safety", "quarantined", "failed"]),
  rework: new Set([
    "implementing",
    "pr_bound",
    "reviewing",
    "paused_safety",
    "quarantined",
    "failed",
  ]),
  finals: new Set(["reviewing", "rework", "merging", "paused_safety", "quarantined", "failed"]),
  merging: new Set(["reviewing", "validating", "paused_safety", "quarantined", "failed"]),
  validating: new Set([
    "validated",
    "rework",
    "paused_safety",
    "quarantined",
    "failed",
  ]),
  paused_safety: new Set(["queued", "implementing", "pr_bound", "reviewing", "rework", "finals", "merging", "validating", "quarantined", "failed"]),
  quarantined: new Set(["queued", "paused_safety", "failed", "superseded"]),
};

function deliveryPrIdentity(
  value: unknown,
  kind: "github" | "gitlab"
): { owner: string; repo: string; number: number } | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname.includes("%")
    ) {
      return null;
    }
    const parts = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (kind === "github") {
      if (
        parsed.hostname.toLowerCase() !== "github.com" ||
        parts.length !== 4 ||
        parts[2] !== "pull" ||
        !/^\d+$/.test(parts[3] ?? "")
      ) {
        return null;
      }
      const number = Number(parts[3]);
      if (!Number.isSafeInteger(number) || number < 1) return null;
      return {
        owner: parts[0]!.toLowerCase(),
        repo: parts[1]!.replace(/\.git$/i, "").toLowerCase(),
        number,
      };
    }
    if (parsed.hostname.toLowerCase() !== "gitlab.com") return null;
    const marker = parts.lastIndexOf("-");
    if (
      marker < 2 ||
      marker + 3 !== parts.length ||
      parts[marker + 1] !== "merge_requests" ||
      !/^\d+$/.test(parts[marker + 2] ?? "")
    ) {
      return null;
    }
    const number = Number(parts[marker + 2]);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    return {
      owner: parts.slice(0, marker - 1).join("/").toLowerCase(),
      repo: parts[marker - 1]!.replace(/\.git$/i, "").toLowerCase(),
      number,
    };
  } catch {
    return null;
  }
}

type Stored<T> = T & { row_version: number };

function now(): string {
  return new Date().toISOString();
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  if (!value) return "''";
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function manifestValidationCommands(
  lane: LaneManifestV2["lanes"][number],
  mergedSha: string
): Array<{
  kind: "preflight" | "command" | "probe";
  index: number;
  command: string;
}> {
  const sha = shellQuote(mergedSha);
  return [
    ...[
      `git fetch --quiet origin ${sha}`,
      `git checkout --quiet --detach ${sha}`,
      `test "$(git rev-parse HEAD)" = ${sha}`,
      `test -z "$(git status --porcelain --untracked-files=all)"`,
    ].map((command, index) => ({
      kind: "preflight" as const,
      index,
      command,
    })),
    ...lane.validation_profile.commands.map((argv, index) => ({
      kind: "command" as const,
      index,
      command: argv.map(shellQuote).join(" "),
    })),
    ...lane.validation_profile.probes.map((probe, index) => ({
      kind: "probe" as const,
      index,
      command: [
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
      ].join(" "),
    })),
  ];
}

function hasExactConductorValidationReceipts(
  evidence: Record<string, unknown>,
  lane: LaneManifestV2["lanes"][number],
  mergedSha: string
): boolean {
  if (evidence.source !== "conductor_tool_events") return false;
  const receipts = Array.isArray(evidence.receipts) ? evidence.receipts : [];
  const expected = manifestValidationCommands(lane, mergedSha);
  return (
    receipts.length === expected.length &&
    receipts.every((entry, position) => {
      if (!entry || typeof entry !== "object") return false;
      const receipt = entry as Record<string, unknown>;
      const item = expected[position];
      return (
        receipt.kind === item?.kind &&
        receipt.index === item.index &&
        receipt.command === item.command &&
        receipt.exit_code === 0 &&
        typeof receipt.execution_id === "string" &&
        receipt.execution_id.length > 0 &&
        typeof receipt.message_id === "string" &&
        receipt.message_id.length > 0
      );
    })
  );
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function conflict(message: string): never {
  throw new LaneStateStoreError(message, 409);
}

export class SqliteLaneStateStore implements LaneStateStore {
  readonly kind = "sqlite" as const;
  private readonly db: Database.Database;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  private guard(lease: LeaseCredentials): LaneLease {
    const row = this.db
      .prepare("SELECT * FROM lane_v2_lease WHERE lease_name = ?")
      .get(lease.lease_name) as Record<string, unknown> | undefined;
    if (
      !row ||
      row.lease_token !== lease.lease_token ||
      Number(row.fence) !== lease.fence ||
      !row.expires_at ||
      Date.parse(String(row.expires_at)) <= Date.now()
    ) {
      conflict("controller lease is stale");
    }
    return row as LaneLease;
  }

  private event(
    type: string,
    runId: string | null,
    data: Record<string, unknown>
  ): void {
    this.db
      .prepare(
        "INSERT INTO lane_v2_events (event_type, run_id, data_json, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(type, runId, JSON.stringify(data), now());
  }

  async claimLease(input: {
    ownerId: string;
    ownerSite: "mac" | "ovh";
    leaseSeconds?: number;
  }): Promise<LaneLease | null> {
    return this.db.transaction(() => {
      const current = this.db
        .prepare("SELECT * FROM lane_v2_lease WHERE lease_name = 'growth'")
        .get() as Record<string, unknown> | undefined;
      if (!current && input.ownerSite === "ovh") return null;
      if (
        current?.lease_token &&
        current.expires_at &&
        Date.parse(String(current.expires_at)) > Date.now()
      ) {
        return null;
      }
      if (
        input.ownerSite === "ovh" &&
        current?.owner_site !== "mac" &&
        current?.owner_site !== "ovh"
      ) {
        return null;
      }
      const leaseToken = token();
      const fence = Number(current?.fence ?? 0) + 1;
      const stamp = now();
      const expires = new Date(
        Date.now() + (input.leaseSeconds ?? 75) * 1000
      ).toISOString();
      this.db
        .prepare(
          `INSERT INTO lane_v2_lease
             (lease_name, owner_id, owner_site, lease_token, fence, expires_at,
              heartbeat_at, heartbeat_json, row_version)
           VALUES ('growth', ?, ?, ?, ?, ?, ?, '{}', 1)
           ON CONFLICT(lease_name) DO UPDATE SET
             owner_id = excluded.owner_id, owner_site = excluded.owner_site,
             lease_token = excluded.lease_token, fence = excluded.fence,
             expires_at = excluded.expires_at, heartbeat_at = excluded.heartbeat_at,
             heartbeat_json = '{}', row_version = lane_v2_lease.row_version + 1`
        )
        .run(input.ownerId, input.ownerSite, leaseToken, fence, expires, stamp);
      return this.db
        .prepare("SELECT * FROM lane_v2_lease WHERE lease_name = 'growth'")
        .get() as LaneLease;
    })();
  }

  async renewLease(
    lease: LeaseCredentials,
    heartbeat: Record<string, unknown>,
    leaseSeconds = 75
  ): Promise<LaneLease> {
    return this.db.transaction(() => {
      const current = this.guard(lease);
      const stamp = now();
      const expires = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      const result = this.db
        .prepare(
          `UPDATE lane_v2_lease SET expires_at = ?, heartbeat_at = ?,
             heartbeat_json = ?, row_version = row_version + 1
           WHERE lease_name = ? AND lease_token = ? AND fence = ? AND row_version = ?`
        )
        .run(
          expires,
          stamp,
          JSON.stringify(heartbeat),
          lease.lease_name,
          lease.lease_token,
          lease.fence,
          current.row_version
        );
      if (result.changes !== 1) conflict("controller lease changed");
      return this.db
        .prepare("SELECT * FROM lane_v2_lease WHERE lease_name = ?")
        .get(lease.lease_name) as LaneLease;
    })();
  }

  async releaseLease(lease: LeaseCredentials): Promise<void> {
    this.db.transaction(() => {
      const current = this.guard(lease);
      const result = this.db
        .prepare(
          `UPDATE lane_v2_lease SET owner_id = NULL,
             lease_token = NULL, expires_at = NULL, row_version = row_version + 1
           WHERE lease_name = ? AND row_version = ?`
        )
        .run(lease.lease_name, current.row_version);
      if (result.changes !== 1) conflict("controller lease changed");
    })();
  }

  async stageManifest(
    lease: LeaseCredentials,
    input: {
      revisionId: string;
      sourceRef: string;
      manifest: LaneManifestV2;
      createdBy: string;
    }
  ): Promise<Record<string, unknown>> {
    return this.db.transaction(() => {
      this.guard(lease);
      const { manifestPath: _path, manifestHash, ...manifest } = input.manifest;
      const existing = this.db
        .prepare("SELECT * FROM lane_v2_manifests WHERE revision_id = ?")
        .get(input.revisionId) as Record<string, unknown> | undefined;
      if (existing) {
        if (
          existing.manifest_hash === manifestHash &&
          existing.manifest_json === JSON.stringify(manifest) &&
          existing.source_ref === input.sourceRef
        ) {
          return { ...existing, manifest_json: manifest };
        }
        conflict("manifest revision already exists with different content");
      }
      this.db
        .prepare(
          `INSERT INTO lane_v2_manifests
             (revision_id, manifest_hash, source_ref, manifest_json, state,
              created_by, created_at)
           VALUES (?, ?, ?, ?, 'staged', ?, ?)`
        )
        .run(
          input.revisionId,
          manifestHash,
          input.sourceRef,
          JSON.stringify(manifest),
          input.createdBy,
          now()
        );
      this.event("manifest_staged", null, { revision_id: input.revisionId });
      return {
        revision_id: input.revisionId,
        manifest_hash: manifestHash,
        source_ref: input.sourceRef,
        manifest_json: manifest,
        state: "staged",
        row_version: 1,
      };
    })();
  }

  async activateManifest(
    lease: LeaseCredentials,
    revisionId: string,
    expectedManifestVersion: number
  ): Promise<Record<string, unknown>> {
    return this.db.transaction(() => {
      this.guard(lease);
      const target = this.db
        .prepare("SELECT * FROM lane_v2_manifests WHERE revision_id = ?")
        .get(revisionId) as Record<string, unknown> | undefined;
      if (!target) throw new LaneStateStoreError("manifest not found", 404);
      if (target.state !== "active") {
        if (Number(target.row_version) !== expectedManifestVersion) {
          conflict("manifest row version changed");
        }
        const liveRun = this.db
          .prepare(
            `SELECT run_id,
                    json_extract(payload_json, '$.manifest_revision_id') AS manifest_revision_id
             FROM lane_v2_runs
             WHERE json_extract(payload_json, '$.manifest_revision_id') <> ?
               AND status NOT IN ('validated','failed','cancelled','superseded')
             LIMIT 1`
          )
          .get(revisionId) as
          | { run_id: string; manifest_revision_id: string }
          | undefined;
        if (liveRun) {
          conflict(
            `cannot activate manifest while run ${liveRun.run_id} uses ${liveRun.manifest_revision_id}`
          );
        }
        const active = this.db
          .prepare(
            "SELECT revision_id, row_version FROM lane_v2_manifests WHERE state = 'active'"
          )
          .get() as { revision_id: string; row_version: number } | undefined;
        if (active) {
          const retired = this.db
            .prepare(
              "UPDATE lane_v2_manifests SET state = 'retired', row_version = row_version + 1 WHERE revision_id = ? AND state = 'active' AND row_version = ?"
            )
            .run(active.revision_id, active.row_version);
          if (retired.changes !== 1) conflict("active manifest changed while retiring");
        }
        const result = this.db
          .prepare(
            "UPDATE lane_v2_manifests SET state = 'active', activated_at = ?, row_version = row_version + 1 WHERE revision_id = ? AND state = 'staged' AND row_version = ?"
          )
          .run(now(), revisionId, expectedManifestVersion);
        if (result.changes !== 1) conflict("only a staged manifest can activate");
        this.event("manifest_activated", null, { revision_id: revisionId });
      }
      const row = this.db
        .prepare("SELECT * FROM lane_v2_manifests WHERE revision_id = ?")
        .get(revisionId) as Record<string, unknown>;
      return { ...row, manifest_json: parse(String(row.manifest_json)) };
    })();
  }

  async createRun(
    lease: LeaseCredentials,
    input: CreateRunInput
  ): Promise<LaneRunRecord> {
    return this.db.transaction(() => {
      this.guard(lease);
      const existing = this.run(input.run_id);
      if (existing) {
        if (
          existing.lane_id === input.lane_id &&
          existing.generation === input.generation &&
          existing.manifest_revision_id === input.manifest_revision_id
        ) {
          return existing;
        }
        conflict("run identity differs");
      }
      const manifestRow = this.db
        .prepare(
          "SELECT manifest_json FROM lane_v2_manifests WHERE revision_id = ? AND state = 'active'"
        )
        .get(input.manifest_revision_id) as { manifest_json: string } | undefined;
      if (!manifestRow) conflict("run must use active manifest");
      const manifest = parse<LaneManifestV2>(manifestRow.manifest_json);
      const lane = manifest.lanes.find((candidate) => candidate.id === input.lane_id);
      if (!lane) throw new LaneStateStoreError("lane absent from manifest", 400);
      if (input.priority !== lane.priority) {
        conflict("run priority must match its manifest lane");
      }
      const stamp = now();
      const record: LaneRunRecord = {
        run_id: input.run_id,
        manifest_revision_id: input.manifest_revision_id,
        lane_id: input.lane_id,
        generation: input.generation,
        status: "queued",
        stage: "queued",
        priority: input.priority,
        repo_owner: lane.repository.owner,
        repo_name: lane.repository.name,
        base_branch: lane.repository.base_branch,
        author_provider: null,
        provider: null,
        model: null,
        workspace_id: null,
        workspace_name: null,
        session_id: null,
        pr_number: null,
        pr_url: null,
        head_branch: null,
        head_sha: null,
        merged_sha: null,
        progress_cursor: null,
        nudge_cursor: null,
        ineffective_nudges: 0,
        retry_at: null,
        ambiguous_action_id: null,
        legacy_verified: input.legacy_verified ?? false,
        metadata_json: input.metadata ?? {},
        created_at: stamp,
        updated_at: stamp,
        terminal_at: null,
        row_version: 1,
      };
      try {
        this.db
          .prepare(
            "INSERT INTO lane_v2_runs (run_id, lane_id, generation, status, row_version, payload_json) VALUES (?, ?, ?, ?, 1, ?)"
          )
          .run(
            record.run_id,
            record.lane_id,
            record.generation,
            record.status,
            JSON.stringify(record)
          );
      } catch {
        conflict("lane already has an active generation");
      }
      this.event("run_created", record.run_id, {
        lane_id: record.lane_id,
        generation: record.generation,
      });
      return record;
    })();
  }

  private run(runId: string): LaneRunRecord | null {
    const row = this.db
      .prepare("SELECT payload_json FROM lane_v2_runs WHERE run_id = ?")
      .get(runId) as { payload_json: string } | undefined;
    return row ? parse<LaneRunRecord>(row.payload_json) : null;
  }

  private saveRun(run: LaneRunRecord, expected: number): LaneRunRecord {
    const next = { ...run, row_version: expected + 1, updated_at: now() };
    const result = this.db
      .prepare(
        `UPDATE lane_v2_runs SET status = ?, row_version = ?, payload_json = ?
         WHERE run_id = ? AND row_version = ?`
      )
      .run(
        next.status,
        next.row_version,
        JSON.stringify(next),
        next.run_id,
        expected
      );
    if (result.changes !== 1) conflict("run row version changed");
    return next;
  }

  private manifestForRun(run: LaneRunRecord): LaneManifestV2 {
    const row = this.db
      .prepare("SELECT manifest_json FROM lane_v2_manifests WHERE revision_id = ?")
      .get(run.manifest_revision_id) as { manifest_json: string } | undefined;
    if (!row) conflict("run manifest is missing");
    return parse<LaneManifestV2>(row.manifest_json);
  }

  private acceptedEvidence(
    runId: string,
    sha: string,
    type: string
  ): Array<Record<string, unknown>> {
    return (
      this.db
        .prepare(
          "SELECT payload_json FROM lane_v2_evidence WHERE run_id = ? AND head_sha = ? AND evidence_type = ? AND accepted = 1"
        )
        .all(runId, sha, type) as Array<{ payload_json: string }>
    ).map((row) => parse<Record<string, unknown>>(row.payload_json));
  }

  private latestEvidence(
    runId: string,
    sha: string,
    type: string
  ): Record<string, unknown> | null {
    const row = this.db
      .prepare(
        "SELECT payload_json FROM lane_v2_evidence WHERE run_id = ? AND head_sha = ? AND evidence_type = ? ORDER BY rowid DESC LIMIT 1"
      )
      .get(runId, sha, type) as { payload_json: string } | undefined;
    return row ? parse<Record<string, unknown>>(row.payload_json) : null;
  }

  private freshEvidence(
    evidence: Record<string, unknown> | null,
    maxAgeMs = 5 * 60_000
  ): boolean {
    if (!evidence || typeof evidence.recorded_at !== "string") return false;
    const age = Date.now() - Date.parse(evidence.recorded_at);
    return Number.isFinite(age) && age >= -30_000 && age <= maxAgeMs;
  }

  private enforceReviewGate(run: LaneRunRecord): void {
    if (!run.head_sha) conflict("review requires current head SHA");
    const review = this.latestEvidence(
      run.run_id,
      run.head_sha,
      "adversarial_review"
    );
    if (review?.accepted !== true) {
      conflict("a current-head adversarial approval is required");
    }
  }

  private enforceMergeGate(run: LaneRunRecord): void {
    if (!run.head_sha) conflict("merge requires current head SHA");
    this.enforceReviewGate(run);
    const finals = this.acceptedEvidence(run.run_id, run.head_sha, "final_attestation");
    const providers = new Set(finals.map((entry) => String(entry.provider ?? "")));
    if (finals.length < 2 || providers.size < 2) {
      conflict("two distinct current-head final attestations are required");
    }
    const checks = this.latestEvidence(run.run_id, run.head_sha, "required_checks");
    if (
      !this.freshEvidence(checks) ||
      checks?.accepted !== true ||
      (checks.evidence as Record<string, unknown> | undefined)?.all_green !== true
    ) {
      conflict("required checks are not green");
    }
    const mergeability = this.latestEvidence(run.run_id, run.head_sha, "mergeability");
    if (
      !this.freshEvidence(mergeability) ||
      mergeability?.accepted !== true ||
      (mergeability.evidence as Record<string, unknown> | undefined)?.mergeable !== true
    ) {
      conflict("pull request is not mergeable");
    }
  }

  private enforceValidationGate(run: LaneRunRecord): void {
    if (!run.merged_sha) conflict("validation requires merged SHA");
    const ci = this.latestEvidence(run.run_id, run.merged_sha, "merged_ci");
    const validation = this.latestEvidence(
      run.run_id,
      run.merged_sha,
      "deterministic_validation"
    );
    if (
      !this.freshEvidence(ci, 15 * 60_000) ||
      ci?.accepted !== true ||
      (ci.evidence as Record<string, unknown> | undefined)?.all_green !== true
    ) {
      conflict("merged-SHA CI evidence is not green");
    }
    if (
      !this.freshEvidence(validation, 15 * 60_000) ||
      validation?.accepted !== true ||
      (validation.evidence as Record<string, unknown> | undefined)?.passed !== true
    ) {
      conflict("deterministic validation evidence is missing");
    }
  }

  async transitionRun(
    lease: LeaseCredentials,
    runId: string,
    input: TransitionRunInput
  ): Promise<LaneRunRecord> {
    return this.db.transaction(() => {
      this.guard(lease);
      const run = this.run(runId);
      if (!run) throw new LaneStateStoreError("run not found", 404);
      if (
        run.row_version !== input.expected_version ||
        run.status !== input.from_status
      ) {
        conflict("run changed");
      }
      if (
        input.to_status !== input.from_status &&
        input.to_status !== "superseded" &&
        !TRANSITIONS[input.from_status]?.has(input.to_status)
      ) {
        throw new LaneStateStoreError(
          `invalid lane transition ${input.from_status} -> ${input.to_status}`,
          400
        );
      }
      const patch = input.patch ?? {};
      const allowedPatch = new Set([
        "author_provider",
        "provider",
        "model",
        "workspace_id",
        "workspace_name",
        "session_id",
        "pr_number",
        "pr_url",
        "head_branch",
        "head_sha",
        "merged_sha",
        "progress_cursor",
        "nudge_cursor",
        "ineffective_nudges",
        "retry_at",
        "metadata",
      ]);
      const unknownPatch = Object.keys(patch).filter(
        (field) => !allowedPatch.has(field)
      );
      if (unknownPatch.length > 0) {
        throw new LaneStateStoreError(
          `unsupported run patch fields: ${unknownPatch.sort().join(", ")}`,
          400
        );
      }
      if (
        Object.hasOwn(patch, "metadata") &&
        (patch.metadata === null ||
          typeof patch.metadata !== "object" ||
          Array.isArray(patch.metadata))
      ) {
        throw new LaneStateStoreError("run metadata patch must be an object", 400);
      }
      const next = {
        ...run,
        ...patch,
        metadata_json:
          (patch.metadata as Record<string, unknown> | undefined) ??
          run.metadata_json,
        status: input.to_status,
        stage: input.stage,
        terminal_at: ["validated", "failed", "cancelled", "superseded"].includes(
          input.to_status
        )
          ? run.terminal_at ?? now()
          : run.terminal_at,
      } as LaneRunRecord;
      const manifest = this.manifestForRun(run);
      const lane = manifest.lanes.find((candidate) => candidate.id === run.lane_id);
      if (!lane) conflict("run lane is missing from its manifest");
      for (const field of ["author_provider", "provider"] as const) {
        if (
          next[field] !== null &&
          !["claude", "codex", "cursor"].includes(next[field]!)
        ) {
          throw new LaneStateStoreError(`invalid ${field}`, 400);
        }
      }
      if (
        next.model !== null &&
        (!next.provider ||
          manifest.global.provider_models[next.provider as ManifestProvider] !== next.model)
      ) {
        throw new LaneStateStoreError(
          "run model violates the manifest provider policy",
          400
        );
      }
      if (
        input.to_status === "implementing" &&
        (!next.author_provider ||
          next.provider !== next.author_provider ||
          manifest.global.provider_models[next.author_provider as ManifestProvider] !==
            next.model)
      ) {
        conflict("implementation must be bound to its author provider and model");
      }
      if (
        input.from_status === "queued" &&
        input.to_status === "validating" &&
        run.metadata_json.legacy_git_verified !== true
      ) {
        conflict("only exact legacy Git truth may adopt a merged run");
      }
      const prFields = [next.pr_number, next.pr_url, next.head_branch, next.head_sha];
      const presentPrFields = prFields.map((value) => value !== null && value !== "");
      if (presentPrFields.some(Boolean) && !presentPrFields.every(Boolean)) {
        throw new LaneStateStoreError(
          "PR identity must bind number, URL, head branch, and head SHA together",
          400
        );
      }
      const repairBindingClear =
        input.from_status === "rework" &&
        input.to_status === "implementing" &&
        Boolean(run.merged_sha) &&
        ["pr_number", "pr_url", "head_branch", "head_sha", "merged_sha"].every(
          (field) => Object.hasOwn(patch, field) && patch[field] === null
        ) &&
        next.metadata_json.repair_from_merged_sha === run.merged_sha;
      const clearingBoundPr =
        [run.pr_number, run.pr_url, run.head_branch, run.head_sha].every(
          (value) => value !== null && value !== ""
        ) && !presentPrFields.some(Boolean);
      if (clearingBoundPr && !repairBindingClear) {
        conflict("a bound PR may clear only for a proven post-merge repair");
      }
      if (run.merged_sha && next.merged_sha === null && !repairBindingClear) {
        conflict("merged_sha may clear only for a proven post-merge repair");
      }
      if (presentPrFields.every(Boolean)) {
        const identity = deliveryPrIdentity(next.pr_url, lane!.delivery_adapter.kind);
        if (
          !identity ||
          identity.owner !== run.repo_owner.toLowerCase() ||
          identity.repo !== run.repo_name.toLowerCase() ||
          identity.number !== next.pr_number ||
          !GIT_SHA_RE.test(next.head_sha!) ||
          !next.head_branch
        ) {
          conflict("PR URL/number does not match the manifest repository binding");
        }
        if (run.pr_url && next.pr_url !== run.pr_url) {
          conflict("a bound PR cannot be replaced without first clearing the binding");
        }
        if (run.head_branch && next.head_branch !== run.head_branch) {
          conflict("a bound PR head branch is immutable");
        }
        next.head_sha = next.head_sha!.toLowerCase();
      }
      if (
        ["pr_bound", "reviewing", "finals", "merging"].includes(input.to_status) &&
        !presentPrFields.every(Boolean)
      ) {
        throw new LaneStateStoreError("PR-bound state requires exact PR identity", 400);
      }
      if (next.merged_sha !== null && !GIT_SHA_RE.test(next.merged_sha)) {
        throw new LaneStateStoreError("merged_sha must be a full Git object ID", 400);
      }
      if (next.merged_sha !== null) next.merged_sha = next.merged_sha.toLowerCase();
      if (Object.hasOwn(patch, "workspace_id") && run.workspace_id) {
        if (next.workspace_id !== null && next.workspace_id !== run.workspace_id) {
          conflict("a bound workspace cannot be replaced in place");
        }
        if (next.workspace_id === null) {
          const stateRow = this.db
            .prepare(
              "SELECT payload_json FROM lane_v2_evidence WHERE run_id = ? AND evidence_type = 'workspace_state' AND accepted = 1 ORDER BY rowid DESC LIMIT 1"
            )
            .get(runId) as { payload_json: string } | undefined;
          const state = stateRow
            ? (parse<Record<string, unknown>>(stateRow.payload_json).evidence as
                | Record<string, unknown>
                | undefined)
            : undefined;
          if (
            state?.workspace_id !== run.workspace_id ||
            state?.unusable !== true ||
            state?.working_session !== false
          ) {
            conflict(
              "workspace binding may clear only after accepted unusable-state evidence"
            );
          }
        }
      }
      if (input.to_status === "merging") this.enforceMergeGate(next);
      if (input.to_status === "finals") this.enforceReviewGate(next);
      if (input.to_status === "validating" && !next.merged_sha) {
        throw new LaneStateStoreError("merged_sha is required for validation", 400);
      }
      if (input.to_status === "validated") this.enforceValidationGate(next);
      if (run.head_sha && run.head_sha !== next.head_sha) {
        this.db
          .prepare(
            "UPDATE lane_v2_evidence SET accepted = 0 WHERE run_id = ? AND accepted = 1 AND (? IS NULL OR head_sha <> ?)"
          )
          .run(runId, next.head_sha, next.head_sha);
      }
      const saved = this.saveRun(next, input.expected_version);
      this.event("run_transitioned", runId, {
        from_status: input.from_status,
        to_status: input.to_status,
        stage: input.stage,
      });
      return saved;
    })();
  }

  async beginAttempt(
    lease: LeaseCredentials,
    runId: string,
    input: BeginAttemptInput
  ): Promise<LaneAttemptRecord> {
    return this.db.transaction(() => {
      this.guard(lease);
      const existingRow = this.db
        .prepare("SELECT payload_json FROM lane_v2_attempts WHERE attempt_id = ?")
        .get(input.attempt_id) as { payload_json: string } | undefined;
      if (existingRow) {
        const existing = parse<LaneAttemptRecord>(existingRow.payload_json);
        if (
          existing.run_id === runId &&
          existing.stage === input.stage &&
          existing.attempt_number === input.attempt_number &&
          existing.role === input.role &&
          existing.provider === input.provider &&
          existing.model === input.model &&
          existing.nonce === input.nonce &&
          existing.head_sha === (input.head_sha ?? null) &&
          existing.workspace_id === (input.workspace_id ?? null) &&
          existing.session_id === (input.session_id ?? null)
        ) {
          return existing;
        }
        conflict("attempt id already has different identity");
      }
      const run = this.run(runId);
      if (!run || run.row_version !== input.expected_run_version) {
        conflict("run changed");
      }
      if (TERMINAL.has(run.status)) conflict("terminal run cannot start an attempt");
      if (run.ambiguous_action_id) conflict("ambiguous action must be reconciled first");
      const manifest = this.manifestForRun(run);
      const expectedStatus = {
        implementation: "implementing",
        review: "reviewing",
        final: "finals",
        validation: "validating",
      }[input.role];
      const expectedStage =
        input.role === "final" ? `final-${input.attempt_number}` : input.role;
      if (run.status !== expectedStatus || input.stage !== expectedStage) {
        conflict("attempt role/stage does not match the durable run stage");
      }
      if (input.role === "implementation") {
        if (input.head_sha !== undefined) {
          throw new LaneStateStoreError(
            "implementation attempts must not bind review or merge heads",
            400
          );
        }
        if (run.author_provider !== input.provider) {
          conflict("implementation provider must match the durable author provider");
        }
      } else if (input.role === "review" || input.role === "final") {
        if (!run.head_sha || input.head_sha !== run.head_sha) {
          conflict("review attempt must bind the current PR head");
        }
      } else if (!run.merged_sha || input.head_sha !== run.merged_sha) {
        conflict("validation attempt must bind the merged SHA");
      }
      if (manifest.global.provider_models[input.provider] !== input.model) {
        throw new LaneStateStoreError("attempt model violates manifest policy", 400);
      }
      const healthRow = this.db
        .prepare("SELECT payload_json FROM lane_v2_providers WHERE provider = ?")
        .get(input.provider) as { payload_json: string } | undefined;
      const health = healthRow
        ? parse<Record<string, unknown>>(healthRow.payload_json)
        : null;
      if (
        health?.state === "disabled" ||
        (health?.state === "open" &&
          (!health.breaker_until ||
            Date.parse(String(health.breaker_until)) > Date.now()))
      ) {
        conflict("provider circuit breaker is open");
      }
      const capacity = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM lane_v2_attempts WHERE provider = ? AND status IN ('commissioned','working','awaiting_result')"
        )
        .get(input.provider) as { count: number };
      if (Number(capacity.count) >= manifest.global.provider_capacity[input.provider]) {
        conflict("provider capacity is exhausted");
      }
      if (
        (input.role === "review" || input.role === "validation") &&
        run.author_provider === input.provider
      ) {
        conflict(`${input.role} provider must differ from author`);
      }
      if (input.role === "final") {
        const prior = this.acceptedEvidence(
          runId,
          input.head_sha ?? "",
          "final_attestation"
        );
        const activeFinals = (
          this.db
            .prepare(
              "SELECT payload_json FROM lane_v2_attempts WHERE run_id = ? AND status IN ('commissioned','working','awaiting_result')"
            )
            .all(runId) as Array<{ payload_json: string }>
        )
          .map((row) => parse<LaneAttemptRecord>(row.payload_json))
          .filter(
            (attempt) =>
              attempt.role === "final" && attempt.head_sha === input.head_sha
          );
        if (
          prior.some((evidence) => evidence.provider === input.provider) ||
          activeFinals.some((attempt) => attempt.provider === input.provider)
        ) {
          conflict("final providers must be distinct per head");
        }
      }
      const record: LaneAttemptRecord = {
        attempt_id: input.attempt_id,
        run_id: runId,
        stage: input.stage,
        attempt_number: input.attempt_number,
        role: input.role,
        provider: input.provider,
        model: input.model,
        status: "commissioned",
        nonce: input.nonce,
        head_sha: input.head_sha ?? null,
        workspace_id: input.workspace_id ?? null,
        session_id: input.session_id ?? null,
        progress_cursor: null,
        nudge_cursor: null,
        ineffective_nudges: 0,
        result_json: {},
        row_version: 1,
      };
      try {
        this.db
          .prepare(
            "INSERT INTO lane_v2_attempts (attempt_id, run_id, stage, provider, status, row_version, payload_json) VALUES (?, ?, ?, ?, ?, 1, ?)"
          )
          .run(
            record.attempt_id,
            record.run_id,
            record.stage,
            record.provider,
            record.status,
            JSON.stringify(record)
          );
      } catch {
        conflict("stage already has an active attempt");
      }
      this.saveRun({ ...run, provider: input.provider, model: input.model }, run.row_version);
      this.event("attempt_commissioned", runId, {
        attempt_id: record.attempt_id,
        provider: record.provider,
      });
      return record;
    })();
  }

  async updateAttempt(
    lease: LeaseCredentials,
    attemptId: string,
    input: UpdateAttemptInput
  ): Promise<LaneAttemptRecord> {
    return this.db.transaction(() => {
      this.guard(lease);
      const row = this.db
        .prepare("SELECT payload_json FROM lane_v2_attempts WHERE attempt_id = ?")
        .get(attemptId) as { payload_json: string } | undefined;
      if (!row) throw new LaneStateStoreError("attempt not found", 404);
      const attempt = parse<LaneAttemptRecord>(row.payload_json);
      if (attempt.row_version !== input.expected_attempt_version) {
        conflict("attempt changed");
      }
      if (
        !ATTEMPT_STATUSES.has(input.status) ||
        !ATTEMPT_TRANSITIONS[attempt.status]?.has(input.status)
      ) {
        conflict(`invalid attempt transition ${attempt.status} -> ${input.status}`);
      }
      const run = this.run(attempt.run_id);
      if (!run || run.row_version !== input.expected_run_version) {
        conflict("run changed");
      }
      if (
        input.workspace_id !== undefined &&
        attempt.workspace_id !== null &&
        input.workspace_id !== attempt.workspace_id
      ) {
        conflict("attempt workspace binding is immutable");
      }
      if (
        input.workspace_id !== undefined &&
        run.workspace_id !== null &&
        input.workspace_id !== run.workspace_id
      ) {
        conflict("attempt workspace does not match its run");
      }
      if (
        input.session_id !== undefined &&
        attempt.session_id !== null &&
        input.session_id !== attempt.session_id
      ) {
        conflict("attempt session binding is immutable");
      }
      const next: LaneAttemptRecord = {
        ...attempt,
        status: input.status,
        workspace_id: input.workspace_id ?? attempt.workspace_id,
        session_id: input.session_id ?? attempt.session_id,
        progress_cursor: input.progress_cursor ?? attempt.progress_cursor,
        nudge_cursor: input.nudge_cursor ?? attempt.nudge_cursor,
        ineffective_nudges:
          input.ineffective_nudges ?? attempt.ineffective_nudges,
        result_json: input.result ?? {},
        row_version: attempt.row_version + 1,
      };
      const result = this.db
        .prepare(
          "UPDATE lane_v2_attempts SET status = ?, row_version = ?, payload_json = ? WHERE attempt_id = ? AND row_version = ?"
        )
        .run(
          next.status,
          next.row_version,
          JSON.stringify(next),
          attemptId,
          attempt.row_version
        );
      if (result.changes !== 1) conflict("attempt changed");
      this.saveRun(
        {
          ...run,
          workspace_id: next.workspace_id ?? run.workspace_id,
          session_id: next.session_id ?? run.session_id,
          progress_cursor: next.progress_cursor,
          nudge_cursor: next.nudge_cursor,
          ineffective_nudges: next.ineffective_nudges,
        },
        run.row_version
      );
      return next;
    })();
  }

  async beginAction(
    lease: LeaseCredentials,
    runId: string,
    input: BeginActionInput
  ): Promise<LaneActionRecordV2> {
    return this.db.transaction(() => {
      this.guard(lease);
      const existingRow = this.db
        .prepare("SELECT payload_json FROM lane_v2_actions WHERE deterministic_tag = ?")
        .get(input.deterministic_tag) as { payload_json: string } | undefined;
      if (existingRow) {
        const existing = parse<LaneActionRecordV2>(existingRow.payload_json);
        if (
          existing.action_id === input.action_id &&
          existing.run_id === runId &&
          existing.stage === input.stage &&
          existing.attempt_id === (input.attempt_id ?? null) &&
          existing.action_type === input.action_type &&
          JSON.stringify(existing.request_json) === JSON.stringify(input.request)
        ) {
          return existing;
        }
        conflict("deterministic action tag has different content");
      }
      const run = this.run(runId);
      if (!run || run.row_version !== input.expected_run_version) {
        conflict("run changed");
      }
      const attemptRow = input.attempt_id
        ? (this.db
            .prepare("SELECT payload_json FROM lane_v2_attempts WHERE attempt_id = ?")
            .get(input.attempt_id) as { payload_json: string } | undefined)
        : undefined;
      const attempt = attemptRow
        ? parse<LaneAttemptRecord>(attemptRow.payload_json)
        : null;
      if (input.attempt_id && attempt?.run_id !== runId) {
        conflict("action attempt does not belong to the durable run");
      }
      const attemptActions = new Set([
        "create_workspace",
        "create_session",
        "send_prompt",
        "nudge_session",
        "post_attestation",
      ]);
      if (
        attemptActions.has(input.action_type) &&
        (!attempt || !ACTIVE_ATTEMPT.has(attempt.status))
      ) {
        conflict("action requires an active commissioned attempt");
      }
      if (run.ambiguous_action_id) conflict("ambiguous action must be reconciled first");
      if (!ALLOWED_ACTIONS.has(input.action_type)) {
        throw new LaneStateStoreError("action type is outside lane authority", 400);
      }
      if (input.action_type === "create_workspace" && run.workspace_id) {
        conflict("existing workspace must be reused");
      }
      if (input.action_type === "create_workspace") {
        const workspaceName = String(input.request.workspace_name ?? "");
        const requiredTags = [
          "[managed:growth]",
          `[lane:${run.lane_id}]`,
          `[run:${run.run_id}]`,
          `[stage:${attempt!.stage}]`,
          `[attempt:${attempt!.attempt_number}]`,
        ];
        if (
          input.request.base_branch !== run.base_branch ||
          input.request.provider !== attempt!.provider ||
          input.request.model !== attempt!.model ||
          !requiredTags.every((tag) => workspaceName.includes(tag))
        ) {
          conflict("workspace creation does not match its commissioned binding");
        }
      }
      if (input.action_type === "create_session") {
        const sessionName = String(input.request.session_name ?? "");
        const requiredTags = [
          "[managed:growth]",
          `[lane:${run.lane_id}]`,
          `[run:${run.run_id}]`,
          `[stage:${attempt!.stage}]`,
          `[attempt:${attempt!.attempt_number}]`,
          `[provider:${attempt!.provider}]`,
        ];
        if (
          input.request.workspace_id !== run.workspace_id ||
          input.request.provider !== attempt!.provider ||
          input.request.model !== attempt!.model ||
          !requiredTags.every((tag) => sessionName.includes(tag))
        ) {
          conflict("session creation does not match its commissioned binding");
        }
      }
      if (
        ["send_prompt", "nudge_session"].includes(
          input.action_type
        ) &&
        (input.request.session_id !== attempt!.session_id ||
          attempt!.workspace_id !== run.workspace_id)
      ) {
        conflict("session action target does not match its commissioned binding");
      }
      if (
        ["send_prompt", "nudge_session"].includes(input.action_type) &&
        (!String(input.request.message_id ?? "") ||
          !/^[0-9a-f]{64}$/.test(String(input.request.message_hash ?? "")))
      ) {
        conflict("session message action requires an ID and exact sha256 payload binding");
      }
      if (input.action_type === "nudge_session") {
        const cursor = String(input.request.progress_cursor ?? "");
        if (!cursor || cursor !== run.progress_cursor || cursor === run.nudge_cursor) {
          conflict("nudge must target one unnudged observed cursor");
        }
      }
      if (
        input.action_type === "post_attestation" &&
        (attempt!.role !== "review" && attempt!.role !== "final" ||
          input.request.pr_url !== run.pr_url ||
          input.request.head_sha !== run.head_sha ||
          input.request.provider !== attempt!.provider ||
          input.request.nonce !== attempt!.nonce ||
          attempt!.head_sha !== run.head_sha ||
          input.request.attestation_tag !==
            `[lane-attestation:${attempt!.nonce}]` ||
          String(input.request.attestation_tag).length > 512 ||
          !/^[0-9a-f]{64}$/.test(
            String(input.request.attestation_body_hash ?? "")
          ))
      ) {
        conflict("attestation action does not match its commissioned PR head");
      }
      if (
        input.action_type === "post_notice" &&
        (input.request.pr_url !== run.pr_url ||
          !String(input.request.notice_tag ?? "") ||
          String(input.request.notice_tag).length > 512 ||
          !/^[0-9a-f]{64}$/.test(
            String(input.request.notice_body_hash ?? "")
          ))
      ) {
        conflict("notice target does not match the durable PR binding");
      }
      if (input.action_type === "merge_pr") {
        if (input.request.expected_head_sha !== run.head_sha) {
          conflict("merge expected head does not match current run head");
        }
        if (input.request.pr_url !== run.pr_url) {
          conflict("merge target does not match the durable PR binding");
        }
        this.enforceMergeGate(run);
      }
      if (input.action_type === "archive_workspace") {
        if (!TERMINAL.has(run.status)) conflict("only terminal runs may archive");
        if (input.request.workspace_id !== run.workspace_id) {
          conflict("archive target does not match the durable workspace binding");
        }
        const state = this.acceptedEvidence(
          run.run_id,
          run.head_sha ?? run.merged_sha ?? "0".repeat(40),
          "workspace_state"
        ).at(-1);
        const evidence = state?.evidence as Record<string, unknown> | undefined;
        if (
          evidence?.workspace_id !== run.workspace_id ||
          evidence?.working_session !== false ||
          evidence?.grace_period_elapsed !== true
        ) {
          conflict("workspace archive safety evidence is missing");
        }
        const workspaceName = String(run.workspace_name ?? "");
        const managed = [
          "[managed:growth]",
          `[lane:${run.lane_id}]`,
          `[run:${run.run_id}]`,
        ].every((tag) => workspaceName.includes(tag));
        if (!managed && !run.legacy_verified) {
          const approvals = (
            this.db
              .prepare(
                "SELECT payload_json FROM lane_v2_controls WHERE status = 'applied'"
              )
              .all() as Array<{ payload_json: string }>
          )
            .map((row) => parse<LaneControlRecord>(row.payload_json))
            .filter(
              (control) =>
                control.kind === "archive_approval" &&
                control.human_approved &&
                (control.lane_id === run.lane_id || control.lane_id === null)
            );
          const approved = approvals.some((control) => {
            const expiresAt = Date.parse(String(control.payload_json.expires_at ?? ""));
            const workspaceIds = Array.isArray(control.payload_json.workspace_ids)
              ? control.payload_json.workspace_ids
              : [];
            return (
              Number.isFinite(expiresAt) &&
              expiresAt > Date.now() &&
              workspaceIds.includes(run.workspace_id) &&
              (control.lane_id === null || control.lane_id === run.lane_id)
            );
          });
          if (!approved) conflict("untagged workspace needs archive approval");
        }
      }
      const stamp = now();
      const action: LaneActionRecordV2 = {
        action_id: input.action_id,
        deterministic_tag: input.deterministic_tag,
        run_id: runId,
        stage: input.stage,
        attempt_id: input.attempt_id ?? null,
        action_type: input.action_type,
        status: "pending",
        request_json: input.request,
        result_json: {},
        external_ref: null,
        error: null,
        started_at: stamp,
        updated_at: stamp,
        completed_at: null,
        row_version: 1,
      };
      try {
        this.db
          .prepare(
            "INSERT INTO lane_v2_actions (action_id, deterministic_tag, run_id, stage, status, row_version, payload_json) VALUES (?, ?, ?, ?, 'pending', 1, ?)"
          )
          .run(
            action.action_id,
            action.deterministic_tag,
            action.run_id,
            action.stage,
            JSON.stringify(action)
          );
      } catch {
        conflict("stage has an unresolved action");
      }
      this.saveRun({ ...run, updated_at: stamp }, run.row_version);
      this.event("action_begun", runId, {
        action_id: action.action_id,
        action_type: action.action_type,
      });
      return action;
    })();
  }

  async finishAction(
    lease: LeaseCredentials,
    actionId: string,
    input: FinishActionInput
  ): Promise<LaneActionRecordV2> {
    return this.db.transaction(() => {
      this.guard(lease);
      const row = this.db
        .prepare("SELECT payload_json FROM lane_v2_actions WHERE action_id = ?")
        .get(actionId) as { payload_json: string } | undefined;
      if (!row) throw new LaneStateStoreError("action not found", 404);
      const action = parse<LaneActionRecordV2>(row.payload_json);
      if (
        action.status !== "pending" &&
        !(
          action.status === "ambiguous" &&
          (input.status === "reconciled" || input.status === "failed")
        )
      ) {
        if (
          action.status === input.status &&
          JSON.stringify(action.result_json) === JSON.stringify(input.result ?? {}) &&
          action.external_ref === (input.external_ref ?? null)
        ) {
          return action;
        }
        conflict("action is already resolved");
      }
      if (action.row_version !== input.expected_action_version) {
        conflict("action changed");
      }
      const run = this.run(action.run_id);
      if (!run || run.row_version !== input.expected_run_version) {
        conflict("run changed");
      }
      if (input.status === "succeeded" || input.status === "reconciled") {
        const request = action.request_json;
        const result = input.result ?? {};
        if (
          action.action_type === "create_workspace" &&
          (!String(result.workspace_id ?? "") ||
            result.workspace_name !== request.workspace_name ||
            !String(result.session_id ?? "") ||
            result.session_name !== request.session_name)
        ) {
          conflict("workspace/session result does not match its deterministic intent");
        }
        if (
          action.action_type === "create_session" &&
          (!String(result.session_id ?? "") ||
            result.workspace_id !== request.workspace_id ||
            result.session_name !== request.session_name)
        ) {
          conflict("session result does not match its durable binding");
        }
        if (
          ["send_prompt", "nudge_session"].includes(action.action_type) &&
          result.message_id !== request.message_id
        ) {
          conflict("message result does not match its deterministic intent");
        }
        if (
          action.action_type === "post_attestation" &&
          (String(result.commit_sha ?? "").toLowerCase() !==
            String(request.head_sha ?? "").toLowerCase() ||
            result.attestation_tag !== request.attestation_tag ||
            result.attestation_body_hash !== request.attestation_body_hash ||
            !(
              result.posted === true ||
              (input.status === "reconciled" && result.found === true)
            ))
        ) {
          conflict("attestation receipt is not tied to the commissioned head");
        }
        if (
          action.action_type === "post_notice" &&
          (result.notice_tag !== request.notice_tag ||
            result.notice_body_hash !== request.notice_body_hash ||
            !(
              result.posted === true ||
              (input.status === "reconciled" && result.found === true)
            ))
        ) {
          conflict("notice result does not prove the deterministic comment");
        }
        if (
          action.action_type === "archive_workspace" &&
          (result.workspace_id !== request.workspace_id ||
            !(
              result.archived === true ||
              (input.status === "reconciled" && result.found === true)
            ))
        ) {
          conflict("archive result does not match its authorized workspace");
        }
      }
      const next: LaneActionRecordV2 = {
        ...action,
        status: input.status,
        result_json: input.result ?? {},
        external_ref: input.external_ref ?? null,
        error: input.error ?? null,
        updated_at: now(),
        completed_at: input.status === "ambiguous" ? null : now(),
        row_version: action.row_version + 1,
      };
      const result = this.db
        .prepare(
          "UPDATE lane_v2_actions SET status = ?, row_version = ?, payload_json = ? WHERE action_id = ? AND row_version = ?"
        )
        .run(
          next.status,
          next.row_version,
          JSON.stringify(next),
          actionId,
          action.row_version
        );
      if (result.changes !== 1) conflict("action changed");
      const mergedSha =
        action.action_type === "merge_pr" &&
        typeof next.result_json.merged_sha === "string"
          ? next.result_json.merged_sha
          : run.merged_sha;
      if (
        action.action_type === "merge_pr" &&
        (input.status === "succeeded" || input.status === "reconciled")
      ) {
        if (action.request_json.expected_head_sha !== run.head_sha) {
          conflict("PR head changed while merge was in flight");
        }
        if (!mergedSha) conflict("merge result requires merged_sha");
      }
      this.saveRun(
        {
          ...run,
          ambiguous_action_id: input.status === "ambiguous" ? actionId : null,
          merged_sha: mergedSha,
        },
        run.row_version
      );
      this.event("action_finished", run.run_id, {
        action_id: actionId,
        status: input.status,
      });
      return next;
    })();
  }

  async recordEvidence(
    lease: LeaseCredentials,
    runId: string,
    input: EvidenceInput
  ): Promise<Record<string, unknown>> {
    return this.db.transaction(() => {
      this.guard(lease);
      runId = safeIdentifier(runId, "run_id");
      input = {
        ...input,
        evidence_id: safeIdentifier(input.evidence_id, "evidence_id"),
        external_key: safeIdentifier(input.external_key, "external_key"),
        provider: input.provider
          ? safeIdentifier(input.provider, "provider")
          : undefined,
        nonce: input.nonce ? safeIdentifier(input.nonce, "nonce") : undefined,
        head_sha: fullGitSha(input.head_sha, "head_sha"),
      };
      if (!ALLOWED_EVIDENCE.has(input.evidence_type)) {
        throw new LaneStateStoreError("unsupported lane evidence type", 400);
      }
      const existing = this.db
        .prepare("SELECT payload_json FROM lane_v2_evidence WHERE external_key = ?")
        .get(input.external_key) as { payload_json: string } | undefined;
      if (existing) {
        const record = parse<Record<string, unknown>>(existing.payload_json);
        if (
          record.evidence_id === input.evidence_id &&
          record.run_id === runId &&
          record.attempt_id === (input.attempt_id ?? undefined) &&
          record.evidence_type === input.evidence_type &&
          record.provider === (input.provider ?? undefined) &&
          record.nonce === (input.nonce ?? undefined) &&
          record.repo_owner === input.repo_owner &&
          record.repo_name === input.repo_name &&
          record.head_sha === input.head_sha &&
          JSON.stringify(record.evidence) === JSON.stringify(input.evidence)
        ) {
          return record;
        }
        conflict("external evidence key has different content");
      }
      const run = this.run(runId);
      if (!run || run.row_version !== input.expected_run_version) {
        conflict("run changed");
      }
      const manifest = this.manifestForRun(run);
      const lane = manifest.lanes.find((candidate) => candidate.id === run.lane_id);
      if (!lane) conflict("run lane is missing from its manifest");
      let accepted =
        input.repo_owner === run.repo_owner &&
        input.repo_name === run.repo_name &&
        (input.evidence_type === "merged_ci" ||
        input.evidence_type === "deterministic_validation"
          ? !run.merged_sha || input.head_sha === run.merged_sha
          : !run.head_sha || input.head_sha === run.head_sha);
      if (
        input.evidence_type === "adversarial_review" ||
        input.evidence_type === "final_attestation"
      ) {
        const attemptRow = input.attempt_id
          ? (this.db
              .prepare("SELECT payload_json FROM lane_v2_attempts WHERE attempt_id = ?")
              .get(input.attempt_id) as { payload_json: string } | undefined)
          : undefined;
        const attempt = attemptRow
          ? parse<LaneAttemptRecord>(attemptRow.payload_json)
          : null;
        const expectedRole =
          input.evidence_type === "adversarial_review" ? "review" : "final";
        const publication = (
          this.db
            .prepare(
              "SELECT payload_json FROM lane_v2_actions WHERE run_id = ? AND status IN ('succeeded','reconciled')"
            )
            .all(runId) as Array<{ payload_json: string }>
        )
          .map((row) => parse<LaneActionRecordV2>(row.payload_json))
          .find(
            (action) =>
              action.attempt_id === input.attempt_id &&
              action.action_type === "post_attestation" &&
              action.request_json.nonce === input.nonce &&
              action.request_json.head_sha === input.head_sha &&
              action.request_json.provider === input.provider &&
              action.result_json.commit_sha === input.head_sha &&
              action.request_json.attestation_body_hash ===
                action.result_json.attestation_body_hash &&
              action.result_json.attestation_body_hash ===
                input.evidence.attestation_body_hash
          );
        accepted =
          accepted &&
          Boolean(attempt) &&
          attempt!.run_id === runId &&
          attempt!.role === expectedRole &&
          attempt!.nonce === input.nonce &&
          attempt!.head_sha === input.head_sha &&
          attempt!.provider === input.provider &&
          ACTIVE_ATTEMPT.has(attempt!.status) &&
          input.evidence.verdict === "approve" &&
          input.evidence.nonce === input.nonce &&
          input.evidence.run === runId &&
          input.evidence.stage === expectedRole &&
          input.evidence.head_sha === input.head_sha &&
          input.evidence.provider === input.provider &&
          Boolean(publication) &&
          !(expectedRole === "review" && input.provider === run.author_provider);
      } else if (
        input.evidence_type === "required_checks" ||
        input.evidence_type === "merged_ci"
      ) {
        accepted =
          accepted &&
          input.evidence.all_green === true &&
          !input.evidence.pending &&
          !input.evidence.failed;
        if (input.evidence_type === "required_checks") {
          accepted =
            accepted &&
            JSON.stringify(input.evidence.required_checks ?? []) ===
              JSON.stringify(lane!.delivery_adapter.required_checks ?? []) &&
            Array.isArray(input.evidence.missing_required_checks ?? []) &&
            ((input.evidence.missing_required_checks ?? []) as unknown[]).length === 0 &&
            Array.isArray(input.evidence.nonpassing_required_checks ?? []) &&
            ((input.evidence.nonpassing_required_checks ?? []) as unknown[]).length === 0;
        }
      } else if (input.evidence_type === "mergeability") {
        accepted = accepted && input.evidence.mergeable === true;
      } else if (input.evidence_type === "deterministic_validation") {
        const attemptRow = input.attempt_id
          ? (this.db
              .prepare("SELECT payload_json FROM lane_v2_attempts WHERE attempt_id = ?")
              .get(input.attempt_id) as { payload_json: string } | undefined)
          : undefined;
        const attempt = attemptRow
          ? parse<LaneAttemptRecord>(attemptRow.payload_json)
          : null;
        const commands = Array.isArray(input.evidence.commands)
          ? input.evidence.commands
          : [];
        const probes = Array.isArray(input.evidence.probes)
          ? input.evidence.probes
          : [];
        accepted =
          accepted &&
          Boolean(attempt) &&
          attempt!.run_id === runId &&
          attempt!.role === "validation" &&
          attempt!.nonce === input.nonce &&
          attempt!.head_sha === input.head_sha &&
          attempt!.provider === input.provider &&
          ACTIVE_ATTEMPT.has(attempt!.status) &&
          input.evidence.nonce === input.nonce &&
          input.evidence.run === runId &&
          input.evidence.stage === "validation" &&
          input.evidence.head_sha === input.head_sha &&
          input.evidence.merged_sha === input.head_sha &&
          input.evidence.provider === input.provider &&
          input.evidence.passed === true &&
          commands.length === lane!.validation_profile.commands.length &&
          commands.every(
            (entry, index) =>
              entry &&
              typeof entry === "object" &&
              Array.isArray((entry as Record<string, unknown>).argv) &&
              JSON.stringify((entry as Record<string, unknown>).argv) ===
                JSON.stringify(lane!.validation_profile.commands[index]) &&
              (entry as Record<string, unknown>).exit_code === 0
          ) &&
          probes.length === lane!.validation_profile.probes.length &&
          probes.every(
            (entry, index) =>
              entry &&
              typeof entry === "object" &&
              (entry as Record<string, unknown>).url ===
                lane!.validation_profile.probes[index]?.url &&
              (entry as Record<string, unknown>).method ===
                lane!.validation_profile.probes[index]?.method &&
              (entry as Record<string, unknown>).read_only === true &&
              (entry as Record<string, unknown>).passed === true
          ) &&
          hasExactConductorValidationReceipts(input.evidence, lane!, input.head_sha) &&
          input.provider !== run.author_provider;
      } else if (input.evidence_type === "workspace_state") {
        accepted = accepted && Boolean(input.evidence.workspace_id);
      } else if (input.evidence_type === "pr_binding") {
        accepted =
          accepted &&
          input.evidence.owner === run.repo_owner &&
          input.evidence.repo === run.repo_name &&
          input.evidence.base_branch === run.base_branch &&
          input.evidence.pr_url === run.pr_url &&
          input.evidence.pr_number === run.pr_number &&
          input.evidence.head_branch === run.head_branch &&
          input.evidence.head_sha === run.head_sha;
      }
      const record = { ...input, run_id: runId, accepted, recorded_at: now() };
      this.db
        .prepare(
          "INSERT INTO lane_v2_evidence (evidence_id, external_key, run_id, head_sha, evidence_type, accepted, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          input.evidence_id,
          input.external_key,
          runId,
          input.head_sha,
          input.evidence_type,
          accepted ? 1 : 0,
          JSON.stringify(record)
        );
      this.saveRun(run, run.row_version);
      this.event("evidence_recorded", runId, {
        evidence_id: input.evidence_id,
        accepted,
      });
      return record;
    })();
  }

  async recordProviderHealth(
    lease: LeaseCredentials,
    input: ProviderHealthInput
  ): Promise<Record<string, unknown>> {
    return this.db.transaction(() => {
      this.guard(lease);
      const row = this.db
        .prepare("SELECT row_version, payload_json FROM lane_v2_providers WHERE provider = ?")
        .get(input.provider) as
        | { row_version: number; payload_json: string }
        | undefined;
      if (Number(row?.row_version ?? 0) !== input.expected_version) {
        conflict("provider health changed");
      }
      const current = row
        ? parse<Record<string, unknown>>(row.payload_json)
        : { provider: input.provider, state: "healthy", transient_failures: [] };
      const failures = Array.isArray(current.transient_failures)
        ? current.transient_failures.filter(
            (value) =>
              Date.parse(String(value)) >= Date.now() - 10 * 60 * 1000
          )
        : [];
      let state = String(current.state ?? "healthy");
      let breakerUntil = current.breaker_until ?? null;
      const breakerStillOpen =
        state === "open" &&
        (!breakerUntil || Date.parse(String(breakerUntil)) > Date.now());
      if (input.outcome === "enable") {
        state = "healthy";
        failures.length = 0;
        breakerUntil = null;
      } else if (input.outcome === "success") {
        // A concurrent in-flight attempt succeeding must not erase a provider-
        // wide hard/quota breaker before its cooling period expires.
        if (!breakerStillOpen && state !== "disabled") {
          state = "healthy";
          failures.length = 0;
          breakerUntil = null;
        }
      } else if (input.outcome === "disable") {
        state = "disabled";
        breakerUntil = null;
      } else if (
        input.outcome === "quota_failure" ||
        input.outcome === "auth_failure"
      ) {
        state = "open";
        breakerUntil = new Date(
          Date.now() + (input.breaker_seconds ?? 600) * 1000
        ).toISOString();
      } else {
        failures.push(now());
        if (failures.length >= 3) {
          state = "open";
          breakerUntil = new Date(
            Date.now() + (input.breaker_seconds ?? 600) * 1000
          ).toISOString();
        }
      }
      const next = {
        ...current,
        provider: input.provider,
        state,
        transient_failures: failures.slice(-3),
        breaker_until: breakerUntil,
        last_error_code: input.error_code ?? null,
        row_version: input.expected_version + 1,
        updated_at: now(),
      };
      this.db
        .prepare(
          `INSERT INTO lane_v2_providers (provider, row_version, payload_json)
           VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET
             row_version = excluded.row_version, payload_json = excluded.payload_json`
        )
        .run(input.provider, next.row_version, JSON.stringify(next));
      if (current.state !== state && (row || state !== "healthy")) {
        this.event("provider_breaker_changed", null, {
          provider: input.provider,
          from_state: current.state,
          to_state: state,
          outcome: input.outcome,
        });
      }
      return next;
    })();
  }

  async claimNotification(
    lease: LeaseCredentials,
    input: NotificationClaimInput
  ): Promise<LaneNotificationClaim> {
    return this.db.transaction(() => {
      const currentLease = this.guard(lease);
      if (
        !input.notification_key.trim() ||
        input.notification_key.length > 256 ||
        !/^[0-9a-f]{64}$/.test(input.message_hash)
      ) {
        throw new LaneStateStoreError("invalid notification claim", 400);
      }
      const controller = this.db
        .prepare("SELECT row_version FROM lane_v2_controller WHERE state_id = 1")
        .get() as { row_version: number };
      if (controller.row_version !== input.expected_controller_version) {
        conflict("controller state changed");
      }
      const existing = this.db
        .prepare("SELECT * FROM lane_v2_notifications WHERE notification_key = ?")
        .get(input.notification_key) as
        | Omit<LaneNotificationClaim, "claimed">
        | undefined;
      if (existing) {
        return { ...existing, claimed: false };
      }
      const record: LaneNotificationClaim = {
        notification_key: input.notification_key,
        message_hash: input.message_hash,
        claimed: true,
        claimed_by: String(currentLease.owner_id),
        lease_fence: lease.fence,
        claimed_at: now(),
        row_version: 1,
      };
      this.db
        .prepare(
          `INSERT INTO lane_v2_notifications
             (notification_key, message_hash, claimed_by, lease_fence,
              claimed_at, row_version)
           VALUES (?, ?, ?, ?, ?, 1)`
        )
        .run(
          record.notification_key,
          record.message_hash,
          record.claimed_by,
          record.lease_fence,
          record.claimed_at
        );
      this.event("notification_claimed", null, {
        notification_key: record.notification_key,
        message_hash: record.message_hash,
      });
      return record;
    })();
  }

  async createControl(input: {
    control_id: string;
    idempotency_key: string;
    kind: string;
    lane_id?: string;
    requested_by: string;
    payload?: Record<string, unknown>;
    approvalKey?: string;
  }): Promise<LaneControlRecord> {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT payload_json FROM lane_v2_controls WHERE idempotency_key = ?")
        .get(input.idempotency_key) as { payload_json: string } | undefined;
      if (existing) return parse<LaneControlRecord>(existing.payload_json);
      const human = ["archive_approval", "cutover", "rollback"].includes(input.kind);
      const allowed = new Set([
        "pause",
        "resume",
        "retry",
        "provider_disable",
        "provider_enable",
        "archive_approval",
        "cutover",
        "shadow",
        "rollback",
      ]);
      if (!allowed.has(input.kind)) {
        throw new LaneStateStoreError("unsupported lane control kind", 400);
      }
      if (input.kind === "retry" && !input.lane_id) {
        throw new LaneStateStoreError("retry control requires lane_id", 400);
      }
      if (
        ["provider_disable", "provider_enable"].includes(input.kind) &&
        !["claude", "codex", "cursor"].includes(
          String(input.payload?.provider ?? "")
        )
      ) {
        throw new LaneStateStoreError(
          "provider control requires claude, codex, or cursor",
          400
        );
      }
      if (
        ["cutover", "shadow"].includes(input.kind) &&
        !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/.test(
          String(input.payload?.revision_id ?? "")
        )
      ) {
        throw new LaneStateStoreError("control requires revision_id", 400);
      }
      if (human && !input.approvalKey) {
        throw new LaneStateStoreError("human approval key required", 401);
      }
      if (input.kind === "archive_approval") {
        const expiresAt = Date.parse(String(input.payload?.expires_at ?? ""));
        if (
          !Number.isFinite(expiresAt) ||
          expiresAt <= Date.now() ||
          expiresAt > Date.now() + 7 * 24 * 60 * 60 * 1000
        ) {
          throw new LaneStateStoreError(
            "archive approval expiry must be within the next seven days",
            400
          );
        }
        const workspaceIds = input.payload?.workspace_ids;
        if (
          !Array.isArray(workspaceIds) ||
          workspaceIds.some((value) => typeof value !== "string" || !value.trim()) ||
          workspaceIds.length === 0
        ) {
          throw new LaneStateStoreError(
            "archive approval requires exact workspace_ids",
            400
          );
        }
      }
      const record: LaneControlRecord = {
        control_id: input.control_id,
        idempotency_key: input.idempotency_key,
        kind: input.kind,
        lane_id: input.lane_id ?? null,
        requested_by: input.requested_by,
        payload_json: input.payload ?? {},
        status: "pending",
        human_approved: human,
        row_version: 1,
      };
      this.db
        .prepare(
          "INSERT INTO lane_v2_controls (control_id, idempotency_key, status, row_version, payload_json) VALUES (?, ?, 'pending', 1, ?)"
        )
        .run(record.control_id, record.idempotency_key, JSON.stringify(record));
      this.event("control_requested", null, {
        control_id: record.control_id,
        kind: record.kind,
      });
      return record;
    })();
  }

  async finishControl(
    lease: LeaseCredentials,
    controlId: string,
    input: {
      expected_version: number;
      expected_controller_version: number;
      status: "applied" | "rejected";
      result?: Record<string, unknown>;
    }
  ): Promise<LaneControlRecord> {
    return this.db.transaction(() => {
      this.guard(lease);
      const row = this.db
        .prepare("SELECT payload_json FROM lane_v2_controls WHERE control_id = ?")
        .get(controlId) as { payload_json: string } | undefined;
      if (!row) throw new LaneStateStoreError("control not found", 404);
      const current = parse<LaneControlRecord>(row.payload_json);
      if (current.row_version !== input.expected_version) conflict("control changed");
      const controller = this.db
        .prepare("SELECT * FROM lane_v2_controller WHERE state_id = 1")
        .get() as Record<string, unknown>;
      if (Number(controller.row_version) !== input.expected_controller_version) {
        conflict("controller state changed");
      }
      let mode = String(controller.mode);
      let revision = (controller.active_revision_id as string | null) ?? null;
      let reason = (controller.reason as string | null) ?? null;
      if (input.status === "applied") {
        if (current.kind === "pause") {
          mode = "paused_safety";
          reason = `paused from ${String(controller.mode)}: [control:${current.control_id}] ${String(
            current.payload_json.reason ?? "operator pause"
          )}`;
        } else if (current.kind === "resume") {
          if (
            controller.mode !== "paused_safety" ||
            !String(controller.reason ?? "").startsWith("paused from active:")
          ) {
            conflict(
              "resume is allowed only after a pause from active mode; shadow/disabled requires cutover"
            );
          }
          const manifest = revision
            ? (this.db
                .prepare("SELECT state FROM lane_v2_manifests WHERE revision_id = ?")
                .get(revision) as { state: string } | undefined)
            : undefined;
          if (manifest?.state !== "active") {
            conflict("controller cannot resume without the same active manifest revision");
          }
          mode = "active";
          reason = null;
        } else if (current.kind === "cutover") {
          revision = String(current.payload_json.revision_id ?? "");
          if (!revision) throw new LaneStateStoreError("cutover requires revision_id", 400);
          const manifest = this.db
            .prepare("SELECT state FROM lane_v2_manifests WHERE revision_id = ?")
            .get(revision) as { state: string } | undefined;
          if (manifest?.state !== "active") {
            conflict("cutover requires the same active manifest revision");
          }
          mode = "active";
          reason = null;
        } else if (current.kind === "shadow") {
          revision = String(current.payload_json.revision_id ?? "");
          if (!revision) throw new LaneStateStoreError("shadow requires revision_id", 400);
          const manifest = this.db
            .prepare("SELECT state FROM lane_v2_manifests WHERE revision_id = ?")
            .get(revision) as { state: string } | undefined;
          if (manifest?.state !== "active") {
            conflict("shadow requires the same active manifest revision");
          }
          mode = "shadow";
          reason = "read-only shadow observation";
        } else if (current.kind === "rollback") {
          mode = "disabled";
          reason = "operator rollback";
        }
      }
      const controllerChange = this.db
        .prepare(
          `UPDATE lane_v2_controller SET mode = ?, active_revision_id = ?,
             reason = ?, updated_at = ?, row_version = row_version + 1
           WHERE state_id = 1 AND row_version = ?`
        )
        .run(
          mode,
          revision,
          reason,
          now(),
          input.expected_controller_version
        );
      if (controllerChange.changes !== 1) conflict("controller state changed");
      const next: LaneControlRecord = {
        ...current,
        status: input.status,
        payload_json: {
          ...current.payload_json,
          controller_result: input.result ?? {},
        },
        row_version: current.row_version + 1,
      };
      const result = this.db
        .prepare(
          "UPDATE lane_v2_controls SET status = ?, row_version = ?, payload_json = ? WHERE control_id = ? AND row_version = ?"
        )
        .run(
          next.status,
          next.row_version,
          JSON.stringify(next),
          controlId,
          current.row_version
        );
      if (result.changes !== 1) conflict("control changed");
      return next;
    })();
  }

  async snapshot(sinceEventSeq = 0): Promise<LaneSnapshotV2> {
    const manifestRow = this.db
      .prepare("SELECT * FROM lane_v2_manifests WHERE state = 'active'")
      .get() as Record<string, unknown> | undefined;
    const manifest = manifestRow
      ? {
          ...manifestRow,
          manifest_json: parse<Record<string, unknown>>(
            String(manifestRow.manifest_json)
          ),
        }
      : null;
    const controller = this.db
      .prepare("SELECT * FROM lane_v2_controller WHERE state_id = 1")
      .get() as LaneSnapshotV2["controller"];
    const rows = this.db
      .prepare("SELECT payload_json FROM lane_v2_runs ORDER BY rowid")
      .all() as Array<{ payload_json: string }>;
    const runs = rows.map((row) => parse<LaneRunRecord>(row.payload_json));
    const attempts = (
      this.db.prepare("SELECT payload_json FROM lane_v2_attempts ORDER BY rowid").all() as Array<{
        payload_json: string;
      }>
    ).map((row) => parse<LaneAttemptRecord>(row.payload_json));
    const actions = (
      this.db
        .prepare(
          "SELECT payload_json FROM lane_v2_actions WHERE status IN ('pending','ambiguous') ORDER BY rowid"
        )
        .all() as Array<{ payload_json: string }>
    ).map((row) => parse<LaneActionRecordV2>(row.payload_json));
    const providers = (
      this.db.prepare("SELECT payload_json FROM lane_v2_providers ORDER BY provider").all() as Array<{
        payload_json: string;
      }>
    ).map((row) => parse<Record<string, unknown>>(row.payload_json));
    const controls = (
      this.db
        .prepare("SELECT payload_json FROM lane_v2_controls WHERE status = 'pending'")
        .all() as Array<{ payload_json: string }>
    ).map((row) => parse<LaneControlRecord>(row.payload_json));
    const eventRows = this.db
      .prepare("SELECT * FROM lane_v2_events WHERE event_seq > ? ORDER BY event_seq LIMIT 1000")
      .all(Math.max(0, sinceEventSeq)) as Array<Record<string, unknown>>;
    const events: Array<Record<string, unknown>> = eventRows.map((row) => ({
      ...row,
      data_json: parse<Record<string, unknown>>(String(row.data_json)),
    }));
    const leaseRow = this.db
      .prepare("SELECT * FROM lane_v2_lease WHERE lease_name = 'growth'")
      .get() as Record<string, unknown> | undefined;
    const lease = leaseRow ? { ...leaseRow } : null;
    if (lease) {
      const held =
        Boolean(lease.lease_token) &&
        Date.parse(String(lease.expires_at ?? "")) > Date.now();
      delete lease.lease_token;
      lease.held = held;
      if (!held) {
        lease.last_owner_site = lease.owner_site;
        lease.owner_id = null;
        lease.owner_site = null;
      }
    }
    const limits =
      (manifest?.manifest_json.global as Record<string, unknown> | undefined)
        ?.provider_capacity as Record<string, number> | undefined;
    const capacity: Record<string, { active: number; limit: number }> = {};
    for (const provider of ["claude", "codex", "cursor"]) {
      capacity[provider] = {
        active: attempts.filter(
          (attempt) =>
            attempt.provider === provider &&
            ["commissioned", "working", "awaiting_result"].includes(attempt.status)
        ).length,
        limit: limits?.[provider] ?? ({ claude: 3, codex: 2, cursor: 2 } as Record<string, number>)[provider],
      };
    }
    const dependencies: LaneSnapshotV2["dependencies"] = {};
    const manifestLanes = (manifest?.manifest_json.lanes ?? []) as LaneManifestV2["lanes"];
    for (const lane of manifestLanes) {
      const requirements = lane.dependencies.map((dependency) => {
        const prerequisite = [...runs]
          .filter((run) => run.lane_id === dependency.lane_id)
          .sort((left, right) => right.generation - left.generation)[0];
        const reached =
          dependency.milestone === "pr_opened"
            ? Boolean(prerequisite?.pr_number && prerequisite.head_sha)
            : dependency.milestone === "merged"
              ? Boolean(prerequisite?.merged_sha)
              : prerequisite?.status === "validated";
        return { ...dependency, reached };
      });
      dependencies[lane.id] = {
        ready: requirements.every((requirement) => requirement.reached),
        requirements,
      };
    }
    const duplicates: Array<Record<string, unknown>> = [];
    for (const field of ["workspace_id", "pr_url"] as const) {
      const grouped = new Map<string, string[]>();
      for (const run of runs) {
        const value = run[field];
        if (!value) continue;
        const ids = grouped.get(value) ?? [];
        ids.push(run.run_id);
        grouped.set(value, ids);
      }
      for (const [value, runIds] of grouped) {
        if (runIds.length > 1) {
          duplicates.push({ kind: field, value, run_ids: runIds });
        }
      }
    }
    return {
      manifest: manifest as LaneSnapshotV2["manifest"],
      controller,
      lease,
      capacity,
      providers,
      runs,
      attempts,
      ambiguous_actions: actions.filter((action) => action.status === "ambiguous"),
      pending_actions: actions.filter((action) => action.status === "pending"),
      pending_controls: controls,
      dependencies,
      duplicates,
      events,
      next_event_seq: Math.max(
        sinceEventSeq,
        ...events.map((event) => Number(event.event_seq))
      ),
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
