import test from "node:test";
import assert from "node:assert/strict";
import { parseCliOutput, parseRouteJson } from "../src/bot/ai-router.js";

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
