import { ConductorApiError, type ConductorApiClient, type ConductorApiMessage } from "../integrations/conductor-api.js";

export function messageEnvelope(content: unknown): Record<string, any> | undefined {
  if (typeof content === "string") {
    try { content = JSON.parse(content); } catch { return undefined; }
  }
  return content && typeof content === "object" && !Array.isArray(content) ? content as Record<string, any> : undefined;
}

export function isSubmittedMessage(message: ConductorApiMessage, submittedId: string): boolean {
  return message.id === submittedId || (message.type === "userMessage" && messageEnvelope(message.content)?.id === submittedId);
}

export function nativeTurnFailure(raw: Record<string, any> | undefined): string | undefined {
  if (raw?.event?.type === "turn.failed") return String(raw.event.error?.message ?? "Provider turn failed").slice(0, 1000);
  if (raw?.type === "result" && (raw.is_error === true || /^error/.test(raw.subtype ?? ""))) {
    return (Array.isArray(raw.errors) ? raw.errors.map(String).join("; ") : String(raw.result ?? raw.subtype ?? "Provider turn failed")).slice(0, 1000);
  }
  return undefined;
}

/** Submission IDs identify commands; transcript rows have separate IDs. */
export async function findSubmittedMessage(api: ConductorApiClient, sessionId: string, submittedId: string): Promise<ConductorApiMessage | null> {
  try {
    const message = await api.getMessage(submittedId);
    if (message.sessionId !== sessionId) throw new Error("Message identity mismatch: different session");
    return message;
  } catch (error) {
    if (!(error instanceof ConductorApiError) || error.status !== 404) throw error;
  }
  for (let offset = 0; offset < 10_000; offset += 100) {
    const page = await api.listSessionMessages({sessionId, offset, limit: 100});
    const message = page.find(m => isSubmittedMessage(m, submittedId));
    if (message) {
      if (message.sessionId !== sessionId) throw new Error("Message identity mismatch: different session");
      return message;
    }
    if (page.length < 100) return null;
  }
  throw new Error("Message reconciliation exceeded its transcript limit; refusing an uncertain replay");
}
