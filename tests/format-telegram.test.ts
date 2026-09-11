import test from "node:test";
import assert from "node:assert/strict";
import { escHtml, markdownToTelegramChunks, splitTelegramHtml } from "../src/bot/format.js";

function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

test("long bold text stays formatted on both sides of a message boundary", () => {
  const body = "x".repeat(8000);
  const chunks = markdownToTelegramChunks(`**${body}**`);
  assert.deepEqual(chunks, [3900, 3900, 200].map(size => `<b>${"x".repeat(size)}</b>`));
  assert.equal(chunks.map(visibleText).join(""), body);
});

test("long fenced code preserves literal Markdown, escapes HTML, and reopens pre tags", () => {
  const code = 'const task = "<tag> & **literal** `code` 🧑‍💻";\n'.repeat(250).trimEnd();
  const chunks = markdownToTelegramChunks(`\`\`\`typescript\n${code}\n\`\`\``);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.match(chunk, /^<pre>[\s\S]*<\/pre>$/);
    assert.ok(visibleText(chunk).length <= 3900);
    assert.equal(Buffer.from(visibleText(chunk), "utf8").toString("utf8"), visibleText(chunk));
    assert.doesNotMatch(chunk, /<(?:b|code|tag)>/);
  }
  assert.equal(chunks.map(visibleText).join(""), code);
});

test("nested emphasis and links close in order and retain the URL across chunks", () => {
  const body = "x".repeat(8000);
  const chunks = markdownToTelegramChunks(`**[${body}](https://example.com/?a=1&b=2)**`);
  assert.deepEqual(chunks, [3900, 3900, 200].map(size =>
    `<b><a href="https://example.com/?a=1&amp;b=2">${"x".repeat(size)}</a></b>`));
});

test("code inside emphasis stays monospace without Telegram-forbidden nesting", () => {
  assert.deepEqual(markdownToTelegramChunks("**Check `task_id` first**"),
    ["<b>Check </b><code>task_id</code><b> first</b>"]);
  assert.deepEqual(markdownToTelegramChunks("# Use `task_id`"),
    ["<b>Use </b><code>task_id</code>"]);
});

test("links with code labels keep their destination, including across message boundaries", () => {
  assert.deepEqual(markdownToTelegramChunks("[`file.ts`](https://example.com/file.ts)"),
    ['<a href="https://example.com/file.ts">file.ts</a>']);
  const body = "x".repeat(8000);
  assert.deepEqual(markdownToTelegramChunks(`**[\`${body}\`](https://example.com/file.ts)**`),
    [3900, 3900, 200].map(size => `<b><a href="https://example.com/file.ts">${"x".repeat(size)}</a></b>`));
});

test("Unicode and escaped entities stay intact at the rendered character limit", () => {
  const prefix = "x".repeat(3899);
  const body = `${prefix}😀 & < > &lt; "fin"`;
  const chunks = markdownToTelegramChunks(`**${body}**`);
  assert.equal(chunks[0], `<b>${prefix}</b>`);
  assert.equal(chunks[1], '<b>😀 &amp; &lt; &gt; &amp;lt; "fin"</b>');
  assert.equal(chunks.map(visibleText).join(""), body);
  const entities = markdownToTelegramChunks("&".repeat(8000));
  assert.equal(entities.length, 3, "Telegram's limit counts decoded text, not HTML bytes");
  assert.equal(entities.map(visibleText).join(""), "&".repeat(8000));
});

test("raw HTML stays literal and quote characters cannot escape link attributes", () => {
  assert.deepEqual(markdownToTelegramChunks('<b>literal</b> & [docs](https://example.com/?q="x")'),
    ['&lt;b&gt;literal&lt;/b&gt; &amp; <a href="https://example.com/?q=&quot;x&quot;">docs</a>']);
});

test("local file references and unsupported URLs stay readable alongside rich text", () => {
  assert.deepEqual(markdownToTelegramChunks("**Changed:** [app.ts](/workspace/src/app.ts:12)"),
    ["<b>Changed:</b> app.ts (/workspace/src/app.ts:12)"]);
  assert.deepEqual(markdownToTelegramChunks("[bad](javascript:alert) and [broken](https://)"),
    ["bad (javascript:alert) and broken (https://)"]);
});

test("malformed nesting falls back to escaped text without losing the reply", () => {
  const md = "**bold *crossed** italic* <literal>";
  assert.deepEqual(markdownToTelegramChunks(md), [escHtml(md)]);
  assert.deepEqual(markdownToTelegramChunks(""), ["(empty message)"]);
  assert.throws(() => splitTelegramHtml("text", 0), RangeError);
});

test("invalid Telegram HTML is rejected before it can enter the delivery queue", () => {
  for (const html of [
    "<script>unsafe</script>", "<b>unclosed",
    '<a href="https://example.com"><a href="https://example.org">nested link</a></a>',
    "<code><b>nested markup</b></code>",
  ]) assert.throws(() => splitTelegramHtml(html), /Telegram HTML/);
});
