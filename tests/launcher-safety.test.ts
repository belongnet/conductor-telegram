import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAgentEnvironment,
  claudeAccessArgs,
  buildCodexExecArgs,
  resolveRemoteBaseCommit,
} from "../src/bot/launcher.js";

test("agent environment excludes bot and provider API-key variables", () => {
  const env = buildAgentEnvironment(
    {
      HOME: "/Users/operator",
      PATH: "/usr/bin:/bin",
      DB_PATH: "/tmp/conductor-telegram.db",
      BOT_TOKEN: "telegram-secret",
      CONDUCTOR_API_KEY: "conductor-secret",
      OPENAI_API_KEY: "provider-secret",
      ANTHROPIC_API_KEY: "provider-secret",
      GITHUB_TOKEN: "github-secret",
    },
    {
      agentType: "codex",
      workspaceName: "oslo",
      workspaceDir: "/workspaces/oslo",
      repoPath: "/repos/app",
    }
  );

  assert.notEqual(env.HOME, "/Users/operator");
  assert.match(env.HOME ?? "", /conductor-telegram-agents/);
  assert.equal(env.CODEX_HOME, "/Users/operator/.codex");
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.DB_PATH, undefined);
  assert.equal(env.CONDUCTOR_WORKSPACE_NAME, "oslo");
  assert.equal(env.CONDUCTOR_WORKSPACE_PATH, "/workspaces/oslo");
  assert.equal(env.CONDUCTOR_ROOT_PATH, "/repos/app");
  assert.equal(env.BOT_TOKEN, undefined);
  assert.equal(env.CONDUCTOR_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
});

test("Codex launches are sandboxed and never use the bypass flag", () => {
  const readOnly = buildCodexExecArgs(
    "gpt-5.5",
    "inspect",
    null,
    [],
    "read-only"
  );
  const writable = buildCodexExecArgs(
    "gpt-5.5",
    "implement",
    "session-1",
    [],
    "workspace-write"
  );
  for (const args of [readOnly, writable]) {
    assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    assert.deepEqual(args.slice(args.indexOf("--ask-for-approval"), args.indexOf("--ask-for-approval") + 2), [
      "--ask-for-approval",
      "never",
    ]);
    assert.equal(args.includes("mcp_servers={}"), true);
    assert.equal(args.includes("--ignore-user-config"), true);
    assert.equal(args.includes("--ignore-rules"), true);
    for (const feature of ["apps", "browser_use", "hooks", "multi_agent", "plugins"]) {
      assert.equal(
        args.some((value, index) => value === "--disable" && args[index + 1] === feature),
        true
      );
    }
    assert.ok(
      args.indexOf("--ask-for-approval") < args.indexOf("exec"),
      "global approval policy must precede the exec subcommand"
    );
  }
  assert.deepEqual(readOnly.slice(readOnly.indexOf("--sandbox"), readOnly.indexOf("--sandbox") + 2), [
    "--sandbox",
    "read-only",
  ]);
  assert.deepEqual(writable.slice(writable.indexOf("--sandbox"), writable.indexOf("--sandbox") + 2), [
    "--sandbox",
    "workspace-write",
  ]);
});

test("generated restricted arguments parse in Conductor's bundled Codex CLI", (t) => {
  const codexBin = path.join(
    os.homedir(),
    "Library/Application Support/com.conductor.app/bin/codex"
  );
  if (!existsSync(codexBin)) {
    t.skip("Conductor's bundled Codex CLI is not installed");
    return;
  }

  const cases = [
    buildCodexExecArgs("gpt-5.5", "inspect", null, [], "read-only").slice(0, -1),
    buildCodexExecArgs(
      "gpt-5.5",
      "implement",
      "00000000-0000-0000-0000-000000000000",
      [],
      "workspace-write"
    ).slice(0, -1),
  ];
  for (const args of cases) {
    assert.doesNotThrow(() =>
      execFileSync(codexBin, [...args, "--help"], {
        encoding: "utf8",
        stdio: "pipe",
      })
    );
  }
});

test("restricted Claude launches expose file tools without project MCP", () => {
  const readOnly = claudeAccessArgs("read-only");
  const writable = claudeAccessArgs("workspace-write");

  assert.equal(readOnly[readOnly.indexOf("--tools") + 1], "Read,Glob,Grep");
  assert.equal(
    readOnly[readOnly.indexOf("--allowedTools") + 1],
    "Read(./**),Glob,Grep"
  );
  assert.equal(
    writable[writable.indexOf("--allowedTools") + 1],
    "Read(./**),Edit(./**),Write(./**),Glob,Grep"
  );
  for (const args of [readOnly, writable]) {
    assert.equal(args[args.indexOf("--setting-sources") + 1], "");
    assert.equal(args.includes("--strict-mcp-config"), true);
    assert.equal(args.includes('{"mcpServers":{}}'), true);
    assert.equal(args.includes("--disable-slash-commands"), true);
    assert.equal(args.includes("--safe-mode"), true);
    assert.equal(args.includes("--no-chrome"), true);
  }
});

test("generated restricted arguments parse in Conductor's bundled Claude CLI", (t) => {
  const claudeBin = path.join(
    os.homedir(),
    "Library/Application Support/com.conductor.app/bin/claude"
  );
  if (!existsSync(claudeBin)) {
    t.skip("Conductor's bundled Claude CLI is not installed");
    return;
  }
  assert.doesNotThrow(() =>
    execFileSync(
      claudeBin,
      [
        "-p",
        "inspect",
        "--output-format",
        "stream-json",
        "--verbose",
        "--session-id",
        "00000000-0000-0000-0000-000000000000",
        "--max-turns",
        "1000",
        "--model",
        "claude-fable-5",
        ...claudeAccessArgs("read-only"),
        "--help",
      ],
      { encoding: "utf8", stdio: "pipe" }
    )
  );
});

test("remote base resolution fetches and pins the exact origin commit", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-base-"));
  const remote = path.join(dir, "remote.git");
  const source = path.join(dir, "source");
  try {
    mkdirSync(source);
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init"], { cwd: source });
    execFileSync("git", ["config", "user.name", "Test Operator"], { cwd: source });
    execFileSync("git", ["config", "user.email", "operator@example.com"], { cwd: source });
    writeFileSync(path.join(source, "README.md"), "pinned\n");
    execFileSync("git", ["add", "README.md"], { cwd: source });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: source });
    execFileSync("git", ["branch", "-M", "main"], { cwd: source });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: source });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: source });

    const expected = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
    }).trim();
    assert.equal(await resolveRemoteBaseCommit(source, "main"), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
