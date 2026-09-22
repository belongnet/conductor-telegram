import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { requiredChecksGate } from "../src/bot/github.js";
import {
  MAX_RETIREMENT_EVIDENCE_BYTES,
  readRetirementEvidenceFile,
} from "../src/cli/lanes.js";
import {
  commissionedAttemptModel,
  validationActionBinding,
} from "../src/lanes/controller.js";
import {
  managedSessionName,
  managedWorkspaceName,
  selectProvider,
} from "../src/lanes/controller-policy.js";
import { canonicalManifestJson, parseLaneManifest } from "../src/lanes/manifest.js";
import { SqliteLaneStateStore } from "../src/lanes/state-store-sqlite.js";
import type {
  LaneControlRecord,
  LaneLease,
  LaneRunRecord,
  LaneScopedControlState,
} from "../src/lanes/state-store.js";
import { retirementEvidenceProvesCompletion } from "../src/lanes/state-store.js";

const MERGED_ONE = "a".repeat(40);
const MERGED_TWO = "b".repeat(40);

function safetyManifest() {
  const lane = (id: string) => ({
    id,
    repository: { owner: "belongnet", name: "example", base_branch: "main" },
    prompt: { path: `${id}.md`, sha256: "c".repeat(64) },
    priority: 100,
    preferred_providers: ["claude", "codex", "cursor"],
    fallback_providers: [],
    dependencies: [],
    policy: { kind: "one_shot" },
    delivery_adapter: {
      kind: "github",
      required_checks: ["required-ci", "second-required"],
    },
    merge_policy: {
      method: "squash",
      auto_merge: true,
      deploy_notes: "",
      replay_notes: "",
    },
    validation_profile: { commands: [["npm", "test"]], probes: [] },
    managed_tags: ["managed:growth", `lane:${id}`],
  });
  const l1 = lane("L1");
  const l2 = lane("L2");
  const recurring = {
    ...lane("R1"),
    dependencies: [{ lane_id: "L1", milestone: "validated" }],
    policy: { kind: "recurring", enabled: false, schedule: "daily" },
    merge_policy: {
      method: "squash",
      auto_merge: false,
      deploy_notes: "",
      replay_notes: "",
    },
  };
  return parseLaneManifest(
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
      lanes: [l1, l2, recurring],
    },
    "/tmp/lanes-safety-manifest.json",
    { verifyPrompts: false }
  );
}

async function activate(store: SqliteLaneStateStore): Promise<LaneLease> {
  const lease = await store.claimLease({
    ownerId: "mac:safety-controls",
    ownerSite: "mac",
    leaseSeconds: 75,
  });
  assert.ok(lease);
  const manifest = safetyManifest();
  await store.stageManifest(lease, {
    revisionId: "growth-safety",
    sourceRef: "test",
    manifest,
    createdBy: "test",
  });
  await store.activateManifest(lease, "growth-safety", 1);
  const cutover = await store.createControl({
    control_id: "safety-cutover",
    idempotency_key: "safety-cutover",
    kind: "cutover",
    requested_by: "human:test",
    payload: { revision_id: "growth-safety" },
    approvalKey: "human-key",
  });
  await finish(store, lease, cutover);
  return lease;
}

async function finish(
  store: SqliteLaneStateStore,
  lease: LaneLease,
  control: LaneControlRecord
) {
  return store.finishControl(lease, control.control_id, {
    expected_version: control.row_version,
    expected_controller_version: (await store.snapshot()).controller!.row_version,
    status: "applied",
  });
}

async function validatingRun(
  store: SqliteLaneStateStore,
  lease: LaneLease,
  laneId: "L1" | "L2",
  sha: string
): Promise<LaneRunRecord> {
  let run = await store.createRun(lease, {
    run_id: `run-${laneId}`,
    manifest_revision_id: "growth-safety",
    lane_id: laneId,
    generation: 1,
    priority: 100,
    metadata: { legacy_git_verified: true },
  });
  run = await store.transitionRun(lease, run.run_id, {
    expected_version: run.row_version,
    from_status: "queued",
    to_status: "validating",
    stage: "validation",
    patch: { merged_sha: sha },
  });
  return run;
}

function evidenceRef(input: {
  id: string;
  key: string;
  locator: string;
  laneId: string;
  runId: string;
  sha: string;
  kind?:
    | "merge_record"
    | "required_checks"
    | "canonical_replay"
    | "deterministic_validation";
  payload?: Record<string, unknown>;
}): LaneScopedControlState["evidence_refs_json"][number] {
  const evidence_document = {
    manifest_revision_id: "growth-safety",
    lane_id: input.laneId,
    run_id: input.runId,
    merged_sha: input.sha,
    evidence_kind: input.kind ?? "canonical_replay",
    source_locator: input.locator,
    observed_at: "2026-09-22T12:00:00.000Z",
    evidence_payload: input.payload ?? {
      verified: true,
      passed: true,
      receipt_summary: "canonical Git-host replay completed successfully",
    },
  };
  return {
    evidence_id: input.id,
    external_key: input.key,
    evidence_hash: createHash("sha256")
      .update(canonicalManifestJson(evidence_document))
      .digest("hex"),
    evidence_document,
  };
}

test("lane hold and release are revision-scoped, atomic, and restart-persistent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-controls-restart-"));
  const filename = path.join(root, "state.db");
  let store = new SqliteLaneStateStore(filename);
  try {
    const lease = await activate(store);
    await validatingRun(store, lease, "L1", MERGED_ONE);
    const controllerVersion = (await store.snapshot()).controller!.row_version;
    const hold = await store.createControl({
      control_id: "hold-l1",
      idempotency_key: "hold-l1",
      kind: "lane_hold",
      lane_id: "L1",
      requested_by: "human:test",
      payload: {
        manifest_revision_id: "growth-safety",
        reason: "contain validation while audited",
      },
    });
    await finish(store, lease, hold);
    let snapshot = await store.snapshot();
    assert.equal(snapshot.controller!.row_version, controllerVersion);
    assert.equal(snapshot.runs.find((run) => run.lane_id === "L1")!.status, "paused_safety");
    assert.equal(snapshot.lane_controls[0]?.state, "held");

    await store.close();
    store = new SqliteLaneStateStore(filename);
    snapshot = await store.snapshot();
    assert.equal(snapshot.lane_controls[0]?.control_id, "hold-l1");
    assert.equal(snapshot.lane_controls[0]?.resume_status, "validating");
    assert.equal(snapshot.lane_controls[0]?.resume_stage, "validation");
    const heldRunVersion = snapshot.runs[0]!.row_version;
    const replayedHold = await store.createControl({
      control_id: "ignored-replayed-hold-id",
      idempotency_key: "hold-l1",
      kind: "lane_hold",
      lane_id: "L1",
      requested_by: "human:test",
      payload: {
        manifest_revision_id: "growth-safety",
        reason: "contain validation while audited",
      },
    });
    assert.equal(replayedHold.status, "applied");
    snapshot = await store.snapshot();
    assert.equal(snapshot.runs[0]!.row_version, heldRunVersion);
    assert.equal(
      snapshot.events.filter((event) => event.event_type === "lane_held").length,
      1
    );

    const resumedLease = await store.claimLease({
      ownerId: "ovh:safety-controls",
      ownerSite: "ovh",
      leaseSeconds: 75,
    });
    assert.equal(resumedLease, null, "the original live lease still fences takeover");
    const release = await store.createControl({
      control_id: "release-l1",
      idempotency_key: "release-l1",
      kind: "lane_release",
      lane_id: "L1",
      requested_by: "human:test",
      payload: {
        manifest_revision_id: "growth-safety",
        expected_hold_control_id: "hold-l1",
      },
      approvalKey: "human-key",
    });
    await finish(store, lease, release);
    snapshot = await store.snapshot();
    assert.equal(snapshot.lane_controls.length, 0);
    assert.equal(snapshot.runs.find((run) => run.lane_id === "L1")!.status, "validating");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lane validate is human-approved, one-run, and preserves the global pause", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-validate-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activate(store);
    await validatingRun(store, lease, "L1", MERGED_ONE);
    const hold = await store.createControl({
      control_id: "validate-hold-l1",
      idempotency_key: "validate-hold-l1",
      kind: "lane_hold",
      lane_id: "L1",
      requested_by: "human:test",
      payload: { manifest_revision_id: "growth-safety", reason: "bounded validation" },
    });
    await finish(store, lease, hold);
    const pause = await store.createControl({
      control_id: "global-pause",
      idempotency_key: "global-pause",
      kind: "pause",
      requested_by: "human:test",
      payload: { reason: "operator pause" },
    });
    await finish(store, lease, pause);
    const before = (await store.snapshot()).controller!;
    const validate = await store.createControl({
      control_id: "validate-l1",
      idempotency_key: "validate-l1",
      kind: "lane_validate",
      lane_id: "L1",
      requested_by: "human:test",
      payload: {
        manifest_revision_id: "growth-safety",
        expected_hold_control_id: "validate-hold-l1",
        expected_run_id: "run-L1",
        merged_sha: MERGED_ONE,
      },
      approvalKey: "human-key",
    });
    await finish(store, lease, validate);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.controller!.mode, "paused_safety");
    assert.equal(snapshot.controller!.row_version, before.row_version);
    assert.equal(snapshot.runs[0]?.status, "validating");
    assert.equal(snapshot.lane_controls[0]?.state, "validation_authorized");
    assert.equal(snapshot.lane_controls[0]?.run_id, snapshot.runs[0]?.run_id);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("queued release and validate controls reject a replaced hold identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-hold-cas-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activate(store);
    await validatingRun(store, lease, "L1", MERGED_ONE);
    const holdOne = await store.createControl({
      control_id: "hold-one",
      idempotency_key: "hold-one",
      kind: "lane_hold",
      lane_id: "L1",
      requested_by: "human:test",
      payload: { manifest_revision_id: "growth-safety", reason: "first hold" },
    });
    await finish(store, lease, holdOne);
    const staleRelease = await store.createControl({
      control_id: "stale-release",
      idempotency_key: "stale-release",
      kind: "lane_release",
      lane_id: "L1",
      requested_by: "human:test",
      payload: {
        manifest_revision_id: "growth-safety",
        expected_hold_control_id: "hold-one",
      },
      approvalKey: "human-key",
    });
    const holdTwo = await store.createControl({
      control_id: "hold-two",
      idempotency_key: "hold-two",
      kind: "lane_hold",
      lane_id: "L1",
      requested_by: "human:test",
      payload: { manifest_revision_id: "growth-safety", reason: "replacement hold" },
    });
    await finish(store, lease, holdTwo);
    await assert.rejects(
      finish(store, lease, staleRelease),
      /hold identity changed before apply/
    );

    const pause = await store.createControl({
      control_id: "hold-cas-pause",
      idempotency_key: "hold-cas-pause",
      kind: "pause",
      requested_by: "human:test",
      payload: { reason: "bounded validation" },
    });
    await finish(store, lease, pause);
    const staleValidate = await store.createControl({
      control_id: "stale-validate",
      idempotency_key: "stale-validate",
      kind: "lane_validate",
      lane_id: "L1",
      requested_by: "human:test",
      payload: {
        manifest_revision_id: "growth-safety",
        expected_hold_control_id: "hold-two",
        expected_run_id: "run-L1",
        merged_sha: MERGED_ONE,
      },
      approvalKey: "human-key",
    });
    const holdThree = await store.createControl({
      control_id: "hold-three",
      idempotency_key: "hold-three",
      kind: "lane_hold",
      lane_id: "L1",
      requested_by: "human:test",
      payload: { manifest_revision_id: "growth-safety", reason: "new audit hold" },
    });
    await finish(store, lease, holdThree);
    await assert.rejects(
      finish(store, lease, staleValidate),
      /hold identity changed before apply/
    );
    const snapshot = await store.snapshot();
    assert.equal(snapshot.lane_controls[0]?.control_id, "hold-three");
    assert.equal(snapshot.runs[0]?.status, "paused_safety");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejected bounded deterministic validation atomically holds the lane, settles the attempt, and frees capacity across restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-validation-failure-"));
  const filename = path.join(root, "state.db");
  let store = new SqliteLaneStateStore(filename);
  try {
    const lease = await activate(store);
    await validatingRun(store, lease, "L1", MERGED_ONE);
    const hold = await store.createControl({
      control_id: "failure-hold",
      idempotency_key: "failure-hold",
      kind: "lane_hold",
      lane_id: "L1",
      requested_by: "human:test",
      payload: { manifest_revision_id: "growth-safety", reason: "bounded test" },
    });
    await finish(store, lease, hold);
    const pause = await store.createControl({
      control_id: "failure-pause",
      idempotency_key: "failure-pause",
      kind: "pause",
      requested_by: "human:test",
      payload: { reason: "bounded test" },
    });
    await finish(store, lease, pause);
    const validate = await store.createControl({
      control_id: "failure-validate",
      idempotency_key: "failure-validate",
      kind: "lane_validate",
      lane_id: "L1",
      requested_by: "human:test",
      payload: {
        manifest_revision_id: "growth-safety",
        expected_hold_control_id: "failure-hold",
        expected_run_id: "run-L1",
        merged_sha: MERGED_ONE,
      },
      approvalKey: "human-key",
    });
    await finish(store, lease, validate);
    let run = (await store.snapshot()).runs[0]!;
    const attempt = await store.beginAttempt(lease, run.run_id, {
      attempt_id: "bounded-failed-attempt",
      expected_run_version: run.row_version,
      stage: "validation",
      attempt_number: 1,
      role: "validation",
      provider: "claude",
      model: "fable-5-1",
      nonce: "bounded-failed-nonce",
      head_sha: MERGED_ONE,
    });
    run = (await store.snapshot()).runs[0]!;
    const rejected = await store.recordEvidence(lease, run.run_id, {
      evidence_id: "bounded-failed-evidence",
      external_key: "bounded-failed-evidence",
      expected_run_version: run.row_version,
      attempt_id: attempt.attempt_id,
      evidence_type: "deterministic_validation",
      provider: attempt.provider,
      nonce: attempt.nonce,
      repo_owner: run.repo_owner,
      repo_name: run.repo_name,
      head_sha: MERGED_ONE,
      evidence: {
        nonce: attempt.nonce,
        run: run.run_id,
        stage: "validation",
        head_sha: MERGED_ONE,
        merged_sha: MERGED_ONE,
        provider: attempt.provider,
        passed: false,
        commands: [{ argv: ["npm", "test"], exit_code: 1 }],
        probes: [],
        receipts: [],
      },
    });
    assert.equal(rejected.accepted, false);
    await store.close();
    store = new SqliteLaneStateStore(filename);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.lane_controls[0]?.state, "held");
    assert.equal(snapshot.runs[0]?.status, "paused_safety");
    assert.equal(snapshot.attempts[0]?.status, "failed");
    assert.equal(snapshot.capacity.claude.active, 0);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy Sonnet manifest commissions bounded Claude validation on current Fable with immutable workspace and session plans", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-bounded-model-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const manifest = safetyManifest();
    (manifest.global.provider_models as Record<string, string>).claude = "sonnet-5-1m";
    const lease = await store.claimLease({
      ownerId: "mac:legacy-bounded-model",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "growth-safety",
      sourceRef: "legacy-active-revision",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "growth-safety", 1);
    const cutover = await store.createControl({
      control_id: "legacy-model-cutover",
      idempotency_key: "legacy-model-cutover",
      kind: "cutover",
      requested_by: "human:test",
      payload: { revision_id: "growth-safety" },
      approvalKey: "human-key",
    });
    await finish(store, lease, cutover);
    await validatingRun(store, lease, "L1", MERGED_ONE);
    const hold = await store.createControl({
      control_id: "legacy-model-hold",
      idempotency_key: "legacy-model-hold",
      kind: "lane_hold",
      lane_id: "L1",
      requested_by: "human:test",
      payload: { manifest_revision_id: "growth-safety", reason: "legacy audit" },
    });
    await finish(store, lease, hold);
    const pause = await store.createControl({
      control_id: "legacy-model-pause",
      idempotency_key: "legacy-model-pause",
      kind: "pause",
      requested_by: "human:test",
      payload: { reason: "bounded legacy validation" },
    });
    await finish(store, lease, pause);
    const validate = await store.createControl({
      control_id: "legacy-model-validate",
      idempotency_key: "legacy-model-validate",
      kind: "lane_validate",
      lane_id: "L1",
      requested_by: "human:test",
      payload: {
        manifest_revision_id: "growth-safety",
        expected_hold_control_id: "legacy-model-hold",
        expected_run_id: "run-L1",
        merged_sha: MERGED_ONE,
      },
      approvalKey: "human-key",
    });
    await finish(store, lease, validate);
    let run = (await store.snapshot()).runs[0]!;
    const model = commissionedAttemptModel({
      manifest,
      provider: "claude",
      role: "validation",
      boundedValidation: true,
    });
    assert.equal(model, "fable-5-1");
    assert.equal(
      commissionedAttemptModel({
        manifest,
        provider: "claude",
        role: "validation",
      }),
      "sonnet-5-1m",
      "the legacy override is forbidden outside bounded validation"
    );
    const backupManifest = safetyManifest();
    (backupManifest.global.provider_models as Record<string, string>).claude =
      "opus-5-1m";
    assert.equal(
      commissionedAttemptModel({
        manifest: backupManifest,
        provider: "claude",
        role: "validation",
        boundedValidation: true,
      }),
      "opus-5-1m",
      "current approved manifests retain their exact same-provider model"
    );
    const attempt = await store.beginAttempt(lease, run.run_id, {
      attempt_id: "legacy-validation-attempt",
      expected_run_version: run.row_version,
      stage: "validation",
      attempt_number: 1,
      role: "validation",
      provider: "claude",
      model,
      nonce: "legacy-validation-nonce",
      head_sha: MERGED_ONE,
    });
    run = (await store.snapshot()).runs[0]!;
    const lane = manifest.lanes.find((candidate) => candidate.id === "L1")!;
    const workspaceName = managedWorkspaceName({
      laneId: "L1",
      runId: run.run_id,
      stage: attempt.stage,
      attempt: attempt.attempt_number,
    });
    const sessionName = managedSessionName({
      laneId: "L1",
      runId: run.run_id,
      stage: attempt.stage,
      attempt: attempt.attempt_number,
      provider: "claude",
    });
    const binding = validationActionBinding(lane, run, attempt);
    const workspaceAction = await store.beginAction(lease, run.run_id, {
      action_id: "legacy-validation-workspace",
      deterministic_tag: "legacy-validation-workspace",
      expected_run_version: run.row_version,
      stage: "validation-workspace",
      attempt_id: attempt.attempt_id,
      action_type: "create_workspace",
      request: {
        project_id: "project-example",
        base_branch: run.base_branch,
        workspace_name: workspaceName,
        session_name: sessionName,
        provider: "claude",
        model,
        ...binding,
      },
    });
    assert.equal(workspaceAction.request_json.model, "fable-5-1");
    await store.finishAction(lease, workspaceAction.action_id, {
      expected_action_version: workspaceAction.row_version,
      expected_run_version: (await store.snapshot()).runs[0]!.row_version,
      status: "succeeded",
      result: {
        workspace_id: "workspace-legacy-validation",
        workspace_name: workspaceName,
        session_id: "session-legacy-validation-initial",
        session_name: sessionName,
      },
    });
    run = (await store.snapshot()).runs[0]!;
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "validating",
      to_status: "validating",
      stage: "validation",
      patch: {
        workspace_id: "workspace-legacy-validation",
        workspace_name: workspaceName,
      },
    });
    await store.updateAttempt(lease, attempt.attempt_id, {
      expected_attempt_version: attempt.row_version,
      expected_run_version: run.row_version,
      status: "commissioned",
      workspace_id: "workspace-legacy-validation",
      result: {},
    });
    const rebound = await store.snapshot();
    run = rebound.runs[0]!;
    const reboundAttempt = rebound.attempts[0]!;
    const sessionAction = await store.beginAction(lease, run.run_id, {
      action_id: "legacy-validation-session",
      deterministic_tag: "legacy-validation-session",
      expected_run_version: run.row_version,
      stage: "validation-session",
      attempt_id: reboundAttempt.attempt_id,
      action_type: "create_session",
      request: {
        workspace_id: run.workspace_id,
        session_name: sessionName,
        provider: "claude",
        model,
        ...validationActionBinding(lane, run, reboundAttempt),
      },
    });
    assert.equal(sessionAction.request_json.model, "fable-5-1");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy grok manifest commissions bounded Cursor validation on current Grok", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-bounded-grok-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const manifest = safetyManifest();
    (manifest.global.provider_models as Record<string, string>).cursor = "grok-4.6";
    const lease = await store.claimLease({
      ownerId: "mac:legacy-bounded-grok",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    await store.stageManifest(lease, {
      revisionId: "growth-safety",
      sourceRef: "legacy-cursor-active-revision",
      manifest,
      createdBy: "test",
    });
    await store.activateManifest(lease, "growth-safety", 1);
    const cutover = await store.createControl({
      control_id: "legacy-grok-cutover",
      idempotency_key: "legacy-grok-cutover",
      kind: "cutover",
      requested_by: "human:test",
      payload: { revision_id: "growth-safety" },
      approvalKey: "human-key",
    });
    await finish(store, lease, cutover);
    await validatingRun(store, lease, "L1", MERGED_ONE);
    const hold = await store.createControl({
      control_id: "legacy-grok-hold",
      idempotency_key: "legacy-grok-hold",
      kind: "lane_hold",
      lane_id: "L1",
      requested_by: "human:test",
      payload: { manifest_revision_id: "growth-safety", reason: "legacy cursor audit" },
    });
    await finish(store, lease, hold);
    const pause = await store.createControl({
      control_id: "legacy-grok-pause",
      idempotency_key: "legacy-grok-pause",
      kind: "pause",
      requested_by: "human:test",
      payload: { reason: "bounded legacy cursor validation" },
    });
    await finish(store, lease, pause);
    const validate = await store.createControl({
      control_id: "legacy-grok-validate",
      idempotency_key: "legacy-grok-validate",
      kind: "lane_validate",
      lane_id: "L1",
      requested_by: "human:test",
      payload: {
        manifest_revision_id: "growth-safety",
        expected_hold_control_id: "legacy-grok-hold",
        expected_run_id: "run-L1",
        merged_sha: MERGED_ONE,
      },
      approvalKey: "human-key",
    });
    await finish(store, lease, validate);
    const run = (await store.snapshot()).runs[0]!;
    const model = commissionedAttemptModel({
      manifest,
      provider: "cursor",
      role: "validation",
      boundedValidation: true,
    });
    assert.equal(model, "grok-4.7");
    assert.equal(
      commissionedAttemptModel({ manifest, provider: "cursor", role: "validation" }),
      "grok-4.6",
      "the legacy Cursor override is forbidden outside bounded validation"
    );
    await assert.rejects(
      store.beginAttempt(lease, run.run_id, {
        attempt_id: "legacy-grok-attempt-rejected",
        expected_run_version: run.row_version,
        stage: "validation",
        attempt_number: 1,
        role: "validation",
        provider: "cursor",
        model: "grok-4.6",
        nonce: "legacy-grok-nonce-rejected",
        head_sha: MERGED_ONE,
      }),
      /model violates manifest policy/
    );
    const attempt = await store.beginAttempt(lease, run.run_id, {
      attempt_id: "legacy-grok-attempt-current",
      expected_run_version: run.row_version,
      stage: "validation",
      attempt_number: 1,
      role: "validation",
      provider: "cursor",
      model,
      nonce: "legacy-grok-nonce-current",
      head_sha: MERGED_ONE,
    });
    assert.equal(attempt.model, "grok-4.7");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lane retirement waits for recurring dependent containment and is restart-persistent and idempotent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-retire-"));
  const filename = path.join(root, "state.db");
  let store = new SqliteLaneStateStore(filename);
  try {
    const lease = await activate(store);
    const l1 = await validatingRun(store, lease, "L1", MERGED_ONE);
    const sourceMerge = evidenceRef({
      id: "source-evidence-one",
      key: "source-key-one",
      locator: "gitlab:nomadhub/example:pipeline:100",
      laneId: "L1",
      runId: l1.run_id,
      sha: MERGED_ONE,
      kind: "merge_record",
      payload: { merged: true },
    });
    const sourceValidation = evidenceRef({
      id: "source-evidence-two",
      key: "source-key-two",
      locator: "gitlab:nomadhub/example:pipeline:100:checks",
      laneId: "L1",
      runId: l1.run_id,
      sha: MERGED_ONE,
      kind: "required_checks",
      payload: {
        all_green: true,
        missing_required_checks: [],
        nonpassing_required_checks: [],
      },
    });
    const sources = [sourceMerge, sourceValidation];
    const retire = await store.createControl({
      control_id: "retire-l1",
      idempotency_key: "retire-l1",
      kind: "lane_retire",
      lane_id: "L1",
      requested_by: "human:test",
      payload: {
        manifest_revision_id: "growth-safety",
        merged_sha: MERGED_ONE,
        evidence_refs: sources,
      },
      approvalKey: "human-key",
    });
    await assert.rejects(finish(store, lease, retire), /recurring dependent R1/);

    const holdDependent = await store.createControl({
      control_id: "hold-r1",
      idempotency_key: "hold-r1",
      kind: "lane_hold",
      lane_id: "R1",
      requested_by: "human:test",
      payload: { manifest_revision_id: "growth-safety", reason: "contain recurring work" },
    });
    await finish(store, lease, holdDependent);
    await finish(store, lease, retire);
    let snapshot = await store.snapshot();
    assert.equal(snapshot.runs.find((run) => run.lane_id === "L1")?.status, "validated");
    assert.equal(
      snapshot.lane_controls.find((control) => control.lane_id === "L1")?.state,
      "retired"
    );
    const retiredRunVersion = snapshot.runs.find(
      (run) => run.lane_id === "L1"
    )!.row_version;
    await store.close();
    store = new SqliteLaneStateStore(filename);
    const replayedRetire = await store.createControl({
      control_id: "ignored-replayed-retire-id",
      idempotency_key: "retire-l1",
      kind: "lane_retire",
      lane_id: "L1",
      requested_by: "human:test",
      payload: {
        manifest_revision_id: "growth-safety",
        merged_sha: MERGED_ONE,
        evidence_refs: sources,
      },
      approvalKey: "human-key",
    });
    assert.equal(replayedRetire.status, "applied");
    snapshot = await store.snapshot();
    assert.equal(
      snapshot.runs.find((run) => run.lane_id === "L1")!.row_version,
      retiredRunVersion
    );
    assert.equal(
      snapshot.events.filter((event) => event.event_type === "lane_retired").length,
      1
    );

    const l2 = await validatingRun(store, lease, "L2", MERGED_TWO);
    const replayMerge = evidenceRef({
      id: sourceMerge.evidence_id,
      key: sourceMerge.external_key,
      locator: "gitlab:nomadhub/example:pipeline:101",
      laneId: "L2",
      runId: l2.run_id,
      sha: MERGED_TWO,
      kind: "merge_record",
      payload: { merged: true },
    });
    const replayValidation = evidenceRef({
      id: sourceValidation.evidence_id,
      key: sourceValidation.external_key,
      locator: "gitlab:nomadhub/example:pipeline:101:checks",
      laneId: "L2",
      runId: l2.run_id,
      sha: MERGED_TWO,
      kind: "required_checks",
      payload: {
        all_green: true,
        missing_required_checks: [],
        nonpassing_required_checks: [],
      },
    });
    const replayControl = await store.createControl({
      control_id: "retire-l2-replay",
      idempotency_key: "retire-l2-replay",
      kind: "lane_retire",
      lane_id: "L2",
      requested_by: "human:test",
      payload: {
        manifest_revision_id: "growth-safety",
        merged_sha: MERGED_TWO,
        evidence_refs: [replayMerge, replayValidation],
      },
      approvalKey: "human-key",
    });
    await assert.rejects(
      finish(store, lease, replayControl),
      /evidence reference was already bound/
    );
    snapshot = await store.snapshot();
    assert.equal(snapshot.runs.find((run) => run.lane_id === "L2")?.status, "validating");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lane retirement rejects tampered hashes and cross-lane evidence identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-retire-tamper-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activate(store);
    const run = await validatingRun(store, lease, "L1", MERGED_ONE);
    const valid = evidenceRef({
      id: "tamper-source",
      key: "tamper-key",
      locator: "gitlab:nomadhub/example:pipeline:tamper",
      laneId: "L1",
      runId: run.run_id,
      sha: MERGED_ONE,
    });
    await assert.rejects(
      store.createControl({
        control_id: "retire-tampered-hash",
        idempotency_key: "retire-tampered-hash",
        kind: "lane_retire",
        lane_id: "L1",
        requested_by: "human:test",
        payload: {
          manifest_revision_id: "growth-safety",
          merged_sha: MERGED_ONE,
          evidence_refs: [{ ...valid, evidence_hash: "0".repeat(64) }],
        },
        approvalKey: "human-key",
      }),
      /immutable evidence id\/key\/hash triples/
    );
    const wrongIdentity = {
      ...valid,
      evidence_document: { ...valid.evidence_document, lane_id: "L2" },
    };
    wrongIdentity.evidence_hash = createHash("sha256")
      .update(canonicalManifestJson(wrongIdentity.evidence_document))
      .digest("hex");
    await assert.rejects(
      store.createControl({
        control_id: "retire-wrong-identity",
        idempotency_key: "retire-wrong-identity",
        kind: "lane_retire",
        lane_id: "L1",
        requested_by: "human:test",
        payload: {
          manifest_revision_id: "growth-safety",
          merged_sha: MERGED_ONE,
          evidence_refs: [wrongIdentity],
        },
        approvalKey: "human-key",
      }),
      /immutable evidence id\/key\/hash triples/
    );
    const futureEvidence = evidenceRef({
      id: "future-source",
      key: "future-key",
      locator: "gitlab:nomadhub/example:pipeline:future",
      laneId: "L1",
      runId: run.run_id,
      sha: MERGED_ONE,
    });
    futureEvidence.evidence_document.observed_at = "2999-01-01T00:00:00.000Z";
    futureEvidence.evidence_hash = createHash("sha256")
      .update(canonicalManifestJson(futureEvidence.evidence_document))
      .digest("hex");
    await assert.rejects(
      store.createControl({
        control_id: "retire-future-evidence",
        idempotency_key: "retire-future-evidence",
        kind: "lane_retire",
        lane_id: "L1",
        requested_by: "human:test",
        payload: {
          manifest_revision_id: "growth-safety",
          merged_sha: MERGED_ONE,
          evidence_refs: [futureEvidence],
        },
        approvalKey: "human-key",
      }),
      /immutable evidence id\/key\/hash triples/
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lane retirement and CLI semantics reject empty, merge-only, and failed validation evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-retire-semantics-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activate(store);
    const run = await validatingRun(store, lease, "L1", MERGED_ONE);
    const merge = evidenceRef({
      id: "semantic-merge",
      key: "semantic-merge",
      locator: "gitlab:nomadhub/example:merge:semantic",
      laneId: "L1",
      runId: run.run_id,
      sha: MERGED_ONE,
      kind: "merge_record",
      payload: { merged: true },
    });
    const failedValidation = evidenceRef({
      id: "semantic-failed-validation",
      key: "semantic-failed-validation",
      locator: "gitlab:nomadhub/example:pipeline:failed",
      laneId: "L1",
      runId: run.run_id,
      sha: MERGED_ONE,
      kind: "deterministic_validation",
      payload: { passed: false },
    });
    const failedReplay = evidenceRef({
      id: "semantic-failed-replay",
      key: "semantic-failed-replay",
      locator: "gitlab:nomadhub/example:replay:failed",
      laneId: "L1",
      runId: run.run_id,
      sha: MERGED_ONE,
      kind: "canonical_replay",
      payload: {
        verified: true,
        passed: false,
        receipt_summary: "validation failed",
      },
    });
    assert.equal(retirementEvidenceProvesCompletion([]), false);
    assert.equal(retirementEvidenceProvesCompletion([merge]), false);
    assert.equal(
      retirementEvidenceProvesCompletion([merge, failedValidation]),
      false
    );
    assert.equal(retirementEvidenceProvesCompletion([merge, failedReplay]), false);
    for (const [suffix, refs] of [
      ["empty", []],
      ["merge-only", [merge]],
      ["failed-validation", [merge, failedValidation]],
      ["failed-canonical-replay", [merge, failedReplay]],
    ] as const) {
      await assert.rejects(
        store.createControl({
          control_id: `retire-${suffix}`,
          idempotency_key: `retire-${suffix}`,
          kind: "lane_retire",
          lane_id: "L1",
          requested_by: "human:test",
          payload: {
            manifest_revision_id: "growth-safety",
            merged_sha: MERGED_ONE,
            evidence_refs: refs,
          },
          approvalKey: "human-key",
        }),
        suffix === "empty"
          ? /immutable evidence id\/key\/hash triples/
          : /successful merge record and validation receipt/
      );
    }
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("required-check allowlist ignores unrelated failures and is order-independent", () => {
  const checks = [
    { name: "scheduled-production-smoke", status: "failing" as const },
    { name: "second-required", status: "passing" as const },
    { name: "required-ci", status: "passing" as const },
  ];
  const first = requiredChecksGate(
    { checksStatus: "failing", checks },
    ["required-ci", "second-required"]
  );
  const reversed = requiredChecksGate(
    { checksStatus: "failing", checks: [...checks].reverse() },
    ["second-required", "required-ci"]
  );
  assert.equal(first.passing, true);
  assert.equal(reversed.passing, true);
  assert.deepEqual(first.missing, []);
  assert.deepEqual(reversed.notPassing, []);
});

test("stored merged-CI evidence accepts exact required checks order-independently and rejects forged names", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "merged-ci-evidence-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const lease = await activate(store);
    const run = await validatingRun(store, lease, "L1", MERGED_ONE);
    const accepted = await store.recordEvidence(lease, run.run_id, {
      evidence_id: "merged-ci-order-independent",
      external_key: "merged-ci:order-independent",
      expected_run_version: run.row_version,
      evidence_type: "merged_ci",
      repo_owner: run.repo_owner,
      repo_name: run.repo_name,
      head_sha: MERGED_ONE,
      evidence: {
        all_green: true,
        required_checks: ["second-required", "required-ci"],
        missing_required_checks: [],
        nonpassing_required_checks: [],
      },
    });
    assert.equal(accepted.accepted, true);

    const refreshed = (await store.snapshot()).runs.find(
      (candidate) => candidate.run_id === run.run_id
    )!;
    const forged = await store.recordEvidence(lease, run.run_id, {
      evidence_id: "merged-ci-forged-name",
      external_key: "merged-ci:forged-name",
      expected_run_version: refreshed.row_version,
      evidence_type: "merged_ci",
      repo_owner: run.repo_owner,
      repo_name: run.repo_name,
      head_sha: MERGED_ONE,
      evidence: {
        all_green: true,
        required_checks: ["second-required", "Required-CI"],
        missing_required_checks: [],
        nonpassing_required_checks: [],
      },
    });
    assert.equal(forged.accepted, false);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing required check never passes or becomes a failed repair signal", () => {
  const gate = requiredChecksGate(
    {
      checksStatus: "passing",
      checks: [{ name: "unrelated", status: "passing" }],
    },
    ["required-ci"]
  );
  assert.equal(gate.passing, false);
  assert.deepEqual(gate.missing, ["required-ci"]);
  assert.deepEqual(gate.failed, []);
  assert.deepEqual(gate.notPassing, []);
});

test("required-check names are exact and case-sensitive", () => {
  const gate = requiredChecksGate(
    {
      checksStatus: "passing",
      checks: [{ name: "Required-CI", status: "passing" }],
    },
    ["required-ci"]
  );
  assert.equal(gate.passing, false);
  assert.deepEqual(gate.missing, ["required-ci"]);
});

test("an empty required-check profile preserves a failing aggregate host gate", () => {
  const gate = requiredChecksGate(
    {
      checksStatus: "failing",
      checks: [{ name: "scheduled-smoke", status: "failing" }],
    },
    []
  );
  assert.equal(gate.passing, false);
  assert.deepEqual(gate.failed, []);
});

test("provider disable survives a lost finish response and restart without a second breaker write", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-control-restart-"));
  const filename = path.join(root, "state.db");
  let store = new SqliteLaneStateStore(filename);
  try {
    const lease = await activate(store);
    const control = await store.createControl({
      control_id: "disable-claude",
      idempotency_key: "disable-claude-once",
      kind: "provider_disable",
      requested_by: "human:test",
      payload: { provider: "claude" },
    });
    await store.finishControl(lease, control.control_id, {
      expected_version: control.row_version,
      expected_controller_version: (await store.snapshot()).controller!.row_version,
      status: "applied",
    });
    // Simulate the caller losing the HTTP response after the transaction
    // committed, then restarting with only its stable idempotency key.
    await store.close();
    store = new SqliteLaneStateStore(filename);
    const replay = await store.createControl({
      control_id: "different-id-is-ignored",
      idempotency_key: "disable-claude-once",
      kind: "provider_disable",
      requested_by: "human:test",
      payload: { provider: "claude" },
    });
    assert.equal(replay.status, "applied");
    const snapshot = await store.snapshot();
    const claude = snapshot.providers.find((provider) => provider.provider === "claude");
    assert.equal(claude?.state, "disabled");
    assert.equal(claude?.row_version, 1);
    assert.equal(
      snapshot.events.filter(
        (event) => event.event_type === "provider_breaker_changed"
      ).length,
      1
    );
    assert.equal(
      selectProvider({
        manifest: safetyManifest(),
        lane: safetyManifest().lanes[0],
        snapshot,
        role: "implementation",
      }),
      "codex"
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retirement evidence CLI rejects symlinks, non-files, and oversized packets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retirement-evidence-file-"));
  try {
    const evidence = path.join(root, "evidence.json");
    fs.writeFileSync(evidence, "[]");
    assert.deepEqual(readRetirementEvidenceFile(evidence), []);
    const symlink = path.join(root, "evidence-link.json");
    fs.symlinkSync(evidence, symlink);
    assert.throws(
      () => readRetirementEvidenceFile(symlink),
      /regular non-symlink file/
    );
    assert.throws(
      () => readRetirementEvidenceFile(root),
      /regular non-symlink file/
    );
    const oversized = path.join(root, "oversized.json");
    fs.writeFileSync(oversized, Buffer.alloc(MAX_RETIREMENT_EVIDENCE_BYTES + 1));
    assert.throws(
      () => readRetirementEvidenceFile(oversized),
      /exceeds the 1 MiB limit/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
