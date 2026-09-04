import test from "node:test";
import assert from "node:assert/strict";
import {
  assistantTextFromTranscriptEvent,
  decideLaneActions,
  deriveLaneRuntimeState,
  laneWorkspaceName,
  parseLaneWorkspaceName,
  type LaneSnapshot,
  type ProviderLimits,
} from "../src/lanes/decide.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const OLD_USER = "2026-09-01T06:00:00.000Z"; // 6h ago
const RECENT_USER = "2026-09-01T11:30:00.000Z"; // 30m ago

const PROVIDERS: ProviderLimits[] = [
  { name: "primary", gapHours: 4.5, maxActive: 1 },
  { name: "secondary", gapHours: 4.5, maxActive: 1 },
];

function lane(overrides: Partial<LaneSnapshot> & Pick<LaneSnapshot, "id">): LaneSnapshot {
  return {
    provider: "primary",
    assignedProvider: "primary",
    state: "not_created",
    lastUserMessageAt: null,
    after: [],
    nudgeCount: 0,
    promptFailedCount: 0,
    lastActionKind: null,
    ...overrides,
  };
}

test("busy provider takes no action while at maxActive", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: false,
    providers: PROVIDERS,
    lanes: [
      lane({
        id: "L1",
        state: "working",
        lastUserMessageAt: OLD_USER,
      }),
      lane({
        id: "L2",
        state: "paused",
        lastUserMessageAt: OLD_USER,
      }),
      lane({
        id: "L3",
        state: "not_created",
        assignedProvider: null,
      }),
    ],
  });

  assert.deepEqual(
    actions.filter((action) => action.provider === "primary"),
    []
  );
});

test("paused lane is not nudged until gapHours have passed", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: false,
    providers: PROVIDERS,
    lanes: [
      lane({
        id: "L1",
        state: "paused",
        lastUserMessageAt: RECENT_USER,
      }),
    ],
  });

  assert.deepEqual(actions, []);
});

test("a lane whose dependency is not done is neither created nor nudged", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: false,
    providers: PROVIDERS,
    lanes: [
      lane({
        id: "L1",
        state: "working",
        lastUserMessageAt: OLD_USER,
      }),
      lane({
        id: "L2",
        state: "not_created",
        assignedProvider: null,
        after: ["L1"],
      }),
      lane({
        id: "L3",
        provider: "any",
        assignedProvider: null,
        state: "paused",
        lastUserMessageAt: OLD_USER,
        after: ["L1"],
      }),
    ],
  });

  assert.deepEqual(actions, []);
});

test("an initializing lane is never nudged; its first prompt is retried instead", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: false,
    providers: PROVIDERS,
    lanes: [
      lane({
        id: "L1",
        state: "initializing",
        lastUserMessageAt: null,
        lastActionKind: "create_failed",
      }),
      lane({
        id: "L2",
        state: "not_created",
        assignedProvider: null,
      }),
    ],
  });

  assert.deepEqual(actions, [
    { type: "prompt", laneId: "L1", provider: "primary" },
  ]);
});

test("an initializing lane is not re-prompted unless the first send failed", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: false,
    providers: PROVIDERS,
    lanes: [
      lane({
        id: "L1",
        state: "initializing",
        lastUserMessageAt: null,
        lastActionKind: "create",
      }),
      lane({
        id: "L2",
        state: "not_created",
        assignedProvider: null,
      }),
    ],
  });

  assert.deepEqual(actions, [
    { type: "create", laneId: "L2", provider: "primary" },
  ]);
});

test("a done lane is not nudged and does not occupy a provider slot", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: false,
    providers: PROVIDERS,
    lanes: [
      lane({
        id: "L1",
        state: "done",
        lastUserMessageAt: OLD_USER,
      }),
      lane({
        id: "L2",
        state: "not_created",
        assignedProvider: null,
      }),
    ],
  });

  assert.deepEqual(actions, [
    { type: "create", laneId: "L2", provider: "primary" },
  ]);
});

test("any-provider lanes are created by the first provider with a free slot", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: false,
    providers: PROVIDERS,
    lanes: [
      lane({
        id: "L1",
        provider: "any",
        assignedProvider: null,
        state: "not_created",
      }),
    ],
  });

  assert.deepEqual(actions, [
    { type: "create", laneId: "L1", provider: "primary" },
  ]);
});

test("failed create moves on to the next eligible lane", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: false,
    providers: PROVIDERS,
    failedLaneIds: new Set(["L1"]),
    lanes: [
      lane({
        id: "L1",
        state: "not_created",
        assignedProvider: null,
      }),
      lane({
        id: "L2",
        state: "not_created",
        assignedProvider: null,
      }),
    ],
  });

  assert.deepEqual(actions, [
    { type: "create", laneId: "L2", provider: "primary" },
  ]);
});

test("global pause suppresses every action", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: true,
    providers: PROVIDERS,
    lanes: [
      lane({
        id: "L1",
        state: "paused",
        lastUserMessageAt: OLD_USER,
      }),
    ],
  });
  assert.deepEqual(actions, []);
});

test("nudge is preferred over create when both are eligible", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: false,
    providers: PROVIDERS,
    lanes: [
      lane({
        id: "L1",
        state: "paused",
        lastUserMessageAt: OLD_USER,
      }),
      lane({
        id: "L2",
        state: "not_created",
        assignedProvider: null,
      }),
    ],
  });

  assert.deepEqual(actions, [
    { type: "nudge", laneId: "L1", provider: "primary" },
  ]);
});

test("deriveLaneRuntimeState: working, done, initializing, paused, not created", () => {
  assert.equal(
    deriveLaneRuntimeState({
      workspaceFound: false,
      sessionStatus: null,
      messages: [],
    }).state,
    "not_created"
  );
  assert.equal(
    deriveLaneRuntimeState({
      workspaceFound: true,
      sessionStatus: "idle",
      messages: [],
    }).state,
    "initializing"
  );
  assert.equal(
    deriveLaneRuntimeState({
      workspaceFound: true,
      sessionStatus: "working",
      messages: [],
    }).state,
    "working"
  );
  assert.equal(
    deriveLaneRuntimeState({
      workspaceFound: true,
      sessionStatus: "working",
      messages: [
        {
          type: "user",
          content: "go",
          receivedAt: OLD_USER,
        },
      ],
    }).state,
    "working"
  );
  assert.equal(
    deriveLaneRuntimeState({
      workspaceFound: true,
      sessionStatus: "idle",
      messages: [
        { type: "user", content: "go", receivedAt: OLD_USER },
        {
          type: "assistant",
          content: "Opened https://github.com/example-org/example-repo/pull/12",
          receivedAt: NOW.toISOString(),
        },
      ],
    }).state,
    "done"
  );
  assert.equal(
    deriveLaneRuntimeState({
      workspaceFound: true,
      sessionStatus: "idle",
      messages: [
        { type: "user", content: "go", receivedAt: OLD_USER },
        { type: "assistant", content: "still working", receivedAt: NOW.toISOString() },
      ],
    }).state,
    "paused"
  );
});

test("a PR URL in a tool payload does not mark the lane done", () => {
  const toolEvent = {
    type: "agent",
    content: {
      rawPayload: {
        event: {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "gh pr diff 12",
            text: "https://github.com/example-org/example-repo/pull/12",
          },
        },
      },
    },
    receivedAt: NOW.toISOString(),
  };
  assert.equal(assistantTextFromTranscriptEvent(toolEvent), "");
  assert.equal(
    deriveLaneRuntimeState({
      workspaceFound: true,
      sessionStatus: "idle",
      messages: [
        { type: "userMessage", content: "review the PR", receivedAt: OLD_USER },
        toolEvent,
      ],
    }).state,
    "paused"
  );
});

test("a PR URL in the last assistant text of an idle turn marks the lane done", () => {
  const agentEvent = {
    type: "agent",
    content: {
      rawPayload: {
        event: {
          type: "item.completed",
          item: {
            type: "text",
            text: "Opened https://github.com/example-org/example-repo/pull/12",
          },
        },
      },
    },
    receivedAt: NOW.toISOString(),
  };
  assert.match(
    assistantTextFromTranscriptEvent(agentEvent),
    /example-org\/example-repo\/pull\/12/
  );
  assert.equal(
    deriveLaneRuntimeState({
      workspaceFound: true,
      sessionStatus: "idle",
      messages: [
        { type: "user", content: "go", receivedAt: OLD_USER },
        agentEvent,
      ],
    }).state,
    "done"
  );
});

test("a PR URL in Codex reasoning text does not mark the lane done", () => {
  const reasoningEvent = {
    type: "agent",
    content: {
      rawPayload: {
        type: "item.completed",
        item: {
          type: "reasoning",
          text: "Inspecting https://github.com/example-org/example-repo/pull/41 before replying",
        },
      },
    },
    receivedAt: NOW.toISOString(),
  };
  assert.equal(assistantTextFromTranscriptEvent(reasoningEvent), "");
  assert.equal(
    deriveLaneRuntimeState({
      workspaceFound: true,
      sessionStatus: "idle",
      messages: [
        { type: "user", content: "review the PR", receivedAt: OLD_USER },
        reasoningEvent,
      ],
    }).state,
    "paused"
  );
});

test("a working lane with an empty transcript is not prompted", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: false,
    providers: PROVIDERS,
    lanes: [
      lane({
        id: "L1",
        state: "working",
        lastUserMessageAt: null,
        lastActionKind: "create_failed",
      }),
    ],
  });
  assert.deepEqual(actions, []);
});

test("maxNudges also caps retries of a failed first prompt", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: false,
    providers: [{ name: "primary", gapHours: 4.5, maxActive: 1, maxNudges: 2 }],
    lanes: [
      lane({
        id: "L1",
        state: "initializing",
        lastActionKind: "prompt_failed",
        promptFailedCount: 2,
      }),
      lane({
        id: "L2",
        state: "not_created",
        assignedProvider: null,
      }),
    ],
  });
  assert.deepEqual(actions, [
    { type: "create", laneId: "L2", provider: "primary" },
  ]);
});

test("an unknown session status is not nudged", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: false,
    providers: PROVIDERS,
    lanes: [
      lane({
        id: "L1",
        state: "unknown",
        lastUserMessageAt: OLD_USER,
      }),
    ],
  });
  assert.deepEqual(actions, []);
});

test("maxNudges stops a paused lane from being nudged forever", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: false,
    providers: [{ name: "primary", gapHours: 4.5, maxActive: 1, maxNudges: 2 }],
    lanes: [
      lane({
        id: "L1",
        state: "paused",
        lastUserMessageAt: OLD_USER,
        nudgeCount: 2,
      }),
      lane({
        id: "L2",
        state: "not_created",
        assignedProvider: null,
      }),
    ],
  });
  assert.deepEqual(actions, [
    { type: "create", laneId: "L2", provider: "primary" },
  ]);
});

test("an any-provider lane without a name prefix still occupies a slot via last action", () => {
  const actions = decideLaneActions({
    now: NOW,
    paused: false,
    providers: PROVIDERS,
    lanes: [
      lane({
        id: "L1",
        provider: "any",
        assignedProvider: "primary",
        state: "paused",
        lastUserMessageAt: OLD_USER,
      }),
    ],
  });
  assert.deepEqual(actions, [
    { type: "nudge", laneId: "L1", provider: "primary" },
  ]);
});

test("workspace names encode lane id and provider", () => {
  const name = laneWorkspaceName("L1", "primary", "Example task");
  assert.equal(name, "[lane:L1:primary] Example task");
  assert.deepEqual(parseLaneWorkspaceName(name), {
    laneId: "L1",
    provider: "primary",
  });
});
