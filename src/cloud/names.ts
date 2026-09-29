/**
 * Names for work the gateway starts. Conductor titles a workspace only when it is created without a name, and the
 * gateway always names its own: that name is how a lost create response is reconciled. Conductor still titles the
 * workspace's first thread from the task, and that title is what the workspace is later called.
 */

/** The name a gateway workspace is created under and keeps until it takes its first thread's title. */
export function creationKey(trackedId: string): string {
  return `telegram-${trackedId}`;
}

/** Conductor's own thread titles run well under this; a longer one is cut before it names a workspace and a topic. */
export const THREAD_TITLE_MAX = 100;

/** A cut never splits a character in two: Telegram refuses a lone surrogate, and refuses it for good. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The task's first line, cut at a word. Work is called this until Conductor has titled it, or if it never does. */
export function taskTitle(text: string, fallback: string, max = 60): string {
  const line = text.split("\n").map(part => part.replace(/\s+/g, " ").trim()).find(Boolean);
  if (!line) return fallback;
  if (line.length <= max) return line;
  const cut = clip(line, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A thread the gateway opened is created under "Task" or "Review" and the queue row that opened it. */
const THREAD_KEY = /^(Task|Review) ((update|route|recover):\S*)$/;

export function isThreadKey(name: string): boolean {
  return THREAD_KEY.test(name);
}

/**
 * Conductor titles a thread with a model, so the title is data before it is a name: one line, without control or
 * invisible characters, and without bracketed tags, which other tools (the lanes controller among them) read in a
 * workspace's name as its identity. Nothing usable left, or a gateway key, is no title.
 */
export function threadTitle(name: string | undefined): string | undefined {
  const text = (name ?? "").replace(/\[[^\]]*\]/g, " ").replace(/\p{Cc}/gu, " ").replace(/(?![‌‍])\p{Cf}/gu, "");
  const title = clip(text.replace(/\s+/g, " ").trim(), THREAD_TITLE_MAX).trimEnd();
  return title && !isThreadKey(title) ? title : undefined;
}

/** A gateway key is not a name: it reads as what the thread is for. Anything else, including "Task list", is a name. */
export function threadName(name: string | undefined, fallback = "Untitled"): string {
  const key = name?.match(THREAD_KEY);
  if (!key) return name?.trim() || fallback;
  return key[1] === "Review" ? "Review" : key[3] === "recover" ? "Recovery" : "Thread";
}

/** How a thread is told apart from its siblings in Telegram: its name and the model that runs it. */
export function threadLabel(name: string | undefined, model?: string): string {
  return [threadName(name), model].filter(Boolean).join(" · ");
}
