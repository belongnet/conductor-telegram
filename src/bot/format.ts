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
