import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb } from "../src/store/db.js";
import {
  createWorkspace,
  consumeMergeIntent,
  createMergeIntent,
  getMergeIntent,
  getWorkspaceByName,
  updateWorkspaceConductorName,
} from "../src/store/queries.js";
import {
  buildExactHeadMergeArgs,
  canMergePr,
  matchesExpectedPrHead,
  normalizePrState,
  summarizeChecks,
  workspaceBranch,
} from "../src/bot/github.js";
import { formatPrCard } from "../src/bot/pr-ui.js";
import type { PrRecord, Workspace } from "../src/types/index.js";

test("workspace name lookup refuses ambiguous city names unless scoped", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-pr-gateway-"));
  try {
    getDb(path.join(dir, "bot.db"));
    const a = createWorkspace({
      name: "a",
      prompt: "one",
      repoPath: "/repos/a",
      telegramChatId: "1",
    });
    const b = createWorkspace({
      name: "b",
      prompt: "two",
      repoPath: "/repos/b",
      telegramChatId: "1",
    });
    updateWorkspaceConductorName(a.id, "rotterdam");
    updateWorkspaceConductorName(b.id, "rotterdam");

    assert.equal(getWorkspaceByName("rotterdam"), undefined);
    assert.equal(getWorkspaceByName("rotterdam", { repoPath: "/repos/a" })?.id, a.id);
    assert.equal(getWorkspaceByName("rotterdam", { repoPath: "/repos/b" })?.id, b.id);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PR state helpers normalize GitHub state and check rollups", () => {
  assert.equal(normalizePrState("OPEN"), "open");
  assert.equal(normalizePrState("MERGED"), "merged");
  assert.equal(normalizePrState("unexpected"), "unknown");

  assert.deepEqual(
    summarizeChecks([
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "COMPLETED", conclusion: "SKIPPED" },
    ]),
    { status: "passing", summary: "2 passing" }
  );
  assert.equal(
    summarizeChecks([{ status: "COMPLETED", conclusion: "FAILURE" }]).status,
    "failing"
  );
  assert.equal(summarizeChecks([{ status: "IN_PROGRESS" }]).status, "pending");
});

test("PR card exposes merge readiness only for open passing clean PRs", () => {
  const workspace = sampleWorkspace();
  const record: PrRecord = {
    workspaceId: workspace.id,
    repoPath: workspace.repoPath,
    branch: "belongcond/oslo",
    prNumber: 42,
    prUrl: "https://github.com/belongnet/conductor-telegram/pull/42",
    title: "Ship it",
    state: "open",
    isDraft: false,
    headRef: "belongcond/oslo",
    headSha: "a".repeat(40),
    baseRef: "main",
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    checksStatus: "passing",
    checksSummary: "3 passing",
    branchExists: true,
    lastCheckedAt: "2026-05-14T00:00:00.000Z",
    lastError: null,
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
  };

  assert.equal(workspaceBranch(workspace), "belongcond/oslo");
  assert.equal(canMergePr(record), true);
  assert.match(formatPrCard(workspace, record), /ready to merge/);

  assert.equal(canMergePr({ ...record, checksStatus: "pending" }), false);
  assert.equal(canMergePr({ ...record, isDraft: true }), false);
  assert.equal(canMergePr({ ...record, reviewDecision: null }), false);
  assert.equal(canMergePr({ ...record, headSha: null }), false);
  assert.equal(canMergePr({ ...record, headSha: "not-an-oid" }), false);
  assert.equal(canMergePr({ ...record, prNumber: null }), false);
  assert.equal(canMergePr({ ...record, mergeable: "CONFLICTING" }), false);
});

test("merge confirmations are requester-bound, single-use, and exact-SHA", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-merge-intent-"));
  try {
    getDb(path.join(dir, "bot.db"));
    const workspace = createWorkspace({
      name: "merge-ready",
      prompt: "ship safely",
      repoPath: "/repos/app",
      telegramChatId: "1",
    });
    const first = createMergeIntent({
      workspaceId: workspace.id,
      prNumber: 42,
      headSha: "A".repeat(40),
      requestedBy: "owner",
    });
    assert.equal(first.headSha, "a".repeat(40));

    const second = createMergeIntent({
      workspaceId: workspace.id,
      prNumber: 42,
      headSha: "b".repeat(40),
      requestedBy: "owner",
    });
    assert.ok(getMergeIntent(first.intentId)?.consumedAt);
    assert.equal(consumeMergeIntent(second.intentId, "other"), undefined);
    assert.equal(consumeMergeIntent(second.intentId, "owner")?.headSha, "b".repeat(40));
    assert.equal(consumeMergeIntent(second.intentId, "owner"), undefined);

    assert.throws(
      () =>
        createMergeIntent({
          workspaceId: workspace.id,
          prNumber: 42,
          headSha: "short",
          requestedBy: "owner",
        }),
      /full Git object ID/
    );
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitHub merge command pins the confirmed head commit", () => {
  const workspace = sampleWorkspace();
  const record: PrRecord = {
    workspaceId: workspace.id,
    repoPath: workspace.repoPath,
    branch: "belongcond/oslo",
    prNumber: 42,
    prUrl: "https://github.com/belongnet/conductor-telegram/pull/42",
    title: "Ship it",
    state: "open",
    isDraft: false,
    headRef: "belongcond/oslo",
    headSha: "a".repeat(40),
    baseRef: "main",
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    checksStatus: "passing",
    checksSummary: "3 passing",
    branchExists: true,
    lastCheckedAt: "2026-05-14T00:00:00.000Z",
    lastError: null,
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
  };

  assert.equal(matchesExpectedPrHead(record, "a".repeat(40)), true);
  assert.equal(matchesExpectedPrHead(record, "b".repeat(40)), false);
  assert.deepEqual(
    buildExactHeadMergeArgs({
      prNumber: 42,
      repoSlug: "belongnet/conductor-telegram",
      expectedHeadSha: "A".repeat(40),
    }),
    [
      "pr",
      "merge",
      "42",
      "--repo",
      "belongnet/conductor-telegram",
      "--squash",
      "--delete-branch",
      "--match-head-commit",
      "a".repeat(40),
    ]
  );
});

function sampleWorkspace(): Workspace {
  return {
    id: "workspace-1",
    name: "repo-1",
    prompt: "ship it",
    status: "done",
    repoPath: "/repos/conductor-telegram",
    createdAt: "2026-05-14T00:00:00.000Z",
    telegramChatId: "1",
    telegramMessageId: null,
    conductorWorkspaceName: "oslo",
    conductorWorkspaceId: "workspace-1",
    conductorSessionId: "session-1",
    conductorBackendKind: "local",
    lastForwardedMessageRowid: 0,
    telegramThreadId: null,
    archivedAt: null,
  };
}
