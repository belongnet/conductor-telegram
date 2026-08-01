import test, { after } from "node:test";
import assert from "node:assert/strict";
import { checkConductorCloudApi } from "../src/cli/doctor.js";
import type { Config } from "../src/cli/config.js";

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function config(overrides: Partial<Config>): Config {
  return { ...overrides } as Config;
}

test("doctor reports observe-only when the cloud backend is off or keyless", async () => {
  const off = await checkConductorCloudApi(
    config({ conductorCloudBackend: "off" })
  );
  assert.equal(off.ok, true);
  assert.match(off.detail ?? "", /observe-only/);

  const keyless = await checkConductorCloudApi(config({}));
  assert.equal(keyless.ok, true);
  assert.match(keyless.detail ?? "", /not configured/);

  // api mode without a key is a misconfiguration, not observe-only.
  const apiModeKeyless = await checkConductorCloudApi(
    config({ conductorCloudBackend: "api" })
  );
  assert.equal(apiModeKeyless.ok, false);
  assert.match(apiModeKeyless.fix ?? "", /CONDUCTOR_API_KEY/);
});

test("doctor separates authentication from project visibility", async () => {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/me") {
      return json({ userId: "user-1", authMethod: "api-key" });
    }
    if (pathname === "/v0/projects") {
      return json({
        data: [
          { id: "proj-1", name: "api", gitRemote: "remote-1" },
          { id: "proj-2", name: "web", gitRemote: "remote-2" },
        ],
        offset: 0,
        hasMore: false,
      });
    }
    return json({ userMessage: `unexpected ${pathname}` }, 599);
  }) as typeof fetch;

  const result = await checkConductorCloudApi(
    config({
      conductorApiKey: "secret",
      conductorApiBaseUrl: "https://conductor.test",
    })
  );
  assert.equal(result.ok, true);
  assert.match(result.detail ?? "", /api-key authenticated/);
  assert.match(result.detail ?? "", /2 cloud project\(s\) visible/);
});

test("doctor keeps auth success even when project listing fails", async () => {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/me") {
      return json({ userId: "user-1", authMethod: "api-key" });
    }
    return json({ userMessage: "insufficient scope" }, 403);
  }) as typeof fetch;

  const result = await checkConductorCloudApi(
    config({
      conductorApiKey: "secret",
      conductorApiBaseUrl: "https://conductor.test",
    })
  );
  assert.equal(result.ok, true);
  assert.match(result.detail ?? "", /projects unavailable/);
});

test("doctor fails closed when authentication itself fails", async () => {
  globalThis.fetch = (async () =>
    json({ userMessage: "bad key" }, 401)) as typeof fetch;

  const result = await checkConductorCloudApi(
    config({
      conductorApiKey: "wrong",
      conductorApiBaseUrl: "https://conductor.test",
    })
  );
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /bad key/);
});
