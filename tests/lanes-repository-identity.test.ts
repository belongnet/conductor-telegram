import test from "node:test";
import assert from "node:assert/strict";
import { repositoryRemoteIdentity } from "../src/lanes/repository-identity.js";

test("Conductor project remotes canonicalize across HTTPS and SSH dialects", () => {
  const expected = "github.com/belongnet/example";
  assert.equal(
    repositoryRemoteIdentity("https://github.com/BelongNet/Example.git"),
    expected
  );
  assert.equal(
    repositoryRemoteIdentity("git@github.com:BelongNet/Example.git"),
    expected
  );
  assert.equal(
    repositoryRemoteIdentity("ssh://git@github.com/BelongNet/Example.git"),
    expected
  );
  assert.equal(
    repositoryRemoteIdentity("https://gitlab.com/group/subgroup/Example.git"),
    "gitlab.com/group/subgroup/example"
  );
  assert.equal(repositoryRemoteIdentity("/tmp/not-a-hosted-repository"), null);
});
