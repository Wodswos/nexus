import type { WorkspacePane } from './executionWorkspace';

export type WorkspaceAgentState = 'queued' | 'preparing' | 'starting' | 'idle' | 'running' | 'waiting' | 'failed' | 'interrupted' | 'stopped' | 'disconnected';
export type AgentEventKind = 'user' | 'assistant' | 'thought' | 'tool' | 'plan' | 'permission' | 'status' | 'error' | 'report' | 'terminal';
export type AgentRoundKind = 'auto' | 'clarify' | 'design' | 'explore' | 'implement' | 'deliver';
export type AgentRoundState = 'running' | 'waiting_user' | 'awaiting_review' | 'accepted' | 'cancelled' | 'failed';
export interface AgentRoundInput {
  kind: AgentRoundKind;
  objective: string;
  expectedOutcome: string;
  acceptanceCriteria: string[];
}
export interface AgentRound extends AgentRoundInput {
  id: string;
  agentId: string;
  taskId: string;
  sequence: number;
  state: AgentRoundState;
  reportId?: string;
  baseRevisionId?: string;
  createdAt: number;
  updatedAt: number;
  acceptedAt?: number;
}
export interface AgentReport {
  id: string;
  agentId: string;
  agentName: string;
  taskId: string;
  roundId?: string;
  summary: string;
  verification: string;
  remaining: string;
  artifacts: string[];
  suggestions?: AgentSuggestion[];
  createdAt: number;
}
export interface AgentSuggestion { label: string; text: string }
export interface AgentQuestion {
  id: string;
  question: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}
export const AGENT_INTERACTION_GUIDE = `澄清问题优先使用原生选择题工具；不可用时向 eventsUrl POST {requestId,kind:"waiting",text,questions:[{id,question,options:[{label,description}],multiSelect:false}]}，从后续消息或上下文 questions 读取回答。选项应具体、说明取舍，允许自定义回答，不替用户选择。回复或报告可附 suggestions:[{label,text}]（最多 4 项），提出结合当前进展的下一步建议；建议不代表用户已授权执行。`;

export interface AgentProductPreset {
  id: string;
  name: string;
  mode: 'acp' | 'tmux' | 'codex' | 'claude';
  command: string;
  executable?: string;
  description: string;
  verified: false;
  legacy?: boolean;
}
export interface WorkspaceAgent {
  id: string;
  workspaceId: string | null;
  taskId: string;
  environmentId: string;
  name: string;
  mode: 'acp' | 'tmux' | 'codex' | 'claude';
  command: string;
  persistentSession?: boolean;
  providerId?: string;
  model?: string;
  capabilities?: import('./agentRuntime').AgentCapabilities;
  sessionGeneration?: number;
  connectionState?: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  workArea?: import('./agentRuntime').AgentWorkArea;
  terminalPolicy?: 'on-demand' | 'create' | 'disabled';
  terminalPane?: WorkspacePane;
  terminalPanes?: WorkspacePane[];
  prompt: string;
  directory: string;
  worktree: boolean;
  isolatedDirectory?: boolean;
  worktreeName?: string;
  /** Absent on legacy records, which retain their original worktrees directory. */
  worktreeLayoutVersion?: 2;
  pane?: WorkspacePane;
  state: WorkspaceAgentState;
  stage: 'environment' | 'agent' | 'prompt' | 'ready';
  remoteSessionId?: string;
  canResume: boolean;
  productId?: string;
  branch?: string;
  currentRoundId?: string;
  currentRound?: AgentRound;
  waitReason?: 'user' | 'permission';
  error?: string;
  createdAt: number;
  updatedAt: number;
}
export interface CreateWorkspaceAgent {
  requestId: string;
  environmentId: string;
  workspaceId?: string | null;
  name: string;
  mode: 'acp' | 'tmux' | 'codex' | 'claude';
  command: string;
  persistentSession?: boolean;
  providerId?: string;
  model?: string;
  terminalPolicy?: 'on-demand' | 'create' | 'disabled';
  prompt?: string;
  directory?: string;
  worktree?: boolean;
  isolatedDirectory?: boolean;
  worktreeName?: string;
  pane?: WorkspacePane;
  productId?: string;
  round?: AgentRoundInput;
}
export interface AgentEvent {
  id: number;
  agentId: string;
  kind: AgentEventKind;
  text: string;
  data?: Record<string, unknown>;
  roundId?: string;
  createdAt: number;
}
export interface AgentEventsPage {
  events: AgentEvent[];
  nextCursor: number;
  hasMore: boolean;
}
export interface AgentMessage {
  id: string;
  agentId: string;
  text: string;
  state: 'queued' | 'sending' | 'delivered' | 'failed' | 'unknown' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  error?: string;
  acknowledgedAt?: number;
  roundId?: string;
}
export const DEFAULT_AGENT_PROMPT = `你正在处理 Nexus 任务「{{task_title}}」。任务页面：{{task_url}}。
1. 每次收到工作指令，先通过 REST API GET {{task_context_url}}，读取最新任务正文及版本、祖先与子任务背景、关联资源、工作记录和未确认消息。历史记录仅供参考，不重放旧指令。处理消息后向 acknowledgeUrl 提交消息 ID。
2. 每次 API 请求前读取 NEXUS_AGENT_TOKEN_FILE 指向的文件；未配置文件时使用 NEXUS_AGENT_TOKEN，以 Authorization: Bearer 认证。不要缓存或输出凭据。遇到 401 时重新读取文件，以原请求 ID 重试一次；仍失败则报告认证问题。
3. 明确本次推进范围。仅有标题或关键信息不足时，先提出 1–3 个具体问题，再开展依赖答案的工作；信息充分则直接推进。提问和下一步建议的格式见上下文 interactionGuide。用户只要求讨论、设计或探索时，不扩大为代码实现。
4. 实现任务时完成必要验证，再提交代码、推送独立分支并创建或更新 PR；用户对提交、推送、发布与部署的具体要求优先，不自动合并 PR。遇到阻塞如实说明，不伪造测试、提交或产物。
5. 将经确认的设计、取舍及执行结果合并写回 Task 正文：向 descriptionUrl 提交 {expectedRevisionId:revision.id,notes}。保留原文和其他人的有效内容；版本冲突时重新读取并合并。纯探索或用户要求只保存报告时不改正文。
6. 完成后向 reportUrl 提交 {requestId,roundId,summary,verification,remaining,artifacts,suggestions?}；roundId 使用最新上下文 currentRound.id，requestId 为唯一 ID。报告写明实际成果、验证、未完成事项和真实链接。不擅自将 Task 标记完成；清理环境按用户要求执行，保留代码和历史。`;

export const AGENT_PRODUCT_PRESETS: readonly AgentProductPreset[] = [
  { id: 'codex-native', name: 'Codex', mode: 'codex', command: 'codex app-server', executable: 'codex', description: '原生 App Server：对话、工具、审批和持久会话。', verified: false },
  { id: 'claude-sdk', name: 'Claude Code', mode: 'claude', command: 'node', executable: 'node', description: '在 Workspace 内运行 Claude Agent SDK；需要安装 @anthropic-ai/claude-agent-sdk。', verified: false },
  { id: 'generic-acp', name: '通用 ACP Agent', mode: 'acp', command: '', description: '填写目标环境中支持 ACP v1 的命令；连接检测会实际握手。', verified: false },
  { id: 'codex-terminal', legacy: true, name: 'Codex CLI · 终端', mode: 'tmux', command: 'codex', executable: 'codex', description: '需要目标环境已安装 Codex CLI 并完成模型认证。通过终端交互，尚未逐版本认证。', verified: false },
  { id: 'claude-terminal', legacy: true, name: 'Claude Code · 终端', mode: 'tmux', command: 'claude', executable: 'claude', description: '需要目标环境已安装 Claude Code 并完成认证。通过终端交互，尚未逐版本认证。', verified: false },
  { id: 'gemini-terminal', legacy: true, name: 'Gemini CLI · 终端', mode: 'tmux', command: 'gemini', executable: 'gemini', description: '需要目标环境已安装 Gemini CLI 并完成认证。通过终端交互，尚未逐版本认证。', verified: false },
  { id: 'opencode-terminal', legacy: true, name: 'OpenCode · 终端', mode: 'tmux', command: 'opencode', executable: 'opencode', description: '需要目标环境已安装 OpenCode 并配置模型。通过终端交互，尚未逐版本认证。', verified: false },
  { id: 'custom-terminal', legacy: true, name: '自定义 Agent CLI', mode: 'tmux', command: '', description: '填写终端启动命令，或关联已运行 Agent 的 tmux pane。', verified: false },
];

export function renderAgentPrompt(template: string, values: { taskTitle: string; taskUrl: string; contextUrl: string }): string {
  const valuesByKey: Record<string, string> = { task_title: values.taskTitle, task_url: values.taskUrl, task_context_url: values.contextUrl };
  return template.replace(/\{\{(task_title|task_url|task_context_url)\}\}/g, (_, key: string) => valuesByKey[key]!);
}
