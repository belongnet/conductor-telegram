import test from "node:test";
import assert from "node:assert/strict";
import {
  ConductorApiClient,
  ConductorApiError,
  conductorWorkspaceIsArchived,
  conductorApiConfigFromEnv,
} from "../src/integrations/conductor-api.js";

test("Conductor API config is opt-in, normalizes /v0, and fails closed in api mode", () => {
  assert.equal(conductorApiConfigFromEnv({}), null);
  assert.throws(
    () =>
      conductorApiConfigFromEnv({
        CONDUCTOR_CLOUD_BACKEND: "api",
      }),
    /requires CONDUCTOR_API_KEY/
  );

  const config = conductorApiConfigFromEnv({
    CONDUCTOR_API_BASE_URL: "https://api.conductor.build/v0/",
    CONDUCTOR_API_KEY: "secret",
    CONDUCTOR_CLOUD_BACKEND: "api",
  });
  assert.equal(config?.baseUrl, "https://api.conductor.build");
  assert.equal(config?.apiKey, "secret");
  assert.throws(
    () =>
      conductorApiConfigFromEnv({
        CONDUCTOR_API_KEY: "secret",
        CONDUCTOR_API_MAX_RETRIES: "6",
      }),
    /at most 5/
  );
  assert.throws(
    () =>
      conductorApiConfigFromEnv({
        CONDUCTOR_API_KEY: "secret",
        CONDUCTOR_API_TIMEOUT_MS: "120001",
      }),
    /at most 120000/
  );

  for (const baseUrl of [
    "https://user:pass@api.conductor.build",
    "https://api.conductor.build/other",
    "https://api.conductor.build?redirect=elsewhere",
  ]) {
    assert.throws(
      () =>
        conductorApiConfigFromEnv({
          CONDUCTOR_API_BASE_URL: baseUrl,
          CONDUCTOR_API_KEY: "secret",
        }),
      /must be an HTTP\(S\) origin/
    );
  }
  assert.throws(
    () =>
      conductorApiConfigFromEnv({
        CONDUCTOR_API_BASE_URL: "http://api.conductor.build",
        CONDUCTOR_API_KEY: "secret",
      }),
    /must use HTTPS/
  );
  assert.equal(
    conductorApiConfigFromEnv({
      CONDUCTOR_API_BASE_URL: "http://127.0.0.1:8787",
      CONDUCTOR_API_KEY: "secret",
    })?.baseUrl,
    "http://127.0.0.1:8787"
  );
});

test("message sends use bearer auth and a caller ID, returning rate limits for durable retry", async () => {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  let attempt = 0;
  const fetcher = (async (
    url: string | URL | Request,
    init: RequestInit = {}
  ) => {
    calls.push({
      url: String(url),
      init,
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    attempt += 1;
    if (attempt === 1) {
      return new Response(JSON.stringify({ userMessage: "try again" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    }
    return new Response(
      JSON.stringify({ messageId: "message-1", state: "queued" }),
      { status: 201, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const client = new ConductorApiClient(config({ maxRetries: 1 }), fetcher);
  await assert.rejects(client.sendMessage({sessionId: "session-1", message: "Implement the bounded change", messageId: "message-1"}),
    (error: unknown) => error instanceof ConductorApiError && error.status === 429);
  assert.equal(calls.length, 1);
  const sent = await client.sendMessage({
    sessionId: "session-1",
    message: "Implement the bounded change",
    messageId: "message-1",
  });

  assert.equal(sent.state, "queued");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://conductor.test/v0/sessions/session-1/messages");
  assert.equal(
    (calls[0].init.headers as Record<string, string>).Authorization,
    "Bearer api-key"
  );
  assert.equal(
    (calls[0].init.headers as Record<string, string>)["User-Agent"],
    "conductor-telegram"
  );
  assert.deepEqual(calls[0].body, {
    messageId: "message-1",
    message: "Implement the bounded change",
  });
});

test("message submission never retries an uncertain network or server response", async () => {
  for (const networkFailure of [true, false]) {
    let attempts = 0;
    const client = new ConductorApiClient(config({maxRetries: 2}), (async () => {
      attempts++;
      if (networkFailure) throw new Error("response lost");
      return new Response(JSON.stringify({userMessage: "upstream unavailable"}), {status: 503});
    }) as typeof fetch);
    await assert.rejects(client.sendMessage({sessionId: "s1", messageId: "command", message: "Perform a mutation"}));
    assert.equal(attempts, 1);
  }
});

test("workspace and session creation are not retried without documented idempotency", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ userMessage: "unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = new ConductorApiClient(config({ maxRetries: 3 }), fetcher);

  await assert.rejects(
    client.createSession({
      workspaceId: "workspace-1",
      agent: "codex",
      model: "gpt-5.5",
    }),
    (error: unknown) =>
      error instanceof ConductorApiError &&
      error.status === 503 &&
      error.retryable
  );
  assert.equal(calls, 1);
});

test("read requests retry transient failures", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ userMessage: "unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        userId: "user-1",
        authMethod: "api-key",
        apiKey: { id: "key-1" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  const client = new ConductorApiClient(config({ maxRetries: 1 }), fetcher);

  assert.equal((await client.getIdentity()).userId, "user-1");
  assert.equal(calls, 2);
});

test("caller cancellation interrupts retry backoff", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ userMessage: "slow down" }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "5",
      },
    });
  }) as typeof fetch;
  const client = new ConductorApiClient(config({ maxRetries: 1 }), fetcher);
  const controller = new AbortController();
  const startedAt = Date.now();
  const listing = client.listProjects({ signal: controller.signal });
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(listing, /request canceled/);
  assert.equal(calls, 1, "an aborted backoff must not start another request");
  assert.ok(
    Date.now() - startedAt < 1_000,
    "cancellation must not wait for Retry-After"
  );
});

test("incremental transcript polling returns one bounded page", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    urls.push(parsed.toString());
    const data = [
      apiMessage("message-2", 2, "assistant", "First"),
      apiMessage("message-3", 3, "assistant", "Second"),
    ];
    return new Response(
      JSON.stringify({
        data,
        offset: 0,
        hasMore: true,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  const messages = await client.listSessionMessages({
    sessionId: "session-1",
    after: "message-1",
  });

  assert.deepEqual(
    messages.map((message) => message.id),
    ["message-2", "message-3"]
  );
  assert.equal(urls.length, 1);
  assert.match(urls[0], /after=message-1/);
});

test("transcript polling rejects messages from another session", async () => {
  const fetcher = (async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            ...apiMessage("message-2", 2, "assistant", "wrong thread"),
            sessionId: "session-2",
          },
        ],
        offset: 0,
        hasMore: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  await assert.rejects(
    client.listSessionMessages({
      sessionId: "session-1",
      after: "message-1",
    }),
    /different session/
  );
});

test("idempotent writes reject a receipt for a different message id", async () => {
  const fetcher = (async () =>
    new Response(
      JSON.stringify({ messageId: "message-other", state: "queued" }),
      { status: 201, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  await assert.rejects(
    client.sendMessage({
      sessionId: "session-1",
      message: "bounded change",
      messageId: "message-1",
    }),
    /mismatched message identity/
  );
});

test("beta response schema drift fails visibly", async () => {
  const fetcher = (async () =>
    new Response(JSON.stringify({ status: "working" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  await assert.rejects(
    client.getSessionStatus("session-1"),
    /did not match its contract/
  );
});

test("project listing paginates and preserves order", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    urls.push(parsed.toString());
    const offset = Number(parsed.searchParams.get("offset") ?? 0);
    const page =
      offset === 0
        ? {
            data: [
              { id: "project-1", name: "api", gitRemote: "git@host:org/api.git" },
            ],
            offset: 0,
            hasMore: true,
          }
        : {
            data: [
              { id: "project-2", name: "web", gitRemote: "git@host:org/web.git" },
            ],
            offset,
            hasMore: false,
          };
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  const projects = await client.listProjects();

  assert.deepEqual(
    projects.map((project) => project.id),
    ["project-1", "project-2"]
  );
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/v0\/projects\?limit=100&offset=0$/);
});

test("project listing honors a caller cancellation across pagination", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetcher = (async (
    _url: string | URL | Request,
    init: RequestInit = {}
  ) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true }
      );
    });
  }) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  const pending = client.listProjects({ signal: controller.signal });
  controller.abort();

  await assert.rejects(pending, /request canceled/);
  assert.equal(calls, 1);
});

test("project and message reads reject mismatched identities", async () => {
  const projectFetcher = (async () =>
    new Response(
      JSON.stringify({ id: "project-other", name: "api", gitRemote: "remote" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  await assert.rejects(
    new ConductorApiClient(config(), projectFetcher).getProject("project-1"),
    /mismatched project identity/
  );

  const messageFetcher = (async () =>
    new Response(
      JSON.stringify(apiMessage("message-other", 4, "assistant", "hi")),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  await assert.rejects(
    new ConductorApiClient(config(), messageFetcher).getMessage("message-1"),
    /mismatched message identity/
  );
});

test("renames send the new name and reject foreign identities", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(
      JSON.stringify({
        id: "workspace-1",
        name: "renamed",
        createdAt: "2026-07-30T00:00:00.000Z",
        deepLink: "conductor://workspace-1",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  const workspace = await client.renameWorkspace("workspace-1", "renamed");
  assert.equal(workspace.name, "renamed");
  assert.equal(
    calls[0].url,
    "https://conductor.test/v0/workspaces/workspace-1/rename"
  );
  assert.deepEqual(calls[0].body, { name: "renamed" });

  const foreignFetcher = (async () =>
    new Response(
      JSON.stringify({ id: "session-other", deepLink: "conductor://x" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  await assert.rejects(
    new ConductorApiClient(config(), foreignFetcher).renameSession(
      "session-1",
      "renamed"
    ),
    /mismatched session identity/
  );
});

test("sql queries post the query and parse the row envelope", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(
      JSON.stringify({
        rows: [{ workspace_id: "workspace-1", workspace_name: "api-fix" }],
        rowCount: 1,
        truncated: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  const result = await client.runSql(
    "SELECT workspace_id FROM session_transcripts_view"
  );

  assert.equal(calls[0].url, "https://conductor.test/v0/sql");
  assert.deepEqual(calls[0].body, {
    query: "SELECT workspace_id FROM session_transcripts_view",
  });
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].workspace_name, "api-fix");
});

test("org workspace listing forwards mine and name filters", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "workspace-1",
            name: "[lane:L1:primary] Example first lane",
            createdAt: "2026-09-01T00:00:00.000Z",
            deepLink: "https://conductor.build/workspace-1",
            state: "archived",
            archivedAt: null,
          },
        ],
        offset: 0,
        hasMore: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  const workspaces = await client.listWorkspaces({
    mine: true,
    name: "[lane:L1:",
    includeArchived: true,
  });

  assert.equal(workspaces[0]?.id, "workspace-1");
  assert.equal(conductorWorkspaceIsArchived(workspaces[0]!), true);
  assert.equal(new URL(urls[0]).pathname, "/v0/workspaces");
  assert.equal(new URL(urls[0]).searchParams.get("mine"), "true");
  assert.equal(new URL(urls[0]).searchParams.get("name"), "[lane:L1:");
  assert.equal(new URL(urls[0]).searchParams.get("includeArchived"), "true");
});

test("workspace session listing can include archived sessions", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "session-new",
            deepLink: "https://conductor.build/session-new",
            createdAt: "2026-09-03T00:00:00.000Z",
          },
        ],
        offset: 0,
        hasMore: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  const sessions = await client.listWorkspaceSessions("workspace-1", {
    includeArchived: true,
  });

  assert.equal(sessions[0]?.createdAt, "2026-09-03T00:00:00.000Z");
  assert.equal(new URL(urls[0]).searchParams.get("includeArchived"), "true");
});

test("workspace create accepts the cursor agent", async () => {
  const bodies: unknown[] = [];
  const fetcher = (async (_url: string | URL | Request, init: RequestInit = {}) => {
    bodies.push(init.body ? JSON.parse(String(init.body)) : null);
    return new Response(
      JSON.stringify({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        deepLink: "https://conductor.build/workspace-1",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  await client.createWorkspace({
    repositoryUrl: "https://github.com/example-org/example-repo",
    name: "[lane:L1:cursor] Example first lane",
    agent: "cursor",
    model: "cursor-example-model",
    effort: "high",
  });

  assert.deepEqual(bodies[0], {
    repositoryUrl: "https://github.com/example-org/example-repo",
    name: "[lane:L1:cursor] Example first lane",
    agent: "cursor",
    model: "cursor-example-model",
    effort: "high",
  });
});

test("project workspace listing paginates against the project path", async () => {
  const urls: string[] = [];
  const workspace = (id: string, name: string) => ({
    id,
    name,
    createdAt: "2026-07-30T00:00:00.000Z",
    deepLink: `conductor://${id}`,
  });
  const fetcher = (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    urls.push(parsed.toString());
    const offset = Number(parsed.searchParams.get("offset") ?? 0);
    const page =
      offset === 0
        ? { data: [workspace("workspace-1", "api-fix")], offset: 0, hasMore: true }
        : { data: [workspace("workspace-2", "web-fix")], offset, hasMore: false };
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  const workspaces = await client.listProjectWorkspaces("project 1");

  assert.deepEqual(
    workspaces.map((entry) => entry.id),
    ["workspace-1", "workspace-2"]
  );
  assert.equal(urls.length, 2);
  assert.match(
    urls[0],
    /\/v0\/projects\/project%201\/workspaces\?limit=100&offset=0$/
  );
});

test("runaway pagination fails instead of looping forever", async () => {
  const fetcher = (async () =>
    new Response(
      JSON.stringify({
        data: [{ id: "project-1", name: "api", gitRemote: "remote" }],
        offset: 0,
        hasMore: true,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  await assert.rejects(client.listProjects(), /pagination exceeded 100 pages/);
});

test("transcript tails keep only the newest messages across pages", async () => {
  const urls: string[] = [];
  const pages = [
    [
      apiMessage("message-1", 1, "assistant", "a"),
      apiMessage("message-2", 2, "assistant", "b"),
    ],
    [
      apiMessage("message-3", 3, "assistant", "c"),
      apiMessage("message-4", 4, "assistant", "d"),
    ],
    [apiMessage("message-5", 5, "assistant", "e")],
  ];
  const fetcher = (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    urls.push(parsed.toString());
    const offset = Number(parsed.searchParams.get("offset") ?? 0);
    const data = pages
      .flat()
      .slice(offset, offset + Math.min(2, Number(parsed.searchParams.get("limit") ?? 100)));
    return new Response(
      JSON.stringify({ data, offset, hasMore: offset + data.length < pages.flat().length }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  // Only the requested tail is returned, in transcript order.
  const tail = await client.getSessionMessageTail("session-1", 3);
  assert.deepEqual(
    tail.map((message) => message.id),
    ["message-3", "message-4", "message-5"]
  );
  assert.ok(urls.length < 10, "locates the tail with bounded reads");

  // getLatestSessionMessage shares the bounded tail lookup.
  const latest = await client.getLatestSessionMessage("session-1");
  assert.equal(latest?.id, "message-5");
});

test("transcript tails seek past one hundred pages with bounded reads", async () => {
  const calls: number[] = [];
  const total = 15_050;
  const fetcher = (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    const offset = Number(parsed.searchParams.get("offset") ?? 0);
    const pageSize = Number(parsed.searchParams.get("limit") ?? 100);
    calls.push(offset);
    const length = Math.max(0, Math.min(pageSize, total - offset));
    const data = Array.from({ length }, (_, index) =>
      apiMessage(`message-${offset + index}`, offset + index, "assistant", "tail")
    );
    return new Response(
      JSON.stringify({ data, offset, hasMore: offset + length < total }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  const client = new ConductorApiClient(config(), fetcher);

  const tail = await client.getSessionMessageTail("session-1", 20);

  assert.deepEqual(
    tail.map((message) => message.sessionIndex),
    Array.from({ length: 20 }, (_, index) => total - 20 + index)
  );
  assert.ok(calls.length < 30, `expected a bounded tail search, received ${calls.length} pages`);
  assert.ok(calls.some((offset) => offset > 10_000));
});

test("tail lookup handles empty, exact-page, partial-page, and capped-page transcripts", async () => {
  for (const count of [0, 1, 2, 99, 100, 101, 199, 200, 201, 10_001]) {
    const client = new ConductorApiClient(config(), (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      const offset = Number(parsed.searchParams.get("offset") ?? 0);
      const requested = Number(parsed.searchParams.get("limit") ?? 100);
      const pageSize = Math.min(count === 2 ? 1 : 100, requested);
      const length = Math.max(0, Math.min(pageSize, count - offset));
      const data = Array.from({ length }, (_, index) =>
        apiMessage(`message-${offset + index}`, (offset + index) * 3, "assistant", "content")
      );
      return new Response(
        JSON.stringify({ data, offset, hasMore: offset + data.length < count }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch);

    const tail = await client.getSessionMessageTail("session-1", 150);

    assert.deepEqual(
      tail.map((message) => message.id),
      Array.from(
        { length: Math.min(count, 150) },
        (_, index) => `message-${Math.max(0, count - 150) + index}`
      ),
      `count=${count}`
    );
  }
});

test("cloud-workspace env wires attribution and the CONDUCTOR_API_URL fallback", async () => {
  const fromEnv = conductorApiConfigFromEnv({
    CONDUCTOR_API_KEY: "secret",
    CONDUCTOR_API_URL: "https://api.conductor.build/v0",
    CONDUCTOR_SESSION_ID: "session-self",
  });
  assert.equal(fromEnv?.baseUrl, "https://api.conductor.build");
  assert.equal(fromEnv?.attributedSessionId, "session-self");

  // An explicit CONDUCTOR_API_BASE_URL wins over the injected fallback.
  assert.equal(
    conductorApiConfigFromEnv({
      CONDUCTOR_API_KEY: "secret",
      CONDUCTOR_API_BASE_URL: "https://api.explicit.example",
      CONDUCTOR_API_URL: "https://api.conductor.build",
    })?.baseUrl,
    "https://api.explicit.example"
  );

  const headers: Array<Record<string, string>> = [];
  const fetcher = (async (_url: string | URL | Request, init: RequestInit = {}) => {
    headers.push(init.headers as Record<string, string>);
    return new Response(
      JSON.stringify({ userId: "user-1", authMethod: "api-key" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  await new ConductorApiClient(
    config({ attributedSessionId: "session-self" }),
    fetcher
  ).getIdentity();
  assert.equal(headers[0]["X-Conductor-Session-Id"], "session-self");

  await new ConductorApiClient(config(), fetcher).getIdentity();
  assert.equal("X-Conductor-Session-Id" in headers[1], false);
});

function config(
  override: Partial<ConstructorParameters<typeof ConductorApiClient>[0]> = {}
) {
  return {
    baseUrl: "https://conductor.test",
    apiKey: "api-key",
    timeoutMs: 1_000,
    maxRetries: 0,
    ...override,
  };
}

function apiMessage(
  id: string,
  sessionIndex: number,
  type: string,
  content: unknown
) {
  return {
    id,
    sessionId: "session-1",
    sessionIndex,
    type,
    content,
    receivedAt: "2026-07-28T12:00:00.000Z",
  };
}

test("large transcript tails locate the end without walking 10000 historical rows", async () => {
  let requests = 0;
  const count = 50037;
  const client = new ConductorApiClient(config(), (async (url: string | URL | Request) => {
    requests++;
    const parsed = new URL(String(url));
    const offset = Number(parsed.searchParams.get("offset") ?? 0);
    const limit = Number(parsed.searchParams.get("limit") ?? 100);
    const data = Array.from({length: Math.max(0, Math.min(limit, count - offset))}, (_, n) =>
      apiMessage(`message-${offset + n}`, (offset + n) * 3, "assistant", "content"));
    return new Response(JSON.stringify({data, offset, hasMore: offset + data.length < count}), {status: 200});
  }) as typeof fetch);
  const tail = await client.getSessionMessageTail("session-1", 20);
  assert.deepEqual(tail.map(m => m.id), Array.from({length: 20}, (_, n) => `message-${count - 20 + n}`));
  assert.ok(requests < 40, `tail lookup took ${requests} requests`);
});
