import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractInlineMedia,
  resolveWorkspaceMediaFile,
} from "../src/bot/media.js";

test("workspace media resolution rejects traversal and escaping symlinks", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ct-media-root-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "ct-media-outside-"));
  try {
    const insideFile = path.join(root, "report.txt");
    const outsideFile = path.join(outside, "secret.txt");
    const escapingLink = path.join(root, "linked-secret.txt");
    writeFileSync(insideFile, "safe");
    writeFileSync(outsideFile, "private");
    symlinkSync(outsideFile, escapingLink);

    assert.equal(
      resolveWorkspaceMediaFile(insideFile, root)?.filePath,
      realpathSync(insideFile)
    );
    assert.equal(resolveWorkspaceMediaFile(outsideFile, root), null);
    assert.equal(
      resolveWorkspaceMediaFile(path.relative(root, outsideFile), root),
      null
    );
    assert.equal(resolveWorkspaceMediaFile(escapingLink, root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("inline extraction leaves blocked local references in the message", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ct-media-text-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "ct-media-text-outside-"));
  try {
    const outsideFile = path.join(outside, "secret.txt");
    writeFileSync(outsideFile, "private");

    const result = extractInlineMedia(
      `Do not upload [secret](${outsideFile}).`,
      root
    );

    assert.equal(result.media.length, 0);
    assert.match(result.cleanedText, /secret/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("attacker-supplied extensions cannot steer the download path", async () => {
  const { safeExtension } = await import("../src/bot/commands.js");
  const downloads = "/Users/operator/.conductor-telegram/downloads";

  const hostile = [
    ".../../../../../../.claude/settings.json",
    "./../../Library/LaunchAgents/com.conductor-telegram.bot.plist",
    "..",
    "./..",
    ".a/b",
    "",
    "   ",
  ];
  for (const ext of hostile) {
    const resolved = safeExtension(ext);
    assert.equal(resolved, ".bin", `${JSON.stringify(ext)} must be rejected`);
    // The staged path must stay a direct child of the downloads directory.
    assert.equal(
      path.dirname(path.join(downloads, `123-abcd${resolved}`)),
      downloads
    );
  }

  // Ordinary extensions still survive untouched.
  for (const ext of [".png", ".mp4", ".tar.gz", ".JPEG", ".webp"]) {
    assert.equal(safeExtension(ext), ext);
  }
});
