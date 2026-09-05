import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ConductorApiMessage,
  ConductorApiProject,
  ConductorApiSession,
  ConductorApiWorkspace,
} from "../src/integrations/conductor-api.js";
import type { GithubPrPolicySnapshot } from "../src/bot/github.js";
import {
  applyLegacyImport,
  planLegacyImport,
  type LegacyConductorGateway,
  type LegacyImportPlan,
} from "../src/lanes/legacy-import.js";
import { parseLaneManifest } from "../src/lanes/manifest.js";
import { SqliteLaneStateStore } from "../src/lanes/state-store-sqlite.js";

const HEAD = "a".repeat(40);
const PR = "https://github.com/example-org/example-repo/pull/7";

function manifest() {
  return parseLaneManifest(
    {
      version: 2,
      global: {
        provider_capacity: { claude: 3, codex: 2, cursor: 2 },
        provider_models: {
          claude: "fable-5-1",
          codex: "gpt-5.6-sol",
          cursor: "grok-4.6",
        },
      },
      lanes: ["L1b", "L1b2"].map((id) => ({
        id,
        repository: { owner: "example-org", name: "example-repo", base_branch: "main" },
        prompt: { path: `${id}.md`, sha256: "b".repeat(64) },
        priority: 1,
        preferred_providers: ["claude"],
        fallback_providers: ["codex", "cursor"],
        dependencies: [],
        policy: { kind: "one_shot" },
        delivery_adapter: { kind: "github" },
        merge_policy: {
          method: "squash",
          auto_merge: true,
          deploy_notes: "",
          replay_notes: "",
        },
        validation_profile: { commands: [["npm", "test"]], probes: [] },
        managed_tags: ["managed:growth", `lane:${id}`],
      })),
    },
    "/tmp/manifest.json",
    { verifyPrompts: false }
  );
}

function workspace(id: string, name: string, lastActivityAt: string, archived = false): ConductorApiWorkspace {
  return {
    id,
    name,
    createdAt: lastActivityAt,
    lastActivityAt,
    deepLink: `conductor://workspace/${id}`,
    state: archived ? "archived" : "sleeping",
    // The current Cloud API reports lifecycle state but may leave archivedAt
    // null, which was the shape behind the duplicate-lane incident.
    archivedAt: null,
  };
}

function assistant(sessionId: string, text: string): ConductorApiMessage {
  return {
    id: `message-${sessionId}`,
    sessionId,
    sessionIndex: 1,
    type: "agent",
    content: {
      type: "agent",
      rawPayload: {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      },
    },
    receivedAt: "2026-09-04T12:00:00Z",
  };
}

function executed(sessionId: string, command = "git status --short"): ConductorApiMessage {
  return {
    id: `execution-${sessionId}`,
    sessionId,
    sessionIndex: 2,
    type: "tool",
    content: {
      type: "commandExecution",
      id: `command-${sessionId}`,
      command,
      status: "completed",
      exitCode: 0,
    },
    receivedAt: "2026-09-04T12:01:00Z",
  };
}

test("legacy import uses exact lane tags and prefers current-head progress over newer quota shells", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-import-"));
  const queue = path.join(root, "queue.json");
  fs.writeFileSync(
    queue,
    JSON.stringify({
      lanes: [
        {
          id: "L1b",
          provider: "claude",
          repo_url: "https://github.com/example-org/example-repo",
          workspace_id: "workspace-l1b",
          session_id: "session-l1b",
        },
        {
          id: "L1b2",
          provider: "claude",
          repo_url: "https://github.com/example-org/example-repo",
          workspace_id: "workspace-good",
          session_id: "session-good",
          pr_url: PR,
        },
      ],
      watch: [{ session_id: "ignored-interactive-chat" }],
    })
  );
  const workspaces = [
    workspace("workspace-quota", "[lane:L1b2:claude] replacement-v8", "2026-09-04T14:00:00Z"),
    workspace("workspace-good", "[lane:L1b2:claude] current PR", "2026-09-04T13:00:00Z"),
    workspace("workspace-archived", "[lane:L1b2:claude] archived", "2026-09-04T15:00:00Z", true),
    workspace("workspace-l1b", "[lane:L1b:claude] part one", "2026-09-04T10:00:00Z"),
  ];
  const sessions = new Map<string, ConductorApiSession[]>(
    workspaces.map((entry) => [
      entry.id,
      [
        {
          id: entry.id.replace("workspace", "session"),
          name: "legacy",
          createdAt: entry.createdAt,
          deepLink: `conductor://session/${entry.id}`,
          archivedAt: null,
        },
      ],
    ])
  );
  sessions.set("workspace-good", [
    {
      id: "session-good",
      name: "legacy pinned session",
      createdAt: "2026-09-04T11:00:00Z",
      deepLink: "conductor://session/session-good",
      archivedAt: null,
    },
    {
      id: "session-good-current",
      name: "newer current-head session",
      createdAt: "2026-09-04T13:00:00Z",
      deepLink: "conductor://session/session-good-current",
      archivedAt: null,
    },
  ]);
  const messages = new Map<string, ConductorApiMessage[]>([
    ["session-quota", [assistant("session-quota", "You're out of usage credits. Switch to another model to continue.")]],
    ["session-good", [assistant("session-good", "Pinned session is stale and has no current-head evidence.")]],
    [
      "session-good-current",
      [assistant("session-good-current", `Updated ${PR} at exact head ${HEAD}.`)],
    ],
    ["session-archived", [assistant("session-archived", `Old ${PR} ${HEAD}`)]],
    [
      "session-l1b",
      [
        assistant("session-l1b", "Part one made verified progress."),
        executed("session-l1b"),
      ],
    ],
  ]);
  const conductor: LegacyConductorGateway = {
    async listProjects(): Promise<ConductorApiProject[]> {
      return [
        {
          id: "project-1",
          name: "example",
          gitRemote: "https://github.com/example-org/example-repo",
        },
      ];
    },
    async listProjectWorkspaces() {
      return [...workspaces].reverse();
    },
    async getWorkspace(id) {
      return workspaces.find((entry) => entry.id === id)!;
    },
    async listWorkspaceSessions(id) {
      return sessions.get(id) ?? [];
    },
    async getSessionMessageTail(id) {
      return messages.get(id) ?? [];
    },
    async getSessionStatus() {
      return { status: "idle" as const };
    },
  };
  const pr: GithubPrPolicySnapshot = {
    url: PR,
    repoOwner: "example-org",
    repoName: "example-repo",
    prNumber: 7,
    state: "open",
    isDraft: false,
    headBranch: "managed/l1b2",
    baseBranch: "main",
    headSha: HEAD,
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    checksStatus: "passing",
    checksSummary: "green",
    mergeCommitSha: null,
    reviews: [],
  };
  try {
    const plan = await planLegacyImport({
      sourcePath: queue,
      manifest: manifest(),
      conductor,
      github: { refreshPr: async () => pr },
    });
    assert.equal(plan.ignoredWatchEntries, 1);
    assert.deepEqual(plan.duplicateWorkspaceIds, []);
    assert.deepEqual(plan.duplicatePrUrls, []);
    assert.equal(plan.lanes[0].workspace?.workspaceId, "workspace-l1b");
    assert.equal(plan.lanes[0].candidates.length, 1, "L1b must not prefix-match L1b2");
    assert.equal(
      plan.lanes[0].legacyVerified,
      false,
      "a legacy tag without an exact PR/head relationship cannot grant archive trust"
    );
    assert.equal(plan.lanes[1].disposition, "adopt");
    assert.equal(plan.lanes[1].reason, "current PR head transcript match");
    assert.equal(plan.lanes[1].workspace?.workspaceId, "workspace-good");
    assert.equal(
      plan.lanes[1].workspace?.sessionId,
      "session-good-current",
      "a pinned legacy session must remain only a candidate"
    );
    assert.equal(plan.lanes[1].legacyVerified, true);
    assert.equal(
      plan.lanes[1].candidates.find((entry) => entry.workspaceId === "workspace-quota")?.verifiedProgress,
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy review/final/merge/validation tags require an exact PR-head relationship", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-import-pipeline-tags-"));
  const queue = path.join(root, "queue.json");
  fs.writeFileSync(
    queue,
    JSON.stringify({
      lanes: [
        {
          id: "L1b2",
          provider: "claude",
          repo_url: "https://github.com/example-org/example-repo",
          pr_url: PR,
        },
      ],
    })
  );
  const workspaces = [
    workspace(
      "workspace-final",
      "[final:L1b2:codex] commissioned current-head final",
      "2026-09-04T13:00:00Z"
    ),
    workspace(
      "workspace-validation-unbound",
      "[validate:L1b2:cursor] newer but not PR-bound",
      "2026-09-04T14:00:00Z"
    ),
    workspace(
      "workspace-other-lane",
      "[review:L1b:codex] must not prefix-match",
      "2026-09-04T15:00:00Z"
    ),
  ];
  const conductor: LegacyConductorGateway = {
    async listProjects() {
      return [
        {
          id: "project-1",
          name: "example",
          gitRemote: "https://github.com/example-org/example-repo",
        },
      ];
    },
    async listProjectWorkspaces() {
      return workspaces;
    },
    async getWorkspace(id) {
      return workspaces.find((entry) => entry.id === id)!;
    },
    async listWorkspaceSessions(id) {
      return [
        {
          id: `session-${id}`,
          name: "legacy",
          deepLink: `conductor://session/${id}`,
          createdAt: "2026-09-04T12:00:00Z",
          archivedAt: null,
        },
      ];
    },
    async getSessionMessageTail(id) {
      return id === "session-workspace-final"
        ? [assistant(id, `${PR} at exact head ${HEAD}`)]
        : [executed(id)];
    },
    async getSessionStatus() {
      return { status: "idle" as const };
    },
  };
  const pr: GithubPrPolicySnapshot = {
    url: PR,
    repoOwner: "example-org",
    repoName: "example-repo",
    prNumber: 7,
    state: "open",
    isDraft: false,
    headBranch: "managed/l1b2",
    baseBranch: "main",
    headSha: HEAD,
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    checksStatus: "passing",
    checksSummary: "green",
    mergeCommitSha: null,
    reviews: [],
  };
  try {
    const plan = await planLegacyImport({
      sourcePath: queue,
      manifest: manifest(),
      conductor,
      github: { refreshPr: async () => pr },
    });
    assert.equal(plan.lanes[0].disposition, "adopt");
    assert.equal(plan.lanes[0].workspace?.workspaceId, "workspace-final");
    assert.equal(plan.lanes[0].legacyVerified, true);
    assert.equal(plan.lanes[0].candidates.length, 2);
    assert.equal(
      plan.lanes[0].candidates.find(
        (candidate) => candidate.workspaceId === "workspace-final"
      )?.recognizedLegacyTag,
      true
    );
    assert.equal(
      plan.lanes[0].candidates.find(
        (candidate) => candidate.workspaceId === "workspace-validation-unbound"
      )?.recognizedLegacyTag,
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exact merged Git truth is adopted without reviving an archived workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-import-merged-archived-"));
  const queue = path.join(root, "queue.json");
  fs.writeFileSync(
    queue,
    JSON.stringify({
      lanes: [
        {
          id: "L1b2",
          provider: "claude",
          repo_url: "https://github.com/example-org/example-repo",
          workspace_id: "workspace-archived",
          session_id: "session-archived",
          pr_url: PR,
        },
      ],
    })
  );
  const archivedWorkspace = workspace(
    "workspace-archived",
    "[final:L1b2:codex] completed legacy final",
    "2026-09-04T14:00:00Z",
    true
  );
  const mergedSha = "c".repeat(40);
  const conductor: LegacyConductorGateway = {
    async listProjects() {
      return [
        {
          id: "project-1",
          name: "example",
          gitRemote: "https://github.com/example-org/example-repo",
        },
      ];
    },
    async listProjectWorkspaces() {
      return [archivedWorkspace];
    },
    async getWorkspace() {
      return archivedWorkspace;
    },
    async listWorkspaceSessions() {
      return [];
    },
    async getSessionMessageTail() {
      return [];
    },
    async getSessionStatus() {
      return { status: "idle" as const };
    },
  };
  const pr: GithubPrPolicySnapshot = {
    url: PR,
    repoOwner: "example-org",
    repoName: "example-repo",
    prNumber: 7,
    state: "merged",
    isDraft: false,
    headBranch: "managed/l1b2",
    baseBranch: "main",
    headSha: HEAD,
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    checksStatus: "passing",
    checksSummary: "green",
    mergeCommitSha: mergedSha,
    reviews: [],
  };
  try {
    const plan = await planLegacyImport({
      sourcePath: queue,
      manifest: manifest(),
      conductor,
      github: { refreshPr: async () => pr },
    });
    assert.equal(plan.lanes[0].disposition, "adopt");
    assert.equal(
      plan.lanes[0].reason,
      "exact merged Git truth; all legacy workspace candidates are archived"
    );
    assert.equal(plan.lanes[0].workspace, null);
    assert.equal(plan.lanes[0].gitTruthVerified, true);
    assert.equal(plan.lanes[0].legacyVerified, false);
    assert.equal(plan.lanes[0].candidates[0]?.archived, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one merged PR with no live workspace cannot be adopted by two lanes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-import-merged-collision-"));
  const queue = path.join(root, "queue.json");
  fs.writeFileSync(
    queue,
    JSON.stringify({
      lanes: ["L1b", "L1b2"].map((id) => ({
        id,
        provider: "claude",
        repo_url: "https://github.com/example-org/example-repo",
        pr_url: PR,
      })),
    })
  );
  const conductor: LegacyConductorGateway = {
    async listProjects() {
      return [
        {
          id: "project-1",
          name: "example",
          gitRemote: "https://github.com/example-org/example-repo",
        },
      ];
    },
    async listProjectWorkspaces() {
      return [];
    },
    async getWorkspace() {
      throw new Error("no workspace should be read");
    },
    async listWorkspaceSessions() {
      return [];
    },
    async getSessionMessageTail() {
      return [];
    },
    async getSessionStatus() {
      return { status: "idle" as const };
    },
  };
  const pr: GithubPrPolicySnapshot = {
    url: PR,
    repoOwner: "example-org",
    repoName: "example-repo",
    prNumber: 7,
    state: "merged",
    isDraft: false,
    headBranch: "managed/shared",
    baseBranch: "main",
    headSha: HEAD,
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    checksStatus: "passing",
    checksSummary: "green",
    mergeCommitSha: "c".repeat(40),
    reviews: [],
  };
  try {
    const plan = await planLegacyImport({
      sourcePath: queue,
      manifest: manifest(),
      conductor,
      github: { refreshPr: async () => pr },
    });
    assert.deepEqual(plan.duplicatePrUrls, [PR]);
    assert.deepEqual(
      plan.lanes.map((lane) => lane.disposition),
      ["quarantine", "quarantine"]
    );
    assert.ok(plan.lanes.every((lane) => lane.workspace === null));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy import quarantines two simultaneously working authoritative candidates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-import-ambiguous-"));
  const queue = path.join(root, "queue.json");
  fs.writeFileSync(
    queue,
    JSON.stringify({
      lanes: [{ id: "L1b2", provider: "claude", repo_url: "https://github.com/example-org/example-repo", pr_url: PR }],
    })
  );
  const candidates = [
    workspace("workspace-a", "[lane:L1b2:claude] a", "2026-09-04T13:00:00Z"),
    workspace("workspace-b", "[lane:L1b2:claude] b", "2026-09-04T12:00:00Z"),
  ];
  const conductor: LegacyConductorGateway = {
    async listProjects() {
      return [{ id: "project-1", name: "example", gitRemote: "https://github.com/example-org/example-repo" }];
    },
    async listProjectWorkspaces() {
      return candidates;
    },
    async getWorkspace(id) {
      return candidates.find((entry) => entry.id === id)!;
    },
    async listWorkspaceSessions(id) {
      return [{ id: `session-${id}`, name: "legacy", deepLink: `conductor://session/${id}`, createdAt: "2026-09-04T12:00:00Z", archivedAt: null }];
    },
    async getSessionMessageTail(id) {
      return [assistant(id, `${PR} ${HEAD} progress`)];
    },
    async getSessionStatus() {
      return { status: "working" as const };
    },
  };
  try {
    const pr = {
      url: PR,
      repoOwner: "example-org",
      repoName: "example-repo",
      prNumber: 7,
      state: "open" as const,
      isDraft: false,
      headBranch: "managed/l1b2",
      baseBranch: "main",
      headSha: HEAD,
      reviewDecision: null,
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
      checksStatus: "passing" as const,
      checksSummary: "green",
      mergeCommitSha: null,
      reviews: [],
    };
    const plan = await planLegacyImport({ sourcePath: queue, manifest: manifest(), conductor, github: { refreshPr: async () => pr } });
    assert.equal(plan.lanes[0].disposition, "quarantine");
    assert.match(plan.lanes[0].reason, /simultaneously working/);
    assert.equal(plan.lanes[0].workspace, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a repository-listed untagged legacy workspace may be adopted but never gains archive trust", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-import-untagged-"));
  const queue = path.join(root, "queue.json");
  fs.writeFileSync(
    queue,
    JSON.stringify({
      lanes: [
        {
          id: "L1b2",
          provider: "claude",
          repo_url: "https://github.com/example-org/example-repo",
          workspace_id: "workspace-plain",
        },
      ],
    })
  );
  const candidate = workspace(
    "workspace-plain",
    "old manually named workspace",
    "2026-09-04T13:00:00Z"
  );
  const conductor: LegacyConductorGateway = {
    async listProjects() {
      return [
        {
          id: "project-1",
          name: "example",
          gitRemote: "https://github.com/example-org/example-repo",
        },
      ];
    },
    async listProjectWorkspaces() {
      return [candidate];
    },
    async getWorkspace() {
      return candidate;
    },
    async listWorkspaceSessions() {
      return [
        {
          id: "session-plain",
          name: "legacy",
          createdAt: candidate.createdAt,
          deepLink: "conductor://session/session-plain",
          archivedAt: null,
        },
      ];
    },
    async getSessionMessageTail() {
      return [
        assistant("session-plain", "Verified implementation progress without a PR yet."),
        executed("session-plain"),
      ];
    },
    async getSessionStatus() {
      return { status: "idle" as const };
    },
  };
  try {
    const plan = await planLegacyImport({
      sourcePath: queue,
      manifest: manifest(),
      conductor,
      github: {
        async refreshPr() {
          throw new Error("no PR");
        },
      },
    });
    assert.equal(plan.lanes[0].disposition, "adopt");
    assert.equal(plan.lanes[0].workspace?.workspaceId, "workspace-plain");
    assert.equal(plan.lanes[0].workspace?.recognizedLegacyTag, false);
    assert.equal(plan.lanes[0].legacyVerified, false);
    assert.equal(plan.lanes[0].gitTruthVerified, false);
    assert.deepEqual(plan.duplicateWorkspaceIds, []);
    assert.deepEqual(plan.duplicatePrUrls, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a pinned workspace outside the manifest repository project is quarantined", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-import-wrong-project-"));
  const queue = path.join(root, "queue.json");
  fs.writeFileSync(
    queue,
    JSON.stringify({
      lanes: [
        {
          id: "L1b2",
          provider: "claude",
          repo_url: "https://github.com/example-org/example-repo",
          workspace_id: "workspace-from-another-project",
        },
      ],
    })
  );
  const conductor: LegacyConductorGateway = {
    async listProjects() {
      return [
        {
          id: "project-expected",
          name: "expected",
          gitRemote: "https://github.com/example-org/example-repo",
        },
      ];
    },
    async listProjectWorkspaces() {
      return [];
    },
    async getWorkspace() {
      return workspace(
        "workspace-from-another-project",
        "[lane:L1b2:claude] wrong project",
        "2026-09-04T13:00:00Z"
      );
    },
    async listWorkspaceSessions() {
      return [];
    },
    async getSessionMessageTail() {
      return [];
    },
    async getSessionStatus() {
      return { status: "idle" as const };
    },
  };
  try {
    const plan = await planLegacyImport({
      sourcePath: queue,
      manifest: manifest(),
      conductor,
      github: {
        async refreshPr() {
          throw new Error("no PR");
        },
      },
    });
    assert.equal(plan.lanes[0].disposition, "quarantine");
    assert.equal(plan.lanes[0].workspace, null);
    assert.deepEqual(plan.lanes[0].candidates, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy import resolves a cross-lane PR collision to the newest head-linked workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-import-pr-collision-"));
  const queue = path.join(root, "queue.json");
  fs.writeFileSync(
    queue,
    JSON.stringify({
      lanes: ["L1b", "L1b2"].map((id) => ({
        id,
        provider: "claude",
        repo_url: "https://github.com/example-org/example-repo",
        pr_url: PR,
      })),
    })
  );
  const workspaces = [
    workspace("workspace-older", "[lane:L1b:claude] older", "2026-09-04T12:00:00Z"),
    workspace("workspace-newer", "[lane:L1b2:claude] newer", "2026-09-04T13:00:00Z"),
  ];
  const conductor: LegacyConductorGateway = {
    async listProjects() {
      return [
        {
          id: "project-1",
          name: "example",
          gitRemote: "https://github.com/example-org/example-repo",
        },
      ];
    },
    async listProjectWorkspaces() {
      return workspaces;
    },
    async getWorkspace(id) {
      return workspaces.find((entry) => entry.id === id)!;
    },
    async listWorkspaceSessions(id) {
      return [
        {
          id: `session-${id}`,
          name: "legacy",
          deepLink: `conductor://session/${id}`,
          createdAt: "2026-09-04T12:00:00Z",
          archivedAt: null,
        },
      ];
    },
    async getSessionMessageTail(id) {
      return [assistant(id, `${PR} at ${HEAD}`)];
    },
    async getSessionStatus() {
      return { status: "idle" as const };
    },
  };
  const pr: GithubPrPolicySnapshot = {
    url: PR,
    repoOwner: "example-org",
    repoName: "example-repo",
    prNumber: 7,
    state: "open",
    isDraft: false,
    headBranch: "managed/shared",
    baseBranch: "main",
    headSha: HEAD,
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    checksStatus: "passing",
    checksSummary: "green",
    mergeCommitSha: null,
    reviews: [],
  };
  try {
    const plan = await planLegacyImport({
      sourcePath: queue,
      manifest: manifest(),
      conductor,
      github: { refreshPr: async () => pr },
    });
    assert.deepEqual(plan.duplicatePrUrls, [PR]);
    assert.equal(plan.lanes.find((lane) => lane.laneId === "L1b2")?.disposition, "adopt");
    assert.equal(plan.lanes.find((lane) => lane.laneId === "L1b")?.disposition, "quarantine");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate legacy queue entries for one lane are quarantined instead of order-adopted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-import-duplicate-id-"));
  const queue = path.join(root, "queue.json");
  fs.writeFileSync(
    queue,
    JSON.stringify({
      lanes: ["workspace-one", "workspace-two"].map((workspaceId) => ({
        id: "L1b",
        provider: "claude",
        repo_url: "https://github.com/example-org/example-repo",
        workspace_id: workspaceId,
      })),
    })
  );
  const workspaces = [
    workspace("workspace-one", "manual one", "2026-09-04T12:00:00Z"),
    workspace("workspace-two", "manual two", "2026-09-04T13:00:00Z"),
  ];
  const conductor: LegacyConductorGateway = {
    async listProjects() {
      return [
        {
          id: "project-1",
          name: "example",
          gitRemote: "https://github.com/example-org/example-repo",
        },
      ];
    },
    async listProjectWorkspaces() {
      return workspaces;
    },
    async getWorkspace(id) {
      return workspaces.find((entry) => entry.id === id)!;
    },
    async listWorkspaceSessions(id) {
      return [
        {
          id: `session-${id}`,
          name: "legacy",
          deepLink: `conductor://session/${id}`,
          createdAt: "2026-09-04T12:00:00Z",
          archivedAt: null,
        },
      ];
    },
    async getSessionMessageTail(id) {
      return [executed(id)];
    },
    async getSessionStatus() {
      return { status: "idle" as const };
    },
  };
  try {
    const plan = await planLegacyImport({
      sourcePath: queue,
      manifest: manifest(),
      conductor,
      github: {
        async refreshPr() {
          throw new Error("no PR");
        },
      },
    });
    assert.deepEqual(plan.duplicateLaneIds, ["L1b"]);
    assert.equal(plan.lanes.length, 2);
    assert.ok(plan.lanes.every((lane) => lane.disposition === "quarantine"));
    assert.ok(plan.lanes.every((lane) => lane.workspace === null));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy apply is idempotent and separates merged Git truth from archive trust", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-import-apply-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  const value = manifest();
  try {
    const lease = await store.claimLease({
      ownerId: "mac:legacy-import",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    const staged = await store.stageManifest(lease, {
      revisionId: "legacy-import-v2",
      sourceRef: "test:legacy-queue",
      manifest: value,
      createdBy: "test",
    });
    await store.activateManifest(
      lease,
      "legacy-import-v2",
      Number(staged.row_version)
    );
    const mergedPr: GithubPrPolicySnapshot = {
      url: PR,
      repoOwner: "example-org",
      repoName: "example-repo",
      prNumber: 7,
      state: "merged",
      isDraft: false,
      headBranch: "managed/l1b",
      baseBranch: "main",
      headSha: HEAD,
      reviewDecision: null,
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
      checksStatus: "passing",
      checksSummary: "green",
      mergeCommitSha: "c".repeat(40),
      reviews: [],
    };
    const adoptedWorkspace = {
      workspaceId: "workspace-plain-merged",
      workspaceName: "manual historical workspace",
      sessionId: "session-plain-merged",
      archived: false,
      working: false,
      verifiedProgress: true,
      prHeadLinked: true,
      lastActivityAt: "2026-09-04T13:00:00Z",
      recognizedLegacyTag: false,
    };
    const plan: LegacyImportPlan = {
      source: "/tmp/legacy-queue.json",
      ignoredWatchEntries: 1,
      duplicateLaneIds: [],
      duplicateWorkspaceIds: [],
      duplicatePrUrls: [],
      lanes: [
        {
          laneId: "L1b",
          disposition: "adopt",
          reason: "exact merged Git truth",
          provider: "claude",
          workspace: adoptedWorkspace,
          pr: mergedPr,
          legacyVerified: false,
          gitTruthVerified: true,
          candidates: [adoptedWorkspace],
        },
        {
          laneId: "L1b2",
          disposition: "quarantine",
          reason: "ambiguous duplicate candidates",
          provider: "codex",
          workspace: null,
          pr: null,
          legacyVerified: false,
          gitTruthVerified: false,
          candidates: [],
        },
      ],
    };

    assert.deepEqual(await applyLegacyImport({ plan, manifest: value, store, lease }), {
      imported: 1,
      quarantined: 1,
      skipped: 0,
    });
    const snapshot = await store.snapshot();
    const adopted = snapshot.runs.find((run) => run.lane_id === "L1b")!;
    const quarantined = snapshot.runs.find((run) => run.lane_id === "L1b2")!;
    assert.equal(adopted.status, "validating");
    assert.equal(adopted.merged_sha, mergedPr.mergeCommitSha);
    assert.equal(adopted.legacy_verified, false, "untagged work must not gain archive trust");
    assert.equal(adopted.metadata_json.legacy_git_verified, true);
    assert.equal(quarantined.status, "quarantined");

    assert.deepEqual(await applyLegacyImport({ plan, manifest: value, store, lease }), {
      imported: 0,
      quarantined: 0,
      skipped: 2,
    });
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy apply durably reserves a verified working session without replaying its prompt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-import-working-"));
  const store = new SqliteLaneStateStore(path.join(root, "state.db"));
  const value = manifest();
  try {
    const lease = await store.claimLease({
      ownerId: "mac:legacy-working",
      ownerSite: "mac",
      leaseSeconds: 75,
    });
    assert.ok(lease);
    const staged = await store.stageManifest(lease, {
      revisionId: "legacy-working-v2",
      sourceRef: "test:legacy-working",
      manifest: value,
      createdBy: "test",
    });
    await store.activateManifest(
      lease,
      "legacy-working-v2",
      Number(staged.row_version)
    );
    const candidate = {
      workspaceId: "workspace-working",
      workspaceName: "[lane:L1b:claude] verified working lane",
      sessionId: "session-working",
      archived: false,
      working: true,
      verifiedProgress: true,
      prHeadLinked: false,
      lastActivityAt: "2026-09-04T13:00:00Z",
      recognizedLegacyTag: true,
    };
    const plan: LegacyImportPlan = {
      source: "/tmp/legacy-working.json",
      ignoredWatchEntries: 0,
      duplicateLaneIds: [],
      duplicateWorkspaceIds: [],
      duplicatePrUrls: [],
      lanes: [
        {
          laneId: "L1b",
          disposition: "adopt",
          reason: "verified working session",
          provider: "claude",
          workspace: candidate,
          pr: null,
          legacyVerified: false,
          gitTruthVerified: false,
          candidates: [candidate],
        },
      ],
    };
    assert.deepEqual(
      await applyLegacyImport({ plan, manifest: value, store, lease }),
      { imported: 1, quarantined: 0, skipped: 0 }
    );
    const snapshot = await store.snapshot();
    const run = snapshot.runs.find((entry) => entry.lane_id === "L1b")!;
    const attempt = snapshot.attempts.find((entry) => entry.run_id === run.run_id)!;
    assert.equal(run.status, "implementing");
    assert.equal(attempt.status, "working");
    assert.equal(attempt.workspace_id, candidate.workspaceId);
    assert.equal(attempt.session_id, candidate.sessionId);
    assert.equal(attempt.result_json.adopted_legacy_session, true);
    assert.deepEqual(snapshot.capacity.claude, { active: 1, limit: 3 });
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
