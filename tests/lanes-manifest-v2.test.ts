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
  manifestNeedsGitlab,
  parseLaneManifest,
  recurrenceIntervalMs,
} from "../src/lanes/manifest.js";
import { laneGenerationDue } from "../src/lanes/controller-policy.js";

function validManifest(promptPath: string, promptHash: string): Record<string, unknown> {
  return {
    version: 2,
    global: {
      provider_capacity: { claude: 3, codex: 2, cursor: 2 },
      provider_models: {
        claude: "fable-5-1",
        codex: "gpt-6-astra",
        cursor: "grok-4.7",
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
  swapped.global.provider_models.claude = "gpt-6-astra";
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

test("Manifest v2 accepts Claude Opus and Codex Sol backups while rejecting legacy provider models", () => {
  const base = validManifest("L1.md", "a".repeat(64));
  const claudeBackup = structuredClone(base) as any;
  claudeBackup.global.provider_models.claude = "opus-5-1m";
  assert.equal(
    parseLaneManifest(claudeBackup, "/tmp/manifest.json", {
      verifyPrompts: false,
    }).global.provider_models.claude,
    "opus-5-1m"
  );

  const codexBackup = structuredClone(base) as any;
  codexBackup.global.provider_models.codex = "gpt-6-sol";
  assert.equal(
    parseLaneManifest(codexBackup, "/tmp/manifest.json", {
      verifyPrompts: false,
    }).global.provider_models.codex,
    "gpt-6-sol"
  );

  const legacySonnet = structuredClone(base) as any;
  legacySonnet.global.provider_models.claude = "sonnet-5-1m";
  assert.throws(
    () =>
      parseLaneManifest(legacySonnet, "/tmp/manifest.json", {
        verifyPrompts: false,
      }),
    /Invalid enum value/
  );

  const legacySol = structuredClone(base) as any;
  legacySol.global.provider_models.codex = "gpt-5.6-sol";
  assert.throws(
    () =>
      parseLaneManifest(legacySol, "/tmp/manifest.json", {
        verifyPrompts: false,
      }),
    /Invalid enum value/
  );

  const legacyGrok = structuredClone(base) as any;
  legacyGrok.global.provider_models.cursor = "grok-4.6";
  assert.throws(
    () =>
      parseLaneManifest(legacyGrok, "/tmp/manifest.json", {
        verifyPrompts: false,
      }),
    /Invalid enum value/
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

test("recurring generations are inert by default and opt in without auto-merge", () => {
  const value = validManifest("L1.md", "a".repeat(64)) as any;
  value.lanes[0].policy = { kind: "recurring", schedule: "every 2h" };
  value.lanes[0].merge_policy.auto_merge = false;
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
      now: new Date("2026-09-05T12:00:00.000Z"),
    }),
    { due: false, generation: 2, recurring: true }
  );
  const enabledLane = {
    ...lane,
    policy: { ...lane.policy, enabled: true },
  } as typeof lane;
  assert.deepEqual(
    laneGenerationDue({
      lane: enabledLane,
      runs: [terminal],
      now: new Date("2026-09-04T12:00:00.000Z"),
    }),
    { due: true, generation: 2, recurring: true }
  );
  assert.equal(
    laneGenerationDue({
      lane: enabledLane,
      runs: [{ ...terminal, status: "implementing" }],
      now: new Date("2026-09-05T12:00:00.000Z"),
    }).due,
    false
  );
});

test("recurring lanes cannot opt into automatic merge", () => {
  const value = validManifest("L1.md", "a".repeat(64)) as any;
  value.lanes[0].policy = {
    kind: "recurring",
    enabled: true,
    schedule: "daily",
  };
  assert.throws(
    () => parseLaneManifest(value, "/tmp/manifest.json", { verifyPrompts: false }),
    /recurring lanes must not automatically merge/
  );
});

// Extended by /ship coverage audit with GitLab delivery and GitHub canonical evidence.
// Value: protects=manifestNeedsGitlab, which doctor and worker startup use to demand GITLAB_TOKEN, covers GitLab delivery and not GitHub canonical evidence;
//   fails_when=manifestNeedsGitlab drops its delivery-kind disjunct, so a GitLab lane starts without a gateway and the worker crashes mid-run;
//   why_new=only canonical-GitLab and plain-GitHub rows exist, and no test anywhere has a GitLab-delivered lane require the token; seam=none
test("Manifest v2 accepts Command Center's check allowlist and canonical evidence", () => {
  const value = validManifest("L1.md", "a".repeat(64)) as any;
  value.lanes[0].delivery_adapter = {
    kind: "github",
    required_checks: ["gitlab/lint-and-test"],
    check_allowlist: ["gitlab/lint-and-test", "test"],
    canonical_evidence: {
      kind: "gitlab",
      project_path: "nomadhub/mvp",
      base_branch: "dev",
    },
  };
  const parsed = parseLaneManifest(value, "/tmp/manifest.json", { verifyPrompts: false });
  assert.deepEqual(parsed.lanes[0].delivery_adapter, value.lanes[0].delivery_adapter);
  assert.equal(manifestNeedsGitlab(parsed), true);
  assert.equal(
    manifestNeedsGitlab(
      parseLaneManifest(validManifest("L1.md", "a".repeat(64)), "/tmp/manifest.json", {
        verifyPrompts: false,
      })
    ),
    false
  );
  const needsGitlab = (delivery: Record<string, unknown>) => {
    const manifest = validManifest("L1.md", "a".repeat(64)) as any;
    manifest.lanes[0].delivery_adapter = delivery;
    return manifestNeedsGitlab(
      parseLaneManifest(manifest, "/tmp/manifest.json", { verifyPrompts: false })
    );
  };
  assert.equal(needsGitlab({ kind: "gitlab" }), true, "GitLab delivery needs a GitLab token");
  assert.equal(
    needsGitlab({
      kind: "github",
      canonical_evidence: { kind: "github", project_path: "belongnet/canonical", base_branch: "main" },
    }),
    false,
    "GitHub canonical evidence needs no GitLab token"
  );
});

test("Manifest v2 without the new delivery fields keeps its revision", () => {
  const value = validManifest("L1.md", "a".repeat(64)) as any;
  value.lanes[0].delivery_adapter = { kind: "github", required_checks: ["test", "gate"] };
  const parsed = parseLaneManifest(value, "/tmp/manifest.json", { verifyPrompts: false });
  // A manifest that names neither field must stage under the revision it had
  // before they existed, so no default may be written into the parsed form.
  assert.equal(
    parsed.manifestHash,
    "e50aaf5e907bc3588e3d8fb65cba5c037241e18c8b5f61a91f410e67a925647c"
  );
  assert.equal("check_allowlist" in parsed.lanes[0].delivery_adapter, false);
  assert.equal("canonical_evidence" in parsed.lanes[0].delivery_adapter, false);
});

test("Manifest v2 refuses check profiles and canonical evidence Command Center refuses", () => {
  const parse = (delivery: Record<string, unknown>) => {
    const value = validManifest("L1.md", "a".repeat(64)) as any;
    value.lanes[0].delivery_adapter = delivery;
    return () => parseLaneManifest(value, "/tmp/manifest.json", { verifyPrompts: false });
  };
  assert.throws(
    parse({ kind: "github", required_checks: ["test", "gate"], check_allowlist: ["test"] }),
    /check_allowlist: must include every required check; missing gate/
  );
  assert.throws(
    parse({ kind: "github", check_allowlist: ["test", "test"] }),
    /allowed check names must be unique/
  );
  assert.throws(parse({ kind: "github", required_checks: ["-leading-dash"] }), /check name/);
  assert.throws(parse({ kind: "github", check_allowlist: ["semi;colon"] }), /check name/);
  const canonical = (evidence: Record<string, unknown>) =>
    parse({ kind: "github", canonical_evidence: evidence });
  assert.throws(
    canonical({ kind: "gitlab", project_path: "mvp", base_branch: "dev" }),
    /group\/project path/
  );
  assert.throws(
    canonical({ kind: "gitlab", project_path: "nomadhub//mvp", base_branch: "dev" }),
    /group\/project path/
  );
  assert.throws(
    canonical({ kind: "bitbucket", project_path: "nomadhub/mvp", base_branch: "dev" }),
    /canonical_evidence/
  );
  assert.throws(
    canonical({ kind: "gitlab", project_path: "nomadhub/mvp", base_branch: "  " }),
    /must not be blank/
  );
  assert.throws(
    canonical({ kind: "gitlab", project_path: "nomadhub/mvp", base_branch: "dev", ref: "dev" }),
    /Unrecognized key/
  );
});

test("GitHub canonical evidence names exactly owner/repository, while GitLab may nest groups", () => {
  const parse = (projectPath: string, kind: "github" | "gitlab") => {
    const value = validManifest("L1.md", "a".repeat(64)) as any;
    value.lanes[0].delivery_adapter = {
      kind: "github",
      canonical_evidence: { kind, project_path: projectPath, base_branch: "main" },
    };
    return () => parseLaneManifest(value, "/tmp/manifest.json", { verifyPrompts: false });
  };
  // The gate reads GitHub checks as owner/repo, so a deeper path would only
  // fail once a lane reached its merge gate.
  assert.throws(parse("belongnet/platform/site", "github"), /exactly owner\/repository/);
  assert.doesNotThrow(parse("belongnet/site", "github"));
  assert.doesNotThrow(parse("nomadhub/platform/site", "gitlab"));
});

test("check names and canonical branches stop exactly where Command Center stops them", () => {
  const checks = (name: string) => {
    const value = validManifest("L1.md", "a".repeat(64)) as any;
    value.lanes[0].delivery_adapter = { kind: "github", required_checks: [name] };
    return () => parseLaneManifest(value, "/tmp/manifest.json", { verifyPrompts: false });
  };
  assert.doesNotThrow(checks("a".repeat(255)));
  assert.doesNotThrow(checks("CI / build: lint-and-test"));
  assert.throws(checks("a".repeat(256)), /check name/);
  assert.throws(checks("test (ubuntu-latest, 20)"), /check name/);
  assert.throws(checks("tést"), /check name/);

  // Command Center refuses what Python's str.strip() empties, which includes
  // characters JavaScript's trim() keeps.
  for (const blank of ["  ", "\x85", "\x1c\x1d"]) {
    const value = validManifest("L1.md", "a".repeat(64)) as any;
    value.lanes[0].delivery_adapter = {
      kind: "github",
      canonical_evidence: { kind: "gitlab", project_path: "nomadhub/mvp", base_branch: blank },
    };
    assert.throws(
      () => parseLaneManifest(value, "/tmp/manifest.json", { verifyPrompts: false }),
      /must not be blank/,
      JSON.stringify(blank)
    );
  }
});

test("canonical evidence bounds stop where Command Center stops them", () => {
  const gitlab = (project_path: string, base_branch = "dev") => {
    const value = validManifest("L1.md", "a".repeat(64)) as any;
    value.lanes[0].delivery_adapter = {
      kind: "github",
      canonical_evidence: { kind: "gitlab", project_path, base_branch },
    };
    return () => parseLaneManifest(value, "/tmp/manifest.json", { verifyPrompts: false });
  };
  assert.doesNotThrow(gitlab("nomadhub/mvp", "b".repeat(255)));
  assert.throws(gitlab("nomadhub/mvp", "b".repeat(256)), /base_branch/);
  assert.doesNotThrow(gitlab(`g/${"p".repeat(256)}`));
  assert.throws(gitlab(`g/${"p".repeat(257)}`), /group\/project path/);
  assert.doesNotThrow(gitlab(`${"x".repeat(256)}/${"y".repeat(255)}`));
  assert.throws(gitlab(`${"x".repeat(256)}/${"y".repeat(256)}`), /project_path/);
  for (const unsafe of [
    "nomadhub/.hidden",
    "nomadhub/-x",
    "nomadhub/../mvp",
    "nomadhub/m vp",
    "nomadhub/mvp?x",
    "nomadhub/mvp#x",
    "nomadhub/mvp%2Fx",
  ]) {
    assert.throws(gitlab(unsafe), /group\/project path/, unsafe);
  }
});

function laneWith(edit: (lane: any) => void) {
  const value = validManifest("L1.md", "a".repeat(64)) as any;
  edit(value.lanes[0]);
  return () => parseLaneManifest(value, "/tmp/manifest.json", { verifyPrompts: false });
}

test("lane fields refuse the blanks and lengths Command Center refuses", () => {
  // Command Center refuses what Python's str.strip() empties.
  const blanks: Array<[string, (lane: any, blank: string) => void]> = [
    ["repository.base_branch", (lane, blank) => (lane.repository.base_branch = blank)],
    ["title", (lane, blank) => (lane.title = blank)],
    ["prompt.path", (lane, blank) => (lane.prompt.path = blank)],
    ["managed_tags", (lane, blank) => lane.managed_tags.push(blank)],
    ["command argument", (lane, blank) => (lane.validation_profile.commands = [["npm", "test", blank]])],
    [
      "policy.schedule",
      (lane, blank) => {
        lane.policy = { kind: "recurring", schedule: blank };
        lane.merge_policy.auto_merge = false;
      },
    ],
  ];
  for (const blank of ["  ", "\x85", "\x1c"]) {
    for (const [field, edit] of blanks) {
      assert.throws(
        laneWith((lane) => edit(lane, blank)),
        /must not be blank/,
        `${field} ${JSON.stringify(blank)}`
      );
    }
  }
  for (const [path, at, over, edit] of [
    ["base_branch", 255, 256, (lane: any, value: string) => (lane.repository.base_branch = value)],
    ["title", 240, 241, (lane: any, value: string) => (lane.title = value)],
    ["managed_tags", 128, 129, (lane: any, value: string) => lane.managed_tags.push(value)],
    [
      "commands",
      4096,
      4097,
      (lane: any, value: string) => (lane.validation_profile.commands = [["npm", "test", value]]),
    ],
  ] as const) {
    assert.doesNotThrow(laneWith((lane) => edit(lane, "x".repeat(at))), path);
    assert.throws(laneWith((lane) => edit(lane, "x".repeat(over))), new RegExp(path), path);
  }
});

test("validation commands stay inside the repository, as Command Center requires", () => {
  const command = (...argv: string[]) =>
    laneWith((lane) => (lane.validation_profile.commands = [argv]));
  for (const argv of [
    ["bash", "scripts/build_frontend_bundle.sh", "--check"],
    ["npm", "--prefix", "wizard", "test"],
    ["pnpm", "--filter", "website", "test:unit"],
    ["pnpm", "--filter", "@belong/web", "build"],
    ["npm", "--prefix=wizard", "test"],
    ["pnpm", "-Cpackages/web", "test"],
  ]) {
    assert.doesNotThrow(command(...argv), argv.join(" "));
  }
  for (const argv of [
    ["bash", "./scripts/test.sh"],
    ["bash", "/tmp/test.sh"],
    ["sh", "../test.sh"],
    ["bash", "scripts//test.sh"],
    ["bash", "scripts\\..\\test.sh"],
    ["npm", "--prefix", "/srv/app", "test"],
    ["npm", "--prefix", "../app", "test"],
    ["pnpm", "--filter", "./packages/web", "test"],
    ["yarn", "--cwd", "web/", "test"],
    // A path joined to its option stays inside the repository too.
    ["npm", "--prefix=/srv/app", "test"],
    ["pnpm", "--dir=../app", "test"],
    ["yarn", "--cwd=../app", "test"],
    ["pnpm", "-C../app", "test"],
    ["pnpm", "-C=/srv/app", "test"],
    ["npm", "--prefix=", "test"],
    // Python's case-insensitive match folds the long s into an s, and a
    // dotless or dotted I into an i.
    ["npm", "run", "test:pu\u017fh"],
    ["pytest", "publ\u0131sh"],
    ["pytest", "publ\u0130sh"],
  ]) {
    assert.throws(command(...argv), /bounded test\/lint/, argv.join(" "));
  }
});

test("validation probes must be public, as Command Center requires", () => {
  const probe = (url: string) =>
    laneWith((lane) => (lane.validation_profile = { commands: [], probes: [{ url, method: "GET" }] }));
  for (const url of [
    "https://example.com/health",
    "HTTP://Example.com:8080/status?x=1",
    "http://93.184.216.34/",
    "https://[2606:4700:4700::1111]/",
  ]) {
    assert.doesNotThrow(probe(url), url);
  }
  for (const url of [
    "http://localhost:3000/health",
    "http://LOCALHOST./",
    "http://api.localhost/",
    "http://printer.local/",
    "http://metadata/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://db.internal/",
    "http://router.home.arpa/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0/",
    "http://224.0.0.1/",
    "http://240.0.0.1/",
    "http://255.255.255.255/",
    "http://[::1]/",
    "http://[::]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://[ff02::1]/",
    "http://[2001:db8::1]/",
    // Shapes whose host Python and WHATWG URL parsers read differently.
    "http:example.com/",
    "http:///example.com/",
    "http://example.com\\@127.0.0.1/",
    " https://example.com/",
    "https://example.com/a b",
    "ftp://example.com/",
  ]) {
    assert.throws(probe(url), /public, read-only HTTP\(S\) URL/, url);
  }
});

test("recurring schedules stop at a year, as Command Center's do", () => {
  const schedule = (value: string) =>
    laneWith((lane) => {
      lane.policy = { kind: "recurring", schedule: value };
      lane.merge_policy.auto_merge = false;
    });
  for (const value of ["daily", " @Weekly ", "every 365d", "every 8760h", "EVERY 525600M", "every　 5 m"]) {
    assert.doesNotThrow(schedule(value), value);
  }
  for (const value of ["every 366d", "every 8761h", "every 525601m", `every ${"9".repeat(400)}d`, "every 0d", "hourly"]) {
    assert.throws(schedule(value), /unsupported recurring schedule/, value);
  }
});

test("the scheduler runs every recurring schedule the manifest accepts", () => {
  // Python's strip() and \s also cover \x1c-\x1f and \x85, which JavaScript's do not.
  for (const schedule of ["daily", " @Weekly ", "every 90m", "daily\x85", "\x1cdaily", "every\x855m", "every 5\x1fm"]) {
    const value = validManifest("L1.md", "a".repeat(64)) as any;
    value.lanes[0].policy = { kind: "recurring", enabled: true, schedule };
    value.lanes[0].merge_policy.auto_merge = false;
    const lane = parseLaneManifest(value, "/tmp/manifest.json", { verifyPrompts: false }).lanes[0];
    assert.equal(laneGenerationDue({ lane, runs: [] }).due, true, JSON.stringify(schedule));
  }
  assert.equal(recurrenceIntervalMs("daily"), 86_400_000);
  assert.equal(recurrenceIntervalMs(" @Weekly "), 7 * 86_400_000);
  assert.equal(recurrenceIntervalMs("every\x855m"), 5 * 60_000);
  assert.equal(recurrenceIntervalMs("every 8760h"), 365 * 86_400_000);
  assert.equal(recurrenceIntervalMs("every 8761h"), null);
  assert.equal(recurrenceIntervalMs("every 05m"), null);
});
