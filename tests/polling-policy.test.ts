import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceCloudSessionCycle,
  canCompletePolledWorkspace,
  cloudCycleIsInFlight,
  cloudSessionCycleKey,
  chunkTelegramHtmlEntries,
  encodeCloudSessionCycle,
  mapWithConcurrency,
  parseCloudSessionCycle,
  shouldPollTrackedWorkspace,
  CLOUD_CYCLE_PENDING_TTL_MS,
} from "../src/bot/polling-policy.js";

test("cloud completion requires observed work and authoritative idle statuses", () => {
  assert.equal(
    canCompletePolledWorkspace({
      remote: true,
      sessions: [{ status: "idle" }],
      cloudWorkObserved: false,
      cloudWorkPending: true,
    }),
    false
  );
  assert.equal(
    canCompletePolledWorkspace({
      remote: true,
      sessions: [{ status: null }],
      cloudWorkObserved: true,
      cloudWorkPending: false,
    }),
    false
  );
  assert.equal(
    canCompletePolledWorkspace({
      remote: true,
      sessions: [{ status: "idle" }, { status: "idle" }],
      cloudWorkObserved: true,
      cloudWorkPending: false,
    }),
    true
  );
  assert.equal(
    canCompletePolledWorkspace({
      remote: true,
      sessions: [{ status: "idle" }],
      cloudWorkObserved: true,
      cloudWorkPending: true,
    }),
    false
  );
});

test("local completion preserves the existing non-working, non-error policy", () => {
  assert.equal(
    canCompletePolledWorkspace({
      remote: false,
      sessions: [{ status: "idle" }],
      cloudWorkObserved: false,
      cloudWorkPending: false,
    }),
    true
  );
  assert.equal(
    canCompletePolledWorkspace({
      remote: false,
      sessions: [{ status: "working" }],
      cloudWorkObserved: false,
      cloudWorkPending: false,
    }),
    false
  );
  assert.equal(
    canCompletePolledWorkspace({
      remote: false,
      sessions: [{ status: "error" }],
      cloudWorkObserved: false,
      cloudWorkPending: false,
    }),
    false
  );
});

test("cloud cycle keys isolate each Conductor workspace and session", () => {
  assert.equal(
    cloudSessionCycleKey("workspace-1", "session-1"),
    "cloud_session_cycle:workspace-1:session-1"
  );
  assert.notEqual(
    cloudSessionCycleKey("workspace-1", "session-1"),
    cloudSessionCycleKey("workspace-1", "session-2")
  );
});

test("cloud cycles ignore assistant backlog until the exact outbound message appears", () => {
  const pending = {
    phase: "pending" as const,
    outboundMessageId: "message-new",
    baselineRowid: 10,
  };
  const oldAssistant = {
    messageId: "message-old-assistant",
    rowid: 11,
    role: "assistant",
  };

  assert.deepEqual(
    advanceCloudSessionCycle({
      cycle: pending,
      status: "idle",
      messages: [oldAssistant],
    }),
    pending
  );

  const boundary = advanceCloudSessionCycle({
    cycle: pending,
    status: "idle",
    messages: [
      oldAssistant,
      { messageId: "message-new", rowid: 12, role: "user" },
    ],
  });
  assert.deepEqual(boundary, {
    phase: "boundary",
    outboundMessageId: "message-new",
    baselineRowid: 10,
    boundaryRowid: 12,
  });
  assert.equal(cloudCycleIsInFlight(boundary), true);
});

test("cloud cycles require work after their generation boundary", () => {
  const boundary = {
    phase: "boundary" as const,
    outboundMessageId: "message-new",
    boundaryRowid: 12,
  };

  const working = advanceCloudSessionCycle({
    cycle: boundary,
    status: "working",
    messages: [],
  });
  assert.equal(working?.phase, "working");
  assert.equal(cloudCycleIsInFlight(working), true);

  const observed = advanceCloudSessionCycle({
    cycle: working,
    status: "idle",
    messages: [],
  });
  assert.equal(observed?.phase, "observed");
  assert.equal(cloudCycleIsInFlight(observed), false);
  assert.equal(
    canCompletePolledWorkspace({
      remote: true,
      sessions: [{ status: "idle" }],
      cloudWorkObserved: observed?.phase === "observed",
      cloudWorkPending: cloudCycleIsInFlight(observed),
    }),
    true
  );

  assert.equal(
    advanceCloudSessionCycle({
      cycle: boundary,
      status: "idle",
      messages: [
        { messageId: "assistant-new", rowid: 13, role: "assistant" },
      ],
    })?.phase,
    "observed"
  );
});

test("a second cloud generation cannot reuse a prior generation's assistant reply", () => {
  const secondGeneration = {
    phase: "pending" as const,
    outboundMessageId: "message-second",
    baselineRowid: 20,
  };
  assert.deepEqual(
    advanceCloudSessionCycle({
      cycle: secondGeneration,
      status: "idle",
      messages: [
        { messageId: "assistant-first", rowid: 21, role: "assistant" },
      ],
    }),
    secondGeneration
  );
});

test("new-session boundaries observe only subsequent assistant work", () => {
  const observed = advanceCloudSessionCycle({
    cycle: {
      phase: "boundary",
      outboundMessageId: "message-new-session",
    },
    status: "idle",
    messages: [
      { messageId: "assistant-new", rowid: 1, role: "assistant" },
    ],
  });
  assert.equal(observed?.phase, "observed");
});

test("canceling cycles remain in flight until the API confirms termination", () => {
  const canceling = { phase: "canceling" as const };
  assert.equal(
    advanceCloudSessionCycle({
      cycle: canceling,
      status: "working",
      messages: [],
    })?.phase,
    "canceling"
  );
  assert.equal(cloudCycleIsInFlight(canceling), true);

  const complete = advanceCloudSessionCycle({
    cycle: canceling,
    status: "idle",
    messages: [],
  });
  assert.equal(complete?.phase, "complete");
  assert.equal(cloudCycleIsInFlight(complete), false);
});

test("cloud cycle metadata round-trips and rejects invalid values", () => {
  const cycle = {
    phase: "pending" as const,
    outboundMessageId: "message-1",
    baselineRowid: 7,
  };
  assert.deepEqual(parseCloudSessionCycle(encodeCloudSessionCycle(cycle)), cycle);
  assert.deepEqual(parseCloudSessionCycle("observed"), { phase: "observed" });
  assert.equal(parseCloudSessionCycle('{"phase":"unknown"}'), null);
  assert.equal(parseCloudSessionCycle("not-json"), null);
});

test("a pending cycle expires instead of blocking its thread forever", () => {
  const startedAt = 1_000_000;
  const fresh = { phase: "pending" as const, startedAt };
  const justInsideTtl = startedAt + CLOUD_CYCLE_PENDING_TTL_MS;
  const pastTtl = startedAt + CLOUD_CYCLE_PENDING_TTL_MS + 1;

  // A crash between reserving the cycle and recording the outbound id leaves
  // a cycle that can never advance on its own.
  assert.deepEqual(
    advanceCloudSessionCycle({
      cycle: fresh,
      status: "idle",
      messages: [],
      now: justInsideTtl,
    }),
    fresh,
    "must not expire early"
  );
  assert.deepEqual(
    advanceCloudSessionCycle({
      cycle: fresh,
      status: "idle",
      messages: [],
      now: pastTtl,
    }),
    { phase: "complete" }
  );

  // Same when the outbound message never shows up in the transcript.
  const stranded = {
    phase: "pending" as const,
    outboundMessageId: "message-1",
    startedAt,
  };
  assert.deepEqual(
    advanceCloudSessionCycle({
      cycle: stranded,
      status: "idle",
      messages: [{ messageId: "other", rowid: 5, role: "assistant" }],
      now: pastTtl,
    }),
    { phase: "complete" }
  );

  // Real agent work is not on a clock: once past the boundary, a long-running
  // session must stay in flight.
  const working = {
    phase: "working" as const,
    outboundMessageId: "message-1",
    boundaryRowid: 3,
    startedAt,
  };
  assert.equal(
    cloudCycleIsInFlight(
      advanceCloudSessionCycle({
        cycle: working,
        status: "working",
        messages: [],
        now: pastTtl,
      })
    ),
    true
  );

  // Legacy rows have no timestamp and must keep their existing behaviour.
  const legacy = { phase: "pending" as const };
  assert.deepEqual(
    advanceCloudSessionCycle({
      cycle: legacy,
      status: "idle",
      messages: [],
      now: pastTtl,
    }),
    legacy
  );
});

test("session request fan-out is capped", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 50 }, (_, index) => index);
  const results = await mapWithConcurrency(items, 6, async (item) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    return item * 2;
  });

  assert.equal(peak <= 6, true, `peak concurrency was ${peak}`);
  // Order must follow the input, not completion.
  assert.deepEqual(results, items.map((item) => item * 2));
  assert.deepEqual(await mapWithConcurrency([], 6, async () => 1), []);
});

test("completed and failed cloud workspaces remain observable", () => {
  for (const status of ["starting", "running", "done", "failed", "stopped"]) {
    assert.equal(
      shouldPollTrackedWorkspace({ status, cloudOnly: true }),
      true,
      status
    );
  }
  assert.equal(
    shouldPollTrackedWorkspace({ status: "archived", cloudOnly: true }),
    false
  );
});

test("an oversized recovery notice is truncated rather than dropped", () => {
  const entries = [
    { id: "small", html: "<pre>ok</pre>" },
    { id: "huge", html: `<pre>${"x".repeat(9_000)}</pre>` },
    { id: "after", html: "<pre>later</pre>" },
  ];
  const chunks = chunkTelegramHtmlEntries(entries);
  const flat = chunks.flat();

  // Every notice still has to be published; the outbox only clears the ones
  // that were delivered, so silently dropping one would strand it forever.
  assert.deepEqual(flat.map((entry) => entry.id), ["small", "huge", "after"]);
  const huge = flat.find((entry) => entry.id === "huge");
  assert.ok(huge!.html.length <= 3_500);
  assert.ok(huge!.html.endsWith("</pre>"));
  for (const chunk of chunks) {
    assert.ok(chunk.map((entry) => entry.html).join("\n\n").length <= 3_500);
  }
});

test("recovery notice backlogs are chunked below Telegram's text limit", () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({
    id: `notice-${index}`,
    html: `<pre>${"x".repeat(490)}</pre>`,
  }));
  const chunks = chunkTelegramHtmlEntries(entries);

  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat().map((entry) => entry.id), entries.map((entry) => entry.id));
  for (const chunk of chunks) {
    assert.ok(
      chunk.map((entry) => entry.html).join("\n\n").length <= 3_500
    );
  }
});
