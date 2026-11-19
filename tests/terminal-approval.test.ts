import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { terminalApprovalSubject, withTerminalApproval } from "../src/cli/terminal-approval.js";
import { FRESH_APPROVAL_REQUIRED, LaneStateStoreError } from "../src/lanes/state-store.js";

const KEY = "t".repeat(48);
const GRANT = "Q".repeat(43);
const env = {
  COMMAND_CENTER_API_BASE_URL: "http://command-center.test:8080",
  COMMAND_CENTER_API_KEY: "s".repeat(48),
  BELONG_APPROVAL_CHANNEL_KEY: KEY,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function commandCenter(verifyResponses: Response[] = []) {
  const calls: Array<{ url: string; method?: string; headers: Headers; body: Record<string, unknown> | null }> = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method,
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    if (String(url).endsWith("/send")) return json({ challenge_id: "ch_cli", expires_in: 600, email_hint: "j***@belong.net" });
    if (String(url).endsWith("/verify")) {
      return (
        verifyResponses.shift() ??
        json({ grant: GRANT, expires_in: 1800, channel: "conductor-lanes", subject: "cli:ops-mac" })
      );
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** A terminal that types the next answer each time it is asked for a code. */
function terminal(answers: string[], isTTY = true) {
  const input = Object.assign(new PassThrough(), { isTTY });
  let shown = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      const text = chunk.toString();
      shown += text;
      if (text.includes("Approval code: ")) {
        const next = answers.shift();
        setImmediate(() => (next === undefined ? input.end() : input.write(`${next}\n`)));
      }
      done();
    },
  });
  return { input, output, shown: () => shown };
}

test("the CLI refuses a human-gated control without a terminal to type the code", async () => {
  const cc = commandCenter();
  const tty = terminal([], false);
  let submitted = false;
  await assert.rejects(
    withTerminalApproval("lanes release", async () => {
      submitted = true;
    }, { env, input: tty.input, output: tty.output, fetchImpl: cc.fetchImpl, subject: "cli:ops-mac" }),
    /lanes release needs an emailed approval code typed at a terminal/
  );
  assert.equal(submitted, false);
  assert.equal(cc.calls.length, 0, "no code is requested for nobody");
});

test("the CLI asks for the code on the terminal, retries a wrong one, and revokes the grant after use", async () => {
  const cc = commandCenter([json({ detail: "no", reason: "invalid" }, 401)]);
  const tty = terminal(["12345", "111111", "042317"]);
  const result = await withTerminalApproval(
    "lanes validate",
    async (approval) => {
      assert.deepEqual(approval, { channelKey: KEY, grant: GRANT });
      return "created";
    },
    { env, input: tty.input, output: tty.output, fetchImpl: cc.fetchImpl, subject: "cli:ops-mac" }
  );
  assert.equal(result, "created");
  assert.deepEqual(cc.calls[0].body, { channel: "conductor-lanes", subject: "cli:ops-mac" });
  assert.deepEqual(
    cc.calls.filter((call) => call.url.endsWith("/verify")).map((call) => call.body),
    [
      { challenge_id: "ch_cli", code: "111111" },
      { challenge_id: "ch_cli", code: "042317" },
    ],
    "a malformed entry is never sent"
  );
  const revoke = cc.calls.at(-1)!;
  assert.equal(revoke.method, "DELETE");
  assert.match(revoke.url, /\/api\/operator\/otp\/channel\/grant$/);
  assert.equal(revoke.headers.get("x-belong-approval-grant"), GRANT);
  const shown = tty.shown();
  assert.match(shown, /^Approval code sent to j\*\*\*@belong\.net\. Enter the 6-digit code within 10 minutes\.\n/);
  assert.match(shown, /Enter only the 6-digit code\./);
  assert.match(shown, /That code was not accepted\. Enter the latest 6-digit code\./);
  assert.doesNotMatch(shown, /042317|111111/, "the terminal output never repeats a code");
});

test("the CLI stops cleanly when no code arrives or Command Center wants a fresh one", async () => {
  const closed = terminal([]);
  const cc = commandCenter();
  let submitted = false;
  await assert.rejects(
    withTerminalApproval("lanes retire", async () => {
      submitted = true;
    }, { env, input: closed.input, output: closed.output, fetchImpl: cc.fetchImpl, subject: "cli:ops-mac" }),
    /lanes retire: no approval code was entered; nothing was applied/
  );
  assert.equal(submitted, false);

  const expired = commandCenter([json({ detail: "no", reason: "expired" }, 401)]);
  const late = terminal(["123456"]);
  await assert.rejects(
    withTerminalApproval("lanes release", async () => "never", {
      env, input: late.input, output: late.output, fetchImpl: expired.fetchImpl, subject: "cli:ops-mac",
    }),
    /lanes release: the code has expired; nothing was applied/
  );

  const stale = commandCenter();
  const typed = terminal(["123456"]);
  await assert.rejects(
    withTerminalApproval(
      "lanes release",
      async () => {
        throw new LaneStateStoreError("rejected", 401, { detail: FRESH_APPROVAL_REQUIRED });
      },
      { env, input: typed.input, output: typed.output, fetchImpl: stale.fetchImpl, subject: "cli:ops-mac" }
    ),
    /Command Center asked for a fresh approval code; nothing was applied, run the command again/
  );
  assert.equal(stale.calls.at(-1)!.method, "DELETE", "the grant is revoked even when the control fails");

  await assert.rejects(
    withTerminalApproval("lanes release", async () => "never", {
      env: { COMMAND_CENTER_API_BASE_URL: "http://command-center.test" },
      input: terminal([]).input,
      output: new PassThrough(),
    }),
    /lanes release needs lane approvals set up: set BELONG_APPROVAL_CHANNEL_KEY and COMMAND_CENTER_API_BASE_URL/
  );
});

test("the CLI's approval subject names this host in printable characters", () => {
  assert.equal(terminalApprovalSubject("ops-mac.local"), "cli:ops-mac.local");
  assert.equal(terminalApprovalSubject("bad host\nname"), "cli:badhostname");
  assert.equal(terminalApprovalSubject(""), "cli:host");
  assert.ok(terminalApprovalSubject("x".repeat(200)).length <= 80);
});
