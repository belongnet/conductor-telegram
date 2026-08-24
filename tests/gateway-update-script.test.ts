import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUpdaterPlist } from "../src/cli/service.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const UPDATE_SCRIPT = path.join(REPO_ROOT, "scripts", "gateway-update.sh");
const LOG_MAX_BYTES = 5242880;

/**
 * Stub deploy script committed into the fixture repo. Records the sha the
 * checkout sits at when the deploy fires (proving the updater reset the
 * checkout first) and exits per STUB_DEPLOY_EXIT.
 */
const STUB_DEPLOY = `#!/bin/bash
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
git -C "$repo_root" rev-parse HEAD >> "$STUB_DEPLOY_LOG"
exit "\${STUB_DEPLOY_EXIT:-0}"
`;

interface Sandbox {
  root: string;
  home: string;
  gatewayHome: string;
  remote: string;
  work: string;
  deployLog: string;
  env: NodeJS.ProcessEnv;
}

function git(env: NodeJS.ProcessEnv, args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8", env });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-gateway-update-"));
  const home = path.join(root, "home");
  const gatewayHome = path.join(root, "gateway-home");
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  const deployLog = path.join(root, "deploy-calls.log");
  fs.mkdirSync(home, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    // A developer's global git config (gpgsign, hooksPath, …) must never
    // leak into the fixture repos.
    GIT_CONFIG_GLOBAL: "/dev/null",
    CONDUCTOR_TELEGRAM_GATEWAY_HOME: gatewayHome,
    CONDUCTOR_TELEGRAM_GATEWAY_REMOTE: remote,
    CONDUCTOR_TELEGRAM_GATEWAY_BRANCH: "main",
    STUB_DEPLOY_LOG: deployLog,
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.STUB_DEPLOY_EXIT;
  delete env.XDG_CONFIG_HOME;
  delete env.CONDUCTOR_TELEGRAM_GATEWAY_LOG;
  delete env.CONDUCTOR_TELEGRAM_GATEWAY_DEPLOY_TIMEOUT;
  delete env.CONDUCTOR_TELEGRAM_UPDATER;

  git(env, ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  git(env, ["clone", "--quiet", remote, work]);
  git(env, ["-C", work, "config", "user.name", "Gateway Test"]);
  git(env, ["-C", work, "config", "user.email", "gateway-test@example.com"]);
  fs.mkdirSync(path.join(work, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(work, "scripts", "deploy-mac-gateway.sh"), STUB_DEPLOY, {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(work, "VERSION"), "0\n");
  git(env, ["-C", work, "add", "."]);
  git(env, ["-C", work, "commit", "--quiet", "-m", "initial gateway"]);
  git(env, ["-C", work, "push", "--quiet", "origin", "main"]);

  return { root, home, gatewayHome, remote, work, deployLog, env };
}

function pushCommit(sb: Sandbox, marker: string): string {
  fs.writeFileSync(path.join(sb.work, "VERSION"), `${marker}\n`);
  git(sb.env, ["-C", sb.work, "commit", "--quiet", "-am", `bump ${marker}`]);
  git(sb.env, ["-C", sb.work, "push", "--quiet", "origin", "main"]);
  return git(sb.env, ["-C", sb.work, "rev-parse", "HEAD"]);
}

function remoteHead(sb: Sandbox): string {
  return git(sb.env, ["-C", sb.work, "rev-parse", "HEAD"]);
}

function runTick(sb: Sandbox, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [UPDATE_SCRIPT], {
    encoding: "utf8",
    env: { ...sb.env, ...extraEnv },
  });
}

function deployCalls(sb: Sandbox): string[] {
  if (!fs.existsSync(sb.deployLog)) return [];
  return fs.readFileSync(sb.deployLog, "utf8").split("\n").filter(Boolean);
}

function readState(sb: Sandbox): string[] {
  return fs
    .readFileSync(path.join(sb.gatewayHome, "last-deploy"), "utf8")
    .trim()
    .split(/\s+/);
}

function writeState(sb: Sandbox, sha: string, status: string, epoch: string): void {
  fs.writeFileSync(
    path.join(sb.gatewayHome, "last-deploy"),
    `${sha} ${status} ${epoch}\n`
  );
}

function cleanup(sb: Sandbox): void {
  fs.rmSync(sb.root, { recursive: true, force: true });
}

test("first tick self-bootstraps: clones the remote and deploys even though the fresh checkout already matches it", () => {
  const sb = makeSandbox();
  try {
    const sha = remoteHead(sb);
    const tick = runTick(sb);
    assert.equal(tick.status, 0, tick.stderr);
    assert.match(tick.stdout, /no gateway checkout .* cloning/);
    assert.match(tick.stdout, new RegExp(`deploy of ${sha} succeeded`));
    // The clone starts at remote HEAD, but with no ok state recorded the
    // deploy must still run — local==remote alone is not "done".
    assert.deepEqual(deployCalls(sb), [sha]);
    const [stateSha, stateStatus, stateEpoch] = readState(sb);
    assert.equal(stateSha, sha);
    assert.equal(stateStatus, "ok");
    assert.match(stateEpoch, /^\d+$/);
    // Lock released by the EXIT trap.
    assert.equal(fs.existsSync(path.join(sb.gatewayHome, "update.lock")), false);
    // Checkout really exists where service status expects it.
    const repoDir = path.join(sb.gatewayHome, "repo");
    assert.equal(
      git(sb.env, ["-C", repoDir, "rev-parse", "HEAD"]),
      sha
    );
  } finally {
    cleanup(sb);
  }
});

test("a tick with nothing new exits quietly without redeploying", () => {
  const sb = makeSandbox();
  try {
    assert.equal(runTick(sb).status, 0);
    const second = runTick(sb);
    assert.equal(second.status, 0);
    // Quiet means byte-for-byte silent: launchd appends stdout to the log
    // forever, so the steady state must write nothing.
    assert.equal(second.stdout, "");
    assert.equal(deployCalls(sb).length, 1);
  } finally {
    cleanup(sb);
  }
});

test("a new commit on the remote triggers a redeploy at exactly that sha", () => {
  const sb = makeSandbox();
  try {
    const first = remoteHead(sb);
    assert.equal(runTick(sb).status, 0);
    const second = pushCommit(sb, "v2");
    const tick = runTick(sb);
    assert.equal(tick.status, 0, tick.stderr);
    assert.match(tick.stdout, new RegExp(`deploying ${first} -> ${second}`));
    // The stub logs the checkout's HEAD at deploy time: reset --hard ran.
    assert.deepEqual(deployCalls(sb), [first, second]);
    assert.equal(readState(sb)[0], second);
    assert.equal(readState(sb)[1], "ok");
  } finally {
    cleanup(sb);
  }
});

test("a failing deploy exits nonzero, records the failure, and the next tick backs off silently", () => {
  const sb = makeSandbox();
  try {
    const sha = remoteHead(sb);
    const failing = runTick(sb, { STUB_DEPLOY_EXIT: "1" });
    assert.equal(failing.status, 1);
    assert.match(failing.stdout, /failed \(exit 1\)/);
    const [stateSha, stateStatus] = readState(sb);
    assert.equal(stateSha, sha);
    assert.equal(stateStatus, "fail");

    // Same sha, recent failure: inside the 1800s window nothing runs, even
    // though the deploy would now succeed.
    const backoff = runTick(sb);
    assert.equal(backoff.status, 0);
    assert.equal(backoff.stdout, "");
    assert.equal(deployCalls(sb).length, 1);
    assert.equal(readState(sb)[1], "fail");
  } finally {
    cleanup(sb);
  }
});

test("a failed deploy is retried once the backoff window has passed", () => {
  const sb = makeSandbox();
  try {
    const sha = remoteHead(sb);
    assert.equal(runTick(sb, { STUB_DEPLOY_EXIT: "1" }).status, 1);
    const expired = Math.floor(Date.now() / 1000) - 3600;
    writeState(sb, sha, "fail", String(expired));

    const retry = runTick(sb);
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(retry.stdout, new RegExp(`retrying failed deploy of ${sha}`));
    assert.equal(deployCalls(sb).length, 2);
    assert.equal(readState(sb)[1], "ok");
  } finally {
    cleanup(sb);
  }
});

test("a garbled epoch in the state file falls back to retrying immediately", () => {
  const sb = makeSandbox();
  try {
    const sha = remoteHead(sb);
    assert.equal(runTick(sb, { STUB_DEPLOY_EXIT: "1" }).status, 1);
    // A corrupted third field must parse as epoch 0 (backoff long expired),
    // not crash the tick under set -euo pipefail.
    writeState(sb, sha, "fail", "not-an-epoch");

    const retry = runTick(sb);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(deployCalls(sb).length, 2);
    assert.equal(readState(sb)[1], "ok");
  } finally {
    cleanup(sb);
  }
});

test("a stale lock left by a dead process is stolen and the tick proceeds", () => {
  const sb = makeSandbox();
  try {
    // A real pid that is certainly dead: spawn a no-op and let it exit.
    const dead = spawnSync("/bin/sh", ["-c", "exit 0"]);
    const deadPid = dead.pid;
    const lockDir = path.join(sb.gatewayHome, "update.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "pid"), `${deadPid}\n`);

    const tick = runTick(sb);
    assert.equal(tick.status, 0, tick.stderr);
    assert.match(tick.stdout, new RegExp(`removing stale lock \\(pid ${deadPid}\\)`));
    assert.equal(deployCalls(sb).length, 1);
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    cleanup(sb);
  }
});

test("a lock held by a live process makes the tick a silent no-op and is left in place", () => {
  const sb = makeSandbox();
  try {
    const lockDir = path.join(sb.gatewayHome, "update.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    // Our own pid: alive, same user, kill -0 succeeds.
    fs.writeFileSync(path.join(lockDir, "pid"), `${process.pid}\n`);

    const tick = runTick(sb);
    assert.equal(tick.status, 0);
    assert.equal(tick.stdout, "");
    assert.equal(deployCalls(sb).length, 0);
    assert.equal(fs.existsSync(path.join(sb.gatewayHome, "repo")), false);
    // The holder still owns the lock; the skipped tick must not remove it.
    assert.equal(fs.existsSync(lockDir), true);
  } finally {
    cleanup(sb);
  }
});

test("an oversized update.log is truncated in place without replacing the inode", () => {
  const sb = makeSandbox();
  try {
    assert.equal(runTick(sb).status, 0);
    const logDir = path.join(sb.home, ".conductor-telegram");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "update.log");
    const line = (n: number) => `line-${String(n).padStart(6, "0")} ${"x".repeat(1000)}\n`;
    let contents = "";
    for (let n = 1; n <= 6000; n += 1) contents += line(n);
    fs.writeFileSync(logPath, contents);
    assert.ok(fs.statSync(logPath).size > LOG_MAX_BYTES);
    const inoBefore = fs.statSync(logPath).ino;

    // An otherwise-quiet tick still performs the truncation pass.
    const tick = runTick(sb);
    assert.equal(tick.status, 0);
    const after = fs.readFileSync(logPath, "utf8");
    assert.ok(fs.statSync(logPath).size < LOG_MAX_BYTES);
    // The byte-based cap keeps the newest bytes and drops the oldest, so one
    // truncation always lands under the trigger threshold.
    assert.ok(after.includes("line-006000"));
    assert.equal(after.includes("line-000001"), false);
    // launchd's O_APPEND descriptor stays valid only if the inode survives.
    assert.equal(fs.statSync(logPath).ino, inoBefore);
  } finally {
    cleanup(sb);
  }
});

test("a failed clone exits cleanly and the next tick self-heals", () => {
  const sb = makeSandbox();
  try {
    const missingRemote = path.join(sb.root, "missing.git");
    const broken = runTick(sb, {
      CONDUCTOR_TELEGRAM_GATEWAY_REMOTE: missingRemote,
    });
    assert.equal(broken.status, 0);
    assert.match(broken.stdout, /clone failed — will retry on the next tick/);
    assert.equal(deployCalls(sb).length, 0);
    assert.equal(fs.existsSync(path.join(sb.gatewayHome, "repo")), false);
    // Lock must be released even on the bail-out path.
    assert.equal(fs.existsSync(path.join(sb.gatewayHome, "update.lock")), false);

    const healed = runTick(sb);
    assert.equal(healed.status, 0, healed.stderr);
    assert.deepEqual(deployCalls(sb), [remoteHead(sb)]);
  } finally {
    cleanup(sb);
  }
});

test("a fetch failure skips the tick and leaves the deployed state alone", () => {
  const sb = makeSandbox();
  try {
    const sha = remoteHead(sb);
    assert.equal(runTick(sb).status, 0);
    fs.renameSync(sb.remote, `${sb.remote}.gone`);

    const tick = runTick(sb);
    assert.equal(tick.status, 0);
    assert.match(tick.stdout, /git fetch failed — will retry on the next tick/);
    assert.equal(deployCalls(sb).length, 1);
    assert.deepEqual(readState(sb).slice(0, 2), [sha, "ok"]);
  } finally {
    cleanup(sb);
  }
});

test("a wedged deploy is killed as a process group at the timeout and recorded as a failure", () => {
  const sb = makeSandbox();
  try {
    // Replace the stub with one that hangs (and records its pid so we can
    // prove the group kill reached it).
    fs.writeFileSync(
      path.join(sb.work, "scripts", "deploy-mac-gateway.sh"),
      `#!/bin/bash\necho $$ >> "$STUB_DEPLOY_LOG.pids"\nsleep 300\n`,
      { mode: 0o755 }
    );
    git(sb.env, ["-C", sb.work, "commit", "--quiet", "-am", "hanging deploy"]);
    git(sb.env, ["-C", sb.work, "push", "--quiet", "origin", "main"]);
    const sha = remoteHead(sb);

    const tick = runTick(sb, { CONDUCTOR_TELEGRAM_GATEWAY_DEPLOY_TIMEOUT: "3" });
    assert.equal(tick.status, 1, tick.stdout);
    assert.match(tick.stdout, /deploy timed out after \d+s — killing process group/);
    assert.deepEqual(readState(sb).slice(0, 2), [sha, "fail"]);
    // Lock released so the next tick is not wedged forever.
    assert.equal(fs.existsSync(path.join(sb.gatewayHome, "update.lock")), false);
    // The hanging deploy really died with its group.
    const pids = fs
      .readFileSync(`${sb.deployLog}.pids`, "utf8")
      .split("\n")
      .filter(Boolean);
    assert.equal(pids.length, 1);
    assert.throws(() => process.kill(Number(pids[0]), 0), /ESRCH/);
  } finally {
    cleanup(sb);
  }
});

test("lock contention: fresh pid-less locks are respected, old ones and pid-reuse impostors are stolen", () => {
  const sb = makeSandbox();
  const lockDir = path.join(sb.gatewayHome, "update.lock");
  let impostor: ChildProcess | null = null;
  try {
    // 1. A pid-less lock that is fresh: the holder may just not have written
    // its pid yet — silent no-op, lock left alone.
    fs.mkdirSync(lockDir, { recursive: true });
    const fresh = runTick(sb);
    assert.equal(fresh.status, 0);
    assert.equal(fresh.stdout, "");
    assert.equal(deployCalls(sb).length, 0);
    assert.equal(fs.existsSync(lockDir), true);

    // 2. The same pid-less lock, aged past the stale window: stolen.
    execFileSync("touch", ["-t", "202601010000", lockDir]);
    const aged = runTick(sb);
    assert.equal(aged.status, 0, aged.stderr);
    assert.match(aged.stdout, /removing stale lock \(pid unknown\)/);
    assert.equal(deployCalls(sb).length, 1);

    // 3. A live pid whose command is clearly not deploy tooling (pid reuse
    // after a crash): stolen, not honored forever.
    impostor = spawn("/bin/sleep", ["300"], {
      detached: true,
      stdio: "ignore",
    });
    impostor.unref();
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "pid"), `${impostor.pid}\n`);
    const second = pushCommit(sb, "v-past-impostor");
    const reused = runTick(sb);
    assert.equal(reused.status, 0, reused.stderr);
    assert.match(reused.stdout, new RegExp(`removing stale lock \\(pid ${impostor.pid}\\)`));
    assert.equal(deployCalls(sb).at(-1), second);
  } finally {
    if (impostor?.pid) {
      try {
        process.kill(impostor.pid);
      } catch {
        // already gone
      }
    }
    cleanup(sb);
  }
});

test("deploy outcomes are notified to Telegram via config.json credentials, and bad config never breaks a tick", () => {
  const sb = makeSandbox();
  try {
    // The script prepends $HOME/.local/bin to PATH, so a stub curl there
    // always wins — no real network call can escape the sandbox.
    const stubBin = path.join(sb.home, ".local", "bin");
    const curlLog = path.join(sb.root, "curl-calls.log");
    fs.mkdirSync(stubBin, { recursive: true });
    // The URL (carrying the token) arrives via stdin config (-K -), not
    // argv, so capture both streams.
    fs.writeFileSync(
      path.join(stubBin, "curl"),
      `#!/bin/bash\nif [ ! -t 0 ]; then cat >> "${curlLog}"; fi\necho "$@" >> "${curlLog}"\nexit 0\n`,
      { mode: 0o755 }
    );
    const configDir = path.join(sb.home, ".conductor-telegram");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ version: 1, botToken: "123:stub-token", ownerChatId: "-100555" })
    );

    // Failure notifies with the retry hint; the token travels via the -K
    // stdin config, never argv.
    assert.equal(runTick(sb, { STUB_DEPLOY_EXIT: "1" }).status, 1);
    let calls = fs.readFileSync(curlLog, "utf8");
    assert.match(calls, /123:stub-token/);
    assert.match(calls, /chat_id=-100555/);
    assert.match(calls, /FAILED/);

    // Success (after backoff expiry) notifies with the new version — via the
    // v0.4.x legacy `token` key, which must keep working.
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ version: 1, token: "123:stub-token", ownerChatId: "-100555" })
    );
    const sha = remoteHead(sb);
    writeState(sb, sha, "fail", "0");
    assert.equal(runTick(sb).status, 0);
    calls = fs.readFileSync(curlLog, "utf8");
    assert.match(calls, /updated to v0/);

    // Malformed config must not fail the tick under set -euo pipefail.
    fs.writeFileSync(path.join(configDir, "config.json"), "{not json");
    const next = pushCommit(sb, "v-bad-config");
    const tick = runTick(sb);
    assert.equal(tick.status, 0, tick.stdout);
    assert.equal(deployCalls(sb).at(-1), next);
  } finally {
    cleanup(sb);
  }
});

test("a force-pushed (non-fast-forward) branch tip is refused, recorded, and recoverable by wiping the checkout", () => {
  const sb = makeSandbox();
  try {
    assert.equal(runTick(sb).status, 0);
    // Rewrite the remote's history: amend the tip and force-push.
    fs.writeFileSync(path.join(sb.work, "VERSION"), "rewritten\n");
    git(sb.env, ["-C", sb.work, "commit", "--quiet", "--amend", "-am", "rewritten"]);
    git(sb.env, ["-C", sb.work, "push", "--quiet", "--force", "origin", "main"]);
    const rewritten = remoteHead(sb);

    const tick = runTick(sb);
    assert.equal(tick.status, 1);
    assert.match(tick.stdout, /refusing non-fast-forward update/);
    // No deploy ran for the rewritten sha; the refusal is recorded as a
    // failure so the 30-minute backoff throttles the log noise.
    assert.equal(deployCalls(sb).length, 1);
    assert.deepEqual(readState(sb).slice(0, 2), [rewritten, "fail"]);

    // The documented recovery: wipe the checkout, next tick re-clones at the
    // rewritten tip and deploys it.
    fs.rmSync(path.join(sb.gatewayHome, "repo"), { recursive: true, force: true });
    writeState(sb, rewritten, "fail", "0");
    const healed = runTick(sb);
    assert.equal(healed.status, 0, healed.stderr);
    assert.equal(deployCalls(sb).at(-1), rewritten);
    assert.deepEqual(readState(sb).slice(0, 2), [rewritten, "ok"]);
  } finally {
    cleanup(sb);
  }
});

test("a checkout that is not a valid clone of the expected remote is recloned, never reset in place", () => {
  const sb = makeSandbox();
  try {
    // A plain non-repo directory at the checkout path (interrupted clone
    // leftovers) must trigger a reclone — and must NOT let git discover some
    // ancestor repository and reset that instead.
    const repoDir = path.join(sb.gatewayHome, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "junk.txt"), "leftover\n");

    const tick = runTick(sb);
    assert.equal(tick.status, 0, tick.stderr);
    assert.match(tick.stdout, /not a valid clone .* recloning/);
    assert.deepEqual(deployCalls(sb), [remoteHead(sb)]);
    assert.equal(fs.existsSync(path.join(repoDir, "junk.txt")), false);

    // A checkout whose origin URL differs from the configured remote is also
    // invalid: it gets recloned from the configured remote.
    const tick2 = runTick(sb, {
      CONDUCTOR_TELEGRAM_GATEWAY_REMOTE: `${sb.remote}${path.sep}`,
    });
    assert.equal(tick2.status, 0, tick2.stderr);
    assert.match(tick2.stdout, /not a valid clone .* recloning/);
  } finally {
    cleanup(sb);
  }
});

test("updater plist pins HOME, PATH, and the update log for headless launchd runs", () => {
  const plist = buildUpdaterPlist();
  const home = os.homedir();
  const logPath = path.join(home, ".conductor-telegram", "update.log");
  assert.match(plist, /<string>net\.belong\.conductor-telegram\.updater<\/string>/);
  // stdout and stderr both land in update.log — the file the script truncates.
  assert.equal(plist.split(`<string>${logPath}</string>`).length - 1, 2);
  // The deploy needs npm/node (Homebrew) and the conductor-telegram global
  // bin; launchd starts agents with a bare PATH unless we pin it.
  const expectedPath = [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  assert.ok(plist.includes(`<string>${expectedPath}</string>`));
  assert.match(plist, /<key>HOME<\/key>/);
  assert.ok(plist.includes(`<string>${home}</string>`));
});

test("the published package keeps gateway-update.sh two directory levels above the cli", () => {
  // service.ts resolves the script at <cli dir>/../../scripts/gateway-update.sh
  // for both src/cli (dev) and dist/cli (installed). That only holds if the
  // package ships scripts/ and tsup keeps cli output nested one dir under dist.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
  ) as { files: string[]; tsup: { entry: Record<string, string> } };
  assert.ok(pkg.files.includes("scripts/gateway-update.sh"));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "scripts", "gateway-update.sh")));
  assert.equal(pkg.tsup.entry["cli/service"], "src/cli/service.ts");
  assert.equal(
    fs.existsSync(
      path.resolve(REPO_ROOT, "src", "cli", "..", "..", "scripts", "gateway-update.sh")
    ),
    true
  );
});
