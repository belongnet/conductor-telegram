import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Handlers write real rows through the bot store and build their API client
// from the environment, so pin every external surface to throwaways before
// any import can touch the real ones.
const TEMP_DIR = mkdtempSync(path.join(os.tmpdir(), "ct-cloud-handlers-"));
process.env.DB_PATH = path.join(TEMP_DIR, "bot.db");
process.env.CONDUCTOR_DB_PATH = path.join(TEMP_DIR, "no-conductor.db");
process.env.CONDUCTOR_SETTINGS_PATH = path.join(TEMP_DIR, "no-settings.toml");
process.env.CONDUCTOR_API_KEY = "test-key";
process.env.CONDUCTOR_API_BASE_URL = "https://conductor.test";
process.env.CONDUCTOR_CLOUD_BACKEND = "api";
process.env.CONDUCTOR_API_MAX_RETRIES = "0";
process.env.TELEGRAM_DEFAULT_MODEL = "";
process.env.TELEGRAM_DEFAULT_AGENT_TYPE = "";

import {
  handleCloud,
  handleFleet,
  handleProjects,
  handleRename,
  handleRenameThread,
} from "../src/bot/commands.js";
import { closeDb } from "../src/store/db.js";
import {
  getWorkspace,
  updateWorkspaceConductorBinding,
  updateWorkspaceConductorName,
  updateWorkspaceThreadId,
  createWorkspace as createTrackedWorkspace,
  getAllWorkspaces,
} from "../src/store/queries.js";

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
  closeDb();
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

const CHAT_ID = 424242;

interface FakeChat {
  ctx: any;
  replies: string[];
  sent: string[];
  edits: string[];
}

/**
 * Minimal Telegraf-shaped context: replies and status messages are captured,
 * and topic creation fails like a private (non-forum) chat so launch flows
 * take the topic-less path.
 */
function fakeCtx(text: string, options: { threadId?: number } = {}): FakeChat {
  const replies: string[] = [];
  const sent: string[] = [];
  const edits: string[] = [];
  const ctx = {
    chat: { id: CHAT_ID, type: "private" },
    from: { id: 7 },
    message: {
      text,
      ...(options.threadId ? { message_thread_id: options.threadId } : {}),
    },
    reply: async (replyText: string) => {
      replies.push(replyText);
      return { message_id: 100 + replies.length };
    },
    telegram: {
      sendMessage: async (_chatId: unknown, sentText: string) => {
        sent.push(sentText);
        return { message_id: 1000 + sent.length };
      },
      editMessageText: async (
        _chatId: unknown,
        _messageId: unknown,
        _inline: unknown,
        editedText: string
      ) => {
        edits.push(editedText);
        return true;
      },
      createForumTopic: async () => {
        throw new Error("Bad Request: the chat is not a forum");
      },
      editForumTopic: async () => true,
      getForumTopicIconStickers: async () => [],
    },
  };
  return { ctx, replies, sent, edits };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROJECTS_PAGE = {
  data: [
    { id: "proj-api", name: "api", gitRemote: "git@host:org/api.git" },
    { id: "proj-web", name: "web", gitRemote: "git@host:org/web.git" },
  ],
  offset: 0,
  hasMore: false,
};

function stubFetch(
  routes: Record<string, (init: RequestInit, url: URL) => Response>
): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${parsed.pathname}`;
    calls.push(key);
    const route = routes[key];
    return route
      ? route(init, parsed)
      : json({ userMessage: `unexpected ${key}` }, 599);
  }) as typeof fetch;
  return calls;
}

test("/projects lists cloud projects with start instructions", async () => {
  stubFetch({ "GET /v0/projects": () => json(PROJECTS_PAGE) });
  const chat = fakeCtx("/projects");

  await handleProjects(chat.ctx);

  assert.equal(chat.replies.length, 1);
  assert.match(chat.replies[0], /Cloud projects/);
  assert.match(chat.replies[0], /api/);
  assert.match(chat.replies[0], /git@host:org\/web\.git/);
});

test("/projects <name> shows the live project detail and its workspaces", async () => {
  const calls = stubFetch({
    "GET /v0/projects": () => json(PROJECTS_PAGE),
    "GET /v0/projects/proj-api": () =>
      json({ id: "proj-api", name: "api", gitRemote: "git@host:org/api.git" }),
    "GET /v0/projects/proj-api/workspaces": () =>
      json({
        data: [
          {
            id: "workspace-1",
            name: "quiet-city",
            createdAt: "2026-07-30T00:00:00.000Z",
            deepLink: "conductor://workspace-1",
            lastActivityAt: "2026-07-31T00:00:00.000Z",
          },
        ],
        offset: 0,
        hasMore: false,
      }),
  });
  const chat = fakeCtx("/projects api");

  await handleProjects(chat.ctx);

  assert.equal(chat.replies.length, 1);
  assert.match(chat.replies[0], /quiet-city/);
  assert.match(chat.replies[0], /1 workspace/);
  // The detail view re-reads the single project record.
  assert.ok(calls.includes("GET /v0/projects/proj-api"));
});

test("/projects with an unknown name explains and re-lists", async () => {
  stubFetch({ "GET /v0/projects": () => json(PROJECTS_PAGE) });
  const chat = fakeCtx("/projects nope");

  await handleProjects(chat.ctx);

  assert.equal(chat.replies.length, 1);
  assert.match(chat.replies[0], /not found/);
  assert.match(chat.replies[0], /Cloud projects/);
});

test("/cloud launches, persists the binding, and reports the running workspace", async () => {
  stubFetch({
    "GET /v0/projects": () => json(PROJECTS_PAGE),
    "POST /v0/workspaces": () =>
      json(
        {
          workspaceId: "workspace-9",
          sessionId: "session-9",
          deepLink: "https://conductor.build/w/workspace-9",
        },
        201
      ),
    "GET /v0/sessions/session-9/status": () =>
      json({
        workspaceId: "workspace-9",
        sessionId: "session-9",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-9/messages": (init) => {
      const body = JSON.parse(String(init.body));
      return json({ messageId: body.messageId, state: "queued" }, 201);
    },
    "GET /v0/workspaces/workspace-9": () =>
      json({
        id: "workspace-9",
        name: "brisk-harbor",
        createdAt: "2026-07-31T00:00:00.000Z",
        deepLink: "https://conductor.build/w/workspace-9",
      }),
  });
  const chat = fakeCtx("/cloud api Fix the auth bug");

  await handleCloud(chat.ctx);

  assert.equal(chat.sent.length, 1, "one starting message");
  assert.match(chat.sent[0], /Starting ☁️ cloud workspace in/);
  assert.equal(chat.edits.length, 1, "starting message edited to success");
  assert.match(chat.edits[0], /brisk-harbor/);
  assert.match(chat.edits[0], /Open in Conductor/);

  const tracked = getAllWorkspaces(5).find(
    (workspace) => workspace.conductorWorkspaceName === "brisk-harbor"
  );
  assert.ok(tracked, "bot-DB row bound to the cloud workspace");
  assert.equal(tracked.status, "running");
  assert.equal(tracked.conductorBackendKind, "cloud-api");
  assert.equal(tracked.conductorWorkspaceId, "workspace-9");
  assert.equal(tracked.conductorSessionId, "session-9");
  assert.match(tracked.repoPath, /^conductor-cloud:\/\//);
});

test("/cloud marks the tracked row failed when the launch fails", async () => {
  stubFetch({
    "GET /v0/projects": () => json(PROJECTS_PAGE),
    "POST /v0/workspaces": () => json({ userMessage: "quota exceeded" }, 400),
  });
  const chat = fakeCtx("/cloud web Try something");

  await handleCloud(chat.ctx);

  assert.equal(chat.edits.length, 1);
  assert.match(chat.edits[0], /Failed to start ☁️ cloud workspace/);
  assert.match(chat.edits[0], /quota exceeded/);
  const failed = getAllWorkspaces(10).find(
    (workspace) =>
      workspace.status === "failed" && workspace.repoPath.includes("web")
  );
  assert.ok(failed, "record marked failed");
});

test("/fleet validates hours and reports grouped activity", async () => {
  const badHours = fakeCtx("/fleet nonsense");
  await handleFleet(badHours.ctx);
  assert.match(badHours.replies[0], /hours must be an integer/);

  stubFetch({
    "POST /v0/sql": (init) => {
      const body = JSON.parse(String(init.body));
      assert.match(body.query, /interval '24 hours'/);
      return json({
        rows: [
          {
            workspace_id: "workspace-1",
            workspace_name: "quiet-city",
            session_title: "Fix auth",
            transcript: "did things",
            transcript_updated_at: "2026-07-31T00:00:00.000Z",
          },
        ],
        rowCount: 1,
        truncated: false,
      });
    },
  });
  const report = fakeCtx("/fleet");
  await handleFleet(report.ctx);
  assert.equal(report.replies.length, 1);
  assert.match(report.replies[0], /quiet-city/);
  assert.match(report.replies[0], /Fix auth/);
});

test("/fleet flags schema drift instead of a false all-clear", async () => {
  stubFetch({
    "POST /v0/sql": () =>
      json({ rows: [{ unexpected: "shape" }], rowCount: 1, truncated: false }),
  });
  const chat = fakeCtx("/fleet 24");
  await handleFleet(chat.ctx);
  assert.equal(chat.replies.length, 1);
  assert.match(chat.replies[0], /schema may have changed/);
});

test("/rename renames the bound cloud workspace and confirms", async () => {
  const threadId = 777;
  const tracked = createTrackedWorkspace({
    name: "seed",
    prompt: "p",
    repoPath: "conductor-cloud://api",
    telegramChatId: String(CHAT_ID),
  });
  updateWorkspaceConductorName(tracked.id, "quiet-city");
  updateWorkspaceThreadId(tracked.id, threadId);
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-1",
    sessionId: "session-1",
    backendKind: "cloud-api",
  });

  stubFetch({
    "POST /v0/workspaces/workspace-1/rename": (init) => {
      const body = JSON.parse(String(init.body));
      assert.equal(body.name, "sharper-name");
      return json({
        id: "workspace-1",
        name: "sharper-name",
        createdAt: "2026-07-30T00:00:00.000Z",
        deepLink: "https://conductor.build/w/workspace-1",
      });
    },
  });
  const chat = fakeCtx("/rename sharper-name", { threadId });

  await handleRename(chat.ctx);

  assert.equal(chat.replies.length, 1);
  assert.match(chat.replies[0], /renamed to <b>sharper-name<\/b>/);
  assert.equal(getWorkspace(tracked.id)?.conductorWorkspaceName, "sharper-name");
});

test("/rename outside any workspace context explains how to target one", async () => {
  const chat = fakeCtx("/rename new-name");
  await handleRename(chat.ctx);
  assert.equal(chat.replies.length, 1);
  assert.match(chat.replies[0], /inside a workspace topic/);
});

test("/cloud resolves a multiword project name without leaking it into the prompt", async () => {
  const bodies: Record<string, any> = {};
  stubFetch({
    "GET /v0/projects": () =>
      json({
        data: [
          {
            id: "proj-belong",
            name: "Belong Network",
            gitRemote: "git@host:org/belong.git",
          },
          { id: "proj-api", name: "api", gitRemote: "git@host:org/api.git" },
        ],
        offset: 0,
        hasMore: false,
      }),
    "POST /v0/workspaces": (init) => {
      bodies.createWorkspace = JSON.parse(String(init.body));
      return json(
        {
          workspaceId: "workspace-12",
          sessionId: "session-12",
          deepLink: "https://conductor.build/w/workspace-12",
        },
        201
      );
    },
    "GET /v0/sessions/session-12/status": () =>
      json({
        workspaceId: "workspace-12",
        sessionId: "session-12",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-12/messages": (init) => {
      bodies.firstPrompt = JSON.parse(String(init.body));
      return json({ messageId: bodies.firstPrompt.messageId, state: "queued" }, 201);
    },
    "GET /v0/workspaces/workspace-12": () =>
      json({
        id: "workspace-12",
        name: "steady-harbor",
        createdAt: "2026-07-31T00:00:00.000Z",
        deepLink: "https://conductor.build/w/workspace-12",
      }),
  });
  const chat = fakeCtx("/cloud Belong Network fix the auth bug");

  await handleCloud(chat.ctx);

  // The longest leading exact-name match wins: "Belong Network" is the
  // project, so its second word must not leak into the agent's prompt.
  assert.equal(bodies.createWorkspace?.projectId, "proj-belong");
  assert.equal(bodies.firstPrompt?.message, "fix the auth bug");
  assert.equal(chat.edits.length, 1, "starting message edited to success");
  assert.match(chat.edits[0], /steady-harbor/);
});

test("/renamethread renames the bound cloud thread and confirms", async () => {
  const threadId = 778;
  const tracked = createTrackedWorkspace({
    name: "seed-thread",
    prompt: "p",
    repoPath: "conductor-cloud://api",
    telegramChatId: String(CHAT_ID),
  });
  updateWorkspaceConductorName(tracked.id, "quiet-harbor");
  updateWorkspaceThreadId(tracked.id, threadId);
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-2",
    sessionId: "session-2",
    backendKind: "cloud-api",
  });

  stubFetch({
    "POST /v0/sessions/session-2/rename": (init) => {
      const body = JSON.parse(String(init.body));
      assert.equal(body.name, "tighter-title");
      return json({
        id: "session-2",
        deepLink: "conductor://workspace/workspace-2/session/session-2",
        name: "tighter-title",
      });
    },
  });
  const chat = fakeCtx("/renamethread tighter-title", { threadId });

  await handleRenameThread(chat.ctx);

  assert.equal(chat.replies.length, 1);
  assert.match(chat.replies[0], /Thread renamed to <b>tighter-title<\/b>/);
});
