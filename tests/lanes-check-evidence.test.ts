import test from "node:test";
import assert from "node:assert/strict";
import { commitChecksSnapshot } from "../src/bot/github.js";
import {
  buildCheckEvidence,
  canonicalEvidenceIdentity,
  githubCheckObservation,
  githubPipelineId,
  validPipelineId,
  type CheckObservation,
} from "../src/lanes/check-evidence.js";
import { parseLaneManifest, type ManifestLane } from "../src/lanes/manifest.js";
import { checkEvidenceAccepted } from "../src/lanes/state-store-sqlite.js";
import type { LaneRunRecord } from "../src/lanes/state-store.js";

const HEAD = "8".repeat(40);
const MERGED = "9".repeat(40);
const RUN = {
  repo_owner: "belongnet",
  repo_name: "Example",
  base_branch: "main",
} as LaneRunRecord;
const GITLAB_CANONICAL = {
  kind: "github",
  canonical_evidence: { kind: "gitlab", project_path: "nomadhub/mvp", base_branch: "dev" },
};

function laneWith(delivery: Record<string, unknown>): ManifestLane {
  return parseLaneManifest(
    {
      version: 2,
      global: {
        provider_capacity: { claude: 3, codex: 2, cursor: 2 },
        provider_models: { claude: "fable-5-1", codex: "gpt-6-astra", cursor: "grok-4.7" },
      },
      lanes: [
        {
          id: "L1",
          repository: { owner: "belongnet", name: "example", base_branch: "main" },
          prompt: { path: "L1.md", sha256: "a".repeat(64) },
          priority: 100,
          preferred_providers: ["claude", "codex", "cursor"],
          fallback_providers: [],
          dependencies: [],
          policy: { kind: "one_shot" },
          delivery_adapter: delivery,
          merge_policy: { method: "squash", auto_merge: true, deploy_notes: "", replay_notes: "" },
          validation_profile: { commands: [["npm", "test"]], probes: [] },
          managed_tags: ["managed:growth", "lane:L1"],
        },
      ],
    },
    "/tmp/lanes-check-evidence.json",
    { verifyPrompts: false }
  ).lanes[0]!;
}

function gitlabPipeline(overrides: Partial<CheckObservation> = {}): CheckObservation {
  return {
    source: "gitlab",
    projectPath: "nomadhub/mvp",
    sha: MERGED,
    pipelineId: 821,
    status: "passing",
    summary: "GitLab pipeline 821 success",
    checks: [],
    ...overrides,
  };
}

test("canonical identity defaults to the delivery host and the run's repository", () => {
  assert.deepEqual(canonicalEvidenceIdentity(laneWith({ kind: "github" }), RUN), {
    kind: "github",
    projectPath: "belongnet/example",
    baseBranch: "main",
  });
  assert.deepEqual(canonicalEvidenceIdentity(laneWith(GITLAB_CANONICAL), RUN), {
    kind: "gitlab",
    projectPath: "nomadhub/mvp",
    baseBranch: "dev",
  });
});

// Extended by /ship coverage audit with single-field forgeries of the receipt and the pipeline a lane without named checks names.
// Value: protects=every field of Command Center's exact receipt is load-bearing: host, base branch, commit and each check's success;
//   fails_when=a conjunct drops out of checkEvidenceAccepted, or a GitHub observation without named checks stops naming every run and status;
//   why_new=the forgeries here change only pipeline_id, receipt commit and receipt order; source, base_branch, commit_sha, status were unasserted; seam=none
test("GitHub named checks produce Command Center's exact pre-merge receipt", () => {
  const lane = laneWith({
    kind: "github",
    required_checks: ["gitlab/lint-and-test"],
    check_allowlist: ["gitlab/lint-and-test"],
  });
  const snapshot = commitChecksSnapshot(
    { repoOwner: "belongnet", repoName: "example", sha: HEAD },
    [{ id: 11, name: "preview", status: "completed", conclusion: "failure" }],
    [{ id: 81, context: "gitlab/lint-and-test", state: "success" }]
  );
  const observation = githubCheckObservation(snapshot, ["gitlab/lint-and-test"]);
  assert.equal(observation.pipelineId, "github-status-81");
  assert.equal(
    githubCheckObservation(snapshot, []).pipelineId,
    "github-check-run-11+github-status-81",
    "without named checks every run and status behind the result names the pipeline"
  );
  const evidence = buildCheckEvidence({ lane, run: RUN, sha: HEAD, observation });
  assert.equal(evidence.identityMatches, true);
  assert.equal(evidence.gate.passing, true);
  assert.deepEqual(evidence.payload, {
    all_green: true,
    pending: 0,
    failed: 0,
    summary: observation.summary,
    required_checks: ["gitlab/lint-and-test"],
    missing_required_checks: [],
    nonpassing_required_checks: [],
    source: "github",
    project_path: "belongnet/example",
    base_branch: "main",
    commit_sha: HEAD,
    pipeline_id: "github-status-81",
    checks: [{ name: "gitlab/lint-and-test", status: "success", commit_sha: HEAD }],
  });
  assert.equal(checkEvidenceAccepted("required_checks", evidence.payload, lane, RUN, HEAD), true);

  const summaryOnly = {
    all_green: true,
    pending: 0,
    failed: 0,
    required_checks: ["gitlab/lint-and-test"],
  };
  assert.equal(checkEvidenceAccepted("required_checks", summaryOnly, lane, RUN, HEAD), false);
  assert.equal(
    checkEvidenceAccepted(
      "required_checks",
      { ...evidence.payload, pipeline_id: true },
      lane,
      RUN,
      HEAD
    ),
    false
  );
  assert.equal(
    checkEvidenceAccepted(
      "required_checks",
      {
        ...evidence.payload,
        checks: [{ name: "gitlab/lint-and-test", status: "success", commit_sha: MERGED }],
      },
      lane,
      RUN,
      HEAD
    ),
    false
  );
  for (const [field, forged] of [
    ["source", { source: "gitlab" }],
    ["base_branch", { base_branch: "dev" }],
    ["commit_sha", { commit_sha: MERGED }],
    [
      "check status",
      { checks: [{ name: "gitlab/lint-and-test", status: "failure", commit_sha: HEAD }] },
    ],
  ] as const) {
    assert.equal(
      checkEvidenceAccepted("required_checks", { ...evidence.payload, ...forged }, lane, RUN, HEAD),
      false,
      `a receipt with a forged ${field} is refused`
    );
  }
});

test("a skipped or neutral named GitHub check cannot become a successful receipt", () => {
  const lane = laneWith({ kind: "github", required_checks: ["test"] });
  for (const conclusion of ["skipped", "neutral"]) {
    const snapshot = commitChecksSnapshot(
      { repoOwner: "belongnet", repoName: "example", sha: HEAD },
      [{ id: 81, name: "test", status: "completed", conclusion }],
      []
    );
    const observation = githubCheckObservation(snapshot, ["test"]);
    const evidence = buildCheckEvidence({ lane, run: RUN, sha: HEAD, observation });
    assert.equal(evidence.gate.passing, false, conclusion);
    assert.deepEqual(evidence.gate.pending, ["test"], conclusion);
    assert.deepEqual(evidence.payload.checks, [
      { name: "test", status: "pending", commit_sha: HEAD },
    ]);
    assert.equal(checkEvidenceAccepted("required_checks", evidence.payload, lane, RUN, HEAD), false);
  }
});

test("receipts follow manifest order and unrelated failing checks never block", () => {
  const lane = laneWith({
    kind: "github",
    required_checks: ["gate", "test"],
    check_allowlist: ["test", "gate", "lint"],
  });
  const observation = githubCheckObservation(
    commitChecksSnapshot(
      { repoOwner: "belongnet", repoName: "example", sha: HEAD },
      [
        { id: 2, name: "test", status: "completed", conclusion: "success" },
        { id: 1, name: "gate", status: "completed", conclusion: "success" },
        { id: 3, name: "deploy-preview", status: "completed", conclusion: "failure" },
      ],
      []
    ),
    ["gate", "test"]
  );
  const evidence = buildCheckEvidence({ lane, run: RUN, sha: HEAD, observation });
  assert.equal(evidence.gate.passing, true);
  assert.equal(evidence.payload.pipeline_id, "github-check-run-1+github-check-run-2");
  assert.deepEqual(
    (evidence.payload.checks as Array<{ name: string }>).map((check) => check.name),
    ["gate", "test"]
  );
  assert.equal(checkEvidenceAccepted("required_checks", evidence.payload, lane, RUN, HEAD), true);
  const reordered = {
    ...evidence.payload,
    checks: [...(evidence.payload.checks as unknown[])].reverse(),
  };
  assert.equal(checkEvidenceAccepted("required_checks", reordered, lane, RUN, HEAD), false);
});

test("green checks without a provable receipt are waited on, never merged on", () => {
  const lane = laneWith({ kind: "github", required_checks: ["test"] });
  const evidence = buildCheckEvidence({
    lane,
    run: RUN,
    sha: HEAD,
    observation: {
      source: "github",
      projectPath: "belongnet/example",
      sha: HEAD,
      pipelineId: null,
      status: "passing",
      summary: "1 passing",
      checks: [{ name: "test", status: "passing" }],
    },
  });
  assert.equal(evidence.gate.passing, false);
  assert.deepEqual(evidence.gate.pending, ["github pipeline receipt"]);
  assert.deepEqual(evidence.gate.failed, []);
  assert.equal(evidence.payload.all_green, false);
  assert.equal(checkEvidenceAccepted("required_checks", evidence.payload, lane, RUN, HEAD), false);
});

// Extended by /ship coverage audit with a green flag over evidence that still counts pending or failed work.
// Value: protects=a lane without named checks never accepts check evidence that still counts pending or failed work, as Command Center refuses it;
//   fails_when=the unnamed-check branch of checkEvidenceAccepted stops reading pending/failed, so a green flag over unfinished CI is accepted;
//   why_new=every unnamed-check payload in the suite is fully green or not all_green, so the pending/failed refusal never runs; seam=none
test("GitLab canonical CI is proven only by the canonical project's exact pipeline", () => {
  const lane = laneWith(GITLAB_CANONICAL);
  const merged = buildCheckEvidence({ lane, run: RUN, sha: MERGED, observation: gitlabPipeline() });
  assert.equal(merged.gate.passing, true);
  assert.deepEqual(
    {
      source: merged.payload.source,
      project_path: merged.payload.project_path,
      base_branch: merged.payload.base_branch,
      commit_sha: merged.payload.commit_sha,
      pipeline_id: merged.payload.pipeline_id,
    },
    {
      source: "gitlab",
      project_path: "nomadhub/mvp",
      base_branch: "dev",
      commit_sha: MERGED,
      pipeline_id: 821,
    }
  );
  assert.equal(checkEvidenceAccepted("merged_ci", merged.payload, lane, RUN, MERGED), true);
  for (const counts of [{ pending: 1 }, { failed: 1 }]) {
    assert.equal(
      checkEvidenceAccepted("merged_ci", { ...merged.payload, ...counts }, lane, RUN, MERGED),
      false,
      `all_green with ${JSON.stringify(counts)} is refused`
    );
  }
  const head = buildCheckEvidence({
    lane,
    run: RUN,
    sha: HEAD,
    observation: gitlabPipeline({ sha: HEAD, pipelineId: 820 }),
  });
  assert.equal(checkEvidenceAccepted("required_checks", head.payload, lane, RUN, HEAD), true);

  const wrongProject = buildCheckEvidence({
    lane,
    run: RUN,
    sha: MERGED,
    observation: gitlabPipeline({ projectPath: "nomadhub/wrong" }),
  });
  assert.equal(wrongProject.identityMatches, false);
  assert.equal(wrongProject.gate.passing, false);
  assert.equal(
    checkEvidenceAccepted(
      "merged_ci",
      { ...merged.payload, project_path: "nomadhub/wrong", pipeline_id: 820 },
      lane,
      RUN,
      MERGED
    ),
    false
  );
  const githubMirrorSummary = {
    all_green: true,
    pending: 0,
    failed: 0,
    required_checks: [],
    missing_required_checks: [],
    nonpassing_required_checks: [],
    source: "github",
    project_path: "belongnet/example",
    base_branch: "main",
    commit_sha: MERGED,
    pipeline_id: "github-status-1",
  };
  assert.equal(checkEvidenceAccepted("merged_ci", githubMirrorSummary, lane, RUN, MERGED), false);
});

test("a GitLab pipeline that is absent, running or failed never passes", () => {
  const lane = laneWith(GITLAB_CANONICAL);
  const gate = (observation: CheckObservation) =>
    buildCheckEvidence({ lane, run: RUN, sha: MERGED, observation }).gate;
  assert.deepEqual(gate(gitlabPipeline({ pipelineId: null, status: "pending" })), {
    passing: false,
    missing: ["gitlab pipeline"],
    notPassing: [],
    pending: [],
    failed: [],
  });
  assert.deepEqual(gate(gitlabPipeline({ status: "pending" })).pending, ["gitlab pipeline"]);
  assert.deepEqual(gate(gitlabPipeline({ status: "failing" })).failed, ["gitlab pipeline"]);
});

test("a GitHub pipeline identifier stays within Command Center's bound", () => {
  assert.equal(githubPipelineId([]), null);
  assert.equal(
    githubPipelineId(["status-2", "check-run-1", "status-2"]),
    "github-check-run-1+github-status-2"
  );
  const many = githubPipelineId(
    Array.from({ length: 80 }, (_, index) => `check-run-${1_000_000 + index}`)
  );
  assert.match(many ?? "", /^github-checks-[0-9a-f]{64}$/);
});

test("a green named check without a real GitHub id never names a pipeline", () => {
  const lane = laneWith({ kind: "github", required_checks: ["test"] });
  for (const status of [
    { context: "test", state: "success" },
    { id: 0, context: "test", state: "success" },
    { id: "81", context: "test", state: "success" },
    { id: 1.5, context: "test", state: "success" },
  ]) {
    const observation = githubCheckObservation(
      commitChecksSnapshot({ repoOwner: "belongnet", repoName: "example", sha: HEAD }, [], [status]),
      ["test"]
    );
    assert.equal(observation.pipelineId, null, JSON.stringify(status));
    const evidence = buildCheckEvidence({ lane, run: RUN, sha: HEAD, observation });
    assert.equal(evidence.gate.passing, false);
    assert.deepEqual(evidence.gate.pending, ["github pipeline receipt"]);
  }
});

test("a pipeline id is valid exactly where Command Center's Python rule says so", () => {
  const lane = laneWith(GITLAB_CANONICAL);
  const { payload } = buildCheckEvidence({ lane, run: RUN, sha: MERGED, observation: gitlabPipeline() });
  const accepted = (pipeline_id: unknown) =>
    checkEvidenceAccepted("merged_ci", { ...payload, pipeline_id }, lane, RUN, MERGED);
  for (const refused of [
    0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, true, null,
    "", "   ", "\x85", "\x1c\x1f", "a\nb", "a\rb", "a\0b", "x".repeat(513),
  ]) {
    assert.equal(accepted(refused), false, JSON.stringify(refused));
  }
  // Python's str.strip() keeps U+FEFF, and its length counts code points.
  for (const valid of [821, "github-status-81", "﻿", "x".repeat(512), "😀".repeat(512)]) {
    assert.equal(accepted(valid), true, JSON.stringify(valid));
  }
  for (const count of [1, 10, 30, 31, 80, 500]) {
    const id = githubPipelineId(
      Array.from({ length: count }, (_, index) => `check-run-${1_000_000 + index}`)
    );
    assert.equal(validPipelineId(id), true, `${count} ids name a valid pipeline`);
  }
});

test("a GitLab-delivered lane with named checks is proven by its own GitLab project", () => {
  const lane = laneWith({ kind: "gitlab", required_checks: ["lint-and-test"] });
  assert.deepEqual(canonicalEvidenceIdentity(lane, RUN), {
    kind: "gitlab",
    projectPath: "belongnet/example",
    baseBranch: "main",
  });
  const observation = gitlabPipeline({
    projectPath: "belongnet/example",
    sha: HEAD,
    checks: [{ name: "lint-and-test", status: "passing", id: "gitlab-job-1" }],
  });
  const evidence = buildCheckEvidence({ lane, run: RUN, sha: HEAD, observation });
  assert.equal(evidence.identityMatches, true);
  assert.equal(evidence.gate.passing, true);
  assert.equal(checkEvidenceAccepted("required_checks", evidence.payload, lane, RUN, HEAD), true);
  const mirror = buildCheckEvidence({
    lane,
    run: RUN,
    sha: HEAD,
    observation: { ...observation, source: "github" },
  });
  assert.equal(mirror.identityMatches, false);
});

test("named GitLab jobs decide the gate; the rest of the pipeline is not consulted", () => {
  const lane = laneWith({ ...GITLAB_CANONICAL, required_checks: ["lint-and-test"] });
  for (const status of ["failing", "pending"] as const) {
    const evidence = buildCheckEvidence({
      lane,
      run: RUN,
      sha: MERGED,
      observation: gitlabPipeline({
        status,
        checks: [
          { name: "lint-and-test", status: "passing", id: "gitlab-job-1" },
          { name: "deploy-review", status, id: "gitlab-job-2" },
        ],
      }),
    });
    assert.equal(evidence.gate.passing, true, `pipeline ${status}`);
    assert.equal(checkEvidenceAccepted("merged_ci", evidence.payload, lane, RUN, MERGED), true);
  }
});

test("the store refuses what Command Center refuses: explicit nulls and non-string paths", () => {
  const named = laneWith({ kind: "github", required_checks: ["test"] });
  assert.equal(
    checkEvidenceAccepted(
      "merged_ci",
      {
        all_green: true,
        required_checks: ["test"],
        missing_required_checks: null,
        nonpassing_required_checks: null,
      },
      named,
      RUN,
      MERGED
    ),
    false
  );
  assert.equal(
    checkEvidenceAccepted(
      "required_checks",
      { all_green: true, pending: 0, failed: 0, required_checks: null },
      laneWith({ kind: "github" }),
      RUN,
      HEAD
    ),
    false
  );
  const canonical = laneWith(GITLAB_CANONICAL);
  const { payload } = buildCheckEvidence({
    lane: canonical,
    run: RUN,
    sha: MERGED,
    observation: gitlabPipeline(),
  });
  assert.equal(checkEvidenceAccepted("merged_ci", payload, canonical, RUN, MERGED), true);
  assert.equal(
    checkEvidenceAccepted(
      "merged_ci",
      { ...payload, project_path: ["nomadhub/mvp"] },
      canonical,
      RUN,
      MERGED
    ),
    false
  );
});

test("each named check's receipt reports exactly what the gate decided for it", () => {
  const lane = laneWith({ kind: "github", required_checks: ["a", "b", "c", "d"] });
  const { payload, gate } = buildCheckEvidence({
    lane,
    run: RUN,
    sha: HEAD,
    observation: {
      source: "github",
      projectPath: "belongnet/example",
      sha: HEAD,
      pipelineId: "github-status-1",
      status: "failing",
      summary: "mixed",
      checks: [
        { name: "a", status: "passing" },
        { name: "b", status: "passing" },
        { name: "b", status: "failing" },
        { name: "c", status: "unknown" },
      ],
    },
  });
  assert.deepEqual(
    (payload.checks as Array<{ name: string; status: string }>).map(({ name, status }) => [name, status]),
    [["a", "success"], ["b", "failure"], ["c", "pending"], ["d", "missing"]]
  );
  assert.deepEqual(gate.failed, ["b"]);
  assert.deepEqual(gate.missing, ["d"]);
  for (const first of ["passing", "pending", "unknown", "failing"] as const) {
    for (const second of ["passing", "pending", "unknown", "failing"] as const) {
      const evidence = buildCheckEvidence({
        lane: laneWith({ kind: "github", required_checks: ["test"] }),
        run: RUN,
        sha: HEAD,
        observation: {
          source: "github",
          projectPath: "belongnet/example",
          sha: HEAD,
          pipelineId: "github-status-1",
          status: "passing",
          summary: "",
          checks: [
            { name: "test", status: first, id: "status-1" },
            { name: "test", status: second, id: "status-2" },
          ],
        },
      });
      const receipts = evidence.payload.checks as Array<{ status: string }>;
      assert.equal(
        evidence.gate.passing,
        receipts.every((receipt) => receipt.status === "success"),
        `${first}+${second}`
      );
    }
  }
});

test("pre-merge receipts keep a manifest order that is not alphabetical", () => {
  const lane = laneWith({ kind: "github", required_checks: ["test", "gate"] });
  const observation = githubCheckObservation(
    commitChecksSnapshot(
      { repoOwner: "belongnet", repoName: "example", sha: HEAD },
      [
        { id: 1, name: "gate", status: "completed", conclusion: "success" },
        { id: 2, name: "test", status: "completed", conclusion: "success" },
      ],
      []
    ),
    ["test", "gate"]
  );
  const { payload } = buildCheckEvidence({ lane, run: RUN, sha: HEAD, observation });
  assert.deepEqual(payload.required_checks, ["test", "gate"]);
  assert.deepEqual(
    (payload.checks as Array<{ name: string }>).map((check) => check.name),
    ["test", "gate"]
  );
  assert.equal(checkEvidenceAccepted("required_checks", payload, lane, RUN, HEAD), true);
  assert.equal(
    checkEvidenceAccepted(
      "required_checks",
      { ...payload, required_checks: ["gate", "test"] },
      lane,
      RUN,
      HEAD
    ),
    false,
    "pre-merge evidence names the required checks in manifest order"
  );
});
