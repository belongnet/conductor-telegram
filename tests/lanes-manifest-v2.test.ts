import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  LaneManifestError,
  canonicalManifestJson,
  manifestHash,
  parseLaneManifest,
} from "../src/lanes/manifest.js";
import { laneGenerationDue } from "../src/lanes/controller-policy.js";

function validManifest(promptPath: string, promptHash: string): Record<string, unknown> {
  return {
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
        title: "Example",
        repository: { owner: "belongnet", name: "example", base_branch: "main" },
        prompt: { path: promptPath, sha256: promptHash },
        priority: 100,
        preferred_providers: ["claude"],
        fallback_providers: ["codex", "cursor"],
        dependencies: [],
        policy: { kind: "one_shot" },
        delivery_adapter: { kind: "github" },
        merge_policy: {
          method: "squash",
          auto_merge: true,
          deploy_notes: "none",
          replay_notes: "none",
        },
        validation_profile: { commands: [["npm", "test"]], probes: [] },
        managed_tags: ["managed:growth", "lane:L1"],
      },
    ],
  };
}

test("Manifest v2 verifies prompt hashes and has a stable canonical hash", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-manifest-v2-"));
  try {
    const prompt = path.join(root, "L1.md");
    fs.writeFileSync(prompt, "unchanged prompt\n");
    const digest = createHash("sha256").update(fs.readFileSync(prompt)).digest("hex");
    const value = validManifest("L1.md", digest);
    const parsed = parseLaneManifest(value, path.join(root, "manifest.json"));
    assert.equal(parsed.lanes[0].prompt.sha256, digest);
    assert.equal(parsed.manifestHash, manifestHash(value));
    assert.equal(
      canonicalManifestJson({ z: 1, a: [2, 3] }),
      '{"a":[2,3],"z":1}'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Manifest v2 rejects runtime bindings, unknown/swapped models, cap drift, and cycles", () => {
  const base = validManifest("L1.md", "a".repeat(64));
  const runtime = structuredClone(base) as any;
  runtime.lanes[0].workspaceId = "pinned-old-workspace";
  assert.throws(
    () => parseLaneManifest(runtime, "/tmp/manifest.json", { verifyPrompts: false }),
    /Runtime IDs\/URLs\/reset timestamps/
  );

  const swapped = structuredClone(base) as any;
  swapped.global.provider_models.claude = "gpt-5.6-sol";
  assert.throws(
    () => parseLaneManifest(swapped, "/tmp/manifest.json", { verifyPrompts: false }),
    /must be fable-5-1/
  );

  const caps = structuredClone(base) as any;
  caps.global.provider_capacity.codex = 3;
  assert.throws(
    () => parseLaneManifest(caps, "/tmp/manifest.json", { verifyPrompts: false }),
    /must be 2/
  );

  const cycle = structuredClone(base) as any;
  const second = structuredClone(cycle.lanes[0]);
  second.id = "L2";
  second.dependencies = [{ lane_id: "L1", milestone: "merged" }];
  cycle.lanes[0].dependencies = [{ lane_id: "L2", milestone: "pr_opened" }];
  cycle.lanes.push(second);
  assert.throws(
    () => parseLaneManifest(cycle, "/tmp/manifest.json", { verifyPrompts: false }),
    (error: unknown) =>
      error instanceof LaneManifestError && /cycle/.test(error.message)
  );

  const unsupportedSchedule = structuredClone(base) as any;
  unsupportedSchedule.lanes[0].policy = {
    kind: "recurring",
    schedule: "0 3 * * *",
  };
  assert.throws(
    () =>
      parseLaneManifest(unsupportedSchedule, "/tmp/manifest.json", {
        verifyPrompts: false,
      }),
    /unsupported recurring schedule/
  );

  const incompleteRotation = structuredClone(base) as any;
  incompleteRotation.lanes[0].fallback_providers = ["codex"];
  assert.throws(
    () =>
      parseLaneManifest(incompleteRotation, "/tmp/manifest.json", {
        verifyPrompts: false,
      }),
    /must include claude, codex, and cursor/
  );

  const unusedMirrorBinding = structuredClone(base) as any;
  unusedMirrorBinding.lanes[0].delivery_adapter = {
    kind: "gitlab",
    mirror_repository: "example-org/example-repo",
  };
  assert.throws(
    () =>
      parseLaneManifest(unusedMirrorBinding, "/tmp/manifest.json", {
        verifyPrompts: false,
      }),
    /Unrecognized key.*mirror_repository/
  );

  for (const unsafeCommand of [
    ["npm", "run", "deploy"],
    ["git", "push", "origin", "main"],
    ["bash", "-c", "npm test"],
  ]) {
    const unsafeValidation = structuredClone(base) as any;
    unsafeValidation.lanes[0].validation_profile.commands = [unsafeCommand];
    assert.throws(
      () =>
        parseLaneManifest(unsafeValidation, "/tmp/manifest.json", {
          verifyPrompts: false,
        }),
      /bounded test\/lint\/typecheck\/build\/check command/
    );
  }

  const unsafeProbe = structuredClone(base) as any;
  unsafeProbe.lanes[0].validation_profile = {
    commands: [],
    probes: [{ url: "file:///etc/passwd", method: "GET" }],
  };
  assert.throws(
    () =>
      parseLaneManifest(unsafeProbe, "/tmp/manifest.json", {
        verifyPrompts: false,
      }),
    /read-only HTTP\(S\) URL/
  );
});

test("Manifest v2 confines prompts to regular files beneath its directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lane-manifest-paths-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lane-prompt-outside-"));
  try {
    const outsidePrompt = path.join(outside, "secret.md");
    fs.writeFileSync(outsidePrompt, "must not be loaded\n");
    const digest = createHash("sha256")
      .update(fs.readFileSync(outsidePrompt))
      .digest("hex");
    const manifestPath = path.join(root, "manifest.json");

    for (const unsafePath of [outsidePrompt, "../secret.md", "prompts\\secret.md"] as const) {
      assert.throws(
        () => parseLaneManifest(validManifest(unsafePath, digest), manifestPath),
        /relative path|contained by the manifest directory/
      );
    }

    const link = path.join(root, "linked.md");
    fs.symlinkSync(outsidePrompt, link);
    assert.throws(
      () => parseLaneManifest(validManifest("linked.md", digest), manifestPath),
      /beneath the manifest directory/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("recurring generations wait for a terminal interval and never overlap", () => {
  const value = validManifest("L1.md", "a".repeat(64)) as any;
  value.lanes[0].policy = { kind: "recurring", schedule: "every 2h" };
  const lane = parseLaneManifest(value, "/tmp/manifest.json", {
    verifyPrompts: false,
  }).lanes[0];
  const terminal = {
    lane_id: "L1",
    generation: 1,
    status: "validated",
    terminal_at: "2026-09-04T10:00:00.000Z",
    updated_at: "2026-09-04T10:00:00.000Z",
  } as any;
  assert.deepEqual(
    laneGenerationDue({
      lane,
      runs: [terminal],
      now: new Date("2026-09-04T11:59:59.999Z"),
    }),
    { due: false, generation: 2, recurring: true }
  );
  assert.deepEqual(
    laneGenerationDue({
      lane,
      runs: [terminal],
      now: new Date("2026-09-04T12:00:00.000Z"),
    }),
    { due: true, generation: 2, recurring: true }
  );
  assert.equal(
    laneGenerationDue({
      lane,
      runs: [{ ...terminal, status: "implementing" }],
      now: new Date("2026-09-05T12:00:00.000Z"),
    }).due,
    false
  );
});
