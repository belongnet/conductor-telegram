import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { getDb, closeDb } from "../src/store/db.js";
import { createWorkspace, getWorkspace, getDecision, answerDecision, getWorkspaceMessageTarget, getThreadCursor, updateWorkspaceThreadId, upsertRepoTopic, linkTelegramMessage } from "../src/store/queries.js";
import { GatewayStore } from "../src/cloud/store.js";
import { FileBridge, startBridge, gatewayHealth } from "../src/cloud/bridge.js";
import { CloudEngine, messageContainsExactText } from "../src/cloud/engine.js";
import { CloudGitHub, GitHubError } from "../src/cloud/catalog.js";
import { enqueueTelegram, enqueueText, enqueueStatus, TelegramDelivery, processQueue, ingestTelegram, reportBlocked, safeDetail, ATTENTION_AFTER_MS } from "../src/cloud/telegram.js";
import { ConductorApiError, type ConductorApiClient } from "../src/integrations/conductor-api.js";
import { CloudCommands, repoTopicCandidates } from "../src/cloud/commands.js";
import { readWorkspaceArtifact } from "../src/mcp/remote.js";
import { acquireGatewayLease } from "../src/cloud/runtime.js";
import {CloudPoller} from "../src/cloud/poller.js";

async function fixture(fn: (f: ReturnType<typeof createFixture>) => Promise<void>): Promise<void> {
  const f = createFixture();
  try { await fn(f); } finally { closeDb(); rmSync(f.dir, { recursive: true, force: true }); }
}
function createFixture() {
  closeDb(); const dir = mkdtempSync(path.join(os.tmpdir(), "ct-cloud-"));
  const store = new GatewayStore(getDb(path.join(dir, "state.db")));
  const ws = createWorkspace({ name: "test", prompt: "Fix the bug", repoPath: "conductor-project:p1", telegramChatId: "42" });
  const bridge = new FileBridge(store, "http://127.0.0.1", path.join(dir, "files"));
  const messages: any[] = [];
  let creates = 0; let sends = 0;
  const sessions: any[] = [{ id: "s1", name: "Task", deepLink: "conductor://s1" }];
  let sessionStatus: "idle" | "working" | "error" = "idle";
  let errorMessage = "quota exhausted";
  const api = {
    listProjects: async () => [{ id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git" }],
    getIdentity: async () => ({ userId: "owner" }),
    createWorkspace: async () => { creates++; return { workspaceId: "w1", sessionId: "s1", deepLink: "conductor://w1" }; },
    getWorkspace: async () => ({ id: "w1", name: "workspace", repoUrl: "https://github.com/org/repo", deepLink: "conductor://w1" }),
    getWorkspaceStatus: async () => ({ workspaceId: "w1", status: "ready" }),
    listProjectWorkspaces: async () => [],
    listWorkspaceSessions: async () => sessions,
    getSession: async (id: string) => ({...sessions.find(session => session.id === id), model: "fable-5-1"}),
    createSession: async (input: any) => { const session = { id: `s${sessions.length + 1}`, name: input.name, deepLink: "conductor://session" }; sessions.push(session); return session; },
    getSessionStatus: async (sessionId: string) => ({ workspaceId: "w1", sessionId, status: sessionStatus, errorMessage }),
    getMessage: async (id: string) => { const message = messages.find(m => m.id === id); if (!message) throw new ConductorApiError("Not found", 404); return message; },
    sendMessage: async (input: any) => { sends++; messages.push({ id: input.messageId, sessionId: input.sessionId, type: "user", content: input.message, sessionIndex: messages.length, receivedAt: new Date().toISOString() }); return { messageId: input.messageId, state: "sent" }; },
    listSessionMessages: async ({ sessionId, after }: any) => {
      const filtered = messages.filter(m => m.sessionId === sessionId); const index = filtered.findIndex(m => m.id === after);
      return after ? filtered.slice(index + 1) : filtered;
    },
    getSessionMessageTail: async (id: string) => messages.filter(m => m.sessionId === id),
    getLatestSessionMessage: async (id: string) => messages.filter(m => m.sessionId === id).at(-1) ?? null,
    cancelSession: async (id: string) => ({ workspaceId: "w1", sessionId: id, status: "idle", canceledQueuedMessages: 0 }),
    archiveWorkspace: async () => ({ workspaceId: "w1", status: "archived" }),
  };
  const engine = new CloudEngine(store, api as unknown as ConductorApiClient, bridge, new CloudGitHub("test"), undefined, true);
  // No test may reach api.github.com. A test about repository access replaces this.
  engine.github.access = async () => ({readable: true, status: 200});
  store.set("conductor-user-id", "owner");
  async function launch() { engine.queue("launch", { type: "launch", trackedId: ws.id, projectId: "p1", prompt: "Fix\nthe bug" }); await processQueue(store, ["cloud"], r => engine.action(r)); }
  return { dir, store, ws, bridge, api, engine, messages, sessions, launch, counts: () => ({ creates, sends }),
    status: (value: typeof sessionStatus, detail = errorMessage) => { sessionStatus = value; errorMessage = detail; store.set(`poll-after:${ws.id}`, 0); } };
}

/** Every repo-topic test needs the same forum group, the topic row, and owner-scoped commands. */
function repoTopic(f: ReturnType<typeof createFixture>, repoName: string, threadId = 5): CloudCommands {
  f.store.db.prepare("UPDATE workspaces SET telegram_chat_id='-42' WHERE id=?").run(f.ws.id);
  upsertRepoTopic({chatId: "-42", repoPath: `/Users/legacy/repos/${repoName}`, repoName, telegramThreadId: threadId});
  return new CloudCommands(f.store, f.engine, async () => ({}), "-42", "9");
}

test("cloud launch sends over native API without a desktop database or checkout", () => fixture(async f => {
  await f.launch();
  assert.deepEqual(f.counts(), { creates: 1, sends: 1 });
  assert.equal(f.store.binding(f.ws.id)?.repoSlug, "org/repo");
  assert.equal(getWorkspace(f.ws.id)?.conductorBackendKind, "cloud-api");
  assert.equal(f.store.row("launch")?.state, "done");
  assert.equal(JSON.parse(f.store.row("launch:created:0")!.payload).payload.disable_notification, true);
  assert.equal(JSON.parse(f.store.row("launch:sent:0")!.payload).payload.disable_notification, true);
}));

test("readiness ignores old polling errors only after the workspace is retired", () => fixture(async f => {
  await f.launch();
  const now = Date.now();
  f.store.set("ingestion-last-success", now);
  f.store.set("cloud-access-last-success", now);
  f.store.set(`poll-success:${f.ws.id}`, now - 180_000);
  f.store.set(`poll-error:${f.ws.id}`, now - 1000);
  assert.equal(gatewayHealth(f.store, now).ready, false);
  f.store.db.prepare("UPDATE workspaces SET status='stopped' WHERE id=?").run(f.ws.id);
  assert.equal(gatewayHealth(f.store, now).ready, false);
  f.store.db.prepare("UPDATE workspaces SET status='failed',archived_at=? WHERE id=?").run(new Date(now).toISOString(), f.ws.id);
  const health = gatewayHealth(f.store, now);
  assert.equal(health.ready, true);
  assert.equal(health.checks.stalledWorkspaces, 0);
  assert.equal(f.store.get(`poll-error:${f.ws.id}`), now - 1000);
}));

test("closing an already deleted retired topic does not block delivery", () => fixture(async f => {
  updateWorkspaceThreadId(f.ws.id, 123);
  f.store.db.prepare("UPDATE workspaces SET archived_at=? WHERE id=?").run(new Date().toISOString(), f.ws.id);
  enqueueTelegram(f.store, "retire-topic", {method: "closeForumTopic", workspaceId: f.ws.id,
    payload: {chat_id: "42", message_thread_id: 123}});
  const methods: string[] = [];
  await new TelegramDelivery(f.store, async method => {
    methods.push(method);
    throw {response: {error_code: 400, description: "Bad Request: TOPIC_ID_INVALID"}};
  }).tick();
  assert.deepEqual(methods, ["closeForumTopic"]);
  assert.equal(f.store.row("retire-topic")?.state, "done");
  assert.equal(f.store.backlog().blocked, 0);
  assert.equal(f.store.row("topic-recover:retire-topic"), undefined);
}));

test("an invalid topic for active work is recovered without dropping its message", () => fixture(async f => {
  updateWorkspaceThreadId(f.ws.id, 123);
  enqueueTelegram(f.store, "active-message", {method: "sendMessage", workspaceId: f.ws.id,
    payload: {chat_id: "42", text: "Agent reply"}});
  await new TelegramDelivery(f.store, async () => {
    throw {response: {error_code: 400, description: "Bad Request: TOPIC_ID_INVALID"}};
  }).tick();
  assert.equal(f.store.row("active-message")?.state, "pending");
  assert.equal(JSON.parse(f.store.row("topic-recover:active-message")!.payload).method, "createForumTopic");
}));

test("replies to migrated local history never queue cloud work against an unbound record", () => fixture(async f => {
  f.store.db.prepare("UPDATE workspaces SET repo_path=?,status='done' WHERE id=?").run("/Users/legacy/project", f.ws.id);
  const before = getWorkspace(f.ws.id);
  const {linkTelegramMessage} = await import("../src/store/queries.js");
  linkTelegramMessage("42", "90", f.ws.id, "legacy-session");
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42");
  for (const [i, extra] of [{text: "continue"}, {text: "/send continue"}, {voice: {file_id: "voice"}}].entries()) {
    const id=i+1;
    f.store.ingest([{update_id: id, message: {message_id: 100+id, chat: {id: 42}, reply_to_message: {message_id: 90}, ...extra}}]);
    await processQueue(f.store, ["update"], row => commands.handle(row));
    assert.equal(f.store.row(`update:${id}:action`), undefined);
    assert.equal(f.store.row(`update:${id}:media`), undefined);
    assert.match(JSON.parse(f.store.row(`update:${id}:reply:0`)!.payload).payload.text, /historical.*\/run/is);
  }
  assert.deepEqual(getWorkspace(f.ws.id), before);
  assert.deepEqual(f.counts(), {creates: 0, sends: 0});
  f.store.ingest([{update_id: 4, message: {message_id: 104, chat: {id: 42}, reply_to_message: {message_id: 90}, text: "/run p1 Start new work"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const action=JSON.parse(f.store.row("update:4:action")!.payload);
  assert.notEqual(action.trackedId, f.ws.id);
  assert.equal(action.projectId, "p1");
  assert.equal(action.sessionId, undefined);
}));

test("uncertain workspace creation is reconciled without another create", () => fixture(async f => {
  f.api.createWorkspace = async () => { throw new Error("lost receipt"); };
  await f.launch();
  assert.equal(f.store.get("create-attempt:launch"), true);
  f.store.retry("launch", "retry", 0);
  let duplicate = false; f.api.createWorkspace = async () => { duplicate = true; throw new Error("must not run"); };
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(duplicate, false);
  assert.match(f.store.row("launch")?.error ?? "", /uncertain/);
}));

for (const type of ["launch", "thread"] as const) test(`${type} retries creation after a rate limit`, () => fixture(async f => {
  if (type === "thread") await f.launch();
  let creates = 0;
  if (type === "launch") {
    const create = f.api.createWorkspace;
    f.api.createWorkspace = async () => {
      if (++creates === 1) throw new ConductorApiError("Rate limited", 429);
      return create();
    };
  } else {
    const create = f.api.createSession;
    f.api.createSession = async input => {
      if (++creates === 1) throw new ConductorApiError("Rate limited", 429);
      return create(input);
    };
  }
  f.engine.queue("limited-create", {type, trackedId: f.ws.id, projectId: "p1", prompt: "Start this task"});
  const row = f.store.row("limited-create")!;
  await assert.rejects(f.engine.action(row), error => error instanceof ConductorApiError && error.status === 429);
  await f.engine.action(row);
  assert.equal(creates, 2);
  assert.equal(f.counts().sends, type === "thread" ? 2 : 1);
}));

test("stop during creation prevents the first prompt from being sent", () => fixture(async f => {
  const original = f.api.createWorkspace;
  f.api.createWorkspace = async () => { const created = await original(); f.engine.queue("stop", { type: "stop", trackedId: f.ws.id }); return created; };
  await f.launch();
  assert.equal(f.counts().sends, 0);
  assert.equal(f.store.get(`stop:${f.ws.id}`), true);
}));

test("a lost native send receipt is reconciled through its distinct transcript row", () => fixture(async f => {
  let sends = 0;
  f.api.sendMessage = async input => {
    sends++;
    f.messages.push({id: "native-row", sessionId: input.sessionId, type: "userMessage", sessionIndex: 1,
      content: {id: input.messageId, message: input.message}, receivedAt: new Date().toISOString()});
    throw new Error("lost receipt");
  };
  await f.launch();
  f.store.bind(f.ws.id, {...f.store.binding(f.ws.id)!, synced: true});
  const getMessage = f.api.getMessage;
  f.api.getMessage = async id => {
    const message = await getMessage(id);
    f.status("working");
    return message;
  };
  f.status("idle");
  f.store.retry("launch", "reconcile", 0);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(sends, 1);
  assert.equal(f.store.row("launch")?.state, "done");
  assert.equal(f.store.get<any>("session:s1").awaitingWorkingEdge, true, "a reconciled submission remains fenced if work starts after preflight");
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.store.get<any>("session:s1").seenWorking, false, "the older working state is not credited to the reconciled turn");
}));

test("a missing receipt cannot replay a command whose submission was attempted", () => fixture(async f => {
  let sends = 0;
  f.api.sendMessage = async () => {sends++; throw new Error("lost receipt before transcript visibility");};
  await f.launch();
  f.store.retry("launch", "reconcile", 0);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(sends, 1);
  assert.match(f.store.row("launch")?.error ?? "", /uncertain/);
}));

test("native turn failure with an idle session recovers only after terminal confirmation", () => fixture(async f => {
  await f.launch();
  const state = f.store.get<any>("session:s1");
  f.messages.push({id: "failed-turn", sessionId: "s1", type: "agent", sessionIndex: 2, receivedAt: new Date().toISOString(),
    content: {turnId: state.sentMessageId, rawPayload: {event: {type: "turn.failed", error: {message: "Selected model is at capacity", codexErrorInfo: "serverOverloaded"}}}}});
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const row = f.store.db.prepare("SELECT * FROM gateway_queue WHERE id LIKE 'recover:%'").get() as any;
  assert.ok(row);
  assert.equal(JSON.parse(row.payload).previousMessageId, state.sentMessageId);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.sessions.length, 2);
  assert.equal(f.store.row(row.id)?.state, "done");
}));

test("a native failed turn cannot trigger replacement after the session starts working again", () => fixture(async f => {
  await f.launch();
  const state = f.store.get<any>("session:s1");
  f.messages.push({id: "failed-turn", sessionId: "s1", type: "agent", sessionIndex: 2, receivedAt: new Date().toISOString(),
    content: {turnId: state.sentMessageId, rawPayload: {event: {type: "turn.failed", error: {message: "Selected model is at capacity"}}}}});
  let reads = 0;
  f.api.getSessionStatus = async sessionId => ({workspaceId: "w1", sessionId, status: ++reads === 1 ? "idle" : "working", errorMessage: ""});
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.sessions.length, 1);
  assert.equal(f.store.db.prepare("SELECT id FROM gateway_queue WHERE id LIKE 'recover:%'").get(), undefined);
}));

test("an older failed turn cannot replace a newly submitted turn", () => fixture(async f => {
  await f.launch();
  const state = f.store.get<any>("session:s1");
  f.messages.push({id: "failed-turn", sessionId: "s1", type: "agent", sessionIndex: 2, receivedAt: new Date().toISOString(),
    content: {turnId: state.sentMessageId, rawPayload: {event: {type: "turn.failed", error: {message: "Selected model is at capacity"}}}}});
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const recovery = f.store.db.prepare("SELECT * FROM gateway_queue WHERE id LIKE 'recover:%'").get() as any;
  assert.ok(recovery);
  f.store.set("session:s1", {...f.store.get<any>("session:s1"), sentMessageId: "new-command", nativeFailure: undefined});
  await f.engine.action(recovery);
  assert.equal(f.sessions.length, 1);
  assert.equal(f.store.row(recovery.id)?.state, "blocked");
}));

test("a lost send receipt is matched by exact multiline payload and never resent", () => fixture(async f => {
  const original = f.api.sendMessage;
  f.api.sendMessage = async (input: any) => { await original(input); throw new Error("lost receipt"); };
  await f.launch(); f.store.retry("launch", "retry", 0);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.counts().sends, 1);
  assert.equal(f.store.row("launch")?.state, "done");
  assert.equal(messageContainsExactText({ content: [{ text: "hello\nworld" }] }, "hello\nworld"), true);
}));

test("idle before the prompt executes is not completion; replies are durably queued before cursors", () => fixture(async f => {
  await f.launch(); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(getWorkspace(f.ws.id)?.status, "running");
  f.messages.push({ id: "assistant1", sessionId: "s1", type: "assistant", content: { message: { content: [{ type: "text", text: "Finished" }] } }, sessionIndex: 1, receivedAt: new Date().toISOString() });
  f.status("idle"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(getThreadCursor(f.ws.id, "s1")?.lastMessageId, "assistant1");
  assert.ok(f.store.row("transcript:s1:assistant1:0"));
  assert.equal(getWorkspace(f.ws.id)?.status, "done");
}));

test("agent replies render Telegram rich text before durable delivery", () => fixture(async f => {
  await f.launch();
  updateWorkspaceThreadId(f.ws.id, 7);
  f.messages.push({id: "rich-reply", sessionId: "s1", type: "assistant", sessionIndex: 1,
    receivedAt: new Date().toISOString(), content: [
      "**What works instead.**", "", "```", "POST /api/tasks { task_type, priority }", "```", "",
      "Use `incident_response` with *care* and ~~old routing~~.",
      "[API docs](https://example.com/api?a=1&b=2)", "Literal <tag> & data.",
    ].join("\n")});
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const job = JSON.parse(f.store.row("transcript:s1:rich-reply:0")!.payload);
  assert.equal(job.payload.text, [
    "<b>What works instead.</b>", "", "<pre>POST /api/tasks { task_type, priority }</pre>", "",
    "Use <code>incident_response</code> with <i>care</i> and <s>old routing</s>.",
    '<a href="https://example.com/api?a=1&amp;b=2">API docs</a>', "Literal &lt;tag&gt; &amp; data.",
  ].join("\n"));
  assert.equal(job.payload.parse_mode, "HTML");
  assert.equal(job.payload.message_thread_id, 7);
  assert.equal(job.workspaceId, f.ws.id);
  assert.equal(job.sessionId, "s1");
  assert.equal(getThreadCursor(f.ws.id, "s1")?.lastMessageId, "rich-reply");
}));

test("agent questions, status reports, and artifacts render rich text with answer buttons", () => fixture(async f => {
  await f.launch();
  updateWorkspaceThreadId(f.ws.id, 7);
  const receipt = f.bridge.event(f.ws.id, {id: randomUUID(), type: "human_request",
    payload: {question: "**Continue?** Inspect `task_id` first.", options: ["Yes", "No"]}});
  const status = f.bridge.event(f.ws.id, {id: randomUUID(), type: "status",
    payload: {status: "running", message: "**Checking** `task_id`"}});
  const artifact = f.bridge.event(f.ws.id, {id: randomUUID(), type: "artifact",
    payload: {type: "pr", url: "https://github.com/example/project/pull/1", description: "**Review** `change`"}});
  f.engine.events();
  const question = JSON.parse(f.store.row(`decision:${receipt.decisionId}:0`)!.payload);
  assert.match(question.payload.text, /<b>Continue\?<\/b> Inspect <code>task_id<\/code> first\./);
  assert.equal(question.payload.message_thread_id, 7);
  assert.equal(question.decisionId, receipt.decisionId);
  assert.deepEqual(question.payload.reply_markup.inline_keyboard, [
    [{text: "Yes", callback_data: `decision:${receipt.decisionId}:0`}],
    [{text: "No", callback_data: `decision:${receipt.decisionId}:1`}],
  ]);
  assert.equal(JSON.parse(f.store.row(`event:${status.eventId}:0`)!.payload).payload.text,
    "running: <b>Checking</b> <code>task_id</code>");
  assert.equal(JSON.parse(f.store.row(`event:${artifact.eventId}:0`)!.payload).payload.text,
    "<b>Review</b> <code>change</code>\nhttps://github.com/example/project/pull/1");
}));

test("long formatted questions retain every chunk and put buttons on the last message", () => fixture(async f => {
  await f.launch();
  const question = `**${"q".repeat(3996)}**`;
  const receipt = f.bridge.event(f.ws.id, {id: randomUUID(), type: "human_request",
    payload: {question, options: ["Continue", "Stop"]}});
  f.engine.events();
  const rows = f.store.db.prepare("SELECT id,payload FROM gateway_queue WHERE id LIKE ? ORDER BY rowid")
    .all(`decision:${receipt.decisionId}:%`) as Array<{id: string; payload: string}>;
  assert.equal(rows.length, 2);
  const jobs = rows.map(row => JSON.parse(row.payload));
  assert.equal(jobs.map(job => job.payload.text.replace(/<\/?b>/g, "")).join(""),
    `workspace needs your input:\n\n${"q".repeat(3996)}`);
  for (const [i, job] of jobs.entries()) {
    assert.equal(rows[i].id, `decision:${receipt.decisionId}:${i}`);
    assert.equal(job.decisionId, receipt.decisionId);
    assert.equal(job.workspaceId, f.ws.id);
    assert.equal(job.payload.parse_mode, "HTML");
    assert.equal(!!job.payload.reply_markup, i === jobs.length - 1);
    assert.match(job.payload.text, /<b>q+<\/b>$/);
  }
  f.engine.events();
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE id LIKE ?")
    .get(`decision:${receipt.decisionId}:%`) as {n: number}).n, 2, "recovery does not duplicate chunks");
}));

test("control text keeps literal Markdown and escaped HTML", () => fixture(async f => {
  enqueueText(f.store, "control", "42", "**literal** `id` <project> & status");
  assert.equal(JSON.parse(f.store.row("control:0")!.payload).payload.text,
    "**literal** `id` &lt;project&gt; &amp; status");
}));

test("quota failure queues one fallback; an API outage never launches a replacement", () => fixture(async f => {
  await f.launch();
  enqueueText(f.store, "quota-ack", "42", "Task received and queued.", {silent: true});
  f.store.set("session:s1", {...f.store.get<any>("session:s1"), statusId: "quota-ack:0"});
  f.status("error");
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const rows = f.store.db.prepare("SELECT * FROM gateway_queue WHERE id LIKE 'recover:%'").all();
  assert.equal(rows.length, 1);
  const notice = JSON.parse(f.store.row(`recover-notice:s1:${f.store.get<any>("session:s1").sentMessageId}`)!.payload);
  assert.equal(notice.method, "editMessageText");
  assert.equal(notice.statusOf, "quota-ack:0", "provider fallback updates the existing turn card");
  f.status("error"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE id LIKE 'recover:%'").get() as any).n, 1);
  f.api.getSessionStatus = async () => { throw new Error("API offline"); };
  f.store.set(`poll-after:${f.ws.id}`, 0);
  await assert.rejects(f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!));
  assert.equal(f.sessions.length, 1);
}));

test("transient disconnect attempts same-session continuation before provider replacement", () => fixture(async f => {
  await f.launch();
  enqueueText(f.store, "disconnect-ack", "42", "Task received and queued.", {silent: true});
  f.store.set("session:s1", {...f.store.get<any>("session:s1"), statusId: "disconnect-ack:0"});
  f.status("error", "connection lost");
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.store.get("recovery-resumed:launch"), true);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE id LIKE 'resume:%'").get() as any).n, 1);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE id LIKE 'recover:%'").get() as any).n, 0);
  const notice = JSON.parse(f.store.row(`resume-notice:s1:${f.store.get<any>("session:s1").sentMessageId}`)!.payload);
  assert.equal(notice.method, "editMessageText");
  assert.equal(notice.statusOf, "disconnect-ack:0", "same-provider recovery updates the existing turn card");
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  const continuationRow = f.store.db.prepare("SELECT payload FROM gateway_queue WHERE id LIKE 'resume:%:sent'").get() as {payload: string};
  const continuation = JSON.parse(continuationRow.payload);
  assert.equal(continuation.method, "editMessageText");
  assert.equal(continuation.statusOf, "disconnect-ack:0", "the resumed send keeps using the original card");
}));

test("provider recovery continues and completes on the original turn card", () => fixture(async f => {
  await f.launch();
  enqueueText(f.store, "recovery-ack", "42", "Task received and queued.", {silent: true});
  f.store.set("session:s1", {...f.store.get<any>("session:s1"), statusId: "recovery-ack:0"});
  f.status("error");
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const recovery = f.store.db.prepare("SELECT id FROM gateway_queue WHERE id LIKE 'recover:%'").get() as {id: string};
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  const continuation = JSON.parse(f.store.row(`${recovery.id}:sent`)!.payload);
  assert.equal(continuation.method, "editMessageText");
  assert.equal(continuation.statusOf, "recovery-ack:0");
  const sessionId = f.sessions.at(-1).id as string;
  const state = f.store.get<any>(`session:${sessionId}`);
  f.messages.push({id: "recovered-answer", sessionId, type: "assistant", content: "Recovered result.",
    sessionIndex: f.messages.length, receivedAt: new Date().toISOString()});
  f.status("idle"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const complete = JSON.parse(f.store.row(`complete:${sessionId}:${state.sentMessageId}`)!.payload);
  assert.equal(complete.method, "editMessageText");
  assert.equal(complete.statusOf, "recovery-ack:0");
  assert.equal(complete.payload.text, "Conductor task finished after recovery.");
}));

test("PR review records exact head, uses a separate session, and detects later changes", () => fixture(async f => {
  await f.launch();
  const mergeEvidence = () => ({
    intents: f.store.db.prepare("SELECT * FROM merge_intents").all(),
    decisions: f.store.db.prepare("SELECT * FROM decisions").all(),
  });
  const beforeReview = mergeEvidence();
  let head = "a".repeat(40);
  f.engine.github.pr = async () => ({ url: "https://github.com/org/repo/pull/1", head, base: "b".repeat(40), branch: "feature", number: 1, state: "open", merged: false, draft: false });
  f.engine.queue("review", { type: "review", trackedId: f.ws.id, prompt: "https://github.com/org/repo/pull/1" });
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.sessions.length, 2);
  assert.equal(f.store.get<any>("session:s2")?.reviewHead, head);
  assert.equal(f.store.binding(f.ws.id)?.sessionId, "s1");
  f.status("working"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  f.messages.push({ id: "review-result", sessionId: "s2", type: "assistant", content: "Review findings", sessionIndex: 2, receivedAt: new Date(Date.now() + 100).toISOString() });
  head = "c".repeat(40); f.status("idle"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const completion = f.store.db.prepare("SELECT payload FROM gateway_queue WHERE id LIKE 'complete:s2:%'").all() as any[];
  assert.ok(completion.some(r => JSON.parse(r.payload).payload.text.includes("PR changed")));
  assert.deepEqual(mergeEvidence(), beforeReview, "Review completion must not create merge authorization or approve a human decision");
}));

test("sleep during a running task queues one same-session continuation and preserves explicit stop", () => fixture(async f => {
  await f.launch();
  let lifecycle = "ready";
  f.api.getWorkspaceStatus = async () => ({workspaceId: "w1", status: lifecycle});
  f.status("working"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.store.get<any>("session:s1").seenWorking, true);
  lifecycle = "sleeping"; f.status("idle");
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const wakes = () => f.store.db.prepare("SELECT * FROM gateway_queue WHERE id LIKE 'wake:%'").all() as any[];
  assert.equal(wakes().length, 1);
  const continuation = JSON.parse(wakes()[0].payload);
  assert.equal(continuation.sessionId, "s1");
  assert.equal(continuation.recovery, true);
  assert.match(continuation.prompt, /continue only unfinished work/);
  f.store.set(`poll-after:${f.ws.id}`, 0);
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(wakes().length, 1);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.deepEqual(f.counts(), {creates: 1, sends: 2});
  assert.equal(f.sessions.length, 1);
  f.engine.queue("owner-stop", {type: "stop", trackedId: f.ws.id});
  f.store.set(`poll-after:${f.ws.id}`, 0);
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.counts().sends, 2);
}));

test("queued follow-ups cannot inherit the prior turn's working status as start evidence", () => fixture(async f => {
  await f.launch();
  let lifecycle = "ready";
  f.api.getWorkspaceStatus = async () => ({workspaceId: "w1", status: lifecycle});
  f.status("working"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  f.engine.queue("follow-up", {type: "send", trackedId: f.ws.id, prompt: "Second turn"});
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.store.get<any>("session:s1").awaitingWorkingEdge, true);
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.store.get<any>("session:s1").seenWorking, false, "the session was already busy before this turn");
  f.engine.queue("second-follow-up", {type: "send", trackedId: f.ws.id, prompt: "Third turn"});
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.store.get<any>("session:s1").awaitingWorkingEdge, true, "another queued turn preserves the pending edge");
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.store.get<any>("session:s1").seenWorking, false);
  lifecycle = "sleeping"; f.status("idle");
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const wakes = () => (f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE id LIKE 'wake:%'").get() as any).n;
  assert.equal(wakes(), 0, "a fresh queued turn is left for Conductor to wake");
  f.store.set("session:s1", {...f.store.get<any>("session:s1"), sentAt: Date.now() - 6 * 60_000});
  f.store.set(`poll-after:${f.ws.id}`, 0); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(wakes(), 1, "a silent turn is continued after the grace window");
}));

test("a turn that starts between polls cannot lend its working state to a queued follow-up", () => fixture(async f => {
  await f.launch();
  let lifecycle = "ready";
  f.api.getWorkspaceStatus = async () => ({workspaceId: "w1", status: lifecycle});
  f.status("working");
  f.engine.queue("follow-up", {type: "send", trackedId: f.ws.id, prompt: "Second turn"});
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.store.get<any>("session:s1").awaitingWorkingEdge, true, "submission observes that the prior turn is already working");
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.store.get<any>("session:s1").seenWorking, false, "the old working state is not credited to the follow-up");
  lifecycle = "sleeping"; f.status("idle");
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const wakes = () => (f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE id LIKE 'wake:%'").get() as any).n;
  assert.equal(wakes(), 0);
}));

test("a queued follow-up in an established managed session closes the status-check-to-submit race", () => fixture(async f => {
  await f.launch();
  f.store.set("session:s1", {...f.store.get<any>("session:s1"), terminal: true});
  let lifecycle = "ready";
  f.api.getWorkspaceStatus = async () => ({workspaceId: "w1", status: lifecycle});
  const send = f.api.sendMessage;
  f.api.sendMessage = async input => {
    const receipt = await send(input);
    f.status("working");
    return {...receipt, state: "queued"};
  };
  f.status("idle");
  f.engine.queue("racing-follow-up", {type: "send", trackedId: f.ws.id, prompt: "Second turn"});
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.store.get<any>("session:s1").awaitingWorkingEdge, true, "the queued receipt fences work that began after the preflight");
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.store.get<any>("session:s1").seenWorking, false);
  lifecycle = "sleeping"; f.status("idle");
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const wakes = (f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE id LIKE 'wake:%'").get() as any).n;
  assert.equal(wakes, 0, "the prior turn cannot trigger a duplicate continuation for the queued follow-up");
}));

test("a first queued prompt in a gateway-created session can use its own working state", () => fixture(async f => {
  const send = f.api.sendMessage;
  f.api.sendMessage = async input => {
    const receipt = await send(input);
    f.status("working");
    return {...receipt, state: "queued"};
  };
  await f.launch();
  assert.equal(f.store.get<any>("session:s1").awaitingWorkingEdge, false, "there is no prior turn to fence in a new managed session");
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.store.get<any>("session:s1").seenWorking, true, "the first prompt's observed work remains usable recovery evidence");
}));

test("a workspace still asleep when a message arrives is left for Conductor to wake", () => fixture(async f => {
  await f.launch();
  f.api.getWorkspaceStatus = async () => ({workspaceId: "w1", status: "sleeping"});
  const wakes = () => (f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE id LIKE 'wake:%'").get() as any).n;
  for (let i = 0; i < 2; i++) { f.store.set(`poll-after:${f.ws.id}`, 0); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!); }
  assert.equal(wakes(), 0);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_state WHERE key LIKE 'wake-attempted:%'").get() as any).n, 0);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.deepEqual(f.counts(), {creates: 1, sends: 1}, "no continuation may follow the real message while Conductor is still waking up");
  // A turn that stays silent well past any wake-up window is still continued.
  f.store.set("session:s1", {...f.store.get<any>("session:s1"), sentAt: Date.now() - 6 * 60_000});
  f.store.set(`poll-after:${f.ws.id}`, 0); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(wakes(), 1);
}));

test("a retried native send recreates a status edit lost after its state was persisted", () => fixture(async f => {
  await f.launch();
  enqueueText(f.store, "retry-ack", "42", "Task received and queued.", {silent: true});
  f.engine.queue("retry-turn", {type: "send", trackedId: f.ws.id, prompt: "Second turn", statusId: "retry-ack:0"});
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.ok(f.store.row("retry-turn:sent"));
  f.store.db.prepare("DELETE FROM gateway_queue WHERE id=?").run("retry-turn:sent");
  f.store.retry("retry-turn", "simulated restart after send state", 0);
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  const recreated = JSON.parse(f.store.row("retry-turn:sent")!.payload);
  assert.equal(recreated.method, "editMessageText");
  assert.equal(recreated.statusOf, "retry-ack:0");
  assert.deepEqual(f.counts(), {creates: 1, sends: 2}, "the native message is not submitted twice");
}));

test("a user turn edits its acknowledgement instead of posting sent and finished messages", () => fixture(async f => {
  await f.launch();
  updateWorkspaceThreadId(f.ws.id, 7);
  f.store.db.prepare("UPDATE gateway_queue SET state='done' WHERE kind='telegram'").run();
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42", "9");
  f.store.ingest([{update_id: 1, message: {message_id: 100, chat: {id: 42}, from: {id: 9}, message_thread_id: 7, text: "what is the status?"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(JSON.parse(f.store.row("update:1:action")!.payload).statusId, "update:1:reply:0");
  const ack = JSON.parse(f.store.row("update:1:reply:0")!.payload);
  assert.equal(ack.payload.disable_notification, true);
  assert.match(ack.payload.text, /Task received and queued/);
  const queued = f.store.db.prepare("SELECT id,rowid FROM gateway_queue WHERE id IN (?,?) ORDER BY rowid")
    .all("update:1:reply:0", "update:1:action") as Array<{id: string; rowid: number}>;
  assert.deepEqual(queued.map(item => item.id), ["update:1:reply:0", "update:1:action"], "the durable card anchor is inserted before its action");
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  const sent = JSON.parse(f.store.row("update:1:action:sent")!.payload);
  assert.equal(sent.method, "editMessageText"); assert.equal(sent.statusOf, "update:1:reply:0");
  assert.equal(f.store.row("update:1:action:sent:0"), undefined, "the receipt is an edit of the card, not a new message");
  assert.equal(f.store.row("update:1:action:sent")!.conversation, f.store.row("update:1:reply:0")!.conversation, "the edit shares the card's delivery lane");
  const calls: Array<{method: string; payload: any}> = [];
  const delivery = new TelegramDelivery(f.store, async (method, payload) => { calls.push({method, payload}); return {message_id: 501}; });
  const deliver = async () => { f.store.set("telegram-chat-after:42", 0); await delivery.tick(); };
  await deliver(); await deliver();
  assert.deepEqual(calls.map(c => c.method), ["sendMessage", "editMessageText"]);
  assert.equal(calls[1].payload.message_id, 501);
  assert.equal(calls[1].payload.message_thread_id, undefined);
  assert.equal(calls[1].payload.text, "Sent to claude (fable-5-1).");
  assert.equal(getWorkspaceMessageTarget("42", "501")?.workspace.id, f.ws.id, "replying to the card targets the session");
  f.store.set(`poll-after:${f.ws.id}`, 0); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  f.messages.push({id: "answer", sessionId: "s1", type: "assistant", content: "All green.", sessionIndex: f.messages.length, receivedAt: new Date().toISOString()});
  f.status("idle"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const complete = JSON.parse(f.store.row(`complete:s1:${f.store.get<any>("session:s1").sentMessageId}`)!.payload);
  assert.equal(complete.method, "editMessageText"); assert.equal(complete.statusOf, "update:1:reply:0");
  await deliver(); await deliver();
  assert.deepEqual(calls.slice(2).map(c => [c.method, c.payload.text, c.payload.disable_notification]),
    [["editMessageText", "Conductor task finished.", undefined], ["sendMessage", "All green.", undefined]], "only the agent's reply rings");
}));

test("a status-card acknowledgement rolls back when its action cannot be reserved", () => fixture(async f => {
  await f.launch();
  updateWorkspaceThreadId(f.ws.id, 7);
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42", "9");
  f.engine.queue = () => { throw new Error("simulated action reservation failure"); };
  f.store.ingest([{update_id: 1, message: {message_id: 100, chat: {id: 42}, from: {id: 9}, message_thread_id: 7, text: "continue"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.row("update:1:reply:0"), undefined, "the card cannot commit without its action");
  assert.equal(f.store.row("update:1:action"), undefined);
  assert.equal(f.store.row("update:1")?.state, "pending", "the owner update remains retryable as one unit");
}));

for (const [type, expected] of [
  ["stop", "All cloud threads stopped."],
  ["archive", "Cloud workspace archived."],
  ["rename", "Cloud workspace renamed."],
  ["renamethread", "Cloud thread renamed."],
] as const) test(`${type} completion edits the turn acknowledgement`, () => fixture(async f => {
  await f.launch();
  (f.api as any).renameWorkspace = async () => ({});
  (f.api as any).renameSession = async () => ({});
  enqueueText(f.store, `${type}-ack`, "42", "Queued for Conductor.", {silent: true});
  f.engine.queue(`${type}-action`, {type, trackedId: f.ws.id, sessionId: "s1", prompt: "renamed", statusId: `${type}-ack:0`});
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  const completion = JSON.parse(f.store.row(`${type}-action:done`)!.payload);
  assert.equal(completion.method, "editMessageText");
  assert.equal(completion.statusOf, `${type}-ack:0`);
  assert.equal(completion.payload.text, expected);
}));

test("thread and command actions carry their own silent acknowledgement as the status card", () => fixture(async f => {
  await f.launch(); updateWorkspaceThreadId(f.ws.id, 7);
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42", "9");
  for (const [id, text, rowId] of [[20, "/threads new investigate", "update:20:thread"], [21, "/rename renamed", "update:21:action"]] as const) {
    f.store.ingest([{update_id: id, message: {message_id: id, chat: {id: 42}, from: {id: 9}, message_thread_id: 7, text}}]);
    await processQueue(f.store, ["update"], row => commands.handle(row));
    assert.equal(JSON.parse(f.store.row(rowId)!.payload).statusId, `update:${id}:reply:0`);
    assert.equal(JSON.parse(f.store.row(`update:${id}:reply:0`)!.payload).payload.disable_notification, true);
  }
}));

test("status edits wait behind a paced acknowledgement in the same lane", () => fixture(async f => {
  enqueueText(f.store, "ack", "42", "Task received and queued.", {threadId: 7, priority: 0, silent: true});
  enqueueStatus(f.store, "ack-sent", {anchorId: "ack:0", chatId: "42", text: "Sent to claude (fable-5-1)."});
  assert.equal(f.store.row("ack-sent")!.conversation, f.store.row("ack:0")!.conversation);
  const calls: string[] = [];
  const delivery = new TelegramDelivery(f.store, async method => { calls.push(method); return {message_id: 9}; });
  const now = Date.now();
  f.store.set("telegram-chat-after:42", now + 1000);
  await delivery.tick(now); await delivery.tick(now);
  assert.deepEqual(calls, []);
  assert.equal(f.store.row("ack:0")!.error, "paced");
  assert.equal(f.store.row("ack-sent")!.attempts, 0, "a paced acknowledgement still fences its edit");
  await delivery.tick(now + 2000);
  assert.deepEqual(calls, ["sendMessage"]);
  await delivery.tick(Date.now() + 5000);
  assert.deepEqual(calls, ["sendMessage", "editMessageText"]);
  assert.equal(f.store.row("ack-sent")!.state, "done");
}));

test("a status edit whose acknowledgement is gone becomes a silent message", () => fixture(async f => {
  updateWorkspaceThreadId(f.ws.id, 7);
  const calls: Array<{method: string; payload: any}> = [];
  let editError: unknown;
  const delivery = new TelegramDelivery(f.store, async (method, payload) => {
    calls.push({method, payload});
    if (method === "editMessageText" && editError) throw editError;
    return {message_id: 700};
  });
  const deliver = async () => { f.store.set("telegram-chat-after:42", 0); await delivery.tick(); };
  // Deleted by the user after delivery.
  enqueueText(f.store, "ack", "42", "Task received and queued.", {threadId: 7, priority: 0, silent: true});
  enqueueStatus(f.store, "ack-sent", {anchorId: "ack:0", chatId: "42", workspaceId: f.ws.id, sessionId: "s1", text: "Sent to claude (fable-5-1)."});
  editError = {response: {error_code: 400, description: "Bad Request: message to edit not found"}};
  await deliver(); await deliver();
  assert.equal(f.store.row("ack-sent")!.state, "pending");
  assert.equal(JSON.parse(f.store.row("ack-sent")!.payload).method, "sendMessage", "the durable row itself becomes a message");
  await deliver();
  const fallback = calls.at(-1)!;
  assert.equal(fallback.method, "sendMessage");
  assert.equal(fallback.payload.disable_notification, true);
  assert.equal(fallback.payload.message_id, undefined);
  assert.equal(fallback.payload.message_thread_id, 7, "the fallback is routed like any workspace message");
  assert.equal(fallback.payload.text, "Sent to claude (fable-5-1).");
  assert.equal(f.store.row("ack-sent")!.state, "done");
  // Never delivered at all, or never queued.
  enqueueText(f.store, "blocked-ack", "42", "Queued for Conductor.", {threadId: 7, priority: 0, silent: true});
  f.store.retry("blocked-ack:0", "Bad Request: chat not found", 0, true);
  enqueueStatus(f.store, "blocked-sent", {anchorId: "blocked-ack:0", chatId: "42", workspaceId: f.ws.id, text: "Sent to claude (fable-5-1)."});
  enqueueStatus(f.store, "orphan-sent", {anchorId: "missing-ack:0", chatId: "42", workspaceId: f.ws.id, text: "Conductor task finished."});
  for (let i = 0; i < 4; i++) await deliver();
  assert.deepEqual(calls.filter(c => c.method === "sendMessage").map(c => c.payload.text).slice(-2), ["Sent to claude (fable-5-1).", "Conductor task finished."]);
  assert.equal(f.store.row("blocked-sent")!.state, "done"); assert.equal(f.store.row("orphan-sent")!.state, "done");
  assert.equal(f.store.get("telegram-not-before"), undefined, "an uneditable card never pauses delivery");
}));

test("identical status text counts as delivered and later states supersede undelivered ones", () => fixture(async f => {
  enqueueText(f.store, "ack", "42", "Task received and queued.", {threadId: 7, priority: 0, silent: true});
  enqueueStatus(f.store, "first", {anchorId: "ack:0", chatId: "42", text: "Sent to claude (fable-5-1)."});
  enqueueStatus(f.store, "second", {anchorId: "ack:0", chatId: "42", workspaceId: f.ws.id, sessionId: "s1", text: "Conductor task finished."});
  assert.equal(f.store.row("first")!.state, "done");
  assert.deepEqual(JSON.parse(f.store.row("first")!.result!), {supersededBy: "second"});
  const calls: string[] = [];
  const delivery = new TelegramDelivery(f.store, async method => {
    calls.push(method);
    if (method === "editMessageText") throw {response: {error_code: 400, description: "Bad Request: message is not modified"}};
    return {message_id: 11};
  });
  for (let i = 0; i < 2; i++) { f.store.set("telegram-chat-after:42", 0); await delivery.tick(); }
  assert.deepEqual(calls, ["sendMessage", "editMessageText"]);
  assert.equal(f.store.row("second")!.state, "done");
  assert.equal(JSON.parse(f.store.row("second")!.payload).method, "editMessageText");
  assert.equal(getWorkspaceMessageTarget("42", "11")?.workspace.id, f.ws.id, "an idempotent retry restores reply routing");
  assert.equal(f.store.get("telegram-not-before"), undefined);
}));

test("re-enqueueing the same status id is an idempotent no-op", () => fixture(async f => {
  enqueueText(f.store, "ack", "42", "Task received and queued.", {silent: true});
  enqueueStatus(f.store, "same", {anchorId: "ack:0", chatId: "42", text: "Sent to claude (fable-5-1)."});
  const original = f.store.row("same")!.payload;
  enqueueStatus(f.store, "same", {anchorId: "ack:0", chatId: "42", text: "A conflicting retry."});
  assert.equal(f.store.row("same")!.payload, original);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE id=?").get("same") as {n: number}).n, 1);
}));

test("status replacement rolls back supersession when the new edit cannot be queued", () => fixture(async f => {
  enqueueText(f.store, "ack", "42", "Task received and queued.", {silent: true});
  enqueueStatus(f.store, "first", {anchorId: "ack:0", chatId: "42", text: "Sent to claude (fable-5-1)."});
  f.store.db.exec(`CREATE TRIGGER fail_replacement BEFORE INSERT ON gateway_queue
    WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END`);
  assert.throws(() => enqueueStatus(f.store, "second", {anchorId: "ack:0", chatId: "42", text: "Conductor task finished."}),
    /simulated insert failure/);
  assert.equal(f.store.row("first")!.state, "pending", "the prior status remains deliverable after rollback");
  assert.equal(f.store.row("second"), undefined);
}));

test("launched workspaces get MCP bridge instructions; workspaces without a credential are told to answer inline", () => fixture(async f => {
  await f.launch();
  assert.match(f.messages[0].content, /conductor-telegram-mcp tools/);
  assert.doesNotMatch(f.messages[0].content, /forwarded to Telegram/);
  f.store.db.prepare("UPDATE gateway_credentials SET revoked=1 WHERE workspace_id=?").run(f.ws.id);
  f.engine.queue("follow-up", {type: "send", trackedId: f.ws.id, prompt: "Next step"});
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.messages.length, 2);
  assert.match(f.messages[1].content, /^Next step\n\nYour replies in this session are forwarded to Telegram/);
  assert.doesNotMatch(f.messages[1].content, /TELEGRAM_BRIDGE|report_status|refresh_attachment/);
  const sent = JSON.parse(f.store.row("follow-up:sent:0")!.payload);
  assert.equal(sent.method, "sendMessage"); assert.equal(sent.payload.disable_notification, true, "a turn without a card reports silently");
  const fileId = f.bridge.save(f.ws.id, "evidence.txt", Buffer.from("proof"));
  f.engine.queue("file-follow-up", {type: "send", trackedId: f.ws.id, prompt: "Inspect this", fileIds: [fileId]});
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.match(f.messages[2].content, /Attachment links expire after 15 minutes; download them first\./);
}));

test("document intake keeps caption and file private, releases its reservation, and deduplicates on retry", () => fixture(async f => {
  await f.launch();
  updateWorkspaceThreadId(f.ws.id, 7);
  const previousToken = process.env.BOT_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.BOT_TOKEN = "test-only-placeholder";
  globalThis.fetch = (async (url: string | URL | Request) => {
    assert.equal(String(url), "https://api.telegram.org/file/bottest-only-placeholder/documents/input.txt");
    return new Response(Buffer.from("user attachment bytes"));
  }) as typeof fetch;
  const commands = new CloudCommands(f.store, f.engine, async (method) => {
    assert.equal(method, "getFile");
    return {file_path: "documents/input.txt", file_size: 21};
  }, "42", "7");
  try {
    f.store.ingest([{update_id: 90, message: {message_id: 90, chat: {id: 42}, from: {id: 7}, message_thread_id: 7,
      caption: "Check this\nagainst the task", document: {file_id: "input-doc", file_name: "input.txt"}}}]);
    await processQueue(f.store, ["update"], r => commands.handle(r));
    assert.equal(JSON.parse(f.store.row("update:90:action")!.payload).mediaPending, true);
    await processQueue(f.store, ["media"], r => commands.media(r));
    const prepared = JSON.parse(f.store.row("update:90:action")!.payload);
    assert.equal(prepared.mediaPending, false);
    assert.equal(prepared.prompt, "Check this\nagainst the task");
    assert.equal(prepared.fileIds.length, 1);
    assert.equal(f.bridge.file(prepared.fileIds[0], f.ws.id)?.name, "input.txt");
    f.store.retry("update:90:media", "simulate lost processing receipt", 0);
    await processQueue(f.store, ["media"], r => commands.media(r));
    assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_files").get() as any).n, 1);
    await processQueue(f.store, ["cloud"], r => f.engine.action(r));
    const sent = f.messages.at(-1).content;
    assert.match(sent, /Check this\nagainst the task/);
    assert.match(sent, /\/v1\/attachments\//);
    assert.doesNotMatch(sent, /api\.telegram\.org|test-only-placeholder/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.BOT_TOKEN; else process.env.BOT_TOKEN = previousToken;
  }
}));

test("human questions bypass transcript backlog and retain reply associations after restart", () => fixture(async f => {
  enqueueText(f.store, "earlier-transcript", "42", "Background progress", {workspaceId: f.ws.id, sessionId: "s1"});
  const receipt = f.bridge.event(f.ws.id, {id: randomUUID(), type: "human_request", payload: {question: "Which target?"}});
  f.engine.events();
  const sent: string[] = [];
  const delivery = new TelegramDelivery(f.store, async (_method, payload) => {sent.push(payload.text); return {message_id: 101};});
  await delivery.tick();
  assert.match(sent[0], /Which target\?/);
  assert.equal(f.store.row("earlier-transcript:0")?.state, "pending");
  const restarted = new GatewayStore(f.store.db);
  assert.equal(restarted.decisionForMessage("42", 101), receipt.decisionId);
  assert.equal(getWorkspaceMessageTarget("42", "101")?.workspace.id, f.ws.id);
}));

test("question send failures and 429 cooldown preserve the question and reply link", () => fixture(async f => {
  const receipt = f.bridge.event(f.ws.id, { id: randomUUID(), type: "human_request", payload: { question: "Continue?", options: ["Yes", "No"] } });
  f.engine.events();
  let calls = 0;
  const sender = new TelegramDelivery(f.store, async () => { calls++; if (calls === 1) throw { response: { error_code: 429, parameters: { retry_after: 39 }, description: "Too Many Requests" } }; return { message_id: 101 }; });
  await sender.tick();
  assert.ok((f.store.get<number>("telegram-not-before") ?? 0) > Date.now() + 38_000);
  await sender.tick(); assert.equal(calls, 1);
  const row = f.store.db.prepare("SELECT id FROM gateway_queue WHERE kind='telegram'").get() as any;
  f.store.set("telegram-not-before", 0); f.store.retry(row.id, "retry", 0);
  await sender.tick();
  const restarted = new GatewayStore(f.store.db);
  assert.equal(restarted.decisionForMessage("42", 101), receipt.decisionId);
  assert.equal(restarted.decisionForMessage("other", 101), undefined);
  assert.equal(getWorkspaceMessageTarget("42", "101")?.workspace.id, f.ws.id);
}));

test("unchanged topic updates are successful and never block following messages", () => fixture(async f => {
  enqueueTelegram(f.store, "topic", { method: "editForumTopic", payload: { chat_id: "42", message_thread_id: 1, name: "test" } });
  const sender = new TelegramDelivery(f.store, async () => { throw { response: { error_code: 400, description: "TOPIC_NOT_MODIFIED" } }; });
  await sender.tick(); assert.equal(f.store.row("topic")?.state, "done");
}));

test("scoped bridge rejects another workspace's files and decisions; event retries deduplicate", () => fixture(async f => {
  const other = createWorkspace({ name: "other", prompt: "x", repoPath: "x", telegramChatId: "42" });
  const a = f.bridge.issueCredential(f.ws.id), b = f.bridge.issueCredential(other.id);
  assert.equal(f.bridge.authorize(a), f.ws.id); assert.equal(f.bridge.authorize(b), other.id);
  const file = f.bridge.save(f.ws.id, "../../test.txt", Buffer.from("hello"));
  assert.equal(f.bridge.file(file)?.name, "test.txt");
  assert.throws(() => f.bridge.link(file, other.id));
  const link = new URL(f.bridge.link(file, f.ws.id));
  assert.ok(f.bridge.validLink(file, link.searchParams.get("token")!));
  assert.equal(f.bridge.validLink(file, link.searchParams.get("token")!, Date.now() + 16 * 60_000), undefined);
  const event = { id: randomUUID(), type: "human_request", payload: { question: "Question?" } };
  const first = f.bridge.event(f.ws.id, event); const retry = f.bridge.event(f.ws.id, event);
  assert.equal(first.decisionId, retry.decisionId);
  const server = startBridge(f.bridge, 0); await once(server, "listening");
  try {
    const port = (server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/decisions/${first.decisionId}`, { headers: { Authorization: `Bearer ${b}` } });
    assert.equal(response.status, 404);
    answerDecision(first.decisionId!, "Yes");
    const own = await fetch(`http://127.0.0.1:${port}/v1/decisions/${first.decisionId}`, { headers: { Authorization: `Bearer ${a}` } });
    assert.deepEqual(await own.json(), { answer: "Yes" });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test("cloud file reports reject symlink escapes and secret files", () => fixture(async f => {
  const root = path.join(f.dir, "files"); writeFileSync(path.join(f.dir, "outside"), "secret");
  symlinkSync(path.join(f.dir, "outside"), path.join(root, "escape")); writeFileSync(path.join(root, ".env"), "secret");
  assert.throws(() => readWorkspaceArtifact("escape", root));
  assert.throws(() => readWorkspaceArtifact(".env", root));
}));

test("native commands acknowledge and queue work; owner checks prevent outsider updates", () => fixture(async f => {
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42", "9");
  f.store.ingest([{ update_id: 1, message: { message_id: 2, chat: { id: 42 }, from: { id: 10 }, text: "/run p1 task" } }]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind='cloud'").get() as any).n, 0);
  f.store.ingest([{ update_id: 2, message: { message_id: 3, chat: { id: 42 }, from: { id: 9 }, text: "/run p1 task\n  preserve formatting" } }]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind='cloud'").get() as any).n, 1);
  assert.equal(f.counts().creates, 0);
  assert.equal(JSON.parse(f.store.row("update:2:action")!.payload).prompt, "task\n  preserve formatting");
}));

test("group authorization rejects impersonation, foreign chats, media, replies and control buttons before side effects", () => fixture(async f => {
  await f.launch();
  f.store.db.prepare("UPDATE workspaces SET telegram_chat_id='-42' WHERE id=?").run(f.ws.id);
  updateWorkspaceThreadId(f.ws.id, 7);
  const decision = f.bridge.event(f.ws.id, {id: randomUUID(), type: "human_request", payload: {question: "Approve?", options: ["Yes", "No"]}}).decisionId!;
  f.store.linkDecision("-42", 100, decision);
  f.store.set("route:access-test", {chatId: "-42", action: {type: "stop", trackedId: f.ws.id}});
  f.store.set("thread:access-test", {trackedId: f.ws.id, sessionId: "other-session"});
  f.store.set("bindtopic:access-test", {chatId: "-42", threadId: 7, projectId: "p1", projectName: "repo"});
  let externalCalls = 0;
  const unexpectedCall = async () => {externalCalls++; throw new Error("Unauthorized request reached an external API");};
  for (const key of Object.keys(f.api)) (f.api as any)[key] = unexpectedCall;
  const commands = new CloudCommands(f.store, f.engine, unexpectedCall, "-42", "9", "-42");
  const snapshot = () => ({
    workspace: getWorkspace(f.ws.id), decision: getDecision(decision), bindings: f.store.bindings(),
    state: f.store.db.prepare("SELECT * FROM gateway_state WHERE key != 'telegram-offset' ORDER BY key").all(),
    queue: f.store.db.prepare("SELECT * FROM gateway_queue WHERE kind NOT IN ('update','health-update') ORDER BY id").all(),
    links: f.store.db.prepare("SELECT * FROM telegram_message_links ORDER BY chat_id,telegram_message_id").all(),
  });
  const before = snapshot();
  const identities = [
    {name: "another group member with the owner's username", chat: -42, from: {id: 10, username: "OwnerName"}},
    {name: "anonymous group administrator", chat: -42, from: {id: 11, is_bot: true}},
    {name: "missing sender", chat: -42, from: undefined},
    {name: "owner in a foreign group", chat: -43, from: {id: 9}},
    {name: "owner in an unapproved private chat", chat: 9, from: {id: 9}},
  ];
  const payloads: Record<string, unknown>[] = [
    ...["/run p1 deploy", "/link", "/link repo", "/send deploy", "/stop", "/archive", "/review https://github.com/org/repo/pull/1",
      "/threads", "/threads new deploy", "/rename changed", "/renamethread changed", "/repos", "/fleet", "/lanes",
      "/sync", "/status", "/decisions", "/ping", "/setup", `/answer ${decision} Yes`, "deploy now"].map(text => ({text})),
    {text: "Yes", reply_to_message: {message_id: 100}},
    {voice: {file_id: "voice"}, reply_to_message: {message_id: 100}},
    {audio: {file_id: "audio"}}, {photo: [{file_id: "photo"}]}, {document: {file_id: "document"}, caption: "/send deploy"},
  ];
  let updateId = 0;
  async function rejected(update: Record<string, unknown>, label: string) {
    const id = ++updateId;
    f.store.ingest([{update_id: id, ...update}]);
    await processQueue(f.store, ["update", "health-update"], row => commands.handle(row));
    assert.equal(f.store.row(`update:${id}`)?.state, "done", label);
    assert.equal(externalCalls, 0, label);
    assert.deepEqual(snapshot(), before, label);
  }
  for (const identity of identities) {
    for (const payload of payloads) await rejected({message: {message_id: 200 + updateId, chat: {id: identity.chat},
      from: identity.from, message_thread_id: 7, ...payload}}, identity.name);
    for (const data of [`decision:${decision}:0`, "route:access-test", "thread:access-test", "bindtopic:access-test"]) {
      await rejected({callback_query: {id: `callback-${updateId}`, from: identity.from, data,
        message: {message_id: 100, chat: {id: identity.chat}, from: {id: 99, is_bot: true}, message_thread_id: 7}}}, `${identity.name}: ${data}`);
    }
  }
  // The original message may be from the owner; only the person clicking can authorize a callback.
  await rejected({callback_query: {id: "foreign-click", from: {id: 10}, data: `decision:${decision}:0`,
    message: {message_id: 100, chat: {id: -42}, from: {id: 9}, message_thread_id: 7}}}, "foreign click on owner's message");

  f.store.ingest([{update_id: ++updateId, message: {message_id: 500, chat: {id: -42}, from: {id: 9, username: "ChangedName"},
    message_thread_id: 7, text: "/send continue"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(JSON.parse(f.store.row(`update:${updateId}:action`)!.payload).trackedId, f.ws.id);
  f.store.ingest([{update_id: ++updateId, callback_query: {id: "owner-click", from: {id: 9}, data: `decision:${decision}:0`,
    message: {message_id: 100, chat: {id: -42}, from: {id: 99, is_bot: true}, message_thread_id: 7}}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(getDecision(decision)?.answer, "Yes");
  assert.equal(externalCalls, 0, "authorized commands queue work without doing network work during ingestion");
}));

test("HTTP bridge credentials cannot answer approvals, impersonate workspaces or bypass revocation", () => fixture(async f => {
  const other = createWorkspace({name: "other", prompt: "Other task", repoPath: "conductor-project:p1", telegramChatId: "42"});
  const credential = f.bridge.issueCredential(f.ws.id);
  const own = f.bridge.event(f.ws.id, {id: randomUUID(), type: "human_request", payload: {question: "Own question?"}}).decisionId!;
  const foreign = f.bridge.event(other.id, {id: randomUUID(), type: "human_request", payload: {question: "Private question?"}}).decisionId!;
  const file = f.bridge.save(other.id, "private.txt", Buffer.from("private contents"));
  const server = startBridge(f.bridge, 0); await once(server, "listening");
  try {
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const request = (route: string, method = "GET", body?: unknown, token = credential) => fetch(`${origin}${route}`, {
      method, headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    for (const token of ["", "invalid"]) {
      for (const route of ["/v1/decisions", "/v1/client", "/v1/bootstrap"]) {
        assert.equal((await request(route, "GET", undefined, token)).status, 401);
      }
      assert.equal((await request("/v1/events", "POST", {}, token)).status, 401);
      assert.equal((await request("/v1/attachments", "POST", {}, token)).status, 401);
    }
    const listed = await (await request(`/v1/decisions?workspaceId=${other.id}`)).json() as any;
    assert.deepEqual(listed.decisions.map((d: any) => d.id), [own]);
    assert.equal((await request(`/v1/decisions/${foreign}`)).status, 404);
    assert.equal((await request(`/v1/decisions/${own}`, "POST", {answer: "Yes"})).status, 404);
    assert.equal((await request(`/v1/attachments/${file}`, "POST", {})).status, 400);
    assert.equal((await request(`/v1/attachments/${file}?token=invalid`)).status, 404);
    const event = {id: randomUUID(), type: "human_request", payload: {question: "Forged question?"}};
    for (const forged of [{...event, workspaceId: other.id}, {...event, type: "run"},
      {...event, type: "decision", payload: {id: own, answer: "Yes"}},
      {...event, type: "artifact", payload: {type: "file", url: `attachment:${file}`, description: "Foreign file"}}]) {
      assert.equal((await request("/v1/events", "POST", forged)).status, 400);
    }
    assert.equal(getDecision(own)?.answer, null);
    assert.equal(getDecision(foreign)?.answer, null);
    assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM decisions").get() as any).n, 2);
    f.store.db.prepare("UPDATE gateway_credentials SET revoked=1 WHERE workspace_id=?").run(f.ws.id);
    assert.equal((await request("/v1/decisions")).status, 401);
    const replacement = f.bridge.issueCredential(f.ws.id);
    assert.equal((await request("/v1/decisions", "GET", undefined, replacement)).status, 200);
    f.store.db.prepare("UPDATE workspaces SET archived_at=datetime('now') WHERE id=?").run(f.ws.id);
    assert.equal((await request("/v1/decisions", "GET", undefined, replacement)).status, 401);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test("gateway lease prevents concurrent pollers and permits takeover only after expiry", () => fixture(async f => {
  assert.equal(acquireGatewayLease(f.store, "one", 1000), true);
  assert.equal(acquireGatewayLease(f.store, "two", 2000), false);
  assert.equal(acquireGatewayLease(f.store, "two", 92_000), true);
  assert.equal(acquireGatewayLease(f.store, "one", 93_000), false);
}));

test("a failed attachment unblocks later work and does not replay a stopped attachment", () => fixture(async f => {
  await f.launch();
  f.engine.queue("attachment:action", {type: "send", trackedId: f.ws.id, mediaPending: true});
  f.store.enqueue("media", "42:0", {}, "attachment:media"); f.store.retry("attachment:media", "Conversion failed", 0, true);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.store.row("attachment:action")?.state, "blocked");
  f.engine.queue("following", {type: "send", trackedId: f.ws.id, prompt: "Text follow-up"});
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.store.row("following")?.state, "done");
}));

test("ping is ingested independently of a stalled conversation", () => fixture(async f => {
  f.store.ingest([{update_id: 1, message: {chat: {id: 42}, text: "/run p1 slow"}}, {update_id: 2, message: {chat: {id: 42}, text: "/ping"}}]);
  f.store.claim(["update"], 1);
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42");
  await processQueue(f.store, ["health-update"], row => commands.handle(row));
  assert.equal(f.store.row("update:2")?.state, "done");
  assert.equal(JSON.parse(f.store.row("update:2:reply:0")!.payload).payload.disable_notification, true);
}));

test("queued expired attachment links renew without changing the message payload", () => fixture(async f => {
  const id = f.bridge.save(f.ws.id, "photo.jpg", Buffer.from("photo"));
  const original = f.bridge.link(id, f.ws.id); const token = new URL(original).searchParams.get("token")!;
  f.store.db.prepare("UPDATE gateway_file_links SET expires_at=0 WHERE file_id=?").run(id);
  assert.equal(f.bridge.validLink(id, token), undefined);
  f.bridge.refreshQueuedLinks(`Download ${original}`, f.ws.id);
  assert.ok(f.bridge.validLink(id, token));
}));

test("all eligible providers are attempted once and a user stop prevents further recovery", () => fixture(async f => {
  await f.launch();
  for (let i = 0; i < 5; i++) {
    f.status("error"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
    await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  }
  assert.equal(f.sessions.length, 5);
  assert.deepEqual(f.store.get("recovery-providers:launch"), [
    "claude:fable-5-1",
    "codex:gpt-6-astra",
    "claude:opus-5-1m",
    "codex:gpt-6-sol",
    "cursor:grok-4.7",
  ]);
  f.engine.queue("stop", {type: "stop", trackedId: f.ws.id});
  f.status("error"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.sessions.length, 5);
}));

test("topic maintenance coalesces and does not outrank transcript messages", () => fixture(async f => {
  const payload = {chat_id: "42", message_thread_id: 1, name: "first"};
  enqueueTelegram(f.store, "first-topic", {method: "editForumTopic", payload}, 20);
  enqueueTelegram(f.store, "last-topic", {method: "editForumTopic", payload: {...payload, name: "last"}}, 20);
  enqueueText(f.store, "text", "42", "Progress");
  const methods: string[] = [];
  const sender = new TelegramDelivery(f.store, async method => {methods.push(method); return {message_id: 1};});
  await sender.tick();
  assert.equal(f.store.row("first-topic")?.state, "done"); assert.deepEqual(methods, ["sendMessage"]);
}));

test("deleted topics are recreated before retrying their message", () => fixture(async f => {
  updateWorkspaceThreadId(f.ws.id, 10);
  enqueueText(f.store, "message", "42", "Progress", {workspaceId: f.ws.id, threadId: 10});
  const calls: any[] = [];
  const sender = new TelegramDelivery(f.store, async (method, payload) => {
    calls.push({method, payload});
    if (calls.length === 1) throw {response: {error_code: 400, description: "message thread not found"}};
    return method === "createForumTopic" ? {message_thread_id: 20} : {message_id: 100};
  });
  await sender.tick(); await sender.tick();
  f.store.set("telegram-chat-after:42", 0); f.store.retry("message:0", "retry", 0);
  await sender.tick(); assert.equal(calls[2].payload.message_thread_id, 20);
}));

test("polling reaches workspaces beyond 100 while another workspace is stalled, with concurrency four", () => fixture(async f => {
  await f.launch(); const template = f.store.binding(f.ws.id)!;
  for (let i = 0; i < 106; i++) f.store.bind(`workspace-${i}`, {...template, workspaceId: `remote-${i}`});
  const visited = new Set<string>(); let active = 0, maximum = 0; let release!: () => void;
  const stalled = new Promise<void>(resolve => {release = resolve;});
  f.engine.pollWorkspace = async id => {
    active++; maximum = Math.max(maximum, active); visited.add(id);
    if (id === f.ws.id) await stalled;
    else await new Promise(resolve => setImmediate(resolve));
    f.store.set(`poll-after:${id}`, Date.now() + 60_000); active--;
  };
  const poller = new CloudPoller(f.engine);
  for (let i = 0; i < 110; i++) {poller.tick(); await new Promise(resolve => setImmediate(resolve));}
  assert.ok(visited.has("workspace-105")); assert.ok(maximum <= 4);
  release(); await poller.settled();
}));

test("fallback rechecks the previous session and refuses a cancellation race", () => fixture(async f => {
  await f.launch(); f.status("error"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  f.status("working"); await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.sessions.length, 1);
  const blocked = f.store.db.prepare("SELECT state FROM gateway_queue WHERE id LIKE 'recover:%'").get() as any;
  assert.equal(blocked.state, "blocked");
}));

test("an unavailable provider rejected before launch is skipped without an uncertain replay", () => fixture(async f => {
  const original = f.api.createWorkspace; let attempts = 0;
  f.api.createWorkspace = async () => {if (++attempts === 1) throw new ConductorApiError("Provider model unavailable", 400); return original();};
  enqueueText(f.store, "provider-ack", "42", "Task received and queued.", {silent: true});
  f.engine.queue("launch", {type: "launch", trackedId: f.ws.id, projectId: "p1", prompt: "Fix\nthe bug", statusId: "provider-ack:0"});
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  const rejected = JSON.parse(f.store.row("provider-rejected:launch:claude:fable-5-1")!.payload);
  assert.equal(rejected.method, "editMessageText"); assert.equal(rejected.statusOf, "provider-ack:0");
  f.store.retry("launch", "eligible fallback", 0);
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.store.binding(f.ws.id)?.agent, "codex"); assert.equal(f.counts().sends, 1);
  assert.deepEqual(f.store.get("recovery-providers:launch"), [
    "claude:fable-5-1",
    "codex:gpt-6-astra",
  ]);
}));

for (const markdown of [false, true]) test(`partial ${markdown ? "rich" : "plain"} multi-message delivery resumes without repeating recorded receipts`, () => fixture(async f => {
  const text = "hello ".repeat(1200);
  enqueueText(f.store, "long", "42", markdown ? `**${text}**` : text, {markdown});
  let attempts = 0; const sent: string[] = [];
  const sender = new TelegramDelivery(f.store, async (_method, payload) => {
    attempts++; if (attempts === 2) throw new Error("network down"); sent.push(payload.text); return {message_id: attempts};
  });
  await sender.tick(); f.store.set("telegram-chat-after:42", 0); await sender.tick();
  f.store.recover(); f.store.set("telegram-not-before", 0); f.store.retry("long:1", "restored", 0);
  await sender.tick(); assert.equal(sent.length, 2); assert.equal(attempts, 3);
  if (markdown) for (const chunk of sent) assert.match(chunk, /^<b>[\s\S]*<\/b>$/);
  assert.equal(sent.join("").replace(/<\/?b>/g, ""), text);
}));

test("historical unanswered questions are retained without reopening archived work", () => fixture(async f => {
  const receipt = f.bridge.event(f.ws.id, {id: randomUUID(), type: "human_request", payload: {question: "Old question"}});
  f.store.db.prepare("UPDATE workspaces SET status='archived',archived_at=datetime('now') WHERE id=?").run(f.ws.id);
  f.engine.events();
  assert.ok(getDecision(receipt.decisionId!));
  assert.equal(f.store.row(`decision:${receipt.decisionId}:0`), undefined);
}));

test("Telegram media rate limits persist their full cooldown and native outages stay retryable", () => fixture(async f => {
  f.store.enqueue("media", "42", {}, "media");
  await processQueue(f.store, ["media"], async () => {throw {response: {error_code: 429, description: "Rate limited", parameters: {retry_after: 90}}};});
  assert.ok(f.store.row("media")!.available_at > Date.now() + 89_000);
  f.store.enqueue("cloud", f.ws.id, {}, "outage");
  for (let i = 0; i < 8; i++) {
    f.store.retry("outage", "probe", 0);
    await processQueue(f.store, ["cloud"], async () => {throw new ConductorApiError("Unavailable", 503, true, 120_000);});
  }
  assert.equal(f.store.row("outage")?.state, "pending");
  assert.ok(f.store.row("outage")!.available_at > Date.now() + 119_000);
}));

test("native out-of-usage-credits errors recover once after confirming an idle session", () => fixture(async f => {
  await f.launch();
  const sent = f.store.get<any>('session:s1').sentMessageId;
  f.messages.push({id: 'credits-error', sessionId: 's1', sessionIndex: 1, type: 'agent', receivedAt: new Date().toISOString(),
    content: {userMessageId: sent, rawPayload: {type: 'result', subtype: 'error_during_execution', is_error: true,
      result: "You're out of usage credits. Switch to another model to continue."}}});
  f.status('idle');
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.store.get<any>('session:s1').recoveryAttempted, true);
  const recovery = (f.store.db.prepare("SELECT payload FROM gateway_queue WHERE kind='cloud'").all() as Array<{payload: string}>)
    .map(row => JSON.parse(row.payload)).filter(action => action.recovery);
  assert.equal(recovery.length, 1); assert.equal(recovery[0].provider.agent, 'codex');
  assert.equal(recovery[0].previousSessionId, 's1'); assert.equal(recovery[0].previousMessageId, sent);
  assert.deepEqual(f.counts(), {creates: 1, sends: 1}, 'the original native command was not replayed');
}));

test("an inaccessible selected model falls back only after its native turn stops", () => fixture(async f => {
  await f.launch();
  const sent = f.store.get<any>('session:s1').sentMessageId;
  f.messages.push({id: 'model-error', sessionId: 's1', sessionIndex: 1, type: 'agent', receivedAt: new Date().toISOString(),
    content: {userMessageId: sent, rawPayload: {type: 'result', subtype: 'error_during_execution', is_error: true,
      result: "There's an issue with the selected model (gpt-5.6-sol). It may not exist or you may not have access to it."}}});
  f.status('working');
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.ok(!f.store.get<any>('session:s1').recoveryAttempted, 'a working session cannot be replaced');
  f.status('idle');
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const recovery = (f.store.db.prepare("SELECT payload FROM gateway_queue WHERE kind='cloud'").all() as Array<{payload: string}>)
    .map(row => JSON.parse(row.payload)).filter(action => action.recovery);
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].previousSessionId, 's1');
  assert.equal(recovery[0].previousMessageId, sent);
  assert.equal(recovery[0].provider.agent, 'codex');
  assert.deepEqual(f.counts(), {creates: 1, sends: 1}, 'the failed task must not be replayed');
}));

test("a repo topic routes itself to the one project matching its repository name", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git"},
    {id: "p2", name: "Long Events", gitRemote: "git@github.com:org/long-events.git"},
  ];
  f.api.getWorkspace = async () => ({id: "w1", name: "workspace", repoUrl: "https://github.com/org/long-events", deepLink: "conductor://w1"});
  const commands = repoTopic(f, "long-events");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "ship the calendar"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  // The remote's repository name authorizes the match; the project's own name never has to agree.
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  const action = JSON.parse(f.store.row("update:1:action")!.payload);
  assert.equal(action.type, "launch"); assert.equal(action.projectId, "p2");
  // One topic, one workspace: it lives here rather than opening a topic of its own.
  assert.equal(getWorkspace(action.trackedId)?.telegramThreadId, 5);
  const ack = JSON.parse(f.store.row("update:1:reply:0")!.payload).payload.text;
  assert.match(ack, /Task received and queued/); assert.match(ack, /now routes to Long Events/);
  assert.match(ack, /This topic now follows that workspace/);
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.counts().creates, 1);
  assert.equal(f.store.row(`create-topic:${action.trackedId}`), undefined);
  f.store.ingest([{update_id: 2, message: {message_id: 102, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "second task"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const second = JSON.parse(f.store.row("update:2:action")!.payload);
  // The follow-up continues that workspace instead of opening another.
  assert.equal(second.type, "send"); assert.equal(second.trackedId, action.trackedId);
  const followUp = JSON.parse(f.store.row("update:2:reply:0")!.payload).payload.text;
  assert.doesNotMatch(followUp, /now routes to/); assert.doesNotMatch(followUp, /now follows that workspace/);
}));

test("an ambiguous repo topic asks once per burst, answers a later attempt, and links on confirmation", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "api", gitRemote: "git@github.com:org/api.git"},
    {id: "p2", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
  ];
  const commands = repoTopic(f, "api");
  const inThread = () => (f.store.db.prepare("SELECT payload FROM gateway_queue WHERE kind='telegram'").all() as any[])
    .map(row => JSON.parse(row.payload)).filter(job => job.method === "sendMessage" && job.payload.message_thread_id === 5);
  const pasted = [1, 2, 3].map(n => ({update_id: n, message: {message_id: 100 + n, chat: {id: -42}, from: {id: 9},
    message_thread_id: 5, date: 1_700_000_000, text: `part ${n} of one pasted list`}}));
  f.store.ingest(pasted);
  // One conversation is claimed in order, so this is three separately handled updates.
  for (const _ of pasted) await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.row("update:3")?.state, "done");
  assert.equal(inThread().length, 1);
  assert.match(inThread()[0].payload.text, /does not match exactly one Conductor project/);
  assert.match(inThread()[0].payload.text, /nothing sent here reaches Conductor yet/);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind='cloud'").get() as any).n, 0);
  const buttons = inThread()[0].payload.reply_markup.inline_keyboard.map((row: any[]) => row[0]);
  assert.deepEqual(buttons.map((b: any) => b.text), ["api \u00b7 org/api", "partner-api \u00b7 partner/api"]);

  // The rest of that paste lands in the next getUpdates batch; Telegram's send time still pairs it.
  f.store.ingest([{update_id: 4, message: {message_id: 104, chat: {id: -42}, from: {id: 9}, message_thread_id: 5,
    date: 1_700_000_001, text: "the tail of that same paste"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(inThread().length, 1);

  // A later attempt is a new message, so silence is never the answer to one.
  f.store.ingest([{update_id: 5, message: {message_id: 105, chat: {id: -42}, from: {id: 9}, message_thread_id: 5,
    date: 1_700_000_030, text: "try again"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(inThread().length, 2);

  // A backlog drained in one batch is many messages, not one burst: each is answered.
  f.store.ingest([6, 7].map(n => ({update_id: n, message: {message_id: 100 + n, chat: {id: -42}, from: {id: 9},
    message_thread_id: 5, date: 1_700_000_000 + n * 600, text: `queued while the gateway was down ${n}`}})));
  for (const _ of [6, 7]) await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(inThread().length, 4);

  f.store.ingest([{update_id: 8, callback_query: {id: "tap", from: {id: 9}, data: buttons[1].callback_data,
    message: {message_id: 200, chat: {id: -42}, message_thread_id: 5}}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  f.store.ingest([{update_id: 9, message: {message_id: 109, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "ship it"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(JSON.parse(f.store.row("update:9:action")!.payload).projectId, "p2");
}));

test("an explicit /run adopts its repo topic so later plain messages continue that workspace", () => fixture(async f => {
  const commands = repoTopic(f, "other", 6);
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 6, text: "/run p1 first task"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:6"), "p1");
  f.store.ingest([{update_id: 2, message: {message_id: 102, chat: {id: -42}, from: {id: 9}, message_thread_id: 6, text: "second task"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  // Sent before the first launch has bound: the topic must not gain a rival workspace.
  const first = JSON.parse(f.store.row("update:1:action")!.payload);
  const action = JSON.parse(f.store.row("update:2:action")!.payload);
  assert.equal(action.trackedId, first.trackedId);
  assert.equal(getWorkspace(action.trackedId)?.telegramThreadId, 6);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM workspaces WHERE telegram_thread_id=6").get() as any).n, 1);
  // Once it is bound, a later message is a plain follow-up.
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  f.store.ingest([{update_id: 3, message: {message_id: 103, chat: {id: -42}, from: {id: 9}, message_thread_id: 6, text: "third task"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const third = JSON.parse(f.store.row("update:3:action")!.payload);
  assert.equal(third.type, "send"); assert.equal(third.trackedId, first.trackedId);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind='telegram' AND payload LIKE '%reaches Conductor yet%'").get() as any).n, 0);
}));

test("/link corrects an automatic repo topic route and rejects an unknown project", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git"},
    {id: "p2", name: "other", gitRemote: "git@github.com:org/other.git"},
  ];
  const commands = repoTopic(f, "repo");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "first task"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p1");
  f.store.ingest([{update_id: 2, message: {message_id: 102, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "/link nope"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p1");
  assert.match(JSON.parse(f.store.row("update:2:reply:0")!.payload).payload.text, /Repository unavailable or ambiguous/);
  f.store.ingest([{update_id: 3, message: {message_id: 103, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "/link other"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  f.store.ingest([{update_id: 4, message: {message_id: 104, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "/link"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const picker = JSON.parse(f.store.row("update:4:bindtopic:0")!.payload).payload;
  assert.deepEqual(picker.reply_markup.inline_keyboard.map((row: any[]) => row[0].text), ["\u25cf other \u00b7 org/other", "repo \u00b7 org/repo"]);
  // An explicit /link reports where the topic points; it never claims a message was dropped.
  assert.match(picker.text, /repo routes to other \u00b7 org\/other/);
  assert.doesNotMatch(picker.text, /reaches Conductor yet/);
  f.store.ingest([{update_id: 5, message: {message_id: 105, chat: {id: -42}, from: {id: 9}, text: "/link repo"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.match(JSON.parse(f.store.row("update:5:reply:0")!.payload).payload.text, /inside a repository topic/);
}));

test("repo topic matching accepts a whole repository name and never a partial one", () => {
  const projects = [
    {id: "p1", name: "Long Events", gitRemote: "git@github.com:org/long-events.git"},
    {id: "p2", name: "long-events-admin", gitRemote: "https://github.com/org/long-events-admin"},
    {id: "p3", name: "api", gitRemote: "ssh://git@github.com/org/api.git"},
    {id: "p4", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
    {id: "p5", name: "broken", gitRemote: "not a remote"},
  ];
  const ids = (name: string) => repoTopicCandidates(name, projects as any).map(p => p.id);
  assert.deepEqual(ids("long-events"), ["p1"]);
  assert.deepEqual(ids("LONG-EVENTS"), ["p1"]);
  assert.deepEqual(ids("Long Events"), ["p1"]);
  // Two repositories share a name, so the topic has no single identity to route on.
  assert.deepEqual(ids("api"), ["p3", "p4"]);
  // A prefix, a suffix and an empty name are never a match.
  assert.deepEqual(ids("long"), []);
  assert.deepEqual(ids("events"), []);
  assert.deepEqual(ids("  "), []);
  assert.deepEqual(ids("not a remote"), []);
});

test("a repo topic with nothing to offer asks for /link without an empty keyboard and forwards nothing", () => fixture(async f => {
  f.api.listProjects = async () => [];
  const commands = repoTopic(f, "orphan");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5,
    photo: [{file_id: "thumb"}, {file_id: "full"}], caption: "fix this screenshot"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const notice = JSON.parse(f.store.row("update:1:bindtopic:0")!.payload).payload;
  assert.match(notice.text, /nothing sent here reaches Conductor yet/);
  assert.match(notice.text, /Use \/projects, then \/link/);
  // An empty catalog has nothing to pick, so Telegram must not be sent a keyboard with no buttons.
  assert.equal(notice.reply_markup, undefined);
  // An attachment nobody can route is never uploaded or queued against a guessed project.
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind IN ('cloud','media')").get() as any).n, 0);
  assert.equal(f.store.get("repo-topic-project:-42:5"), undefined);
}));

test("an ambiguous repo topic ranks related projects first and offers at most four", () => fixture(async f => {
  f.api.listProjects = async () => ["api-tools", "my-api-service", "alpha", "beta", "delta", "gamma"]
    .map((name, i) => ({id: `a${i}`, name, gitRemote: `git@github.com:org/${name}.git`}));
  const commands = repoTopic(f, "api");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "ship it"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const notice = JSON.parse(f.store.row("update:1:bindtopic:0")!.payload).payload;
  // Projects whose name contains the repository sort above unrelated ones, and a long catalog is truncated.
  assert.deepEqual(notice.reply_markup.inline_keyboard.map((row: any[]) => row[0].text),
    ["api-tools \u00b7 org/api-tools", "my-api-service \u00b7 org/my-api-service", "alpha \u00b7 org/alpha", "beta \u00b7 org/beta"]);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind='cloud'").get() as any).n, 0);
}));

test("a photo in a repo topic auto-links and its workspace lives in that topic", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git"},
    {id: "p2", name: "Screens", gitRemote: "git@github.com:org/screens.git"},
  ];
  const commands = repoTopic(f, "screens");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5,
    photo: [{file_id: "thumb"}, {file_id: "full"}]}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  const action = JSON.parse(f.store.row("update:1:action")!.payload);
  assert.equal(action.type, "launch"); assert.equal(action.projectId, "p2"); assert.equal(action.mediaPending, true);
  assert.equal(JSON.parse(f.store.row("update:1:media")!.payload).fileId, "full");
  assert.equal(getWorkspace(action.trackedId)?.telegramThreadId, 5);
  const ack = JSON.parse(f.store.row("update:1:reply:0")!.payload).payload.text;
  assert.match(ack, /Attachment received/); assert.match(ack, /now routes to Screens/);
}));

test("a topic link tap from another topic or an expired button changes nothing", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "api", gitRemote: "git@github.com:org/api.git"},
    {id: "p2", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
  ];
  const commands = repoTopic(f, "api");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "ship it"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const data = JSON.parse(f.store.row("update:1:bindtopic:0")!.payload).payload.reply_markup.inline_keyboard[0][0].callback_data;
  // A button belongs to the topic it was offered in; the same owner tapping it elsewhere links nothing.
  f.store.ingest([{update_id: 2, callback_query: {id: "elsewhere", from: {id: 9}, data,
    message: {message_id: 200, chat: {id: -42}, message_thread_id: 6}}}]);
  f.store.ingest([{update_id: 3, callback_query: {id: "expired", from: {id: 9}, data: "bindtopic:expired",
    message: {message_id: 201, chat: {id: -42}, message_thread_id: 5}}}]);
  for (const _ of [2, 3]) await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), undefined);
  assert.equal(f.store.get("repo-topic-project:-42:6"), undefined);
  assert.equal(f.store.row("update:2:reply:0"), undefined);
  // A dead button inside the topic says so; one aimed at another topic is not this topic's business.
  assert.match(JSON.parse(f.store.row("update:3:answer")!.payload).payload.text, /no longer on the table/);
  // Every tap is still acknowledged, so Telegram never leaves a spinner behind.
  assert.ok(f.store.row("update:2:answer")); assert.ok(f.store.row("update:3:answer"));
  f.store.ingest([{update_id: 4, callback_query: {id: "real", from: {id: 9}, data,
    message: {message_id: 202, chat: {id: -42}, message_thread_id: 5}}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p1");
  // Answering retires the whole offer: its buttons and its burst notice both go.
  assert.equal(f.store.get("repo-topic-notice:-42:5"), undefined);
  assert.equal(f.store.get("repo-topic-offer:-42:5"), undefined);
  assert.equal(f.store.get(data), undefined);
}));

test("a catalog outage retries the repo topic message instead of dropping or guessing it", () => fixture(async f => {
  f.api.listProjects = async () => { throw new Error("catalog unavailable"); };
  const commands = repoTopic(f, "repo");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "ship it"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.row("update:1")?.state, "pending");
  assert.match(f.store.row("update:1")?.error ?? "", /catalog unavailable/);
  assert.equal(f.store.get("repo-topic-project:-42:5"), undefined);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind='cloud'").get() as any).n, 0);
  // The failure must not count as the burst's one answer, or the retry would be silent.
  f.api.listProjects = async () => [{id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git"}];
  f.store.retry("update:1", "retry", 0);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p1");
  assert.equal(JSON.parse(f.store.row("update:1:action")!.payload).projectId, "p1");
}));

test("a one-off /run in a linked repo topic stays a one-off and says where the topic still routes", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git"},
    {id: "p2", name: "other", gitRemote: "git@github.com:org/other.git"},
  ];
  const commands = repoTopic(f, "repo");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "/link other"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  for (const [i, text] of ["/run p1 one off", "/cloud p1 another one off"].entries()) {
    const id = i + 2;
    f.store.ingest([{update_id: id, message: {message_id: 100 + id, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text}}]);
    await processQueue(f.store, ["update"], row => commands.handle(row));
    assert.equal(JSON.parse(f.store.row(`update:${id}:action`)!.payload).projectId, "p1", text);
    assert.match(JSON.parse(f.store.row(`update:${id}:reply:0`)!.payload).payload.text, /one-off in repo \u00b7 org\/repo\. repo still routes to other \u00b7 org\/other/, text);
    // Naming a project for one task must never silently re-point every later message.
    assert.equal(f.store.get("repo-topic-project:-42:5"), "p2", text);
  }
  // Each /run rolls the topic onto the work it started, so the follow-up continues that workspace.
  const latest = JSON.parse(f.store.row("update:3:action")!.payload).trackedId;
  f.store.ingest([{update_id: 4, message: {message_id: 104, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "plain follow-up"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(JSON.parse(f.store.row("update:4:action")!.payload).trackedId, latest);
  // The link the owner set with /link still decides where the NEXT fresh task goes.
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
}));

test("a repo topic whose project the catalog stops listing asks again and keeps its link", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "api", gitRemote: "git@github.com:org/api.git"},
    {id: "p2", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
  ];
  const commands = repoTopic(f, "api");
  f.store.set("repo-topic-project:-42:5", "p-deleted");
  const before = (f.store.db.prepare("SELECT count(*) AS n FROM workspaces").get() as any).n;
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "ship it"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.row("update:1:action"), undefined);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM workspaces").get() as any).n, before);
  // A stale or partial catalog read never deletes a link the owner confirmed, and never replaces it.
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p-deleted");
  assert.match(JSON.parse(f.store.row("update:1:bindtopic:0")!.payload).payload.text, /this catalog does not list/);
}));

test("a voice note in an unlinked repo topic is answered, never transcribed into a guess", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "api", gitRemote: "git@github.com:org/api.git"},
    {id: "p2", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
  ];
  const commands = repoTopic(f, "api");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, voice: {file_id: "v1"}}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind IN ('media','cloud')").get() as any).n, 0);
  assert.match(JSON.parse(f.store.row("update:1:bindtopic:0")!.payload).payload.text, /nothing sent here reaches Conductor yet/);
}));

test("a button from an offer the owner already answered cannot re-point the topic later", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "api", gitRemote: "git@github.com:org/api.git"},
    {id: "p2", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
  ];
  const commands = repoTopic(f, "api");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "ship it"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const stale = JSON.parse(f.store.row("update:1:bindtopic:0")!.payload).payload.reply_markup.inline_keyboard[0][0].callback_data;
  f.store.ingest([{update_id: 2, message: {message_id: 102, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "/link partner-api"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  // Scrollback is not a control surface: the superseded button reports itself instead of rebinding.
  f.store.ingest([{update_id: 3, callback_query: {id: "stale", from: {id: 9}, data: stale,
    message: {message_id: 200, chat: {id: -42}, message_thread_id: 5}}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  assert.match(JSON.parse(f.store.row("update:3:answer")!.payload).payload.text, /no longer on the table/);
}));

test("a message queued behind /link is answered instead of swallowed by its picker", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "api", gitRemote: "git@github.com:org/api.git"},
    {id: "p2", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
  ];
  const commands = repoTopic(f, "api");
  // Both arrive in one batch, as they do after a restart or a Telegram backoff.
  f.store.ingest([1, 2].map(n => ({update_id: n, message: {message_id: 100 + n, chat: {id: -42}, from: {id: 9},
    message_thread_id: 5, date: 1_700_000_000, text: n === 1 ? "/link" : "ship the release notes"}})));
  for (const _ of [1, 2]) await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.match(JSON.parse(f.store.row("update:1:bindtopic:0")!.payload).payload.text, /routes to no project yet/);
  assert.match(JSON.parse(f.store.row("update:2:bindtopic:0")!.payload).payload.text, /nothing sent here reaches Conductor yet/);
}));

test("a button dropped from a later offer stops working instead of re-pointing the topic", () => fixture(async f => {
  let catalog = [
    {id: "p1", name: "api", gitRemote: "git@github.com:org/api.git"},
    {id: "p2", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
    {id: "p3", name: "charlie", gitRemote: "git@github.com:org/charlie.git"},
    {id: "p4", name: "delta", gitRemote: "git@github.com:org/delta.git"},
  ];
  f.api.listProjects = async () => catalog;
  const commands = repoTopic(f, "api");
  const buttons = (id: number) => JSON.parse(f.store.row(`update:${id}:bindtopic:0`)!.payload)
    .payload.reply_markup.inline_keyboard.map((row: any[]) => row[0]);
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, date: 1_700_000_000, text: "ship it"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const dropped = buttons(1).find((b: any) => b.text.startsWith("delta")).callback_data;
  // A new project outranks delta alphabetically, so the next offer of four drops its button.
  catalog = [...catalog, {id: "p5", name: "aardvark", gitRemote: "git@github.com:org/aardvark.git"}];
  f.store.clear("projects");
  f.store.ingest([{update_id: 2, message: {message_id: 102, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, date: 1_700_000_060, text: "try again"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.ok(!buttons(2).some((b: any) => b.text.startsWith("delta")));
  assert.equal(f.store.get(dropped), undefined);
  f.store.ingest([{update_id: 3, callback_query: {id: "stale", from: {id: 9}, data: dropped,
    message: {message_id: 200, chat: {id: -42}, message_thread_id: 5}}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), undefined);
  assert.match(JSON.parse(f.store.row("update:3:answer")!.payload).payload.text, /no longer on the table/);
}));

test("an album reaches one workspace in the project its caption named", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git"},
    {id: "p2", name: "other", gitRemote: "git@github.com:org/other.git"},
  ];
  const commands = repoTopic(f, "repo");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "/link other"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  // Telegram delivers an album as one update per photo, with the caption on only the first.
  f.store.ingest([2, 3].map(n => ({update_id: n, message: {message_id: 100 + n, chat: {id: -42}, from: {id: 9},
    message_thread_id: 5, media_group_id: "album-1", photo: [{file_id: `photo-${n}`}],
    ...(n === 2 ? {caption: "/run p1 fix these two screens"} : {})}})));
  for (const _ of [2, 3]) await processQueue(f.store, ["update"], row => commands.handle(row));
  const captioned = JSON.parse(f.store.row("update:2:action")!.payload);
  assert.equal(captioned.projectId, "p1");
  assert.match(JSON.parse(f.store.row("update:2:reply:0")!.payload).payload.text, /one-off in repo \u00b7 org\/repo\. repo still routes to other \u00b7 org\/other/);
  // Both photos are one intent, so they reach one workspace rather than one workspace each.
  assert.equal(JSON.parse(f.store.row("update:3:action")!.payload).trackedId, captioned.trackedId);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM workspaces WHERE telegram_thread_id=5").get() as any).n, 1);
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
}));

test("a workspace already living in a repo topic is continued, not replaced", () => fixture(async f => {
  f.api.listProjects = async () => [{id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git"}];
  const commands = repoTopic(f, "repo");
  // v0.8.1 pinned the workspace it launched to the repo topic's own thread.
  updateWorkspaceThreadId(f.ws.id, 5);
  await f.launch();
  assert.ok(f.store.binding(f.ws.id));
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "start something new"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const action = JSON.parse(f.store.row("update:1:action")!.payload);
  // The workspace already in this topic is the topic's workspace: continue it.
  assert.equal(action.type, "send");
  assert.equal(action.trackedId, f.ws.id);
  // Replying to one of its messages targets the same workspace.
  linkTelegramMessage("-42", "500", f.ws.id, "s1");
  f.store.ingest([{update_id: 2, message: {message_id: 102, chat: {id: -42}, from: {id: 9}, message_thread_id: 5,
    reply_to_message: {message_id: 500}, text: "keep going"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(JSON.parse(f.store.row("update:2:action")!.payload).trackedId, f.ws.id);
}));

test("a stop signal ends ingestion cleanly instead of failing the whole service", () => fixture(async f => {
  const abort = new AbortController();
  // The live gateway fences every write on its lease and throws once the abort fires.
  f.store.assertWriter = () => { if (abort.signal.aborted) throw new Error("Gateway lease lost"); };
  let polls = 0;
  const call = async (): Promise<any> => { polls++; abort.abort(); throw new Error("Gateway lease lost"); };
  // Recording why ingestion stopped must not itself throw out of the handler.
  await ingestTelegram(f.store, call, abort.signal);
  assert.equal(polls, 1);
  assert.equal(f.store.get("ingestion-error"), undefined);
}));

/** A session that Conductor reports under another workspace: the same answer on every attempt. */
const foreignSession = (async (sessionId: string) => ({workspaceId: "other", sessionId, status: "idle"})) as any;

test("a deterministic failure blocks on the first attempt and lands on the turn's card", () => fixture(async f => {
  await f.launch();
  enqueueText(f.store, "cmd:reply", "42", "Queued for Conductor.", {priority: 0, silent: true});
  f.api.getSessionStatus = foreignSession;
  f.engine.queue("doomed", {type: "send", trackedId: f.ws.id, prompt: "next", statusId: "cmd:reply:0"});
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.store.row("doomed")!.state, "blocked");
  assert.equal(f.store.row("doomed")!.attempts, 1);
  assert.equal(f.store.get("queue-failures:doomed"), undefined, "a terminal failure is not a counted retry");
  reportBlocked(f.store, "42");
  const card = JSON.parse(f.store.row("blocked-card:doomed")!.payload);
  assert.equal(card.method, "editMessageText");
  assert.equal(card.statusOf, "cmd:reply:0");
  assert.equal(card.payload.text, "Not done: Session belongs to another cloud workspace");
  assert.equal(f.store.row("blocked:doomed:0"), undefined, "a card the owner is watching does not also ring");
  const rows = () => (f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue").get() as any).n;
  const before = rows(); reportBlocked(f.store, "42");
  assert.equal(rows(), before, "blocked work is reported once");
}));

test("a failure that surfaces after the owner stopped watching also rings", () => fixture(async f => {
  await f.launch();
  enqueueText(f.store, "cmd:reply", "42", "Queued for Conductor.", {priority: 0, silent: true});
  f.store.db.prepare("UPDATE gateway_queue SET created_at=? WHERE id='cmd:reply:0'").run(Date.now() - ATTENTION_AFTER_MS - 1000);
  f.api.getSessionStatus = foreignSession;
  f.engine.queue("late", {type: "send", trackedId: f.ws.id, prompt: "next", statusId: "cmd:reply:0"});
  f.engine.queue("bare", {type: "send", trackedId: f.ws.id, prompt: "no card"});
  for (let i = 0; i < 2; i++) await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  reportBlocked(f.store, "42");
  assert.ok(f.store.row("blocked-card:late"));
  assert.match(JSON.parse(f.store.row("blocked:late:0")!.payload).payload.text, /^Operation needs attention: Session belongs/);
  assert.equal(f.store.row("blocked-card:bare"), undefined);
  assert.match(JSON.parse(f.store.row("blocked:bare:0")!.payload).payload.text, /^Operation needs attention: Session belongs/);
}));

test("a blocked row whose tracked workspace is gone still reaches the owner", () => fixture(async f => {
  f.store.enqueue("cloud", "ghost", {type: "send", trackedId: "ghost", prompt: "x"}, "ghost-row");
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.store.row("ghost-row")!.state, "blocked");
  assert.equal(f.store.row("ghost-row")!.attempts, 1);
  reportBlocked(f.store, "42");
  const notice = JSON.parse(f.store.row("blocked:ghost-row:0")!.payload).payload;
  assert.equal(notice.chat_id, "42");
  assert.match(notice.text, /^Telegram operation needs attention: This workspace.+record no longer exists.+\/run/);
}));

test("blocked gateway rows answer in the chat that asked, and a raw update reports to the owner", () => fixture(async f => {
  f.store.enqueue("route", "native-router", {text: "hi", chatId: "-42", threadId: 9}, "r:route");
  f.store.retry("r:route", "Routing failed", 0, true);
  f.store.enqueue("update", "-7:0", {update_id: 1, message: {chat: {id: -7}, message_thread_id: 3, text: "x"}}, "update:1");
  f.store.retry("update:1", "Handler failed", 0, true);
  reportBlocked(f.store, "42");
  const route = JSON.parse(f.store.row("blocked:r:route:0")!.payload).payload;
  assert.equal(route.chat_id, "-42"); assert.equal(route.message_thread_id, 9);
  const update = JSON.parse(f.store.row("blocked:update:1:0")!.payload).payload;
  assert.equal(update.chat_id, "42"); assert.equal(update.message_thread_id, undefined);
}));

test("a workspace Conductor deletes during provisioning fails the launch once, with Conductor's reason", () => fixture(async f => {
  f.store.db.prepare("UPDATE workspaces SET telegram_chat_id='-42' WHERE id=?").run(f.ws.id);
  let statusReads = 0;
  f.api.getWorkspaceStatus = (async () => { statusReads++; return {workspaceId: "w1", status: "deleted",
    errorMessage: "Failed to create workspace branch conductor/x: fatal: token ghp_abcdefghij123456 https://github.com/org/repo\n\t.conductor/settings.local.toml"}; }) as any;
  await f.launch();
  const row = f.store.row("launch")!;
  assert.equal(row.state, "blocked"); assert.equal(row.attempts, 1);
  assert.match(row.error!, /^Conductor could not create the workspace: Failed to create workspace branch.+settings\.local\.toml$/);
  assert.doesNotMatch(row.error!, /ghp_|deploy:/, "relayed git output is scrubbed");
  const ws = getWorkspace(f.ws.id)!;
  assert.equal(ws.status, "failed"); assert.ok(ws.archivedAt);
  assert.equal((f.store.db.prepare("SELECT revoked FROM gateway_credentials WHERE workspace_id=?").get(f.ws.id) as any).revoked, 1);
  // Telegram had not opened the topic yet: it is cancelled with everything waiting for it, rather than left to hold the lane.
  assert.equal(f.store.row(`create-topic:${f.ws.id}`)!.state, "done");
  assert.equal(f.store.row("launch:created:0")!.state, "done");
  assert.equal(f.store.row(`retire-topic:${f.ws.id}`), undefined);
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(statusReads, 1, "a retired workspace is no longer polled");
}));

test("a workspace that disappears later is retired, and only a topic this gateway opened is closed", () => fixture(async f => {
  f.store.db.prepare("UPDATE workspaces SET telegram_chat_id='-42' WHERE id=?").run(f.ws.id);
  await f.launch();
  updateWorkspaceThreadId(f.ws.id, 77);
  f.api.getWorkspaceStatus = (async () => ({workspaceId: "w1", status: "archived"})) as any;
  f.store.set(`poll-after:${f.ws.id}`, 0);
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(getWorkspace(f.ws.id)!.status, "archived");
  const close = f.store.row(`retire-topic:${f.ws.id}`)!;
  assert.equal(JSON.parse(close.payload).method, "closeForumTopic");
  assert.equal(close.conversation, "-42:77", "queued behind the notices already owed to the topic");
  const notice = f.store.row(`unavailable:${f.ws.id}:0`)!;
  assert.equal(notice.conversation, close.conversation);
  assert.match(JSON.parse(notice.payload).payload.text, /no longer available\. Its history is retained/);
}));

test("an adopted topic is never closed when its workspace is retired", () => fixture(async f => {
  await f.launch();
  f.store.db.prepare("UPDATE workspaces SET telegram_chat_id='-42' WHERE id=?").run(f.ws.id);
  updateWorkspaceThreadId(f.ws.id, 77);
  f.api.getWorkspaceStatus = (async () => ({workspaceId: "w1", status: "deleted", errorMessage: "quota exceeded"})) as any;
  f.store.set(`poll-after:${f.ws.id}`, 0);
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(getWorkspace(f.ws.id)!.status, "failed");
  assert.equal(f.store.row(`retire-topic:${f.ws.id}`), undefined);
  assert.match(JSON.parse(f.store.row(`unavailable:${f.ws.id}:0`)!.payload).payload.text, /no longer available: quota exceeded\./);
}));

test("a message for a retired workspace's closed topic is dropped instead of blocking delivery", () => fixture(async f => {
  updateWorkspaceThreadId(f.ws.id, 7);
  f.store.db.prepare("UPDATE workspaces SET status='archived',archived_at=datetime('now') WHERE id=?").run(f.ws.id);
  enqueueText(f.store, "late", "42", "late notice", {workspaceId: f.ws.id, threadId: 7});
  const delivery = new TelegramDelivery(f.store, async () => { throw {response: {error_code: 400, description: "Bad Request: TOPIC_CLOSED"}}; });
  await delivery.tick();
  assert.equal(f.store.row("late:0")!.state, "done");
  assert.match(f.store.row("late:0")!.result!, /suppressed/);
  assert.equal(f.store.backlog().blocked, 0);
}));

test("a topic that opens after its workspace was retired is closed again", () => fixture(async f => {
  f.store.db.prepare("UPDATE workspaces SET telegram_chat_id='-42',status='failed',archived_at=datetime('now') WHERE id=?").run(f.ws.id);
  enqueueTelegram(f.store, `create-topic:${f.ws.id}`, {method: "createForumTopic", workspaceId: f.ws.id, payload: {chat_id: "-42", name: "task"}}, 0);
  const delivery = new TelegramDelivery(f.store, async () => ({message_thread_id: 88}));
  await delivery.tick();
  const close = JSON.parse(f.store.row(`retire-topic:${f.ws.id}`)!.payload);
  assert.equal(close.method, "closeForumTopic");
  assert.equal(close.payload.message_thread_id, 88);
}));

test("relayed upstream detail is scrubbed and bounded", () => {
  const remote = ["https:/", "/user:pw@github.com/org/repo"].join("");
  assert.equal(safeDetail(`fatal: ${remote}\n\tnot found`), "fatal: https://github.com/org/repo not found");
  assert.doesNotMatch(safeDetail("token ghp_abcdefgh12345678 and github_pat_11ABCDEFG0abcdefgh and bot123456:AAH-xyz_1"), /ghp_|github_pat_|AAH/);
  assert.equal(safeDetail("x".repeat(400)).length, 300);
  assert.equal(safeDetail(undefined), "");
});

const openPr = (number: number, head = "a".repeat(40)): import("../src/cloud/catalog.js").CloudPr => ({
  url: `https://github.com/org/repo/pull/${number}`, number, head, base: "b".repeat(40), branch: "feature", state: "open", merged: false, draft: false,
});

test("bare /review finds one open PR from the transcript", () => fixture(async f => {
  await f.launch();
  enqueueText(f.store, "cmd:reply", "42", "Queued for Conductor.", {silent: true});
  f.messages.push({id: "pr", sessionId: "s1", type: "assistant", content: "Opened https://github.com/org/repo/pull/12", sessionIndex: 1, receivedAt: new Date().toISOString()});
  f.engine.github.pr = async (_slug, url) => { assert.equal(url, "https://github.com/org/repo/pull/12"); return openPr(12); };
  f.engine.queue("review", {type: "review", trackedId: f.ws.id, statusId: "cmd:reply:0"});
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.sessions.length, 2);
  assert.equal(f.store.get<any>("session:s2")?.reviewUrl, "https://github.com/org/repo/pull/12");
  assert.equal(JSON.parse(f.store.row("review:sent")!.payload).payload.text, "Reviewing PR #12 (aaaaaaa) in codex");
  assert.equal(f.store.row("review")!.state, "done");
}));

test("short /review forms skip the transcript scan", () => fixture(async f => {
  await f.launch();
  let scanned = 0;
  const list = f.api.listWorkspaceSessions;
  f.api.listWorkspaceSessions = async () => { scanned++; return list(); };
  f.api.getSessionMessageTail = async () => { scanned++; return []; };
  f.engine.github.pr = async (_slug, url) => { assert.equal(url, "https://github.com/org/repo/pull/500"); return openPr(500); };
  for (const prompt of ["500", "#500", "500 focus on auth", "#500 focus on auth"]) {
    const id = `review-${prompt}`;
    scanned = 0;
    f.engine.queue(id, {type: "review", trackedId: f.ws.id, prompt});
    await processQueue(f.store, ["cloud"], r => f.engine.action(r));
    assert.equal(scanned, 0, `/${prompt} must not read Conductor transcripts`);
    assert.equal(f.store.get<any>(`review:${id}`)?.url, "https://github.com/org/repo/pull/500");
  }
}));

test("several transcript PRs preserve review instructions and require just one choice", () => fixture(async f => {
  await f.launch();
  enqueueText(f.store, "cmd:reply", "42", "Queued for Conductor.", {silent: true});
  f.messages.push({id: "prs", sessionId: "s1", type: "assistant",
    content: "See https://github.com/org/repo/pull/8 and https://github.com/org/repo/pull/9", sessionIndex: 1, receivedAt: new Date().toISOString()});
  f.engine.github.pr = async (_slug, url) => openPr(Number(url.split("/").at(-1)));
  f.engine.queue("review", {type: "review", trackedId: f.ws.id, statusId: "cmd:reply:0", prompt: "Focus on authentication"});
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.sessions.length, 1, "several PRs must not start a review");
  assert.equal(f.store.row("review")!.state, "done");
  const card = JSON.parse(f.store.row("review:choose")!.payload);
  assert.equal(card.payload.text, "Which pull request should be reviewed?");
  const key = card.payload.reply_markup.inline_keyboard[0][0].callback_data;
  const otherKey = card.payload.reply_markup.inline_keyboard[1][0].callback_data;
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42", "9");
  for (const [id, data] of [[1, key], [2, key], [3, otherKey]] as const) {
    f.store.ingest([{update_id: id, callback_query: {id: `cb-${id}`, data, from: {id: 9}, message: {chat: {id: 42}}}}]);
    await processQueue(f.store, ["update"], r => commands.handle(r));
  }
  const actions = f.store.db.prepare("SELECT id,payload FROM gateway_queue WHERE kind='cloud' AND id LIKE '%confirmed:action'").all() as any[];
  assert.equal(actions.length, 1);
  assert.equal(JSON.parse(actions[0].payload).prompt, "https://github.com/org/repo/pull/8\n\nFocus on authentication");
}));

test("review choices preserve the selected thread and roll back if queueing fails", () => fixture(async f => {
  await f.launch();
  f.engine.queue("review", {type: "review", trackedId: f.ws.id, sessionId: "selected-thread"});
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  const card = JSON.parse(f.store.row("review:choose:0")!.payload);
  const key = card.payload.reply_markup.inline_keyboard[0][0].callback_data;
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42", "9");
  f.store.ingest([{update_id: 1, callback_query: {id: "cb", data: key, from: {id: 9}, message: {chat: {id: 42}}}}]);
  const originalQueue = f.engine.queue.bind(f.engine);
  f.engine.queue = () => { throw new Error("Queue unavailable"); };
  await assert.rejects(commands.handle(f.store.row("update:1")!), /Queue unavailable/);
  assert.equal(f.store.get("review-choice:review"), undefined);
  assert.equal(f.store.row("update:1:reply:0"), undefined);
  f.engine.queue = originalQueue;
  await commands.handle(f.store.row("update:1")!);
  const action = JSON.parse(f.store.row(`${key}:confirmed:action`)!.payload);
  assert.equal(action.sessionId, "selected-thread");
  assert.equal(action.prompt, "Use /review");
}));

for (const type of ["stop", "archive"] as const) {
  for (const missingAt of ["cancel", "status"] as const) {
    test(`${type} continues cancelling other sessions after a ${missingAt} 404`, () => fixture(async f => {
      await f.launch();
      f.sessions.push({id: "s2", name: "Second task"});
      const cancelled: string[] = []; let archived = 0;
      f.api.cancelSession = async id => {
        cancelled.push(id);
        if (id === "s1" && missingAt === "cancel") throw new ConductorApiError("Gone", 404);
        return {workspaceId: "w1", sessionId: id, status: "idle", canceledQueuedMessages: 0};
      };
      const getStatus = f.api.getSessionStatus;
      f.api.getSessionStatus = async id => {
        if (id === "s1" && missingAt === "status") throw new ConductorApiError("Gone", 404);
        return getStatus(id);
      };
      f.api.archiveWorkspace = async () => { archived++; return {workspaceId: "w1", status: "archived"}; };
      f.engine.queue("control", {type, trackedId: f.ws.id});
      await processQueue(f.store, ["cloud"], r => f.engine.action(r));
      assert.deepEqual(cancelled, ["s1", "s2"]);
      assert.equal(archived, type === "archive" ? 1 : 0);
      assert.equal(f.store.row("control")!.state, "done");
      assert.equal(f.store.get<any>("session:s1")?.terminal, true);
    }));
  }
}

for (const mode of ["explicit", "cached", "transcript"] as const) {
  for (const failure of [new GitHubError("Unavailable", 503), new GitHubError("Rate limited", 403, true), new TypeError("fetch failed")]) {
    test(`${mode} review retries ${failure.message} without claiming a PR is missing or choosing another`, () => fixture(async f => {
      await f.launch();
      if (mode === "cached") f.store.bind(f.ws.id, {...f.store.binding(f.ws.id)!, prUrl: openPr(8).url});
      if (mode === "transcript") f.messages.push({id: "prs", sessionId: "s1", type: "assistant", content: `${openPr(9).url} ${openPr(8).url}`});
      let unavailable = true;
      f.engine.github.pr = async (_slug, url) => {
        if (url === openPr(8).url && unavailable) throw failure;
        return openPr(Number(url.split("/").at(-1)));
      };
      f.engine.queue("review", {type: "review", trackedId: f.ws.id, prompt: mode === "explicit" ? "8" : undefined});
      await processQueue(f.store, ["cloud"], r => f.engine.action(r));
      assert.equal(f.store.row("review")!.state, "pending");
      assert.equal(f.sessions.length, 1);
      assert.equal(f.store.row("review:choose:0"), undefined);
      if (mode !== "explicit") assert.equal(f.store.get("review-pr:review"), undefined);
      unavailable = false;
      f.store.retry("review", "Retry now", 0);
      await processQueue(f.store, ["cloud"], r => f.engine.action(r));
      assert.equal(f.store.row("review")!.state, "done");
      if (mode === "transcript") {
        assert.equal(f.sessions.length, 1);
        assert.match(JSON.parse(f.store.row("review:choose:0")!.payload).payload.text, /Which pull request/);
      } else assert.equal(f.store.get<any>("session:s2")?.reviewUrl, openPr(8).url);
    }));
  }
}

test("ping survives a malformed repository access cache entry", () => fixture(async f => {
  f.store.db.prepare("INSERT INTO gateway_state VALUES (?,?)").run("github-access:org/repo", "broken json");
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42", "9");
  f.store.ingest([{update_id: 1, message: {message_id: 1, from: {id: 9}, chat: {id: 42}, text: "/ping"}}]);
  await processQueue(f.store, ["health-update"], row => commands.handle(row));
  assert.equal(f.store.row("update:1")!.state, "done");
  assert.match(JSON.parse(f.store.row("update:1:reply:0")!.payload).payload.text, /Gateway online/);
}));

test("ping reports only repository denials still within the access-cache lifetime", () => fixture(async f => {
  f.store.set("github-access:org/fresh", {ok: false, status: 404, at: Date.now()});
  f.store.set("github-access:org/expired", {ok: false, status: 404, at: Date.now() - 300_001});
  f.engine.github.access = async () => { throw new Error("Ping must not make GitHub requests"); };
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42", "9");
  f.store.ingest([{update_id: 1, message: {message_id: 1, from: {id: 9}, chat: {id: 42}, text: "/ping"}}]);
  await processQueue(f.store, ["health-update"], row => commands.handle(row));
  const text = JSON.parse(f.store.row("update:1:reply:0")!.payload).payload.text;
  assert.match(text, /cannot read: org\/fresh/);
  assert.doesNotMatch(text, /org\/expired/);
}));

test("no open PR ends the review row at once with buttons", () => fixture(async f => {
  await f.launch();
  enqueueText(f.store, "cmd:reply", "42", "Queued for Conductor.", {silent: true});
  f.engine.github.find = async () => null;
  f.engine.queue("review", {type: "review", trackedId: f.ws.id, statusId: "cmd:reply:0"});
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.store.row("review")!.state, "done");
  assert.equal(f.sessions.length, 1);
  const card = JSON.parse(f.store.row("review:choose")!.payload);
  assert.equal(card.payload.text, "No open pull request found for this workspace.");
  assert.deepEqual(card.payload.reply_markup.inline_keyboard.map((row: any) => row[0].text),
    ["Ask the agent to review its own diff", "Open a PR first"]);
}));

test("a merged cached PR does not dead-end a bare /review", () => fixture(async f => {
  await f.launch();
  f.store.bind(f.ws.id, {...f.store.binding(f.ws.id)!, prUrl: "https://github.com/org/repo/pull/1"});
  enqueueText(f.store, "cmd:reply", "42", "Queued for Conductor.", {silent: true});
  f.messages.push({id: "pr", sessionId: "s1", type: "assistant", content: "https://github.com/org/repo/pull/9", sessionIndex: 1, receivedAt: new Date().toISOString()});
  f.engine.github.pr = async (_slug, url) => url.endsWith("/1")
    ? {...openPr(1), state: "closed", merged: true}
    : openPr(9);
  f.engine.queue("review", {type: "review", trackedId: f.ws.id, statusId: "cmd:reply:0"});
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.store.get<any>("session:s2")?.reviewUrl, "https://github.com/org/repo/pull/9");
}));

test("an unreadable repository short-circuits /review before any Conductor call", () => fixture(async f => {
  await f.launch();
  f.store.bind(f.ws.id, {...f.store.binding(f.ws.id)!, synced: true});
  let conductor = 0;
  f.api.getSession = async () => { conductor++; throw new Error("GitHub denial must precede author lookup"); };
  const list = f.api.listWorkspaceSessions;
  f.api.listWorkspaceSessions = async () => { conductor++; return list(); };
  f.api.getSessionMessageTail = async () => { conductor++; return []; };
  f.engine.github.access = async () => ({readable: false, status: 404});
  enqueueText(f.store, "cmd:reply", "42", "Queued for Conductor.", {silent: true});
  f.engine.queue("review", {type: "review", trackedId: f.ws.id, statusId: "cmd:reply:0"});
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(conductor, 0);
  assert.equal(f.store.row("review")!.state, "done");
  assert.match(JSON.parse(f.store.row("review:choose")!.payload).payload.text, /cannot read org\/repo/);
  assert.equal(JSON.parse(f.store.row("review:choose")!.payload).payload.reply_markup.inline_keyboard.length, 1);
}));

test("a rate-limited 403 is never cached as unreadable", () => fixture(async f => {
  f.engine.github.access = async () => { throw new GitHubError("GitHub request failed (403)", 403, true); };
  await assert.rejects(() => f.engine.repoAccess("org/repo", true), /403/);
  assert.equal(f.engine.githubDenied("org/repo"), undefined);
  assert.equal(f.store.get("github-access:org/repo"), undefined);
}));

test("a Conductor rejection of a send clears the fence", () => fixture(async f => {
  await f.launch();
  f.api.sendMessage = async () => { throw new ConductorApiError("payload too large", 413); };
  f.engine.queue("follow", {type: "send", trackedId: f.ws.id, prompt: "next"});
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.store.row("follow")!.state, "blocked");
  assert.match(f.store.row("follow")!.error!, /refused this message: payload too large/);
  assert.equal(f.store.get("send-attempted:follow"), false);
}));

test("/land runs the land-and-deploy skill in the topic's workspace", () => fixture(async f => {
  f.store.db.prepare("UPDATE workspaces SET telegram_chat_id='-42' WHERE id=?").run(f.ws.id);
  updateWorkspaceThreadId(f.ws.id, 9);
  await f.launch();
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "-42", "9");
  for (const [i, text] of ["/land", "/land after the canary"].entries()) {
    const id = i + 1;
    f.store.ingest([{update_id: id, message: {message_id: 200 + id, chat: {id: -42}, from: {id: 9}, message_thread_id: 9, text}}]);
    await processQueue(f.store, ["update"], row => commands.handle(row));
    const action = JSON.parse(f.store.row(`update:${id}:action`)!.payload);
    assert.equal(action.type, "send", text);
    assert.equal(action.trackedId, f.ws.id, text);
    // The alias resolves to the skill's real name, not to a /land nobody ships.
    assert.match(action.prompt, /^Use \/land-and-deploy/, text);
  }
  assert.match(JSON.parse(f.store.row("update:2:action")!.payload).prompt, /after the canary/);
}));

test("a workspace living in a repo topic never renames it", () => fixture(async f => {
  (f.api as any).renameWorkspace = async () => ({});
  const commands = repoTopic(f, "repo");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "first task"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const trackedId = JSON.parse(f.store.row("update:1:action")!.payload).trackedId;
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  f.store.ingest([{update_id: 2, message: {message_id: 102, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "/rename Broken Link Review"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(getWorkspace(trackedId)?.name, "Broken Link Review");
  // The topic is named for its repository; renaming the workspace must not rewrite it.
  const renames = (f.store.db.prepare("SELECT payload FROM gateway_queue WHERE kind='telegram'").all() as any[])
    .map(row => JSON.parse(row.payload)).filter(job => job.method === "editForumTopic");
  assert.deepEqual(renames, []);
}));
