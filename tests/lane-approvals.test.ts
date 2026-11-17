import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APPROVAL_TEXT,
  LaneApprovals,
  MAX_WAITING_CONTROLS,
  approvalMessageFrom,
  isWithheldApprovalMessage,
  loggableMessagePreview,
  setLaneApprovals,
  takeWithheldApprovalText,
  telegrafApprovalChat,
  withholdApprovalText,
  type ApprovalChat,
  type HumanLaneControl,
} from "../src/bot/lane-approvals.js";
import { handleDurableLanes } from "../src/bot/durable-lanes-command.js";
import { registerCommands } from "../src/bot/commands.js";
import {
  FRESH_APPROVAL_REQUIRED,
  LaneStateStoreError,
  type LaneHumanApproval,
  type LaneStateStore,
} from "../src/lanes/state-store.js";
import { getDb, closeDb } from "../src/store/db.js";
import { GatewayStore } from "../src/cloud/store.js";
import { CloudCommands } from "../src/cloud/commands.js";
import { processQueue } from "../src/cloud/telegram.js";
import type { CloudEngine } from "../src/cloud/engine.js";

const OWNER = "6262626262";
const BOT = 4242;
const KEY = "c".repeat(48);
const GRANT = "G".repeat(43);
const START = Date.parse("2026-11-17T12:00:00.000Z");
const PROMPT = "Approval code sent to j***@belong.net. Reply to this message with the 6-digit code within 10 minutes.";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** A Command Center that answers the approval channel routes and records what it was sent. */
function harness(envOverrides: Record<string, string | undefined> = {}) {
  let clock = START;
  const cc = {
    sends: [] as Array<{ body: Record<string, unknown>; headers: Headers }>,
    verifies: [] as Array<Record<string, unknown>>,
    sendResponses: [] as Response[],
    verifyResponses: [] as Response[],
  };
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (String(url).endsWith("/api/operator/otp/channel/send")) {
      cc.sends.push({ body, headers: new Headers(init.headers) });
      return cc.sendResponses.shift() ?? json({ challenge_id: `ch_${cc.sends.length}`, expires_in: 600, email_hint: "j***@belong.net" });
    }
    if (String(url).endsWith("/api/operator/otp/channel/verify")) {
      cc.verifies.push(body);
      return (
        cc.verifyResponses.shift() ??
        json({
          grant: GRANT,
          expires_in: 1800,
          expires_at: new Date(clock + 1800_000).toISOString(),
          channel: "conductor-lanes",
          subject: cc.sends.at(-1)?.body.subject,
        })
      );
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const env: Record<string, string | undefined> = {
    OWNER_CHAT_ID: OWNER,
    COMMAND_CENTER_API_BASE_URL: "http://command-center.test:8080",
    COMMAND_CENTER_API_KEY: "s".repeat(48),
    BELONG_APPROVAL_CHANNEL_KEY: KEY,
    ...envOverrides,
  };
  const sleeps: number[] = [];
  const approvals = new LaneApprovals({
    env: () => env as NodeJS.ProcessEnv,
    fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { approvals, cc, env, sleeps, fetchImpl, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

type FakeChat = ApprovalChat & { replies: string[]; prompts: string[]; deletes: number[]; failDeletes: number; promptIds: number[] };

function chat(overrides: Partial<ApprovalChat> = {}): FakeChat {
  let nextId = 500;
  const fake: FakeChat = {
    chatId: OWNER,
    userId: OWNER,
    replies: [],
    prompts: [],
    deletes: [],
    promptIds: [],
    failDeletes: 0,
    reply: async (text) => {
      fake.replies.push(text);
    },
    prompt: async (text) => {
      fake.prompts.push(text);
      fake.promptIds.push(++nextId);
      return nextId;
    },
    deleteMessage: async (id) => {
      fake.deletes.push(id);
      if (fake.failDeletes > 0) {
        fake.failDeletes--;
        throw new Error("Bad Request: message can't be deleted");
      }
    },
    ...overrides,
  };
  return fake;
}

function control(label = "cutover growth-v2-abc") {
  const submissions: LaneHumanApproval[] = [];
  const failures: unknown[] = [];
  const value: HumanLaneControl & { submissions: LaneHumanApproval[]; failNext(error: unknown): void } = {
    label,
    submissions,
    failNext(error: unknown) {
      failures.push(error);
    },
    submit: async (approval) => {
      submissions.push(approval);
      const failure = failures.shift();
      if (failure) throw failure;
      return `Lane control queued: ${label}. The lease holder will apply it.`;
    },
  };
  return value;
}

let messageIds = 1000;
/** A Telegram text message as the owner (or someone else) sends it, optionally replying to a prompt. */
function message(text: string, replyTo?: { id: number; prompt?: boolean }, from = OWNER) {
  return {
    raw: {
      message_id: ++messageIds,
      chat: { id: Number(OWNER), type: "private" },
      from: { id: Number(from), is_bot: false },
      text,
      ...(replyTo
        ? { reply_to_message: { message_id: replyTo.id, from: { id: BOT, is_bot: true }, text: replyTo.prompt === false ? "Something else" : PROMPT } }
        : {}),
    },
    get view() {
      return approvalMessageFrom(this.raw, BOT)!;
    },
  };
}

const fresh = () => new LaneStateStoreError(`Command Center lane request rejected: ${FRESH_APPROVAL_REQUIRED}`, 401, { detail: FRESH_APPROVAL_REQUIRED });

test("only the owner, from the owner chat, can start an approval", async () => {
  const h = harness();
  const stranger = chat({ userId: "777" });
  await h.approvals.submit(stranger, control());
  assert.deepEqual(stranger.replies, [APPROVAL_TEXT.ownerOnly]);
  const group = chat({ chatId: "-1001234" });
  await h.approvals.submit(group, control());
  assert.deepEqual(group.replies, [APPROVAL_TEXT.ownerChatOnly]);
  assert.equal(h.cc.sends.length, 0, "no code was requested");

  const groupWithoutOwner = harness({ OWNER_CHAT_ID: "-1001234" });
  const groupChat = chat({ chatId: "-1001234" });
  await groupWithoutOwner.approvals.submit(groupChat, control());
  assert.deepEqual(groupChat.replies, [APPROVAL_TEXT.needsOwner]);

  const unkeyed = harness({ BELONG_APPROVAL_CHANNEL_KEY: undefined, BELONG_HUMAN_APPROVAL_KEY: "h".repeat(48) });
  const owner = chat();
  await unkeyed.approvals.submit(owner, control());
  assert.equal(owner.replies.length, 1);
  assert.match(owner.replies[0], /^Lane approvals are not set up: set BELONG_APPROVAL_CHANNEL_KEY and COMMAND_CENTER_API_BASE_URL\. Nothing was applied\.$/);
  assert.equal(unkeyed.cc.sends.length, 0, "the retired key is never used");
});

test("a control waits for the owner's six-digit reply to the prompt, then runs once", async () => {
  const h = harness();
  const owner = chat();
  const cutover = control();
  await h.approvals.submit(owner, cutover);
  assert.equal(h.cc.sends.length, 1);
  assert.deepEqual(h.cc.sends[0].body, { channel: "conductor-lanes", subject: `telegram:${OWNER}` });
  assert.equal(h.cc.sends[0].headers.get("x-belong-approval-channel-key"), KEY);
  assert.deepEqual(owner.prompts, [PROMPT]);
  assert.deepEqual(owner.replies, [], "the prompt is the whole answer");
  assert.equal(cutover.submissions.length, 0, "nothing runs before the code");
  const prompt = owner.promptIds[0];

  // Someone else's reply, even with digits, is dropped unread.
  const stranger = chat({ userId: "777" });
  assert.equal(await h.approvals.handleReply(stranger, message("123456", { id: prompt }, "777").view), true);
  assert.deepEqual(stranger.replies, []);
  assert.deepEqual(stranger.deletes, []);

  // A code typed without replying to the prompt is not used, and is removed.
  const bare = message("123456");
  assert.equal(await h.approvals.handleReply(owner, bare.view), true);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.bareCode);
  assert.equal(owner.deletes.at(-1), bare.raw.message_id);

  for (const wrongShape of ["12345", "1234567", "12 3456", "code 123456", "１２３４５６"]) {
    const attempt = message(wrongShape, { id: prompt });
    assert.equal(await h.approvals.handleReply(owner, attempt.view), true, wrongShape);
    assert.equal(owner.replies.at(-1), APPROVAL_TEXT.digitsOnly, wrongShape);
    assert.equal(owner.deletes.at(-1), attempt.raw.message_id, `${wrongShape} may hold the code, so it is removed`);
  }
  assert.equal(h.cc.verifies.length, 0, "only exactly six digits are relayed");
  const words = message("thanks", { id: prompt });
  const deletesBefore = owner.deletes.length;
  assert.equal(await h.approvals.handleReply(owner, words.view), true);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.digitsOnly);
  assert.equal(owner.deletes.length, deletesBefore, "a reply with no digit at all holds no code and stays");

  // Ordinary conversation and commands are not the flow's.
  assert.equal(await h.approvals.handleReply(owner, message("hello").view), false);
  assert.equal(await h.approvals.handleReply(owner, message("thanks", { id: 42, prompt: false }).view), false);
  assert.equal(await h.approvals.handleReply(owner, message("/lanes status", { id: prompt }).view), false);

  const code = message(" 042317 ", { id: prompt });
  assert.equal(await h.approvals.handleReply(owner, code.view), true);
  assert.deepEqual(h.cc.verifies, [{ challenge_id: "ch_1", code: "042317" }]);
  assert.equal(owner.deletes.at(-1), code.raw.message_id);
  assert.deepEqual(owner.replies.slice(-2), [
    "Code accepted. Approvals open until 12:30 UTC.",
    "Lane control queued: cutover growth-v2-abc. The lease holder will apply it.",
  ]);
  assert.deepEqual(cutover.submissions, [{ channelKey: KEY, grant: GRANT }]);

  // A second code for an approval already granted is acknowledged, never verified or applied again.
  const again = message("042317", { id: prompt });
  assert.equal(await h.approvals.handleReply(owner, again.view), true);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.alreadyOpen("12:30"));
  assert.equal(owner.deletes.at(-1), again.raw.message_id);
  assert.equal(h.cc.verifies.length, 1);
  assert.equal(cutover.submissions.length, 1, "the queued control was applied once");
  for (const reply of owner.replies) assert.doesNotMatch(reply, /042317|G{20}/, "no code or grant is ever echoed");
});

test("controls inside a live grant run directly; an expired grant asks again", async () => {
  const h = harness();
  const owner = chat();
  await h.approvals.submit(owner, control("rollback"));
  await h.approvals.handleReply(owner, message("111111", { id: owner.promptIds[0] }).view);
  const archive = control("archive_approval");
  await h.approvals.submit(owner, archive);
  assert.equal(h.cc.sends.length, 1, "no second code inside the grant");
  assert.deepEqual(archive.submissions, [{ channelKey: KEY, grant: GRANT }]);
  assert.equal(owner.replies.at(-1), "Lane control queued: archive_approval. The lease holder will apply it.");

  h.advance(30 * 60_000);
  const late = control("lane_release L1");
  await h.approvals.submit(owner, late);
  assert.equal(h.cc.sends.length, 2, "the grant ended, so a new code is asked for");
  assert.equal(late.submissions.length, 0);
  assert.equal(owner.prompts.length, 2);
});

test("Command Center's fresh-code refusal drops the grant and restarts the flow, without looping", async () => {
  const h = harness();
  const owner = chat();
  await h.approvals.submit(owner, control("rollback"));
  await h.approvals.handleReply(owner, message("111111", { id: owner.promptIds[0] }).view);

  const cutover = control();
  cutover.failNext(fresh());
  await h.approvals.submit(owner, cutover);
  assert.equal(cutover.submissions.length, 1, "tried once with the cached grant");
  assert.equal(h.cc.sends.length, 2, "then a fresh code was requested");
  assert.equal(owner.prompts.at(-1), PROMPT);
  await h.approvals.handleReply(owner, message("222222", { id: owner.promptIds.at(-1)! }).view);
  assert.deepEqual(h.cc.verifies.at(-1), { challenge_id: "ch_2", code: "222222" });
  assert.equal(cutover.submissions.length, 2);
  assert.equal(
    owner.replies.filter((reply) => reply.startsWith("Lane control queued: cutover")).length,
    1,
    "applied once"
  );

  // A grant refused right after it was verified is reported, not asked for again.
  h.advance(31 * 60_000);
  const validate = control("lane_validate L2");
  validate.failNext(fresh());
  await h.approvals.submit(owner, validate);
  const sends = h.cc.sends.length;
  await h.approvals.handleReply(owner, message("333333", { id: owner.promptIds.at(-1)! }).view);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.freshRefused(1));
  assert.equal(h.cc.sends.length, sends, "no new code after a fresh grant was refused");
  assert.equal(validate.submissions.length, 1);
});

test("controls wait behind one code, up to a bound, and each runs once in order", async () => {
  const h = harness();
  const owner = chat();
  const order: string[] = [];
  const controls = Array.from({ length: MAX_WAITING_CONTROLS + 1 }, (_, index) => {
    const item = control(`lane_release L${index + 1}`);
    const submit = item.submit;
    item.submit = async (approval) => {
      order.push(item.label);
      return submit(approval);
    };
    return item;
  });
  await h.approvals.submit(owner, controls[0]);
  for (const item of controls.slice(1, MAX_WAITING_CONTROLS)) await h.approvals.submit(owner, item);
  assert.deepEqual(owner.replies, Array(MAX_WAITING_CONTROLS - 1).fill(APPROVAL_TEXT.waiting));
  await h.approvals.submit(owner, controls[MAX_WAITING_CONTROLS]);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.queueFull);
  assert.equal(h.cc.sends.length, 1, "one code covers every waiting control");

  await h.approvals.handleReply(owner, message("123456", { id: owner.promptIds[0] }).view);
  assert.deepEqual(order, controls.slice(0, MAX_WAITING_CONTROLS).map((item) => item.label));
  assert.equal(controls[MAX_WAITING_CONTROLS].submissions.length, 0, "the refused control never runs");
  await h.approvals.handleReply(owner, message("123456", { id: owner.promptIds[0] }).view);
  assert.equal(order.length, MAX_WAITING_CONTROLS, "a repeated code applies nothing twice");
});

test("verification refusals answer with fixed wording and keep or end the wait by reason", async () => {
  const cases: Array<[Response, string, boolean]> = [
    [json({ detail: "x", reason: "invalid" }, 401), APPROVAL_TEXT.invalid, true],
    [json({ detail: "x", reason: "expired" }, 401), APPROVAL_TEXT.expired, false],
    [json({ detail: "x", reason: "attempts" }, 401), APPROVAL_TEXT.attempts, false],
    [json({ detail: "x", reason: "wait", retry_after: 90 }, 429), "Too many tries right now. Wait 2 minutes, then reply to the approval prompt with the code again.", true],
    [json({ detail: "down" }, 503), APPROVAL_TEXT.verifyUnavailable, true],
    [json({ detail: "bad channel key" }, 401), APPROVAL_TEXT.keyRefused, true],
  ];
  for (const [response, wording, stillWaiting] of cases) {
    const h = harness();
    const owner = chat();
    const cutover = control();
    await h.approvals.submit(owner, cutover);
    h.cc.verifyResponses.push(response);
    const code = message("123456", { id: owner.promptIds[0] });
    await h.approvals.handleReply(owner, code.view);
    assert.equal(owner.replies.at(-1), wording);
    assert.equal(owner.deletes.at(-1), code.raw.message_id, "a refused code is removed too");
    assert.equal(cutover.submissions.length, 0, wording);
    await h.approvals.handleReply(owner, message("654321", { id: owner.promptIds[0] }).view);
    if (stillWaiting) {
      assert.equal(cutover.submissions.length, 1, `${wording} keeps the wait open`);
    } else {
      assert.equal(owner.replies.at(-1), APPROVAL_TEXT.stale, `${wording} ends the wait`);
      assert.equal(cutover.submissions.length, 0);
    }
  }
});

test("code requests that are refused say why, with fixed wording", async () => {
  const cases: Array<[Response | "prompt-fails", string]> = [
    [json({ detail: "hold", reason: "wait", retry_after: 125 }, 429), "Too many approval codes were requested. Try again in 3 minutes. Nothing was applied."],
    [json({ detail: "hold", reason: "wait" }, 429), "Too many approval codes were requested. Try again later. Nothing was applied."],
    [json({ detail: "paused", reason: "attempts" }, 429), APPROVAL_TEXT.sendAttempts],
    [json({ detail: "bad key" }, 401), APPROVAL_TEXT.keyRefused],
    [json({ detail: "unconfigured" }, 503), APPROVAL_TEXT.sendUnavailable],
    ["prompt-fails", APPROVAL_TEXT.promptFailed],
  ];
  for (const [response, wording] of cases) {
    const h = harness();
    const owner = chat(
      response === "prompt-fails"
        ? {
            prompt: async () => {
              throw new Error("Too Many Requests");
            },
          }
        : {}
    );
    if (response !== "prompt-fails") h.cc.sendResponses.push(response);
    const cutover = control();
    await h.approvals.submit(owner, cutover);
    assert.deepEqual(owner.replies, [wording]);
    assert.equal(cutover.submissions.length, 0);
    // Nothing waits after a refusal, so a code reply finds no approval to complete.
    await h.approvals.handleReply(owner, message("123456", { id: 501 }).view);
    assert.equal(owner.replies.at(-1), APPROVAL_TEXT.stale);
    assert.equal(h.cc.verifies.length, 0);
  }
});

test("a code after the prompt expires is not verified, and expired waiting controls are reported", async () => {
  const h = harness();
  const owner = chat();
  const first = control("rollback");
  await h.approvals.submit(owner, first);
  h.advance(10 * 60_000 + 1);
  await h.approvals.handleReply(owner, message("123456", { id: owner.promptIds[0] }).view);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.expired);
  assert.equal(h.cc.verifies.length, 0);

  const second = control("cutover v2");
  await h.approvals.submit(owner, second);
  h.advance(11 * 60_000);
  const third = control("cutover v3");
  await h.approvals.submit(owner, third);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.expiredUnused(1));
  assert.equal(h.cc.sends.length, 3);
  await h.approvals.handleReply(owner, message("123456", { id: owner.promptIds.at(-1)! }).view);
  assert.equal(second.submissions.length, 0, "an expired wait never runs later");
  assert.equal(third.submissions.length, 1);
});

test("the code message is deleted with up to three tries", async () => {
  const h = harness();
  const owner = chat();
  await h.approvals.submit(owner, control());
  owner.failDeletes = 2;
  const code = message("123456", { id: owner.promptIds[0] });
  await h.approvals.handleReply(owner, code.view);
  assert.deepEqual(owner.deletes, [code.raw.message_id, code.raw.message_id, code.raw.message_id]);
  assert.deepEqual(h.sleeps, [500, 1000]);
  assert.ok(!owner.replies.includes(APPROVAL_TEXT.deleteFailed));

  const h2 = harness();
  const stubborn = chat();
  await h2.approvals.submit(stubborn, control());
  stubborn.failDeletes = 10;
  await h2.approvals.handleReply(stubborn, message("123456", { id: stubborn.promptIds[0] }).view);
  assert.equal(stubborn.deletes.length, 3, "best effort stops at three");
  assert.deepEqual(stubborn.replies, [
    "Code accepted. Approvals open until 12:30 UTC.",
    APPROVAL_TEXT.deleteFailed,
    "Lane control queued: cutover growth-v2-abc. The lease holder will apply it.",
  ]);
});

test("a reply to a prompt from before a restart is recognised and refused", async () => {
  const h = harness();
  const owner = chat();
  const old = message("123456", { id: 77 });
  assert.equal(await h.approvals.handleReply(owner, old.view), true, "recognised by the prompt itself");
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.stale);
  assert.equal(owner.deletes.at(-1), old.raw.message_id);
  assert.equal(h.cc.verifies.length, 0);
  assert.equal(await h.approvals.handleReply(owner, message("ok", { id: 77 }).view), true);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.stale);
  assert.deepEqual(owner.deletes, [old.raw.message_id], "only a message that could hold a code is deleted");
});

test("possible codes are withheld from durable storage and from the update log", () => {
  const h = harness();
  setLaneApprovals(h.approvals);
  try {
    const reply = message("042317", { id: 501 });
    const update = { update_id: 9, message: reply.raw };
    const stored = withholdApprovalText(update, BOT);
    assert.notEqual(stored, update);
    assert.doesNotMatch(JSON.stringify(stored), /042317/);
    assert.equal(isWithheldApprovalMessage(stored.message), true);
    assert.equal(update.message.text, "042317", "the live update is not mutated");
    assert.equal(takeWithheldApprovalText(OWNER, reply.raw.message_id), "042317");
    assert.equal(takeWithheldApprovalText(OWNER, reply.raw.message_id), undefined, "handed over once");

    const ordinary = { update_id: 10, message: message("deploy the fix").raw };
    assert.equal(withholdApprovalText(ordinary, BOT), ordinary);
    const command = { update_id: 11, message: message("/lanes status", { id: 501 }).raw };
    assert.equal(withholdApprovalText(command, BOT), command, "commands stay commands");
    const otherBot = { update_id: 12, message: { ...message("123456").raw, reply_to_message: { message_id: 3, from: { id: 1, is_bot: true }, text: PROMPT } } };
    assert.equal(withholdApprovalText(otherBot, BOT), otherBot, "another bot's look-alike is not ours");
  } finally {
    setLaneApprovals(undefined);
  }
  assert.equal(loggableMessagePreview({ text: "042317" }), "[text withheld]");
  assert.equal(loggableMessagePreview({ text: "my code 042317 thanks" }), "[text withheld]");
  assert.equal(loggableMessagePreview(message("abc", { id: 1 }).raw), "[text withheld]");
  assert.equal(loggableMessagePreview({ text: "PR 12345 merged" }), "PR 12345 merged");
  assert.equal(loggableMessagePreview({ photo: [{}] }), "[photo]");
});

test("the Telegram bot posts the prompt as a forced reply and intercepts the code before routing", async () => {
  const h = harness();
  setLaneApprovals(h.approvals);
  try {
    const created: Array<Record<string, unknown>> = [];
    const store = {
      createControl: async (input: Record<string, unknown>) => {
        created.push(input);
        return { kind: input.kind, lane_id: input.lane_id ?? null };
      },
      close: async () => undefined,
    } as unknown as LaneStateStore;
    const sent: Array<{ text: string; extra?: Record<string, any> }> = [];
    const deleted: Array<[string, number]> = [];
    const ctx = (msg: Record<string, unknown>) => ({
      chat: { id: Number(OWNER), type: "private" },
      from: { id: Number(OWNER), is_bot: false },
      message: msg,
      botInfo: { id: BOT },
      reply: async (text: string, extra?: Record<string, any>) => {
        sent.push({ text, extra });
        return { message_id: 900 + sent.length };
      },
      telegram: {
        deleteMessage: async (chatId: string, id: number) => {
          deleted.push([chatId, id]);
          return true;
        },
      },
    });
    await handleDurableLanes(ctx({ message_id: 10, text: "/lanes rollback" }) as never, "rollback", { openStore: async () => store });
    assert.equal(created.length, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, PROMPT);
    assert.deepEqual(sent[0].extra, {
      reply_parameters: { message_id: 10, allow_sending_without_reply: true },
      reply_markup: { force_reply: true, selective: true },
    });

    // The bot's own text handler hands the reply to the flow before decisions, topics or the router.
    const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
    registerCommands({
      start: () => undefined,
      command: () => undefined,
      action: () => undefined,
      on: (event: string, handler: (ctx: unknown) => Promise<void>) => {
        handlers[event] = handler;
      },
    } as never);
    await handlers.text(
      ctx({ message_id: 11, text: "042317", reply_to_message: { message_id: 901, from: { id: BOT, is_bot: true }, text: PROMPT } })
    );
    assert.deepEqual(h.cc.verifies, [{ challenge_id: "ch_1", code: "042317" }]);
    assert.deepEqual(deleted, [[OWNER, 11]]);
    assert.equal(created.length, 1);
    assert.equal(created[0].kind, "rollback");
    assert.deepEqual(created[0].approval, { channelKey: KEY, grant: GRANT });
    assert.equal(created[0].requested_by, `telegram:${OWNER}`);
    assert.deepEqual(sent.slice(1).map((entry) => entry.text), [
      "Code accepted. Approvals open until 12:30 UTC.",
      "Lane control queued: rollback. The lease holder will apply it.",
    ]);
  } finally {
    setLaneApprovals(undefined);
  }
});

test("telegrafApprovalChat deletes in the chat the message came from", async () => {
  const calls: unknown[] = [];
  const chatView = telegrafApprovalChat({
    chat: { id: -100555 },
    from: { id: 9 },
    message: { message_id: 3 },
    reply: async () => ({ message_id: 4 }),
    telegram: { deleteMessage: async (...args: unknown[]) => calls.push(args) },
  } as never);
  assert.equal(chatView.chatId, "-100555");
  assert.equal(chatView.userId, "9");
  assert.equal(await chatView.prompt("x"), 4);
  await chatView.deleteMessage(8);
  assert.deepEqual(calls, [["-100555", 8]]);
});

test("the cloud gateway never writes an approval code to its database", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-approval-"));
  const backend = process.env.LANES_STATE_BACKEND;
  process.env.LANES_STATE_BACKEND = "http";
  const h = harness({ OWNER_CHAT_ID: "42", OWNER_USER_ID: "9" });
  setLaneApprovals(h.approvals);
  closeDb();
  try {
    const store = new GatewayStore(getDb(path.join(dir, "state.db")));
    store.set("telegram-bot-id", BOT);
    const calls: Array<{ method: string; payload: Record<string, any> }> = [];
    const telegram = async (method: string, payload: Record<string, any>) => {
      calls.push({ method, payload });
      return method === "sendMessage" ? { message_id: 77 } : true;
    };
    const created: Array<Record<string, unknown>> = [];
    const commands = new CloudCommands(store, {} as CloudEngine, telegram, "42", "9");
    commands.openLaneStore = async () =>
      ({
        createControl: async (input: Record<string, unknown>) => {
          created.push(input);
          return { kind: input.kind, lane_id: null };
        },
        close: async () => undefined,
      }) as unknown as LaneStateStore;
    const handle = () => processQueue(store, ["update"], (row) => commands.handle(row));

    store.ingest([{ update_id: 1, message: { message_id: 10, chat: { id: 42, type: "private" }, from: { id: 9 }, date: 1, text: "/lanes cutover growth-v2-abc" } }]);
    await handle();
    assert.equal(h.cc.sends.length, 1);
    const prompt = calls.find((call) => call.method === "sendMessage")!;
    assert.equal(prompt.payload.text, PROMPT);
    assert.equal(prompt.payload.chat_id, "42");
    assert.deepEqual(prompt.payload.reply_parameters, { message_id: 10, allow_sending_without_reply: true });
    assert.deepEqual(prompt.payload.reply_markup, { force_reply: true, selective: true });
    assert.equal(created.length, 0);

    // A code typed without a reply while one is awaited is withheld and goes nowhere else.
    store.ingest([{ update_id: 2, message: { message_id: 11, chat: { id: 42, type: "private" }, from: { id: 9 }, date: 2, text: "555555" } }]);
    await handle();
    assert.equal(store.row("update:2:route"), undefined, "never offered to the router");
    assert.equal(store.row("update:2:action"), undefined);
    assert.match(JSON.parse(store.row("update:2:approval:0:0")!.payload).payload.text, /reply to the approval prompt/);

    store.ingest([{ update_id: 3, message: { message_id: 12, chat: { id: 42, type: "private" }, from: { id: 9 }, date: 3, text: "042317",
      reply_to_message: { message_id: 77, from: { id: BOT, is_bot: true }, text: PROMPT } } }]);
    assert.doesNotMatch(store.row("update:3")!.payload, /042317/, "the stored update has no code");
    await handle();
    assert.deepEqual(h.cc.verifies, [{ challenge_id: "ch_1", code: "042317" }]);
    assert.deepEqual(calls.filter((call) => call.method === "deleteMessage").map((call) => call.payload), [
      { chat_id: "42", message_id: 11 },
      { chat_id: "42", message_id: 12 },
    ]);
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].approval, { channelKey: KEY, grant: GRANT });
    const texts = (store.db.prepare("SELECT id,payload FROM gateway_queue WHERE id LIKE 'update:3:approval:%' ORDER BY id").all() as Array<{ payload: string }>)
      .map((row) => JSON.parse(row.payload).payload.text);
    assert.deepEqual(texts, [
      "Code accepted. Approvals open until 12:30 UTC.",
      "Lane control queued: cutover. The lease holder will apply it.",
    ]);
    const everything = JSON.stringify([
      store.db.prepare("SELECT * FROM gateway_queue").all(),
      store.db.prepare("SELECT * FROM gateway_state").all(),
    ]);
    assert.doesNotMatch(everything, /042317|555555/, "no code in any table");
    assert.ok(!everything.includes(GRANT) && !everything.includes(KEY), "no grant or key in any table");
  } finally {
    setLaneApprovals(undefined);
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    if (backend === undefined) delete process.env.LANES_STATE_BACKEND;
    else process.env.LANES_STATE_BACKEND = backend;
  }
});
