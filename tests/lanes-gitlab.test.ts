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
  let baseBranch = "dev";
  let mergedBaseBranchOverride: string | null = null;
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
        target_branch: merged && mergedBaseBranchOverride ? mergedBaseBranchOverride : baseBranch,
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
    setBaseBranch(value: string) {
      baseBranch = value;
    },
    setMergedBaseBranch(value: string) {
      mergedBaseBranchOverride = value;
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

  const body = `FINAL-REVIEW (gpt-6-astra): {"headSha":"${HEAD}","nonce":"n"}`;
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
    expectedHeadBranch: "managed/site",
    expectedBaseBranch: "dev",
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

test("a GitLab squash merge records the commit left at the tip of the target branch", async () => {
  const MERGE_COMMIT = "d".repeat(40);
  let merged = false;
  const fetcher: typeof fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    const method = init.method ?? "GET";
    let payload: unknown;
    if (url.pathname.endsWith("/merge_requests/17") && method === "GET") {
      // The merge-commit method puts a merge commit on top of the squash commit.
      payload = {
        iid: 17,
        state: merged ? "merged" : "opened",
        sha: HEAD,
        source_branch: "managed/site",
        target_branch: "dev",
        merge_status: "can_be_merged",
        squash_commit_sha: merged ? MERGED : null,
        merge_commit_sha: merged ? MERGE_COMMIT : null,
        web_url: MR_URL,
      };
    } else if (url.pathname.endsWith("/merge_requests/17/merge") && method === "PUT") {
      merged = true;
      payload = { state: "merged" };
    } else if (url.pathname.includes("/statuses") || url.pathname.endsWith("/notes")) {
      payload = [];
    } else {
      return new Response(JSON.stringify({ message: `unhandled ${method} ${url}` }), { status: 404 });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const gateway = new GitlabLaneGateway("token", fetcher);
  const { mergedSha } = await gateway.merge({
    prUrl: MR_URL,
    method: "squash",
    expectedHeadSha: HEAD,
    expectedHeadBranch: "managed/site",
    expectedBaseBranch: "dev",
  });
  assert.equal(mergedSha, MERGE_COMMIT);
  assert.equal((await gateway.refreshPr(MR_URL)).mergeCommitSha, MERGE_COMMIT);
});

test("GitLab exact-head merge fails closed before mutation when the head changed", async () => {
  const fixture = gitlabFixture();
  fixture.setHead(NEXT_HEAD);
  await assert.rejects(
    fixture.gateway.merge({
      prUrl: MR_URL,
      method: "squash",
      expectedHeadSha: HEAD,
      expectedHeadBranch: "managed/site",
      expectedBaseBranch: "dev",
    }),
    /merge gate changed/
  );
  assert.equal(fixture.mergeCalls(), 0);
});

test("GitLab merge refuses a retargeted MR even when its head SHA is unchanged", async () => {
  const fixture = gitlabFixture();
  fixture.setBaseBranch("release");
  await assert.rejects(
    fixture.gateway.merge({
      prUrl: MR_URL,
      method: "squash",
      expectedHeadSha: HEAD,
      expectedHeadBranch: "managed/site",
      expectedBaseBranch: "dev",
    }),
    /merge gate changed/
  );
  assert.equal(fixture.mergeCalls(), 0);
});

test("GitLab merge detects a target changed during the merge request", async () => {
  const fixture = gitlabFixture();
  fixture.setMergedBaseBranch("release");
  await assert.rejects(
    fixture.gateway.merge({
      prUrl: MR_URL,
      method: "squash",
      expectedHeadSha: HEAD,
      expectedHeadBranch: "managed/site",
      expectedBaseBranch: "dev",
    }),
    /merged state is not proven/
  );
  assert.equal(fixture.mergeCalls(), 1, "the changed target is detected after the host mutation");
});

test("GitLab exact-head merge rejects a changed head in the post-merge receipt", async () => {
  const fixture = gitlabFixture();
  fixture.setMergedHead(NEXT_HEAD);
  await assert.rejects(
    fixture.gateway.merge({
      prUrl: MR_URL,
      method: "squash",
      expectedHeadSha: HEAD,
      expectedHeadBranch: "managed/site",
      expectedBaseBranch: "dev",
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

type FakePipeline = {
  id: number;
  sha: string;
  ref: string;
  status: string;
  source?: string;
  tag?: boolean;
};
type FakeJob = { id: number; name: string; status: string; allow_failure?: boolean };

/**
 * GitLab's pipeline API as commitPipeline reads it, newest first and 20 a page
 * unless more are asked for. Like GitLab, the list never says whether a
 * pipeline ran for a tag; only a pipeline's full record does. Rows are not
 * filtered by sha or ref, so the gateway's own filter is what is tested.
 */
function pipelineApi(state: {
  pipelines: FakePipeline[];
  jobs?: Record<number, FakeJob[]>;
  bridges?: Record<number, FakeJob[]>;
  variables?: Record<number, unknown>;
  details?: Record<number, unknown>;
  mergeRequests?: Record<number, {
    iid: number;
    source_branch: string;
    target_branch: string;
    sha: string;
    state: string;
  }>;
}) {
  const requests: URL[] = [];
  const fetcher: typeof fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    requests.push(url);
    assert.equal((init.headers as Record<string, string>)["PRIVATE-TOKEN"], "token");
    const headers: Record<string, string> = { "content-type": "application/json" };
    const mergeRequest = url.pathname.match(
      /^\/api\/v4\/projects\/nomadhub%2Fmvp\/merge_requests\/(\d+)$/
    );
    if (mergeRequest) {
      const row = state.mergeRequests?.[Number(mergeRequest[1])];
      return new Response(JSON.stringify(row ?? { message: "404 Not found" }), {
        status: row ? 200 : 404,
        headers,
      });
    }
    const pipeline = url.pathname.match(
      /^\/api\/v4\/projects\/nomadhub%2Fmvp\/pipelines(?:\/(\d+)(?:\/(jobs|bridges|variables))?)?$/
    );
    let payload: unknown;
    if (!pipeline) {
      return new Response(JSON.stringify({ message: `unhandled ${url}` }), { status: 404 });
    } else if (!pipeline[1]) {
      const perPage = Number(url.searchParams.get("per_page") ?? "20");
      const page = Number(url.searchParams.get("page") ?? "1");
      const listed = [...state.pipelines]
        .sort((left, right) => right.id - left.id)
        .map(({ tag: _tag, ...row }) => row);
      payload = listed.slice((page - 1) * perPage, page * perPage);
      if (page * perPage < listed.length) headers["x-next-page"] = String(page + 1);
    } else {
      const id = Number(pipeline[1]);
      const row = state.pipelines.find((candidate) => candidate.id === id);
      if (!row) return new Response(JSON.stringify({ message: "404 Not found" }), { status: 404 });
      if (pipeline[2] === "jobs") {
        assert.equal(url.searchParams.get("include_retried"), "true", "retried jobs are read");
        payload = state.jobs?.[id] ?? [{ id: id * 10, name: "test", status: "success" }];
      } else if (pipeline[2] === "bridges") {
        payload = state.bridges?.[id] ?? [];
      } else if (pipeline[2] === "variables") {
        payload = state.variables?.[id] ?? [];
      } else {
        payload = state.details?.[id] ?? { tag: false, ...row };
      }
    }
    return new Response(JSON.stringify(payload), { status: 200, headers });
  };
  return { gateway: new GitlabLaneGateway("token", fetcher), requests };
}

test("a push pipeline with supplied variables cannot prove CI", async () => {
  const state: Parameters<typeof pipelineApi>[0] = {
    pipelines: [{ id: 720, sha: HEAD, ref: "managed/site", status: "success", source: "push" }],
    variables: { 720: [{ key: "SKIP_TESTS", value: "true" }] },
  };
  const { gateway, requests } = pipelineApi(state);
  const read = () => gateway.commitPipeline({ projectPath: "nomadhub/mvp", sha: HEAD });
  const observed = await read();
  assert.equal(observed.status, "pending");
  assert.deepEqual(observed.checks, []);
  assert.match(observed.summary, /supplied variables; CI evidence is untrusted/);
  assert.equal(requests.some((url) => url.pathname.endsWith("/jobs")), false);
  assert.equal(observed.summary.includes("SKIP_TESTS"), false, "variable names and values stay private");

  state.variables = { 720: { key: "SKIP_TESTS" } };
  await assert.rejects(read(), /pipeline variables were not an array/);
});

test("a same-commit pipeline on another branch cannot prove the reviewed head", async () => {
  const state: Parameters<typeof pipelineApi>[0] = {
    pipelines: [
      { id: 812, sha: HEAD, ref: "other-branch", status: "success", source: "push" },
      { id: 811, sha: HEAD, ref: "managed/site", status: "failed", source: "push" },
    ],
  };
  const { gateway } = pipelineApi(state);
  const read = () => gateway.commitPipeline({
    projectPath: "nomadhub/mvp",
    sha: HEAD,
    ref: "managed/site",
  });
  assert.equal((await read()).pipelineId, 811, "the reviewed branch's failed CI decides");
  state.pipelines = state.pipelines.slice(0, 1);
  const absent = await read();
  assert.equal(absent.pipelineId, null, "another branch's green CI proves nothing");
  assert.equal(absent.status, "pending");
});

test("a merge-request pipeline proves only its bound source branch, target and SHA", async () => {
  const state: Parameters<typeof pipelineApi>[0] = {
    pipelines: [{
      id: 813,
      sha: HEAD,
      ref: "refs/merge-requests/17/head",
      status: "success",
      source: "merge_request_event",
    }],
    mergeRequests: {
      17: {
        iid: 17,
        source_branch: "managed/site",
        target_branch: "dev",
        sha: HEAD,
        state: "opened",
      },
    },
  };
  const { gateway, requests } = pipelineApi(state);
  const read = () => gateway.commitPipeline({
    projectPath: "nomadhub/mvp",
    sha: HEAD,
    ref: "managed/site",
    baseBranch: "dev",
    expectedMrIid: 17,
  });
  assert.equal((await read()).pipelineId, 813);
  assert.equal((await read()).status, "passing");
  assert.equal(
    requests.some((url) => url.pathname.endsWith("/merge_requests/17")),
    true,
    "the MR identity must be checked before accepting its pipeline"
  );
  assert.equal((await gateway.commitPipeline({
    projectPath: "nomadhub/mvp",
    sha: HEAD,
    ref: "managed/site",
    baseBranch: "dev",
    expectedMrIid: 18,
  })).pipelineId, null, "another MR's matching branch and SHA cannot prove CI");

  state.pipelines.push({
    id: 814,
    sha: HEAD,
    ref: "refs/merge-requests/18/head",
    status: "success",
    source: "merge_request_event",
  });
  assert.equal((await read()).pipelineId, 813, "a newer unbound MR does not hide the bound pipeline");
  state.pipelines.pop();

  delete state.mergeRequests![17];
  assert.equal((await read()).pipelineId, null, "a deleted MR cannot prove CI");
  state.mergeRequests![17] = {
    iid: 17,
    source_branch: "managed/site",
    target_branch: "dev",
    sha: HEAD,
    state: "opened",
  };

  state.mergeRequests![17]!.source_branch = "other-branch";
  assert.equal((await read()).pipelineId, null, "another source branch cannot prove CI");
  state.mergeRequests![17]!.source_branch = "managed/site";
  state.mergeRequests![17]!.target_branch = "other-target";
  assert.equal((await read()).pipelineId, null, "another target cannot prove CI");
  state.mergeRequests![17]!.target_branch = "dev";
  state.mergeRequests![17]!.sha = NEXT_HEAD;
  assert.equal((await read()).pipelineId, null, "a stale MR cannot prove CI");
});

// Extended by /ship coverage audit with failed, canceled, skipped and manual canonical pipelines.
// Value: protects=only a successful canonical GitLab pipeline passes: failed reports failing for repair, canceled, skipped and manual wait;
//   fails_when=pipelineStatus follows the commit-status mapping (skipped counts as success), or failed falls through to pending;
//   why_new=the pipeline rows cover success and running plus one manual job; no failed, canceled, skipped or manual pipeline is read; seam=none
test("canonical GitLab evidence reads the newest exact-commit pipeline of the canonical project", async () => {
  const state: Parameters<typeof pipelineApi>[0] = { pipelines: [] };
  const { gateway, requests } = pipelineApi(state);

  const absent = await gateway.commitPipeline({ projectPath: "nomadhub/mvp", sha: MERGED, ref: "dev" });
  assert.equal(absent.pipelineId, null);
  assert.equal(absent.status, "pending");
  assert.equal(absent.summary, `no GitLab pipeline for ${MERGED.slice(0, 12)}`);
  assert.equal(requests[0]?.searchParams.get("sha"), MERGED);
  assert.equal(requests[0]?.searchParams.get("ref"), "dev");

  state.pipelines = [
    { id: 820, sha: MERGED, ref: "dev", status: "failed", source: "push" },
    { id: 822, sha: MERGED, ref: "dev", status: "success", source: "push" },
    { id: 999, sha: HEAD, ref: "dev", status: "success", source: "push" },
    { id: 1000, sha: MERGED, ref: "feature", status: "success", source: "push" },
  ];
  state.jobs = {
    822: [
      { id: 9001, name: "lint-and-test", status: "success" },
      { id: 9002, name: "deploy-review", status: "manual", allow_failure: true },
    ],
  };
  requests.length = 0;
  const merged = await gateway.commitPipeline({ projectPath: "nomadhub/mvp", sha: MERGED, ref: "dev" });
  assert.deepEqual(merged, {
    source: "gitlab",
    projectPath: "nomadhub/mvp",
    sha: MERGED,
    pipelineId: 822,
    status: "passing",
    summary: "GitLab pipeline 822 success",
    checks: [
      { name: "lint-and-test", status: "passing", id: "gitlab-job-9001" },
      { name: "deploy-review", status: "pending", id: "gitlab-job-9002" },
    ],
  });
  assert.deepEqual(
    requests.map((url) => url.pathname.replace("/api/v4/projects/nomadhub%2Fmvp", "")),
    ["/pipelines", "/pipelines/822", "/pipelines/822/variables", "/pipelines/822/jobs", "/pipelines/822/bridges"],
    "the newest candidate is read in full, then its variables, jobs and bridges"
  );

  state.pipelines = [{ id: 830, sha: MERGED, ref: "dev", status: "running", source: "push" }];
  requests.length = 0;
  const running = await gateway.commitPipeline({ projectPath: "nomadhub/mvp", sha: MERGED });
  assert.equal(running.status, "pending");
  assert.equal(running.pipelineId, 830);
  assert.equal(requests[0]?.searchParams.get("ref"), null);
  for (const [status, expected] of [
    ["failed", "failing"],
    ["canceled", "pending"],
    ["skipped", "pending"],
    ["manual", "pending"],
  ] as const) {
    state.pipelines = [{ id: 840, sha: MERGED, ref: "dev", status, source: "push" }];
    const observed = await gateway.commitPipeline({ projectPath: "nomadhub/mvp", sha: MERGED, ref: "dev" });
    assert.equal(observed.status, expected, `a ${status} canonical pipeline is ${expected}`);
  }
  await assert.rejects(
    gateway.commitPipeline({ projectPath: "nomadhub/mvp", sha: "abc" }),
    /full SHA/
  );
});

test("only the canonical project's own newest pipeline proves a commit", async () => {
  const state: Parameters<typeof pipelineApi>[0] = { pipelines: [] };
  const { gateway, requests } = pipelineApi(state);
  const read = () => gateway.commitPipeline({ projectPath: "nomadhub/mvp", sha: HEAD });

  // A newer pipeline decides, never an older green one.
  for (const [status, expected] of [
    ["running", "pending"],
    ["failed", "failing"],
    ["manual", "pending"],
  ] as const) {
    state.pipelines = [
      { id: 822, sha: HEAD, ref: "managed/site", status: "success", source: "push" },
      { id: 830, sha: HEAD, ref: "managed/site", status, source: "push" },
    ];
    const observed = await read();
    assert.equal(observed.pipelineId, 830);
    assert.equal(observed.status, expected, `a newer ${status} pipeline decides`);
  }

  // Only the project's own CI for a push or a merge request counts. A commit
  // status anyone with Developer access can post opens an external pipeline;
  // a child pipeline is a slice of its parent; a pipeline started by hand, by
  // API, trigger or schedule can carry variables that skip jobs.
  for (const source of [
    "external",
    "parent_pipeline",
    "pipeline",
    "web",
    "api",
    "trigger",
    "schedule",
    "chat",
    "webide",
  ]) {
    state.pipelines = [
      { id: 500, sha: HEAD, ref: "managed/site", status: "failed", source: "push" },
      { id: 501, sha: HEAD, ref: "managed/site", status: "success", source },
    ];
    const observed = await read();
    assert.equal(observed.pipelineId, 500, source);
    assert.equal(observed.status, "failing");
  }
  for (const source of ["merge_request_event", "external_pull_request_event"]) {
    state.pipelines = [
      { id: 500, sha: HEAD, ref: "managed/site", status: "failed", source: "push" },
      { id: 501, sha: HEAD, ref: "refs/merge-requests/17/head", status: "success", source },
    ];
    assert.equal((await read()).pipelineId, 501, `a ${source} pipeline proves the head`);
  }
  state.pipelines = [{ id: 501, sha: HEAD, ref: "managed/site", status: "success", source: "external" }];
  requests.length = 0;
  assert.equal((await read()).pipelineId, null, "a lone external pipeline proves nothing");
  assert.equal(requests.length, 1, "a pipeline that cannot count is never read in full");
});

// Extended by /ship coverage audit with a parent pipeline behind more than a page of its own child pipelines.
// Value: protects=the canonical pipeline is found behind more than a page of newer child pipelines, as GitLab answers 20 a page by default;
//   fails_when=the pipeline list stops paging or asks for fewer than 100 a page, so the parent behind 150 newer child pipelines is not found within two pages;
//   why_new=the fake GitLab returned every pipeline at once, so the page size the pipeline list asks for was never exercised; seam=none
test("the canonical pipeline is found behind more than a page of child pipelines", async () => {
  const { gateway, requests } = pipelineApi({
    pipelines: [
      { id: 600, sha: HEAD, ref: "managed/site", status: "success", source: "push" },
      ...Array.from({ length: 150 }, (_, index) => ({
        id: 601 + index,
        sha: HEAD,
        ref: "managed/site",
        status: "running",
        source: "parent_pipeline",
      })),
    ],
  });
  const observed = await gateway.commitPipeline({ projectPath: "nomadhub/mvp", sha: HEAD });
  assert.equal(observed.pipelineId, 600);
  assert.equal(observed.status, "passing");
  assert.deepEqual(
    requests
      .filter((url) => url.pathname.endsWith("/pipelines"))
      .map((url) => url.searchParams.get("page")),
    ["1", "2"],
    "pages are read only until the pipeline turns up"
  );
});

test("a tag pipeline is skipped once its full record shows the tag", async () => {
  const state: Parameters<typeof pipelineApi>[0] = {
    pipelines: [
      { id: 500, sha: HEAD, ref: "main", status: "failed", source: "push", tag: false },
      { id: 501, sha: HEAD, ref: "main", status: "success", source: "push", tag: true },
    ],
  };
  const { gateway, requests } = pipelineApi(state);
  const read = () => gateway.commitPipeline({ projectPath: "nomadhub/mvp", sha: HEAD, ref: "main" });

  // A tag named like the branch matches the ref filter; only its record tells.
  const observed = await read();
  assert.equal(observed.pipelineId, 500);
  assert.equal(observed.status, "failing");
  assert.deepEqual(
    requests
      .filter((url) => /\/pipelines\/\d+$/.test(url.pathname))
      .map((url) => url.pathname.split("/").at(-1)),
    ["501", "500"]
  );

  // A record that does not say, or that disagrees with its list entry, is
  // never trusted.
  for (const detail of [
    { id: 501, sha: HEAD, ref: "main", status: "success", source: "push" },
    { id: 501, sha: MERGED, ref: "main", status: "success", source: "push", tag: false },
    { id: 501, sha: HEAD, ref: "main", status: "success", source: "web", tag: false },
    { id: 502, sha: HEAD, ref: "main", status: "success", source: "push", tag: false },
  ]) {
    state.details = { 501: detail };
    await assert.rejects(read(), /did not match its list entry/, JSON.stringify(detail));
  }

  // Past ten tag pipelines the gate waits instead of reading on.
  state.details = undefined;
  state.pipelines = [
    { id: 400, sha: HEAD, ref: "main", status: "success", source: "push", tag: false },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: 401 + index,
      sha: HEAD,
      ref: "main",
      status: "success",
      source: "push",
      tag: true,
    })),
  ];
  const hidden = await read();
  assert.equal(hidden.pipelineId, null);
  assert.equal(hidden.status, "pending");
  assert.equal(
    hidden.summary,
    `GitLab pipeline search for ${HEAD.slice(0, 12)} stopped after 10 tag pipelines`,
    "a search cut short never claims that no pipeline exists"
  );

  state.pipelines = [{ id: 401, sha: HEAD, ref: "main", status: "success", source: "push", tag: true }];
  assert.equal(
    (await read()).summary,
    `no GitLab pipeline for ${HEAD.slice(0, 12)} besides tag pipelines`
  );
});

test("a pipeline passes only when every job's last run agrees", async () => {
  const state: Parameters<typeof pipelineApi>[0] = {
    pipelines: [{ id: 700, sha: HEAD, ref: "managed/site", status: "success", source: "push" }],
  };
  const { gateway } = pipelineApi(state);
  const read = () => gateway.commitPipeline({ projectPath: "nomadhub/mvp", sha: HEAD });

  // A commit status posted under a job's name retires that job and turns the
  // pipeline green; the job's own last run still failed.
  state.jobs = { 700: [{ id: 70, name: "test", status: "failed" }] };
  let observed = await read();
  assert.equal(observed.status, "failing");
  assert.equal(observed.summary, "GitLab pipeline 700 success; jobs failed: test");
  assert.deepEqual(observed.checks, [{ name: "test", status: "failing", id: "gitlab-job-70" }]);

  // A job retried to green counts by its last run.
  state.jobs = {
    700: [
      { id: 75, name: "test", status: "success" },
      { id: 70, name: "test", status: "failed" },
    ],
  };
  observed = await read();
  assert.equal(observed.status, "passing");
  assert.deepEqual(observed.checks, [{ name: "test", status: "passing", id: "gitlab-job-75" }]);

  // A bridge to a downstream pipeline is a job too.
  state.jobs = { 700: [{ id: 75, name: "test", status: "success" }] };
  state.bridges = { 700: [{ id: 76, name: "e2e", status: "failed" }] };
  observed = await read();
  assert.equal(observed.status, "failing");
  assert.match(observed.summary, /jobs failed: e2e$/);
  state.bridges = undefined;

  // Weighed as GitLab weighs them for the pipeline.
  for (const [job, expected] of [
    [{ status: "skipped" }, "passing"],
    [{ status: "failed", allow_failure: true }, "passing"],
    [{ status: "canceled", allow_failure: true }, "passing"],
    [{ status: "manual", allow_failure: true }, "passing"],
    [{ status: "manual" }, "pending"],
    [{ status: "canceled" }, "pending"],
    [{ status: "running" }, "pending"],
    [{ status: "failed" }, "failing"],
  ] as const) {
    state.jobs = { 700: [{ id: 75, name: "test", status: "success" }, { id: 77, name: "deploy", ...job }] };
    observed = await read();
    assert.equal(observed.status, expected, JSON.stringify(job));
  }
  assert.equal(observed.summary, "GitLab pipeline 700 success; jobs failed: deploy");
  state.jobs = { 700: [{ id: 77, name: "deploy", status: "manual" }] };
  assert.equal((await read()).summary, "GitLab pipeline 700 success; jobs not finished: deploy");

  // A named check passes only on its job's own success.
  state.jobs = { 700: [{ id: 78, name: "lint", status: "failed", allow_failure: true }] };
  observed = await read();
  assert.equal(observed.status, "passing");
  assert.deepEqual(observed.checks, [{ name: "lint", status: "failing", id: "gitlab-job-78" }]);

  // A green pipeline with no jobs to show for it proves nothing.
  state.jobs = { 700: [] };
  observed = await read();
  assert.equal(observed.status, "pending");
  assert.equal(observed.summary, "GitLab pipeline 700 success; no jobs");

  state.jobs = { 700: [{ name: "test", status: "success" } as FakeJob] };
  await assert.rejects(read(), /job without an id or name/);
});


test("the pipeline search fails closed on a malformed list and stops at its page bound", async () => {
  const answer = (payload: unknown, nextPage?: string): typeof fetch => async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json", ...(nextPage ? { "x-next-page": nextPage } : {}) },
    });
  const read = (fetcher: typeof fetch) =>
    new GitlabLaneGateway("token", fetcher).commitPipeline({ projectPath: "nomadhub/mvp", sha: HEAD });
  await assert.rejects(read(answer({ message: "oops" })), /pipeline list was not an array/);
  await assert.rejects(read(answer([], "1")), /invalid pagination cursor/);
  await assert.rejects(read(answer([], "next")), /invalid pagination cursor/);

  // Twenty pages of child pipelines hide the parent: the gate waits and says why.
  const { gateway, requests } = pipelineApi({
    pipelines: [
      { id: 100, sha: HEAD, ref: "managed/site", status: "success", source: "push" },
      ...Array.from({ length: 2000 }, (_, index) => ({
        id: 101 + index,
        sha: HEAD,
        ref: "managed/site",
        status: "running",
        source: "parent_pipeline",
      })),
    ],
  });
  const capped = await gateway.commitPipeline({ projectPath: "nomadhub/mvp", sha: HEAD });
  assert.equal(capped.pipelineId, null);
  assert.equal(
    capped.summary,
    `GitLab pipeline search for ${HEAD.slice(0, 12)} stopped after 20 pages of pipelines`
  );
  assert.equal(requests.length, 20, "no more than twenty pages are read");
});
