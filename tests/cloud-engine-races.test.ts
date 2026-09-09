import test from "node:test";
import assert from "node:assert/strict";
import {getDb, closeDb} from "../src/store/db.js";
import {createWorkspace, getWorkspace} from "../src/store/queries.js";
import {GatewayStore, type CloudBinding} from "../src/cloud/store.js";
import {CloudEngine, DEFAULT_PROVIDERS, transcriptText, type Provider} from "../src/cloud/engine.js";
import {CloudGitHub} from "../src/cloud/catalog.js";
import type {FileBridge} from "../src/cloud/bridge.js";
import {ConductorApiError, type ConductorApiClient, type ConductorApiMessage} from "../src/integrations/conductor-api.js";

function fixture(providers: Provider[] = DEFAULT_PROVIDERS, reviewProvider: {agent?: Provider["agent"]; model?: string} = {}) {
  closeDb();
  const store = new GatewayStore(getDb(":memory:"));
  const ws = createWorkspace({name: "task", prompt: "Original task", repoPath: "conductor-project:p1", telegramChatId: "42"});
  const binding: CloudBinding = {workspaceId: "w1", projectId: "p1", repoUrl: "https://github.com/org/repo", repoSlug: "org/repo", branch: "task", prUrl: "https://github.com/org/repo/pull/1", sessionId: "s1", ...DEFAULT_PROVIDERS[0], stopped: false};
  store.bind(ws.id, binding);
  store.set("session:s1", {trackedId: ws.id, ...DEFAULT_PROVIDERS[0], role: "task", sentMessageId: "old", sentAt: 1, episode: "old", seenReply: false, terminal: false});
  const mutations: string[] = [];
  const api = {
    getWorkspaceStatus: async () => ({workspaceId: "w1", status: "ready"}),
    listWorkspaceSessions: async () => [{id: "s1", name: "Task"}],
    getSessionStatus: async (_id: string) => ({workspaceId: "w1", status: "idle"}),
    listSessionMessages: async (_input: unknown) => [{id: "reply", sessionId: "s1", type: "assistant", content: "Original turn finished", sessionIndex: 1, receivedAt: "2026-01-01T00:00:00Z"}],
    getMessage: async (_id: string) => {throw new ConductorApiError("Not found", 404);},
    sendMessage: async (_input: unknown) => {mutations.push("send"); return {};},
    cancelSession: async (_id: string) => {mutations.push("cancel"); return {};},
    createSession: async (_input: unknown) => {mutations.push("create-session"); return {id: "s2"};},
  };
  const github = new CloudGitHub("unused");
  github.pr = async () => ({url: binding.prUrl!, number: 1, head: "a".repeat(40), base: "b".repeat(40), branch: "task", state: "open", merged: false, draft: false});
  const bridge = {refreshQueuedLinks() {}} as unknown as FileBridge;
  const engine = new CloudEngine(store, api as unknown as ConductorApiClient, bridge, github, providers, true, reviewProvider);
  async function send() {
    engine.queue("followup", {type: "send", trackedId: ws.id, prompt: "New task"});
    await engine.action(store.row("followup")!);
  }
  return {store, ws, binding, api, github, engine, mutations, send};
}

test("a stop confirmed while message reconciliation waits prevents a later send", async () => {
  const f = fixture();
  try {
    f.api.getMessage = async () => {
      f.engine.queue("stop", {type: "stop", trackedId: f.ws.id});
      await f.engine.action(f.store.row("stop")!);
      throw new ConductorApiError("Not found", 404);
    };
    await f.send();
    assert.ok(f.mutations.includes("cancel"));
    assert.ok(!f.mutations.includes("send"), "No new task may start after cancellation was confirmed");
  } finally {closeDb();}
});

test("polling preserves a follow-up turn committed while its status read waits", async () => {
  const f = fixture();
  try {
    const original = f.api.getSessionStatus;
    let injected = false;
    f.api.getSessionStatus = async id => {
      if (!injected) {injected = true; await f.send();}
      return original(id);
    };
    await f.engine.pollWorkspace(f.ws.id, f.binding);
    const current = f.store.get<any>("session:s1");
    assert.equal(current.episode, "followup");
    assert.equal(current.taskPrompt, "New task");
    assert.equal(current.terminal, false);
    assert.equal(getWorkspace(f.ws.id)?.status, "running");
  } finally {closeDb();}
});

test("review completion cannot overwrite a new turn while GitHub verification waits", async () => {
  const f = fixture();
  try {
    f.store.set("session:s1", {...f.store.get<any>("session:s1"), role: "review", reviewUrl: f.binding.prUrl, reviewHead: "a".repeat(40), reviewBase: "b".repeat(40)});
    const original = f.github.pr.bind(f.github);
    f.github.pr = async (...args) => {await f.send(); return original(...args);};
    await f.engine.pollWorkspace(f.ws.id, f.binding);
    assert.equal(f.store.get<any>("session:s1").episode, "followup");
    assert.equal(f.store.get<any>("session:s1").terminal, false);
  } finally {closeDb();}
});

test("stop during review lookup prevents a new review session", async () => {
  const f = fixture();
  try {
    const original = f.github.pr.bind(f.github);
    f.github.pr = async (...args) => {f.engine.queue("stop", {type: "stop", trackedId: f.ws.id}); return original(...args);};
    f.engine.queue("review", {type: "review", trackedId: f.ws.id});
    await f.engine.action(f.store.row("review")!);
    assert.ok(!f.mutations.includes("create-session"));
    assert.equal(f.store.binding(f.ws.id)?.stopped, true);
  } finally {closeDb();}
});

test("native review requires an enabled provider different from the author", async () => {
  const f = fixture([DEFAULT_PROVIDERS[0]]);
  try {
    f.engine.queue("review", {type: "review", trackedId: f.ws.id});
    await assert.rejects(f.engine.action(f.store.row("review")!), /eligible.*review|review.*provider/i);
    assert.ok(!f.mutations.includes("create-session"));
  } finally {closeDb();}
});

test("configured review agent and model select the native review session", async () => {
  const f = fixture(DEFAULT_PROVIDERS, {agent: "cursor", model: "configured-review-model"});
  try {
    let created: any;
    f.api.createSession = async input => {created = input; return {id: "s2"};};
    f.engine.queue("review", {type: "review", trackedId: f.ws.id});
    await f.engine.action(f.store.row("review")!);
    assert.equal(created.agent, "cursor");
    assert.equal(created.model, "configured-review-model");
    assert.equal(f.store.binding(f.ws.id)?.sessionId, "s1");
  } finally {closeDb();}
});

test("a configured reviewer cannot override the different-author requirement", async () => {
  const f = fixture(DEFAULT_PROVIDERS, {agent: "claude", model: "other-model"});
  try {
    f.engine.queue("review", {type: "review", trackedId: f.ws.id});
    await assert.rejects(f.engine.action(f.store.row("review")!), /eligible.*review|review.*provider/i);
    assert.ok(!f.mutations.includes("create-session"));
  } finally {closeDb();}
});

test("raw assistant JSON survives transcript extraction while tool and reasoning envelopes stay hidden", () => {
  const extract = (content: string) => transcriptText({type: "assistant", content} as ConductorApiMessage);
  const raw = '{"action":"new","projectId":"p1","prompt":"Keep the task"}';
  assert.equal(extract(raw), raw);
  assert.equal(extract('[1,{"answer":42}]'), '[1,{"answer":42}]');
  assert.equal(extract('{"message":{"content":[{"type":"text","text":"Visible"}]}}'), "Visible");
  for (const type of ["tool_use", "tool_result", "thinking", "reasoning"]) {
    assert.equal(extract(JSON.stringify({type, text: "Hidden private content"})), "");
    assert.equal(extract(JSON.stringify([{type, text: "Hidden private content"}, {metadata: true}])), "");
  }
});

test("a stop during reported PR lookup remains stopped after polling finishes", async () => {
  const f = fixture();
  try {
    const messages = f.api.listSessionMessages;
    f.api.listSessionMessages = async input => (await messages(input)).map(m => ({...m, content: f.binding.prUrl!}));
    const original = f.github.pr.bind(f.github);
    f.github.pr = async (...args) => {
      f.engine.queue("stop", {type: "stop", trackedId: f.ws.id});
      await f.engine.action(f.store.row("stop")!);
      return original(...args);
    };
    await f.engine.pollWorkspace(f.ws.id, f.binding);
    assert.equal(getWorkspace(f.ws.id)?.status, "stopped");
    assert.ok(f.store.get<number>(`poll-after:${f.ws.id}`)! > Date.now() + 50_000);
  } finally {closeDb();}
});

test("a new session during reported PR lookup keeps the workspace running and promptly polled", async () => {
  const f = fixture();
  try {
    const messages = f.api.listSessionMessages;
    f.api.listSessionMessages = async input => (await messages(input)).map(m => ({...m, content: f.binding.prUrl!}));
    const original = f.github.pr.bind(f.github);
    f.github.pr = async (...args) => {
      f.engine.queue("new-thread", {type: "thread", trackedId: f.ws.id, prompt: "Another unfinished task"});
      await f.engine.action(f.store.row("new-thread")!);
      return original(...args);
    };
    await f.engine.pollWorkspace(f.ws.id, f.binding);
    assert.equal(f.store.get<any>("session:s2").terminal, false);
    assert.equal(getWorkspace(f.ws.id)?.status, "running");
    assert.ok(f.store.get<number>(`poll-after:${f.ws.id}`)! <= Date.now() + 15_000);
  } finally {closeDb();}
});
