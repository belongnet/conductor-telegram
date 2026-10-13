import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { checkDurableLanes } from "../src/cli/doctor.js";

test("doctor reports launch models after applying resolved config", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-doctor-models-"));
  try {
    const dbPath = path.join(dir, "conductor.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE sessions (agent_type TEXT);
    `);
    db.close();

    const settingsPath = path.join(dir, "settings.toml");
    writeFileSync(settingsPath, "[models]\n");

    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `
          const { checkLaunchModels } = await import("./src/cli/doctor.ts");
          const result = await checkLaunchModels({
            version: 1,
            botToken: "test-token",
            ownerChatId: "1",
            conductorDbPath: process.env.TEST_CONDUCTOR_DB_PATH,
            defaultAgentType: "claude",
            defaultModel: "claude-sonnet-4-5",
            reviewAgentType: "codex",
            reviewModel: "gpt-5.5",
          });
          console.log(JSON.stringify(result));
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEST_CONDUCTOR_DB_PATH: dbPath,
          CONDUCTOR_SETTINGS_PATH: settingsPath,
          TELEGRAM_DEFAULT_AGENT_TYPE: "",
          TELEGRAM_DEFAULT_MODEL: "",
          TELEGRAM_REVIEW_AGENT_TYPE: "",
          TELEGRAM_REVIEW_MODEL: "",
        },
        encoding: "utf8",
      }
    );

    const result = JSON.parse(output.trim()) as {
      name: string;
      ok: boolean;
      detail: string;
    };
    assert.deepEqual(result, {
      name: "Launch models",
      ok: true,
      detail:
        "prompt → claude/claude-sonnet-4-5 · review → codex/gpt-5.5",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reports shipped defaults without usable config or a Conductor DB", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-doctor-defaults-"));
  try {
    const settingsPath = path.join(dir, "settings.toml");
    writeFileSync(settingsPath, "[models]\n");

    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `
          const { checkLaunchModels } = await import("./src/cli/doctor.ts");
          console.log(JSON.stringify(await checkLaunchModels(null)));
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CONDUCTOR_DB_PATH: path.join(dir, "missing-conductor.db"),
          CONDUCTOR_SETTINGS_PATH: settingsPath,
          TELEGRAM_DEFAULT_AGENT_TYPE: "",
          TELEGRAM_DEFAULT_MODEL: "",
          TELEGRAM_REVIEW_AGENT_TYPE: "",
          TELEGRAM_REVIEW_MODEL: "",
        },
        encoding: "utf8",
      }
    );

    assert.deepEqual(JSON.parse(output.trim()), {
      name: "Launch models",
      ok: true,
      detail:
        "prompt → claude/claude-fable-5 · review → claude/claude-fable-5",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeDurableManifest(
  dir: string,
  deliveryAdapter: Record<string, unknown> = { kind: "github" }
): string {
  writeFileSync(path.join(dir, "L1.md"), "Do the bounded test task.\n");
  const promptHash = createHash("sha256")
    .update("Do the bounded test task.\n")
    .digest("hex");
  const manifestPath = path.join(dir, "manifest.v2.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 2,
      global: {
        provider_capacity: { claude: 3, codex: 2, cursor: 2 },
        provider_models: {
          claude: "fable-5-1",
          codex: "gpt-6-astra",
          cursor: "grok-4.7",
        },
      },
      lanes: [
        {
          id: "L1",
          repository: {
            owner: "belongnet",
            name: "example",
            base_branch: "main",
          },
          prompt: { path: "L1.md", sha256: promptHash },
          priority: 1,
          preferred_providers: ["claude"],
          fallback_providers: ["codex", "cursor"],
          dependencies: [],
          policy: { kind: "one_shot" },
          delivery_adapter: deliveryAdapter,
          merge_policy: {
            method: "squash",
            auto_merge: true,
            deploy_notes: "",
            replay_notes: "",
          },
          validation_profile: {
            commands: [["npm", "test"]],
            probes: [],
          },
          managed_tags: ["managed:growth", "lane:L1"],
        },
      ],
    })
  );
  return manifestPath;
}

test("doctor validates the durable manifest, credentials, and Command Center connection", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-doctor-lanes-"));
  try {
    const manifestPath = writeDurableManifest(dir);
    const env: NodeJS.ProcessEnv = {
      LANES_MANIFEST: manifestPath,
      LANES_STATE_BACKEND: "http",
      COMMAND_CENTER_API_BASE_URL: "https://command-center.test",
      COMMAND_CENTER_API_KEY: "svc",
      CONDUCTOR_API_KEY: "con",
      BOT_TOKEN: "bot",
      OWNER_CHAT_ID: "42",
      BELONG_HUMAN_APPROVAL_KEY: "human-key",
    };
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ controller: { mode: "shadow" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    const result = await checkDurableLanes(null, env, fakeFetch);
    assert.equal(result.ok, true);
    assert.match(result.detail, /^growth-v2-[0-9a-f]{20} valid;/);
    assert.match(result.detail, /mode=shadow/);
    assert.deepEqual(calls, [
      "https://command-center.test/api/conductor/lanes/status?since_event_seq=0",
    ]);

    const missing = await checkDurableLanes(
      null,
      { ...env, COMMAND_CENTER_API_KEY: "" },
      fakeFetch
    );
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /COMMAND_CENTER_API_KEY/);

    const headlessStandby = await checkDurableLanes(
      null,
      {
        ...env,
        LANES_SITE: "ovh",
        BOT_TOKEN: "",
        OWNER_CHAT_ID: "",
        BELONG_HUMAN_APPROVAL_KEY: "",
      },
      fakeFetch
    );
    assert.equal(headlessStandby.ok, true);

    const sqlite = await checkDurableLanes(
      null,
      { ...env, LANES_STATE_BACKEND: "sqlite" },
      fakeFetch
    );
    assert.equal(sqlite.ok, false);
    assert.match(sqlite.detail, /forbidden sqlite/);

    const implicit = await checkDurableLanes(
      null,
      { ...env, LANES_STATE_BACKEND: undefined },
      fakeFetch
    );
    assert.equal(implicit.ok, false);
    assert.match(implicit.detail, /explicit HTTP state backend/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Extended by /ship coverage audit with a GitLab-delivered lane's own project and an unreachable GitLab.
// Value: protects=doctor reads every GitLab project a gate reads, a GitLab-delivered lane's own included, and fails closed when GitLab is unreachable;
//   fails_when=gitlabEvidenceProjects drops GitLab delivery or a thrown GitLab read is skipped, so doctor passes a token the gate cannot use;
//   why_new=only a canonical GitLab project answering 403/200 was probed; a GitLab-delivered lane and a failed fetch were never read; seam=none
test("doctor requires a GitLab token when canonical CI evidence comes from GitLab", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-doctor-lanes-gitlab-"));
  try {
    const manifestPath = writeDurableManifest(dir, {
      kind: "github",
      canonical_evidence: {
        kind: "gitlab",
        project_path: "nomadhub/mvp",
        base_branch: "dev",
      },
    });
    const env: NodeJS.ProcessEnv = {
      LANES_MANIFEST: manifestPath,
      LANES_STATE_BACKEND: "http",
      LANES_SITE: "ovh",
      COMMAND_CENTER_API_BASE_URL: "https://command-center.test",
      COMMAND_CENTER_API_KEY: "svc",
      CONDUCTOR_API_KEY: "con",
    };
    let gitlabStatus = 200;
    const gitlabReads: string[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://gitlab.com/")) {
        gitlabReads.push(String(url));
        assert.equal((init?.headers as Record<string, string>)["PRIVATE-TOKEN"], "gl");
        return new Response("[]", { status: gitlabStatus });
      }
      return new Response(JSON.stringify({ controller: { mode: "paused_safety" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const missing = await checkDurableLanes(null, env, fakeFetch);
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /missing runtime credential\(s\): GITLAB_TOKEN/);
    assert.deepEqual(gitlabReads, [], "a missing token is reported before any GitLab read");

    gitlabStatus = 403;
    const forbidden = await checkDurableLanes(null, { ...env, GITLAB_TOKEN: "gl" }, fakeFetch);
    assert.equal(forbidden.ok, false);
    assert.match(forbidden.detail, /GITLAB_TOKEN cannot read nomadhub\/mvp pipelines \(HTTP 403\)/);

    gitlabStatus = 200;
    const ready = await checkDurableLanes(null, { ...env, GITLAB_TOKEN: "gl" }, fakeFetch);
    assert.equal(ready.ok, true);
    assert.match(ready.detail, /mode=paused_safety/);
    assert.equal(
      gitlabReads.at(-1),
      "https://gitlab.com/api/v4/projects/nomadhub%2Fmvp/pipelines?per_page=1"
    );

    // Without canonical evidence a GitLab-delivered lane's gates read its own
    // project, and a GitLab that cannot be reached fails closed as well.
    writeDurableManifest(dir, { kind: "gitlab" });
    gitlabStatus = 404;
    const delivery = await checkDurableLanes(null, { ...env, GITLAB_TOKEN: "gl" }, fakeFetch);
    assert.equal(delivery.ok, false);
    assert.match(delivery.detail, /GITLAB_TOKEN cannot read belongnet\/example pipelines \(HTTP 404\)/);
    assert.equal(
      gitlabReads.at(-1),
      "https://gitlab.com/api/v4/projects/belongnet%2Fexample/pipelines?per_page=1"
    );
    const unreachableFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://gitlab.com/")) {
        throw new Error("getaddrinfo ENOTFOUND gitlab.com");
      }
      return fakeFetch(url, init);
    }) as typeof fetch;
    const unreachable = await checkDurableLanes(
      null,
      { ...env, GITLAB_TOKEN: "gl" },
      unreachableFetch
    );
    assert.equal(unreachable.ok, false);
    assert.match(
      unreachable.detail,
      /GITLAB_TOKEN cannot read belongnet\/example pipelines \(getaddrinfo ENOTFOUND gitlab\.com\)/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reads a GitLab-delivered lane's own project even when its CI is proven elsewhere", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-doctor-lanes-gitlab-delivery-"));
  try {
    for (const canonical of [
      { kind: "gitlab", project_path: "nomadhub/mvp", base_branch: "dev" },
      { kind: "github", project_path: "belongnet/canonical", base_branch: "main" },
    ]) {
      const manifestPath = writeDurableManifest(dir, { kind: "gitlab", canonical_evidence: canonical });
      const gitlabReads: string[] = [];
      const fakeFetch = (async (url: string | URL | Request) => {
        if (String(url).startsWith("https://gitlab.com/")) {
          gitlabReads.push(String(url));
          // The token reads the canonical project but not the merge requests' own.
          return new Response("[]", { status: String(url).includes("belongnet%2Fexample") ? 403 : 200 });
        }
        return new Response(JSON.stringify({ controller: { mode: "paused_safety" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const result = await checkDurableLanes(
        null,
        {
          LANES_MANIFEST: manifestPath,
          LANES_STATE_BACKEND: "http",
          LANES_SITE: "ovh",
          COMMAND_CENTER_API_BASE_URL: "https://command-center.test",
          COMMAND_CENTER_API_KEY: "svc",
          CONDUCTOR_API_KEY: "con",
          GITLAB_TOKEN: "gl",
        },
        fakeFetch
      );
      assert.equal(result.ok, false, JSON.stringify(canonical));
      assert.match(result.detail, /GITLAB_TOKEN cannot read belongnet\/example pipelines \(HTTP 403\)/);
      assert.ok(
        gitlabReads.some((url) => url.includes("belongnet%2Fexample")),
        "the merge requests' own project is read"
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor checks access to GitLab pipeline variables used by the CI gate", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-doctor-lanes-gitlab-vars-"));
  try {
    const manifestPath = writeDurableManifest(dir, {
      kind: "github",
      canonical_evidence: {
        kind: "gitlab",
        project_path: "nomadhub/mvp",
        base_branch: "dev",
      },
    });
    const env: NodeJS.ProcessEnv = {
      LANES_MANIFEST: manifestPath,
      LANES_STATE_BACKEND: "http",
      LANES_SITE: "ovh",
      COMMAND_CENTER_API_BASE_URL: "https://command-center.test",
      COMMAND_CENTER_API_KEY: "svc",
      CONDUCTOR_API_KEY: "con",
      GITLAB_TOKEN: "gl",
    };
    const reads: string[] = [];
    let variablesStatus = 403;
    const fakeFetch = (async (url: string | URL | Request) => {
      const target = String(url);
      reads.push(target);
      if (target.endsWith("/pipelines?per_page=1")) {
        return new Response(JSON.stringify([{ id: 42 }]));
      }
      if (target.endsWith("/pipelines/42/variables")) {
        return new Response("[]", { status: variablesStatus });
      }
      return new Response(JSON.stringify({ controller: { mode: "paused_safety" } }));
    }) as typeof fetch;

    const denied = await checkDurableLanes(null, env, fakeFetch);
    assert.equal(denied.ok, false);
    assert.match(denied.detail, /pipeline variables HTTP 403/);
    assert.ok(reads.some((url) => url.endsWith("/pipelines/42/variables")));

    variablesStatus = 200;
    const allowed = await checkDurableLanes(null, env, fakeFetch);
    assert.equal(allowed.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
