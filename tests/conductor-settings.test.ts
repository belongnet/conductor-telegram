import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSimpleToml } from "../src/store/conductor-settings.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const git = (...args: string[]) =>
  // cwd is the repo, never the runner's: git resolves these paths from the
  // process directory, and the rules are a property of the repository rather
  // than of wherever the suite was started. The timeout keeps a wedged global
  // config (core.excludesFile on a dead mount, a stuck credential helper)
  // from hanging the run instead of reporting.
  spawnSync("git", args, {cwd: REPO_ROOT, encoding: "utf8", timeout: 10_000});

/**
 * `git check-ignore -v` prints "<source>:<line>:<pattern>\t<pathname>".
 * `--no-index` answers about the ignore rules alone: without it git skips
 * anything already in the index, so a force-added file reads exactly like a
 * deleted rule.
 */
function checkIgnore(target: string): {ignored: boolean; source: string} {
  const probe = git("check-ignore", "-v", "--no-index", "--", target);
  // 0 means a rule matched and 1 means none did. Anything else — 128 "not a
  // git repository", a spawn failure, the timeout — is a broken environment
  // rather than a verdict, so say that instead of blaming a missing rule.
  const detail = probe.error?.message ?? (probe.stderr ?? "").trim();
  assert.ok(
    probe.status === 0 || probe.status === 1,
    `git check-ignore could not answer for ${target}: ${detail || `exit ${probe.status}`}`
  );
  return {ignored: probe.status === 0, source: (probe.stdout ?? "").split("\t")[0]};
}

const isTracked = (target: string) =>
  git("ls-files", "--error-unmatch", "--", target).status === 0;

// Conductor writes machine-local overrides beside the tracked settings file.
// Left unignored they keep `git status --untracked-files=all` non-empty, which
// is what the lane validation preflight (src/lanes/controller.ts) and the cloud
// takeover guard (src/bot/launcher.ts) refuse to run against, and Conductor has
// reported them in failed `conductor/telegram-*` branch creation too.
for (const override of [
  ".conductor/settings.local.toml",
  ".conductor/settings.local.json",
]) {
  test(`${override} is ignored and untracked so it cannot strand a workspace`, () => {
    const {ignored, source} = checkIgnore(override);
    assert.ok(ignored, `${override} is not ignored — restore its .gitignore rule`);
    // The rule has to live in the committed .gitignore. A .git/info/exclude
    // entry or a global core.excludesFile silences it on one machine and
    // leaves every other clone, and CI, hitting the original failure.
    assert.match(
      source,
      /^\.gitignore:\d+:/,
      `${override} is ignored by ${source || "an unknown source"}, not by the committed .gitignore`
    );
    // check-ignore still reports the rule for a force-added file, so confirm
    // tracking separately rather than shipping someone's local override.
    assert.equal(isTracked(override), false, `${override} is committed — a machine-local override must never be tracked`);
  });
}

// The shared repo config sits in the same directory and is tracked. A blanket
// `.conductor/` rule would satisfy every assertion above while also swallowing
// this file, so pin that boundary instead of the exact pattern text — which
// leaves the rules free to be rewritten as long as they stay correct.
test(".conductor/settings.toml stays tracked and unignored", () => {
  assert.equal(
    checkIgnore(".conductor/settings.toml").ignored,
    false,
    "the local-override rules must not widen to cover the shared Conductor config"
  );
  assert.equal(isTracked(".conductor/settings.toml"), true, ".conductor/settings.toml must stay tracked");
});

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
