import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHelperEnvironment, CHILD_ENV_ALLOWLIST } from "../src/bot/child-env.js";
import {
  parseCliOutput,
  parseCliOutputDetailed,
  parseRouteJson,
  parseRouteJsonDetailed,
  type RouteParseFailureReason,
  type RouteParseResult,
} from "../src/bot/ai-router.js";

function assertParseFailure(
  result: RouteParseResult,
  reason: RouteParseFailureReason
): void {
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected route parser to reject the payload");
  assert.equal(result.reason, reason);
  assert.equal(typeof result.preview, "string");
}

test("CLI envelope accepts new route with blank irrelevant workspaceId", () => {
  const payload = {
    transcript: "voice transcript",
    action: "new",
    repoName: "aideployco",
    workspaceId: "",
    prompt: "Create the README section.",
  };
  const output = JSON.stringify({
    type: "result",
    result: JSON.stringify(payload),
  });

  assert.deepEqual(parseCliOutput(output), {
    transcript: "voice transcript",
    action: "new",
    repoName: "aideployco",
    workspaceId: undefined,
    prompt: "Create the README section.",
  });
});

test("new routes require a non-empty repoName", () => {
  const base = {
    transcript: "voice transcript",
    action: "new",
    prompt: "Create the README section.",
  };

  for (const repoName of [undefined, null, "", 42]) {
    const payload =
      repoName === undefined ? base : { ...base, repoName };
    assert.equal(parseRouteJson(JSON.stringify(payload)), null);
  }
});

test("existing route accepts null irrelevant repoName", () => {
  const payload = {
    transcript: "follow-up",
    action: "existing",
    repoName: null,
    workspaceId: "workspace-1",
    prompt: "Apply that fix.",
  };

  assert.deepEqual(parseRouteJson(JSON.stringify(payload)), {
    transcript: "follow-up",
    action: "existing",
    repoName: undefined,
    workspaceId: "workspace-1",
    prompt: "Apply that fix.",
  });
});

test("existing route accepts blank irrelevant repoName", () => {
  const payload = {
    transcript: "follow-up",
    action: "existing",
    repoName: "",
    workspaceId: "workspace-1",
    prompt: "Apply that fix.",
  };

  assert.deepEqual(parseRouteJson(JSON.stringify(payload)), {
    transcript: "follow-up",
    action: "existing",
    repoName: undefined,
    workspaceId: "workspace-1",
    prompt: "Apply that fix.",
  });
});

test("existing route can fall back to repo when workspaceId is missing", () => {
  const payload = {
    transcript: "follow-up",
    action: "existing",
    repoName: "conductor-telegram",
    workspaceId: null,
    prompt: "Apply that fix.",
  };

  assert.deepEqual(parseRouteJson(JSON.stringify(payload)), {
    transcript: "follow-up",
    action: "existing",
    repoName: "conductor-telegram",
    workspaceId: undefined,
    prompt: "Apply that fix.",
  });
});

test("existing routes require a workspaceId or repoName fallback", () => {
  const base = {
    transcript: "follow-up",
    action: "existing",
    prompt: "Apply that fix.",
  };

  for (const workspaceId of [undefined, null, "", 42]) {
    const payload =
      workspaceId === undefined ? base : { ...base, workspaceId };
    assert.equal(parseRouteJson(JSON.stringify(payload)), null);
  }
});

test("router JSON inside markdown code fences still parses", () => {
  const text = [
    "```json",
    JSON.stringify({
      transcript: "voice transcript",
      action: "new",
      repoName: "conductor-telegram",
      workspaceId: null,
      prompt: "Fix voice routing.",
    }),
    "```",
  ].join("\n");

  assert.deepEqual(parseRouteJson(text), {
    transcript: "voice transcript",
    action: "new",
    repoName: "conductor-telegram",
    workspaceId: undefined,
    prompt: "Fix voice routing.",
  });
});

test("route parser reports stable failure reasons", () => {
  const cases: Array<[RouteParseFailureReason, string]> = [
    ["invalid_json", "not json"],
    ["invalid_action", JSON.stringify({ action: "archive", prompt: "Do it." })],
    ["missing_prompt", JSON.stringify({ action: "new", repoName: "conductor-telegram" })],
    [
      "invalid_optional_repo_name",
      JSON.stringify({ action: "existing", repoName: 42, workspaceId: "workspace-1", prompt: "Do it." }),
    ],
    [
      "invalid_optional_workspace_id",
      JSON.stringify({ action: "new", repoName: "conductor-telegram", workspaceId: 42, prompt: "Do it." }),
    ],
    ["missing_new_repo", JSON.stringify({ action: "new", prompt: "Do it." })],
    ["missing_existing_target", JSON.stringify({ action: "existing", prompt: "Do it." })],
  ];

  for (const [reason, payload] of cases) {
    assertParseFailure(parseRouteJsonDetailed(payload), reason);
  }
});

test("CLI envelope reports malformed result shape", () => {
  const output = JSON.stringify({
    type: "result",
    result: { action: "new", repoName: "conductor-telegram", prompt: "Do it." },
  });

  assertParseFailure(parseCliOutputDetailed(output), "invalid_cli_envelope");
});

const BOT_SECRETS = [
  "BELONG_APPROVAL_CHANNEL_KEY",
  "BELONG_HUMAN_APPROVAL_KEY",
  "COMMAND_CENTER_API_KEY",
  "CONDUCTOR_API_KEY",
  "BOT_TOKEN",
  "GITLAB_TOKEN",
];

test("the bot's helper processes get the agent allowlist and HOME, never its credentials", () => {
  const source = Object.fromEntries([
    ...BOT_SECRETS.map((name) => [name, "secret"]),
    ...CHILD_ENV_ALLOWLIST.map((name) => [name, `value-${name}`]),
    ["HOME", "/Users/operator"],
    ["CLAUDE_CONFIG_DIR", "/Users/operator/.claude-alt"],
    ["DOPPLER_TOKEN", "dp.st.secret"],
  ]);
  const env = buildHelperEnvironment(source);
  for (const name of BOT_SECRETS) assert.equal(env[name], undefined, name);
  assert.equal(env.DOPPLER_TOKEN, undefined);
  assert.equal(env.HOME, "/Users/operator");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/Users/operator/.claude-alt");
  assert.deepEqual(Object.keys(env).sort(), [...CHILD_ENV_ALLOWLIST, "HOME", "CLAUDE_CONFIG_DIR"].sort());
});

test("the router's Claude CLI and the voice tools are started without the bot's credentials", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-router-env-"));
  try {
    // Each stand-in records only the names of the variables it was given.
    const tool = (name: string, output = ""): string => {
      const file = path.join(dir, name);
      writeFileSync(file, `#!/bin/sh\n/usr/bin/env | /usr/bin/cut -d= -f1 > "${path.join(dir, `${name}.names`)}"\n${output ? `echo ${output}\n` : ""}`);
      chmodSync(file, 0o755);
      return file;
    };
    const claude = tool("claude");
    const convert = tool("convert");
    const whisper = tool("whisper", "hello");
    const model = path.join(dir, "model.bin");
    const voice = path.join(dir, "voice.ogg");
    writeFileSync(model, "");
    writeFileSync(voice, "");
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "-e", `
        const router = await import("./src/bot/ai-router.ts");
        await router.routeTextMessage("hello", [], []);
        console.log("TRANSCRIPT=" + await router.transcribeVoiceMessage(process.env.TEST_VOICE_PATH));
      `],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ...Object.fromEntries(BOT_SECRETS.map((name) => [name, `secret-${name}`])),
          CLAUDE_BIN: claude,
          AFCONVERT_BIN: convert,
          FFMPEG_BIN: convert,
          TELEGRAM_WHISPER_BIN: whisper,
          TELEGRAM_WHISPER_MODEL: model,
          TELEGRAM_WHISPER_CPP_DIR: dir,
          TEST_VOICE_PATH: voice,
        },
      }
    );
    assert.match(output, /TRANSCRIPT=hello/, "the voice tools really ran");
    for (const name of ["claude", "convert", "whisper"]) {
      const names = readFileSync(path.join(dir, `${name}.names`), "utf8").split("\n").filter(Boolean);
      assert.ok(names.includes("PATH") && names.includes("HOME"), `${name} keeps PATH and HOME`);
      for (const secret of BOT_SECRETS) assert.equal(names.includes(secret), false, `${name} must not inherit ${secret}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
