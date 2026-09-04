import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LanesConfigError,
  loadLanesConfig,
} from "../src/lanes/config.js";

test("lanes config is inert when the file is absent", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-lanes-missing-"));
  try {
    const loaded = loadLanesConfig({
      LANES_CONFIG: path.join(dir, "lanes.json"),
      HOME: dir,
    });
    assert.equal(loaded, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lanes config accepts placeholder example values", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-lanes-ok-"));
  const configPath = path.join(dir, "lanes.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      intervalMinutes: 30,
      providers: {
        primary: {
          agent: "claude",
          model: "claude-example-model",
          effort: "high",
          gapHours: 4.5,
          maxActive: 1,
        },
      },
      lanes: [
        {
          id: "L1",
          title: "Example first lane",
          provider: "any",
          repoUrl: "https://github.com/example-org/example-repo",
          prompt: "prompts/l1.md",
        },
      ],
    })
  );
  try {
    const loaded = loadLanesConfig({ LANES_CONFIG: configPath });
    assert.equal(loaded?.intervalMinutes, 30);
    assert.equal(loaded?.lanes[0]?.id, "L1");
    assert.equal(loaded?.configPath, configPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lanes config rejects an unknown provider", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-lanes-bad-"));
  const configPath = path.join(dir, "lanes.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      intervalMinutes: 30,
      providers: {
        primary: {
          agent: "claude",
          model: "claude-example-model",
          gapHours: 4.5,
        },
      },
      lanes: [
        {
          id: "L1",
          title: "Example first lane",
          provider: "missing",
          repoUrl: "https://github.com/example-org/example-repo",
          prompt: "prompts/l1.md",
        },
      ],
    })
  );
  try {
    assert.throws(
      () => loadLanesConfig({ LANES_CONFIG: configPath }),
      LanesConfigError
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lanes config validates optional delivery rotations", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-lanes-delivery-"));
  const configPath = path.join(dir, "lanes.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      intervalMinutes: 30,
      providers: {
        author: { agent: "claude", model: "author-model", gapHours: 4 },
        reviewer: { agent: "codex", model: "review-model", gapHours: 4 },
        validator: { agent: "cursor", model: "validation-model", gapHours: 4 },
      },
      lanes: [
        {
          id: "L1",
          title: "Example delivery",
          provider: "author",
          repoUrl: "https://github.com/example-org/example-repo",
          prompt: "prompts/author.md",
          delivery: {
            review: { rotation: ["reviewer", "validator"], prompt: "prompts/review.md" },
            finals: { rotation: ["reviewer", "validator"], prompt: "prompts/final.md" },
            merge: { rotation: ["validator"], prompt: "prompts/merge.md" },
            validation: {
              rotation: ["reviewer"],
              prompt: "prompts/validation.md",
              verification: "npm test",
            },
          },
        },
      ],
    })
  );
  try {
    const loaded = loadLanesConfig({ LANES_CONFIG: configPath });
    assert.equal(loaded?.lanes[0]?.delivery?.merge?.method, "squash");
    assert.deepEqual(loaded?.lanes[0]?.delivery?.finals?.rotation, [
      "reviewer",
      "validator",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lanes config rejects a merge rotation containing only the author", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-lanes-self-merge-"));
  const configPath = path.join(dir, "lanes.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      intervalMinutes: 30,
      providers: {
        author: { agent: "claude", model: "author-model", gapHours: 4 },
        reviewer: { agent: "codex", model: "review-model", gapHours: 4 },
        validator: { agent: "cursor", model: "validation-model", gapHours: 4 },
      },
      lanes: [
        {
          id: "L1",
          title: "Example delivery",
          provider: "author",
          repoUrl: "https://github.com/example-org/example-repo",
          prompt: "prompts/author.md",
          delivery: {
            finals: {
              rotation: ["reviewer", "validator"],
              prompt: "prompts/final.md",
            },
            merge: { rotation: ["author"], prompt: "prompts/merge.md" },
          },
        },
      ],
    }),
  );
  try {
    assert.throws(
      () => loadLanesConfig({ LANES_CONFIG: configPath }),
      /merge rotation needs a provider other than the author/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
