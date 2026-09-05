import type { ConductorApiMessage } from "../integrations/conductor-api.js";

export type RawExecutionReceipt = {
  command: string;
  execution_id: string;
  message_id: string;
  exit_code: number;
};

function normalizedEventType(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[_-]/g, "")
    : "";
}

/**
 * Extract terminal process receipts emitted by Conductor itself. Assistant
 * text is deliberately never parsed as execution evidence. Codex emits
 * commandExecution events; Claude and Cursor emit a Bash tool_use paired with
 * a tool_result. The recursive walk tolerates provider envelopes without
 * trusting arbitrary result prose.
 */
export function rawExecutionReceipts(
  messages: readonly ConductorApiMessage[]
): RawExecutionReceipt[] {
  type ToolUse = { command: string; messageId: string; order: number };
  type ToolResult = { failed: boolean };
  const commandEvents = new Map<
    string,
    RawExecutionReceipt & { order: number }
  >();
  const toolUses = new Map<string, ToolUse>();
  const toolResults = new Map<string, ToolResult>();
  let order = 0;

  const visit = (value: unknown, messageId: string, depth: number): void => {
    if (depth > 16 || value == null || typeof value === "string") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, messageId, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    const type = normalizedEventType(object.type);

    if (type === "commandexecution") {
      const command = typeof object.command === "string" ? object.command : null;
      const status = normalizedEventType(object.status);
      const exitCode = object.exitCode ?? object.exit_code;
      if (
        command &&
        ["completed", "failed"].includes(status) &&
        typeof exitCode === "number" &&
        Number.isInteger(exitCode)
      ) {
        const executionId =
          typeof object.id === "string" && object.id
            ? object.id
            : `${messageId}:command:${order}`;
        const previous = commandEvents.get(executionId);
        commandEvents.set(executionId, {
          command,
          execution_id: executionId,
          message_id: messageId,
          exit_code: exitCode,
          order: previous?.order ?? order++,
        });
      }
    } else if (
      type === "tooluse" &&
      normalizedEventType(object.name) === "bash" &&
      typeof object.id === "string"
    ) {
      const toolInput =
        object.input && typeof object.input === "object"
          ? (object.input as Record<string, unknown>)
          : null;
      if (typeof toolInput?.command === "string" && !toolUses.has(object.id)) {
        toolUses.set(object.id, {
          command: toolInput.command,
          messageId,
          order: order++,
        });
      }
    } else if (
      type === "toolresult" &&
      typeof object.tool_use_id === "string" &&
      (object.is_error === undefined || typeof object.is_error === "boolean")
    ) {
      // Anthropic's tool_result `is_error` field is optional; omission is the
      // protocol's successful-result form, while true is an explicit failure.
      toolResults.set(object.tool_use_id, { failed: object.is_error === true });
    }

    for (const nested of Object.values(object)) {
      visit(nested, messageId, depth + 1);
    }
  };

  for (const message of [...messages].sort(
    (left, right) => left.sessionIndex - right.sessionIndex
  )) {
    visit(message.content, message.id, 0);
  }

  const receipts: Array<RawExecutionReceipt & { order: number }> = [
    ...commandEvents.values(),
  ];
  for (const [toolId, use] of toolUses) {
    const result = toolResults.get(toolId);
    if (!result) continue;
    receipts.push({
      command: use.command,
      execution_id: toolId,
      message_id: use.messageId,
      exit_code: result.failed ? 1 : 0,
      order: use.order,
    });
  }
  return receipts
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...receipt }) => receipt);
}
