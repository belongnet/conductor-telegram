import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCloudRecoveryPrompt,
  formatRecoveryConversation,
  formatConductorDeepLink,
  formatRelativeTime,
  isLocalAgentAuthenticationFailure,
  isTrustedConductorLink,
  parseFleetHours,
  resolveCloudProject,
  resolveCloudProjectForRepo,
} from "../src/bot/commands.js";
import {
  claudeEventHasMeaningfulActivity,
  codexEventHasMeaningfulActivity,
  resolveRepoRemoteUrl,
  resolveSafeCloudTakeoverBranch,
  revalidateCloudTakeoverBranch,
  runClaudeAuthenticationPreflight,
} from "../src/bot/launcher.js";
import type { ConductorApiProject } from "../src/integrations/conductor-api.js";

function project(id: string, name: string): ConductorApiProject {
  return { id, name, gitRemote: `git@host:org/${id}.git` };
}

const PROJECTS: ConductorApiProject[] = [
  project("proj-alpha", "api"),
  project("proj-beta", "api-server"),
  project("proj-gamma", "web"),
];

test("cloud projects resolve by list number, id, and exact name", () => {
  // /projects list numbers are 1-based and bounded.
  assert.equal(resolveCloudProject(PROJECTS, "1")?.id, "proj-alpha");
  assert.equal(resolveCloudProject(PROJECTS, "3")?.id, "proj-gamma");
  assert.equal(resolveCloudProject(PROJECTS, "0"), null);
  assert.equal(resolveCloudProject(PROJECTS, "4"), null);

  assert.equal(resolveCloudProject(PROJECTS, "proj-beta")?.id, "proj-beta");

  // An exact (case-insensitive) name wins even when it prefixes another
  // project, so /cloud api never lands in api-server by accident.
  assert.equal(resolveCloudProject(PROJECTS, "API")?.id, "proj-alpha");
  assert.equal(resolveCloudProject(PROJECTS, " web ")?.id, "proj-gamma");
});

test("prefix references resolve only when they are unambiguous", () => {
  assert.equal(resolveCloudProject(PROJECTS, "we")?.id, "proj-gamma");
  assert.equal(resolveCloudProject(PROJECTS, "api-s")?.id, "proj-beta");

  // "ap" prefixes both api and api-server: refuse to guess.
  assert.equal(resolveCloudProject(PROJECTS, "ap"), null);
  assert.equal(resolveCloudProject(PROJECTS, "zzz"), null);
  assert.equal(resolveCloudProject(PROJECTS, ""), null);
  assert.equal(resolveCloudProject(PROJECTS, "   "), null);
  assert.equal(resolveCloudProject([], "1"), null);
});

test("default repo launches match one cloud project across git URL dialects", () => {
  const projects: ConductorApiProject[] = [
    {
      id: "proj-belong",
      name: "Belong Network",
      gitRemote: "https://github.com/belongnet/belong.git",
    },
    {
      id: "proj-api",
      name: "api",
      gitRemote: "git@github.com:belongnet/api.git",
    },
  ];

  assert.equal(
    resolveCloudProjectForRepo(
      projects,
      "belong",
      "git@github.com:belongnet/belong.git"
    )?.id,
    "proj-belong"
  );
  assert.equal(
    resolveCloudProjectForRepo(
      projects,
      "api",
      "ssh://git@github.com/belongnet/api.git"
    )?.id,
    "proj-api"
  );
  // Automatic routing requires repository identity; names remain available
  // only through the explicit /cloud command.
  assert.equal(resolveCloudProjectForRepo(projects, "API", null), null);
});

test("default repo launches refuse ambiguous cloud project matches", () => {
  const duplicateRemote = "git@github.com:belongnet/api.git";
  const projects: ConductorApiProject[] = [
    { id: "proj-a", name: "API A", gitRemote: duplicateRemote },
    { id: "proj-b", name: "API B", gitRemote: duplicateRemote },
  ];

  assert.equal(
    resolveCloudProjectForRepo(projects, "api", duplicateRemote),
    null
  );
});

test("default repo launches never use a name match when origin identifies another repo", () => {
  const projects: ConductorApiProject[] = [
    {
      id: "proj-api",
      name: "api",
      gitRemote: "git@github.com:belongnet/api.git",
    },
  ];

  assert.equal(
    resolveCloudProjectForRepo(
      projects,
      "api",
      "git@github.com:someone-else/api.git"
    ),
    null
  );
});

test("default repo launches never guess from a name or basename without an origin", () => {
  const projects: ConductorApiProject[] = [
    {
      id: "proj-billing",
      name: "Billing Service",
      gitRemote: "https://github.com/belongnet/billing.git",
    },
  ];

  assert.equal(resolveCloudProjectForRepo(projects, "billing", null), null);
  assert.equal(resolveCloudProjectForRepo(projects, "   ", null), null);
});

test("automatic routing preserves path case on unknown Git hosts", () => {
  const projects: ConductorApiProject[] = [
    {
      id: "proj-upper",
      name: "upper",
      gitRemote: "ssh://git@git.example.test/Org/API.git",
    },
    {
      id: "proj-lower",
      name: "lower",
      gitRemote: "ssh://git@git.example.test/org/api.git",
    },
  ];

  assert.equal(
    resolveCloudProjectForRepo(
      projects,
      "api",
      "git@git.example.test:Org/API.git"
    )?.id,
    "proj-upper"
  );
});

test("local auth failures are distinguished from ordinary agent errors", () => {
  assert.equal(
    isLocalAgentAuthenticationFailure({
      isError: false,
      exitCode: 0,
      resultText: "Not logged in · Please run /login",
    }),
    false
  );
  assert.equal(
    isLocalAgentAuthenticationFailure({
      isError: true,
      exitCode: 1,
      resultText: "Not logged in · Please run /login",
    }),
    true
  );
  assert.equal(
    isLocalAgentAuthenticationFailure({
      isError: true,
      exitCode: 1,
      resultText:
        "You've hit your weekly limit · resets Aug 28 at 7am (America/New_York)",
    }),
    true,
    "the attached weekly-capacity banner is a known pre-execution failure"
  );
  assert.equal(
    isLocalAgentAuthenticationFailure({
      isError: true,
      exitCode: 1,
      stderrTail: "Authentication required. Run claude /login to continue.",
    }),
    true
  );
  assert.equal(
    isLocalAgentAuthenticationFailure({
      isError: true,
      exitCode: 1,
      resultText: "Tests failed in src/auth.ts",
    }),
    false
  );
  assert.equal(
    isLocalAgentAuthenticationFailure({
      isError: true,
      exitCode: 1,
      stderrTail: "Access token is expired",
    }),
    true
  );
  assert.equal(
    isLocalAgentAuthenticationFailure({
      isError: true,
      exitCode: 1,
      stderrTail: "\u001b[31mNot logged in · Please run /login\u001b[0m",
    }),
    true,
    "CLI color codes must not hide a whole-line authentication failure"
  );
  assert.equal(
    isLocalAgentAuthenticationFailure({
      isError: true,
      exitCode: 1,
      stderrTail: "Error: Not logged in. Please run /login",
    }),
    true
  );
  assert.equal(
    isLocalAgentAuthenticationFailure({
      isError: true,
      exitCode: 1,
      stderrTail: "Token expired",
    }),
    false,
    "generic application errors are not known CLI authentication banners"
  );
  assert.equal(
    isLocalAgentAuthenticationFailure({
      isError: true,
      exitCode: 1,
      resultText:
        "AssertionError: expected access token is expired banner to be visible",
    }),
    false,
    "application/test output mentioning auth copy must not trigger takeover"
  );
  assert.equal(
    isLocalAgentAuthenticationFailure({
      isError: true,
      exitCode: 1,
      resultText: "Deployment completed and notification sent",
      stderrTail: "Not logged in · Please run /login",
    }),
    false,
    "mixed side-effect output and an auth banner must fail closed"
  );
});

test("Codex agent-message starts do not hide a completed login failure", () => {
  assert.equal(
    codexEventHasMeaningfulActivity({
      type: "item.started",
      item: { type: "agent_message" },
    }),
    false
  );
  assert.equal(
    codexEventHasMeaningfulActivity({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Not logged in · Please run /login",
      },
    }),
    false
  );
  assert.equal(
    codexEventHasMeaningfulActivity({
      type: "item.completed",
      item: { type: "agent_message", text: "I changed the deployment." },
    }),
    true
  );
  assert.equal(
    codexEventHasMeaningfulActivity({
      type: "item.started",
      item: { type: "command_execution" },
    }),
    true
  );
});

test("Claude hook lifecycle events make an auth banner unsafe to replay", () => {
  assert.equal(
    claudeEventHasMeaningfulActivity({
      type: "system",
      subtype: "hook_started",
    }),
    true
  );
  assert.equal(
    claudeEventHasMeaningfulActivity({
      type: "system",
      subtype: "hook_response",
    }),
    true
  );
  assert.equal(
    claudeEventHasMeaningfulActivity({
      type: "result",
      is_error: true,
      result:
        "You've hit your weekly limit · resets Aug 28 at 7am (America/New_York)",
    }),
    false
  );
});

test("cloud recovery carries the original task into ambiguous follow-ups", () => {
  const handoff = buildCloudRecoveryPrompt(
    "Implement resilient billing retries.",
    "Do the safer option we discussed."
  );
  assert.match(handoff, /Original workspace task:\nImplement resilient billing retries\./);
  assert.match(handoff, /Latest request that did not complete:\nDo the safer option/);

  const contextual = buildCloudRecoveryPrompt(
    "Implement resilient billing retries.",
    "Use that approach.",
    "Assistant: Option B avoids duplicate charges.\n\nUser: Choose option B."
  );
  assert.match(contextual, /Option B avoids duplicate charges/);
  assert.match(contextual, /User: Choose option B/);

  assert.equal(
    buildCloudRecoveryPrompt("Run the tests", "Run the tests"),
    "Run the tests"
  );
  assert.equal(
    buildCloudRecoveryPrompt("", "Inspect the failed deployment"),
    "Inspect the failed deployment"
  );
});

test("cloud recovery transcript budget keeps the newest decisions", () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    messageId: null,
    rowid: index + 1,
    role: "user",
    content: `decision-${index + 1} ${"x".repeat(1_480)}`,
    createdAt: `2026-07-31T00:00:${String(index).padStart(2, "0")}.000Z`,
    sentAt: null,
  }));

  const conversation = formatRecoveryConversation(messages, "", "");

  assert.match(conversation, /decision-12/);
  assert.match(conversation, /decision-11/);
  assert.doesNotMatch(conversation, /decision-1\s/);
  assert.ok(
    conversation.indexOf("decision-11") < conversation.indexOf("decision-12"),
    "retained entries remain chronological"
  );
});

test("cloud recovery preserves repeated answers in distinct contexts", () => {
  const messages = [
    { role: "assistant", content: "Approve option A?" },
    { role: "user", content: "yes" },
    { role: "assistant", content: "Approve option B?" },
    { role: "user", content: "yes" },
  ].map((message, index) => ({
    messageId: null,
    rowid: index + 1,
    ...message,
    createdAt: `2026-07-31T00:00:0${index}.000Z`,
    sentAt: null,
  }));

  const conversation = formatRecoveryConversation(
    messages,
    "Approve option A?",
    "yes"
  );

  assert.equal(conversation.match(/User: yes/g)?.length, 2);
  assert.ok(
    conversation.indexOf("Approve option A?") <
      conversation.indexOf("Approve option B?")
  );
});

test("repo origin lookup returns the configured URL and null when absent", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ct-origin-lookup-"));
  const withOrigin = path.join(tempDir, "with-origin");
  const withoutOrigin = path.join(tempDir, "without-origin");

  try {
    execFileSync("git", ["init", "-b", "main", withOrigin], { stdio: "pipe" });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:belongnet/api.git"],
      { cwd: withOrigin, stdio: "pipe" }
    );
    execFileSync("git", ["init", "-b", "main", withoutOrigin], {
      stdio: "pipe",
    });

    assert.equal(
      await resolveRepoRemoteUrl(withOrigin),
      "git@github.com:belongnet/api.git"
    );
    assert.equal(await resolveRepoRemoteUrl(withoutOrigin), null);
    assert.equal(await resolveRepoRemoteUrl(path.join(tempDir, "missing")), null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cloud takeover only uses a clean commit available on the remote", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ct-cloud-takeover-"));
  const remoteDir = path.join(tempDir, "origin.git");
  const repoDir = path.join(tempDir, "repo");
  const workspaceDir = path.join(tempDir, "workspace");
  const git = (args: string[], cwd?: string) =>
    execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

  try {
    git(["init", "--bare", remoteDir]);
    git(["symbolic-ref", "HEAD", "refs/heads/main"], remoteDir);
    git(["init", "-b", "main", repoDir]);
    git(["config", "user.name", "Cloud Test"], repoDir);
    git(["config", "user.email", "cloud@example.test"], repoDir);
    writeFileSync(path.join(repoDir, "README.md"), "base\n");
    git(["add", "README.md"], repoDir);
    git(["commit", "-m", "base"], repoDir);
    git(["remote", "add", "origin", remoteDir], repoDir);
    git(["push", "-u", "origin", "main"], repoDir);
    git(["remote", "set-head", "origin", "--auto"], repoDir);
    git(["worktree", "add", "-b", "local-task", workspaceDir, "HEAD"], repoDir);
    git(["config", "user.name", "Cloud Test"], workspaceDir);
    git(["config", "user.email", "cloud@example.test"], workspaceDir);

    const baseCommit = git(["rev-parse", "HEAD"], workspaceDir);
    assert.deepEqual(
      await resolveSafeCloudTakeoverBranch(repoDir, workspaceDir),
      { branch: "main", commit: baseCommit, reason: null }
    );
    assert.equal(
      await revalidateCloudTakeoverBranch(workspaceDir, "main", baseCommit),
      null
    );

    const dirtyPath = path.join(workspaceDir, "dirty.txt");
    writeFileSync(dirtyPath, "not uploaded\n");
    assert.deepEqual(
      await resolveSafeCloudTakeoverBranch(repoDir, workspaceDir),
      {
        branch: null,
        commit: null,
        reason: "workspace_has_uncommitted_changes",
      }
    );
    assert.equal(
      await revalidateCloudTakeoverBranch(workspaceDir, "main", baseCommit),
      "workspace_has_uncommitted_changes"
    );
    rmSync(dirtyPath);

    writeFileSync(path.join(workspaceDir, "committed.txt"), "local only\n");
    git(["add", "committed.txt"], workspaceDir);
    git(["commit", "-m", "local task"], workspaceDir);
    assert.deepEqual(
      await resolveSafeCloudTakeoverBranch(repoDir, workspaceDir),
      { branch: null, commit: null, reason: "commit_not_available_on_remote" }
    );
    assert.equal(
      await revalidateCloudTakeoverBranch(workspaceDir, "main", baseCommit),
      "workspace_changed_after_verification"
    );

    git(["push", "-u", "origin", "local-task"], workspaceDir);
    const localTaskCommit = git(["rev-parse", "HEAD"], workspaceDir);
    assert.deepEqual(
      await resolveSafeCloudTakeoverBranch(repoDir, workspaceDir),
      { branch: "local-task", commit: localTaskCommit, reason: null }
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cloud takeover fails closed when repository state cannot be read", async () => {
  const missing = path.join(os.tmpdir(), `ct-missing-${Date.now()}`);
  assert.deepEqual(await resolveSafeCloudTakeoverBranch(missing, missing), {
    branch: null,
    commit: null,
    reason: "workspace_state_unavailable",
  });
});

test("Claude authentication preflight does not block the Node event loop", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ct-auth-preflight-"));
  const executable = path.join(tempDir, "slow-auth");
  try {
    writeFileSync(
      executable,
      '#!/bin/sh\nsleep 0.2\nprintf \'{"loggedIn":true}\'\n'
    );
    chmodSync(executable, 0o755);
    let immediateRan = false;
    const probe = runClaudeAuthenticationPreflight(
      executable,
      tempDir,
      process.env
    );
    setImmediate(() => {
      immediateRan = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(immediateRan, true);
    assert.equal(await probe, null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("only http(s) deep links become Telegram anchors", () => {
  assert.equal(
    formatConductorDeepLink("https://conductor.build/workspaces/w-1"),
    '<a href="https://conductor.build/workspaces/w-1">Open in Conductor</a>'
  );
  assert.equal(
    formatConductorDeepLink("HTTP://conductor.build/w-1"),
    '<a href="HTTP://conductor.build/w-1">Open in Conductor</a>'
  );
  assert.equal(
    formatConductorDeepLink("conductor://workspace/w-1"),
    "<code>conductor://workspace/w-1</code>"
  );
  // A non-web scheme must never render as a clickable anchor.
  assert.equal(
    formatConductorDeepLink("javascript:alert(1)"),
    "<code>javascript:alert(1)</code>"
  );
  // Markup embedded in a link is neutralized before it reaches parse_mode=HTML.
  assert.equal(
    formatConductorDeepLink('https://conductor.build/<b>&x"y'),
    '<a href="https://conductor.build/&lt;b&gt;&amp;x&quot;y">Open in Conductor</a>'
  );
});

test("relative activity times bucket into minutes, hours, and days", () => {
  const now = Date.now();
  assert.equal(
    formatRelativeTime(new Date(now - 5 * 60_000).toISOString()),
    "5m ago"
  );
  // Numeric epoch values are accepted (SQL rows are unknown-typed).
  assert.equal(formatRelativeTime(now - 2 * 60_000), "2m ago");
  // Future timestamps clamp to "just now" instead of going negative.
  assert.equal(
    formatRelativeTime(new Date(now + 10 * 60_000).toISOString()),
    "0m ago"
  );
  assert.equal(
    formatRelativeTime(new Date(now - 90 * 60_000).toISOString()),
    "2h ago"
  );
  assert.equal(
    formatRelativeTime(new Date(now - 30 * 3_600_000).toISOString()),
    "30h ago"
  );
  assert.equal(
    formatRelativeTime(new Date(now - 72 * 3_600_000).toISOString()),
    "3d ago"
  );
  assert.equal(formatRelativeTime("not-a-date"), "unknown");
  assert.equal(formatRelativeTime(null), "unknown");
  assert.equal(formatRelativeTime(undefined), "unknown");
  assert.equal(formatRelativeTime({}), "unknown");
});

test("fleet hours accept only plain bounded integers", () => {
  // Empty means the default window.
  assert.equal(parseFleetHours(""), 24);
  assert.equal(parseFleetHours("1"), 1);
  assert.equal(parseFleetHours("168"), 168);

  // The parsed value is inlined into the /v0/sql interval literal, so
  // anything but a plain integer must be rejected outright.
  assert.equal(parseFleetHours("0"), null);
  assert.equal(parseFleetHours("169"), null);
  assert.equal(parseFleetHours("-1"), null);
  assert.equal(parseFleetHours("1.5"), null);
  assert.equal(parseFleetHours("1e2"), null);
  assert.equal(parseFleetHours("0x10"), null);
  assert.equal(parseFleetHours("24; DROP TABLE x"), null);
  assert.equal(parseFleetHours("24 hours"), null);
  assert.equal(parseFleetHours("NaN"), null);
  assert.equal(parseFleetHours("Infinity"), null);
});

test("deep links only become anchors for Conductor hosts", () => {
  assert.equal(
    isTrustedConductorLink("https://conductor.build/workspaces/w-1"),
    true
  );
  assert.equal(isTrustedConductorLink("https://app.conductor.build/w-1"), true);
  assert.equal(isTrustedConductorLink("HTTPS://CONDUCTOR.BUILD/w-1"), true);

  assert.equal(isTrustedConductorLink("https://evil.example/phish"), false);
  assert.equal(
    isTrustedConductorLink("https://conductor.build.evil.example/x"),
    false
  );
  assert.equal(isTrustedConductorLink("https://notconductor.build/x"), false);
  assert.equal(isTrustedConductorLink("conductor://workspace/w-1"), false);
  assert.equal(isTrustedConductorLink("javascript:alert(1)"), false);
  assert.equal(isTrustedConductorLink("not a url"), false);

  // A foreign host renders as inert code, never as a clickable anchor.
  assert.match(
    formatConductorDeepLink("https://evil.example/phish"),
    /^<code>/
  );
  assert.match(
    formatConductorDeepLink("https://conductor.build/w-1"),
    /^<a href=/
  );
});
