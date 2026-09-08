import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseLaneManifest,
  type LaneManifestV2,
  type ManifestProvider,
} from "../src/lanes/manifest.js";
import { SqliteLaneStateStore } from "../src/lanes/state-store-sqlite.js";
import {
  createLaneStateStore,
  LaneStateStoreError,
  type LaneAttemptRecord,
  type LaneLease,
  type LaneRunRecord,
} from "../src/lanes/state-store.js";
import {
  LANE_ACTION_SETTLE_SECONDS,
  LANE_LEASE_SECONDS,
  LANE_STANDBY_POLL_SECONDS,
} from "../src/lanes/controller-policy.js";

test("lease expiry plus standby polling meets the 120-second failover bound", () => {
  assert.ok(LANE_LEASE_SECONDS + LANE_STANDBY_POLL_SECONDS <= 120);
  assert.ok(LANE_ACTION_SETTLE_SECONDS >= LANE_LEASE_SECONDS);
});

function manifest(lanes = 10): LaneManifestV2 {
  return parseLaneManifest(
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
      lanes: Array.from({ length: lanes }, (_, index) => ({
        id: `L${index + 1}`,
        repository: { owner: "belongnet", name: "example", base_branch: "main" },
        prompt: { path: `L${index + 1}.md`, sha256: "a".repeat(64) },
        priority: 100 - index,
        preferred_providers: ["claude", "codex", "cursor"],
        fallback_providers: [],
        dependencies: [],
        policy: { kind: "one_shot" },
        delivery_adapter: { kind: "github" },
        merge_policy: {
          method: "squash",
          auto_merge: true,
          deploy_notes: "",
          replay_notes: "",
        },
        validation_profile: { commands: [["npm", "test"]], probes: [] },
        managed_tags: ["managed:growth", `lane:L${index + 1}`],
      })),
    },
    "/tmp/manifest.json",
    { verifyPrompts: false }
  );
}

async function setup(store: SqliteLaneStateStore): Promise<{
  lease: LaneLease;
  manifest: LaneManifestV2;
}> {
  const lease = await store.claimLease({
    ownerId: "mac:test",
    ownerSite: "mac",
    leaseSeconds: 75,
  });
  assert.ok(lease);
  const value = manifest();
  await store.stageManifest(lease, {
    revisionId: "growth-test",
    sourceRef: "test",
    manifest: value,
    createdBy: "test",
  });
  await store.activateManifest(lease, "growth-test", 1);
  return { lease, manifest: value };
}

async function createImplementingRun(
  store: SqliteLaneStateStore,
  lease: LaneLease,
  laneId: string,
  provider: ManifestProvider = "claude"
): Promise<LaneRunRecord> {
  let run = await store.createRun(lease, {
    run_id: `run-${laneId}`,
    manifest_revision_id: "growth-test",
    lane_id: laneId,
    generation: 1,
    priority: manifest().lanes.find((lane) => lane.id === laneId)!.priority,
  });
  run = await store.transitionRun(lease, run.run_id, {
    expected_version: run.row_version,
    from_status: "queued",
    to_status: "implementing",
    stage: "implementation",
    patch: {
      author_provider: provider,
      provider,
      model: manifest().global.provider_models[provider],
    },
  });
  return run;
}

async function recordApprovedAttestation(
  store: SqliteLaneStateStore,
  lease: LaneLease,
  attempt: LaneAttemptRecord,
  evidenceType: "adversarial_review" | "final_attestation"
): Promise<LaneRunRecord> {
  let run = (await store.snapshot()).runs.find(
    (candidate) => candidate.run_id === attempt.run_id
  )!;
  const tag = `[lane-attestation:${attempt.nonce}]`;
  const bodyHash = "a".repeat(64);
  const action = await store.beginAction(lease, run.run_id, {
    action_id: `publish-${attempt.attempt_id}`,
    deterministic_tag: `publish:${attempt.attempt_id}`,
    expected_run_version: run.row_version,
    stage: `${attempt.stage}-publish`,
    attempt_id: attempt.attempt_id,
    action_type: "post_attestation",
    request: {
      pr_url: run.pr_url,
      head_sha: run.head_sha,
      provider: attempt.provider,
      nonce: attempt.nonce,
      attestation_tag: tag,
      attestation_body_hash: bodyHash,
    },
  });
  run = (await store.snapshot()).runs.find(
    (candidate) => candidate.run_id === attempt.run_id
  )!;
  await store.finishAction(lease, action.action_id, {
    expected_action_version: action.row_version,
    expected_run_version: run.row_version,
    status: "succeeded",
    result: {
      posted: true,
      commit_sha: run.head_sha,
      attestation_tag: tag,
      attestation_body_hash: bodyHash,
      review_id: `review-${attempt.attempt_id}`,
    },
  });
  run = (await store.snapshot()).runs.find(
    (candidate) => candidate.run_id === attempt.run_id
  )!;
  const evidence = await store.recordEvidence(lease, run.run_id, {
    evidence_id: `evidence-${attempt.attempt_id}`,
    external_key: `review:${attempt.attempt_id}`,
    expected_run_version: run.row_version,
    attempt_id: attempt.attempt_id,
    evidence_type: evidenceType,
    provider: attempt.provider,
    nonce: attempt.nonce,
    repo_owner: run.repo_owner,
    repo_name: run.repo_name,
    head_sha: run.head_sha!,
    evidence: {
      verdict: "approve",
      nonce: attempt.nonce,
      run: run.run_id,
      stage: evidenceType === "adversarial_review" ? "review" : "final",
      head_sha: run.head_sha,
      provider: attempt.provider,
      attestation_body_hash: bodyHash,
    },
  });
  assert.equal(evidence.accepted, true);
  return (await store.snapshot()).runs.find(
    (candidate) => candidate.run_id === attempt.run_id
  )!;
}

test("state backend never silently falls back to SQLite", async () => {
  await assert.rejects(
    createLaneStateStore({}),
    /LANES_STATE_BACKEND must be explicitly set/
  );
  await assert.rejects(
    createLaneStateStore({ LANES_STATE_BACKEND: "http" }),
    /HTTP lane state requires/
  );
  await assert.rejects(
    createLaneStateStore({ LANES_STATE_BACKEND: "sqlite" }),
    /standalone\/test only/
  );
});

test("SQLite standalone enforces production evidence identifiers and SHA normalization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-store-identifiers-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const { lease } = await setup(store);
    const run = await createImplementingRun(store, lease, "L1");
    const base = {
      evidence_id: "evidence-workspace-state",
      expected_run_version: run.row_version,
      evidence_type: "workspace_state",
      repo_owner: run.repo_owner,
      repo_name: run.repo_name,
      head_sha: "A".repeat(40),
      evidence: { workspace_id: "workspace-one" },
    };
    await assert.rejects(
      store.recordEvidence(lease, run.run_id, {
        ...base,
        external_key: "unsafe evidence key",
      }),
      /external_key has an unsupported format/
    );
    const recorded = await store.recordEvidence(lease, run.run_id, {
      ...base,
      external_key: "workspace-state:workspace-one",
    });
    assert.equal(recorded.head_sha, "a".repeat(40));
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dual workers have one lease winner, monotonically fenced failover, and stale-writer rejection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-store-race-"));
  const filename = path.join(root, "state.db");
  const mac = new SqliteLaneStateStore(filename);
    const ovh = new SqliteLaneStateStore(filename);
    try {
    assert.equal(
      await ovh.claimLease({
        ownerId: "ovh-before-primary",
        ownerSite: "ovh",
        leaseSeconds: 75,
      }),
      null,
      "OVH standby must not bootstrap an empty lease"
    );
    const claims = await Promise.all([
      mac.claimLease({ ownerId: "mac", ownerSite: "mac", leaseSeconds: 75 }),
      ovh.claimLease({ ownerId: "ovh", ownerSite: "ovh", leaseSeconds: 75 }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.ok(claims[0], "the preferred Mac worker must establish the first fence");
    const winner = claims[0] ? mac : ovh;
    const standby = claims[0] ? ovh : mac;
    const first = claims[0] ?? claims[1]!;
    await winner.releaseLease(first);
    const second = await standby.claimLease({
      ownerId: "standby",
      ownerSite: claims[0] ? "ovh" : "mac",
      leaseSeconds: 75,
    });
    assert.ok(second);
    assert.equal(second.fence, first.fence + 1);
    await assert.rejects(
      winner.renewLease(first, {}, 75),
      (error: unknown) => error instanceof LaneStateStoreError && error.conflict
    );
  } finally {
    await mac.close();
    await ovh.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("notification claims are durably deduplicated across worker processes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-notification-"));
  const filename = path.join(root, "state.db");
  const firstStore = new SqliteLaneStateStore(filename);
  const restartedStore = new SqliteLaneStateStore(filename);
  try {
    const lease = await firstStore.claimLease({
      ownerId: "mac:notifications",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    const controllerVersion = (await firstStore.snapshot()).controller!.row_version;
    const first = await firstStore.claimNotification(lease, {
      notification_key: "daily:2026-09-04",
      message_hash: "a".repeat(64),
      expected_controller_version: controllerVersion,
    });
    const duplicate = await restartedStore.claimNotification(lease, {
      notification_key: "daily:2026-09-04",
      message_hash: "a".repeat(64),
      expected_controller_version: controllerVersion,
    });
    assert.equal(first.claimed, true);
    assert.equal(duplicate.claimed, false);
    const changedSummary = await restartedStore.claimNotification(lease, {
      notification_key: "daily:2026-09-04",
      message_hash: "b".repeat(64),
      expected_controller_version: controllerVersion,
    });
    assert.equal(changedSummary.claimed, false);
    assert.equal(changedSummary.message_hash, "a".repeat(64));
  } finally {
    await firstStore.close();
    await restartedStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("control requests reject unsupported kinds and incomplete durable targets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-control-validation-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const base = {
      requested_by: "operator:test",
    };
    await assert.rejects(
      store.createControl({
        ...base,
        control_id: "control-unsupported",
        idempotency_key: "control-unsupported",
        kind: "merge",
      }),
      /unsupported lane control kind/
    );
    await assert.rejects(
      store.createControl({
        ...base,
        control_id: "control-retry-no-lane",
        idempotency_key: "control-retry-no-lane",
        kind: "retry",
      }),
      /retry control requires lane_id/
    );
    await assert.rejects(
      store.createControl({
        ...base,
        control_id: "control-unknown-provider",
        idempotency_key: "control-unknown-provider",
        kind: "provider_disable",
        payload: { provider: "uncommissioned-provider" },
      }),
      /provider control requires claude, codex, or cursor/
    );
    await assert.rejects(
      store.createControl({
        ...base,
        control_id: "control-shadow-no-revision",
        idempotency_key: "control-shadow-no-revision",
        kind: "shadow",
      }),
      /control requires revision_id/
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resume cannot bypass cutover from shadow or rollback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-resume-boundary-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const { lease } = await setup(store);
    const apply = async (
      control: Awaited<ReturnType<SqliteLaneStateStore["createControl"]>>
    ) => {
      const snapshot = await store.snapshot();
      return store.finishControl(lease, control.control_id, {
        expected_version: control.row_version,
        expected_controller_version: snapshot.controller!.row_version,
        status: "applied",
      });
    };
    const shadow = await store.createControl({
      control_id: "control-shadow-boundary",
      idempotency_key: "control-shadow-boundary",
      kind: "shadow",
      requested_by: "telegram:test",
      payload: { revision_id: "growth-test" },
    });
    await apply(shadow);
    const shadowResume = await store.createControl({
      control_id: "control-shadow-resume",
      idempotency_key: "control-shadow-resume",
      kind: "resume",
      requested_by: "telegram:test",
    });
    await assert.rejects(apply(shadowResume), /shadow\/disabled requires cutover/);

    const cutover = await store.createControl({
      control_id: "control-boundary-cutover",
      idempotency_key: "control-boundary-cutover",
      kind: "cutover",
      requested_by: "telegram:test",
      payload: { revision_id: "growth-test" },
      approvalKey: "human-key",
    });
    await apply(cutover);
    const pause = await store.createControl({
      control_id: "control-boundary-pause",
      idempotency_key: "control-boundary-pause",
      kind: "pause",
      requested_by: "telegram:test",
    });
    await apply(pause);
    const resume = await store.createControl({
      control_id: "control-boundary-resume",
      idempotency_key: "control-boundary-resume",
      kind: "resume",
      requested_by: "telegram:test",
    });
    await apply(resume);
    assert.equal((await store.snapshot()).controller?.mode, "active");

    const rollback = await store.createControl({
      control_id: "control-boundary-rollback",
      idempotency_key: "control-boundary-rollback",
      kind: "rollback",
      requested_by: "telegram:test",
      approvalKey: "human-key",
    });
    await apply(rollback);
    const rollbackResume = await store.createControl({
      control_id: "control-rollback-resume",
      idempotency_key: "control-rollback-resume",
      kind: "resume",
      requested_by: "telegram:test",
    });
    await assert.rejects(
      apply(rollbackResume),
      /shadow\/disabled requires cutover/
    );
    assert.equal((await store.snapshot()).controller?.mode, "disabled");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manifest activation rejects a stale target version before retiring the active revision", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-manifest-cas-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const { lease } = await setup(store);
    const staged = await store.stageManifest(lease, {
      revisionId: "growth-next",
      sourceRef: "test:next",
      manifest: manifest(9),
      createdBy: "test",
    });
    await assert.rejects(
      store.activateManifest(
        lease,
        "growth-next",
        Number(staged.row_version) + 1
      ),
      /manifest row version changed/
    );
    assert.equal((await store.snapshot()).manifest?.revision_id, "growth-test");
    await store.activateManifest(
      lease,
      "growth-next",
      Number(staged.row_version)
    );
    assert.equal((await store.snapshot()).manifest?.revision_id, "growth-next");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manifest activation cannot switch policy underneath a nonterminal run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-manifest-live-run-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const { lease } = await setup(store);
    await store.createRun(lease, {
      run_id: "run-live-revision",
      manifest_revision_id: "growth-test",
      lane_id: "L1",
      generation: 1,
      priority: 100,
    });
    const staged = await store.stageManifest(lease, {
      revisionId: "growth-next-live",
      sourceRef: "test:next-live",
      manifest: manifest(9),
      createdBy: "test",
    });
    await assert.rejects(
      store.activateManifest(
        lease,
        "growth-next-live",
        Number(staged.row_version)
      ),
      /cannot activate manifest while run run-live-revision uses growth-test/
    );
    assert.equal((await store.snapshot()).manifest?.revision_id, "growth-test");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an in-flight success does not erase an unexpired provider breaker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-provider-breaker-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const { lease } = await setup(store);
    const opened = await store.recordProviderHealth(lease, {
      expected_version: 0,
      provider: "codex",
      outcome: "quota_failure",
      error_code: "quota",
    });
    assert.equal(opened.state, "open");
    const stillOpen = await store.recordProviderHealth(lease, {
      expected_version: Number(opened.row_version),
      provider: "codex",
      outcome: "success",
    });
    assert.equal(stillOpen.state, "open");
    assert.equal(stillOpen.breaker_until, opened.breaker_until);
    const enabled = await store.recordProviderHealth(lease, {
      expected_version: Number(stillOpen.row_version),
      provider: "codex",
      outcome: "enable",
    });
    assert.equal(enabled.state, "healthy");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capacity is reserved atomically and one active attempt wins per stage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-store-cap-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const { lease, manifest: value } = await setup(store);
    for (let index = 1; index <= 3; index += 1) {
      const run = await createImplementingRun(store, lease, `L${index}`);
      await store.beginAttempt(lease, run.run_id, {
        attempt_id: `attempt-${index}`,
        expected_run_version: run.row_version,
        stage: "implementation",
        attempt_number: 1,
        role: "implementation",
        provider: "claude",
        model: value.global.provider_models.claude,
        nonce: `nonce-${index}`,
      });
    }
    const fourth = await createImplementingRun(store, lease, "L4");
    await assert.rejects(
      store.beginAttempt(lease, fourth.run_id, {
        attempt_id: "attempt-4",
        expected_run_version: fourth.row_version,
        stage: "implementation",
        attempt_number: 1,
        role: "implementation",
        provider: "claude",
        model: value.global.provider_models.claude,
        nonce: "nonce-4",
      }),
      /capacity is exhausted/
    );
    const snapshot = await store.snapshot();
    assert.deepEqual(snapshot.capacity.claude, { active: 3, limit: 3 });
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("state rejects mismatched PR, stage, head, terminal reopen, and unsafe workspace clear", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-store-bindings-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const { lease, manifest: value } = await setup(store);
    await assert.rejects(
      store.createRun(lease, {
        run_id: "run-wrong-priority",
        manifest_revision_id: "growth-test",
        lane_id: "L1",
        generation: 1,
        priority: 99,
      }),
      /priority must match/
    );
    let run = await createImplementingRun(store, lease, "L1");
    await assert.rejects(
      store.transitionRun(lease, run.run_id, {
        expected_version: run.row_version,
        from_status: "implementing",
        to_status: "pr_bound",
        stage: "pr",
        patch: {
          pr_number: 7,
          pr_url: "https://github.com/other/example/pull/7",
          head_branch: "managed/L1",
          head_sha: "1".repeat(40),
        },
      }),
      /manifest repository binding/
    );
    await assert.rejects(
      store.transitionRun(lease, run.run_id, {
        expected_version: run.row_version,
        from_status: "implementing",
        to_status: "pr_bound",
        stage: "pr",
        patch: {
          pr_number: 7,
          pr_url: "https://github.com/belongnet/example/pull/7",
          head_branch: "managed/L1",
          head_sha: "1".repeat(41),
        },
      }),
      /full Git object ID|manifest repository binding/
    );
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "implementing",
      to_status: "pr_bound",
      stage: "pr",
      patch: {
        pr_number: 7,
        pr_url: "https://github.com/belongnet/example/pull/7",
        head_branch: "managed/L1",
        head_sha: "1".repeat(40),
      },
    });
    await assert.rejects(
      store.transitionRun(lease, run.run_id, {
        expected_version: run.row_version,
        from_status: "pr_bound",
        to_status: "pr_bound",
        stage: "pr",
        patch: { head_branch: "managed/someone-else" },
      }),
      /head branch is immutable/
    );
    await assert.rejects(
      store.beginAttempt(lease, run.run_id, {
        attempt_id: "review-too-early",
        expected_run_version: run.row_version,
        stage: "review",
        attempt_number: 1,
        role: "review",
        provider: "codex",
        model: value.global.provider_models.codex,
        nonce: "review-too-early",
        head_sha: "1".repeat(40),
      }),
      /role\/stage/
    );
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "pr_bound",
      to_status: "reviewing",
      stage: "review",
    });
    await assert.rejects(
      store.beginAttempt(lease, run.run_id, {
        attempt_id: "review-stale",
        expected_run_version: run.row_version,
        stage: "review",
        attempt_number: 1,
        role: "review",
        provider: "codex",
        model: value.global.provider_models.codex,
        nonce: "review-stale",
        head_sha: "2".repeat(40),
      }),
      /current PR head/
    );
    let attempt = await store.beginAttempt(lease, run.run_id, {
      attempt_id: "review-bound",
      expected_run_version: run.row_version,
      stage: "review",
      attempt_number: 1,
      role: "review",
      provider: "codex",
      model: value.global.provider_models.codex,
      nonce: "review-bound",
      head_sha: "1".repeat(40),
      workspace_id: "workspace-review",
      session_id: "session-review",
    });
    run = (await store.snapshot()).runs.find((entry) => entry.run_id === run.run_id)!;
    attempt = await store.updateAttempt(lease, attempt.attempt_id, {
      expected_attempt_version: attempt.row_version,
      expected_run_version: run.row_version,
      status: "completed",
      result: { verdict: "approve" },
    });
    run = (await store.snapshot()).runs.find((entry) => entry.run_id === run.run_id)!;
    await assert.rejects(
      store.updateAttempt(lease, attempt.attempt_id, {
        expected_attempt_version: attempt.row_version,
        expected_run_version: run.row_version,
        status: "working",
      }),
      /completed -> working/
    );

    let workspaceRun = await createImplementingRun(store, lease, "L2");
    workspaceRun = await store.transitionRun(lease, workspaceRun.run_id, {
      expected_version: workspaceRun.row_version,
      from_status: "implementing",
      to_status: "implementing",
      stage: "implementation",
      patch: { workspace_id: "workspace-bound", workspace_name: "managed" },
    });
    await assert.rejects(
      store.transitionRun(lease, workspaceRun.run_id, {
        expected_version: workspaceRun.row_version,
        from_status: "implementing",
        to_status: "implementing",
        stage: "implementation",
        patch: { workspace_id: null, workspace_name: null },
      }),
      /accepted unusable-state evidence/
    );
    await store.recordEvidence(lease, workspaceRun.run_id, {
      evidence_id: "workspace-unusable",
      external_key: "workspace-unusable",
      expected_run_version: workspaceRun.row_version,
      evidence_type: "workspace_state",
      repo_owner: workspaceRun.repo_owner,
      repo_name: workspaceRun.repo_name,
      head_sha: "0".repeat(40),
      evidence: {
        workspace_id: "workspace-bound",
        unusable: true,
        working_session: false,
      },
    });
    workspaceRun = (await store.snapshot()).runs.find(
      (entry) => entry.run_id === workspaceRun.run_id
    )!;
    workspaceRun = await store.transitionRun(lease, workspaceRun.run_id, {
      expected_version: workspaceRun.row_version,
      from_status: "implementing",
      to_status: "implementing",
      stage: "implementation",
      patch: { workspace_id: null, workspace_name: null },
    });
    assert.equal(workspaceRun.workspace_id, null);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("post-merge repair is the only PR-clear path and late stages may quarantine", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-store-repair-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const { lease } = await setup(store);
    let run = await store.createRun(lease, {
      run_id: "run-repair",
      manifest_revision_id: "growth-test",
      lane_id: "L1",
      generation: 1,
      priority: 100,
      metadata: { legacy_git_verified: true },
      legacy_verified: true,
    });
    const binding = {
      pr_number: 17,
      pr_url: "https://github.com/belongnet/example/pull/17",
      head_branch: "managed/repair",
      head_sha: "1".repeat(40),
      merged_sha: "2".repeat(40),
    };
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "queued",
      to_status: "validating",
      stage: "validation",
      patch: binding,
    });
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "validating",
      to_status: "quarantined",
      stage: "validation",
    });
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "quarantined",
      to_status: "queued",
      stage: "queued",
    });
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "queued",
      to_status: "validating",
      stage: "validation",
    });
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "validating",
      to_status: "rework",
      stage: "repair",
    });

    const clearPatch = {
      pr_number: null,
      pr_url: null,
      head_branch: null,
      head_sha: null,
      merged_sha: null,
    };
    await assert.rejects(
      store.transitionRun(lease, run.run_id, {
        expected_version: run.row_version,
        from_status: "rework",
        to_status: "implementing",
        stage: "implementation",
        patch: {
          ...clearPatch,
          author_provider: "claude",
          provider: "claude",
          model: "fable-5-1",
        },
      }),
      /proven post-merge repair/
    );

    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "rework",
      to_status: "quarantined",
      stage: "repair",
    });
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "quarantined",
      to_status: "queued",
      stage: "queued",
    });
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "queued",
      to_status: "validating",
      stage: "validation",
    });
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "validating",
      to_status: "rework",
      stage: "repair",
    });
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "rework",
      to_status: "implementing",
      stage: "implementation",
      patch: {
        ...clearPatch,
        author_provider: "claude",
        provider: "claude",
        model: "fable-5-1",
        metadata: {
          ...run.metadata_json,
          repair_from_merged_sha: "2".repeat(40),
        },
      },
    });
    assert.equal(run.pr_url, null);
    assert.equal(run.head_sha, null);
    assert.equal(run.merged_sha, null);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous external actions block retries until authoritative reconciliation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-store-ambiguous-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const { lease, manifest: value } = await setup(store);
    let run = await createImplementingRun(store, lease, "L1");
    const attempt = await store.beginAttempt(lease, run.run_id, {
      attempt_id: "attempt-action-one",
      expected_run_version: run.row_version,
      stage: "implementation",
      attempt_number: 1,
      role: "implementation",
      provider: "claude",
      model: value.global.provider_models.claude,
      nonce: "nonce-action-one",
    });
    run = (await store.snapshot()).runs[0];
    const request = {
      project_id: "project-one",
      base_branch: "main",
      workspace_name:
        "[managed:growth][lane:L1][run:run-L1][stage:implementation][attempt:1]",
      session_name:
        "[managed:growth][lane:L1][run:run-L1][stage:implementation][attempt:1][provider:claude]",
      provider: "claude",
      model: value.global.provider_models.claude,
    };
    const action = await store.beginAction(lease, run.run_id, {
      action_id: "action-one",
      deterministic_tag: "run-L1:implementation:create:v2",
      expected_run_version: run.row_version,
      stage: "implementation-workspace",
      attempt_id: attempt.attempt_id,
      action_type: "create_workspace",
      request,
    });
    run = (await store.snapshot()).runs[0];
    const ambiguous = await store.finishAction(lease, action.action_id, {
      expected_action_version: action.row_version,
      expected_run_version: run.row_version,
      status: "ambiguous",
      error: "lost response",
    });
    run = (await store.snapshot()).runs[0];
    await assert.rejects(
      store.beginAction(lease, run.run_id, {
        action_id: "action-two",
        deterministic_tag: "run-L1:implementation:create:v4",
        expected_run_version: run.row_version,
        stage: "implementation-workspace",
        attempt_id: attempt.attempt_id,
        action_type: "create_workspace",
        request,
      }),
      /ambiguous action/
    );
    await store.finishAction(lease, ambiguous.action_id, {
      expected_action_version: ambiguous.row_version,
      expected_run_version: run.row_version,
      status: "failed",
      result: { reconciled: true, found: false },
      error: "authoritative absence",
    });
    run = (await store.snapshot()).runs[0];
    const retry = await store.beginAction(lease, run.run_id, {
      action_id: "action-two",
      deterministic_tag: "run-L1:implementation:create:v5",
      expected_run_version: run.row_version,
      stage: "implementation-workspace",
      attempt_id: attempt.attempt_id,
      action_type: "create_workspace",
      request,
    });
    assert.equal(retry.status, "pending");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite standalone archive policy requires an exact unexpired human batch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-store-archive-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const { lease } = await setup(store);
    let run = await createImplementingRun(store, lease, "L1");
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "implementing",
      to_status: "failed",
      stage: "terminal",
      patch: {
        workspace_id: "workspace-untagged",
        workspace_name: "legacy workspace without managed tags",
      },
    });
    await store.recordEvidence(lease, run.run_id, {
      evidence_id: "evidence-archive-ready",
      external_key: "workspace-archive-ready",
      expected_run_version: run.row_version,
      evidence_type: "workspace_state",
      repo_owner: run.repo_owner,
      repo_name: run.repo_name,
      head_sha: "0".repeat(40),
      evidence: {
        workspace_id: "workspace-untagged",
        working_session: false,
        grace_period_elapsed: true,
      },
    });
    run = (await store.snapshot()).runs.find(
      (candidate) => candidate.run_id === run.run_id
    )!;
    await assert.rejects(
      store.beginAction(lease, run.run_id, {
        action_id: "archive-wrong-target",
        deterministic_tag: "archive-wrong-target",
        expected_run_version: run.row_version,
        stage: "hygiene",
        action_type: "archive_workspace",
        request: { workspace_id: "workspace-someone-else" },
      }),
      /archive target does not match/
    );
    await assert.rejects(
      store.beginAction(lease, run.run_id, {
        action_id: "archive-without-approval",
        deterministic_tag: "archive-without-approval",
        expected_run_version: run.row_version,
        stage: "hygiene",
        action_type: "archive_workspace",
        request: { workspace_id: "workspace-untagged" },
      }),
      /untagged workspace needs archive approval/
    );

    await assert.rejects(
      store.createControl({
        control_id: "archive-lane-only-control",
        idempotency_key: "archive-lane-only-control",
        kind: "archive_approval",
        lane_id: "L1",
        requested_by: "telegram:test",
        payload: {
          workspace_ids: [],
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        approvalKey: "separate-human-key",
      }),
      /exact workspace_ids/
    );

    const wrongWorkspaceControl = await store.createControl({
      control_id: "archive-wrong-workspace-control",
      idempotency_key: "archive-wrong-workspace-control",
      kind: "archive_approval",
      lane_id: "L1",
      requested_by: "telegram:test",
      payload: {
        workspace_ids: ["workspace-someone-else"],
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      approvalKey: "separate-human-key",
    });
    let snapshot = await store.snapshot();
    await store.finishControl(lease, wrongWorkspaceControl.control_id, {
      expected_version: wrongWorkspaceControl.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
    });
    run = (await store.snapshot()).runs.find(
      (candidate) => candidate.run_id === run.run_id
    )!;
    await assert.rejects(
      store.beginAction(lease, run.run_id, {
        action_id: "archive-after-wrong-approval",
        deterministic_tag: "archive-after-wrong-approval",
        expected_run_version: run.row_version,
        stage: "hygiene",
        action_type: "archive_workspace",
        request: { workspace_id: "workspace-untagged" },
      }),
      /untagged workspace needs archive approval/
    );

    const control = await store.createControl({
      control_id: "archive-batch-control",
      idempotency_key: "archive-batch-control",
      kind: "archive_approval",
      requested_by: "telegram:test",
      payload: {
        workspace_ids: ["workspace-untagged"],
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      approvalKey: "separate-human-key",
    });
    snapshot = await store.snapshot();
    await store.finishControl(lease, control.control_id, {
      expected_version: control.row_version,
      expected_controller_version: snapshot.controller!.row_version,
      status: "applied",
    });
    run = (await store.snapshot()).runs.find(
      (candidate) => candidate.run_id === run.run_id
    )!;
    const action = await store.beginAction(lease, run.run_id, {
      action_id: "archive-with-approval",
      deterministic_tag: "archive-with-approval",
      expected_run_version: run.row_version,
      stage: "hygiene",
      action_type: "archive_workspace",
      request: { workspace_id: "workspace-untagged" },
    });
    assert.equal(action.status, "pending");
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("terminal bookkeeping preserves the original grace-period timestamp", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-terminal-time-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const { lease } = await setup(store);
    let run = await createImplementingRun(store, lease, "L1");
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "implementing",
      to_status: "failed",
      stage: "terminal",
    });
    const terminalAt = run.terminal_at;
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "failed",
      to_status: "failed",
      stage: "terminal",
      patch: { metadata: { bookkeeping: true } },
    });
    assert.equal(run.terminal_at, terminalAt);
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed final provider may retry, but an accepted final provider may not duplicate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-final-retry-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  try {
    const { lease, manifest: value } = await setup(store);
    let run = await createImplementingRun(store, lease, "L1");
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "implementing",
      to_status: "pr_bound",
      stage: "pr",
      patch: {
        pr_number: 7,
        pr_url: "https://github.com/belongnet/example/pull/7",
        head_branch: "managed/L1",
        head_sha: "1".repeat(40),
      },
    });
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "pr_bound",
      to_status: "reviewing",
      stage: "review",
    });
    let review = await store.beginAttempt(lease, run.run_id, {
      attempt_id: "review-final-retry",
      expected_run_version: run.row_version,
      stage: "review",
      attempt_number: 1,
      role: "review",
      provider: "codex",
      model: value.global.provider_models.codex,
      nonce: "review-final-retry",
      head_sha: run.head_sha!,
    });
    run = await recordApprovedAttestation(
      store,
      lease,
      review,
      "adversarial_review"
    );
    review = (await store.snapshot()).attempts.find(
      (candidate) => candidate.attempt_id === review.attempt_id
    )!;
    await store.updateAttempt(lease, review.attempt_id, {
      expected_attempt_version: review.row_version,
      expected_run_version: run.row_version,
      status: "completed",
      result: { verdict: "approve" },
    });
    run = (await store.snapshot()).runs.find(
      (candidate) => candidate.run_id === run.run_id
    )!;
    run = await store.transitionRun(lease, run.run_id, {
      expected_version: run.row_version,
      from_status: "reviewing",
      to_status: "finals",
      stage: "finals",
    });

    let failed = await store.beginAttempt(lease, run.run_id, {
      attempt_id: "final-failed",
      expected_run_version: run.row_version,
      stage: "final-1",
      attempt_number: 1,
      role: "final",
      provider: "codex",
      model: value.global.provider_models.codex,
      nonce: "final-failed",
      head_sha: run.head_sha!,
    });
    run = (await store.snapshot()).runs.find(
      (candidate) => candidate.run_id === run.run_id
    )!;
    await store.updateAttempt(lease, failed.attempt_id, {
      expected_attempt_version: failed.row_version,
      expected_run_version: run.row_version,
      status: "failed",
      result: { provider_failure: "transient_failure" },
    });
    run = (await store.snapshot()).runs.find(
      (candidate) => candidate.run_id === run.run_id
    )!;
    let retried = await store.beginAttempt(lease, run.run_id, {
      attempt_id: "final-retried",
      expected_run_version: run.row_version,
      stage: "final-2",
      attempt_number: 2,
      role: "final",
      provider: "codex",
      model: value.global.provider_models.codex,
      nonce: "final-retried",
      head_sha: run.head_sha!,
    });
    assert.equal(retried.provider, "codex");
    run = (await store.snapshot()).runs.find(
      (candidate) => candidate.run_id === run.run_id
    )!;
    await assert.rejects(
      store.beginAttempt(lease, run.run_id, {
        attempt_id: "final-concurrent-same-provider",
        expected_run_version: run.row_version,
        stage: "final-3",
        attempt_number: 3,
        role: "final",
        provider: "codex",
        model: value.global.provider_models.codex,
        nonce: "final-concurrent-same-provider",
        head_sha: run.head_sha!,
      }),
      /final providers must be distinct/
    );
    run = await recordApprovedAttestation(
      store,
      lease,
      retried,
      "final_attestation"
    );
    retried = (await store.snapshot()).attempts.find(
      (candidate) => candidate.attempt_id === retried.attempt_id
    )!;
    await store.updateAttempt(lease, retried.attempt_id, {
      expected_attempt_version: retried.row_version,
      expected_run_version: run.row_version,
      status: "completed",
      result: { verdict: "approve" },
    });
    run = (await store.snapshot()).runs.find(
      (candidate) => candidate.run_id === run.run_id
    )!;
    await assert.rejects(
      store.beginAttempt(lease, run.run_id, {
        attempt_id: "final-duplicate-accepted-provider",
        expected_run_version: run.row_version,
        stage: "final-3",
        attempt_number: 3,
        role: "final",
        provider: "codex",
        model: value.global.provider_models.codex,
        nonce: "final-duplicate-accepted-provider",
        head_sha: run.head_sha!,
      }),
      /final providers must be distinct/
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("seeded dual-worker crash simulation preserves one winner, one stage attempt, and 3/2/2", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-store-simulator-"));
  try {
    for (let seed = 1; seed <= 12; seed += 1) {
      const filename = path.join(root, `state-${seed}.db`);
      const mac = new SqliteLaneStateStore(filename);
      const ovh = new SqliteLaneStateStore(filename);
      try {
        const claims = await Promise.all([
          mac.claimLease({ ownerId: `mac-${seed}`, ownerSite: "mac", leaseSeconds: 75 }),
          ovh.claimLease({ ownerId: `ovh-${seed}`, ownerSite: "ovh", leaseSeconds: 75 }),
        ]);
        assert.equal(claims.filter(Boolean).length, 1, `seed ${seed}: exactly one lease winner`);
        const store = claims[0] ? mac : ovh;
        const standby = claims[0] ? ovh : mac;
        const lease = claims[0] ?? claims[1]!;
        const value = manifest();
        await store.stageManifest(lease, {
          revisionId: "growth-test",
          sourceRef: `simulator:${seed}`,
          manifest: value,
          createdBy: "simulator",
        });
        await store.activateManifest(lease, "growth-test", 1);
        const firstRun = await createImplementingRun(store, lease, "L1", "claude");
        const competing = await Promise.allSettled(
          ["attempt-a", "attempt-b"].map((attemptId) =>
            store.beginAttempt(lease, firstRun.run_id, {
              attempt_id: `${attemptId}-${seed}`,
              expected_run_version: firstRun.row_version,
              stage: "implementation",
              attempt_number: attemptId === "attempt-a" ? 1 : 2,
              role: "implementation",
              provider: "claude",
              model: value.global.provider_models.claude,
              nonce: `${attemptId}-nonce-${seed}`,
            })
          )
        );
        assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);

        let currentSnapshot = await store.snapshot();
        let current = currentSnapshot.runs.find(
          (run) => run.run_id === firstRun.run_id
        )!;
        const activeAttempt = currentSnapshot.attempts.find(
          (attempt) =>
            attempt.run_id === firstRun.run_id &&
            ["commissioned", "working", "awaiting_result"].includes(
              attempt.status
            )
        )!;
        const actionInput = {
          action_id: `action-${seed}`,
          deterministic_tag: `run-L1:implementation:create:${seed}`,
          expected_run_version: current.row_version,
          stage: "implementation-workspace",
          attempt_id: activeAttempt.attempt_id,
          action_type: "create_workspace",
          request: {
            project_id: "project-one",
            base_branch: "main",
            workspace_name:
              `[managed:growth][lane:L1][run:run-L1]` +
              `[stage:implementation][attempt:${activeAttempt.attempt_number}]`,
            session_name:
              `[managed:growth][lane:L1][run:run-L1]` +
              `[stage:implementation][attempt:${activeAttempt.attempt_number}]` +
              `[provider:${activeAttempt.provider}]`,
            provider: activeAttempt.provider,
            model: activeAttempt.model,
          },
        };
        const duplicateReceipts = await Promise.all([
          store.beginAction(lease, current.run_id, actionInput),
          store.beginAction(lease, current.run_id, actionInput),
        ]);
        assert.equal(duplicateReceipts[0].action_id, duplicateReceipts[1].action_id);

        const providers: ManifestProvider[] = [
          "claude",
          "claude",
          "codex",
          "codex",
          "cursor",
          "cursor",
        ];
        // A tiny deterministic shuffle varies response order without making the
        // regression non-reproducible.
        let state = seed;
        const random = () => {
          state = (state * 1664525 + 1013904223) >>> 0;
          return state / 2 ** 32;
        };
        providers.sort(() => random() - 0.5);
        for (const [index, provider] of providers.entries()) {
          const laneId = `L${index + 2}`;
          const run = await createImplementingRun(store, lease, laneId, provider);
          try {
            await store.beginAttempt(lease, run.run_id, {
              attempt_id: `attempt-${seed}-${laneId}`,
              expected_run_version: run.row_version,
              stage: "implementation",
              attempt_number: 1,
              role: "implementation",
              provider,
              model: value.global.provider_models[provider],
              nonce: `nonce-${seed}-${laneId}`,
            });
          } catch (error) {
            assert.match(String(error), /capacity is exhausted/);
          }
        }
        const snapshot = await store.snapshot();
        assert.ok(snapshot.capacity.claude.active <= 3);
        assert.ok(snapshot.capacity.codex.active <= 2);
        assert.ok(snapshot.capacity.cursor.active <= 2);
        const attemptKeys = snapshot.attempts
          .filter((attempt) => ["commissioned", "working", "awaiting_result"].includes(attempt.status))
          .map((attempt) => `${attempt.run_id}:${attempt.stage}`);
        assert.equal(new Set(attemptKeys).size, attemptKeys.length);
        assert.equal(
          snapshot.pending_actions.filter((action) => action.deterministic_tag === actionInput.deterministic_tag).length,
          1
        );

        await store.releaseLease(lease);
        const takeover = await standby.claimLease({
          ownerId: `takeover-${seed}`,
          ownerSite: claims[0] ? "ovh" : "mac",
          leaseSeconds: 75,
        });
        assert.ok(takeover);
        assert.equal(takeover.fence, lease.fence + 1);
        current = (await standby.snapshot()).runs.find((run) => run.run_id === firstRun.run_id)!;
        await assert.rejects(
          store.transitionRun(lease, current.run_id, {
            expected_version: current.row_version,
            from_status: current.status,
            to_status: current.status,
            stage: current.stage,
            patch: {},
          }),
          (error: unknown) => error instanceof LaneStateStoreError && error.conflict
        );
      } finally {
        await mac.close();
        await ovh.close();
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
