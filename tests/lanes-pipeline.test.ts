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
import type { LaneConfig, LanesConfig } from "../src/lanes/config.js";
import type { LaneSnapshot } from "../src/lanes/decide.js";
import { decideLaneActions } from "../src/lanes/decide.js";
import { executeLaneAction } from "../src/lanes/scheduler.js";
import {
  isAbandonedWorkspace,
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
    'MERGED BY AGENTS: {"sha":"abcdef1234567"}',
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
  assert.equal(parseMergedSha(transcript), "abcdef1234567");
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

test("fixture markers advance two final approvals through merge to validation", async () => {
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
  let validationCreated = false;
  const client = {
    listWorkspaceSessions: async (workspaceId: string) => [
      {
        id:
          workspaceId === "final-two-workspace"
            ? "final-two-session"
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
          ? 'FINAL-REVIEW (validation-model): {"verdict":"approve"}\nMERGED BY AGENTS: {"sha":"abcdef1234567"}'
          : input.sessionId === "validation-session"
            ? "VALIDATED (review-model)"
            : "";
      return text
        ? [assistantMessage(input.sessionId, text, "2026-09-03T11:00:00.000Z")]
        : [];
    },
    createWorkspace: async () => {
      validationCreated = true;
      return {
        workspaceId: "validation-workspace",
        sessionId: "validation-session",
        deepLink: "https://conductor.build/validation",
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

  await runDeliveryPipeline({
    client,
    config,
    snapshots: [snapshot],
    workspaces: finalWorkspaces,
    notify: async () => undefined,
  });
  assert.equal(
    getLaneDeliveryState<LaneDeliveryState>("L2")?.stage,
    "validation",
  );

  await runDeliveryPipeline({
    client,
    config,
    snapshots: [snapshot],
    workspaces: finalWorkspaces,
    notify: async () => undefined,
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
      workspace(
        "validation-workspace",
        "[lane:L2:validation:reviewer] Example",
      ),
    ],
    notify: async () => undefined,
  });
  const complete = getLaneDeliveryState<LaneDeliveryState>("L2");
  assert.equal(complete?.stage, "complete");
  assert.equal(complete?.validationResult, "passed");
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
