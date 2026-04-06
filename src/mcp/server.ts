import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb } from "../store/db.js";
import {
  addEvent,
  getWorkspaceByName,
  createDecision,
  getDecision,
} from "../store/queries.js";

const WORKSPACE_NAME = process.env.CONDUCTOR_WORKSPACE_NAME;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

if (!WORKSPACE_NAME) {
  console.error(
    "CONDUCTOR_WORKSPACE_NAME not set. This MCP server must be run inside a Conductor workspace."
  );
  process.exit(1);
}

// Resolve workspace ID from the conductor workspace name
function getWorkspaceId(): string | null {
  const ws = getWorkspaceByName(WORKSPACE_NAME!);
  return ws?.id ?? null;
}

const server = new McpServer({
  name: "conductor-telegram",
  version: "0.1.0",
});

// ── report_status ───────────────────────────────────────────
server.tool(
  "report_status",
  "Report your current status back to the Telegram oversight bot. Call this periodically to keep the user informed of your progress.",
  {
    status: z
      .string()
      .describe(
        'Short status label, e.g. "working", "testing", "reviewing", "done", "blocked"'
      ),
    message: z
      .string()
      .describe(
        "Human-readable description of what you're doing or what happened"
      ),
  },
  async ({ status, message }) => {
    const workspaceId = getWorkspaceId();
    if (!workspaceId) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Warning: No tracked workspace found for "${WORKSPACE_NAME}". Status not recorded.`,
          },
        ],
      };
    }

    const payload = JSON.stringify({ status, message });
    addEvent(workspaceId, "status", payload);

    return {
      content: [
        {
          type: "text" as const,
          text: `Status reported: [${status}] ${message}`,
        },
      ],
    };
  }
);

// ── report_artifact ─────────────────────────────────────────
server.tool(
  "report_artifact",
  "Report a deliverable (PR, commit, file) back to the Telegram oversight bot.",
  {
    type: z.enum(["pr", "commit", "file"]).describe("Type of artifact"),
    url: z.string().describe("URL or path to the artifact"),
    description: z.string().describe("Brief description of the artifact"),
  },
  async ({ type, url, description }) => {
    const workspaceId = getWorkspaceId();
    if (!workspaceId) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Warning: No tracked workspace found for "${WORKSPACE_NAME}". Artifact not recorded.`,
          },
        ],
      };
    }

    const payload = JSON.stringify({ type, url, description });
    addEvent(workspaceId, "artifact", payload);

    return {
      content: [
        {
          type: "text" as const,
          text: `Artifact reported: [${type}] ${description} — ${url}`,
        },
      ],
    };
  }
);

// ── request_human ───────────────────────────────────────────
server.tool(
  "request_human",
  "Ask the human operator a question via Telegram and wait for their response. Use this when you need approval, clarification, or a decision.",
  {
    question: z.string().describe("The question to ask the human"),
    options: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of choices to present as buttons. If omitted, the human can type a free-form response."
      ),
  },
  async ({ question, options }) => {
    const workspaceId = getWorkspaceId();
    if (!workspaceId) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Warning: No tracked workspace found for "${WORKSPACE_NAME}". Cannot request human input.`,
          },
        ],
      };
    }

    // Create decision record
    const decisionId = createDecision(
      workspaceId,
      question,
      options ?? null
    );

    // Also add as an event so the bot's poll loop picks it up
    const eventPayload = JSON.stringify({
      decisionId,
      question,
      options: options ?? [],
    });
    addEvent(workspaceId, "human_request", eventPayload);

    // Poll for the answer
    const answer = await pollForAnswer(decisionId);

    if (answer === null) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Timed out waiting for human response (5 minutes). Proceeding without input.",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Human responded: ${answer}`,
        },
      ],
    };
  }
);

async function pollForAnswer(decisionId: number): Promise<string | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    const decision = getDecision(decisionId);
    if (decision?.answer) {
      return decision.answer;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return null;
}

// ── Start server ────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `conductor-telegram MCP server running for workspace: ${WORKSPACE_NAME}`
  );
}

main().catch((err) => {
  console.error("MCP server fatal error:", err);
  process.exit(1);
});
