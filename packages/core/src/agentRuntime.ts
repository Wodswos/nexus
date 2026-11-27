/** Runtime authority lives on the server. These values never enter the CRDT. */
export type AgentHarness = "codex" | "claude" | "acp" | "terminal";
export interface AgentCapabilities {
  text: boolean;
  tools: boolean;
  approvals: boolean;
  questions: boolean;
  history: boolean;
  resume: boolean;
  cancel: boolean;
  steer: boolean;
  models: boolean;
  tuiHandoff: boolean;
  fork: boolean;
  rollback: boolean;
  version?: string;
}
export interface ProviderInstance {
  id: string;
  name: string;
  harness: Exclude<AgentHarness, "terminal">;
  command: string;
  model?: string;
  /** Absolute path on the execution side; secrets are never returned by this API. */
  configDirectory?: string;
  createdAt: number;
  updatedAt: number;
}
export type AgentRunState =
  | "queued"
  | "starting"
  | "running"
  | "waiting_input"
  | "completed"
  | "cancelled"
  | "failed"
  | "unknown";
export interface AgentRun {
  id: string;
  agentId: string;
  messageId: string;
  roundId?: string;
  state: AgentRunState;
  attemptId?: string;
  generation: number;
  nativeTurnId?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
}
export interface AgentWorkArea {
  id: string;
  agentId: string;
  environmentId: string;
  directory: string;
  kind: "worktree" | "directory";
  branch?: string;
  baseCommit?: string;
  owned: boolean;
  cleanupStartedAt?: number;
  dataDeletedAt?: number;
  createdAt: number;
}
export interface ConversationItem {
  id: string;
  agentId: string;
  kind: string;
  text: string;
  data?: Record<string, unknown>;
  runId?: string;
  roundId?: string;
  sequence: number;
  createdAt: number;
  updatedAt: number;
}
export interface ConversationSnapshot {
  items: ConversationItem[];
  sequence: number;
  before?: number;
  hasMore: boolean;
  runs: AgentRun[];
  messages: import("./agentWorkspace").AgentMessage[];
}
export interface NodeWorkspaceBinding {
  id: string;
  taskId: string;
  environmentId: string;
  inherit: boolean;
  createdAt: number;
}
