import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  handleStop,
  observeAgentCompletion,
  recoverLocalAgentFailure,
  startWorkspaceForRepo,
} from "../src/bot/commands.js";
import {
  launchCloudWorkspace,
  launchWorkspaceSession,
  reconcilePendingCloudLaunch,
  reconcilePendingCloudMessages,
  reconcilePendingCloudTerminalIntent,
  sendToSession,
} from "../src/bot/launcher.js";
import { closeDb, getDb } from "../src/store/db.js";
import {
  acknowledgePendingCloudNotice,
  archiveWorkspace,
  clearPendingCloudLaunch,
  clearPendingCloudMessages,
  enqueuePendingCloudNotice,
  enqueuePendingCloudMessage,
  getPendingCloudMessages,
  getThreadCursor,
  getWorkspace,
  getPendingCloudLaunch,
  getPendingCloudMessageOutcome,
  getPendingCloudNotices,
  getPendingCloudTerminalIntent,
  getWorkspacesWithPendingCloudWork,
  beginCloudWorkLease,
  markPendingCloudLaunchCanceled,
  markPendingCloudLaunchSent,
  markPendingCloudLaunchForCleanup,
  persistPendingCloudLaunch,
  updateWorkspaceConductorBinding,
  updateWorkspaceConductorName,
  updateWorkspaceThreadId,
  createWorkspace as createTrackedWorkspace,
  getAllWorkspaces,
  updateWorkspaceStatus,
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
  routes: Record<
    string,
    (init: RequestInit, url: URL) => Response | Promise<Response>
  >
): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${parsed.pathname}`;
    calls.push(key);
    const wildcardKey =
      method === "GET" && parsed.pathname.startsWith("/v0/messages/")
        ? "GET /v0/messages/*"
        : key;
    const route = routes[key] ?? routes[wildcardKey];
    return route
      ? await route(init, parsed)
      : json({ userMessage: `unexpected ${key}` }, 599);
  }) as typeof fetch;
  return calls;
}

function createPushedRepo(name: string): { repoDir: string; remoteDir: string } {
  const remoteDir = path.join(TEMP_DIR, `${name}-origin.git`);
  const repoDir = path.join(TEMP_DIR, `${name}-repo`);
  const git = (args: string[], cwd?: string) =>
    execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  git(["init", "--bare", remoteDir]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], remoteDir);
  git(["init", "-b", "main", repoDir]);
  git(["config", "user.name", "Cloud Test"], repoDir);
  git(["config", "user.email", "cloud@example.test"], repoDir);
  writeFileSync(path.join(repoDir, "README.md"), "base\n");
  git(["add", "README.md"], repoDir);
  git(["commit", "-m", "base"], repoDir);
  git(["remote", "add", "origin", remoteDir], repoDir);
  git(["push", "-u", "origin", "main"], repoDir);
  git(["remote", "set-head", "origin", "--auto"], repoDir);
  return { repoDir, remoteDir };
}

function trackLocalWorkspace(name: string, repoDir: string, prompt: string) {
  const tracked = createTrackedWorkspace({
    name,
    prompt,
    repoPath: repoDir,
    telegramChatId: String(CHAT_ID),
  });
  updateWorkspaceConductorName(tracked.id, name);
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: `${name}-workspace`,
    sessionId: `${name}-session`,
    backendKind: "local",
  });
  updateWorkspaceStatus(tracked.id, "running");
  return getWorkspace(tracked.id)!;
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
      const duringSend = getAllWorkspaces(10).find(
        (workspace) => workspace.prompt === "Fix the auth bug"
      );
      assert.equal(duringSend?.conductorBackendKind, "cloud-api");
      assert.equal(duringSend?.conductorWorkspaceId, "workspace-9");
      assert.equal(duringSend?.status, "starting");
      assert.ok(
        duringSend && getPendingCloudLaunch(duringSend.id),
        "the binding and pending prompt must be durable before the API send"
      );
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
  assert.equal(getPendingCloudLaunch(tracked.id), null);
  assert.match(tracked.repoPath, /^conductor-cloud:\/\//);
});

test("a pending Cloud first prompt resumes with its durable message id", async () => {
  const tracked = trackLocalWorkspace(
    "pending-local-city",
    path.join(TEMP_DIR, "pending-cloud-repo"),
    "Resume after restart"
  );
  persistPendingCloudLaunch(tracked.id, {
    workspaceId: "workspace-pending",
    sessionId: "session-pending",
    prompt: "Resume after restart",
    messageId: "message-pending",
  });
  let sentBody: Record<string, unknown> | null = null;
  stubFetch({
    "GET /v0/messages/message-pending": () =>
      json({ userMessage: "not found" }, 404),
    "GET /v0/sessions/session-pending/status": () =>
      json({
        workspaceId: "workspace-pending",
        sessionId: "session-pending",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-pending/messages": (init) => {
      sentBody = JSON.parse(String(init.body));
      return json({ messageId: "message-pending", state: "queued" }, 201);
    },
  });

  const outcome = await reconcilePendingCloudLaunch(
    tracked.id,
    getWorkspace(tracked.id)!
  );

  assert.deepEqual(outcome, {
    status: "queued",
    sessionId: "session-pending",
    messageId: "message-pending",
  });
  assert.deepEqual(sentBody, {
    messageId: "message-pending",
    message: "Resume after restart",
  });
  assert.equal(getPendingCloudLaunch(tracked.id), null);
});

test("foreground launch accepts an exact restart finalization without archiving", async () => {
  const tracked = trackLocalWorkspace(
    "foreground-reconcile-city",
    path.join(TEMP_DIR, "foreground-reconcile-repo"),
    "Run exactly once"
  );
  let messageVisible = false;
  let announcePost!: () => void;
  const postStarted = new Promise<void>((resolve) => {
    announcePost = resolve;
  });
  let releasePost!: () => void;
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  const calls = stubFetch({
    "POST /v0/workspaces": () =>
      json(
        {
          workspaceId: "workspace-foreground-reconcile",
          sessionId: "session-foreground-reconcile",
          deepLink: "https://conductor.build/w/workspace-foreground-reconcile",
        },
        201
      ),
    "GET /v0/sessions/session-foreground-reconcile/status": () =>
      json({
        workspaceId: "workspace-foreground-reconcile",
        sessionId: "session-foreground-reconcile",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-foreground-reconcile/messages": async (init) => {
      const body = JSON.parse(String(init.body));
      messageVisible = true;
      announcePost();
      await postGate;
      return json({ messageId: body.messageId, state: "queued" }, 201);
    },
    "GET /v0/messages/*": (_init, url) =>
      messageVisible
        ? json({
            id: path.basename(url.pathname),
            sessionId: "session-foreground-reconcile",
            sessionIndex: 1,
            type: "user",
            content: "Run exactly once",
            receivedAt: "2026-07-31T00:00:00.000Z",
          })
        : json({ userMessage: "not found" }, 404),
    "GET /v0/workspaces/workspace-foreground-reconcile": () =>
      json({
        id: "workspace-foreground-reconcile",
        name: "foreground-cloud-city",
        createdAt: "2026-07-31T00:00:00.000Z",
        deepLink: "https://conductor.build/w/workspace-foreground-reconcile",
      }),
    "POST /v0/workspaces/workspace-foreground-reconcile/archive": () =>
      json({
        workspaceId: "workspace-foreground-reconcile",
        status: "archived",
      }),
  });

  const foreground = launchCloudWorkspace({
    projectId: "project-foreground-reconcile",
    prompt: "Run exactly once",
    persistBeforePrompt: (pending) => {
      persistPendingCloudLaunch(tracked.id, pending);
      return tracked.id;
    },
  });
  await postStarted;
  const restarted = await reconcilePendingCloudLaunch(
    tracked.id,
    getWorkspace(tracked.id)!
  );
  assert.equal(restarted.status, "queued");
  updateWorkspaceStatus(tracked.id, "done");
  releasePost();
  const launched = await foreground;

  assert.ok(!("error" in launched), JSON.stringify(launched));
  assert.equal(getWorkspace(tracked.id)?.status, "done");
  assert.equal(
    calls.filter(
      (call) =>
        call ===
        "POST /v0/sessions/session-foreground-reconcile/messages"
    ).length,
    1
  );
  assert.ok(
    !calls.includes(
      "POST /v0/workspaces/workspace-foreground-reconcile/archive"
    )
  );
  assert.equal(
    getPendingCloudNotices(tracked.id).filter(
      (notice) => notice.kind === "launch_queued"
    ).length,
    1
  );
});

test("foreground launch accepts restart finalization after a malformed POST receipt", async () => {
  const tracked = trackLocalWorkspace(
    "foreground-lost-receipt-city",
    path.join(TEMP_DIR, "foreground-lost-receipt-repo"),
    "Run once despite the lost receipt"
  );
  let messageVisible = false;
  let announcePost!: () => void;
  const postStarted = new Promise<void>((resolve) => {
    announcePost = resolve;
  });
  let releasePost!: () => void;
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  const calls = stubFetch({
    "POST /v0/workspaces": () =>
      json(
        {
          workspaceId: "workspace-foreground-lost-receipt",
          sessionId: "session-foreground-lost-receipt",
          deepLink: "https://conductor.build/w/workspace-foreground-lost-receipt",
        },
        201
      ),
    "GET /v0/sessions/session-foreground-lost-receipt/status": () =>
      json({
        workspaceId: "workspace-foreground-lost-receipt",
        sessionId: "session-foreground-lost-receipt",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-foreground-lost-receipt/messages": async () => {
      messageVisible = true;
      announcePost();
      await postGate;
      // The server accepted the caller-provided message ID, but its response
      // lost the required receipt identity.
      return json({ state: "queued" }, 201);
    },
    "GET /v0/messages/*": (_init, url) =>
      messageVisible
        ? json({
            id: path.basename(url.pathname),
            sessionId: "session-foreground-lost-receipt",
            sessionIndex: 1,
            type: "user",
            content: "Run once despite the lost receipt",
            receivedAt: "2026-07-31T00:00:00.000Z",
          })
        : json({ userMessage: "not found" }, 404),
    "GET /v0/workspaces/workspace-foreground-lost-receipt": () =>
      json({
        id: "workspace-foreground-lost-receipt",
        name: "lost-receipt-cloud-city",
        createdAt: "2026-07-31T00:00:00.000Z",
        deepLink: "https://conductor.build/w/workspace-foreground-lost-receipt",
      }),
    "POST /v0/workspaces/workspace-foreground-lost-receipt/archive": () =>
      json({
        workspaceId: "workspace-foreground-lost-receipt",
        status: "archived",
      }),
  });

  const foreground = launchCloudWorkspace({
    projectId: "project-foreground-lost-receipt",
    prompt: "Run once despite the lost receipt",
    persistBeforePrompt: (pending) => {
      persistPendingCloudLaunch(tracked.id, pending);
      return tracked.id;
    },
  });
  await postStarted;
  assert.equal(
    (
      await reconcilePendingCloudLaunch(
        tracked.id,
        getWorkspace(tracked.id)!
      )
    ).status,
    "queued"
  );
  updateWorkspaceStatus(tracked.id, "failed");
  releasePost();
  const launched = await foreground;

  assert.ok(!("error" in launched), JSON.stringify(launched));
  assert.equal(launched.initialCursorMessageId?.length, 36);
  assert.equal(getWorkspace(tracked.id)?.status, "failed");
  assert.ok(
    !calls.includes(
      "POST /v0/workspaces/workspace-foreground-lost-receipt/archive"
    )
  );
});

test("a pending Cloud launch is not recorded without its tracked workspace", () => {
  assert.throws(
    () =>
      persistPendingCloudLaunch("missing-tracked-workspace", {
        workspaceId: "workspace-orphan",
        sessionId: "session-orphan",
        prompt: "Do not orphan this prompt",
        messageId: "message-orphan",
      }),
    /missing workspace/
  );
  assert.equal(getPendingCloudLaunch("missing-tracked-workspace"), null);
});

test("pending Cloud work is discoverable beyond the normal 100-workspace cap", () => {
  const oldest = trackLocalWorkspace(
    "oldest-pending-city",
    path.join(TEMP_DIR, "oldest-pending-repo"),
    "Do not starve this recovery"
  );
  getDb()
    .prepare("UPDATE workspaces SET created_at = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", oldest.id);
  persistPendingCloudLaunch(oldest.id, {
    workspaceId: "workspace-oldest-pending",
    sessionId: "session-oldest-pending",
    prompt: "Do not starve this recovery",
    messageId: "message-oldest-pending",
  });
  for (let index = 0; index < 101; index += 1) {
    createTrackedWorkspace({
      name: `newer-workspace-${index}`,
      prompt: "fleet filler",
      repoPath: path.join(TEMP_DIR, `newer-workspace-${index}`),
      telegramChatId: String(CHAT_ID),
    });
  }

  assert.equal(
    getAllWorkspaces(100).some((workspace) => workspace.id === oldest.id),
    false
  );
  assert.equal(
    getWorkspacesWithPendingCloudWork().some(
      (workspace) => workspace.id === oldest.id
    ),
    true
  );
});

test("a non-retryable pending launch identity mismatch fails closed", async () => {
  const tracked = trackLocalWorkspace(
    "mismatched-pending-city",
    path.join(TEMP_DIR, "mismatched-pending-repo"),
    "Resume safely"
  );
  persistPendingCloudLaunch(tracked.id, {
    workspaceId: "workspace-mismatch",
    sessionId: "session-mismatch",
    prompt: "Resume safely",
    messageId: "message-mismatch",
  });
  stubFetch({
    "GET /v0/messages/message-mismatch": () =>
      json({
        id: "message-mismatch",
        sessionId: "different-session",
        sessionIndex: 1,
        type: "user",
        content: "Resume safely",
        receivedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/workspaces/workspace-mismatch/archive": () =>
      json({ workspaceId: "workspace-mismatch", status: "archived" }),
  });

  const outcome = await reconcilePendingCloudLaunch(
    tracked.id,
    getWorkspace(tracked.id)!
  );

  assert.deepEqual(outcome, {
    status: "failed",
    error: "Pending Cloud message belongs to a different session",
  });
  assert.equal(getPendingCloudLaunch(tracked.id), null);
  assert.equal(getWorkspace(tracked.id)?.conductorBackendKind, "local");
});

test("uncertain first-prompt delivery preserves cleanup evidence until archive succeeds", async () => {
  const { repoDir, remoteDir } = createPushedRepo("uncertain-cleanup");
  const tracked = trackLocalWorkspace(
    "uncertain-local-city",
    repoDir,
    "Do this exactly once"
  );
  let announceArchive!: () => void;
  const archiveStarted = new Promise<void>((resolve) => {
    announceArchive = resolve;
  });
  let releaseArchive!: () => void;
  const archiveGate = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  stubFetch({
    "GET /v0/projects": () =>
      json({
        data: [
          {
            id: "proj-uncertain",
            name: "uncertain-cleanup",
            gitRemote: remoteDir,
          },
        ],
        offset: 0,
        hasMore: false,
      }),
    "POST /v0/workspaces": () =>
      json(
        {
          workspaceId: "workspace-uncertain",
          sessionId: "session-uncertain",
          deepLink: "https://conductor.build/w/workspace-uncertain",
        },
        201
      ),
    "GET /v0/sessions/session-uncertain/status": () =>
      json({
        workspaceId: "workspace-uncertain",
        sessionId: "session-uncertain",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-uncertain/messages": () =>
      json({ userMessage: "response lost" }, 503),
    "POST /v0/workspaces/workspace-uncertain/archive": async () => {
      announceArchive();
      await archiveGate;
      return json({ userMessage: "archive unavailable" }, 503);
    },
  });
  const chat = fakeCtx("uncertain cleanup");

  const takeoverPromise = recoverLocalAgentFailure(
    chat.ctx,
    tracked,
    "uncertain-local-city",
    {
      isError: true,
      exitCode: 1,
      resultText: "Not logged in · Please run /login",
      hadMeaningfulActivity: false,
      authenticationFailure: true,
    },
    {
      prompt: "Do this exactly once",
      repoName: "uncertain-cleanup",
      repoPath: repoDir,
      workspaceDir: repoDir,
    }
  );
  await archiveStarted;
  assert.equal(
    getPendingCloudLaunch(tracked.id)?.phase,
    "cleanup",
    "cleanup must be durable before the archive request can apply remotely"
  );
  releaseArchive();
  const takeover = await takeoverPromise;

  assert.equal(takeover.recovered, false);
  assert.match(takeover.reason ?? "", /cleanup is still pending/i);
  const pending = getPendingCloudLaunch(tracked.id);
  assert.equal(pending?.phase, "cleanup");
  assert.equal(pending?.previousBinding?.conductorBackendKind, "local");
  assert.equal(getWorkspace(tracked.id)?.conductorBackendKind, "cloud-api");

  stubFetch({
    "POST /v0/workspaces/workspace-uncertain/archive": () =>
      json({ workspaceId: "workspace-uncertain", status: "archived" }),
  });
  const cleanup = await reconcilePendingCloudLaunch(
    tracked.id,
    getWorkspace(tracked.id)!
  );

  assert.equal(cleanup.status, "failed");
  assert.equal(getPendingCloudLaunch(tracked.id), null);
  const restored = getWorkspace(tracked.id)!;
  assert.equal(restored.conductorBackendKind, "local");
  assert.equal(restored.conductorWorkspaceId, `${tracked.name}-workspace`);
  assert.equal(restored.conductorSessionId, `${tracked.name}-session`);
});

test("a stopped pending Cloud launch is canceled after restart and never sends its prompt", async () => {
  const tracked = trackLocalWorkspace(
    "stop-pending-city",
    path.join(TEMP_DIR, "stop-pending-repo"),
    "Never send after stop"
  );
  persistPendingCloudLaunch(tracked.id, {
    workspaceId: "workspace-stop-pending",
    sessionId: "session-stop-pending",
    prompt: "Never send after stop",
    messageId: "message-stop-pending",
  });
  const stopCalls = stubFetch({
    "GET /v0/sessions/session-stop-pending/status": () =>
      json({ userMessage: "temporarily unavailable" }, 503),
  });
  const chat = fakeCtx(`/stop ${tracked.id}`);

  await handleStop(chat.ctx);

  assert.match(chat.replies.at(-1) ?? "", /Stop intent.*saved/i);
  assert.equal(getWorkspace(tracked.id)?.status, "stopped");
  assert.equal(getPendingCloudLaunch(tracked.id)?.phase, "cancel");
  assert.equal(
    markPendingCloudLaunchForCleanup(tracked.id),
    false,
    "a racing send failure cannot overwrite durable stop intent"
  );
  assert.equal(getPendingCloudLaunch(tracked.id)?.phase, "cancel");
  assert.ok(
    !stopCalls.some((call) => call.endsWith("/messages")),
    "stop path must not send the pending prompt"
  );

  const reconcileCalls = stubFetch({
    "POST /v0/workspaces/workspace-stop-pending/archive": () =>
      json({
        workspaceId: "workspace-stop-pending",
        status: "archived",
      }),
  });
  const outcome = await reconcilePendingCloudLaunch(
    tracked.id,
    getWorkspace(tracked.id)!
  );

  assert.deepEqual(outcome, { status: "none" });
  assert.equal(getPendingCloudLaunch(tracked.id), null);
  const restored = getWorkspace(tracked.id)!;
  assert.equal(restored.status, "stopped");
  assert.equal(restored.conductorBackendKind, "local");
  assert.ok(
    !reconcileCalls.some((call) => call.endsWith("/messages")),
    "restart reconciliation must cancel instead of replaying"
  );
});

test("an ordinary Cloud stop survives an API outage and retries after restart", async () => {
  const tracked = trackLocalWorkspace(
    "durable-stop-city",
    path.join(TEMP_DIR, "durable-stop-repo"),
    "Keep this stop durable"
  );
  updateWorkspaceConductorName(tracked.id, "durable-stop-cloud-city");
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-durable-stop",
    sessionId: "session-durable-stop",
    backendKind: "cloud-api",
  });
  updateWorkspaceStatus(tracked.id, "running");

  assert.equal(markPendingCloudLaunchCanceled(tracked.id), true);
  assert.equal(getWorkspace(tracked.id)?.status, "stopped");
  assert.equal(getPendingCloudTerminalIntent(tracked.id)?.action, "stop");
  stubFetch({
    "GET /v0/sessions/session-durable-stop/status": () =>
      json({ userMessage: "temporarily unavailable" }, 503),
  });
  assert.deepEqual(await reconcilePendingCloudTerminalIntent(tracked.id), {
    status: "pending",
    action: "stop",
  });
  assert.equal(getPendingCloudTerminalIntent(tracked.id)?.action, "stop");
  assert.ok(
    getWorkspacesWithPendingCloudWork().some(
      (workspace) => workspace.id === tracked.id
    )
  );

  const calls = stubFetch({
    "GET /v0/sessions/session-durable-stop/status": () =>
      json({
        workspaceId: "workspace-durable-stop",
        sessionId: "session-durable-stop",
        status: "working",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-durable-stop/cancel": () =>
      json({
        workspaceId: "workspace-durable-stop",
        sessionId: "session-durable-stop",
        status: "idle",
        canceledQueuedMessages: 0,
      }),
  });
  const completed = await reconcilePendingCloudTerminalIntent(tracked.id);

  assert.equal(completed.status, "completed");
  assert.equal(getPendingCloudTerminalIntent(tracked.id), null);
  assert.equal(getWorkspace(tracked.id)?.status, "stopped");
  assert.ok(calls.includes("POST /v0/sessions/session-durable-stop/cancel"));
  assert.ok(
    getPendingCloudNotices(tracked.id).some(
      (notice) => notice.kind === "stop_confirmed"
    )
  );
});

test("an ordinary Cloud archive survives an API outage and retries after restart", async () => {
  const tracked = trackLocalWorkspace(
    "durable-archive-city",
    path.join(TEMP_DIR, "durable-archive-repo"),
    "Keep this archive durable"
  );
  updateWorkspaceConductorName(tracked.id, "durable-archive-cloud-city");
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-durable-archive",
    sessionId: "session-durable-archive",
    backendKind: "cloud-api",
  });
  updateWorkspaceStatus(tracked.id, "running");

  archiveWorkspace(tracked.id);
  assert.equal(getWorkspace(tracked.id)?.status, "archived");
  assert.equal(getPendingCloudTerminalIntent(tracked.id)?.action, "archive");
  stubFetch({
    "POST /v0/workspaces/workspace-durable-archive/archive": () =>
      json({ userMessage: "temporarily unavailable" }, 503),
  });
  assert.deepEqual(await reconcilePendingCloudTerminalIntent(tracked.id), {
    status: "pending",
    action: "archive",
  });
  assert.equal(getPendingCloudTerminalIntent(tracked.id)?.action, "archive");
  assert.ok(
    getWorkspacesWithPendingCloudWork().some(
      (workspace) => workspace.id === tracked.id
    )
  );

  const calls = stubFetch({
    "POST /v0/workspaces/workspace-durable-archive/archive": () =>
      json({
        workspaceId: "workspace-durable-archive",
        status: "archived",
      }),
  });
  const completed = await reconcilePendingCloudTerminalIntent(tracked.id);

  assert.equal(completed.status, "completed");
  assert.equal(getPendingCloudTerminalIntent(tracked.id), null);
  assert.equal(getWorkspace(tracked.id)?.status, "archived");
  assert.ok(
    calls.includes("POST /v0/workspaces/workspace-durable-archive/archive")
  );
  assert.ok(
    getPendingCloudNotices(tracked.id).some(
      (notice) => notice.kind === "archive_confirmed"
    )
  );
});

test("stop during uncertain cleanup preserves archive-and-restore evidence", async () => {
  const tracked = trackLocalWorkspace(
    "stop-cleanup-city",
    path.join(TEMP_DIR, "stop-cleanup-repo"),
    "Do not replay uncertain work"
  );
  persistPendingCloudLaunch(tracked.id, {
    workspaceId: "workspace-stop-cleanup",
    sessionId: "session-stop-cleanup",
    prompt: "Do not replay uncertain work",
    messageId: "message-stop-cleanup",
  });
  assert.equal(markPendingCloudLaunchForCleanup(tracked.id), true);
  stubFetch({
    "GET /v0/sessions/session-stop-cleanup/status": () =>
      json({
        workspaceId: "workspace-stop-cleanup",
        sessionId: "session-stop-cleanup",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-stop-cleanup/cancel": () =>
      json({
        workspaceId: "workspace-stop-cleanup",
        sessionId: "session-stop-cleanup",
        status: "idle",
        canceledQueuedMessages: 0,
      }),
  });

  await handleStop(fakeCtx(`/stop ${tracked.id}`).ctx);

  assert.equal(
    getPendingCloudLaunch(tracked.id)?.phase,
    "cancel",
    "stop must retain a saga that still requires workspace archival"
  );
  stubFetch({
    "POST /v0/workspaces/workspace-stop-cleanup/archive": () =>
      json({ workspaceId: "workspace-stop-cleanup", status: "archived" }),
  });
  const outcome = await reconcilePendingCloudLaunch(
    tracked.id,
    getWorkspace(tracked.id)!
  );

  assert.deepEqual(outcome, { status: "none" });
  assert.equal(getPendingCloudLaunch(tracked.id), null);
  const restored = getWorkspace(tracked.id)!;
  assert.equal(restored.status, "stopped");
  assert.equal(restored.conductorBackendKind, "local");
  assert.equal(restored.conductorWorkspaceId, `${tracked.name}-workspace`);
});

test("stop wins while pending-launch reconciliation is waiting on the API", async () => {
  const tracked = trackLocalWorkspace(
    "stop-reconcile-city",
    path.join(TEMP_DIR, "stop-reconcile-repo"),
    "Never race this prompt"
  );
  persistPendingCloudLaunch(tracked.id, {
    workspaceId: "workspace-stop-reconcile",
    sessionId: "session-stop-reconcile",
    prompt: "Never race this prompt",
    messageId: "message-stop-reconcile",
  });
  let announceRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    announceRead = resolve;
  });
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const calls = stubFetch({
    "GET /v0/messages/message-stop-reconcile": async () => {
      announceRead();
      await readGate;
      return json({ userMessage: "not found" }, 404);
    },
    "GET /v0/sessions/session-stop-reconcile/status": () =>
      json({
        workspaceId: "workspace-stop-reconcile",
        sessionId: "session-stop-reconcile",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
  });

  const reconciliation = reconcilePendingCloudLaunch(
    tracked.id,
    getWorkspace(tracked.id)!
  );
  await readStarted;
  markPendingCloudLaunchCanceled(tracked.id);
  releaseRead();
  const outcome = await reconciliation;

  assert.deepEqual(outcome, { status: "pending" });
  assert.equal(getPendingCloudLaunch(tracked.id)?.phase, "cancel");
  assert.ok(
    !calls.includes("POST /v0/sessions/session-stop-reconcile/messages"),
    "the final durable gate must suppress a send after stop"
  );
});

test("archive intent wins while pending-launch reconciliation is waiting on the API", async () => {
  const tracked = trackLocalWorkspace(
    "archive-reconcile-city",
    path.join(TEMP_DIR, "archive-reconcile-repo"),
    "Never run after archive"
  );
  persistPendingCloudLaunch(tracked.id, {
    workspaceId: "workspace-archive-reconcile",
    sessionId: "session-archive-reconcile",
    prompt: "Never run after archive",
    messageId: "message-archive-reconcile",
  });
  let announceRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    announceRead = resolve;
  });
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const calls = stubFetch({
    "GET /v0/messages/message-archive-reconcile": async () => {
      announceRead();
      await readGate;
      return json({ userMessage: "not found" }, 404);
    },
    "GET /v0/sessions/session-archive-reconcile/status": () =>
      json({
        workspaceId: "workspace-archive-reconcile",
        sessionId: "session-archive-reconcile",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/workspaces/workspace-archive-reconcile/archive": () =>
      json({
        workspaceId: "workspace-archive-reconcile",
        status: "archived",
      }),
  });

  const reconciliation = reconcilePendingCloudLaunch(
    tracked.id,
    getWorkspace(tracked.id)!
  );
  await readStarted;
  archiveWorkspace(tracked.id);
  releaseRead();

  assert.deepEqual(await reconciliation, { status: "pending" });
  assert.equal(getPendingCloudLaunch(tracked.id)?.phase, "cancel");
  assert.equal(getWorkspace(tracked.id)?.status, "archived");
  assert.ok(
    !calls.includes("POST /v0/sessions/session-archive-reconcile/messages")
  );

  assert.deepEqual(
    await reconcilePendingCloudLaunch(tracked.id, getWorkspace(tracked.id)!),
    { status: "none" }
  );
  assert.ok(
    calls.includes("POST /v0/workspaces/workspace-archive-reconcile/archive")
  );
  assert.equal(getPendingCloudLaunch(tracked.id), null);
  assert.equal(getWorkspace(tracked.id)?.status, "archived");
});

test("pending reconciliation ignores a stale poller binding snapshot", async () => {
  const tracked = trackLocalWorkspace(
    "stale-poller-city",
    path.join(TEMP_DIR, "stale-poller-repo"),
    "Resume from the durable binding"
  );
  const staleSnapshot = getWorkspace(tracked.id)!;
  persistPendingCloudLaunch(tracked.id, {
    workspaceId: "workspace-stale-poller",
    sessionId: "session-stale-poller",
    prompt: "Resume from the durable binding",
    messageId: "message-stale-poller",
  });
  const calls = stubFetch({
    "GET /v0/messages/message-stale-poller": () =>
      json({ userMessage: "not found" }, 404),
    "GET /v0/sessions/session-stale-poller/status": () =>
      json({
        workspaceId: "workspace-stale-poller",
        sessionId: "session-stale-poller",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-stale-poller/messages": (init) => {
      const body = JSON.parse(String(init.body));
      return json({ messageId: body.messageId, state: "queued" }, 201);
    },
    "GET /v0/workspaces/workspace-stale-poller": () =>
      json({
        id: "workspace-stale-poller",
        name: "stale-poller-cloud-city",
        createdAt: "2026-07-31T00:00:00.000Z",
        deepLink: "https://conductor.build/w/workspace-stale-poller",
      }),
  });

  const outcome = await reconcilePendingCloudLaunch(
    tracked.id,
    staleSnapshot
  );

  assert.deepEqual(outcome, {
    status: "queued",
    sessionId: "session-stale-poller",
    messageId: "message-stale-poller",
  });
  assert.ok(!calls.includes("POST /v0/workspaces/workspace-stale-poller/archive"));
  assert.equal(getPendingCloudLaunch(tracked.id), null);
  const finalized = getWorkspace(tracked.id)!;
  assert.equal(finalized.status, "running");
  assert.equal(finalized.conductorBackendKind, "cloud-api");
  assert.equal(
    getThreadCursor(tracked.id, "session-stale-poller")?.lastMessageId,
    "message-stale-poller"
  );
});

test("a stale pending-launch sender cannot cross into a replacement saga", async () => {
  const tracked = trackLocalWorkspace(
    "launch-aba-send-city",
    path.join(TEMP_DIR, "launch-aba-send-repo"),
    "Old prompt"
  );
  const oldPending = {
    workspaceId: "workspace-launch-aba-old",
    sessionId: "session-launch-aba-old",
    prompt: "Old prompt",
    messageId: "message-launch-aba-old",
  };
  persistPendingCloudLaunch(tracked.id, oldPending);
  let announceRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    announceRead = resolve;
  });
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const calls = stubFetch({
    "GET /v0/messages/message-launch-aba-old": async () => {
      announceRead();
      await readGate;
      return json({ userMessage: "not found" }, 404);
    },
    "GET /v0/sessions/session-launch-aba-old/status": () =>
      json({
        workspaceId: "workspace-launch-aba-old",
        sessionId: "session-launch-aba-old",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-launch-aba-old/messages": (init) => {
      const body = JSON.parse(String(init.body));
      return json({ messageId: body.messageId, state: "queued" }, 201);
    },
  });

  const staleReconciliation = reconcilePendingCloudLaunch(
    tracked.id,
    getWorkspace(tracked.id)!
  );
  await readStarted;
  assert.equal(clearPendingCloudLaunch(tracked.id, oldPending), true);
  const replacement = {
    workspaceId: "workspace-launch-aba-new",
    sessionId: "session-launch-aba-new",
    prompt: "New prompt",
    messageId: "message-launch-aba-new",
  };
  persistPendingCloudLaunch(tracked.id, replacement);
  releaseRead();

  assert.deepEqual(await staleReconciliation, { status: "pending" });
  assert.ok(
    !calls.includes("POST /v0/sessions/session-launch-aba-old/messages")
  );
  assert.equal(
    getPendingCloudLaunch(tracked.id)?.workspaceId,
    replacement.workspaceId
  );
  assert.equal(
    getWorkspace(tracked.id)?.conductorWorkspaceId,
    replacement.workspaceId
  );
});

test("a stale pending-launch cleanup cannot restore over a replacement saga", async () => {
  const tracked = trackLocalWorkspace(
    "launch-aba-cleanup-city",
    path.join(TEMP_DIR, "launch-aba-cleanup-repo"),
    "Old cleanup"
  );
  const oldPending = {
    workspaceId: "workspace-cleanup-aba-old",
    sessionId: "session-cleanup-aba-old",
    prompt: "Old cleanup",
    messageId: "message-cleanup-aba-old",
  };
  persistPendingCloudLaunch(tracked.id, oldPending);
  assert.equal(markPendingCloudLaunchForCleanup(tracked.id, oldPending), true);
  let announceArchive!: () => void;
  const archiveStarted = new Promise<void>((resolve) => {
    announceArchive = resolve;
  });
  let releaseArchive!: () => void;
  const archiveGate = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  stubFetch({
    "POST /v0/workspaces/workspace-cleanup-aba-old/archive": async () => {
      announceArchive();
      await archiveGate;
      return json({
        workspaceId: "workspace-cleanup-aba-old",
        status: "archived",
      });
    },
  });

  const staleCleanup = reconcilePendingCloudLaunch(
    tracked.id,
    getWorkspace(tracked.id)!
  );
  await archiveStarted;
  const currentOld = getPendingCloudLaunch(tracked.id)!;
  assert.equal(clearPendingCloudLaunch(tracked.id, currentOld), true);
  const replacement = {
    workspaceId: "workspace-cleanup-aba-new",
    sessionId: "session-cleanup-aba-new",
    prompt: "New work",
    messageId: "message-cleanup-aba-new",
  };
  persistPendingCloudLaunch(tracked.id, replacement);
  releaseArchive();

  assert.deepEqual(await staleCleanup, { status: "pending" });
  assert.equal(
    getPendingCloudLaunch(tracked.id)?.workspaceId,
    replacement.workspaceId
  );
  assert.equal(
    getWorkspace(tracked.id)?.conductorWorkspaceId,
    replacement.workspaceId
  );
});

test("stop wins while durable outbox delivery is waiting on the API", async () => {
  const tracked = trackLocalWorkspace(
    "stop-outbox-city",
    path.join(TEMP_DIR, "stop-outbox-repo"),
    "Initial work"
  );
  updateWorkspaceConductorName(tracked.id, "stop-outbox-cloud-city");
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-stop-outbox",
    sessionId: "session-stop-outbox",
    backendKind: "cloud-api",
  });
  updateWorkspaceStatus(tracked.id, "running");
  enqueuePendingCloudMessage(tracked.id, {
    requestId: "request-stop-outbox",
    sessionId: "session-stop-outbox",
    messageId: "message-stop-outbox",
    prompt: "Never deliver after stop",
    createdAt: "2026-07-31T00:00:00.000Z",
  });
  let announceRead!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    announceRead = resolve;
  });
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const calls = stubFetch({
    "GET /v0/messages/message-stop-outbox": async () => {
      announceRead();
      await readGate;
      return json({ userMessage: "not found" }, 404);
    },
    "GET /v0/sessions/session-stop-outbox/status": () =>
      json({
        workspaceId: "workspace-stop-outbox",
        sessionId: "session-stop-outbox",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
  });

  const delivery = reconcilePendingCloudMessages(
    tracked.id,
    getWorkspace(tracked.id)!
  );
  await readStarted;
  markPendingCloudLaunchCanceled(tracked.id);
  releaseRead();
  const outcome = await delivery;

  assert.equal(outcome.status, "suppressed");
  assert.ok(!calls.includes("POST /v0/sessions/session-stop-outbox/messages"));
  assert.deepEqual(getPendingCloudMessages(tracked.id), []);
  assert.equal(getWorkspace(tracked.id)?.status, "stopped");
});

test("stop revokes an ordinary Cloud steer while remote preflight is waiting", async () => {
  const tracked = trackLocalWorkspace(
    "stop-steer-city",
    path.join(TEMP_DIR, "stop-steer-repo"),
    "Initial work"
  );
  updateWorkspaceConductorName(tracked.id, "stop-steer-cloud-city");
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-stop-steer",
    sessionId: "session-stop-steer",
    backendKind: "cloud-api",
  });
  updateWorkspaceStatus(tracked.id, "running");

  let announceSessionRead!: () => void;
  const sessionReadStarted = new Promise<void>((resolve) => {
    announceSessionRead = resolve;
  });
  let releaseSessionRead!: () => void;
  const sessionReadGate = new Promise<void>((resolve) => {
    releaseSessionRead = resolve;
  });
  const calls = stubFetch({
    "GET /v0/sessions/session-stop-steer": async () => {
      announceSessionRead();
      await sessionReadGate;
      return json({
        id: "session-stop-steer",
        deepLink:
          "conductor://workspace/workspace-stop-steer/session/session-stop-steer",
        name: "Stop steer",
        model: "gpt-5.5",
        resolvedModel: "gpt-5.5",
        archivedAt: null,
      });
    },
    "GET /v0/sessions/session-stop-steer/status": () =>
      json({
        workspaceId: "workspace-stop-steer",
        sessionId: "session-stop-steer",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "GET /v0/sessions/session-stop-steer/messages": () =>
      json({ data: [], offset: 0, hasMore: false }),
  });
  const binding = getWorkspace(tracked.id)!;
  const sending = sendToSession(
    "stop-steer-cloud-city",
    "Do not send after stop",
    [],
    { repoPath: binding.repoPath, binding }
  );

  await sessionReadStarted;
  markPendingCloudLaunchCanceled(tracked.id);
  releaseSessionRead();
  const result = await sending;

  assert.ok("error" in result);
  assert.ok(
    !calls.includes("POST /v0/sessions/session-stop-steer/messages"),
    "the revoked lease must suppress the final message POST"
  );
  assert.equal(getWorkspace(tracked.id)?.status, "stopped");
});

test("stop revokes a new Cloud thread before its first prompt POST", async () => {
  const tracked = trackLocalWorkspace(
    "stop-thread-city",
    path.join(TEMP_DIR, "stop-thread-repo"),
    "Initial work"
  );
  updateWorkspaceConductorName(tracked.id, "stop-thread-cloud-city");
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-stop-thread",
    sessionId: "session-stop-thread-old",
    backendKind: "cloud-api",
  });
  updateWorkspaceStatus(tracked.id, "running");

  let announceStatusRead!: () => void;
  const statusReadStarted = new Promise<void>((resolve) => {
    announceStatusRead = resolve;
  });
  let releaseStatusRead!: () => void;
  const statusReadGate = new Promise<void>((resolve) => {
    releaseStatusRead = resolve;
  });
  const calls = stubFetch({
    "POST /v0/sessions": () =>
      json(
        {
          id: "session-stop-thread-new",
          deepLink:
            "conductor://workspace/workspace-stop-thread/session/session-stop-thread-new",
          name: "New thread",
          model: "gpt-5.5",
          resolvedModel: "gpt-5.5",
          archivedAt: null,
        },
        201
      ),
    "GET /v0/sessions/session-stop-thread-new/status": async () => {
      announceStatusRead();
      await statusReadGate;
      return json({
        workspaceId: "workspace-stop-thread",
        sessionId: "session-stop-thread-new",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      });
    },
    "POST /v0/sessions/session-stop-thread-new/archive": () =>
      json({
        workspaceId: "workspace-stop-thread",
        sessionId: "session-stop-thread-new",
        status: "archived",
        canceledQueuedMessages: 0,
      }),
  });
  const binding = getWorkspace(tracked.id)!;
  const launching = launchWorkspaceSession(
    "stop-thread-cloud-city",
    "Do not start after stop",
    {
      repoPath: binding.repoPath,
      binding,
      agentType: "codex",
      model: "gpt-5.5",
      title: "New thread",
    }
  );

  await statusReadStarted;
  markPendingCloudLaunchCanceled(tracked.id);
  releaseStatusRead();
  const result = await launching;

  assert.ok("error" in result);
  assert.ok(
    !calls.includes("POST /v0/sessions/session-stop-thread-new/messages"),
    "the revoked lease must suppress the first prompt"
  );
  assert.ok(
    calls.includes("POST /v0/sessions/session-stop-thread-new/archive"),
    "the empty session must be archived when the send gate loses"
  );
  assert.equal(getWorkspace(tracked.id)?.status, "stopped");
});

test("stop is re-confirmed when an ordinary Cloud steer POST was already accepted", async () => {
  const tracked = trackLocalWorkspace(
    "stop-steer-post-city",
    path.join(TEMP_DIR, "stop-steer-post-repo"),
    "Initial work"
  );
  updateWorkspaceConductorName(tracked.id, "stop-steer-post-cloud-city");
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-stop-steer-post",
    sessionId: "session-stop-steer-post",
    backendKind: "cloud-api",
  });
  updateWorkspaceStatus(tracked.id, "running");

  let announcePost!: () => void;
  const postStarted = new Promise<void>((resolve) => {
    announcePost = resolve;
  });
  let releasePost!: () => void;
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  const calls = stubFetch({
    "GET /v0/sessions/session-stop-steer-post": () =>
      json({
        id: "session-stop-steer-post",
        deepLink:
          "conductor://workspace/workspace-stop-steer-post/session/session-stop-steer-post",
        name: "Stop steer post",
        model: "gpt-5.5",
        resolvedModel: "gpt-5.5",
        archivedAt: null,
      }),
    "GET /v0/sessions/session-stop-steer-post/status": () =>
      json({
        workspaceId: "workspace-stop-steer-post",
        sessionId: "session-stop-steer-post",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "GET /v0/sessions/session-stop-steer-post/messages": () =>
      json({ data: [], offset: 0, hasMore: false }),
    "POST /v0/sessions/session-stop-steer-post/messages": async (init) => {
      announcePost();
      await postGate;
      const body = JSON.parse(String(init.body));
      return json({ messageId: body.messageId, state: "queued" }, 201);
    },
    "POST /v0/sessions/session-stop-steer-post/cancel": () =>
      json({
        workspaceId: "workspace-stop-steer-post",
        sessionId: "session-stop-steer-post",
        status: "idle",
        canceledQueuedMessages: 1,
      }),
  });
  const binding = getWorkspace(tracked.id)!;
  const sending = sendToSession(
    "stop-steer-post-cloud-city",
    "Accepted just before stop",
    [],
    { repoPath: binding.repoPath, binding }
  );

  await postStarted;
  markPendingCloudLaunchCanceled(tracked.id);
  releasePost();
  const result = await sending;

  assert.ok("error" in result);
  assert.ok(
    calls.includes("POST /v0/sessions/session-stop-steer-post/cancel"),
    "a possibly accepted late message requires a fresh cancellation"
  );
  assert.equal(getWorkspace(tracked.id)?.status, "stopped");
});

test("stop rolls back a new Cloud thread whose first POST was already accepted", async () => {
  const tracked = trackLocalWorkspace(
    "stop-thread-post-city",
    path.join(TEMP_DIR, "stop-thread-post-repo"),
    "Initial work"
  );
  updateWorkspaceConductorName(tracked.id, "stop-thread-post-cloud-city");
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-stop-thread-post",
    sessionId: "session-stop-thread-post-old",
    backendKind: "cloud-api",
  });
  updateWorkspaceStatus(tracked.id, "running");

  let announcePost!: () => void;
  const postStarted = new Promise<void>((resolve) => {
    announcePost = resolve;
  });
  let releasePost!: () => void;
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  const calls = stubFetch({
    "POST /v0/sessions": () =>
      json(
        {
          id: "session-stop-thread-post-new",
          deepLink:
            "conductor://workspace/workspace-stop-thread-post/session/session-stop-thread-post-new",
          name: "New thread",
          model: "gpt-5.5",
          resolvedModel: "gpt-5.5",
          archivedAt: null,
        },
        201
      ),
    "GET /v0/sessions/session-stop-thread-post-new/status": () =>
      json({
        workspaceId: "workspace-stop-thread-post",
        sessionId: "session-stop-thread-post-new",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-stop-thread-post-new/messages": async (init) => {
      announcePost();
      await postGate;
      const body = JSON.parse(String(init.body));
      return json({ messageId: body.messageId, state: "queued" }, 201);
    },
    "POST /v0/sessions/session-stop-thread-post-new/archive": () =>
      json({
        workspaceId: "workspace-stop-thread-post",
        sessionId: "session-stop-thread-post-new",
        status: "archived",
        canceledQueuedMessages: 1,
      }),
  });
  const binding = getWorkspace(tracked.id)!;
  const launching = launchWorkspaceSession(
    "stop-thread-post-cloud-city",
    "Accepted just before stop",
    {
      repoPath: binding.repoPath,
      binding,
      agentType: "codex",
      model: "gpt-5.5",
      title: "New thread",
    }
  );

  await postStarted;
  markPendingCloudLaunchCanceled(tracked.id);
  releasePost();
  const result = await launching;

  assert.ok("error" in result);
  assert.ok(
    calls.includes("POST /v0/sessions/session-stop-thread-post-new/archive"),
    "the accepted prompt's new session must be archived"
  );
  const restored = getWorkspace(tracked.id)!;
  assert.equal(restored.conductorSessionId, "session-stop-thread-post-old");
  assert.equal(restored.status, "stopped");
});

test("done and stopped Cloud workspaces can intentionally start a new thread", async () => {
  for (const priorStatus of ["done", "stopped"] as const) {
    const suffix = priorStatus;
    const tracked = trackLocalWorkspace(
      `reopen-thread-${suffix}`,
      path.join(TEMP_DIR, `reopen-thread-${suffix}-repo`),
      "Initial work"
    );
    updateWorkspaceConductorName(tracked.id, `reopen-thread-${suffix}-cloud`);
    updateWorkspaceConductorBinding(tracked.id, {
      workspaceId: `workspace-reopen-thread-${suffix}`,
      sessionId: `session-reopen-thread-${suffix}-old`,
      backendKind: "cloud-api",
    });
    updateWorkspaceStatus(tracked.id, priorStatus);
    const calls = stubFetch({
      "POST /v0/sessions": () =>
        json(
          {
            id: `session-reopen-thread-${suffix}-new`,
            deepLink:
              `conductor://workspace/workspace-reopen-thread-${suffix}/session/session-reopen-thread-${suffix}-new`,
            name: "New thread",
            model: "gpt-5.5",
            resolvedModel: "gpt-5.5",
            archivedAt: null,
          },
          201
        ),
      [`GET /v0/sessions/session-reopen-thread-${suffix}-new/status`]: () =>
        json({
          workspaceId: `workspace-reopen-thread-${suffix}`,
          sessionId: `session-reopen-thread-${suffix}-new`,
          status: "idle",
          updatedAt: "2026-07-31T00:00:00.000Z",
        }),
      [`POST /v0/sessions/session-reopen-thread-${suffix}-new/messages`]: (
        init
      ) => {
        const body = JSON.parse(String(init.body));
        return json({ messageId: body.messageId, state: "queued" }, 201);
      },
    });
    const binding = getWorkspace(tracked.id)!;
    const result = await launchWorkspaceSession(
      `reopen-thread-${suffix}-cloud`,
      "Start again",
      {
        repoPath: binding.repoPath,
        binding,
        agentType: "codex",
        model: "gpt-5.5",
        title: "New thread",
      }
    );

    assert.ok(!("error" in result), "error" in result ? result.error : "");
    const durable = getWorkspace(tracked.id)!;
    assert.equal(
      durable.conductorSessionId,
      `session-reopen-thread-${suffix}-new`
    );
    assert.equal(durable.status, "running");
    assert.ok(
      calls.includes(
        `POST /v0/sessions/session-reopen-thread-${suffix}-new/messages`
      )
    );
  }
});

test("failed new-thread preflight restores the prior Cloud binding and status", async () => {
  const tracked = trackLocalWorkspace(
    "thread-preflight-failure",
    path.join(TEMP_DIR, "thread-preflight-failure-repo"),
    "Initial work"
  );
  updateWorkspaceConductorName(tracked.id, "thread-preflight-failure-cloud");
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-thread-preflight-failure",
    sessionId: "session-thread-preflight-failure-old",
    backendKind: "cloud-api",
  });
  updateWorkspaceStatus(tracked.id, "running");
  stubFetch({
    "POST /v0/sessions": () =>
      json(
        {
          id: "session-thread-preflight-failure-new",
          deepLink:
            "conductor://workspace/workspace-thread-preflight-failure/session/session-thread-preflight-failure-new",
          name: "New thread",
          model: "gpt-5.5",
          resolvedModel: "gpt-5.5",
          archivedAt: null,
        },
        201
      ),
    "GET /v0/sessions/session-thread-preflight-failure-new/status": () =>
      json({ userMessage: "preflight unavailable" }, 400),
    "POST /v0/sessions/session-thread-preflight-failure-new/archive": () =>
      json({
        workspaceId: "workspace-thread-preflight-failure",
        sessionId: "session-thread-preflight-failure-new",
        status: "archived",
        canceledQueuedMessages: 0,
      }),
  });
  const binding = getWorkspace(tracked.id)!;
  const result = await launchWorkspaceSession(
    "thread-preflight-failure-cloud",
    "Start new work",
    {
      repoPath: binding.repoPath,
      binding,
      agentType: "codex",
      model: "gpt-5.5",
      title: "New thread",
    }
  );

  assert.ok("error" in result);
  const restored = getWorkspace(tracked.id)!;
  assert.equal(
    restored.conductorSessionId,
    "session-thread-preflight-failure-old"
  );
  assert.equal(restored.status, "running");
});

test("a stop arriving during Cloud provisioning cannot be overwritten by persistence", async () => {
  const { repoDir, remoteDir } = createPushedRepo("stop-during-provisioning");
  const tracked = trackLocalWorkspace(
    "stop-during-provisioning-city",
    repoDir,
    "Never run after the stop"
  );
  const calls = stubFetch({
    "GET /v0/projects": () =>
      json({
        data: [
          {
            id: "proj-stop-during-provisioning",
            name: "stop-during-provisioning",
            gitRemote: remoteDir,
          },
        ],
        offset: 0,
        hasMore: false,
      }),
    "POST /v0/workspaces": () =>
      json(
        {
          workspaceId: "workspace-stop-during-provisioning",
          sessionId: "session-stop-during-provisioning",
          deepLink:
            "https://conductor.build/w/workspace-stop-during-provisioning",
        },
        201
      ),
    "GET /v0/sessions/session-stop-during-provisioning/status": () => {
      updateWorkspaceStatus(tracked.id, "stopped");
      return json({
        workspaceId: "workspace-stop-during-provisioning",
        sessionId: "session-stop-during-provisioning",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      });
    },
    "POST /v0/workspaces/workspace-stop-during-provisioning/archive": () =>
      json({
        workspaceId: "workspace-stop-during-provisioning",
        status: "archived",
      }),
  });
  const chat = fakeCtx("stop during provisioning");

  const outcome = await recoverLocalAgentFailure(
    chat.ctx,
    tracked,
    tracked.name,
    {
      isError: true,
      exitCode: 1,
      resultText: "Not logged in · Please run /login",
      hadMeaningfulActivity: false,
      authenticationFailure: true,
    },
    {
      prompt: "Never run after the stop",
      repoName: "stop-during-provisioning",
      repoPath: repoDir,
      workspaceDir: repoDir,
    }
  );

  assert.equal(outcome.handled, true);
  assert.equal(outcome.recovered, false);
  assert.match(outcome.reason ?? "", /canceled/i);
  assert.ok(
    !calls.includes(
      "POST /v0/sessions/session-stop-during-provisioning/messages"
    )
  );
  assert.ok(
    calls.includes(
      "POST /v0/workspaces/workspace-stop-during-provisioning/archive"
    )
  );
  assert.equal(getPendingCloudLaunch(tracked.id), null);
  const stopped = getWorkspace(tracked.id)!;
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.conductorBackendKind, "local");
});

test("the durable Cloud outbox preserves identical requests as distinct ordered work", () => {
  const tracked = trackLocalWorkspace(
    "duplicate-outbox-city",
    path.join(TEMP_DIR, "duplicate-outbox-repo"),
    "Repeat safely"
  );
  persistPendingCloudLaunch(tracked.id, {
    workspaceId: "workspace-duplicate-outbox",
    sessionId: "session-duplicate-outbox",
    prompt: "Initial request",
    messageId: "message-initial",
  });
  for (const suffix of ["one", "two"]) {
    enqueuePendingCloudMessage(tracked.id, {
      requestId: `request-${suffix}`,
      sessionId: "session-duplicate-outbox",
      messageId: `message-${suffix}`,
      prompt: "Run the same explicit request",
      createdAt: `2026-07-31T00:00:0${suffix === "one" ? "1" : "2"}.000Z`,
    });
  }

  assert.deepEqual(
    getPendingCloudMessages(tracked.id).map((message) => ({
      requestId: message.requestId,
      prompt: message.prompt,
    })),
    [
      { requestId: "request-one", prompt: "Run the same explicit request" },
      { requestId: "request-two", prompt: "Run the same explicit request" },
    ]
  );
  clearPendingCloudMessages(tracked.id);
  assert.deepEqual(getPendingCloudMessages(tracked.id), []);
});

test("an uncertain outbox receipt preserves its message and every later request", async () => {
  const tracked = trackLocalWorkspace(
    "uncertain-outbox-city",
    path.join(TEMP_DIR, "uncertain-outbox-repo"),
    "Initial work"
  );
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-uncertain-outbox",
    sessionId: "session-uncertain-outbox",
    backendKind: "cloud-api",
  });
  updateWorkspaceStatus(tracked.id, "running");
  for (const suffix of ["one", "two"]) {
    enqueuePendingCloudMessage(tracked.id, {
      requestId: `request-uncertain-${suffix}`,
      sessionId: "session-uncertain-outbox",
      messageId: `message-uncertain-${suffix}`,
      prompt: `Request ${suffix}`,
      createdAt: `2026-07-31T00:00:0${suffix === "one" ? "1" : "2"}.000Z`,
    });
  }
  const calls = stubFetch({
    "GET /v0/messages/*": () => json({ userMessage: "not found" }, 404),
    "GET /v0/sessions/session-uncertain-outbox/status": () =>
      json({
        workspaceId: "workspace-uncertain-outbox",
        sessionId: "session-uncertain-outbox",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-uncertain-outbox/messages": () =>
      json({ state: "queued" }, 201),
  });

  const outcome = await reconcilePendingCloudMessages(
    tracked.id,
    getWorkspace(tracked.id)!
  );

  assert.deepEqual(outcome, { status: "pending" });
  assert.equal(
    calls.filter(
      (call) =>
        call === "POST /v0/sessions/session-uncertain-outbox/messages"
    ).length,
    1
  );
  assert.deepEqual(
    getPendingCloudMessages(tracked.id).map((message) => message.requestId),
    ["request-uncertain-one", "request-uncertain-two"]
  );
});

test("proven outbox identity mismatches fail visibly instead of retrying forever", async () => {
  for (const mismatch of ["message-session", "session-workspace"] as const) {
    const tracked = trackLocalWorkspace(
      `invariant-${mismatch}-city`,
      path.join(TEMP_DIR, `invariant-${mismatch}-repo`),
      "Initial work"
    );
    const workspaceId = `workspace-invariant-${mismatch}`;
    const sessionId = `session-invariant-${mismatch}`;
    const requestId = `request-invariant-${mismatch}`;
    const messageId = `message-invariant-${mismatch}`;
    updateWorkspaceConductorBinding(tracked.id, {
      workspaceId,
      sessionId,
      backendKind: "cloud-api",
    });
    updateWorkspaceStatus(tracked.id, "running");
    enqueuePendingCloudMessage(tracked.id, {
      requestId,
      sessionId,
      messageId,
      prompt: "Keep invariant failures terminal",
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    stubFetch({
      [`GET /v0/messages/${messageId}`]: () =>
        mismatch === "message-session"
          ? json({
              id: messageId,
              sessionId: "different-session",
              sessionIndex: 1,
              type: "user",
              content: "Keep invariant failures terminal",
              receivedAt: "2026-07-31T00:00:00.000Z",
            })
          : json({ userMessage: "not found" }, 404),
      [`GET /v0/sessions/${sessionId}/status`]: () =>
        json({
          workspaceId:
            mismatch === "session-workspace"
              ? "different-workspace"
              : workspaceId,
          sessionId,
          status: "idle",
          updatedAt: "2026-07-31T00:00:00.000Z",
        }),
    });

    const outcome = await reconcilePendingCloudMessages(
      tracked.id,
      getWorkspace(tracked.id)!
    );

    assert.equal(outcome.status, "failed");
    assert.deepEqual(getPendingCloudMessages(tracked.id), []);
    assert.equal(
      getPendingCloudMessageOutcome(tracked.id, requestId)?.outcome,
      "failed"
    );
    assert.ok(
      getPendingCloudNotices(tracked.id).some(
        (notice) => notice.kind === "messages_failed"
      )
    );
  }
});

test("notice acknowledgement removes only the notice that was published", () => {
  const tracked = trackLocalWorkspace(
    "notice-ack-city",
    path.join(TEMP_DIR, "notice-ack-repo"),
    "Keep both notices"
  );
  const oldNotice = enqueuePendingCloudNotice(tracked.id, {
    kind: "messages_sent",
    count: 1,
  });
  const newNotice = enqueuePendingCloudNotice(tracked.id, {
    kind: "messages_sent",
    count: 1,
  });

  assert.equal(
    acknowledgePendingCloudNotice(tracked.id, newNotice.id),
    true
  );
  assert.deepEqual(
    getPendingCloudNotices(tracked.id).map((notice) => notice.id),
    [oldNotice.id]
  );
});

test("a persisted Cloud-first launch survives a Telegram status edit failure", async () => {
  stubFetch({
    "GET /v0/projects": () => json(PROJECTS_PAGE),
    "POST /v0/workspaces": () =>
      json(
        {
          workspaceId: "workspace-edit-fallback",
          sessionId: "session-edit-fallback",
          deepLink: "https://conductor.build/w/workspace-edit-fallback",
        },
        201
      ),
    "GET /v0/sessions/session-edit-fallback/status": () =>
      json({
        workspaceId: "workspace-edit-fallback",
        sessionId: "session-edit-fallback",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-edit-fallback/messages": (init) => {
      const body = JSON.parse(String(init.body));
      return json({ messageId: body.messageId, state: "queued" }, 201);
    },
    "GET /v0/workspaces/workspace-edit-fallback": () =>
      json({
        id: "workspace-edit-fallback",
        name: "edit-fallback-city",
        createdAt: "2026-07-31T00:00:00.000Z",
        deepLink: "https://conductor.build/w/workspace-edit-fallback",
      }),
  });
  const chat = fakeCtx("/cloud api Keep the launch bound");
  chat.ctx.telegram.editMessageText = async () => {
    throw new Error("Telegram edit unavailable");
  };

  await handleCloud(chat.ctx);

  const tracked = getAllWorkspaces(20).find(
    (workspace) => workspace.conductorWorkspaceId === "workspace-edit-fallback"
  );
  assert.equal(tracked?.status, "running");
  assert.equal(tracked?.conductorBackendKind, "cloud-api");
  assert.ok(chat.sent.some((message) => /edit-fallback-city/.test(message)));
});

test("ordinary repo launches default to the matching cloud project", async () => {
  const repoDir = path.join(TEMP_DIR, "default-cloud-api");
  mkdirSync(repoDir);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://host/org/api.git"],
    { cwd: repoDir }
  );
  const bodies: Record<string, any> = {};
  stubFetch({
    "GET /v0/projects": () => json(PROJECTS_PAGE),
    "POST /v0/workspaces": (init) => {
      bodies.createWorkspace = JSON.parse(String(init.body));
      return json(
        {
          workspaceId: "workspace-default",
          sessionId: "session-default",
          deepLink: "https://conductor.build/w/workspace-default",
        },
        201
      );
    },
    "GET /v0/sessions/session-default/status": () =>
      json({
        workspaceId: "workspace-default",
        sessionId: "session-default",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-default/messages": (init) => {
      bodies.firstPrompt = JSON.parse(String(init.body));
      return json({ messageId: bodies.firstPrompt.messageId, state: "queued" }, 201);
    },
    "GET /v0/workspaces/workspace-default": () =>
      json({
        id: "workspace-default",
        name: "cloud-first-city",
        createdAt: "2026-07-31T00:00:00.000Z",
        deepLink: "https://conductor.build/w/workspace-default",
      }),
  });
  const chat = fakeCtx("ordinary launch");

  await startWorkspaceForRepo(
    chat.ctx,
    { repoName: "api", repoPath: repoDir },
    "Fix the auth bug"
  );

  assert.equal(bodies.createWorkspace?.projectId, "proj-api");
  assert.equal(bodies.firstPrompt?.message, "Fix the auth bug");
  assert.match(chat.sent[0], /Starting ☁️ cloud workspace/);
  assert.match(chat.edits[0], /cloud-first-city/);
  const tracked = getAllWorkspaces(20).find(
    (workspace) => workspace.prompt === "Fix the auth bug"
  );
  assert.ok(tracked);
  assert.equal(tracked.repoPath, repoDir);
  assert.equal(tracked.conductorBackendKind, "cloud-api");
});

test("ordinary repo launches explain every material local fallback", async () => {
  const repoDir = path.join(TEMP_DIR, "local-fallbacks");
  mkdirSync(repoDir);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://host/org/local-only.git"],
    { cwd: repoDir }
  );
  const originalKey = process.env.CONDUCTOR_API_KEY;
  const originalBackend = process.env.CONDUCTOR_CLOUD_BACKEND;

  try {
    const attachments = fakeCtx("attachment fallback");
    const attachmentCalls = stubFetch({});
    await startWorkspaceForRepo(
      attachments.ctx,
      { repoName: "local-only", repoPath: repoDir },
      "Inspect the screenshot",
      [path.join(TEMP_DIR, "screenshot.png")]
    );
    assert.deepEqual(attachmentCalls, []);
    assert.match(attachments.sent[0], /local file bridge/);

    process.env.CONDUCTOR_CLOUD_BACKEND = "auto";
    delete process.env.CONDUCTOR_API_KEY;
    const unconfigured = fakeCtx("unconfigured fallback");
    const unconfiguredCalls = stubFetch({});
    await startWorkspaceForRepo(
      unconfigured.ctx,
      { repoName: "local-only", repoPath: repoDir },
      "Run locally"
    );
    assert.deepEqual(unconfiguredCalls, []);
    assert.match(unconfigured.sent[0], /Cloud API is not configured/);

    process.env.CONDUCTOR_API_KEY = "test-key";
    process.env.CONDUCTOR_CLOUD_BACKEND = "invalid";
    const invalid = fakeCtx("invalid fallback");
    await startWorkspaceForRepo(
      invalid.ctx,
      { repoName: "local-only", repoPath: repoDir },
      "Run with invalid config"
    );
    assert.match(invalid.sent[0], /Cloud configuration is invalid/);

    process.env.CONDUCTOR_CLOUD_BACKEND = "api";
    const lookupFailure = fakeCtx("lookup fallback");
    stubFetch({
      "GET /v0/projects": () => json({ userMessage: "unavailable" }, 503),
    });
    await startWorkspaceForRepo(
      lookupFailure.ctx,
      { repoName: "local-only", repoPath: repoDir },
      "Run after lookup failure"
    );
    assert.match(lookupFailure.sent[0], /project lookup failed/);

    const noMatch = fakeCtx("no match fallback");
    stubFetch({ "GET /v0/projects": () => json(PROJECTS_PAGE) });
    await startWorkspaceForRepo(
      noMatch.ctx,
      { repoName: "local-only", repoPath: repoDir },
      "Run without a project match"
    );
    assert.match(noMatch.sent[0], /no Cloud project matches/);
  } finally {
    if (originalKey === undefined) delete process.env.CONDUCTOR_API_KEY;
    else process.env.CONDUCTOR_API_KEY = originalKey;
    if (originalBackend === undefined) delete process.env.CONDUCTOR_CLOUD_BACKEND;
    else process.env.CONDUCTOR_CLOUD_BACKEND = originalBackend;
  }
});

test("a clean local auth failure takes over in cloud on the same remote commit", async () => {
  const { repoDir, remoteDir } = createPushedRepo("takeover");
  const tracked = trackLocalWorkspace(
    "local-city",
    repoDir,
    "Continue the task"
  );

  const bodies: Record<string, any> = {};
  stubFetch({
    "GET /v0/projects": () =>
      json({
        data: [{ id: "proj-takeover", name: "takeover", gitRemote: remoteDir }],
        offset: 0,
        hasMore: false,
      }),
    "POST /v0/workspaces": (init) => {
      bodies.createWorkspace = JSON.parse(String(init.body));
      return json(
        {
          workspaceId: "workspace-takeover",
          sessionId: "session-takeover",
          deepLink: "https://conductor.build/w/workspace-takeover",
        },
        201
      );
    },
    "GET /v0/sessions/session-takeover/status": () =>
      json({
        workspaceId: "workspace-takeover",
        sessionId: "session-takeover",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-takeover/messages": (init) => {
      bodies.firstPrompt = JSON.parse(String(init.body));
      const durable = getWorkspace(tracked.id);
      assert.equal(durable?.conductorBackendKind, "cloud-api");
      assert.equal(durable?.conductorWorkspaceId, "workspace-takeover");
      assert.ok(getPendingCloudLaunch(tracked.id));
      return json({ messageId: bodies.firstPrompt.messageId, state: "queued" }, 201);
    },
    "GET /v0/workspaces/workspace-takeover": () => {
      assert.equal(
        getPendingCloudLaunch(tracked.id)?.phase,
        "sent",
        "the API receipt must stay durable across workspace-name lookup"
      );
      assert.equal(getWorkspace(tracked.id)?.status, "starting");
      assert.equal(getThreadCursor(tracked.id, "session-takeover"), undefined);
      return json({
        id: "workspace-takeover",
        name: "cloud-takeover-city",
        createdAt: "2026-07-31T00:00:00.000Z",
        deepLink: "https://conductor.build/w/workspace-takeover",
      });
    },
  });
  const chat = fakeCtx("local auth failure");
  const outcome = await recoverLocalAgentFailure(
    chat.ctx,
    tracked,
    "local-city",
    {
      isError: true,
      exitCode: 1,
      resultText: "Not logged in · Please run /login",
      hadMeaningfulActivity: false,
      authenticationFailure: true,
    },
    {
      prompt: "Continue the task",
      repoName: "takeover",
      repoPath: repoDir,
      workspaceDir: repoDir,
    }
  );

  assert.equal(outcome.recovered, true);
  assert.equal(bodies.createWorkspace?.projectId, "proj-takeover");
  assert.equal(bodies.createWorkspace?.branch, "main");
  assert.match(bodies.firstPrompt?.message ?? "", /^Continue the task/);
  assert.match(bodies.firstPrompt?.message ?? "", /Expected remote state: main at/);
  assert.match(bodies.firstPrompt?.message ?? "", /verify HEAD before any side effect/);
  assert.match(chat.sent.at(-1) ?? "", /Switching to Conductor Cloud/);
  assert.match(chat.edits.at(-1) ?? "", /took over/);
  const recovered = getWorkspace(tracked.id)!;
  assert.equal(recovered.status, "running");
  assert.equal(recovered.conductorBackendKind, "cloud-api");
  assert.equal(recovered.conductorWorkspaceId, "workspace-takeover");
  assert.equal(recovered.conductorSessionId, "session-takeover");
  assert.equal(getPendingCloudLaunch(tracked.id), null);
  assert.equal(
    getThreadCursor(tracked.id, "session-takeover")?.lastMessageId,
    bodies.firstPrompt?.messageId
  );
});

test("auth recovery resolves the Cloud project from the verified worktree origin", async () => {
  const { repoDir, remoteDir: rootRemoteDir } = createPushedRepo(
    "divergent-origin"
  );
  const worktreeRemoteDir = path.join(
    TEMP_DIR,
    "divergent-origin-worktree.git"
  );
  const workspaceDir = path.join(TEMP_DIR, "divergent-origin-worktree");
  const git = (args: string[], cwd?: string) =>
    execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

  git(["init", "--bare", worktreeRemoteDir]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], worktreeRemoteDir);
  git(["push", worktreeRemoteDir, "main:main"], repoDir);
  git(["config", "extensions.worktreeConfig", "true"], repoDir);
  git(
    ["worktree", "add", "-b", "divergent-origin-task", workspaceDir, "HEAD"],
    repoDir
  );
  git(["config", "--worktree", "remote.origin.url", rootRemoteDir], repoDir);
  git(
    ["config", "--worktree", "remote.origin.url", worktreeRemoteDir],
    workspaceDir
  );

  assert.equal(
    git(["config", "--get", "remote.origin.url"], repoDir),
    rootRemoteDir
  );
  assert.equal(
    git(["config", "--get", "remote.origin.url"], workspaceDir),
    worktreeRemoteDir
  );

  const tracked = trackLocalWorkspace(
    "divergent-origin-local-city",
    repoDir,
    "Continue from the verified worktree"
  );
  const createWorkspaceBodies: Array<Record<string, unknown>> = [];
  stubFetch({
    "GET /v0/projects": () =>
      json({
        data: [
          {
            id: "proj-root-origin",
            name: "divergent-origin-root",
            gitRemote: rootRemoteDir,
          },
          {
            id: "proj-worktree-origin",
            name: "divergent-origin-worktree",
            gitRemote: worktreeRemoteDir,
          },
        ],
        offset: 0,
        hasMore: false,
      }),
    "POST /v0/workspaces": (init) => {
      createWorkspaceBodies.push(JSON.parse(String(init.body)));
      return json({ userMessage: "stop after project selection" }, 400);
    },
  });

  const outcome = await recoverLocalAgentFailure(
    fakeCtx("divergent worktree origin").ctx,
    tracked,
    "divergent-origin-local-city",
    {
      isError: true,
      exitCode: 1,
      resultText: "Not logged in · Please run /login",
      hadMeaningfulActivity: false,
      authenticationFailure: true,
    },
    {
      prompt: "Continue from the verified worktree",
      repoName: "divergent-origin",
      repoPath: repoDir,
      workspaceDir,
    }
  );

  assert.equal(outcome.handled, true);
  assert.equal(outcome.recovered, false);
  assert.equal(createWorkspaceBodies[0]?.projectId, "proj-worktree-origin");
  assert.equal(createWorkspaceBodies[0]?.branch, "main");
});

test("auth recovery aborts before sending when the remote branch moves during provisioning", async () => {
  const { repoDir, remoteDir } = createPushedRepo("moving-takeover");
  const tracked = trackLocalWorkspace(
    "moving-local-city",
    repoDir,
    "Continue only from this commit"
  );
  let moved = false;
  const calls = stubFetch({
    "GET /v0/projects": () =>
      json({
        data: [
          {
            id: "proj-moving",
            name: "moving-takeover",
            gitRemote: remoteDir,
          },
        ],
        offset: 0,
        hasMore: false,
      }),
    "POST /v0/workspaces": () =>
      json(
        {
          workspaceId: "workspace-moving",
          sessionId: "session-moving",
          deepLink: "https://conductor.build/w/workspace-moving",
        },
        201
      ),
    "GET /v0/sessions/session-moving/status": () => {
      if (!moved) {
        moved = true;
        writeFileSync(path.join(repoDir, "moved.txt"), "new remote head\n");
        execFileSync("git", ["add", "moved.txt"], { cwd: repoDir });
        execFileSync("git", ["commit", "-m", "move branch"], { cwd: repoDir });
        execFileSync("git", ["push", "origin", "main"], { cwd: repoDir });
      }
      return json({
        workspaceId: "workspace-moving",
        sessionId: "session-moving",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      });
    },
    "POST /v0/workspaces/workspace-moving/archive": () =>
      json({ workspaceId: "workspace-moving", status: "archived" }),
  });
  const chat = fakeCtx("moving branch takeover");

  const outcome = await recoverLocalAgentFailure(
    chat.ctx,
    tracked,
    "moving-local-city",
    {
      isError: true,
      exitCode: 1,
      resultText: "Not logged in · Please run /login",
      hadMeaningfulActivity: false,
      authenticationFailure: true,
    },
    {
      prompt: "Continue only from this commit",
      repoName: "moving-takeover",
      repoPath: repoDir,
      workspaceDir: repoDir,
    }
  );

  assert.equal(outcome.handled, true);
  assert.equal(outcome.recovered, false);
  assert.match(outcome.reason ?? "", /Origin branch main moved/);
  assert.ok(!calls.includes("POST /v0/sessions/session-moving/messages"));
  assert.ok(calls.includes("POST /v0/workspaces/workspace-moving/archive"));
  assert.equal(getWorkspace(tracked.id)?.conductorBackendKind, "local");
});

test("overlapping auth failures forward every distinct prompt through one takeover", async () => {
  const { repoDir, remoteDir } = createPushedRepo("overlap-takeover");
  const tracked = trackLocalWorkspace(
    "overlap-local-city",
    repoDir,
    "Original task"
  );
  const messageBodies: Array<Record<string, any>> = [];
  let announceFirstSend!: () => void;
  const firstSendStarted = new Promise<void>((resolve) => {
    announceFirstSend = resolve;
  });
  let releaseFirstSend!: () => void;
  const firstSendGate = new Promise<void>((resolve) => {
    releaseFirstSend = resolve;
  });
  const calls = stubFetch({
    "GET /v0/projects": () =>
      json({
        data: [
          {
            id: "proj-overlap",
            name: "overlap-takeover",
            gitRemote: remoteDir,
          },
        ],
        offset: 0,
        hasMore: false,
      }),
    "POST /v0/workspaces": () =>
      json(
        {
          workspaceId: "workspace-overlap",
          sessionId: "session-overlap",
          deepLink: "https://conductor.build/w/workspace-overlap",
        },
        201
      ),
    "GET /v0/sessions/session-overlap": () =>
      json({
        id: "session-overlap",
        deepLink: "https://conductor.build/s/session-overlap",
        model: "fable-5",
      }),
    "GET /v0/sessions/session-overlap/status": () =>
      json({
        workspaceId: "workspace-overlap",
        sessionId: "session-overlap",
        status: messageBodies.length === 0 ? "idle" : "working",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "GET /v0/sessions/session-overlap/messages": () =>
      json({
        data: [
          {
            id: String(messageBodies[0]?.messageId ?? "message-first"),
            sessionId: "session-overlap",
            sessionIndex: 1,
            type: "user",
            content: "Recover the first request",
            receivedAt: "2026-07-31T00:00:00.000Z",
          },
        ],
        offset: 0,
        hasMore: false,
      }),
    "GET /v0/messages/*": () => json({ userMessage: "not found" }, 404),
    "POST /v0/sessions/session-overlap/messages": async (init) => {
      const body = JSON.parse(String(init.body));
      messageBodies.push(body);
      if (messageBodies.length === 1) {
        announceFirstSend();
        await firstSendGate;
      }
      return json({ messageId: body.messageId, state: "queued" }, 201);
    },
    "GET /v0/workspaces/workspace-overlap": () =>
      json({
        id: "workspace-overlap",
        name: "overlap-cloud-city",
        createdAt: "2026-07-31T00:00:00.000Z",
        deepLink: "https://conductor.build/w/workspace-overlap",
      }),
  });
  const chat = fakeCtx("overlapping takeover");
  const authFailure = {
    isError: true as const,
    exitCode: 1,
    resultText: "Not logged in · Please run /login",
    hadMeaningfulActivity: false,
    authenticationFailure: true,
  };

  const first = recoverLocalAgentFailure(
    chat.ctx,
    tracked,
    "overlap-local-city",
    authFailure,
    {
      prompt: "Recover the first request",
      repoName: "overlap-takeover",
      repoPath: repoDir,
      workspaceDir: repoDir,
    }
  );
  await firstSendStarted;
  const second = recoverLocalAgentFailure(
    chat.ctx,
    tracked,
    "overlap-local-city",
    authFailure,
    {
      prompt: "Recover the second request",
      repoName: "overlap-takeover",
      repoPath: repoDir,
      workspaceDir: repoDir,
    }
  );
  await Promise.resolve();
  const durableOverlap = getPendingCloudMessages(tracked.id);
  assert.equal(durableOverlap.length, 1);
  assert.equal(durableOverlap[0]?.prompt, "Recover the second request");
  releaseFirstSend();
  const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

  assert.equal(firstOutcome.recovered, true);
  assert.equal(secondOutcome.recovered, true);
  assert.equal(
    calls.filter((call) => call === "POST /v0/workspaces").length,
    1
  );
  assert.equal(messageBodies.length, 2);
  assert.match(messageBodies[0].message, /^Recover the first request/);
  assert.match(messageBodies[0].message, /verify HEAD before any side effect/);
  assert.equal(messageBodies[1].message, "Recover the second request");
  assert.deepEqual(getPendingCloudMessages(tracked.id), []);
});

test("auth recovery fails closed for dirty work and explains the skipped takeover", async () => {
  const { repoDir } = createPushedRepo("dirty-takeover");
  writeFileSync(path.join(repoDir, "local-only.txt"), "not pushed\n");
  const tracked = trackLocalWorkspace(
    "dirty-local-city",
    repoDir,
    "Preserve my local work"
  );
  const calls = stubFetch({});
  const chat = fakeCtx("dirty auth failure");

  await observeAgentCompletion(
    chat.ctx,
    tracked,
    "dirty-local-city",
    Promise.resolve({
      isError: true,
      exitCode: 1,
      resultText: "Not logged in · Please run /login",
      hadMeaningfulActivity: false,
      authenticationFailure: true,
    }),
    {
      cloudRecovery: {
        prompt: "Preserve my local work",
        repoName: "dirty-takeover",
        repoPath: repoDir,
        workspaceDir: repoDir,
      },
    }
  );

  assert.deepEqual(calls, [], "dirty work blocks Cloud before API lookup");
  assert.equal(getWorkspace(tracked.id)?.status, "failed");
  assert.match(chat.replies.at(-1) ?? "", /changes that are not available in Cloud/);
  assert.match(chat.replies.at(-1) ?? "", /Not logged in/);
});

test("auth recovery never replays a local run that already produced activity", async () => {
  const { repoDir } = createPushedRepo("active-before-auth");
  const tracked = trackLocalWorkspace(
    "active-local-city",
    repoDir,
    "Deploy the release"
  );
  const calls = stubFetch({});
  const chat = fakeCtx("partial auth failure");

  const outcome = await recoverLocalAgentFailure(
    chat.ctx,
    tracked,
    "active-local-city",
    {
      isError: true,
      exitCode: 1,
      resultText: "Not logged in · Please run /login",
      hadMeaningfulActivity: true,
      authenticationFailure: true,
    },
    {
      prompt: "Deploy the release",
      repoName: "active-before-auth",
      repoPath: repoDir,
      workspaceDir: repoDir,
    }
  );

  assert.equal(outcome.handled, false);
  assert.equal(outcome.recovered, false);
  assert.match(outcome.reason ?? "", /duplicate side effects/);
  assert.deepEqual(calls, []);

  const textOnly = await recoverLocalAgentFailure(
    chat.ctx,
    tracked,
    "active-local-city",
    {
      isError: true,
      exitCode: 1,
      resultText: "Not logged in · Please run /login",
      hadMeaningfulActivity: false,
    },
    {
      prompt: "Deploy the release",
      repoName: "active-before-auth",
      repoPath: repoDir,
      workspaceDir: repoDir,
    }
  );
  assert.match(textOnly.reason ?? "", /could not confirm/);
  assert.deepEqual(calls, []);
});

test("auth recovery reports a Cloud launch failure and marks the workspace failed", async () => {
  const { repoDir, remoteDir } = createPushedRepo("failed-takeover");
  const tracked = trackLocalWorkspace(
    "failed-local-city",
    repoDir,
    "Retry in Cloud"
  );
  stubFetch({
    "GET /v0/projects": () =>
      json({
        data: [{ id: "proj-failed", name: "failed-takeover", gitRemote: remoteDir }],
        offset: 0,
        hasMore: false,
      }),
    "POST /v0/workspaces": () => json({ userMessage: "quota exceeded" }, 400),
  });
  const chat = fakeCtx("failed cloud takeover");
  chat.ctx.telegram.editMessageText = async () => {
    throw new Error("Telegram edit unavailable");
  };

  const outcome = await recoverLocalAgentFailure(
    chat.ctx,
    tracked,
    "failed-local-city",
    {
      isError: true,
      exitCode: 1,
      resultText: "Not logged in · Please run /login",
      hadMeaningfulActivity: false,
      authenticationFailure: true,
    },
    {
      prompt: "Retry in Cloud",
      repoName: "failed-takeover",
      repoPath: repoDir,
      workspaceDir: repoDir,
    }
  );

  assert.equal(outcome.handled, true);
  assert.equal(outcome.recovered, false);
  assert.equal(getWorkspace(tracked.id)?.status, "failed");
  assert.match(chat.sent.at(-1) ?? "", /Cloud takeover.*also failed/);
  assert.match(chat.sent.at(-1) ?? "", /quota exceeded/);
});

test("successful Cloud takeover survives a Telegram status edit failure", async () => {
  const { repoDir, remoteDir } = createPushedRepo("notice-takeover");
  const tracked = trackLocalWorkspace(
    "notice-local-city",
    repoDir,
    "Keep going in Cloud"
  );
  stubFetch({
    "GET /v0/projects": () =>
      json({
        data: [{ id: "proj-notice", name: "notice-takeover", gitRemote: remoteDir }],
        offset: 0,
        hasMore: false,
      }),
    "POST /v0/workspaces": () =>
      json(
        {
          workspaceId: "workspace-notice",
          sessionId: "session-notice",
          deepLink: "https://conductor.build/w/workspace-notice",
        },
        201
      ),
    "GET /v0/sessions/session-notice/status": () =>
      json({
        workspaceId: "workspace-notice",
        sessionId: "session-notice",
        status: "idle",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }),
    "POST /v0/sessions/session-notice/messages": (init) => {
      const body = JSON.parse(String(init.body));
      return json({ messageId: body.messageId, state: "queued" }, 201);
    },
    "GET /v0/workspaces/workspace-notice": () =>
      json({
        id: "workspace-notice",
        name: "notice-cloud-city",
        createdAt: "2026-07-31T00:00:00.000Z",
        deepLink: "https://conductor.build/w/workspace-notice",
      }),
  });
  const chat = fakeCtx("notice failure");
  chat.ctx.telegram.editMessageText = async () => {
    throw new Error("Telegram edit unavailable");
  };

  const outcome = await recoverLocalAgentFailure(
    chat.ctx,
    tracked,
    "notice-local-city",
    {
      isError: true,
      exitCode: 1,
      resultText: "Not logged in · Please run /login",
      hadMeaningfulActivity: false,
      authenticationFailure: true,
    },
    {
      prompt: "Keep going in Cloud",
      repoName: "notice-takeover",
      repoPath: repoDir,
      workspaceDir: repoDir,
    }
  );

  assert.equal(outcome.handled, true);
  assert.equal(outcome.recovered, true);
  assert.equal(getWorkspace(tracked.id)?.conductorBackendKind, "cloud-api");
  assert.ok(chat.sent.some((message) => /took over/.test(message)));
});

test("ordinary agent failures surface result text and mark the workspace failed", async () => {
  const tracked = trackLocalWorkspace(
    "ordinary-failure-city",
    path.join(TEMP_DIR, "ordinary-failure-repo"),
    "Run the checks"
  );
  const chat = fakeCtx("ordinary failure");

  await observeAgentCompletion(
    chat.ctx,
    tracked,
    "ordinary-failure-city",
    Promise.resolve({
      isError: true,
      exitCode: 2,
      resultText: "Tests failed in src/auth.ts",
    })
  );

  assert.equal(getWorkspace(tracked.id)?.status, "failed");
  assert.match(chat.replies.at(-1) ?? "", /exit 2/);
  assert.match(chat.replies.at(-1) ?? "", /Tests failed in src\/auth\.ts/);
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

test("a Cloud stop that can never succeed gives up instead of gating forever", async () => {
  const tracked = trackLocalWorkspace(
    "doomed-stop-city",
    path.join(TEMP_DIR, "doomed-stop-repo"),
    "This stop can never be confirmed"
  );
  updateWorkspaceConductorName(tracked.id, "doomed-stop-cloud-city");
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-doomed-stop",
    sessionId: "session-doomed-stop",
    backendKind: "cloud-api",
  });
  updateWorkspaceStatus(tracked.id, "running");
  assert.equal(markPendingCloudLaunchCanceled(tracked.id), true);
  assert.equal(getPendingCloudTerminalIntent(tracked.id)?.action, "stop");

  // 400 is not in the retryable set, so retrying it just reproduces it.
  stubFetch({
    "GET /v0/sessions/session-doomed-stop/status": () =>
      json({ userMessage: "unknown session" }, 400),
  });
  const failed = await reconcilePendingCloudTerminalIntent(tracked.id);

  assert.equal(failed.status, "failed");
  assert.equal(getPendingCloudTerminalIntent(tracked.id), null);
  assert.ok(
    getPendingCloudNotices(tracked.id).some(
      (notice) => notice.kind === "stop_failed"
    )
  );
});

test("a workspace-identity mismatch retires the stop rather than self-trapping", async () => {
  const tracked = trackLocalWorkspace(
    "mismatch-stop-city",
    path.join(TEMP_DIR, "mismatch-stop-repo"),
    "This stop points at the wrong workspace"
  );
  updateWorkspaceConductorName(tracked.id, "mismatch-stop-cloud-city");
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-mismatch-stop",
    sessionId: "session-mismatch-stop",
    backendKind: "cloud-api",
  });
  updateWorkspaceStatus(tracked.id, "running");
  assert.equal(markPendingCloudLaunchCanceled(tracked.id), true);

  // The guard throws a ConductorApiError with a null status, which the old
  // catch treated as "not 404, so retry" — forever, since the stored ids
  // never change.
  stubFetch({
    "GET /v0/sessions/session-mismatch-stop/status": () =>
      json({
        workspaceId: "workspace-somebody-else",
        sessionId: "session-mismatch-stop",
        status: "working",
        updatedAt: "2026-08-27T00:00:00.000Z",
      }),
  });
  const failed = await reconcilePendingCloudTerminalIntent(tracked.id);

  assert.equal(failed.status, "failed");
  assert.match(
    failed.status === "failed" ? failed.error : "",
    /identity mismatch/
  );
  assert.equal(getPendingCloudTerminalIntent(tracked.id), null);
});

test("a work lease orphaned by a crash expires instead of retiring the workspace", () => {
  const tracked = trackLocalWorkspace(
    "orphan-lease-city",
    path.join(TEMP_DIR, "orphan-lease-repo"),
    "A crash stranded this lease"
  );
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-orphan-lease",
    sessionId: "session-orphan-lease",
    backendKind: "cloud-api",
  });
  updateWorkspaceStatus(tracked.id, "running");

  const writeLease = (ageMs: number) =>
    getDb()
      .prepare(
        `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(
        `cloud-work-leases:${tracked.id}`,
        JSON.stringify([
          {
            token: "token-from-a-dead-process",
            workspaceId: "workspace-orphan-lease",
            createdAt: new Date(Date.now() - ageMs).toISOString(),
          },
        ]),
        new Date().toISOString()
      );

  // A lease a live send could still be holding keeps blocking.
  writeLease(60_000);
  assert.equal(
    beginCloudWorkLease(tracked.id, "workspace-orphan-lease"),
    null
  );

  // One older than any legitimate hold must not block the workspace forever.
  writeLease(30 * 60_000);
  assert.ok(beginCloudWorkLease(tracked.id, "workspace-orphan-lease"));
});

test("recovery notices stay bounded when Telegram never accepts them", () => {
  const tracked = trackLocalWorkspace(
    "notice-flood-city",
    path.join(TEMP_DIR, "notice-flood-repo"),
    "Notices pile up while delivery fails"
  );
  for (let index = 0; index < 60; index += 1) {
    enqueuePendingCloudNotice(tracked.id, {
      kind: "messages_failed",
      count: 1,
      error: `failure ${index}`,
    });
  }
  const notices = getPendingCloudNotices(tracked.id);

  assert.equal(notices.length, 50);
  // The newest are the ones worth replaying, so the oldest are dropped.
  assert.match(notices.at(-1)?.error ?? "", /failure 59/);
  assert.match(notices[0]?.error ?? "", /failure 10/);
});

test("a rebound workspace row cannot mark an older launch prompt sent", () => {
  const tracked = trackLocalWorkspace(
    "rebound-launch-city",
    path.join(TEMP_DIR, "rebound-launch-repo"),
    "An older prompt must not land in a newer session"
  );
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-rebound",
    sessionId: "session-rebound-old",
    backendKind: "cloud-api",
  });
  updateWorkspaceStatus(tracked.id, "starting");
  getDb()
    .prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(
      `pending-cloud-launch:${tracked.id}`,
      JSON.stringify({
        workspaceId: "workspace-rebound",
        sessionId: "session-rebound-old",
        prompt: "the older prompt",
        messageId: "message-rebound",
        phase: "send",
      }),
      new Date().toISOString()
    );

  assert.equal(
    markPendingCloudLaunchSent(
      tracked.id,
      "message-rebound",
      "workspace-rebound",
      "session-rebound-old"
    ),
    true
  );

  // Rebind the row to a different session without clearing the saga.
  getDb()
    .prepare(
      `UPDATE meta SET value = ? WHERE key = ?`
    )
    .run(
      JSON.stringify({
        workspaceId: "workspace-rebound",
        sessionId: "session-rebound-old",
        prompt: "the older prompt",
        messageId: "message-rebound",
        phase: "send",
      }),
      `pending-cloud-launch:${tracked.id}`
    );
  updateWorkspaceConductorBinding(tracked.id, {
    workspaceId: "workspace-rebound",
    sessionId: "session-rebound-new",
    backendKind: "cloud-api",
  });
  updateWorkspaceStatus(tracked.id, "starting");

  assert.equal(
    markPendingCloudLaunchSent(
      tracked.id,
      "message-rebound",
      "workspace-rebound",
      "session-rebound-old"
    ),
    false
  );
});
