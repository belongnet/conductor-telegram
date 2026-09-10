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
