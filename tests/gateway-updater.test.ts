import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBotProgramArguments,
  buildUpdaterPlist,
  extractGatewayOverrides,
  resolveLaunchdNodePath,
  shouldLeaveBotStopped,
} from "../src/cli/service.js";

test("resolveLaunchdNodePath never changes which node actually runs", () => {
  const resolved = resolveLaunchdNodePath();
  assert.ok(path.isAbsolute(resolved));
  // Either the stable symlink to the running node, or the running node
  // itself — but never some other install.
  assert.equal(fs.realpathSync(resolved), fs.realpathSync(process.execPath));
});

test("resolveLaunchdNodePath prefers a stable symlink to this node and rejects other installs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-node-resolve-"));
  try {
    const matching = path.join(dir, "node");
    fs.symlinkSync(process.execPath, matching);
    // A symlink that realpaths to the running node wins over execPath.
    assert.equal(resolveLaunchdNodePath([matching]), matching);
    // A missing candidate falls through to execPath.
    assert.equal(
      resolveLaunchdNodePath([path.join(dir, "missing", "node")]),
      process.execPath
    );
    // A real file that is NOT this node must not be chosen.
    const other = path.join(dir, "other-node");
    fs.writeFileSync(other, "#!/bin/sh\n");
    assert.equal(resolveLaunchdNodePath([other]), process.execPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only auto-deploys defer to a standing operator stop", () => {
  // updater context + marker → stay down; every other combination starts.
  assert.equal(shouldLeaveBotStopped(true, true), true);
  assert.equal(shouldLeaveBotStopped(true, false), false);
  assert.equal(shouldLeaveBotStopped(false, true), false);
  assert.equal(shouldLeaveBotStopped(false, false), false);
});

test("bot program arguments default to the stable node path", () => {
  const args = buildBotProgramArguments();
  assert.equal(args[0], resolveLaunchdNodePath());
});

test("updater plist runs bash on the installed script copy, not the checkout", () => {
  const plist = buildUpdaterPlist();
  const home = os.homedir();
  assert.match(plist, /<string>\/bin\/bash<\/string>/);
  assert.match(
    plist,
    new RegExp(
      `<string>${path
        .join(home, ".conductor-telegram", "bin", "gateway-update.sh")
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`
    )
  );
  // Survives reboots and keeps polling without a node install: the program
  // is bash + the script, nothing else (a $HOME containing "node" elsewhere
  // in the plist is fine).
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
  const programArgs = plist.match(/<array>([\s\S]*?)<\/array>/);
  assert.ok(programArgs);
  const args = [...programArgs[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(
    (m) => m[1]
  );
  assert.equal(args[0], "/bin/bash");
  assert.equal(args.length, 2);
});

test("updater plist bakes gateway overrides present at install time", () => {
  const name = "CONDUCTOR_TELEGRAM_GATEWAY_REMOTE";
  const prev = process.env[name];
  process.env[name] = "https://example.com/fork.git";
  try {
    const plist = buildUpdaterPlist();
    assert.match(plist, new RegExp(`<key>${name}</key>`));
    assert.match(plist, /<string>https:\/\/example\.com\/fork\.git<\/string>/);
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
  // Without the override the key is absent entirely.
  assert.equal(buildUpdaterPlist().includes(name), false);
});

test("a log override moves launchd's StandardOut/ErrPath along with the script's cap target", () => {
  // The script caps the file launchd appends to; if the override only moved
  // one side, the real log would grow unbounded while an idle file gets
  // capped. The plist must point stdout, stderr, AND the env var at the
  // override.
  const name = "CONDUCTOR_TELEGRAM_GATEWAY_LOG";
  const prev = process.env[name];
  const override = "/tmp/ct-test-gateway-update.log";
  process.env[name] = override;
  try {
    const plist = buildUpdaterPlist();
    assert.equal(plist.split(`<string>${override}</string>`).length - 1, 3);
    assert.equal(
      plist.includes(path.join(os.homedir(), ".conductor-telegram", "update.log")),
      false
    );
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
});

test("gateway overrides survive a reinstall that lacks them in its environment", () => {
  const name = "CONDUCTOR_TELEGRAM_GATEWAY_REMOTE";
  const prev = process.env[name];
  process.env[name] = "https://example.com/a&b.git";
  let plist: string;
  try {
    plist = buildUpdaterPlist();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
  // Round-trips through the plist's XML escaping.
  assert.deepEqual(extractGatewayOverrides(plist), {
    [name]: "https://example.com/a&b.git",
  });
  assert.deepEqual(extractGatewayOverrides(buildUpdaterPlist()), {});
});

test("a v0.4.x config.json with the legacy `token` key still authenticates", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ct-legacy-config-"));
  try {
    const dir = path.join(home, ".conductor-telegram");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ version: 1, token: "42:legacy", ownerChatId: "-7" })
    );
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'const { loadConfig } = await import("./src/cli/config.ts"); const c = loadConfig(); console.log(JSON.stringify({ botToken: c.botToken, ownerChatId: c.ownerChatId }));',
      ],
      {
        cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
        env: { ...process.env, HOME: home, BOT_TOKEN: "", OWNER_CHAT_ID: "" },
        encoding: "utf8",
      }
    );
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      botToken: "42:legacy",
      ownerChatId: "-7",
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("gateway-update.sh parses under the system bash", () => {
  const script = path.join(
    process.cwd(),
    "scripts",
    "gateway-update.sh"
  );
  const check = spawnSync("/bin/bash", ["-n", script], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});
