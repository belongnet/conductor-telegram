import type {CloudEngine} from "./engine.js";
import {getAllWorkspaces, getWorkspacesWithPendingCloudWork, getPendingCloudLaunch, getPendingCloudMessages, getPendingCloudTerminalIntent,
  getPendingCloudNotices, acknowledgePendingCloudNotice} from "../store/queries.js";

/** Adopt legacy outboxes only when native identities have already been verified. */
export function restoreLegacyOperations(engine: CloudEngine): void {
  const store = engine.store;
  const workspaces = new Map([...getAllWorkspaces(-1), ...getWorkspacesWithPendingCloudWork()].map(w => [w.id, w]));
  for (const workspace of workspaces.values()) {
    const binding = store.binding(workspace.id);
    const launch = getPendingCloudLaunch(workspace.id);
    if (launch) {
      engine.notify(`legacy-launch:${workspace.id}`, workspace.id, "A legacy workspace creation is unresolved. Its intent is preserved; reconcile it before starting replacement work.");
      store.set(`stop:${workspace.id}`, true);
    }
    const terminal = getPendingCloudTerminalIntent(workspace.id);
    if (terminal && binding && terminal.workspaceId === binding.workspaceId) engine.queue(`legacy-terminal:${workspace.id}:${terminal.createdAt}`, {
      type: terminal.action, trackedId: workspace.id, legacyTerminal: terminal,
    });
    if (binding && !launch) for (const message of getPendingCloudMessages(workspace.id)) {
      const id = `legacy-message:${workspace.id}:${message.requestId}`;
      store.db.transaction(() => {
        // Preserve the original exact bytes and native message identity after a lost response.
        store.set(`send:${id}`, {messageId: message.messageId, message: message.prompt});
        engine.queue(id, {type: "send", trackedId: workspace.id, sessionId: message.sessionId,
          prompt: message.prompt, legacyRequestId: message.requestId});
      })();
    }
    for (const notice of getPendingCloudNotices(workspace.id)) store.db.transaction(() => {
      engine.notify(`legacy-notice:${workspace.id}:${notice.id}`, workspace.id,
        `${notice.kind.replace(/_/g, " ")}${notice.count ? ` (${notice.count})` : ""}${notice.error ? `: ${notice.error}` : ""}`);
      acknowledgePendingCloudNotice(workspace.id, notice.id);
    })();
  }
}
