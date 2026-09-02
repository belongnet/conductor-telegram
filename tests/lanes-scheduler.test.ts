import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_DIR = mkdtempSync(path.join(os.tmpdir(), "ct-lanes-sched-"));
process.env.DB_PATH = path.join(TEMP_DIR, "bot.db");
process.env.CONDUCTOR_DB_PATH = path.join(TEMP_DIR, "no-conductor.db");
process.env.CONDUCTOR_SETTINGS_PATH = path.join(TEMP_DIR, "no-settings.toml");
process.env.CONDUCTOR_API_KEY = "test-key";
process.env.CONDUCTOR_API_BASE_URL = "https://conductor.test";
process.env.CONDUCTOR_CLOUD_BACKEND = "api";
process.env.CONDUCTOR_API_MAX_RETRIES = "0";
process.env.LANES_CONFIG = path.join(TEMP_DIR, "lanes.json");
process.env.OWNER_CHAT_ID = "424242";

import {
  LaneWorkspaceIndexError,
  executeLaneAction,
  loadWorkspaceIndex,
  runLanesTick,
} from "../src/lanes/scheduler.js";
import { handleLanes } from "../src/bot/commands.js";
import {
  ConductorApiClient,
} from "../src/integrations/conductor-api.js";
import { closeDb, getDb } from "../src/store/db.js";
import {
  getLatestLaneAction,
  isLanesPaused,
  setLanesLastTickAt,
  setLanesPaused,
} from "../src/store/queries.js";
import type { LanesConfig } from "../src/lanes/config.js";

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
  closeDb();
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

mkdirSync(path.join(TEMP_DIR, "prompts"), { recursive: true });
writeFileSync(path.join(TEMP_DIR, "prompts", "l1.md"), "Do the example work.");
writeFileSync(
  path.join(TEMP_DIR, "lanes.json"),
  JSON.stringify({
    intervalMinutes: 30,
    providers: {
      primary: {
        agent: "claude",
        model: "claude-example-model",
        effort: "high",
        gapHours: 4.5,
        maxActive: 1,
      },
    },
    lanes: [
      {
        id: "L1",
        title: "Example first lane",
        provider: "primary",
        repoUrl: "https://github.com/example-org/example-repo",
        prompt: "prompts/l1.md",
      },
    ],
  })
);

function config(): ConstructorParameters<typeof ConductorApiClient>[0] {
  return {
    baseUrl: "https://conductor.test",
    apiKey: "api-key",
    timeoutMs: 1_000,
    maxRetries: 0,
  };
}

function lanesConfig(): LanesConfig {
  return {
    intervalMinutes: 30,
    providers: {
      primary: {
        agent: "claude",
        model: "claude-example-model",
        effort: "high",
        gapHours: 4.5,
        maxActive: 1,
        maxNudges: 8,
      },
    },
    lanes: [
      {
        id: "L1",
        title: "Example first lane",
        provider: "primary",
        repoUrl: "https://github.com/example-org/example-repo",
        prompt: "prompts/l1.md",
        after: [],
      },
    ],
    configPath: path.join(TEMP_DIR, "lanes.json"),
  };
}

function resetLanesDb(): void {
  const db = getDb();
  db.exec("DELETE FROM lane_actions");
  db.exec("DELETE FROM meta WHERE key LIKE 'lanes_%'");
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function workspacePage(entries: Array<{ id: string; name: string }>) {
  return {
    data: entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      createdAt: "2026-09-01T00:00:00.000Z",
      deepLink: `https://conductor.build/${entry.id}`,
    })),
    offset: 0,
    hasMore: false,
  };
}

test("listing failure does not look like an empty index", async () => {
  const fetcher = (async () =>
    json({ userMessage: "unavailable" }, 503)) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);
  await assert.rejects(
    () => loadWorkspaceIndex(client, lanesConfig()),
    LaneWorkspaceIndexError
  );
});

test("a listing outage skips the tick instead of creating a duplicate workspace", async () => {
  resetLanesDb();
  globalThis.fetch = (async () =>
    json({ userMessage: "unavailable" }, 503)) as typeof fetch;
  const notices: string[] = [];
  const result = await runLanesTick({
    notify: async (text) => {
      notices.push(text);
    },
    force: true,
  });
  assert.equal(result.skipped, true);
  assert.match(result.reason ?? "", /could not list lane workspaces|unavailable|HTTP 503/i);
  assert.equal(notices.length, 0);
  assert.equal(getLatestLaneAction("L1"), null);
});

test("create refuses when the workspace already exists", async () => {
  resetLanesDb();
  const client = new ConductorApiClient(
    config(),
    (async () =>
      json({ userMessage: "should not create" }, 500)) as typeof fetch
  );
  const existing = {
    id: "workspace-1",
    name: "[lane:L1:primary] Example first lane",
    createdAt: "2026-09-01T00:00:00.000Z",
    deepLink: "https://conductor.build/workspace-1",
  };
  const outcome = await executeLaneAction(
    client,
    lanesConfig(),
    lanesConfig().lanes[0],
    { type: "create", laneId: "L1", provider: "primary" },
    [existing]
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.notice, /already exists/);
  assert.equal(getLatestLaneAction("L1")?.action, "create_refused");
});

test("a create whose first prompt fails is retried as prompt on the next tick", async () => {
  resetLanesDb();
  let created = false;
  let promptSends = 0;
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/v0/workspaces" && init.method === "GET") {
      if (!created) return json(workspacePage([]));
      return json(
        workspacePage([
          {
            id: "workspace-1",
            name: "[lane:L1:primary] Example first lane",
          },
        ])
      );
    }
    if (parsed.pathname === "/v0/workspaces" && init.method === "POST") {
      created = true;
      return json({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        deepLink: "https://conductor.build/workspace-1",
      });
    }
    if (parsed.pathname === "/v0/workspaces/workspace-1/sessions") {
      return json({
        data: [{ id: "session-1", deepLink: "https://conductor.build/session-1" }],
        offset: 0,
        hasMore: false,
      });
    }
    if (parsed.pathname === "/v0/sessions/session-1/status") {
      return json({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        status: "idle",
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
    }
    if (parsed.pathname === "/v0/sessions/session-1/messages") {
      if (init.method === "POST") {
        promptSends += 1;
        if (promptSends === 1) {
          return json({ userMessage: "send failed" }, 500);
        }
        const body = init.body ? JSON.parse(String(init.body)) : {};
        return json({ messageId: body.messageId, state: "queued" }, 201);
      }
      return json({ data: [], offset: 0, hasMore: false });
    }
    return json({ userMessage: `unhandled ${parsed.pathname}` }, 404);
  }) as typeof fetch;
  globalThis.fetch = fetcher;

  const first = await runLanesTick({
    notify: async () => undefined,
    force: true,
  });
  assert.equal(first.skipped, false);
  assert.equal(promptSends, 1);
  assert.equal(getLatestLaneAction("L1")?.action, "create_failed");

  const second = await runLanesTick({
    notify: async () => undefined,
    force: true,
  });
  assert.equal(second.skipped, false);
  assert.equal(second.actions[0]?.type, "prompt");
  assert.equal(promptSends, 2);
  assert.equal(getLatestLaneAction("L1")?.action, "prompt");
});

test("handleLanes pause and resume toggle the global flag", async () => {
  resetLanesDb();
  setLanesPaused(false);
  const replies: string[] = [];
  const ctx = {
    chat: { id: 424242, type: "private" },
    message: { text: "/lanes pause" },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 1 };
    },
  };
  await handleLanes(ctx as never);
  assert.equal(isLanesPaused(), true);
  assert.match(replies[0] ?? "", /paused/i);

  ctx.message.text = "/lanes resume";
  await handleLanes(ctx as never);
  assert.equal(isLanesPaused(), false);
  assert.match(replies[1] ?? "", /resumed/i);
});

test("handleLanes reports usage for unknown subcommands", async () => {
  const replies: string[] = [];
  await handleLanes({
    chat: { id: 424242, type: "private" },
    message: { text: "/lanes explode" },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 1 };
    },
  } as never);
  assert.match(replies[0] ?? "", /Usage: \/lanes/);
});

test("loadWorkspaceIndex uses the per-lane name filter", async () => {
  const urls: string[] = [];
  const client = new ConductorApiClient(
    config(),
    (async (url: string | URL | Request) => {
      urls.push(String(url));
      return json(workspacePage([]));
    }) as typeof fetch
  );
  await loadWorkspaceIndex(client, lanesConfig());
  assert.equal(urls.length, 1);
  const parsed = new URL(urls[0]);
  assert.equal(parsed.pathname, "/v0/workspaces");
  assert.equal(parsed.searchParams.get("mine"), "true");
  assert.equal(parsed.searchParams.get("name"), "[lane:L1:");
});

function existingLaneFetcher(options: {
  status: "idle" | "working" | "error";
  messagesStatus?: number;
  messages?: unknown[];
  onMessagePost?: (body: unknown) => void;
}): typeof fetch {
  return (async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/v0/workspaces" && init.method === "GET") {
      return json(
        workspacePage([
          {
            id: "workspace-1",
            name: "[lane:L1:primary] Example first lane",
          },
        ])
      );
    }
    if (parsed.pathname === "/v0/workspaces/workspace-1/sessions") {
      return json({
        data: [{ id: "session-1", deepLink: "https://conductor.build/session-1" }],
        offset: 0,
        hasMore: false,
      });
    }
    if (parsed.pathname === "/v0/sessions/session-1/status") {
      return json({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        status: options.status,
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
    }
    if (parsed.pathname === "/v0/sessions/session-1/messages") {
      if (init.method === "POST") {
        options.onMessagePost?.(init.body ? JSON.parse(String(init.body)) : {});
        return json({ userMessage: "unexpected prompt" }, 500);
      }
      if (options.messagesStatus && options.messagesStatus >= 400) {
        return json({ userMessage: "unavailable" }, options.messagesStatus);
      }
      return json({
        data: options.messages ?? [],
        offset: 0,
        hasMore: false,
      });
    }
    return json({ userMessage: `unhandled ${parsed.pathname}` }, 404);
  }) as typeof fetch;
}

test("a transcript fetch failure does not re-send the lane prompt", async () => {
  resetLanesDb();
  let promptPosts = 0;
  globalThis.fetch = existingLaneFetcher({
    status: "working",
    messagesStatus: 503,
    onMessagePost: () => {
      promptPosts += 1;
    },
  });
  const result = await runLanesTick({
    notify: async () => undefined,
    force: true,
  });
  assert.equal(result.skipped, false);
  assert.equal(result.actions.length, 0);
  assert.equal(promptPosts, 0);
  assert.equal(result.statuses[0]?.state, "unknown");
});

test("a working session with an empty transcript is not prompted", async () => {
  resetLanesDb();
  let promptPosts = 0;
  globalThis.fetch = existingLaneFetcher({
    status: "working",
    messages: [],
    onMessagePost: () => {
      promptPosts += 1;
    },
  });
  const result = await runLanesTick({
    notify: async () => undefined,
    force: true,
  });
  assert.equal(result.skipped, false);
  assert.equal(result.actions.length, 0);
  assert.equal(promptPosts, 0);
  assert.equal(result.statuses[0]?.state, "working");
});

test("an idle session whose transcript fetch fails is not prompted", async () => {
  resetLanesDb();
  let promptPosts = 0;
  globalThis.fetch = existingLaneFetcher({
    status: "idle",
    messagesStatus: 503,
    onMessagePost: () => {
      promptPosts += 1;
    },
  });
  const result = await runLanesTick({
    notify: async () => undefined,
    force: true,
  });
  assert.equal(result.skipped, false);
  assert.equal(result.actions.length, 0);
  assert.equal(promptPosts, 0);
  assert.equal(result.statuses[0]?.state, "unknown");
});

test("a scheduled tick while paused does not list workspaces", async () => {
  resetLanesDb();
  setLanesPaused(true);
  setLanesLastTickAt(new Date(Date.now() - 60 * 60_000).toISOString());
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return json({ userMessage: "should not list" }, 500);
  }) as typeof fetch;
  const result = await runLanesTick({
    notify: async () => undefined,
    force: false,
  });
  assert.equal(result.skipped, true);
  assert.match(result.reason ?? "", /paused/i);
  assert.equal(fetchCalls, 0);
  setLanesPaused(false);
});
