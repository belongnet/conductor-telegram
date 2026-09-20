import test from "node:test";
import assert from "node:assert/strict";
import { githubRepositoryAccess } from "../src/cloud/preflight.js";

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
