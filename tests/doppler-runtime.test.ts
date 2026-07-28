import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildServiceDopplerEnvironment,
  buildDopplerRunArgs,
  DopplerRuntimeError,
  stripDopplerManagedConfig,
} from "../src/cli/doppler.js";
import {
  buildBotPlist,
  buildBotProgramArguments,
} from "../src/cli/service.js";

test("Doppler runtime injects only the explicit conductor-telegram allowlist", () => {
  const runtime = {
    executable: "/opt/homebrew/bin/doppler",
    project: "example-app",
    config: "production",
    secretNames: [
      "BOT_TOKEN",
      "CONDUCTOR_API_KEY",
    ],
  };
  const command = ["/opt/node/bin/node", "/opt/app/cli/index.js", "start"];
  const args = buildDopplerRunArgs(runtime, command);

  assert.deepEqual(args.slice(0, 5), [
    "run",
    "--project",
    "example-app",
    "--config",
    "production",
  ]);
  assert.equal(
    args[args.indexOf("--only-secrets") + 1],
    "BOT_TOKEN,CONDUCTOR_API_KEY"
  );
  assert.deepEqual(args.slice(args.indexOf("--") + 1), command);
  assert.equal(args.some((value) => value.includes("secret-value")), false);
});

test("Doppler runtime rejects an empty or widened secret allowlist", () => {
  const runtime = {
    project: "example-app",
    config: "production",
  };
  assert.throws(
    () => buildDopplerRunArgs({ ...runtime, secretNames: [] }, ["/usr/bin/true"]),
    DopplerRuntimeError
  );
  assert.throws(
    () =>
      buildDopplerRunArgs(
        { ...runtime, secretNames: ["UNRELATED_SECRET"] },
        ["/usr/bin/true"]
      ),
    DopplerRuntimeError
  );
});

test("launchd validation cannot rely on ephemeral tokens or inherited bot secrets", () => {
  const sanitized = buildServiceDopplerEnvironment({
    HOME: "/Users/gateway",
    PATH: "/opt/homebrew/bin:/usr/bin",
    DOPPLER_TOKEN: "ephemeral-service-token",
    DOPPLER_PROJECT: "example-app",
    DOPPLER_CONFIG: "production",
    DOPPLER_CONFIG_DIR: "/Users/gateway/.doppler",
    BOT_TOKEN: "inherited-bot-token",
    CONDUCTOR_API_KEY: "inherited-conductor-key",
  });

  assert.equal(sanitized.HOME, "/Users/gateway");
  assert.equal(sanitized.PATH, "/opt/homebrew/bin:/usr/bin");
  assert.equal(sanitized.DOPPLER_CONFIG_DIR, "/Users/gateway/.doppler");
  assert.equal(sanitized.DOPPLER_TOKEN, undefined);
  assert.equal(sanitized.DOPPLER_PROJECT, undefined);
  assert.equal(sanitized.DOPPLER_CONFIG, undefined);
  assert.equal(sanitized.BOT_TOKEN, undefined);
  assert.equal(sanitized.CONDUCTOR_API_KEY, undefined);
});

test("Doppler-managed values are removed from persisted bot config", () => {
  const config = {
    version: 1 as const,
    botToken: "local-token",
    ownerChatId: "123",
    ownerUserId: "456",
    conductorApiBaseUrl: "https://api.conductor.build",
    conductorApiKey: "local-conductor-key",
    conductorCloudBackend: "api" as const,
    dopplerProject: "example-app",
    dopplerConfig: "production",
  };
  const stripped = stripDopplerManagedConfig(
    config,
    new Set([
      "BOT_TOKEN",
      "OWNER_CHAT_ID",
      "CONDUCTOR_API_KEY",
    ])
  );

  assert.equal(stripped.botToken, "");
  assert.equal(stripped.ownerChatId, "");
  assert.equal(stripped.conductorApiKey, undefined);
  assert.equal(stripped.ownerUserId, "456");
  assert.equal(stripped.conductorCloudBackend, "api");
  assert.equal(stripped.dopplerProject, "example-app");
  assert.equal(stripped.dopplerConfig, "production");
});

test("launchd plist delegates through Doppler without embedding credentials", () => {
  const options = {
    doppler: {
      executable: "/opt/homebrew/bin/doppler",
      project: "example-app",
      config: "production",
      secretNames: [
        "BOT_TOKEN",
        "CONDUCTOR_API_KEY",
      ],
    },
    nodePath: "/opt/node/bin/node",
    cliPath: "/opt/conductor-telegram/cli/index.js",
  };
  const args = buildBotProgramArguments(options);
  const plist = buildBotPlist(options);

  assert.equal(args[0], "/opt/homebrew/bin/doppler");
  assert.deepEqual(args.slice(-5), [
    "/opt/node/bin/node",
    "/opt/conductor-telegram/cli/index.js",
    "start",
    "--quiet",
    "--no-color",
  ]);
  for (const argument of args) {
    assert.match(plist, new RegExp(escapeRegExp(argument)));
  }
  assert.equal(plist.includes("service-secret-value"), false);
  assert.equal(plist.includes("<key>DOPPLER_TOKEN</key>"), false);
  assert.equal(args.includes("/bin/sh"), false);
});

test("config accepts paired Doppler references and rejects partial references", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ct-doppler-config-"));
  try {
    const run = (env: NodeJS.ProcessEnv) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          'const { loadConfig } = await import("./src/cli/config.ts"); console.log(JSON.stringify(loadConfig()));',
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: home,
            BOT_TOKEN: "test-token",
            OWNER_CHAT_ID: "1",
            ...env,
          },
          encoding: "utf8",
        }
      );

    const valid = run({
      CONDUCTOR_TELEGRAM_DOPPLER_PROJECT: "example-app",
      CONDUCTOR_TELEGRAM_DOPPLER_CONFIG: "production",
    });
    assert.equal(valid.status, 0, valid.stderr);
    const parsed = JSON.parse(valid.stdout) as {
      dopplerProject: string;
      dopplerConfig: string;
    };
    assert.equal(parsed.dopplerProject, "example-app");
    assert.equal(parsed.dopplerConfig, "production");

    const partial = run({
      CONDUCTOR_TELEGRAM_DOPPLER_PROJECT: "example-app",
      CONDUCTOR_TELEGRAM_DOPPLER_CONFIG: "",
    });
    assert.notEqual(partial.status, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
