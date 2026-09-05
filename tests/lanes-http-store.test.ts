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
    approvalKey: "different-human-key",
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
  const workerHeaders = new Headers(requests[0].init.headers);
  assert.equal(workerHeaders.get("x-api-key"), "service-key");
  assert.equal(workerHeaders.get("x-belong-approval-key"), null);
  assert.match(requests[1].url, /notifications\/claim$/);
  assert.equal(requests[1].body?.expected_controller_version, 7);
  const controlHeaders = new Headers(requests[2].init.headers);
  assert.equal(controlHeaders.get("x-api-key"), "service-key");
  assert.equal(controlHeaders.get("x-belong-approval-key"), "different-human-key");
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
