import assert from "node:assert/strict";
import test from "node:test";
import { HttpLaneStateStore } from "../src/lanes/state-store-http.js";
import { LaneStateStoreError } from "../src/lanes/state-store.js";

const lease = {
  lease_name: "growth",
  lease_token: "lease-token",
  fence: 9,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("HTTP state store carries fence/CAS fields and keeps human approval separate", async () => {
  const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> | null }> = [];
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), init, body });
    if (String(url).endsWith("/controls")) {
      return jsonResponse({
        control_id: "control-1",
        idempotency_key: "once",
        kind: "cutover",
        lane_id: null,
        requested_by: "human:test",
        payload_json: { revision_id: "v2" },
        status: "pending",
        human_approved: true,
        row_version: 1,
      });
    }
    return jsonResponse({ run_id: "run-1", row_version: 4 });
  };
  const store = new HttpLaneStateStore({
    baseUrl: "https://command.example.test/",
    apiKey: "service-key",
    fetchImpl,
  });
  await store.transitionRun(lease, "run/one", {
    expected_version: 3,
    from_status: "queued",
    to_status: "implementing",
    stage: "implementation",
    patch: {},
  });
  await store.claimNotification(lease, {
    notification_key: "daily:2026-09-04",
    message_hash: "a".repeat(64),
    expected_controller_version: 7,
  });
  await store.createControl({
    control_id: "control-1",
    idempotency_key: "once",
    kind: "cutover",
    requested_by: "human:test",
    payload: { revision_id: "v2" },
    approval: { channelKey: "approval-channel-key", grant: "emailed-code-grant" },
  });
  assert.match(requests[0].url, /runs\/run%2Fone\/transition$/);
  assert.deepEqual(
    {
      lease_name: requests[0].body?.lease_name,
      lease_token: requests[0].body?.lease_token,
      fence: requests[0].body?.fence,
      expected_version: requests[0].body?.expected_version,
    },
    { ...lease, expected_version: 3 }
  );
  for (const request of requests.slice(0, 2)) {
    const workerHeaders = new Headers(request.init.headers);
    assert.equal(workerHeaders.get("x-api-key"), "service-key");
    assert.equal(workerHeaders.get("x-belong-approval-channel-key"), null);
    assert.equal(workerHeaders.get("x-belong-approval-grant"), null);
  }
  assert.match(requests[1].url, /notifications\/claim$/);
  assert.equal(requests[1].body?.expected_controller_version, 7);
  const controlHeaders = new Headers(requests[2].init.headers);
  assert.equal(controlHeaders.get("x-api-key"), "service-key");
  assert.equal(controlHeaders.get("x-belong-approval-channel-key"), "approval-channel-key");
  assert.equal(controlHeaders.get("x-belong-approval-grant"), "emailed-code-grant");
  assert.equal(controlHeaders.get("x-belong-approval-key"), null, "the retired header is never sent");
  assert.equal(requests[2].body?.approval, undefined, "approval travels in headers, never in the body");
  assert.doesNotMatch(String(requests[2].init.body), /emailed-code-grant|approval-channel-key/);
});

test("a control without a live grant surfaces Command Center's fresh-code refusal", async () => {
  const store = new HttpLaneStateStore({
    baseUrl: "https://command.example.test",
    apiKey: "service-key",
    fetchImpl: async () => jsonResponse({ detail: "A fresh approval code is required" }, 401),
  });
  const error = await store
    .createControl({
      control_id: "c",
      idempotency_key: "c",
      kind: "rollback",
      requested_by: "telegram:1",
      approval: { channelKey: "approval-channel-key", grant: "expired-grant" },
    })
    .catch((caught: unknown) => caught);
  assert.ok(error instanceof LaneStateStoreError);
  assert.equal(error.status, 401);
  assert.equal(error.freshApprovalRequired, true);
  const otherRefusal = new LaneStateStoreError("rejected", 401, {
    detail: "The approval key is retired; approve with an emailed code",
  });
  assert.equal(otherRefusal.freshApprovalRequired, false);
});

test("HTTP lease contention returns standby while outages fail closed without retry", async () => {
  let calls = 0;
  const conflictStore = new HttpLaneStateStore({
    baseUrl: "https://command.example.test",
    apiKey: "service-key",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ detail: "lease held" }, 409);
    },
  });
  assert.equal(
    await conflictStore.claimLease({ ownerId: "ovh:standby", ownerSite: "ovh", leaseSeconds: 75 }),
    null
  );
  assert.equal(calls, 1);

  const outageStore = new HttpLaneStateStore({
    baseUrl: "https://command.example.test",
    apiKey: "service-key",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("database path unavailable");
    },
  });
  const before = calls;
  await assert.rejects(
    outageStore.snapshot(),
    (error: unknown) =>
      error instanceof LaneStateStoreError &&
      /failed closed/.test(error.message) &&
      !error.conflict
  );
  assert.equal(calls, before + 1, "state writes/reads are not silently retried or redirected");
});

test("HTTP incremental snapshots encode the event cursor", async () => {
  let requested = "";
  const store = new HttpLaneStateStore({
    baseUrl: "https://command.example.test",
    apiKey: "service-key",
    fetchImpl: async (url) => {
      requested = String(url);
      return jsonResponse({
        manifest: null,
        controller: null,
        lease: null,
        capacity: {},
        providers: [],
        runs: [],
        attempts: [],
        ambiguous_actions: [],
        pending_actions: [],
        pending_controls: [],
        dependencies: {},
        duplicates: [],
        events: [],
        next_event_seq: 42,
      });
    },
  });
  const snapshot = await store.snapshot(41);
  assert.match(requested, /since_event_seq=41$/);
  assert.equal(snapshot.next_event_seq, 42);
});

test("a redirect never carries the service key or the approval headers to another server", async () => {
  const { createServer } = await import("node:http");
  const seen: Array<{ method?: string; url?: string; headers: Record<string, unknown> }> = [];
  const elsewhere = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, headers: request.headers });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${(elsewhere.address() as { port: number }).port}`;
  let status = 307;
  const commandCenter = createServer((request, response) => {
    response.writeHead(status, { location: `${target}${request.url}` });
    response.end();
  });
  await new Promise<void>((resolve) => commandCenter.listen(0, "127.0.0.1", resolve));
  try {
    const store = new HttpLaneStateStore({
      baseUrl: `http://127.0.0.1:${(commandCenter.address() as { port: number }).port}`,
      apiKey: "service-key",
    });
    for (const code of [307, 308, 302, 301]) {
      status = code;
      const control = await store
        .createControl({
          control_id: `c-${code}`,
          idempotency_key: `c-${code}`,
          kind: "cutover",
          requested_by: "telegram:1",
          payload: { revision_id: "v2" },
          approval: { channelKey: "approval-channel-key", grant: "emailed-code-grant" },
        })
        .catch((error: unknown) => error);
      assert.ok(control instanceof LaneStateStoreError, `${code} on /controls fails closed`);
      assert.match(control.message, /failed closed/);
      const snapshot = await store.snapshot().catch((error: unknown) => error);
      assert.ok(snapshot instanceof LaneStateStoreError, `${code} on /status fails closed`);
    }
    assert.deepEqual(seen, [], "the second server never sees a request");
  } finally {
    await new Promise<void>((resolve) => commandCenter.close(() => resolve()));
    await new Promise<void>((resolve) => elsewhere.close(() => resolve()));
  }
});

test("every lane request refuses redirects, caps the body and bounds Command Center's words", async () => {
  const inits: RequestInit[] = [];
  let reply: () => Response = () => jsonResponse({ ok: true });
  const store = new HttpLaneStateStore({
    baseUrl: "https://command.example.test",
    apiKey: "service-key",
    maxResponseBytes: 64 * 1024,
    fetchImpl: async (_url, init = {}) => {
      inits.push(init);
      return reply();
    },
  });
  await store.snapshot();
  await store.releaseLease(lease);
  await store.createControl({
    control_id: "c",
    idempotency_key: "c",
    kind: "rollback",
    requested_by: "telegram:1",
    approval: { channelKey: "approval-channel-key", grant: "emailed-code-grant" },
  });
  assert.ok(inits.length === 3 && inits.every((init) => init.redirect === "error"));

  reply = () => new Response(null, { status: 307, headers: { location: "https://elsewhere.test/" } });
  const redirected = await store.snapshot().catch((error: unknown) => error);
  assert.ok(redirected instanceof LaneStateStoreError);
  assert.match(redirected.message, /redirect refused \(HTTP 307\)/);

  let cancelled = false;
  reply = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode(" ".repeat(8192)));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 }
    );
  const endless = await store.snapshot().catch((error: unknown) => error);
  assert.ok(endless instanceof LaneStateStoreError);
  assert.match(endless.message, /unreadable or too large/);
  assert.equal(cancelled, true, "reading stops at the cap");

  const rlo = String.fromCharCode(0x202e);
  const noisy = `line one\n${rlo}${"x".repeat(10_000)}`;
  reply = () => jsonResponse({ detail: noisy }, 409);
  const conflict = await store.snapshot().catch((error: unknown) => error);
  assert.ok(conflict instanceof LaneStateStoreError);
  assert.equal(conflict.status, 409);
  assert.ok(conflict.message.length <= 260, `bounded, got ${conflict.message.length}`);
  assert.ok(!conflict.message.includes("\n") && !conflict.message.includes(rlo), "no line breaks or bidi controls");
  assert.match(conflict.message, /^Command Center lane request rejected: line one x+…$/);
  assert.equal((conflict.body as { detail: string }).detail, noisy, "the body itself is kept for callers");
});
