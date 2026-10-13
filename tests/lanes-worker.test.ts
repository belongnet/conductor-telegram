import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { missingLaneWorkerAlertConfig, runLaneWorker } from "../src/lanes/worker.js";

test("every lease worker requires send-only Telegram alert credentials", () => {
  assert.deepEqual(missingLaneWorkerAlertConfig({}), [
    "BOT_TOKEN",
    "OWNER_CHAT_ID",
  ]);
  assert.deepEqual(
    missingLaneWorkerAlertConfig({ BOT_TOKEN: "token", OWNER_CHAT_ID: "123" }),
    []
  );
  assert.deepEqual(
    missingLaneWorkerAlertConfig({ BOT_TOKEN: "  ", OWNER_CHAT_ID: "123" }),
    ["BOT_TOKEN"]
  );
});

test("the worker refuses GitLab-proven lanes without GITLAB_TOKEN before claiming a lease", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-worker-gitlab-"));
  try {
    fs.writeFileSync(path.join(dir, "L1.md"), "Do the bounded test task.\n");
    const manifestPath = path.join(dir, "manifest.v2.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 2,
        global: {
          provider_capacity: { claude: 3, codex: 2, cursor: 2 },
          provider_models: { claude: "fable-5-1", codex: "gpt-6-astra", cursor: "grok-4.7" },
        },
        lanes: [
          {
            id: "L1",
            repository: { owner: "belongnet", name: "example", base_branch: "main" },
            prompt: {
              path: "L1.md",
              sha256: createHash("sha256").update("Do the bounded test task.\n").digest("hex"),
            },
            priority: 1,
            preferred_providers: ["claude"],
            fallback_providers: ["codex", "cursor"],
            dependencies: [],
            policy: { kind: "one_shot" },
            delivery_adapter: {
              kind: "github",
              canonical_evidence: { kind: "gitlab", project_path: "nomadhub/mvp", base_branch: "dev" },
            },
            merge_policy: { method: "squash", auto_merge: true, deploy_notes: "", replay_notes: "" },
            validation_profile: { commands: [["npm", "test"]], probes: [] },
            managed_tags: ["managed:growth", "lane:L1"],
          },
        ],
      })
    );
    const statePath = path.join(dir, "state.db");
    await assert.rejects(
      runLaneWorker({
        env: {
          LANES_SITE: "ovh",
          BOT_TOKEN: "bot",
          OWNER_CHAT_ID: "1",
          LANES_MANIFEST: manifestPath,
          LANES_STATE_BACKEND: "sqlite",
          LANES_STANDALONE: "1",
          LANES_SQLITE_PATH: statePath,
          CONDUCTOR_API_KEY: "con",
        },
        // Even if the refusal regressed, an aborted worker never enters its loop.
        signal: AbortSignal.abort(),
        log: () => undefined,
      }),
      /canonical GitLab evidence but GITLAB_TOKEN is missing/
    );
    assert.equal(fs.existsSync(statePath), false, "a refused start opens no lane store");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
