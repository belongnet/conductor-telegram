import test from "node:test";
import assert from "node:assert/strict";
import { parseSimpleToml } from "../src/store/conductor-settings.js";

test("Conductor settings TOML parser reads nested model and git settings", () => {
  const parsed = parseSimpleToml(`
    # user-wide Conductor settings
    [models]
    default = "gpt-5.5"
    review = "opus-1m"

    [models.codex]
    default_thinking_level = "high"
    review_thinking_level = "medium"

    [git]
    branch_prefix_type = "github_username"
    branch_prefix = "nomadcalendar"
  `);

  assert.equal(parsed.get("models.default"), "gpt-5.5");
  assert.equal(parsed.get("models.review"), "opus-1m");
  assert.equal(parsed.get("models.codex.default_thinking_level"), "high");
  assert.equal(parsed.get("git.branch_prefix_type"), "github_username");
  assert.equal(parsed.get("git.branch_prefix"), "nomadcalendar");
});
