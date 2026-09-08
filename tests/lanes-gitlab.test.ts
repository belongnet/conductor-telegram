import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  GitlabLaneGateway,
  gitlabMrIdentity,
} from "../src/bot/gitlab.js";

const HEAD = "a".repeat(40);
const NEXT_HEAD = "b".repeat(40);
const MERGED = "c".repeat(40);
const MR_URL = "https://gitlab.com/nomadhub/platform/site/-/merge_requests/17";

function gitlabFixture() {
  let head = HEAD;
  let merged = false;
  let mergedHeadOverride: string | null = null;
  let noteId = 0;
  let mergeCalls = 0;
  const notes: Array<{ id: number; body: string; created_at: string }> = [];
  const fetcher: typeof fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    const method = init.method ?? "GET";
    assert.equal(init.headers && (init.headers as Record<string, string>)["PRIVATE-TOKEN"], "token");
    let payload: unknown;
    if (url.pathname.endsWith("/merge_requests/17") && method === "GET") {
      payload = {
        iid: 17,
        state: merged ? "merged" : "opened",
        draft: false,
        source_branch: "managed/site",
        target_branch: "dev",
        sha: merged && mergedHeadOverride ? mergedHeadOverride : head,
        merge_status: "can_be_merged",
        detailed_merge_status: "mergeable",
        squash_commit_sha: merged ? MERGED : null,
        web_url: MR_URL,
      };
    } else if (url.pathname.endsWith(`/repository/commits/${head}/statuses`)) {
      payload = [
        { name: "unit", status: "success" },
        { name: "gitlab/lint-and-test", status: "success" },
      ];
    } else if (url.pathname.endsWith(`/repository/commits/${MERGED}/statuses`)) {
      payload = [{ name: "post-merge", status: "success" }];
    } else if (url.pathname.endsWith("/merge_requests/17/notes") && method === "GET") {
      payload = notes;
    } else if (url.pathname.endsWith("/merge_requests/17/notes") && method === "POST") {
      const body = JSON.parse(String(init.body)) as { body: string };
      payload = {
        id: ++noteId,
        body: body.body,
        created_at: new Date().toISOString(),
      };
      notes.push(payload as (typeof notes)[number]);
    } else if (url.pathname.endsWith("/merge_requests/17/merge") && method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(body.sha, head);
      assert.equal(body.squash, true);
      assert.equal(body.should_remove_source_branch, false);
      mergeCalls += 1;
      merged = true;
      payload = { state: "merged", squash_commit_sha: MERGED };
    } else {
      return new Response(JSON.stringify({ message: `unhandled ${method} ${url}` }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    gateway: new GitlabLaneGateway("token", fetcher),
    setHead(value: string) {
      head = value;
    },
    setMergedHead(value: string) {
      mergedHeadOverride = value;
    },
    mergeCalls() {
      return mergeCalls;
    },
  };
}

test("GitLab identity supports nested groups and rejects non-MR URLs", () => {
  assert.deepEqual(gitlabMrIdentity(MR_URL), {
    baseUrl: "https://gitlab.com",
    owner: "nomadhub/platform",
    repo: "site",
    project: "nomadhub/platform/site",
    number: 17,
  });
  assert.equal(gitlabMrIdentity("https://gitlab.com/nomadhub/site/-/issues/17"), null);
  assert.equal(gitlabMrIdentity("http://gitlab.com/nomadhub/site/-/merge_requests/17"), null);
  assert.equal(gitlabMrIdentity(`${MR_URL}?view=parallel`), null);
  assert.equal(
    gitlabMrIdentity("https://token@gitlab.com/nomadhub/platform/site/-/merge_requests/17"),
    null
  );
});

test("GitLab adapter binds exact head, publishes commissioned evidence, and verifies merge", async () => {
  const fixture = gitlabFixture();
  const policy = await fixture.gateway.refreshPr(MR_URL);
  assert.equal(policy.repoOwner, "nomadhub/platform");
  assert.equal(policy.repoName, "site");
  assert.equal(policy.baseBranch, "dev");
  assert.equal(policy.headSha, HEAD);
  assert.equal(policy.checksStatus, "passing");
  assert.deepEqual(
    policy.checks?.map((check) => check.name),
    ["unit", "gitlab/lint-and-test"]
  );

  const body = `FINAL-REVIEW (gpt-5.6-sol): {"headSha":"${HEAD}","nonce":"n"}`;
  const receipt = await fixture.gateway.postReview(MR_URL, body, HEAD);
  assert.equal(receipt.commitSha, HEAD);
  assert.equal(await fixture.gateway.hasCommentTag(MR_URL, '"nonce":"n"'), true);
  assert.equal(
    await fixture.gateway.hasCommentTag(
      MR_URL,
      '"nonce":"n"',
      createHash("sha256").update(body).digest("hex")
    ),
    true
  );
  assert.equal(
    await fixture.gateway.hasCommentTag(MR_URL, '"nonce":"n"', "0".repeat(64)),
    false
  );

  const merged = await fixture.gateway.merge({
    prUrl: MR_URL,
    method: "squash",
    expectedHeadSha: HEAD,
  });
  assert.equal(merged.mergedSha, MERGED);
  assert.equal(fixture.mergeCalls(), 1);
  assert.equal((await fixture.gateway.refreshPr(MR_URL)).state, "merged");
  assert.equal(
    (
      await fixture.gateway.refreshCommitChecks({
        repoOwner: "nomadhub/platform",
        repoName: "site",
        sha: MERGED,
      })
    ).status,
    "passing"
  );
});

test("GitLab exact-head merge fails closed before mutation when the head changed", async () => {
  const fixture = gitlabFixture();
  fixture.setHead(NEXT_HEAD);
  await assert.rejects(
    fixture.gateway.merge({
      prUrl: MR_URL,
      method: "squash",
      expectedHeadSha: HEAD,
    }),
    /merge gate changed/
  );
  assert.equal(fixture.mergeCalls(), 0);
});

test("GitLab exact-head merge rejects a changed head in the post-merge receipt", async () => {
  const fixture = gitlabFixture();
  fixture.setMergedHead(NEXT_HEAD);
  await assert.rejects(
    fixture.gateway.merge({
      prUrl: MR_URL,
      method: "squash",
      expectedHeadSha: HEAD,
    }),
    /merged state is not proven/
  );
  assert.equal(fixture.mergeCalls(), 1);
});

test("GitLab commit status pagination is exhaustive and cursor ordered", async () => {
  const pages: string[] = [];
  const fetcher: typeof fetch = async (rawUrl) => {
    const url = new URL(String(rawUrl));
    const page = url.searchParams.get("page") ?? "";
    pages.push(page);
    return new Response(
      JSON.stringify([{ name: `check-${page}`, status: "success" }]),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(page === "1" ? { "x-next-page": "2" } : {}),
        },
      }
    );
  };
  const gateway = new GitlabLaneGateway("token", fetcher);
  const checks = await gateway.refreshCommitChecks({
    repoOwner: "nomadhub/platform",
    repoName: "site",
    sha: MERGED,
  });
  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(checks.status, "passing");
  assert.equal(checks.summary, "2 passing");
});
