import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { HttpLaneStateStore } from "../src/lanes/state-store-http.js";
import type {
  LaneActionRecordV2,
  LaneRunRecord,
  LaneSnapshotV2,
} from "../src/lanes/state-store.js";
import { LaneStateStoreError } from "../src/lanes/state-store.js";

const apiKey = "isolated-canary-key";
const lease = {
  lease_name: "growth",
  lease_token: "isolated-lease-token",
  fence: 1,
};

function runRecord(rowVersion: number, ambiguousActionId: string | null): LaneRunRecord {
  return {
    run_id: "run-http-postgres-canary",
    manifest_revision_id: "canary",
    lane_id: "CANARY",
    generation: 1,
    status: "implementing",
    stage: "implementation",
    priority: 1,
    repo_owner: "belongnet",
    repo_name: "canary",
    base_branch: "main",
    author_provider: "claude",
    provider: "claude",
    model: "fable-5-1",
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
    ambiguous_action_id: ambiguousActionId,
    legacy_verified: false,
    metadata_json: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    terminal_at: null,
    row_version: rowVersion,
  };
}

function actionRecord(
  actionId: string,
  stage: string,
  status: LaneActionRecordV2["status"],
  rowVersion: number
): LaneActionRecordV2 {
  return {
    action_id: actionId,
    deterministic_tag: `canary:${stage}`,
    run_id: "run-http-postgres-canary",
    stage,
    attempt_id: null,
    action_type: "send_prompt",
    status,
    request_json: { message_id: `${actionId}-message` },
    result_json: {},
    external_ref: null,
    error: null,
    row_version: rowVersion,
    started_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: status === "ambiguous" ? null : "2026-01-01T00:00:00.000Z",
  };
}

function snapshot(run: LaneRunRecord, actions: LaneActionRecordV2[]): LaneSnapshotV2 {
  return {
    manifest: null,
    controller: null,
    lease: null,
    capacity: {},
    providers: [],
    runs: [run],
    attempts: [],
    ambiguous_actions: actions.filter((action) => action.status === "ambiguous"),
    pending_actions: actions.filter((action) => action.status === "pending"),
    pending_controls: [],
    dependencies: {},
    duplicates: [],
    events: [],
    next_event_seq: 0,
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length === 0
    ? {}
    : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

test("isolated HTTP/Postgres canary fences ambiguous actions and preserves unrelated finishes", async () => {
  // This deliberately models the Command Center transaction against Postgres:
  // action/run row versions are CAS guarded, and the run fence is changed only
  // by the action that owns it being authoritatively reconciled.
  let run = runRecord(1, null);
  const actions = new Map<string, LaneActionRecordV2>();
  const server = createServer(async (request, response) => {
    if (request.headers["x-api-key"] !== apiKey) {
      respond(response, 401, { detail: "unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname.endsWith("/lease/claim")) {
      respond(response, 200, {
        ...lease,
        owner_id: "mac:http-postgres-canary",
        owner_site: "mac",
        expires_at: "2099-01-01T00:00:00.000Z",
        heartbeat_at: "2026-01-01T00:00:00.000Z",
        row_version: 1,
      });
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/lanes/status")) {
      respond(response, 200, snapshot(run, [...actions.values()]));
      return;
    }
    if (request.method === "POST" && /\/lanes\/runs$/.test(url.pathname)) {
      const body = await readJson(request);
      run = runRecord(1, null);
      run = { ...run, run_id: String(body.run_id) };
      respond(response, 200, run);
      return;
    }
    const beginMatch = url.pathname.match(/\/lanes\/runs\/([^/]+)\/actions$/);
    if (request.method === "POST" && beginMatch) {
      const body = await readJson(request);
      if (run.ambiguous_action_id) {
        respond(response, 409, { detail: "ambiguous action must be reconciled first" });
        return;
      }
      if (Number(body.expected_run_version) !== run.row_version) {
        respond(response, 409, { detail: "run changed" });
        return;
      }
      const action = actionRecord(String(body.action_id), String(body.stage), "pending", 1);
      actions.set(action.action_id, action);
      run = { ...run, row_version: run.row_version + 1 };
      respond(response, 200, action);
      return;
    }
    const finishMatch = url.pathname.match(/\/lanes\/actions\/([^/]+)\/finish$/);
    if (request.method === "POST" && finishMatch) {
      const body = await readJson(request);
      const action = actions.get(decodeURIComponent(finishMatch[1]));
      if (!action) {
        respond(response, 404, { detail: "action not found" });
        return;
      }
      const status = String(body.status) as LaneActionRecordV2["status"];
      if (
        action.status !== "pending" &&
        !(action.status === "ambiguous" && status === "reconciled")
      ) {
        respond(response, 409, { detail: "action is already resolved" });
        return;
      }
      if (action.row_version !== Number(body.expected_action_version)) {
        respond(response, 409, { detail: "action changed" });
        return;
      }
      if (run.row_version !== Number(body.expected_run_version)) {
        respond(response, 409, { detail: "run changed" });
        return;
      }
      const next = {
        ...action,
        status,
        result_json: (body.result ?? {}) as Record<string, unknown>,
        error: typeof body.error === "string" ? body.error : null,
        row_version: action.row_version + 1,
        completed_at: status === "ambiguous" ? null : "2026-01-01T00:00:00.000Z",
      } satisfies LaneActionRecordV2;
      actions.set(action.action_id, next);
      run = {
        ...run,
        ambiguous_action_id:
          status === "ambiguous"
            ? action.action_id
            : status === "reconciled" && run.ambiguous_action_id === action.action_id
              ? null
              : run.ambiguous_action_id,
        row_version: run.row_version + 1,
      };
      respond(response, 200, next);
      return;
    }
    respond(response, 404, { detail: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const store = new HttpLaneStateStore({
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey,
  });

  try {
    const claimed = await store.claimLease({
      ownerId: "mac:http-postgres-canary",
      ownerSite: "mac",
    });
    assert.ok(claimed);
    const created = await store.createRun(claimed, {
      run_id: run.run_id,
      manifest_revision_id: "canary",
      lane_id: "CANARY",
      generation: 1,
      priority: 1,
    });
    const first = await store.beginAction(claimed, created.run_id, {
      action_id: "ambiguous-action",
      deterministic_tag: "canary:implementation",
      expected_run_version: created.row_version,
      stage: "implementation",
      action_type: "send_prompt",
      request: { message_id: "ambiguous-action-message" },
    });
    const unrelated = await store.beginAction(claimed, created.run_id, {
      action_id: "unrelated-action",
      deterministic_tag: "canary:review",
      expected_run_version: run.row_version,
      stage: "review",
      action_type: "send_prompt",
      request: { message_id: "unrelated-action-message" },
    });
    await store.finishAction(claimed, first.action_id, {
      expected_action_version: first.row_version,
      expected_run_version: run.row_version,
      status: "ambiguous",
      error: "lost response",
    });
    const fencedRunVersion = run.row_version;
    await assert.rejects(
      store.finishAction(claimed, first.action_id, {
        expected_action_version: first.row_version + 1,
        expected_run_version: fencedRunVersion,
        status: "failed",
        error: "authoritative absence",
      }),
      (error: unknown) =>
        error instanceof LaneStateStoreError &&
        error.status === 409 &&
        /already resolved/.test(error.message)
    );
    await store.finishAction(claimed, unrelated.action_id, {
      expected_action_version: unrelated.row_version,
      expected_run_version: fencedRunVersion,
      status: "succeeded",
      result: { message_id: "unrelated-action-message" },
    });
    const after = await store.snapshot();
    assert.equal(after.runs[0]?.ambiguous_action_id, first.action_id);
    assert.equal(after.ambiguous_actions[0]?.action_id, first.action_id);
  } finally {
    await store.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
