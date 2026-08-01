import test from "node:test";
import assert from "node:assert/strict";
import {
  ConductorApiClient,
  ConductorApiError,
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

test("message sends use bearer auth, a caller message id, and safe retries", async () => {
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
