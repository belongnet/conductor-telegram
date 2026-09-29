import test from "node:test";
import assert from "node:assert/strict";
import { clip, creationKey, taskTitle, threadLabel, threadName, threadTitle } from "../src/cloud/names.js";
import { recoverableProviderError, stopReason } from "../src/cloud/engine.js";

test("a task is called by its first line, cut at a word", () => {
  assert.equal(taskTitle("fix these screens", "Telegram task"), "fix these screens");
  assert.equal(taskTitle("\n  Fix   the\tlogin  bug \nwith the logs attached", "Telegram task"), "Fix the login bug");
  assert.equal(taskTitle("", "long-events: 4 attachments"), "long-events: 4 attachments");
  assert.equal(taskTitle(" \n \n", "Telegram task"), "Telegram task");
  assert.equal(taskTitle("Investigate why the auxiliary model route fails with out of credits and fix it", "Telegram task"),
    "Investigate why the auxiliary model route fails with out…");
  // A word too long to cut at still fits.
  assert.equal(taskTitle("x".repeat(80), "Telegram task"), `${"x".repeat(59)}…`);
});

test("a gateway thread's creation key reads as what the thread is for", () => {
  assert.equal(threadName("Task recover:e5ce7c57-7238-4110-9884-bf658268959d:35dc46aa-cda1-45af-a4e3-526992887427"), "Recovery");
  assert.equal(threadName("Review route:3ea184d3a1cdc9025a0307ea21b64110:confirmed:action"), "Review");
  assert.equal(threadName("Task update:12:thread"), "Thread");
  assert.equal(threadName("Task update:12:thread", "Unnamed"), "Thread", "a key reads as its purpose, never as a missing name");
  // Real names pass through, including ones that start like a key.
  assert.equal(threadName("Task list"), "Task list");
  assert.equal(threadName("Task operator-provider-codex-20260910"), "Task operator-provider-codex-20260910");
  assert.equal(threadName("Review the auth module"), "Review the auth module");
  assert.equal(threadName(undefined, "Untitled"), "Untitled");
  assert.equal(threadLabel("Task recover:s1:m1", "gpt-6-astra"), "Recovery · gpt-6-astra");
  assert.equal(threadLabel("Auxiliary LLM Error Fix", "fable-5-1"), "Auxiliary LLM Error Fix · fable-5-1");
  assert.equal(threadLabel(undefined, undefined), "Untitled");
  assert.equal(creationKey("b9bed051-9e94-41af-802b-fa5be3b58b9d"), "telegram-b9bed051-9e94-41af-802b-fa5be3b58b9d");
});

test("a provider's stop is worded to follow its name, and only a recoverable one is named", () => {
  const cases: Array<[string, string]> = [
    ["You're out of usage credits. Switch to another model to continue.", "ran out of usage credits"],
    ["insufficient credit balance", "ran out of usage credits"],
    ["429: rate limit reached", "was rate limited"],
    ["quota exhausted", "hit a usage limit"],
    ["You've hit your usage limit", "hit a usage limit"],
    ["Selected model is at capacity", "is over capacity"],
    ["Authentication failed: expired token", "could not authenticate"],
    ["The model gpt-9 does not exist or you do not have access to it", "is unavailable"],
    ["connection lost", "was interrupted"],
    ["sandbox stopped", "was interrupted"],
  ];
  for (const [detail, reason] of cases) {
    assert.equal(stopReason(detail), reason, detail);
    assert.equal(recoverableProviderError(detail), true, detail);
  }
  assert.equal(recoverableProviderError("Something odd happened."), false);
  assert.equal(stopReason("Something odd happened."), "stopped: Something odd happened");
});

test("names are cut only past their limit, a blank or model-less thread still reads well, and the most specific stop wins", () => {
  assert.equal(taskTitle("a".repeat(60), "Telegram task"), "a".repeat(60));
  assert.equal(taskTitle("a".repeat(61), "Telegram task"), `${"a".repeat(59)}…`);
  assert.equal(threadName("   ", "Untitled"), "Untitled");
  assert.equal(threadLabel("Earlier", undefined), "Earlier");
  assert.equal(threadLabel(undefined, "gpt-6-astra"), "Untitled · gpt-6-astra");
  // Matched most specific first: a rate limit is not reported as a usage limit, nor credits as either.
  assert.equal(stopReason("You've hit your rate limit for today"), "was rate limited");
  assert.equal(stopReason("Usage limit reached: you're out of credits"), "ran out of usage credits");
  // Provider output can carry secrets and run long; an unrecognised stop is scrubbed and bounded like any relayed detail.
  assert.equal(stopReason("Tool crashed with token ghp_abcdefgh12345678 in the log!!"), "stopped: Tool crashed with token [redacted] in the log");
  assert.equal(stopReason("x".repeat(300)), `stopped: ${"x".repeat(119)}…`);
});

test("a cut never splits a character in two", () => {
  const rocket = "\u{1F680}";
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.equal(clip(`${"a".repeat(99)}${rocket}`, 100), "a".repeat(99));
  assert.equal(clip(`${"a".repeat(98)}${rocket}`, 100), `${"a".repeat(98)}${rocket}`);
  assert.doesNotMatch(taskTitle(rocket.repeat(40), "Telegram task"), lone);
  assert.doesNotMatch(taskTitle(`${"修复".repeat(14)}${"\u{1F41B}".repeat(20)}`, "Telegram task"), lone);
});

test("a thread's title is taken as data: one line, no tags, nothing invisible, never a key", () => {
  assert.equal(threadTitle("Auxiliary LLM Error Fix"), "Auxiliary LLM Error Fix");
  assert.equal(threadTitle("  [lane:growth:claude] Fix\n onboarding​‮ stall\u0007 "), "Fix onboarding stall");
  assert.equal(threadTitle("[managed:growth][lane:x]"), undefined, "nothing usable is left");
  assert.equal(threadTitle("​⁠"), undefined);
  assert.equal(threadTitle("Task recover:s1:m1"), undefined, "a gateway key is no title");
  assert.equal(threadTitle(undefined), undefined);
  // Scripts that need joiners keep them.
  assert.equal(threadTitle("می‌خواهم"), "می‌خواهم");
  assert.equal(threadTitle(`${"a".repeat(99)} ${"b".repeat(20)}`), "a".repeat(99));
});

test("a real name shaped like a gateway key keeps its name", () => {
  assert.equal(threadName("Review https://github.com/org/repo/pull/3"), "Review https://github.com/org/repo/pull/3");
  assert.equal(threadName("Task JIRA-12:login"), "Task JIRA-12:login");
});

test("every stop the earlier matcher accepted is still recoverable, and worded", () => {
  const cases: Array<[string, string]> = [
    ["Server overloaded", "is over capacity"], ["401 Unauthorized", "could not authenticate"],
    ["invalid API credential", "could not authenticate"], ["Stream disconnected", "was interrupted"],
    ["Turn interrupted", "was interrupted"], ["connection closed by peer", "was interrupted"],
    ["sandbox expired", "was interrupted"], ["model claude-x not found", "is unavailable"],
    ["model gpt-9 not supported", "is unavailable"], ["the model may not exist", "is unavailable"],
    ["insufficient balance", "ran out of usage credits"], ["quota exceeded", "hit a usage limit"],
  ];
  for (const [detail, reason] of cases) {
    assert.equal(recoverableProviderError(detail), true, detail);
    assert.equal(stopReason(detail), reason, detail);
  }
});
