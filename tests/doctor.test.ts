import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

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
