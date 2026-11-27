import { EMPTY_WORKSPACE, WORKSPACE_CONFIG_KEYS, validateNodeWorkspace, type WorkspaceConfig } from './executionWorkspace';

/** Reusable, account-local configuration. Credentials are references, never secret values. */
export interface WorkspaceProfile {
  id: string;
  name: string;
  taskId?: string;
  config: WorkspaceConfig;
  /** @deprecated Retained for older backups/clients; new Agents own their prompt. */
  promptTemplate: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}

export function validateWorkspaceProfile(value: unknown): asserts value is WorkspaceProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workspace 档案格式无效');
  const row = value as Record<string, unknown>;
  if (row.taskId !== undefined && (typeof row.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.taskId))) throw new Error('Workspace 模板所属 Task 无效');
  if (Object.keys(row).some(key => !['id', 'name', 'taskId', 'config', 'promptTemplate', 'createdAt', 'updatedAt', 'deletedAt'].includes(key)))
    throw new Error('Workspace 档案包含未知字段');
  if (typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.id)) throw new Error('Workspace 档案 ID 无效');
  if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120 || row.name.includes('\0'))
    throw new Error('Workspace 名称需要 1–120 个字符');
  if (typeof row.promptTemplate !== 'string' || row.promptTemplate.length > 24000 || row.promptTemplate.includes('\0'))
    throw new Error('Workspace Prompt 最多 24000 个字符');
  if (!row.config || typeof row.config !== 'object' || Array.isArray(row.config)) throw new Error('Workspace 配置格式无效');
  if (Object.entries(row.config).some(([key, field]) => !(WORKSPACE_CONFIG_KEYS as readonly string[]).includes(key) || typeof field !== 'string'))
    throw new Error('Workspace 配置包含未知字段或非文本值');
  validateNodeWorkspace({ ...EMPTY_WORKSPACE, ...row.config, id: 'profile', mode: 'override' });
  for (const key of ['createdAt', 'updatedAt'] as const)
    if (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error('Workspace 时间无效');
  if (row.deletedAt != null && (typeof row.deletedAt !== 'number' || !Number.isSafeInteger(row.deletedAt) || row.deletedAt < 0))
    throw new Error('Workspace 删除时间无效');
}
