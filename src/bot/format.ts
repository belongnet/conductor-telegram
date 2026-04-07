/**
 * Telegram message formatting utilities.
 *
 * Provides styled inline buttons (Bot API 9.4), expandable blockquotes
 * (Bot API 7.4), and common message-building helpers.
 */

// ── HTML helpers ─────────────────────────────────────────────

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + "..." : s;
}

/**
 * Wrap text in an expandable blockquote (collapsed by default, ~3 lines shown).
 * Only wraps if the text exceeds `minLength` characters.
 */
export function expandableQuote(text: string, minLength = 120): string {
  if (text.length <= minLength) {
    return `<blockquote>${text}</blockquote>`;
  }
  return `<blockquote expandable>${text}</blockquote>`;
}

/**
 * Telegram forbids nesting links and code/pre entities inside blockquotes.
 * Fall back to plain HTML when those entities are present.
 */
export function maybeExpandableQuote(text: string, minLength = 120): string {
  return /<(?:a|code|pre)\b/i.test(text) ? text : expandableQuote(text, minLength);
}

// ── Styled inline buttons ────────────────────────────────────
//
// Telegraf v4 doesn't expose the `style` field from Bot API 9.4.
// We build reply_markup JSON directly so we can set button colors.

export type ButtonStyle = "primary" | "success" | "danger";

interface StyledButton {
  text: string;
  callback_data: string;
  style?: ButtonStyle;
}

/**
 * Create a styled inline keyboard.
 * Each inner array is a row of buttons.
 */
export function styledKeyboard(rows: StyledButton[][]): {
  reply_markup: { inline_keyboard: StyledButton[][] };
} {
  return { reply_markup: { inline_keyboard: rows } };
}

/** Shorthand: one button per row. */
export function styledButtons(buttons: StyledButton[]): {
  reply_markup: { inline_keyboard: StyledButton[][] };
} {
  return styledKeyboard(buttons.map((b) => [b]));
}

/** Single styled button (convenience). */
export function btn(
  text: string,
  callbackData: string,
  style?: ButtonStyle
): StyledButton {
  const b: StyledButton = { text, callback_data: callbackData };
  if (style) b.style = style;
  return b;
}

// ── Markdown → Telegram HTML ─────────────────────────────────

/**
 * Convert markdown (as produced by Claude / LLMs) to Telegram-compatible HTML.
 *
 * Handles fenced code blocks, inline code, bold, italic, strikethrough,
 * links, and headings.  Everything outside markdown syntax is HTML-escaped.
 */
export function markdownToTelegramHtml(md: string): string {
  const placeholders: string[] = [];
  const protect = (html: string): string => {
    const i = placeholders.length;
    placeholders.push(html);
    return `\x00${i}\x00`;
  };

  let s = md;

  // 1. Fenced code blocks  ```lang\n…\n```
  s = s.replace(/```\w*\n([\s\S]*?)```/g, (_m, code: string) =>
    protect(`<pre>${escHtml(code.trimEnd())}</pre>`)
  );

  // 2. Inline code  `…`
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    protect(`<code>${escHtml(code)}</code>`)
  );

  // 3. Escape remaining literal text
  s = escHtml(s);

  // 4. Bold  **…**
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 5. Italic  *…*  (only single, not adjacent to another *)
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");

  // 6. Strikethrough  ~~…~~
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 7. Links  [text](url)
  s = s.replace(
    /\[(.+?)\]\((.+?)\)/g,
    (_m, label: string, href: string) =>
      `<a href="${href.replace(/"/g, "&quot;")}">${label}</a>`
  );

  // 8. Headings  # … → bold line
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Restore protected regions
  s = s.replace(/\x00(\d+)\x00/g, (_m, idx: string) => placeholders[Number(idx)]);

  return s;
}

// ── Status formatting ────────────────────────────────────────

export function statusIcon(status: string): string {
  switch (status) {
    case "starting":
      return "🟡";
    case "running":
      return "🟢";
    case "done":
      return "✅";
    case "failed":
      return "🔴";
    case "stopped":
      return "⏹";
    default:
      return "⚪";
  }
}

/** Format cost/turns/duration stats into a single line. */
export function formatStats(opts: {
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
}): string {
  const parts: string[] = [];
  if (opts.costUsd) parts.push(`$${opts.costUsd.toFixed(2)}`);
  if (opts.numTurns) parts.push(`${opts.numTurns} turns`);
  if (opts.durationMs) parts.push(`${Math.round(opts.durationMs / 1000)}s`);
  return parts.join(" · ");
}
