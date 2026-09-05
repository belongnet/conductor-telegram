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

test("doctor validates the durable manifest, credentials, and Command Center connection", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-doctor-lanes-"));
  try {
    const promptPath = path.join(dir, "L1.md");
    writeFileSync(promptPath, "Do the bounded test task.\n");
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
            codex: "gpt-5.6-sol",
            cursor: "grok-4.6",
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
            delivery_adapter: { kind: "github" },
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
    const env: NodeJS.ProcessEnv = {
      LANES_MANIFEST: manifestPath,
      LANES_STATE_BACKEND: "http",
      COMMAND_CENTER_API_BASE_URL: "https://command-center.test",
      COMMAND_CENTER_API_KEY: "service-key",
      CONDUCTOR_API_KEY: "conductor-key",
      BOT_TOKEN: "telegram-key",
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
