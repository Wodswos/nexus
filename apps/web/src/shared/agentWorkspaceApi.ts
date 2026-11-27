import { apiRequest } from '@nexus/crdt';
import type { WorkspaceConfig, WorkspaceEnvironment, WorkspaceAgent, AgentEvent, CreateWorkspaceAgent, AgentRound, AgentRoundInput, AgentProductPreset } from '@nexus/core';

export interface WorkspaceProfileView {
  id: string;
  name: string;
  taskId?: string;
  config: WorkspaceConfig;
  promptTemplate: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}
export type WorkspaceAgentView = WorkspaceAgent;
export type AgentEventView = AgentEvent;
export type CreateAgentInput = CreateWorkspaceAgent;
export interface WorkAreaCleanupPlan {
  directory:string; branch?:string; kind:string; dataDeletedAt?:number;
  agents:{id:string;name:string;state:string}[]; artifacts:string[]; blockers:string[];
  inspection?:{exists:boolean;dirty:boolean;unpushed:boolean}; inspectionError?:string;
}
export interface KubernetesConnectionView {
  id: string;
  name: string;
  server: string;
  namespace: string;
  ca: string;
  tokenSet: boolean;
  certificateSet: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface KubernetesConnectionInput {
  name: string;
  server: string;
  namespace: string;
  ca?: string;
  token?: string | null;
  cert?: string | null;
  key?: string | null;
}

export interface TaskAgentGroup {
  task: { id: string; title: string; status: string; parentId: string | null };
  taskId: string; title: string; projectId?: string; projectTitle?: string;
  agents: WorkspaceAgentView[]; rounds: AgentRound[]; reasons: string[]; updatedAt: number;
}
export interface AgentWorkbench { groups: { waiting: TaskAgentGroup[]; review: TaskAgentGroup[]; running: TaskAgentGroup[]; error: TaskAgentGroup[] }; counts: Record<string, number> }
const key = encodeURIComponent;
async function get<T>(path: string): Promise<T> {
  return (await apiRequest<{ data: T }>(path)).data;
}
async function write<T>(path: string, method: string, value?: unknown): Promise<T> {
  return (await apiRequest<{ data: T }>(path, { method, body: value === undefined ? undefined : JSON.stringify(value) }, 20000)).data;
}
export const agentWorkspaceApi = {
  workAreaPlan: (id:string) => get<WorkAreaCleanupPlan>(`/api/agents/${key(id)}/workarea/cleanup-plan`),
  cleanWorkArea: (id:string,confirmDirectory:string) => write<WorkspaceAgentView>(`/api/agents/${key(id)}/workarea`,'DELETE',{confirmDirectory}),
  cleanupPlan: (id:string) => get<{terminals?:{id:string;session:string}[];taskIds:string[];agents:{id:string;name:string;state:string;directory:string}[];git?:{dirty:boolean;unpushed:boolean};inspectionError?:string}>(`/api/workspace-environments/${key(id)}/cleanup-plan`),
  all: () => get<WorkspaceAgentView[]>('/api/agents'),
  snapshot: (id:string,before?:number) => get<import('@nexus/core').ConversationSnapshot>(`/api/agents/${key(id)}/conversation${before?`?before=${before}`:''}`),
  reconcile: (id:string,runId:string,resolution:'completed'|'cancelled') => write<unknown>(`/api/agents/${key(id)}/runs/${key(runId)}/reconcile`,'POST',{resolution}),
  queue: (id:string,messageId:string,input:{text?:string;cancel?:boolean}) => write<unknown>(`/api/agents/${key(id)}/messages/${key(messageId)}`,'PATCH',input),
  answer: (id:string,permissionId:string,answers:Record<string,string|string[]>) => write<unknown>(`/api/agents/${key(id)}/answers`,'POST',{permissionId,answers}),
  terminal: (id:string,requestId?:string) => write<import('@nexus/core').WorkspacePane>(`/api/agents/${key(id)}/terminal`,'POST',{requestId}),
  endTerminal:(id:string,paneId:string)=>write<unknown>(`/api/agents/${key(id)}/terminals/${key(paneId)}`,'DELETE'),
  changes: (id:string) => get<{directory:string;branch?:string;text:string;truncated:boolean;updatedAt:number}>(`/api/agents/${key(id)}/changes`),
  providers: () => get<import('@nexus/core').ProviderInstance[]>('/api/agent-providers'),
  saveProvider: (value:Partial<import('@nexus/core').ProviderInstance>) => write<import('@nexus/core').ProviderInstance>(`/api/agent-providers${value.id?`/${key(value.id)}`:''}`,value.id?'PUT':'POST',value),
  deleteProvider: (id:string) => write<unknown>(`/api/agent-providers/${key(id)}`,'DELETE'),
  bindings: (taskId:string) => get<(import('@nexus/core').NodeWorkspaceBinding & {inherited:boolean;environment:WorkspaceEnvironment})[]>(`/api/tasks/${key(taskId)}/workspace-bindings`),
  bind: (taskId:string,value:{environmentId:string;inherit?:boolean;remove?:boolean}) => write<unknown>(`/api/tasks/${key(taskId)}/workspace-bindings`,'POST',value),
  workbench: () => get<AgentWorkbench>('/api/agent-workbench'),
  products: () => get<AgentProductPreset[]>('/api/agent-products'),
  check: (value: { taskId: string; environmentId: string; mode: WorkspaceAgent['mode']; command: string; productId?: string; pane?: import('@nexus/core').WorkspacePane }) => write<Record<string, unknown>>('/api/agents/check', 'POST', value),
  cancelRound: (id: string, roundId: string, value: { requestId: string; text?: string }) => write<{agent: WorkspaceAgentView; round: AgentRound}>(`/api/agents/${key(id)}/rounds/${key(roundId)}/cancel`, 'POST', value),
  rounds: (id: string) => get<AgentRound[]>(`/api/agents/${key(id)}/rounds`),
  newRound: (id: string, value: AgentRoundInput & { requestId: string; text?: string }) => write<AgentRound>(`/api/agents/${key(id)}/rounds`, 'POST', value),
  reviewRound: (id: string, roundId: string, value: { requestId: string; action: 'accept' | 'revise' | 'complete_task'; text?: string }) => write<{ agent: WorkspaceAgentView; round: AgentRound; taskCompleted: boolean }>(`/api/agents/${key(id)}/rounds/${key(roundId)}/review`, 'POST', value),
  environments: () => get<WorkspaceEnvironment[]>('/api/workspace-environments'),
  environmentAction: (id: string, action: 'stop' | 'resume' | 'archive', value?: unknown) => write<WorkspaceEnvironment>(`/api/workspace-environments/${key(id)}/${action}`, 'POST', value ?? {}),
  destroyEnvironment: (id: string) => write<WorkspaceEnvironment>(`/api/workspace-environments/${key(id)}`, 'DELETE'),
  deleteEnvironmentData: (id: string) => write<WorkspaceEnvironment>(`/api/workspace-environments/${key(id)}/data`, 'DELETE', { confirm: true }),
  preview: (taskId: string, value: { requestId?: string; environmentId?: string; config?: WorkspaceConfig; worktreeName: string }) => write<{ environmentId: string; workRoot: string; directory: string; branch: string }>(`/api/workspaces/${key(taskId)}/preview`, 'POST', value),
  launch: (taskId: string, value: { requestId: string; name?: string; workspaceId?: string; config: WorkspaceConfig; agent?: Omit<CreateAgentInput, 'requestId' | 'environmentId'> }) => write<{ environment: WorkspaceEnvironment; agent?: WorkspaceAgentView }>(`/api/tasks/${key(taskId)}/workspace-launch`, 'POST', value),
  list: (taskId: string) => get<WorkspaceAgentView[]>(`/api/tasks/${key(taskId)}/agents`),
  agent: (id: string) => get<WorkspaceAgentView>(`/api/agents/${key(id)}`),
  prompt: (taskId: string) => get<{ prompt: string; contextUrlTemplate: string; taskUrl: string }>(`/api/tasks/${key(taskId)}/agent-prompt`),
  create: (taskId: string, value: CreateAgentInput) => write<WorkspaceAgentView>(`/api/tasks/${key(taskId)}/agents`, 'POST', value),
  events: (id: string, after: number) => get<{ events: AgentEventView[]; nextCursor: number; hasMore: boolean }>(`/api/agents/${key(id)}/events?after=${after}`),
  send: (id: string, requestId: string, text: string) => write<unknown>(`/api/agents/${key(id)}/messages`, 'POST', { requestId, text }),
  action: (id: string, action: 'cancel' | 'resume' | 'retry' | 'stop', value?: { newSession?: boolean }) => write<WorkspaceAgentView>(`/api/agents/${key(id)}/${action}`, 'POST', value ?? {}),
  permission: (id: string, permissionId: string, optionId: string | null) => write<unknown>(`/api/agents/${key(id)}/permissions`, 'POST', { permissionId, optionId }),
  profiles: () => get<WorkspaceProfileView[]>('/api/workspace-profiles'),
  createProfile: (value: { requestId: string; name: string; taskId?: string; config: WorkspaceConfig; promptTemplate?: string }) => write<WorkspaceProfileView>('/api/workspace-profiles', 'POST', value),
  updateProfile: (id: string, value: { name?: string; config?: WorkspaceConfig; promptTemplate?: string; expectedUpdatedAt?: number }) => write<WorkspaceProfileView>(`/api/workspace-profiles/${key(id)}`, 'PATCH', value),
  deleteProfile: (id: string) => write<unknown>(`/api/workspace-profiles/${key(id)}`, 'DELETE'),
  connections: () => get<KubernetesConnectionView[]>('/api/kubernetes-connections'),
  saveConnection: (value: KubernetesConnectionInput, id?: string) => write<KubernetesConnectionView>(`/api/kubernetes-connections${id ? `/${key(id)}` : ''}`, id ? 'PUT' : 'POST', value),
  deleteConnection: (id: string) => write<unknown>(`/api/kubernetes-connections/${key(id)}`, 'DELETE'),
};
