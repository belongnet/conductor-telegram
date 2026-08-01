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

/** Telegram message text limit (characters). */
export const TELEGRAM_MAX_TEXT = 4096;

/**
 * Truncate an HTML string so the total message (header + body) fits within
 * Telegram's 4096-char limit. Strips from the end to the last complete line,
 * closes any open tags, and appends "…".
 */
export function truncateHtml(html: string, maxLen: number): string {
  if (html.length <= maxLen) return html;
  // Cut to last newline before maxLen to avoid splitting HTML tags mid-tag
  let cut = html.lastIndexOf("\n", maxLen - 4);
  if (cut < maxLen * 0.3) {
    // Fallback for one long unbroken line: a raw index cut may land inside
    // `<...>` markup or an `&...;` entity, which Telegram rejects outright,
    // so back the cut out of any partial token first.
    cut = maxLen - 4;
    const openAngle = html.lastIndexOf("<", cut - 1);
    if (openAngle > html.lastIndexOf(">", cut - 1)) cut = openAngle;
    const amp = html.lastIndexOf("&", cut - 1);
    if (amp > cut - 10 && amp !== -1 && !html.slice(amp, cut).includes(";")) {
      cut = amp;
    }
  }
  let result = html.slice(0, cut) + "\n…";
  // Close still-open tags in reverse nesting order — Telegram rejects
  // interleaved closers like <b><i>…</b></i>.
  const stack: string[] = [];
  const tokenRe = /<(\/?)(b|i|s|u|code|pre|blockquote)(?:\s[^>]*)?>/gi;
  let token: RegExpExecArray | null;
  while ((token = tokenRe.exec(result))) {
    const name = token[2].toLowerCase();
    if (token[1] !== "/") {
      stack.push(name);
    } else {
      const openIndex = stack.lastIndexOf(name);
      if (openIndex !== -1) stack.splice(openIndex, 1);
    }
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    result += `</${stack[i]}>`;
  }
  return result;
}

/**
 * Human-readable "how long ago" bucketing shared by the workspace lists,
 * the CLI status output, and the cloud project views. Accepts unknown input
 * because SQL rows and API payloads arrive untyped.
 */
export function formatRelativeTime(value: unknown): string {
  const date =
    typeof value === "string" || typeof value === "number"
      ? new Date(value)
      : null;
  if (!date || Number.isNaN(date.getTime())) return "unknown";
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Status-line "how long ago" with second resolution, "never" for absent
 * values, and the raw string echoed for unparseable input. Shared by the bot
 * poll status view and the CLI service status.
 */
export function formatAgo(
  iso: string | null | undefined,
  nowMs: number = Date.now()
): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const secs = Math.max(0, Math.round((nowMs - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
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

// ── Inline buttons ───────────────────────────────────────────

interface InlineButton {
  text: string;
  callback_data: string;
}

/**
 * Create an inline keyboard.
 * Each inner array is a row of buttons.
 */
export function styledKeyboard(rows: InlineButton[][]): {
  reply_markup: { inline_keyboard: InlineButton[][] };
} {
  return { reply_markup: { inline_keyboard: rows } };
}

/** Shorthand: one button per row. */
export function styledButtons(buttons: InlineButton[]): {
  reply_markup: { inline_keyboard: InlineButton[][] };
} {
  return styledKeyboard(buttons.map((b) => [b]));
}

export function btn(text: string, callbackData: string): InlineButton {
  return { text, callback_data: callbackData };
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
    case "archived":
      return "🗄";
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
