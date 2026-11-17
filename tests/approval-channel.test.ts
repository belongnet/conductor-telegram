import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  APPROVAL_CHANNEL,
  ApprovalAttemptsError,
  ApprovalChannelClient,
  ApprovalChannelError,
  ApprovalCodeExpiredError,
  ApprovalCodeInvalidError,
  ApprovalUnavailableError,
  ApprovalWaitError,
  approvalChannelFromEnv,
  approvalChannelKeyProblem,
} from "../src/lanes/approval-channel.js";

const KEY = "k".repeat(48);
const GRANT = "g".repeat(43);
const NOW = Date.parse("2026-11-17T12:00:00.000Z");

type Call = { url: string; init: RequestInit; body: Record<string, unknown> | null };

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function client(
  respond: (call: Call) => Response | Promise<Response>,
  options: { now?: () => number; timeoutMs?: number; apiKey?: string } = {}
) {
  const calls: Call[] = [];
  let clock = NOW;
  const instance = new ApprovalChannelClient({
    baseUrl: "http://command-center.test:8080/",
    channelKey: KEY,
    subject: "telegram:6262626262",
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
    now: options.now ?? (() => clock),
    fetchImpl: (async (url: string | URL | Request, init: RequestInit = {}) => {
      const call = { url: String(url), init, body: typeof init.body === "string" ? JSON.parse(init.body) : null };
      calls.push(call);
      return respond(call);
    }) as typeof fetch,
  });
  return { client: instance, calls, advance: (ms: number) => { clock += ms; } };
}

const sent = { challenge_id: "ch_123", expires_in: 600, email_hint: "j***@belong.net" };
const verified = (extra: Record<string, unknown> = {}) => ({
  grant: GRANT,
  expires_in: 1800,
  expires_at: new Date(NOW + 1800_000).toISOString(),
  channel: APPROVAL_CHANNEL,
  subject: "telegram:6262626262",
  ...extra,
});

test("sendCode asks Command Center for a code with only the channel key and refuses redirects", async () => {
  const { client: c, calls } = client(() => json(sent), { apiKey: "service-key" });
  const challenge = await c.sendCode();
  assert.deepEqual(challenge, {
    challengeId: "ch_123",
    emailHint: "j***@belong.net",
    expiresInSeconds: 600,
    expiresAt: NOW + 600_000,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://command-center.test:8080/api/operator/otp/channel/send");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal, "every call has a timeout");
  assert.deepEqual(calls[0].body, { channel: "conductor-lanes", subject: "telegram:6262626262" });
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("x-belong-approval-channel-key"), KEY);
  assert.equal(headers.get("x-api-key"), "service-key");
  assert.equal(headers.get("x-belong-approval-key"), null, "the retired key header is never sent");
  assert.equal(headers.get("x-belong-approval-grant"), null);
});

test("sendCode maps every refusal to a typed reason", async () => {
  const cases: Array<[Response | (() => never), new (...args: never[]) => ApprovalChannelError, Partial<ApprovalChannelError>]> = [
    [json({ detail: "hold", reason: "wait", retry_after: 125 }, 429, { "retry-after": "125" }), ApprovalWaitError, { reason: "wait", retryAfterSeconds: 125 }],
    [json({ detail: "hold", reason: "attempts" }, 429, { "retry-after": "900" }), ApprovalAttemptsError, { reason: "attempts", retryAfterSeconds: 900 }],
    [json({ detail: "hold" }, 429), ApprovalWaitError, { reason: "wait", retryAfterSeconds: undefined }],
    [json({ detail: "bad channel key" }, 401), ApprovalUnavailableError, { reason: "unavailable", status: 401, channelKeyRefused: true }],
    [json({ detail: "unconfigured" }, 503), ApprovalUnavailableError, { reason: "unavailable", status: 503, channelKeyRefused: false }],
    [new Response("<html>gateway</html>", { status: 502 }), ApprovalUnavailableError, { reason: "unavailable", status: 502 }],
    [json({ challenge_id: "", expires_in: 600 }), ApprovalUnavailableError, { reason: "unavailable" }],
    [json({ challenge_id: "ch", expires_in: -1 }), ApprovalUnavailableError, { reason: "unavailable" }],
    [new Response("not json", { status: 200 }), ApprovalUnavailableError, { reason: "unavailable" }],
    [() => { throw new TypeError("fetch failed"); }, ApprovalUnavailableError, { reason: "unavailable", status: undefined }],
  ];
  for (const [response, type, expected] of cases) {
    const { client: c } = client(() => (typeof response === "function" ? response() : response.clone()));
    const error = await c.sendCode().then(() => assert.fail("must refuse"), (e: unknown) => e);
    assert.ok(error instanceof type, `${type.name} expected, got ${String(error)}`);
    for (const [field, value] of Object.entries(expected)) {
      assert.equal((error as unknown as Record<string, unknown>)[field], value, `${type.name}.${field}`);
    }
  }
});

test("a code that would leave through a redirect, an oversized body or a stalled call is refused", async () => {
  const redirected = client(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }));
  await assert.rejects(redirected.client.sendCode(), ApprovalUnavailableError);

  let pulled = 0;
  let cancelled = false;
  const endless = client(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++;
            controller.enqueue(new TextEncoder().encode(" ".repeat(4096)));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
  );
  await assert.rejects(endless.client.sendCode(), ApprovalUnavailableError);
  assert.ok(cancelled, "the stream is cancelled at the cap");
  assert.ok(pulled <= 6, `read stops near 16 KiB, pulled ${pulled} chunks`);

  const declared = client(() => new Response("{}", { status: 200, headers: { "content-length": String(1024 * 1024) } }));
  await assert.rejects(declared.client.sendCode(), ApprovalUnavailableError);

  const stalled = client(
    ({ init }) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
    { timeoutMs: 20 }
  );
  const started = Date.now();
  await assert.rejects(stalled.client.sendCode(), ApprovalUnavailableError);
  assert.ok(Date.now() - started < 2000, "the timeout ends the wait");
});

test("verifyCode keeps the grant in memory until the earlier of its two expiries", async () => {
  const { client: c, calls, advance } = client(({ url }) =>
    url.endsWith("/verify") ? json(verified({ expires_at: new Date(NOW + 1200_000).toISOString() })) : json({}, 204)
  );
  assert.equal(c.approval(), null);
  const result = await c.verifyCode("ch_123", "042317");
  assert.equal(result.expiresAt, NOW + 1200_000, "expires_at came first");
  assert.equal(calls[0].url, "http://command-center.test:8080/api/operator/otp/channel/verify");
  assert.deepEqual(calls[0].body, { challenge_id: "ch_123", code: "042317" });
  assert.deepEqual(c.approval(), { channelKey: KEY, grant: GRANT });
  assert.deepEqual(c.grantHeaders(), {
    "x-belong-approval-channel-key": KEY,
    "x-belong-approval-grant": GRANT,
  });
  assert.equal(c.grantExpiresAt(), NOW + 1200_000);
  advance(1200_000 - 11_000);
  assert.ok(c.approval(), "still live just before the safety margin");
  advance(2_000);
  assert.equal(c.approval(), null, "expired inside the margin");
  assert.equal(c.grantHeaders(), null);

  const relative = client(() => json(verified({ expires_at: undefined })));
  assert.equal((await relative.client.verifyCode("ch", "123456")).expiresAt, NOW + 1800_000);
  const textual = client(() => json(verified({ expires_at: undefined, expires_in: "900" })));
  assert.equal((await textual.client.verifyCode("ch", "123456")).expiresAt, NOW + 900_000, "a numeric string is a lifetime too");
  relative.client.dropGrant();
  assert.equal(relative.client.approval(), null);
});

test("verifyCode maps refusals by reason and never sends a malformed code", async () => {
  const cases: Array<[Response, new (...args: never[]) => ApprovalChannelError]> = [
    [json({ detail: "no", reason: "invalid" }, 401), ApprovalCodeInvalidError],
    [json({ detail: "no", reason: "expired" }, 401), ApprovalCodeExpiredError],
    [json({ detail: "no", reason: "attempts" }, 401), ApprovalAttemptsError],
    [json({ detail: "no", reason: "attempts", retry_after: 60 }, 429), ApprovalAttemptsError],
    [json({ detail: "no", reason: "wait", retry_after: 60 }, 429), ApprovalWaitError],
    [json({ detail: "bad key" }, 401), ApprovalUnavailableError],
    [json({ detail: "down" }, 503), ApprovalUnavailableError],
    [json(verified({ subject: "telegram:1" })), ApprovalUnavailableError],
    [json(verified({ channel: "other-channel" })), ApprovalUnavailableError],
    [json(verified({ grant: "short" })), ApprovalUnavailableError],
    [json(verified({ expires_in: undefined, expires_at: undefined })), ApprovalUnavailableError],
    [json(verified({ expires_in: undefined, expires_at: new Date(NOW - 1000).toISOString() })), ApprovalUnavailableError],
  ];
  for (const [response, type] of cases) {
    const { client: c } = client(() => response.clone());
    await assert.rejects(c.verifyCode("ch_123", "123456"), type);
    assert.equal(c.approval(), null, `${type.name} leaves no grant`);
  }
  const { client: c, calls } = client(() => json(verified()));
  for (const malformed of ["12345", "1234567", "12 345", "abcdef", " 123456"]) {
    await assert.rejects(c.verifyCode("ch_123", malformed), ApprovalCodeInvalidError);
  }
  assert.equal(calls.length, 0, "a malformed code never leaves the process");
});

test("revokeGrant forgets the grant first and sends both headers", async () => {
  const { client: c, calls } = client(({ url }) => (url.endsWith("/grant") ? new Response(null, { status: 204 }) : json(verified())));
  assert.equal(await c.revokeGrant(), false, "nothing to revoke");
  await c.verifyCode("ch", "123456");
  assert.equal(await c.revokeGrant(), true);
  assert.equal(c.approval(), null);
  const revoke = calls.at(-1)!;
  assert.equal(revoke.url, "http://command-center.test:8080/api/operator/otp/channel/grant");
  assert.equal(revoke.init.method, "DELETE");
  const headers = new Headers(revoke.init.headers);
  assert.equal(headers.get("x-belong-approval-channel-key"), KEY);
  assert.equal(headers.get("x-belong-approval-grant"), GRANT);

  const failing = client(({ url }) => {
    if (url.endsWith("/grant")) throw new TypeError("offline");
    return json(verified());
  });
  await failing.client.verifyCode("ch", "123456");
  assert.equal(await failing.client.revokeGrant(), false);
  assert.equal(failing.client.approval(), null, "the grant is gone even when revocation fails");
});

test("errors and the client itself never show the key, grant or code", async () => {
  const { client: c } = client(({ url }) =>
    url.endsWith("/verify") ? json({ detail: `code 654321 for ${KEY}`, reason: "invalid" }, 401) : json(sent)
  );
  const error = await c.verifyCode("ch_123", "654321").catch((e: unknown) => e);
  const rendered = [String(error), JSON.stringify(error), inspect(error), inspect(c, { showHidden: true, depth: 5 })].join("\n");
  assert.doesNotMatch(rendered, /654321/);
  assert.ok(!rendered.includes(KEY), "the channel key is not rendered");
  const granted = client(() => json(verified()));
  await granted.client.verifyCode("ch", "123456");
  assert.ok(!inspect(granted.client, { showHidden: true, depth: 5 }).includes(GRANT), "the grant is not rendered");
  assert.ok(!JSON.stringify(granted.client).includes(GRANT));
});

test("the email hint is reduced to one visible line", async () => {
  for (const [hint, shown] of [
    ["j***@belong.net", "j***@belong.net"],
    [`${String.fromCharCode(0x202e)}j***@belong.net\n<b>${String.fromCharCode(0x200b)}`, "j***@belong.net<b>"],
    ["", "the approval mailbox"],
    [42, "the approval mailbox"],
  ] as const) {
    const { client: c } = client(() => json({ ...sent, email_hint: hint }));
    assert.equal((await c.sendCode()).emailHint, shown);
  }
});

test("the channel key must be long, unbroken and its own", () => {
  const env = {
    COMMAND_CENTER_API_KEY: "s".repeat(48),
    BELONG_AGENTS_API_KEYS: `a${"x".repeat(47)}, b${"y".repeat(47)}`,
    BELONG_HUMAN_APPROVAL_KEY: "h".repeat(48),
  };
  assert.match(approvalChannelKeyProblem(undefined)!, /not set/);
  assert.match(approvalChannelKeyProblem("short")!, /at least 40/);
  assert.match(approvalChannelKeyProblem(`${"k".repeat(30)} ${"k".repeat(30)}`)!, /whitespace/);
  assert.match(approvalChannelKeyProblem("s".repeat(48), env)!, /differ from COMMAND_CENTER_API_KEY/);
  assert.match(approvalChannelKeyProblem(`b${"y".repeat(47)}`, env)!, /differ from BELONG_AGENTS_API_KEYS/);
  assert.match(approvalChannelKeyProblem("h".repeat(48), env)!, /differ from BELONG_HUMAN_APPROVAL_KEY/);
  assert.equal(approvalChannelKeyProblem(KEY, env), null);
  for (const problem of [approvalChannelKeyProblem("s".repeat(48), env)!, approvalChannelKeyProblem("short")!]) {
    assert.ok(!problem.includes("s".repeat(10)), "a problem never echoes the value");
  }
});

test("approvalChannelFromEnv explains what is missing", () => {
  assert.match(
    (approvalChannelFromEnv({}, "telegram:1") as { problem: string }).problem,
    /BELONG_APPROVAL_CHANNEL_KEY and COMMAND_CENTER_API_BASE_URL/
  );
  assert.match(
    (approvalChannelFromEnv({ COMMAND_CENTER_API_BASE_URL: "http://cc.test", BELONG_APPROVAL_CHANNEL_KEY: "short" }, "telegram:1") as { problem: string }).problem,
    /at least 40/
  );
  assert.match(
    (approvalChannelFromEnv({ COMMAND_CENTER_API_BASE_URL: "ftp://cc.test", BELONG_APPROVAL_CHANNEL_KEY: KEY }, "telegram:1") as { problem: string }).problem,
    /http or https/
  );
  const setup = approvalChannelFromEnv(
    { COMMAND_CENTER_API_BASE_URL: "http://cc.test", BELONG_APPROVAL_CHANNEL_KEY: ` ${KEY} ` },
    "telegram:1"
  );
  assert.ok("client" in setup);
  assert.equal(setup.client.subject, "telegram:1");
  assert.equal(setup.client.channel, "conductor-lanes");
});
