import test from "node:test";
import assert from "node:assert/strict";
import { githubRepositoryAccess, laneApprovalCheck } from "../src/cloud/preflight.js";

test("preflight reports repositories the GitHub token cannot read", async () => {
  const check = await githubRepositoryAccess(
    [{gitRemote: "https://github.com/org/a.git"}, {gitRemote: "git@github.com:org/b.git"}],
    "token",
    async (url) => {
      const path = String(url);
      if (path.includes("org/a/pulls")) return new Response("[]", {status: 200});
      if (path.includes("org/b/pulls")) return new Response("{}", {status: 404});
      throw new Error(path);
    },
  );
  assert.equal(check.ok, false);
  assert.equal(check.name, "GitHub repositories");
  assert.match(check.detail, /org\/b/);
  assert.doesNotMatch(check.detail, /org\/a/);
  assert.match(check.fix ?? "", /Pull requests: read/);
});

test("preflight does not treat a GitHub outage as missing access", async () => {
  const check = await githubRepositoryAccess(
    [{gitRemote: "https://github.com/org/a"}, {gitRemote: "https://github.com/org/b"}],
    "token",
    async (url) => {
      if (String(url).includes("org/a/pulls")) return new Response("[]", {status: 200});
      return new Response("{}", {status: 503});
    },
  );
  assert.equal(check.ok, true);
  assert.match(check.detail, /1 of 2 project repositories readable/);
  assert.match(check.detail, /1 not checked/);
});

test("a gateway that serves lane controls needs a usable approval channel key", () => {
  assert.equal(laneApprovalCheck({}), null, "no durable lanes, nothing to approve");
  const base = { LANES_STATE_BACKEND: "http", COMMAND_CENTER_API_BASE_URL: "http://command-center.test", COMMAND_CENTER_API_KEY: "s".repeat(48) };
  const missing = laneApprovalCheck({ ...base, BELONG_HUMAN_APPROVAL_KEY: "h".repeat(48) })!;
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /BELONG_APPROVAL_CHANNEL_KEY is not set/);
  assert.match(missing.fix ?? "", /keep it out of the lanes worker/);
  assert.match(laneApprovalCheck({ ...base, BELONG_APPROVAL_CHANNEL_KEY: "s".repeat(48) })!.detail, /must differ from COMMAND_CENTER_API_KEY/);
  assert.match(laneApprovalCheck({ LANES_STATE_BACKEND: "http", BELONG_APPROVAL_CHANNEL_KEY: "k".repeat(48) })!.detail, /COMMAND_CENTER_API_BASE_URL is not set/);
  const ready = laneApprovalCheck({ ...base, BELONG_APPROVAL_CHANNEL_KEY: "k".repeat(48) })!;
  assert.equal(ready.ok, true);
  assert.equal(ready.detail, "Owner lane controls ask Command Center for an emailed code");
  const leftover = laneApprovalCheck({ ...base, BELONG_APPROVAL_CHANNEL_KEY: "k".repeat(48), BELONG_HUMAN_APPROVAL_KEY: "h".repeat(48) })!;
  assert.equal(leftover.ok, true);
  assert.match(leftover.detail, /BELONG_HUMAN_APPROVAL_KEY is retired and unused, delete it$/);
  for (const check of [missing, ready, leftover]) assert.ok(!JSON.stringify(check).includes("k".repeat(10)) && !JSON.stringify(check).includes("h".repeat(10)));
});
