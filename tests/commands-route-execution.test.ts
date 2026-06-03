import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveRepoTopicLaunchTarget,
  resolveRouteExecutionPlan,
} from "../src/bot/commands.js";
import type { RouteResult } from "../src/bot/ai-router.js";
import type { Workspace } from "../src/types/index.js";

const chatId = "chat-1";

function route(overrides: Partial<RouteResult>): RouteResult {
  return {
    transcript: "follow-up",
    action: "existing",
    prompt: "Apply that fix.",
    ...overrides,
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "workspace-1",
    name: "workspace-1",
    prompt: "Fix routing.",
    status: "running",
    repoPath: "/repos/conductor-telegram",
    createdAt: "2026-05-20T00:00:00.000Z",
    telegramChatId: chatId,
    telegramMessageId: null,
    conductorWorkspaceName: "rotterdam",
    conductorSessionId: null,
    lastForwardedMessageRowid: 0,
    telegramThreadId: null,
    archivedAt: null,
    ...overrides,
  };
}

test("repo topic launch targets preserve the stored repo path", () => {
  const target = resolveRepoTopicLaunchTarget({
    repoName: "ai-deploy-clo",
    repoPath: "/custom/repos/ai-deploy-clo",
  });

  assert.deepEqual(target, {
    repoName: "ai-deploy-clo",
    repoPath: "/custom/repos/ai-deploy-clo",
  });
});

test("route execution sends valid existing routes to the workspace", () => {
  const plan = resolveRouteExecutionPlan(
    chatId,
    route({ workspaceId: "workspace-1" }),
    {
      getWorkspace: () => workspace(),
      resolveRepo: () => {
        assert.fail("existing workspace route should not resolve a repo");
      },
    }
  );

  assert.equal(plan.kind, "existing");
  if (plan.kind !== "existing") assert.fail("expected existing workspace plan");
  assert.equal(plan.workspace.id, "workspace-1");
});

test("route execution falls back to a new workspace when existing route has only a repo", () => {
  const plan = resolveRouteExecutionPlan(
    chatId,
    route({ repoName: "conductor-telegram", workspaceId: undefined }),
    {
      getWorkspace: () => {
        assert.fail("missing workspaceId should not query workspace storage");
      },
      resolveRepo: (input) => input,
    }
  );

  assert.deepEqual(plan, {
    kind: "new",
    repoName: "conductor-telegram",
    existingRejection: undefined,
  });
});

test("route execution rejects existing routes without workspace or repo target", () => {
  const plan = resolveRouteExecutionPlan(
    chatId,
    route({ workspaceId: undefined, repoName: undefined }),
    {
      getWorkspace: () => {
        assert.fail("missing workspaceId should not query workspace storage");
      },
      resolveRepo: () => {
        assert.fail("missing repoName should not resolve a repo");
      },
    }
  );

  assert.deepEqual(plan, {
    kind: "unroutable",
    reason: "missing_target",
    existingRejection: undefined,
  });
});

test("route execution preserves rejection reason when falling back to a repo", () => {
  const plan = resolveRouteExecutionPlan(
    chatId,
    route({ repoName: "conductor-telegram", workspaceId: "workspace-1" }),
    {
      getWorkspace: () => workspace({ telegramChatId: "other-chat" }),
      resolveRepo: (input) => input,
    }
  );

  assert.deepEqual(plan, {
    kind: "new",
    repoName: "conductor-telegram",
    existingRejection: "wrong chat",
  });
});
