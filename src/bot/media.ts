/**
 * Inline media plumbing for Telegram bot.
 *
 * Inbound: classify a Telegram media message into a uniform shape so all media
 * handlers share the same downstream flow.
 *
 * Outbound: scan agent text for markdown image/link references, classify any
 * local files those references point at, and produce a clean text + media list
 * the bot can ship as `sendMediaGroup` (or singular `sendPhoto`/`sendDocument`
 * etc. when there's exactly one item).
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";

export type MediaKind = "photo" | "video" | "audio" | "document" | "animation";

export interface InlineMediaItem {
  kind: MediaKind;
  filePath: string;
  filename: string;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const AUDIO_EXTS = new Set([".mp3", ".m4a", ".wav", ".ogg", ".oga", ".opus", ".flac", ".aac"]);
const ANIMATION_EXTS = new Set([".gif"]);

/** Telegram media-group caps photo/video groups at 10 items, mixed/document groups at 10 too. */
export const TELEGRAM_MEDIA_GROUP_MAX = 10;

/** Telegram caps photo/video captions at 1024 chars; documents/audio at 1024 too. */
export const TELEGRAM_CAPTION_MAX = 1024;

/** Telegram rejects files >50MB on the bot upload path. */
export const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function classifyByExtension(filePath: string): MediaKind {
  const ext = path.extname(filePath).toLowerCase();
  if (ANIMATION_EXTS.has(ext)) return "animation";
  if (IMAGE_EXTS.has(ext)) return "photo";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "document";
}

/**
 * Find markdown-style file references in `text` that resolve to local files
 * inside `baseDir` (or to absolute paths that exist on disk).
 *
 * Returns the cleaned text (matched references stripped) and the list of
 * inline media items the caller should attach.
 *
 * Remote URLs (http/https) are left alone — Telegram's link preview handles
 * those without a re-upload.
 */
export function extractInlineMedia(
  text: string,
  baseDir: string
): { cleanedText: string; media: InlineMediaItem[] } {
  const media: InlineMediaItem[] = [];
  const seen = new Set<string>();

  let cleaned = text;

  // Markdown image: ![alt](url)
  cleaned = cleaned.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, _alt, url) => {
    const item = resolveLocalFile(url, baseDir);
    if (!item) return match;
    if (seen.has(item.filePath)) return "";
    seen.add(item.filePath);
    media.push(item);
    return "";
  });

  // Markdown link: [name](url) — exclude image syntax (negative lookbehind not portable in older
  // engines; we just make sure the leading '!' wasn't there by checking match[0] prefix later).
  cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, _name, url, offset) => {
    if (offset > 0 && cleaned[offset - 1] === "!") return match;
    const item = resolveLocalFile(url, baseDir);
    if (!item) return match;
    if (seen.has(item.filePath)) return "";
    seen.add(item.filePath);
    media.push(item);
    return "";
  });

  // Collapse the whitespace damage the substitutions cause.
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return { cleanedText: cleaned, media };
}

function resolveLocalFile(url: string, baseDir: string): InlineMediaItem | null {
  if (/^https?:\/\//i.test(url)) return null;

  let p = url;
  if (p.startsWith("file://")) p = p.slice("file://".length);

  if (!path.isAbsolute(p)) {
    p = path.resolve(baseDir, p);
  }

  if (!existsSync(p)) return null;
  let stat;
  try {
    stat = statSync(p);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > TELEGRAM_MAX_UPLOAD_BYTES) return null;

  return {
    kind: classifyByExtension(p),
    filePath: p,
    filename: path.basename(p),
  };
}
