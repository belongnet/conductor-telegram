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
