import test from "node:test";
import assert from "node:assert/strict";
import {
  formatConductorDeepLink,
  formatRelativeTime,
  isTrustedConductorLink,
  parseFleetHours,
  resolveCloudProject,
} from "../src/bot/commands.js";
import type { ConductorApiProject } from "../src/integrations/conductor-api.js";

function project(id: string, name: string): ConductorApiProject {
  return { id, name, gitRemote: `git@host:org/${id}.git` };
}

const PROJECTS: ConductorApiProject[] = [
  project("proj-alpha", "api"),
  project("proj-beta", "api-server"),
  project("proj-gamma", "web"),
];

test("cloud projects resolve by list number, id, and exact name", () => {
  // /projects list numbers are 1-based and bounded.
  assert.equal(resolveCloudProject(PROJECTS, "1")?.id, "proj-alpha");
  assert.equal(resolveCloudProject(PROJECTS, "3")?.id, "proj-gamma");
  assert.equal(resolveCloudProject(PROJECTS, "0"), null);
  assert.equal(resolveCloudProject(PROJECTS, "4"), null);

  assert.equal(resolveCloudProject(PROJECTS, "proj-beta")?.id, "proj-beta");

  // An exact (case-insensitive) name wins even when it prefixes another
  // project, so /cloud api never lands in api-server by accident.
  assert.equal(resolveCloudProject(PROJECTS, "API")?.id, "proj-alpha");
  assert.equal(resolveCloudProject(PROJECTS, " web ")?.id, "proj-gamma");
});

test("prefix references resolve only when they are unambiguous", () => {
  assert.equal(resolveCloudProject(PROJECTS, "we")?.id, "proj-gamma");
  assert.equal(resolveCloudProject(PROJECTS, "api-s")?.id, "proj-beta");

  // "ap" prefixes both api and api-server: refuse to guess.
  assert.equal(resolveCloudProject(PROJECTS, "ap"), null);
  assert.equal(resolveCloudProject(PROJECTS, "zzz"), null);
  assert.equal(resolveCloudProject(PROJECTS, ""), null);
  assert.equal(resolveCloudProject(PROJECTS, "   "), null);
  assert.equal(resolveCloudProject([], "1"), null);
});

test("only http(s) deep links become Telegram anchors", () => {
  assert.equal(
    formatConductorDeepLink("https://conductor.build/workspaces/w-1"),
    '<a href="https://conductor.build/workspaces/w-1">Open in Conductor</a>'
  );
  assert.equal(
    formatConductorDeepLink("HTTP://conductor.build/w-1"),
    '<a href="HTTP://conductor.build/w-1">Open in Conductor</a>'
  );
  assert.equal(
    formatConductorDeepLink("conductor://workspace/w-1"),
    "<code>conductor://workspace/w-1</code>"
  );
  // A non-web scheme must never render as a clickable anchor.
  assert.equal(
    formatConductorDeepLink("javascript:alert(1)"),
    "<code>javascript:alert(1)</code>"
  );
  // Markup embedded in a link is neutralized before it reaches parse_mode=HTML.
  assert.equal(
    formatConductorDeepLink('https://conductor.build/<b>&x"y'),
    '<a href="https://conductor.build/&lt;b&gt;&amp;x&quot;y">Open in Conductor</a>'
  );
});

test("relative activity times bucket into minutes, hours, and days", () => {
  const now = Date.now();
  assert.equal(
    formatRelativeTime(new Date(now - 5 * 60_000).toISOString()),
    "5m ago"
  );
  // Numeric epoch values are accepted (SQL rows are unknown-typed).
  assert.equal(formatRelativeTime(now - 2 * 60_000), "2m ago");
  // Future timestamps clamp to "just now" instead of going negative.
  assert.equal(
    formatRelativeTime(new Date(now + 10 * 60_000).toISOString()),
    "0m ago"
  );
  assert.equal(
    formatRelativeTime(new Date(now - 90 * 60_000).toISOString()),
    "2h ago"
  );
  assert.equal(
    formatRelativeTime(new Date(now - 30 * 3_600_000).toISOString()),
    "30h ago"
  );
  assert.equal(
    formatRelativeTime(new Date(now - 72 * 3_600_000).toISOString()),
    "3d ago"
  );
  assert.equal(formatRelativeTime("not-a-date"), "unknown");
  assert.equal(formatRelativeTime(null), "unknown");
  assert.equal(formatRelativeTime(undefined), "unknown");
  assert.equal(formatRelativeTime({}), "unknown");
});

test("fleet hours accept only plain bounded integers", () => {
  // Empty means the default window.
  assert.equal(parseFleetHours(""), 24);
  assert.equal(parseFleetHours("1"), 1);
  assert.equal(parseFleetHours("168"), 168);

  // The parsed value is inlined into the /v0/sql interval literal, so
  // anything but a plain integer must be rejected outright.
  assert.equal(parseFleetHours("0"), null);
  assert.equal(parseFleetHours("169"), null);
  assert.equal(parseFleetHours("-1"), null);
  assert.equal(parseFleetHours("1.5"), null);
  assert.equal(parseFleetHours("1e2"), null);
  assert.equal(parseFleetHours("0x10"), null);
  assert.equal(parseFleetHours("24; DROP TABLE x"), null);
  assert.equal(parseFleetHours("24 hours"), null);
  assert.equal(parseFleetHours("NaN"), null);
  assert.equal(parseFleetHours("Infinity"), null);
});

test("deep links only become anchors for Conductor hosts", () => {
  assert.equal(
    isTrustedConductorLink("https://conductor.build/workspaces/w-1"),
    true
  );
  assert.equal(isTrustedConductorLink("https://app.conductor.build/w-1"), true);
  assert.equal(isTrustedConductorLink("HTTPS://CONDUCTOR.BUILD/w-1"), true);

  assert.equal(isTrustedConductorLink("https://evil.example/phish"), false);
  assert.equal(
    isTrustedConductorLink("https://conductor.build.evil.example/x"),
    false
  );
  assert.equal(isTrustedConductorLink("https://notconductor.build/x"), false);
  assert.equal(isTrustedConductorLink("conductor://workspace/w-1"), false);
  assert.equal(isTrustedConductorLink("javascript:alert(1)"), false);
  assert.equal(isTrustedConductorLink("not a url"), false);

  // A foreign host renders as inert code, never as a clickable anchor.
  assert.match(
    formatConductorDeepLink("https://evil.example/phish"),
    /^<code>/
  );
  assert.match(
    formatConductorDeepLink("https://conductor.build/w-1"),
    /^<a href=/
  );
});
