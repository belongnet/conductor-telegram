import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCliOutput,
  parseCliOutputDetailed,
  parseRouteJson,
  parseRouteJsonDetailed,
  type RouteParseFailureReason,
  type RouteParseResult,
} from "../src/bot/ai-router.js";

function assertParseFailure(
  result: RouteParseResult,
  reason: RouteParseFailureReason
): void {
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected route parser to reject the payload");
  assert.equal(result.reason, reason);
  assert.equal(typeof result.preview, "string");
}

test("CLI envelope accepts new route with blank irrelevant workspaceId", () => {
  const payload = {
    transcript: "voice transcript",
    action: "new",
    repoName: "aideployco",
    workspaceId: "",
    prompt: "Create the README section.",
  };
  const output = JSON.stringify({
    type: "result",
    result: JSON.stringify(payload),
  });

  assert.deepEqual(parseCliOutput(output), {
    transcript: "voice transcript",
    action: "new",
    repoName: "aideployco",
    workspaceId: undefined,
    prompt: "Create the README section.",
  });
});

test("new routes require a non-empty repoName", () => {
  const base = {
    transcript: "voice transcript",
    action: "new",
    prompt: "Create the README section.",
  };

  for (const repoName of [undefined, null, "", 42]) {
    const payload =
      repoName === undefined ? base : { ...base, repoName };
    assert.equal(parseRouteJson(JSON.stringify(payload)), null);
  }
});

test("existing route accepts null irrelevant repoName", () => {
  const payload = {
    transcript: "follow-up",
    action: "existing",
    repoName: null,
    workspaceId: "workspace-1",
    prompt: "Apply that fix.",
  };

  assert.deepEqual(parseRouteJson(JSON.stringify(payload)), {
    transcript: "follow-up",
    action: "existing",
    repoName: undefined,
    workspaceId: "workspace-1",
    prompt: "Apply that fix.",
  });
});

test("existing route accepts blank irrelevant repoName", () => {
  const payload = {
    transcript: "follow-up",
    action: "existing",
    repoName: "",
    workspaceId: "workspace-1",
    prompt: "Apply that fix.",
  };

  assert.deepEqual(parseRouteJson(JSON.stringify(payload)), {
    transcript: "follow-up",
    action: "existing",
    repoName: undefined,
    workspaceId: "workspace-1",
    prompt: "Apply that fix.",
  });
});

test("existing route can fall back to repo when workspaceId is missing", () => {
  const payload = {
    transcript: "follow-up",
    action: "existing",
    repoName: "conductor-telegram",
    workspaceId: null,
    prompt: "Apply that fix.",
  };

  assert.deepEqual(parseRouteJson(JSON.stringify(payload)), {
    transcript: "follow-up",
    action: "existing",
    repoName: "conductor-telegram",
    workspaceId: undefined,
    prompt: "Apply that fix.",
  });
});

test("existing routes require a workspaceId or repoName fallback", () => {
  const base = {
    transcript: "follow-up",
    action: "existing",
    prompt: "Apply that fix.",
  };

  for (const workspaceId of [undefined, null, "", 42]) {
    const payload =
      workspaceId === undefined ? base : { ...base, workspaceId };
    assert.equal(parseRouteJson(JSON.stringify(payload)), null);
  }
});

test("router JSON inside markdown code fences still parses", () => {
  const text = [
    "```json",
    JSON.stringify({
      transcript: "voice transcript",
      action: "new",
      repoName: "conductor-telegram",
      workspaceId: null,
      prompt: "Fix voice routing.",
    }),
    "```",
  ].join("\n");

  assert.deepEqual(parseRouteJson(text), {
    transcript: "voice transcript",
    action: "new",
    repoName: "conductor-telegram",
    workspaceId: undefined,
    prompt: "Fix voice routing.",
  });
});

test("route parser reports stable failure reasons", () => {
  const cases: Array<[RouteParseFailureReason, string]> = [
    ["invalid_json", "not json"],
    ["invalid_action", JSON.stringify({ action: "archive", prompt: "Do it." })],
    ["missing_prompt", JSON.stringify({ action: "new", repoName: "conductor-telegram" })],
    [
      "invalid_optional_repo_name",
      JSON.stringify({ action: "existing", repoName: 42, workspaceId: "workspace-1", prompt: "Do it." }),
    ],
    [
      "invalid_optional_workspace_id",
      JSON.stringify({ action: "new", repoName: "conductor-telegram", workspaceId: 42, prompt: "Do it." }),
    ],
    ["missing_new_repo", JSON.stringify({ action: "new", prompt: "Do it." })],
    ["missing_existing_target", JSON.stringify({ action: "existing", prompt: "Do it." })],
  ];

  for (const [reason, payload] of cases) {
    assertParseFailure(parseRouteJsonDetailed(payload), reason);
  }
});

test("CLI envelope reports malformed result shape", () => {
  const output = JSON.stringify({
    type: "result",
    result: { action: "new", repoName: "conductor-telegram", prompt: "Do it." },
  });

  assertParseFailure(parseCliOutputDetailed(output), "invalid_cli_envelope");
});
