import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_DIR = mkdtempSync(path.join(os.tmpdir(), "ct-lanes-pipeline-"));
process.env.DB_PATH = path.join(TEMP_DIR, "bot.db");
process.env.CONDUCTOR_DB_PATH = path.join(TEMP_DIR, "no-conductor.db");
process.env.CONDUCTOR_SETTINGS_PATH = path.join(TEMP_DIR, "no-settings.toml");
for (const name of ["review.md", "final.md", "merge.md", "validation.md"]) {
  writeFileSync(
    path.join(TEMP_DIR, name),
    `Example ${name} prompt for {{prUrl}}.`,
  );
}

import type { ConductorApiClient } from "../src/integrations/conductor-api.js";
import type { GithubPrPolicySnapshot } from "../src/bot/github.js";
import type { LaneConfig, LanesConfig } from "../src/lanes/config.js";
import type { LaneSnapshot } from "../src/lanes/decide.js";
import {
  decideLaneActions,
  githubPrUrlFromTextForRepo,
} from "../src/lanes/decide.js";
import { executeLaneAction } from "../src/lanes/scheduler.js";
import {
  isAbandonedWorkspace,
  hasCurrentFinalApprovals,
  mergeDependencyBlockers,
  parseFinalReviewMarkers,
  parseMergedSha,
  parsePipelineWorkspaceName,
  parseRateLimitReset,
  parseValidationMarker,
  runDeliveryPipeline,
  selectRotatedProvider,
  shouldArchiveWorkspace,
  shouldRestartDeadSession,
  type LaneDeliveryState,
} from "../src/lanes/pipeline.js";
import { closeDb } from "../src/store/db.js";
import {
  getLaneDeliveryState,
  setLaneDeliveryState,
} from "../src/store/queries.js";

after(() => {
  closeDb();
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

const NOW = new Date("2026-09-03T12:00:00.000Z");

test("machine-readable final, merge, and validation markers parse from fixture transcripts", () => {
  const transcript = [
    "FINAL-REVIEW (model-a): not-json",
    'FINAL-REVIEW (model-a): {"verdict":"approve","risk":"low"}',
    'FINAL-REVIEW (model-b): {"verdict":"changes","reason":"test gap"}',
    'MERGED BY AGENTS: {"sha":"abcdef1234567890abcdef1234567890abcdef12"}',
    "VALIDATED (model-c)",
  ].join("\n");

  assert.deepEqual(
    parseFinalReviewMarkers(transcript).map((marker) => [
      marker.model,
      marker.verdict,
    ]),
    [
      ["model-a", "approve"],
      ["model-b", "changes"],
    ],
  );
  assert.equal(
    parseMergedSha(transcript),
    "abcdef1234567890abcdef1234567890abcdef12",
  );
  assert.equal(
    parseMergedSha('MERGED BY AGENTS: {"sha":"abcdef1"}'),
    null,
  );
  assert.deepEqual(parseValidationMarker(transcript), {
    result: "passed",
    model: "model-c",
    raw: "VALIDATED (model-c)",
  });
});

test("provider rotation skips author, busy providers, and rate-limited providers", () => {
  const selected = selectRotatedProvider({
    rotation: ["author", "limited", "busy", "stand-in"],
    exclude: new Set(["author"]),
    occupied: new Set(["busy"]),
    outages: new Map([["limited", "2026-09-03T18:00:00.000Z"]]),
    now: NOW,
  });
  assert.equal(selected, "stand-in");
});

test("rate-limit resets and two-unanswered-nudge death detection are deterministic", () => {
  const reset = parseRateLimitReset(
    "Provider rate limit reached; try again after 2026-09-03T18:00:00Z.",
    NOW,
  );
  assert.equal(reset, "2026-09-03T18:00:00.000Z");
  assert.equal(
    parseRateLimitReset("Quota reached; resets in 3 hours.", NOW),
    "2026-09-03T15:00:00.000Z",
  );
  assert.equal(
    parseRateLimitReset(
      "Quota reached; resets in 3 hours.",
      new Date("2026-09-04T12:00:00.000Z"),
      NOW,
    ),
    null,
  );
  assert.equal(
    shouldRestartDeadSession({
      unansweredNudges: 2,
      lastAssistantAt: "2026-09-03T08:00:00.000Z",
      lastNudgeAt: "2026-09-03T10:00:00.000Z",
      now: NOW,
    }),
    true,
  );
  assert.equal(
    shouldRestartDeadSession({
      unansweredNudges: 2,
      lastAssistantAt: null,
      lastNudgeAt: "2026-09-03T10:00:00.000Z",
      rateLimitUntil: "2026-09-03T18:00:00.000Z",
      now: NOW,
    }),
    false,
  );
});

test("a dead author session is restarted in place instead of creating a workspace", async () => {
  const lane = laneConfig({ delivery: undefined });
  const config = lanesConfig();
  config.lanes = [lane];
  const snapshot: LaneSnapshot = {
    ...authorSnapshot("2026-09-03T08:00:00.000Z"),
    state: "paused",
    lastUserMessageAt: "2026-09-03T06:00:00.000Z",
    unansweredNudges: 2,
  };
  assert.deepEqual(
    decideLaneActions({
      now: NOW,
      paused: false,
      providers: [{ name: "author", gapHours: 1, maxActive: 1 }],
      lanes: [snapshot],
    }),
    [{ type: "restart", laneId: "L1", provider: "author" }],
  );

  const calls: string[] = [];
  const client = {
    createSession: async (input: { workspaceId: string }) => {
      calls.push(`session:${input.workspaceId}`);
      return {
        id: "replacement-session",
        deepLink: "https://conductor.build/session",
      };
    },
    sendMessage: async (input: { sessionId: string; messageId: string }) => {
      calls.push(`message:${input.sessionId}`);
      return { messageId: input.messageId, state: "queued" as const };
    },
  } as unknown as ConductorApiClient;
  const outcome = await executeLaneAction(
    client,
    config,
    lane,
    { type: "restart", laneId: "L1", provider: "author" },
    [workspace("author-workspace", "[host] [lane:L1:author] Example")],
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, [
    "session:author-workspace",
    "message:replacement-session",
  ]);
});

test("workspace parsing uses containment and abandoned tags are ignored", () => {
  assert.deepEqual(
    parsePipelineWorkspaceName(
      "[team] [lane:L1:final:r2:s1:reviewer] Example task",
    ),
    {
      role: "final",
      laneId: "L1",
      round: 2,
      slot: 1,
      provider: "reviewer",
    },
  );
  assert.equal(
    isAbandonedWorkspace("[abandoned old] [lane:L1:review:x]"),
    true,
  );
});

test("hygiene archives completed roles but never an unmerged author or active validation", () => {
  const state = deliveryState({ stage: "review_fixes" });
  assert.equal(
    shouldArchiveWorkspace(
      { role: "review", laneId: "L1", provider: "reviewer" },
      state,
    ),
    true,
  );
  assert.equal(
    shouldArchiveWorkspace(
      { role: "author", laneId: "L1", provider: "author" },
      state,
    ),
    false,
  );
  state.mergedSha = "abcdef1";
  state.stage = "validation";
  assert.equal(
    shouldArchiveWorkspace(
      { role: "validation", laneId: "L1", provider: "validator" },
      state,
    ),
    false,
  );
});

test("merge waits for every dependency lane to have a merge SHA", () => {
  const lane = laneConfig({ after: ["L0", "Lx"] });
  const states = new Map<string, LaneDeliveryState | null>([
    ["L0", deliveryState({ laneId: "L0", mergedSha: "abcdef1" })],
    ["Lx", deliveryState({ laneId: "Lx" })],
  ]);
  assert.deepEqual(mergeDependencyBlockers(lane, states), ["Lx"]);
});

test("merge accepts a done dependency that has no delivery pipeline", () => {
  const lane = laneConfig({ after: ["L0"] });
  const dependency = laneConfig({ id: "L0", delivery: undefined });
  assert.deepEqual(
    mergeDependencyBlockers(
      lane,
      new Map([["L0", null]]),
      [{ ...authorSnapshot(NOW.toISOString()), id: "L0" }],
      [dependency, lane],
    ),
    [],
  );
});

test("PR discovery is repo-bound and prefers the last matching URL", () => {
  assert.equal(
    githubPrUrlFromTextForRepo(
      "See https://github.com/other/example/pull/2 then https://github.com/example-org/example-repo/pull/3 and https://github.com/example-org/example-repo/pull/4",
      "https://github.com/example-org/example-repo.git",
    ),
    "https://github.com/example-org/example-repo/pull/4",
  );
});

test("fixture transcript advances review to author fixes, then starts finals after a push", async () => {
  const config = lanesConfig();
  const lane = config.lanes[0];
  const sent: Array<{ sessionId: string; message: string }> = [];
  let created = 0;
  const client = {
    createWorkspace: async () => {
      created += 1;
      return {
        workspaceId: created === 1 ? "review-workspace" : "final-workspace",
        sessionId: created === 1 ? "review-session" : "final-session",
        deepLink: "https://conductor.build/example",
      };
    },
    sendMessage: async (input: {
      sessionId: string;
      message: string;
      messageId: string;
    }) => {
      sent.push(input);
      return { messageId: input.messageId, state: "queued" as const };
    },
    listWorkspaceSessions: async (workspaceId: string) => [
      {
        id:
          workspaceId === "author-workspace"
            ? "author-session"
            : "review-session",
        deepLink: "https://conductor.build/session",
        createdAt: "2026-09-03T10:00:00.000Z",
      },
    ],
    getSessionStatus: async (sessionId: string) => ({
      workspaceId:
        sessionId === "author-session"
          ? "author-workspace"
          : "review-workspace",
      sessionId,
      status: "idle" as const,
      updatedAt: "2026-09-03T11:00:00.000Z",
    }),
    listSessionMessages: async (input: { sessionId: string }) =>
      ({
        data:
          input.sessionId === "review-session"
            ? [
                assistantMessage(
                  "review-session",
                  "REVIEW POSTED",
                  "2026-09-03T11:00:00.000Z",
                ),
              ]
            : [],
        offset: 0,
        hasMore: false,
      }).data,
  } as unknown as ConductorApiClient;
  const author = authorSnapshot("2026-09-03T10:00:00.000Z");

  await runDeliveryPipeline({
    client,
    config,
    snapshots: [author],
    workspaces: [],
    notify: async () => undefined,
  });
  assert.equal(created, 1);
  assert.equal(getLaneDeliveryState<LaneDeliveryState>("L1")?.stage, "review");

  await runDeliveryPipeline({
    client,
    config,
    snapshots: [author],
    workspaces: [
      workspace("review-workspace", "[host] [lane:L1:review:reviewer] Example"),
    ],
    notify: async () => undefined,
  });
  const fixing = getLaneDeliveryState<LaneDeliveryState>("L1");
  assert.equal(fixing?.stage, "review_fixes");
  assert.match(sent.at(-1)?.message ?? "", /Address the adversarial/);

  const pushed = authorSnapshot("2099-09-03T12:00:00.000Z");
  await runDeliveryPipeline({
    client,
    config,
    snapshots: [pushed],
    workspaces: [
      workspace("review-workspace", "[host] [lane:L1:review:reviewer] Example"),
    ],
    notify: async () => undefined,
  });
  const final = getLaneDeliveryState<LaneDeliveryState>("L1");
  assert.equal(final?.stage, "finals");
  assert.equal(final?.finals.length, 1);
  assert.equal(final?.finals[0]?.provider, "reviewer");
});

test("fixture markers require GitHub policy before merge and exact GitHub SHA afterward", async () => {
  const config = lanesConfig();
  const lane = { ...config.lanes[0], id: "L2" };
  config.lanes = [lane];
  const state = deliveryState({
    laneId: "L2",
    stage: "finals",
    finals: [
      {
        role: "final",
        workspaceId: "final-one-workspace",
        sessionId: "final-one-session",
        provider: "reviewer",
        model: "review-model",
        startedAt: "2026-09-03T08:00:00.000Z",
        round: 1,
        slot: 1,
        verdict: "approve",
        marker: 'FINAL-REVIEW (review-model): {"verdict":"approve"}',
        completedAt: "2026-09-03T09:00:00.000Z",
      },
      {
        role: "final",
        workspaceId: "final-two-workspace",
        sessionId: "final-two-session",
        provider: "validator",
        model: "validation-model",
        startedAt: "2026-09-03T09:00:00.000Z",
        round: 1,
        slot: 2,
      },
    ],
  });
  setLaneDeliveryState("L2", state);
  const headSha = "1111111111111111111111111111111111111111";
  const mergeSha = "2222222222222222222222222222222222222222";
  let merged = false;
  let mergeCreated = false;
  let validationCreated = false;
  const client = {
    listWorkspaceSessions: async (workspaceId: string) => [
      {
        id:
          workspaceId === "final-two-workspace"
            ? "final-two-session"
            : workspaceId === "merge-workspace"
              ? "merge-session"
            : workspaceId === "validation-workspace"
              ? "validation-session"
              : "author-session",
        deepLink: "https://conductor.build/session",
        createdAt: "2026-09-03T10:00:00.000Z",
      },
    ],
    getSessionStatus: async (sessionId: string) => ({
      workspaceId: `${sessionId}-workspace`,
      sessionId,
      status: "idle" as const,
      updatedAt: "2026-09-03T11:00:00.000Z",
    }),
    listSessionMessages: async (input: { sessionId: string }) => {
      const text =
        input.sessionId === "final-two-session"
          ? 'FINAL-REVIEW (validation-model): {"verdict":"approve"}'
          : input.sessionId === "merge-session"
            ? `MERGED BY AGENTS: {"sha":"${mergeSha}"}`
          : input.sessionId === "validation-session"
            ? "VALIDATED (review-model)"
            : "";
      return text
        ? [assistantMessage(input.sessionId, text, "2026-09-03T11:00:00.000Z")]
        : [];
    },
    createWorkspace: async (input: { name: string }) => {
      const isMerge = input.name.includes(":merge:");
      mergeCreated ||= isMerge;
      validationCreated ||= !isMerge;
      return {
        workspaceId: isMerge ? "merge-workspace" : "validation-workspace",
        sessionId: isMerge ? "merge-session" : "validation-session",
        deepLink: `https://conductor.build/${isMerge ? "merge" : "validation"}`,
      };
    },
    sendMessage: async (input: { messageId: string }) => ({
      messageId: input.messageId,
      state: "queued" as const,
    }),
  } as unknown as ConductorApiClient;
  const snapshot = { ...authorSnapshot("2026-09-03T10:00:00.000Z"), id: "L2" };
  const finalWorkspaces = [
    workspace("final-one-workspace", "[lane:L2:final:r1:s1:reviewer] Example"),
    workspace("final-two-workspace", "[lane:L2:final:r1:s2:validator] Example"),
  ];
  const refreshPr = async () =>
    prPolicy({
      state: merged ? "merged" : "open",
      headSha,
      mergeCommitSha: merged ? mergeSha : null,
      reviews: [
        prReview(
          'FINAL-REVIEW (review-model): {"verdict":"approve"}',
          headSha,
          "2026-09-03T09:00:00.000Z",
        ),
        prReview(
          'FINAL-REVIEW (validation-model): {"verdict":"approve"}',
          headSha,
          "2026-09-03T11:00:00.000Z",
        ),
      ],
    });

  await runDeliveryPipeline({
    client,
    config,
    snapshots: [snapshot],
    workspaces: finalWorkspaces,
    notify: async () => undefined,
    refreshPr,
  });
  assert.equal(getLaneDeliveryState<LaneDeliveryState>("L2")?.stage, "merge");

  await runDeliveryPipeline({
    client,
    config,
    snapshots: [snapshot],
    workspaces: finalWorkspaces,
    notify: async () => undefined,
    refreshPr,
  });
  assert.equal(mergeCreated, true);
  assert.equal(
    getLaneDeliveryState<LaneDeliveryState>("L2")?.mergeHeadSha,
    headSha,
  );

  merged = true;
  await runDeliveryPipeline({
    client,
    config,
    snapshots: [snapshot],
    workspaces: [
      ...finalWorkspaces,
      workspace("merge-workspace", "[lane:L2:merge:validator] Example"),
    ],
    notify: async () => undefined,
    refreshPr,
  });
  assert.equal(
    getLaneDeliveryState<LaneDeliveryState>("L2")?.stage,
    "validation",
  );

  await runDeliveryPipeline({
    client,
    config,
    snapshots: [snapshot],
    workspaces: [
      ...finalWorkspaces,
      workspace("merge-workspace", "[lane:L2:merge:validator] Example"),
    ],
    notify: async () => undefined,
    refreshPr,
  });
  const validating = getLaneDeliveryState<LaneDeliveryState>("L2");
  assert.equal(validationCreated, true);
  assert.equal(validating?.validation?.provider, "reviewer");

  await runDeliveryPipeline({
    client,
    config,
    snapshots: [snapshot],
    workspaces: [
      ...finalWorkspaces,
      workspace("merge-workspace", "[lane:L2:merge:validator] Example"),
      workspace(
        "validation-workspace",
        "[lane:L2:validation:reviewer] Example",
      ),
    ],
    notify: async () => undefined,
    refreshPr,
  });
  const complete = getLaneDeliveryState<LaneDeliveryState>("L2");
  assert.equal(complete?.stage, "complete");
  assert.equal(complete?.validationResult, "passed");
});

test("current final approvals must be GitHub reviews on the exact head", () => {
  const state = approvedFinalState("L3");
  const headSha = "3333333333333333333333333333333333333333";
  const current = prPolicy({
    headSha,
    reviews: [
      prReview(state.finals[0].marker!, headSha, "2026-09-03T09:00:00Z"),
      prReview(state.finals[1].marker!, headSha, "2026-09-03T10:00:00Z"),
    ],
  });
  assert.equal(hasCurrentFinalApprovals(state, current), true);
  current.reviews[1].commitSha = "4444444444444444444444444444444444444444";
  assert.equal(hasCurrentFinalApprovals(state, current), false);
});

test("GitHub conflict returns the lane to its author without trusting transcript prose", async () => {
  const config = lanesConfig();
  const lane = { ...config.lanes[0], id: "L4" };
  config.lanes = [lane];
  const state = approvedFinalState("L4");
  setLaneDeliveryState("L4", state);
  let created = false;
  let authorMessage = "";
  const client = {
    listWorkspaceSessions: async () => [
      {
        id: "author-session",
        deepLink: "https://conductor.build/session",
        createdAt: NOW.toISOString(),
      },
    ],
    sendMessage: async (input: { message: string; messageId: string }) => {
      authorMessage = input.message;
      return { messageId: input.messageId, state: "queued" as const };
    },
    createWorkspace: async () => {
      created = true;
      throw new Error("must not create a merge workspace for a conflict");
    },
  } as unknown as ConductorApiClient;
  await runDeliveryPipeline({
    client,
    config,
    snapshots: [{ ...authorSnapshot(NOW.toISOString()), id: "L4" }],
    workspaces: [],
    notify: async () => undefined,
    refreshPr: async () =>
      prPolicy({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
  });
  assert.equal(created, false);
  assert.match(authorMessage, /^Rebase /);
  assert.equal(getLaneDeliveryState<LaneDeliveryState>("L4")?.stage, "final_fixes");
  assert.equal(
    shouldArchiveWorkspace(
      { role: "merge", laneId: "L4", provider: "validator" },
      getLaneDeliveryState<LaneDeliveryState>("L4")!,
    ),
    false,
  );
});

test("ordinary conflict and rebase prose cannot trigger the conflict transition", async () => {
  const config = lanesConfig();
  const lane = { ...config.lanes[0], id: "L6" };
  config.lanes = [lane];
  const state = approvedFinalState("L6");
  state.mergeHeadSha = "1111111111111111111111111111111111111111";
  state.merge = {
    role: "merge",
    workspaceId: "merge-workspace",
    sessionId: "merge-session",
    provider: "validator",
    model: "validation-model",
    startedAt: "2026-09-03T08:00:00.000Z",
  };
  setLaneDeliveryState("L6", state);
  const client = {
    listWorkspaceSessions: async () => [
      {
        id: "merge-session",
        deepLink: "https://conductor.build/session",
        createdAt: NOW.toISOString(),
      },
    ],
    getSessionStatus: async () => ({
      workspaceId: "merge-workspace",
      sessionId: "merge-session",
      status: "idle" as const,
      updatedAt: NOW.toISOString(),
    }),
    listSessionMessages: async () => [
      assistantMessage(
        "merge-session",
        "There are no conflicting PRs. The guide says a branch sometimes needs rebase.",
        NOW.toISOString(),
      ),
    ],
    sendMessage: async (input: { messageId: string }) => ({
      messageId: input.messageId,
      state: "queued" as const,
    }),
  } as unknown as ConductorApiClient;
  await runDeliveryPipeline({
    client,
    config,
    snapshots: [{ ...authorSnapshot(NOW.toISOString()), id: "L6" }],
    workspaces: [
      workspace("merge-workspace", "[lane:L6:merge:validator] Example"),
    ],
    notify: async () => undefined,
    refreshPr: async () => prPolicy(),
  });
  assert.equal(getLaneDeliveryState<LaneDeliveryState>("L6")?.stage, "merge");
});

test("GitHub policy blocks merge workspace creation while checks are pending", async () => {
  const config = lanesConfig();
  const lane = { ...config.lanes[0], id: "L7" };
  config.lanes = [lane];
  setLaneDeliveryState("L7", approvedFinalState("L7"));
  let created = false;
  const client = {
    createWorkspace: async () => {
      created = true;
      throw new Error("pending checks must fail closed");
    },
  } as unknown as ConductorApiClient;
  await runDeliveryPipeline({
    client,
    config,
    snapshots: [{ ...authorSnapshot(NOW.toISOString()), id: "L7" }],
    workspaces: [],
    notify: async () => undefined,
    refreshPr: async () => prPolicy({ checksStatus: "pending" }),
  });
  assert.equal(created, false);
  assert.equal(getLaneDeliveryState<LaneDeliveryState>("L7")?.merge, undefined);
});

test("an archived matching merge workspace is not rebound or recreated", async () => {
  const config = lanesConfig();
  const lane = { ...config.lanes[0], id: "L5" };
  config.lanes = [lane];
  setLaneDeliveryState("L5", approvedFinalState("L5"));
  let created = false;
  const client = {
    createWorkspace: async () => {
      created = true;
      throw new Error("archived names must not be recreated");
    },
  } as unknown as ConductorApiClient;
  await runDeliveryPipeline({
    client,
    config,
    snapshots: [{ ...authorSnapshot(NOW.toISOString()), id: "L5" }],
    workspaces: [
      {
        ...workspace("old-merge", "[lane:L5:merge:validator] Example"),
        archivedAt: "2026-09-03T11:00:00.000Z",
      },
    ],
    notify: async () => undefined,
    refreshPr: async () => prPolicy(),
  });
  assert.equal(created, false);
  assert.equal(getLaneDeliveryState<LaneDeliveryState>("L5")?.merge, undefined);
});

function deliveryState(
  overrides: Partial<LaneDeliveryState> = {},
): LaneDeliveryState {
  return {
    version: 1,
    laneId: "L1",
    prUrl: "https://github.com/example-org/example-repo/pull/1",
    authorProvider: "author",
    authorTurnAt: "2026-09-03T08:00:00.000Z",
    stage: "review",
    round: 1,
    finals: [],
    ...overrides,
  };
}

function approvedFinalState(laneId: string): LaneDeliveryState {
  return deliveryState({
    laneId,
    stage: "merge",
    finals: [
      {
        role: "final",
        workspaceId: "final-one-workspace",
        sessionId: "final-one-session",
        provider: "reviewer",
        model: "review-model",
        startedAt: "2026-09-03T08:00:00.000Z",
        round: 1,
        slot: 1,
        verdict: "approve",
        marker: 'FINAL-REVIEW (review-model): {"verdict":"approve"}',
        completedAt: "2026-09-03T09:00:00.000Z",
      },
      {
        role: "final",
        workspaceId: "final-two-workspace",
        sessionId: "final-two-session",
        provider: "validator",
        model: "validation-model",
        startedAt: "2026-09-03T09:00:00.000Z",
        round: 1,
        slot: 2,
        verdict: "approve",
        marker: 'FINAL-REVIEW (validation-model): {"verdict":"approve"}',
        completedAt: "2026-09-03T10:00:00.000Z",
      },
    ],
  });
}

function prPolicy(
  overrides: Partial<GithubPrPolicySnapshot> = {},
): GithubPrPolicySnapshot {
  return {
    url: "https://github.com/example-org/example-repo/pull/1",
    prNumber: 1,
    state: "open",
    isDraft: false,
    headSha: "1111111111111111111111111111111111111111",
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    checksStatus: "passing",
    checksSummary: "2 passing",
    mergeCommitSha: null,
    reviews: [
      prReview(
        'FINAL-REVIEW (review-model): {"verdict":"approve"}',
        "1111111111111111111111111111111111111111",
        "2026-09-03T09:00:00.000Z",
      ),
      prReview(
        'FINAL-REVIEW (validation-model): {"verdict":"approve"}',
        "1111111111111111111111111111111111111111",
        "2026-09-03T10:00:00.000Z",
      ),
    ],
    ...overrides,
  };
}

function prReview(body: string, commitSha: string, submittedAt: string) {
  return { body, state: "COMMENTED", commitSha, submittedAt };
}

function laneConfig(overrides: Partial<LaneConfig> = {}): LaneConfig {
  return {
    id: "L1",
    title: "Example task",
    provider: "author",
    repoUrl: "https://github.com/example-org/example-repo",
    prompt: "prompts/author.md",
    after: [],
    delivery: {
      review: { rotation: ["reviewer", "validator"], prompt: "review.md" },
      finals: { rotation: ["reviewer", "validator"], prompt: "final.md" },
      merge: {
        rotation: ["validator", "reviewer"],
        prompt: "merge.md",
        method: "squash",
        deployNotes: "none",
        replayNotes: "none",
      },
      validation: {
        rotation: ["validator", "reviewer"],
        prompt: "validation.md",
        verification: "npm test",
      },
    },
    ...overrides,
  };
}

function lanesConfig(): LanesConfig {
  return {
    intervalMinutes: 30,
    providers: {
      author: provider("author-model"),
      reviewer: provider("review-model"),
      validator: provider("validation-model"),
    },
    lanes: [laneConfig()],
    configPath: path.join(TEMP_DIR, "lanes.json"),
  };
}

function provider(model: string) {
  return {
    agent: "codex" as const,
    model,
    effort: "high",
    gapHours: 1,
    maxActive: 1,
    maxNudges: 2,
  };
}

function authorSnapshot(at: string): LaneSnapshot {
  return {
    id: "L1",
    provider: "author",
    assignedProvider: "author",
    state: "done",
    lastUserMessageAt: "2026-09-03T09:00:00.000Z",
    after: [],
    nudgeCount: 0,
    promptFailedCount: 0,
    lastActionKind: null,
    workspaceId: "author-workspace",
    sessionId: "author-session",
    prUrl: "https://github.com/example-org/example-repo/pull/1",
    lastAssistantAt: at,
  };
}

function workspace(id: string, name: string) {
  return {
    id,
    name,
    createdAt: "2026-09-03T10:00:00.000Z",
    deepLink: `https://conductor.build/${id}`,
  };
}

function assistantMessage(sessionId: string, text: string, receivedAt: string) {
  return {
    id: `${sessionId}-message`,
    sessionId,
    sessionIndex: 1,
    type: "assistant",
    content: text,
    receivedAt,
  };
}
