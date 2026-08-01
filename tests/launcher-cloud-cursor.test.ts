import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// A successful re-anchor clears the persisted thread-cursor anchor through the
// bot store, so give this whole file a throwaway database before anything can
// lazily open the real one.
const TEMP_DIR = mkdtempSync(path.join(os.tmpdir(), "ct-cloud-cursor-"));
process.env.DB_PATH = path.join(TEMP_DIR, "bot.db");

import { recoverCloudTranscriptCursor } from "../src/bot/launcher.js";
import {
  ConductorApiClient,
  ConductorApiError,
} from "../src/integrations/conductor-api.js";
import {
  closeDb,
  getDb,
} from "../src/store/db.js";
import {
  createWorkspace,
  getThreadCursor,
  upsertThreadCursor,
} from "../src/store/queries.js";

after(() => {
  closeDb();
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

const SESSION = "session-1";

/** The listing failure that makes the poller consider cursor recovery. */
function deadListingError(): ConductorApiError {
  return new ConductorApiError(
    "Conductor API request failed (404): message not found",
    404,
    false
  );
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiMessage(id: string, sessionId: string, sessionIndex: number) {
  return {
    id,
    sessionId,
    sessionIndex,
    type: "message",
    content: { role: "assistant", content: "done" },
    receivedAt: "2026-07-30T00:00:00.000Z",
  };
}

/**
 * Real ConductorApiClient over an injected fetcher (the conductor-api test
 * seam), routed by pathname. Requests outside `routes` fail loudly via a 599
 * so a test never silently exercises an unexpected endpoint.
 */
function clientWith(routes: Record<string, () => Response>): {
  client: ConductorApiClient;
  calls: string[];
} {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    const route = routes[pathname];
    return route
      ? route()
      : json({ error: `unexpected request: ${pathname}` }, 599);
  }) as typeof fetch;
  const client = new ConductorApiClient(
    {
      baseUrl: "https://conductor.test",
      apiKey: "api-key",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
    fetcher
  );
  return { client, calls };
}

test("only non-retryable API listing failures trigger cursor recovery", async () => {
  const { client, calls } = clientWith({});

  // No established cursor: nothing to recover.
  assert.equal(
    await recoverCloudTranscriptCursor(client, SESSION, null, deadListingError()),
    null
  );
  assert.equal(
    await recoverCloudTranscriptCursor(client, SESSION, undefined, deadListingError()),
    null
  );
  // Retryable server trouble is an outage, not a dead cursor.
  assert.equal(
    await recoverCloudTranscriptCursor(
      client,
      SESSION,
      "message-1",
      new ConductorApiError("upstream flake", 503, true)
    ),
    null
  );
  // Status-less failures are network-shaped; the cursor may be fine.
  assert.equal(
    await recoverCloudTranscriptCursor(
      client,
      SESSION,
      "message-1",
      new ConductorApiError("socket hang up", null, false)
    ),
    null
  );
  // Non-API errors never reclassify the cursor.
  assert.equal(
    await recoverCloudTranscriptCursor(client, SESSION, "message-1", new Error("boom")),
    null
  );

  assert.deepEqual(calls, [], "recovery probes must not run for these failures");
});

test("a cursor that still resolves in its session is left untouched", async () => {
  const resolving = clientWith({
    "/v0/messages/message-1": () => json(apiMessage("message-1", SESSION, 5)),
  });
  assert.equal(
    await recoverCloudTranscriptCursor(
      resolving.client,
      SESSION,
      "message-1",
      deadListingError()
    ),
    null
  );
  assert.deepEqual(resolving.calls, ["/v0/messages/message-1"]);

  // A transient failure while probing the cursor must not count as "gone".
  const flaky = clientWith({
    "/v0/messages/message-1": () => json({ error: "upstream" }, 503),
  });
  assert.equal(
    await recoverCloudTranscriptCursor(
      flaky.client,
      SESSION,
      "message-1",
      deadListingError()
    ),
    null
  );
  assert.deepEqual(flaky.calls, ["/v0/messages/message-1"]);
});

test("a dead cursor re-anchors the poll at the latest transcript message", async () => {
  const gone = clientWith({
    "/v0/messages/message-dead": () => json({ error: "message not found" }, 404),
    [`/v0/sessions/${SESSION}/messages`]: () =>
      json({
        data: [
          apiMessage("message-7", SESSION, 6),
          apiMessage("message-8", SESSION, 7),
        ],
        offset: 0,
        hasMore: false,
      }),
  });
  const recovered = await recoverCloudTranscriptCursor(
    gone.client,
    SESSION,
    "message-dead",
    deadListingError()
  );
  assert.ok(recovered, "a deleted cursor message must re-anchor the poll");
  // The whole transcript tail is delivered, not just the newest message, so
  // replies posted before recovery ran still reach Telegram.
  assert.deepEqual(
    recovered.map((message) => message.messageId),
    ["message-7", "message-8"]
  );
  assert.equal(recovered[1].rowid, 7);
  assert.equal(recovered[1].role, "assistant");

  // A cursor that now resolves into a different session is equally dead.
  const moved = clientWith({
    "/v0/messages/message-moved": () =>
      json(apiMessage("message-moved", "session-other", 3)),
    [`/v0/sessions/${SESSION}/messages`]: () =>
      json({
        data: [apiMessage("message-9", SESSION, 9)],
        offset: 0,
        hasMore: false,
      }),
  });
  const reanchored = await recoverCloudTranscriptCursor(
    moved.client,
    SESSION,
    "message-moved",
    deadListingError()
  );
  assert.equal(reanchored?.length, 1);
  assert.equal(reanchored?.[0]?.messageId, "message-9");
});

test("re-anchoring resets a persisted cursor that sits ahead of the rebuilt transcript", async () => {
  // Transcript rebuilds can hand out fresh ids with LOWER session indexes
  // than the stored position, and upsertThreadCursor never moves a cloud
  // cursor backwards — so recovery must clear the anchor for the forwarded
  // re-anchor to persist.
  closeDb();
  getDb(process.env.DB_PATH);
  const workspace = createWorkspace({
    name: "cloud-ws",
    prompt: "p",
    repoPath: "conductor-cloud://proj",
    telegramChatId: "chat-1",
  });
  const sessionId = "session-rebuilt";
  upsertThreadCursor({
    workspaceId: workspace.id,
    sessionId,
    backendKind: "cloud-api",
    lastForwardedRowid: 900,
    lastMessageId: "message-dead",
  });

  const rebuilt = clientWith({
    "/v0/messages/message-dead": () => json({ error: "not found" }, 404),
    [`/v0/sessions/${sessionId}/messages`]: () =>
      json({
        data: [apiMessage("message-new", sessionId, 2)],
        offset: 0,
        hasMore: false,
      }),
  });
  const recovered = await recoverCloudTranscriptCursor(
    rebuilt.client,
    sessionId,
    "message-dead",
    deadListingError()
  );
  assert.equal(recovered?.[0]?.messageId, "message-new");

  const cleared = getThreadCursor(workspace.id, sessionId);
  assert.equal(cleared?.lastMessageId, null);
  assert.equal(cleared?.lastForwardedRowid, 0);

  // The poll loop's normal persistence of the re-anchored message now sticks
  // even though its rowid (2) is far below the old position (900).
  upsertThreadCursor({
    workspaceId: workspace.id,
    sessionId,
    backendKind: "cloud-api",
    lastForwardedRowid: 2,
    lastMessageId: "message-new",
  });
  const healed = getThreadCursor(workspace.id, sessionId);
  assert.equal(healed?.lastMessageId, "message-new");
  assert.equal(healed?.lastForwardedRowid, 2);
});

test("re-anchoring fails closed on empty transcripts and API outages", async () => {
  // Cursor gone and the transcript is now empty: re-anchor to "nothing yet"
  // (an empty batch) rather than stalling on the dead cursor.
  const empty = clientWith({
    "/v0/messages/message-dead": () => json({ error: "not found" }, 404),
    [`/v0/sessions/${SESSION}/messages`]: () =>
      json({ data: [], offset: 0, hasMore: false }),
  });
  assert.deepEqual(
    await recoverCloudTranscriptCursor(
      empty.client,
      SESSION,
      "message-dead",
      deadListingError()
    ),
    []
  );

  // If the latest-message fetch itself fails, keep the old cursor: an outage
  // must never masquerade as a dead cursor.
  const outage = clientWith({
    "/v0/messages/message-dead": () => json({ error: "not found" }, 404),
    [`/v0/sessions/${SESSION}/messages`]: () => json({ error: "upstream" }, 503),
  });
  assert.equal(
    await recoverCloudTranscriptCursor(
      outage.client,
      SESSION,
      "message-dead",
      deadListingError()
    ),
    null
  );
});
