import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

test("saving secret-bearing config repairs existing file and directory permissions", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ct-config-mode-"));
  const configDir = path.join(home, ".conductor-telegram");
  const configPath = path.join(configDir, "config.json");
  try {
    mkdirSync(configDir, { mode: 0o755 });
    writeFileSync(
      configPath,
      JSON.stringify({ version: 1, botToken: "old", ownerChatId: "1" }),
      { mode: 0o644 }
    );
    chmodSync(configDir, 0o755);
    chmodSync(configPath, 0o644);

    const script = [
      'import { saveConfig } from "./src/cli/config.ts";',
      "saveConfig({",
      "  version: 1,",
      '  botToken: "telegram-secret",',
      '  ownerChatId: "1",',
      '  conductorApiKey: "conductor-secret"',
      "});",
    ].join("\n");
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      }
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(statSync(configDir).mode & 0o777, 0o700);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("persisted config never captures secrets from the ambient environment", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ct-config-persist-"));
  const configDir = path.join(home, ".conductor-telegram");
  try {
    mkdirSync(configDir, { mode: 0o700 });
    writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ version: 1, botToken: "from-file", ownerChatId: "1" }),
      { mode: 0o600 }
    );

    const script = [
      'import { loadConfig, loadPersistableConfig } from "./src/cli/config.ts";',
      "console.log(JSON.stringify({",
      "  runtime: loadConfig({}),",
      "  persisted: loadPersistableConfig({}),",
      "}));",
    ].join("\n");
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          // A key exported for this one command, as the deploy runner does.
          CONDUCTOR_API_KEY: "ambient-secret",
          BOT_TOKEN: "ambient-token",
          CONDUCTOR_TELEGRAM_DOPPLER_PROJECT: "belong-agents",
          CONDUCTOR_TELEGRAM_DOPPLER_CONFIG: "prd",
        },
        encoding: "utf8",
      }
    );
    assert.equal(child.status, 0, child.stderr);
    const { runtime, persisted } = JSON.parse(child.stdout);

    // The running process still sees the environment.
    assert.equal(runtime.conductorApiKey, "ambient-secret");
    assert.equal(runtime.botToken, "ambient-token");

    // Nothing secret from the environment reaches disk.
    assert.equal(persisted.conductorApiKey, undefined);
    assert.equal(persisted.botToken, "from-file");
    assert.equal(
      JSON.stringify(persisted).includes("ambient-secret"),
      false,
      "no ambient secret may appear anywhere in the persisted config"
    );

    // Non-secret Doppler references are pointers and must still persist.
    assert.equal(persisted.dopplerProject, "belong-agents");
    assert.equal(persisted.dopplerConfig, "prd");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
