import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface SidecarNotification {
  type: "sessionNotification";
  sessionId: string;
  workspaceId: string;
  notificationIndex?: number;
  newEvents?: Array<{
    type: "userMessage" | "agent";
    agentMessage?: string;
    toolUse?: { name: string; input?: any };
    turnComplete?: boolean;
  }>;
  updatedLiveState?: {
    status?: "working" | "idle";
    error?: string;
    activeQuestions?: Array<{ question: string; id: string }>;
    proposedPlan?: string;
  };
}

export type NotificationHandler = (notification: SidecarNotification) => void;

/**
 * Simple HTTP server that receives POST notifications from sidecar processes.
 * Each sidecar is configured with ROUNDHOUSE_URL pointing to this server.
 */
export function startCallbackServer(
  port: number,
  onNotification: NotificationHandler
): { port: number; close: () => void } {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Accept all POST requests (sidecar sends to various paths)
    if (req.method !== "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      console.log(`[callback] ${req.url} ${JSON.stringify(data).slice(0, 500)}`);
      onNotification(data);
    } catch (err) {
      console.error(`[callback] parse error:`, err);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Callback server listening on port ${port}`);
  });

  return {
    port,
    close: () => server.close(),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
