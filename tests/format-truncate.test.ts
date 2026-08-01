import test from "node:test";
import assert from "node:assert/strict";
import { truncateHtml, TELEGRAM_MAX_TEXT } from "../src/bot/format.js";

test("short HTML passes through untouched", () => {
  assert.equal(truncateHtml("<b>hi</b>", TELEGRAM_MAX_TEXT), "<b>hi</b>");
});

test("truncation prefers a newline boundary and closes open tags", () => {
  const line = `<b>${"x".repeat(80)}</b>`;
  const html = Array.from({ length: 100 }, () => line).join("\n");
  const result = truncateHtml(html, 2000);
  assert.ok(result.length <= 2000 + 32);
  // Every opened tag is closed.
  const opens = result.match(/<b>/g)?.length ?? 0;
  const closes = result.match(/<\/b>/g)?.length ?? 0;
  assert.equal(opens, closes);
});

test("a single unbroken line never cuts inside tag markup or an entity", () => {
  // One long line whose cut index would land inside "<code>" markup.
  const head = "x".repeat(994);
  const html = `${head}<code>${"y".repeat(500)}</code>`;
  const result = truncateHtml(html, 1000);
  // No dangling "<cod"-style fragment survives.
  assert.ok(!/<[a-z]*$/i.test(result.replace(/\n…[\s\S]*$/, "")));
  assert.ok(!result.includes("<code\n"));

  // A cut that would split "&amp;" backs out of the entity instead.
  const entityHtml = `${"z".repeat(995)}&amp;${"w".repeat(200)}`;
  const entityResult = truncateHtml(entityHtml, 1000);
  assert.ok(!/&a?m?p?$/.test(entityResult.split("\n…")[0]));
});

test("open tags close in reverse nesting order", () => {
  const html = `<b>bold <i>italic ${"x".repeat(2000)}`;
  const result = truncateHtml(html, 1000);
  const closeOrder = [...result.matchAll(/<\/(b|i)>/g)].map((m) => m[1]);
  assert.deepEqual(closeOrder, ["i", "b"]);
});

test("already-balanced markup gains no extra closers", () => {
  const html = `<b>done</b>\n${"x".repeat(2000)}`;
  const result = truncateHtml(html, 1000);
  assert.equal(result.match(/<\/b>/g)?.length, 1);
});
