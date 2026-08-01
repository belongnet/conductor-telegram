import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// getSessionMessagesAfter touches the bot store (cursor reset on re-anchor)
// and must never see a real Conductor desktop DB.
const TEMP_DIR = mkdtempSync(path.join(os.tmpdir(), "ct-poll-recovery-"));
process.env.DB_PATH = path.join(TEMP_DIR, "bot.db");
process.env.CONDUCTOR_DB_PATH = path.join(TEMP_DIR, "no-conductor.db");
process.env.CONDUCTOR_API_KEY = "test-key";
process.env.CONDUCTOR_API_BASE_URL = "https://conductor.test";
process.env.CONDUCTOR_CLOUD_BACKEND = "api";
process.env.CONDUCTOR_API_MAX_RETRIES = "0";

import { getSessionMessagesAfter } from "../src/bot/launcher.js";
import { closeDb } from "../src/store/db.js";

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
  closeDb();
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

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
    content: { role: "assistant", content: `payload ${id}` },
    receivedAt: "2026-07-31T00:00:00.000Z",
  };
}

/**
 * Route the env-built client's fetch by pathname + whether the transcript
 * listing carries the dead `after` cursor. The client captures
 * globalThis.fetch at construction, which happens inside the call under test.
 */
function stubFetch(sessionId: string, tail: ReturnType<typeof apiMessage>[]): {
  calls: string[];
} {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    calls.push(`${parsed.pathname}${parsed.search}`);
    if (parsed.pathname === `/v0/sessions/${sessionId}/messages`) {
      if (parsed.searchParams.get("after")) {
        return json({ userMessage: "message not found" }, 404);
      }
      return json({ data: tail, offset: 0, hasMore: false });
    }
    if (parsed.pathname.startsWith("/v0/messages/")) {
      return json({ userMessage: "not found" }, 404);
    }
    return json({ userMessage: `unexpected ${parsed.pathname}` }, 599);
  }) as typeof fetch;
  return { calls };
}

test("the cloud poll path re-anchors through recovery and returns the tail", async () => {
  const sessionId = "session-poll-1";
  const { calls } = stubFetch(sessionId, [
    apiMessage("message-5", sessionId, 4),
    apiMessage("message-6", sessionId, 5),
  ]);

  const messages = await getSessionMessagesAfter(sessionId, 900, 25, {
    afterMessageId: "message-dead",
    backendKind: "cloud-api",
  });

  assert.deepEqual(
    messages.map((message) => message.messageId),
    ["message-5", "message-6"]
  );
  // The listing failed, the cursor probe 404ed, and the tail was fetched.
  assert.ok(calls.some((c) => c.includes("after=message-dead")));
  assert.ok(calls.some((c) => c.startsWith("/v0/messages/message-dead")));
});

test("a repeat failure inside the cooldown skips the recovery probes", async () => {
  const sessionId = "session-poll-2";
  const first = stubFetch(sessionId, [apiMessage("message-1", sessionId, 0)]);
  const recovered = await getSessionMessagesAfter(sessionId, 0, 25, {
    afterMessageId: "message-dead",
    backendKind: "cloud-api",
  });
  assert.equal(recovered.length, 1);
  const probesAfterFirst = first.calls.length;

  // Same dead cursor again, straight away: the listing still fails, but the
  // cooldown suppresses the probe fan-out and the poll returns empty.
  const second = stubFetch(sessionId, [apiMessage("message-1", sessionId, 0)]);
  const suppressed = await getSessionMessagesAfter(sessionId, 0, 25, {
    afterMessageId: "message-dead",
    backendKind: "cloud-api",
  });
  assert.deepEqual(suppressed, []);
  assert.equal(second.calls.length, 1, "only the failed listing, no probes");
  assert.ok(probesAfterFirst >= 3);
});
