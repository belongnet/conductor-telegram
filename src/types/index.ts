export type WorkspaceStatus =
  | "starting"
  | "running"
  | "done"
  | "failed"
  | "stopped"
  | "archived";

export interface Workspace {
  id: string;
  name: string;
  prompt: string;
  status: WorkspaceStatus;
  repoPath: string;
  createdAt: string;
  telegramChatId: string;
  telegramMessageId: string | null;
  conductorWorkspaceName: string | null;
  conductorSessionId: string | null;
  lastForwardedMessageRowid: number;
  telegramThreadId: number | null;
  archivedAt: string | null;
}

export type EventType =
  | "status"
  | "artifact"
  | "human_request"
  | "human_response";

export interface WorkspaceEvent {
  id: number;
  workspaceId: string;
  type: EventType;
  payload: string;
  createdAt: string;
}

export interface Decision {
  id: number;
  workspaceId: string;
  question: string;
  options: string | null;
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface StatusPayload {
  status: string;
  message: string;
}

export interface ArtifactPayload {
  type: "pr" | "commit" | "file";
  url: string;
  description: string;
}

export interface HumanRequestPayload {
  decisionId: number;
  question: string;
  options: string[];
}
