import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLaunchConfig } from "../src/bot/launcher.js";

/**
 * Point the Conductor settings reader at a throwaway TOML (and a missing DB so
 * the deprecated-row fallback stays silent), run the assertion, then restore
 * the real environment.
 */
function withConductorSettings(toml: string, fn: () => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-effort-"));
  const tomlPath = path.join(dir, "settings.toml");
  writeFileSync(tomlPath, toml);
  const previous = {
    settings: process.env.CONDUCTOR_SETTINGS_PATH,
    db: process.env.CONDUCTOR_DB_PATH,
    model: process.env.TELEGRAM_DEFAULT_MODEL,
    reviewModel: process.env.TELEGRAM_REVIEW_MODEL,
  };
  process.env.CONDUCTOR_SETTINGS_PATH = tomlPath;
  process.env.CONDUCTOR_DB_PATH = path.join(dir, "missing.db");
  delete process.env.TELEGRAM_DEFAULT_MODEL;
  delete process.env.TELEGRAM_REVIEW_MODEL;
  try {
    fn();
  } finally {
    restoreEnv("CONDUCTOR_SETTINGS_PATH", previous.settings);
    restoreEnv("CONDUCTOR_DB_PATH", previous.db);
    restoreEnv("TELEGRAM_DEFAULT_MODEL", previous.model);
    restoreEnv("TELEGRAM_REVIEW_MODEL", previous.reviewModel);
    rmSync(dir, { recursive: true, force: true });
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const EFFORT_TOML = `
[models]
default = "claude-fable-5"
review = "claude-fable-5"

[models.claude_code]
default_effort_level = "high"
review_effort_level = "max"

[models.codex]
default_thinking_level = "medium"
review_thinking_level = "xhigh"
`;

test("claude launches resolve effort from the claude_code settings", () => {
  withConductorSettings(EFFORT_TOML, () => {
    const prompt = resolveLaunchConfig({
      agentType: "claude",
      launchMode: "prompt",
    });
    assert.equal(prompt.claudeEffortLevel, "high");
    assert.equal(prompt.codexThinkingLevel, null);

    const review = resolveLaunchConfig({
      agentType: "claude",
      launchMode: "review",
    });
    assert.equal(review.claudeEffortLevel, "max");
  });
});

test("codex launches keep the codex thinking level and no claude effort", () => {
  withConductorSettings(EFFORT_TOML, () => {
    const prompt = resolveLaunchConfig({
      agentType: "codex",
      launchMode: "prompt",
      model: "gpt-5.5",
    });
    assert.equal(prompt.codexThinkingLevel, "medium");
    assert.equal(prompt.claudeEffortLevel, null);

    const review = resolveLaunchConfig({
      agentType: "codex",
      launchMode: "review",
      model: "gpt-5.5",
    });
    assert.equal(review.codexThinkingLevel, "xhigh");
  });
});

test("unset effort settings resolve to null rather than a default", () => {
  withConductorSettings(`[models]\ndefault = "claude-fable-5"\n`, () => {
    const prompt = resolveLaunchConfig({
      agentType: "claude",
      launchMode: "prompt",
    });
    assert.equal(prompt.claudeEffortLevel, null);
  });
});
