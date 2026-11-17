import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APPROVAL_TEXT,
  LaneApprovals,
  claimedForApproval,
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
  assert.equal(owner.deletes.length, deletesBefore + 1);
  assert.equal(owner.deletes.at(-1), words.raw.message_id, "any reply to the prompt is removed, whatever it holds");

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
  const ok = message("ok", { id: 77 });
  assert.equal(await h.approvals.handleReply(owner, ok.view), true);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.stale);
  assert.deepEqual(owner.deletes, [old.raw.message_id, ok.raw.message_id], "every reply to an approval prompt is removed");
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
    const otherBot = { update_id: 12, message: { ...message("sure").raw, reply_to_message: { message_id: 3, from: { id: 1, is_bot: true }, text: PROMPT } } };
    assert.equal(withholdApprovalText(otherBot, BOT), otherBot, "another bot's look-alike prompt is not ours");
    const sixAnywhere = { update_id: 13, message: { ...message("123456").raw, reply_to_message: { message_id: 3, from: { id: 1, is_bot: true }, text: PROMPT } } };
    assert.doesNotMatch(JSON.stringify(withholdApprovalText(sixAnywhere, BOT)), /123456/, "the owner's six digits are withheld wherever they reply");
  } finally {
    setLaneApprovals(undefined);
  }
  assert.equal(loggableMessagePreview({ text: "042317" }), "######");
  assert.equal(loggableMessagePreview({ text: "my code 04 23 17 thanks" }), "my code ## ## ## thanks");
  assert.equal(loggableMessagePreview({ text: `code ${String.fromCharCode(0x661, 0x662, 0x663)}` }), "code ###", "any script's digits");
  assert.equal(loggableMessagePreview(message("abc", { id: 1 }).raw), "[text withheld]");
  assert.equal(loggableMessagePreview({ photo: [{}], caption: "123456", reply_to_message: message("x", { id: 1 }).raw.reply_to_message }), "[text withheld]");
  assert.equal(loggableMessagePreview({ text: "deploy the fix" }), "deploy the fix");
  assert.equal(loggableMessagePreview({ photo: [{}] }), "[photo]");
});

test("captions, files and codes in other shapes never leave the approval flow", async () => {
  const h = harness();
  const owner = chat();
  const cutover = control();
  await h.approvals.submit(owner, cutover);
  const prompt = owner.promptIds[0];
  const photo = message("", { id: prompt });
  photo.raw = { ...photo.raw, text: undefined, photo: [{ file_id: "p" }], caption: "123456" } as never;
  assert.equal(await h.approvals.handleReply(owner, photo.view), true, "a captioned photo answering the prompt is the flow's");
  assert.equal(photo.view.media, true);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.digitsOnly);
  assert.equal(owner.deletes.at(-1), photo.raw.message_id);
  const file = message("", { id: prompt });
  file.raw = { ...file.raw, text: undefined, document: { file_id: "d" } } as never;
  assert.equal(await h.approvals.handleReply(owner, file.view), true);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.digitsOnly);
  assert.equal(owner.deletes.at(-1), file.raw.message_id);
  assert.equal(h.cc.verifies.length, 0, "no caption or file is ever relayed as a code");

  // While the code is awaited, anything with digits is held; a message that could hold six of them is removed too.
  const shaped = message("code: 123456");
  assert.equal(await h.approvals.handleReply(owner, shaped.view), true);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.bareCode);
  assert.equal(owner.deletes.at(-1), shaped.raw.message_id);
  const split = message("code: 123 456");
  assert.equal(await h.approvals.handleReply(owner, split.view), true, "held: it carries digits while a code is awaited");
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.heldWhileWaiting);
  assert.equal(owner.deletes.at(-1), split.raw.message_id, "six digits in all could be the code, so it is removed");
  const deletesBefore = owner.deletes.length;
  const ordinary = message("deploy v2 to staging");
  assert.equal(await h.approvals.handleReply(owner, ordinary.view), true, "held: it carries a digit");
  assert.equal(owner.deletes.length, deletesBefore);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.heldWhileWaiting);
  const screenshot = message("");
  screenshot.raw = { ...screenshot.raw, text: undefined, photo: [{ file_id: "s" }], caption: "screenshot 2" } as never;
  assert.equal(await h.approvals.handleReply(owner, screenshot.view), true);
  assert.equal(owner.deletes.length, deletesBefore, "too few digits to be the code, so they stay in the chat");
  assert.equal(await h.approvals.handleReply(owner, message("deploy now").view), false, "no digits, no hold");
  assert.equal(await h.approvals.handleReply(chat({ userId: "777" }), message("deploy v2", undefined, "777").view), false, "only the owner's digits");

  await h.approvals.handleReply(owner, message("042317", { id: prompt }).view);
  assert.equal(cutover.submissions.length, 1);
  assert.equal(await h.approvals.handleReply(owner, message("deploy v2 to staging").view), false, "nothing is awaited anymore");
});

test("six digits alone are never routed, even after a restart forgot the request", async () => {
  const h = harness();
  const owner = chat();
  const bare = message("123456");
  assert.equal(await h.approvals.handleReply(owner, bare.view), true);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.stale);
  assert.equal(owner.deletes.at(-1), bare.raw.message_id);
  const topic = message("654321");
  topic.raw = { ...topic.raw, message_thread_id: 7, is_topic_message: true, reply_to_message: { message_id: 7, forum_topic_created: { name: "repo" } } } as never;
  assert.equal(await h.approvals.handleReply(owner, topic.view), true, "a forum topic's opening message is not a reply");
  assert.equal(await h.approvals.handleReply(chat({ userId: "777" }), message("123456", undefined, "777").view), false, "only the owner's");
  const answer = message("123456", { id: 42, prompt: false });
  assert.equal(await h.approvals.handleReply(owner, answer.view), true, "six digits are claimed even as an answer to other work");
  assert.equal(owner.deletes.at(-1), answer.raw.message_id);
  assert.equal(await h.approvals.handleReply(owner, message("1234567").view), false, "seven digits are not a code's shape");
  const photo = message("");
  photo.raw = { ...photo.raw, text: undefined, photo: [{ file_id: "p" }], caption: "123456" } as never;
  assert.equal(await h.approvals.handleReply(owner, photo.view), true, "captions count as text");
  assert.equal(owner.deletes.at(-1), photo.raw.message_id);
  assert.equal(h.cc.verifies.length, 0);
});

test("a refused control is reported in fixed words, never Command Center's own", async () => {
  const h = harness();
  const owner = chat();
  await h.approvals.submit(owner, control("rollback"));
  await h.approvals.handleReply(owner, message("111111", { id: owner.promptIds[0] }).view);
  const noisy = "x".repeat(5000);
  for (const [error, wording] of [
    [new LaneStateStoreError(`Command Center lane request rejected: ${noisy}`, 409, { detail: noisy }), "it conflicts with the current lane state; check /lanes"],
    [new LaneStateStoreError("rejected", 400, { detail: noisy }), "Command Center found the request invalid"],
    [new LaneStateStoreError("rejected", 503, { detail: noisy }), "Command Center is unavailable; try again shortly"],
    [new LaneStateStoreError("Command Center lane request failed closed: fetch failed"), "Command Center did not answer; try again"],
    [new LaneStateStoreError("redirect", 307), "Command Center refused it (HTTP 307)"],
  ] as const) {
    const cutover = control();
    cutover.failNext(error);
    await h.approvals.submit(owner, cutover);
    assert.equal(owner.replies.at(-1), `Lane control cutover growth-v2-abc was not applied: ${wording}.`);
  }
  assert.ok(owner.replies.every((reply) => !reply.includes("xxxxx")), "no detail text reaches the chat");
});

const GROUP = "-1001234567";
const telegramError = (code: number, description: string) => Object.assign(new Error(description), { response: { error_code: code, description } });

test("a group owner gets the prompt in a private chat and answers it only there", async () => {
  const h = harness({ OWNER_CHAT_ID: GROUP, OWNER_USER_ID: OWNER });
  const reached: string[] = [];
  const privatePrompts: Array<{ userId: string; text: string }> = [];
  const group = chat({
    chatId: GROUP,
    reachPrivately: async (userId) => {
      reached.push(userId);
    },
    promptPrivately: async (userId, text) => {
      privatePrompts.push({ userId, text });
      return 900;
    },
  });
  const cutover = control();
  await h.approvals.submit(group, cutover);
  assert.deepEqual(reached, [OWNER], "the private chat is checked before a code is spent");
  assert.deepEqual(privatePrompts, [{ userId: OWNER, text: PROMPT }]);
  assert.deepEqual(group.prompts, [], "no prompt where other bots can read it");
  assert.deepEqual(group.replies, [APPROVAL_TEXT.promptSentPrivately]);

  const inGroup = message("042317");
  assert.equal(await h.approvals.handleReply(group, inGroup.view), true);
  assert.equal(group.replies.at(-1), APPROVAL_TEXT.bareCodeElsewhere);
  assert.equal(group.deletes.at(-1), inGroup.raw.message_id);
  const replyInGroup = message("042317", { id: 900 });
  assert.equal(await h.approvals.handleReply(group, replyInGroup.view), true);
  assert.equal(group.deletes.at(-1), replyInGroup.raw.message_id);
  assert.equal(h.cc.verifies.length, 0, "a code is accepted only in the private chat");

  const dm = chat({ chatId: OWNER });
  await h.approvals.handleReply(dm, message("042317", { id: 900 }).view);
  assert.deepEqual(h.cc.verifies, [{ challenge_id: "ch_1", code: "042317" }]);
  assert.equal(cutover.submissions.length, 1);
  assert.deepEqual(dm.replies, [
    "Code accepted. Approvals open until 12:30 UTC.",
    "Lane control queued: cutover growth-v2-abc. The lease holder will apply it.",
  ]);
});

test("a group owner the bot cannot reach privately is told how, and nothing is applied", async () => {
  let privatePrompts = 0;
  const promptPrivately = async (): Promise<number> => {
    privatePrompts++;
    return 900;
  };
  const cases: Array<[Partial<ApprovalChat>, string, number]> = [
    [{ promptPrivately, reachPrivately: async () => { throw telegramError(403, "Forbidden: bot can't initiate conversation with a user"); } }, APPROVAL_TEXT.openPrivateChat, 0],
    [{ promptPrivately, reachPrivately: async () => { throw telegramError(403, "Forbidden: bot was blocked by the user"); } }, APPROVAL_TEXT.openPrivateChat, 0],
    [{ promptPrivately, reachPrivately: async () => { throw telegramError(400, "Bad Request: chat not found"); } }, APPROVAL_TEXT.openPrivateChat, 0],
    [{ promptPrivately, reachPrivately: async () => { throw telegramError(429, "Too Many Requests: retry after 5"); } }, APPROVAL_TEXT.privateChatUnavailable, 0],
    [{}, APPROVAL_TEXT.openPrivateChat, 0],
    [
      {
        reachPrivately: async () => undefined,
        promptPrivately: async () => { throw telegramError(403, "Forbidden: bot can't initiate conversation with a user"); },
      },
      APPROVAL_TEXT.openPrivateChat,
      1,
    ],
  ];
  for (const [operations, wording, codesSent] of cases) {
    const h = harness({ OWNER_CHAT_ID: GROUP, OWNER_USER_ID: OWNER });
    const group = chat({ chatId: GROUP, ...operations });
    const cutover = control();
    await h.approvals.submit(group, cutover);
    assert.deepEqual(group.replies, [wording]);
    assert.equal(h.cc.sends.length, codesSent);
    assert.equal(cutover.submissions.length, 0, "nothing is applied");
    assert.equal(await h.approvals.handleReply(chat({ chatId: OWNER }), message("123456", { id: 900 }).view), true);
    assert.equal(h.cc.verifies.length, 0, "and no code can complete it");
  }
  assert.equal(privatePrompts, 0, "an unreachable owner is never prompted");
  assert.equal(APPROVAL_TEXT.openPrivateChat, "To approve, open a private chat with this bot, send /start, then send the lane control again.");
});

test("six digits in a row from the owner are removed and never routed, in every chat, pending or not", async () => {
  const h = harness();
  const owner = chat();
  const elsewhere = chat({ chatId: "-100999" });
  for (const [where, text] of [[owner, "order 123456 shipped"], [elsewhere, "123456"], [owner, `code ${String.fromCharCode(0x661, 0x662, 0x663, 0x664, 0x665, 0x666)}`]] as const) {
    const sent = message(text);
    assert.equal(await h.approvals.handleReply(where, sent.view), true, text);
    assert.equal(where.deletes.at(-1), sent.raw.message_id, text);
  }
  assert.equal(owner.replies[0], APPROVAL_TEXT.sixDigits);
  assert.equal(elsewhere.replies[0], APPROVAL_TEXT.stale);
  const caption = message("");
  caption.raw = { ...caption.raw, text: undefined, document: { file_id: "f" }, caption: "invoice 654321" } as never;
  assert.equal(await h.approvals.handleReply(owner, caption.view), true, "captions count as text");
  assert.equal(owner.deletes.at(-1), caption.raw.message_id);
  for (const text of ["1234567", "12345", "123 456", "v2 build 12 34"]) {
    assert.equal(await h.approvals.handleReply(owner, message(text).view), false, `${text} is not a code's shape`);
  }

  owner.failDeletes = 3;
  const stuck = message("my code was 222222");
  await h.approvals.handleReply(owner, stuck.view);
  assert.deepEqual(owner.deletes.slice(-3), [stuck.raw.message_id, stuck.raw.message_id, stuck.raw.message_id], "three tries");
  assert.deepEqual(owner.replies.slice(-2), [APPROVAL_TEXT.sixDigits, APPROVAL_TEXT.deleteFailed], "a failed delete is reported");
  assert.equal(h.cc.verifies.length, 0);
});

test("forwarded, inline-bot and on-behalf messages are never the owner", async () => {
  const h = harness();
  const owner = chat();
  const cutover = control();
  await h.approvals.submit(owner, cutover);
  const prompt = owner.promptIds[0];

  const viaBot = message("042317", { id: prompt });
  viaBot.raw = { ...viaBot.raw, via_bot: { id: 55, is_bot: true } } as never;
  assert.equal(viaBot.view.relayed, true);
  assert.equal(await h.approvals.handleReply(owner, viaBot.view), true);
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.relayed);
  assert.equal(owner.deletes.at(-1), viaBot.raw.message_id);

  const forwarded = message("042317");
  forwarded.raw = { ...forwarded.raw, forward_origin: { type: "hidden_user", sender_user_name: "x", date: 1 }, forward_date: 1 } as never;
  assert.equal(await h.approvals.handleReply(owner, forwarded.view), true, "a forwarded code is still kept out of the chat's routing");
  assert.equal(owner.replies.at(-1), APPROVAL_TEXT.relayed);
  assert.equal(owner.deletes.at(-1), forwarded.raw.message_id);

  const anonymous = chat({ userId: "1087968824" });
  const onBehalf = message("042317", { id: prompt }, "1087968824");
  onBehalf.raw = { ...onBehalf.raw, sender_chat: { id: Number(GROUP), type: "supergroup" } } as never;
  assert.equal(await h.approvals.handleReply(anonymous, onBehalf.view), true, "a reply to the prompt is the flow's, whoever sends it");
  assert.deepEqual(anonymous.replies, [], "but an anonymous admin is never the owner");
  assert.equal(h.cc.verifies.length, 0, "none of them is relayed as a code");

  const relayedControl = chat({ relayed: true });
  const forwardedCutover = control("cutover forwarded");
  await h.approvals.submit(relayedControl, forwardedCutover);
  assert.deepEqual(relayedControl.replies, [APPROVAL_TEXT.ownerOnly], "a forwarded control asks for nothing");

  await h.approvals.handleReply(owner, message("042317", { id: prompt }).view);
  assert.equal(cutover.submissions.length, 1);
  assert.equal(forwardedCutover.submissions.length, 0);
});

test("the owner's private chat lets approval traffic through and nothing else", async () => {
  const { authGuard } = await import("../src/bot/middleware.js");
  const h = harness({ OWNER_CHAT_ID: GROUP, OWNER_USER_ID: OWNER });
  setLaneApprovals(h.approvals);
  try {
    const guard = authGuard(() => ({ ownerChatId: GROUP, ownerUserId: OWNER }), { approvalTraffic: claimedForApproval });
    const passes = async (chatId: string, chatType: string, fromId: string, msg: Record<string, unknown>) => {
      let passed = false;
      await guard(
        { chat: { id: Number(chatId), type: chatType }, from: { id: Number(fromId), is_bot: false }, message: { message_id: 1, ...msg } } as never,
        async () => {
          passed = true;
        }
      );
      return passed;
    };
    assert.equal(await passes(GROUP, "supergroup", OWNER, { text: "deploy" }), true, "the owner chat is unchanged");
    assert.equal(await passes(OWNER, "private", OWNER, { text: "123456" }), true, "a code in the private chat");
    assert.equal(await passes(OWNER, "private", OWNER, { text: "ok", reply_to_message: message("x", { id: 900 }).raw.reply_to_message }), true, "a reply to a prompt");
    assert.equal(await passes(OWNER, "private", OWNER, { text: "deploy the fix" }), false, "ordinary private messages stay refused");
    assert.equal(await passes(OWNER, "private", OWNER, { text: "/lanes cutover v2" }), false, "commands stay refused there");
    assert.equal(await passes("777", "private", "777", { text: "123456" }), false, "someone else's private chat");
    const withoutOption = authGuard(() => ({ ownerChatId: GROUP, ownerUserId: OWNER }));
    let passed = false;
    await withoutOption({ chat: { id: Number(OWNER), type: "private" }, from: { id: Number(OWNER) }, message: { message_id: 1, text: "123456" } } as never, async () => { passed = true; });
    assert.equal(passed, false);
  } finally {
    setLaneApprovals(undefined);
  }
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
    // Media handlers are guarded too: a captioned photo answering the prompt is never downloaded or relayed.
    await handlers.photo(
      ctx({ message_id: 12, photo: [{ file_id: "secret-shot" }], caption: "042317", reply_to_message: { message_id: 901, from: { id: BOT, is_bot: true }, text: PROMPT } })
    );
    assert.deepEqual(h.cc.verifies, []);
    assert.equal(sent.at(-1)?.text, APPROVAL_TEXT.digitsOnly);
    await handlers.text(
      ctx({ message_id: 11, text: "042317", reply_to_message: { message_id: 901, from: { id: BOT, is_bot: true }, text: PROMPT } })
    );
    assert.deepEqual(h.cc.verifies, [{ challenge_id: "ch_1", code: "042317" }]);
    assert.deepEqual(deleted, [[OWNER, 12], [OWNER, 11]]);
    assert.equal(created.length, 1);
    assert.equal(created[0].kind, "rollback");
    assert.deepEqual(created[0].approval, { channelKey: KEY, grant: GRANT });
    assert.equal(created[0].requested_by, `telegram:${OWNER}`);
    assert.deepEqual(sent.slice(1).map((entry) => entry.text), [
      APPROVAL_TEXT.digitsOnly,
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
  const h = harness({ OWNER_CHAT_ID: "9", OWNER_USER_ID: "9" });
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
    const commands = new CloudCommands(store, {} as CloudEngine, telegram, "9", "9");
    commands.openLaneStore = async () =>
      ({
        createControl: async (input: Record<string, unknown>) => {
          created.push(input);
          return { kind: input.kind, lane_id: null };
        },
        close: async () => undefined,
      }) as unknown as LaneStateStore;
    const handle = () => processQueue(store, ["update"], (row) => commands.handle(row));

    store.ingest([{ update_id: 1, message: { message_id: 10, chat: { id: 9, type: "private" }, from: { id: 9 }, date: 1, text: "/lanes cutover growth-v2-abc" } }]);
    await handle();
    assert.equal(h.cc.sends.length, 1);
    const prompt = calls.find((call) => call.method === "sendMessage")!;
    assert.equal(prompt.payload.text, PROMPT);
    assert.equal(prompt.payload.chat_id, "9");
    assert.deepEqual(prompt.payload.reply_parameters, { message_id: 10, allow_sending_without_reply: true });
    assert.deepEqual(prompt.payload.reply_markup, { force_reply: true, selective: true });
    assert.equal(created.length, 0);

    // A code typed without a reply while one is awaited is withheld and goes nowhere else.
    store.ingest([{ update_id: 2, message: { message_id: 11, chat: { id: 9, type: "private" }, from: { id: 9 }, date: 2, text: "555555" } }]);
    await handle();
    assert.equal(store.row("update:2:route"), undefined, "never offered to the router");
    assert.equal(store.row("update:2:action"), undefined);
    assert.match(JSON.parse(store.row("update:2:approval:0:0")!.payload).payload.text, /reply to the approval prompt/);

    // A captioned photo answering the prompt is stored without its caption and never fetched or routed.
    store.ingest([{ update_id: 3, message: { message_id: 13, chat: { id: 9, type: "private" }, from: { id: 9 }, date: 3, photo: [{ file_id: "shot" }],
      caption: "999999", caption_entities: [], reply_to_message: { message_id: 77, from: { id: BOT, is_bot: true }, text: PROMPT } } }]);
    assert.doesNotMatch(store.row("update:3")!.payload, /999999|caption/);
    // Ordinary words with a digit are held while the code is awaited, not routed.
    store.ingest([{ update_id: 4, message: { message_id: 14, chat: { id: 9, type: "private" }, from: { id: 9 }, date: 3, text: "deploy v2 now" } }]);
    assert.doesNotMatch(store.row("update:4")!.payload, /deploy v2/);
    await handle();
    await handle(); // one update per conversation per pass, in order
    assert.equal(store.row("update:3:media"), undefined, "the photo is never fetched");
    assert.equal(store.row("update:4:route"), undefined, "held, not routed");
    assert.equal(JSON.parse(store.row("update:3:approval:0:0")!.payload).payload.text, APPROVAL_TEXT.digitsOnly);
    assert.match(JSON.parse(store.row("update:4:approval:0:0")!.payload).payload.text, /^Messages with digits are held/);

    store.ingest([{ update_id: 5, message: { message_id: 12, chat: { id: 9, type: "private" }, from: { id: 9 }, date: 3, text: "042317",
      reply_to_message: { message_id: 77, from: { id: BOT, is_bot: true }, text: PROMPT } } }]);
    assert.doesNotMatch(store.row("update:5")!.payload, /042317/, "the stored update has no code");
    await handle();
    assert.deepEqual(h.cc.verifies, [{ challenge_id: "ch_1", code: "042317" }]);
    assert.deepEqual(calls.filter((call) => call.method === "deleteMessage").map((call) => call.payload), [
      { chat_id: "9", message_id: 11 },
      { chat_id: "9", message_id: 13 },
      { chat_id: "9", message_id: 12 },
    ], "the words with one digit stay in the chat; everything that could hold the code is removed");
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].approval, { channelKey: KEY, grant: GRANT });
    const texts = (store.db.prepare("SELECT id,payload FROM gateway_queue WHERE id LIKE 'update:5:approval:%' ORDER BY id").all() as Array<{ payload: string }>)
      .map((row) => JSON.parse(row.payload).payload.text);
    assert.deepEqual(texts, [
      "Code accepted. Approvals open until 12:30 UTC.",
      "Lane control queued: cutover. The lease holder will apply it.",
    ]);
    const everything = JSON.stringify([
      store.db.prepare("SELECT * FROM gateway_queue").all(),
      store.db.prepare("SELECT * FROM gateway_state").all(),
    ]);
    assert.doesNotMatch(everything, /042317|555555|999999|deploy v2/, "no code, caption or held text in any table");
    assert.ok(!everything.includes(GRANT) && !everything.includes(KEY), "no grant or key in any table");
  } finally {
    setLaneApprovals(undefined);
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    if (backend === undefined) delete process.env.LANES_STATE_BACKEND;
    else process.env.LANES_STATE_BACKEND = backend;
  }
});

test("the cloud gateway prompts a group owner privately and reads codes only there", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-approval-group-"));
  const backend = process.env.LANES_STATE_BACKEND;
  process.env.LANES_STATE_BACKEND = "http";
  const h = harness({ OWNER_CHAT_ID: "-42", OWNER_USER_ID: "9" });
  setLaneApprovals(h.approvals);
  closeDb();
  try {
    const store = new GatewayStore(getDb(path.join(dir, "state.db")));
    store.set("telegram-bot-id", BOT);
    const calls: Array<{ method: string; payload: Record<string, any> }> = [];
    let unreachable = false;
    const telegram = async (method: string, payload: Record<string, any>) => {
      calls.push({ method, payload });
      if (method === "sendChatAction" && unreachable) {
        throw Object.assign(new Error("Forbidden"), { response: { error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" } });
      }
      return method === "sendMessage" ? { message_id: 77 } : true;
    };
    const created: Array<Record<string, unknown>> = [];
    const commands = new CloudCommands(store, {} as CloudEngine, telegram, "-42", "9");
    commands.openLaneStore = async () =>
      ({
        createControl: async (input: Record<string, unknown>) => {
          created.push(input);
          return { kind: input.kind, lane_id: null };
        },
        close: async () => undefined,
      }) as unknown as LaneStateStore;
    const handle = async () => {
      for (let pass = 0; pass < 4; pass++) await processQueue(store, ["update"], (row) => commands.handle(row));
    };
    const group = { id: -42, type: "supergroup" };
    const direct = { id: 9, type: "private" };
    const text = (rows: string) =>
      (store.db.prepare(`SELECT payload FROM gateway_queue WHERE id LIKE ? ORDER BY id`).all(rows) as Array<{ payload: string }>)
        .map((row) => JSON.parse(row.payload).payload);

    store.ingest([{ update_id: 1, message: { message_id: 10, chat: group, from: { id: 9 }, date: 1, text: "/lanes rollback" } }]);
    await handle();
    assert.deepEqual(calls.slice(0, 2).map((call) => [call.method, call.payload.chat_id]), [["sendChatAction", "9"], ["sendMessage", "9"]]);
    assert.equal(calls[1].payload.text, PROMPT);
    assert.deepEqual(calls[1].payload.reply_markup, { force_reply: true });
    assert.deepEqual(text("update:1:approval:%").map((payload) => [payload.chat_id, payload.text]), [["-42", APPROVAL_TEXT.promptSentPrivately]]);

    store.ingest([
      { update_id: 2, message: { message_id: 11, chat: group, from: { id: 9 }, date: 2, text: "042317" } },
      { update_id: 3, message: { message_id: 12, chat: direct, from: { id: 9 }, date: 2, text: "deploy the fix" } },
    ]);
    assert.doesNotMatch(store.row("update:2")!.payload, /042317/);
    await handle();
    assert.deepEqual(calls.filter((call) => call.method === "deleteMessage").map((call) => call.payload), [{ chat_id: "-42", message_id: 11 }]);
    assert.equal(text("update:2:approval:%")[0].text, APPROVAL_TEXT.bareCodeElsewhere);
    const followUps = store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE id LIKE 'update:3:%'").get() as { n: number };
    assert.equal(followUps.n, 0, "anything else in the private chat is ignored");
    assert.equal(h.cc.verifies.length, 0);

    store.ingest([{ update_id: 4, message: { message_id: 13, chat: direct, from: { id: 9 }, date: 3, text: "042317",
      reply_to_message: { message_id: 77, from: { id: BOT, is_bot: true }, text: PROMPT } } }]);
    assert.doesNotMatch(store.row("update:4")!.payload, /042317/);
    await handle();
    assert.deepEqual(h.cc.verifies, [{ challenge_id: "ch_1", code: "042317" }]);
    assert.deepEqual(calls.filter((call) => call.method === "deleteMessage").at(-1)!.payload, { chat_id: "9", message_id: 13 });
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].approval, { channelKey: KEY, grant: GRANT });
    assert.deepEqual(text("update:4:approval:%").map((payload) => [payload.chat_id, payload.text]), [
      ["9", "Code accepted. Approvals open until 12:30 UTC."],
      ["9", "Lane control queued: rollback. The lease holder will apply it."],
    ]);

    // An owner who never started the bot is told how, and no code is spent.
    h.advance(31 * 60_000);
    unreachable = true;
    const sends = h.cc.sends.length;
    store.ingest([{ update_id: 5, message: { message_id: 14, chat: group, from: { id: 9 }, date: 4, text: "/lanes rollback" } }]);
    await handle();
    assert.equal(text("update:5:approval:%")[0].text, APPROVAL_TEXT.openPrivateChat);
    assert.equal(h.cc.sends.length, sends);
    assert.equal(created.length, 1);
    assert.doesNotMatch(JSON.stringify(store.db.prepare("SELECT * FROM gateway_queue").all()), /042317/);
  } finally {
    setLaneApprovals(undefined);
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    if (backend === undefined) delete process.env.LANES_STATE_BACKEND;
    else process.env.LANES_STATE_BACKEND = backend;
  }
});

test("the Telegram bot prompts a group owner privately", async () => {
  const h = harness({ OWNER_CHAT_ID: GROUP, OWNER_USER_ID: OWNER });
  setLaneApprovals(h.approvals);
  try {
    const sent: Array<{ chatId?: string; text: string; extra?: Record<string, any> }> = [];
    const actions: Array<[string, string]> = [];
    const ctx = {
      chat: { id: Number(GROUP), type: "supergroup" },
      from: { id: Number(OWNER), is_bot: false },
      message: { message_id: 10, text: "/lanes rollback" },
      botInfo: { id: BOT },
      reply: async (text: string, extra?: Record<string, any>) => {
        sent.push({ text, extra });
        return { message_id: 500 + sent.length };
      },
      telegram: {
        sendChatAction: async (chatId: string, action: string) => {
          actions.push([chatId, action]);
          return true;
        },
        sendMessage: async (chatId: string, text: string, extra?: Record<string, any>) => {
          sent.push({ chatId, text, extra });
          return { message_id: 900 };
        },
        deleteMessage: async () => true,
      },
    };
    const store = { createControl: async () => ({ kind: "rollback", lane_id: null }), close: async () => undefined } as unknown as LaneStateStore;
    await handleDurableLanes(ctx as never, "rollback", { openStore: async () => store });
    assert.deepEqual(actions, [[OWNER, "typing"]]);
    assert.deepEqual(sent, [
      { chatId: OWNER, text: PROMPT, extra: { reply_markup: { force_reply: true } } },
      { text: APPROVAL_TEXT.promptSentPrivately, extra: undefined },
    ]);
  } finally {
    setLaneApprovals(undefined);
  }
});
