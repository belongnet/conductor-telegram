/**
 * Human-gated lane controls from the CLI (release, validate, retire) are
 * approved like Telegram ones: Command Center emails a code and the operator
 * types it here. The code is read from the terminal, never from arguments,
 * files or the environment, and neither it nor the grant is written anywhere.
 */
import os from "node:os";
import { once } from "node:events";
import { createInterface, type Interface } from "node:readline/promises";
import {
  APPROVAL_CODE_PATTERN,
  ApprovalChannelError,
  approvalChannelFromEnv,
  type ApprovalChallenge,
} from "../lanes/approval-channel.js";
import { LaneStateStoreError, type LaneHumanApproval } from "../lanes/state-store.js";

const MAX_TRIES = 3;

export interface TerminalApprovalOptions {
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
  fetchImpl?: typeof fetch;
  subject?: string;
}

/** `cli:<host>`: who typed the code. Kept apart from the Telegram owner's grant. */
export function terminalApprovalSubject(hostname = os.hostname()): string {
  return `cli:${hostname.replace(/[^\x21-\x7e]/g, "").slice(0, 76) || "host"}`;
}

/**
 * Runs `submit` with a grant from an emailed code typed at this terminal, then
 * revokes the grant, which this short-lived process never needs again. Without
 * a terminal there is nobody to type the code, so it refuses before asking.
 */
export async function withTerminalApproval<T>(
  action: string,
  submit: (approval: LaneHumanApproval) => Promise<T>,
  options: TerminalApprovalOptions = {}
): Promise<T> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  if (input.isTTY !== true) {
    throw new Error(`${action} needs an emailed approval code typed at a terminal; run it in an interactive shell`);
  }
  const setup = approvalChannelFromEnv(
    options.env ?? process.env,
    options.subject ?? terminalApprovalSubject(),
    { fetchImpl: options.fetchImpl }
  );
  if ("problem" in setup) throw new Error(`${action} needs lane approvals set up: ${setup.problem}`);
  const { client } = setup;
  let challenge: ApprovalChallenge;
  try {
    challenge = await client.sendCode();
  } catch (error) {
    throw new Error(`${action}: ${sendRefusal(error)}; nothing was applied`);
  }
  const minutes = Math.max(1, Math.round(challenge.expiresInSeconds / 60));
  output.write(
    `Approval code sent to ${challenge.emailHint}. Enter the 6-digit code within ${minutes} ${minutes === 1 ? "minute" : "minutes"}.\n`
  );
  const lines = createInterface({ input, output, terminal: false });
  try {
    let typed = 0;
    let refused = 0;
    for (;;) {
      const code = (await question(lines, "Approval code: ", action)).trim();
      if (!APPROVAL_CODE_PATTERN.test(code)) {
        if (++typed >= MAX_TRIES) throw new Error(`${action}: no 6-digit code was entered; nothing was applied`);
        output.write("Enter only the 6-digit code.\n");
        continue;
      }
      try {
        await client.verifyCode(challenge.challengeId, code);
        break;
      } catch (error) {
        if (error instanceof ApprovalChannelError && error.reason === "invalid" && ++refused < MAX_TRIES) {
          output.write("That code was not accepted. Enter the latest 6-digit code.\n");
          continue;
        }
        throw new Error(`${action}: ${verifyRefusal(error)}; nothing was applied`);
      }
    }
  } finally {
    lines.close();
  }
  const approval = client.approval();
  if (!approval) throw new Error(`${action}: the approval ended before it could be used; nothing was applied`);
  try {
    return await submit(approval);
  } catch (error) {
    if (error instanceof LaneStateStoreError && error.freshApprovalRequired) {
      throw new Error(`${action}: Command Center asked for a fresh approval code; nothing was applied, run the command again`);
    }
    throw error;
  } finally {
    await client.revokeGrant();
  }
}

/** One line from the terminal; a closed input means nobody is there to type. */
async function question(lines: Interface, prompt: string, action: string): Promise<string> {
  const abort = new AbortController();
  try {
    return await Promise.race([
      lines.question(prompt, { signal: abort.signal }),
      once(lines, "close", { signal: abort.signal }).then(() => {
        throw new Error(`${action}: no approval code was entered; nothing was applied`);
      }),
    ]);
  } finally {
    abort.abort();
  }
}

function minutesText(seconds?: number): string {
  if (seconds === undefined) return "later";
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function sendRefusal(error: unknown): string {
  if (!(error instanceof ApprovalChannelError)) return "the approval code service is unavailable";
  if (error.reason === "wait") return `too many approval codes were requested; try again ${minutesText(error.retryAfterSeconds)}`;
  if (error.reason === "attempts") return "approvals are paused after too many wrong codes; try again later";
  return error.channelKeyRefused
    ? "Command Center refused BELONG_APPROVAL_CHANNEL_KEY"
    : "the approval code service is unavailable; try again shortly";
}

function verifyRefusal(error: unknown): string {
  if (!(error instanceof ApprovalChannelError)) return "the approval service did not answer";
  switch (error.reason) {
    case "invalid":
      return "the code was not accepted";
    case "expired":
      return "the code has expired";
    case "attempts":
      return "too many wrong codes";
    case "wait":
      return `too many tries; try again ${minutesText(error.retryAfterSeconds)}`;
    default:
      return error.channelKeyRefused
        ? "Command Center refused BELONG_APPROVAL_CHANNEL_KEY"
        : "the approval service did not answer";
  }
}
