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

export type PrState = "none" | "open" | "closed" | "merged" | "unknown";
export type PrChecksStatus = "passing" | "pending" | "failing" | "unknown";

export interface PrRecord {
  workspaceId: string;
  repoPath: string;
  branch: string;
  prNumber: number | null;
  prUrl: string | null;
  title: string | null;
  state: PrState;
  isDraft: boolean;
  headRef: string | null;
  baseRef: string | null;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  mergeable: string | null;
  checksStatus: PrChecksStatus;
  checksSummary: string | null;
  branchExists: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
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
