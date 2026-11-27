import type { NexusData } from './types';
import type { WorkspaceProfile } from './workspaceProfiles';

export type WorkspaceRuntime = 'ssh' | 'docker' | 'kubernetes' | 'linux-user';
/** SSH resolves HOME on the execution host; the stored empty value selects this default. */
export function workspaceDefaultRoot(runtime: WorkspaceRuntime): string {
  return runtime === 'ssh' ? '$HOME/.local/share/nexus/workspaces'
    : runtime === 'linux-user' ? '/var/lib/nexus/workspaces' : '/workspace';
}
export interface WorkspaceConfig {
  runtime: WorkspaceRuntime;
  serverId: string;
  /** Account-owned direct Kubernetes API connection. Empty retains SSH/kubectl. */
  kubeConnectionId?: string;
  image: string;
  repository: string;
  ref: string;
  directory: string;
  session: string;
  /** Omitted on legacy templates, which eagerly create their terminal. */
  terminalPolicy?: "on-demand" | "create";
  agentCommand: string;
  context: string;
  namespace: string;
  secretRef: string;
  imagePullSecret: string;
  localRepository?: string;
  source?: 'auto' | 'local' | 'remote';
  branch?: string;
  prTarget?: string;
  workRoot?: string;
  storage?: 'persistent' | 'ephemeral';
  volumeName?: string;
  storageClass?: string;
  storageSize?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  runUser?: string;
  pidsLimit?: string;
}
export const WORKSPACE_CONFIG_KEYS = [
  'runtime',
  'serverId',
  'kubeConnectionId',
  'image',
  'repository',
  'ref',
  'directory',
  'session',
  'terminalPolicy',
  'agentCommand',
  'context',
  'namespace',
  'secretRef',
  'imagePullSecret',
  'localRepository', 'source', 'branch', 'prTarget', 'workRoot', 'storage', 'volumeName', 'storageClass', 'storageSize', 'cpuLimit', 'memoryLimit', 'runUser', 'pidsLimit',
] as const;
export interface NodeWorkspace
  extends Partial<
    Record<Exclude<keyof WorkspaceConfig, 'runtime'>, string | null>
  > {
  id: string;
  mode: 'inherit' | 'override' | 'disabled';
  runtime?: WorkspaceRuntime | null;
  environmentId?: string | null;
  workspaceId?: string | null;
}
export const EMPTY_WORKSPACE: WorkspaceConfig = {
  runtime: 'ssh',
  serverId: '',
  kubeConnectionId: '',
  image: '',
  repository: '',
  ref: '',
  directory: '',
  session: '',
  agentCommand: '',
  context: '',
  namespace: 'default',
  secretRef: '',
  imagePullSecret: '',
  localRepository: '', source: 'auto', branch: '', prTarget: '', workRoot: '', storage: 'persistent', volumeName: '', storageClass: '', storageSize: '10Gi', cpuLimit: '', memoryLimit: '', runUser: '', pidsLimit: '256',
};

export function validateNodeWorkspace(
  value: unknown,
): asserts value is NodeWorkspace {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Workspace 配置格式无效');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.id))
    throw new Error('Workspace 节点 ID 无效');
  if (!['inherit', 'override', 'disabled'].includes(String(row.mode)))
    throw new Error('Workspace 继承方式无效');
  for (const [key, field] of Object.entries(row)) {
    if (key === 'id' || key === 'mode') continue;
    if (
      key !== 'environmentId' &&
      key !== 'workspaceId' &&
      !(WORKSPACE_CONFIG_KEYS as readonly string[]).includes(key)
    )
      throw new Error(`Workspace 字段无效 ${key}`);
    if (field === null || field === undefined) continue;
    if (
      typeof field !== 'string' ||
      field.length > (key === 'agentCommand' ? 4096 : 2048) ||
      field.includes('\0')
    )
      throw new Error(`Workspace 字段格式无效 ${key}`);
    if (key === 'runtime' && !['ssh', 'docker', 'kubernetes', 'linux-user'].includes(field))
      throw new Error('Workspace 运行方式无效');
    if (key === 'source' && !['auto', 'local', 'remote'].includes(field)) throw new Error('Workspace 仓库来源无效');
    if (key === 'terminalPolicy' && !['on-demand','create'].includes(field)) throw new Error('Workspace 终端策略无效');
    if (key === 'storage' && !['persistent', 'ephemeral'].includes(field)) throw new Error('Workspace 存储方式无效');
  }
}

export function resolveWorkspace(
  data: Pick<NexusData, 'tasks' | 'workspaces'> & { workspaceProfiles?: WorkspaceProfile[] },
  taskId: string,
) {
  const tasks = new Map(data.tasks.map((task) => [task.id, task]));
  const bindings = new Map(
    (data.workspaces ?? []).map((binding) => [binding.id, binding]),
  );
  const profiles = new Map((data.workspaceProfiles ?? []).filter((profile) => profile.deletedAt == null).map((profile) => [profile.id, profile]));
  const path: string[] = [],
    seen = new Set<string>();
  let cursor: string | null = taskId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const task = tasks.get(cursor);
    if (!task || task.deletedAt != null || task.status === 'archived') break;
    path.unshift(cursor);
    cursor = task.parentId;
  }
  let config = { ...EMPTY_WORKSPACE },
    disabled = false;
  let sources: Partial<Record<keyof WorkspaceConfig, string>> = {};
  let environmentId: string | null = null,
    environmentSource: string | null = null;
  let workspaceId: string | null = null, workspaceSource: string | null = null, promptTemplate = '';
  let missingProfile = false;
  for (const id of path) {
    const binding = bindings.get(id);
    if (!binding) continue;
    if (binding.mode === 'disabled') {
      config = { ...EMPTY_WORKSPACE };
      sources = {};
      disabled = true;
      environmentId = null;
      environmentSource = null;
      workspaceId = null;
      workspaceSource = null;
      promptTemplate = '';
      missingProfile = false;
      continue;
    }
    if (binding.workspaceId !== undefined) {
      workspaceId = binding.workspaceId;
      workspaceSource = id;
      // Template defaults govern future instances; an existing default instance
      // inherits independently until explicitly overridden or unbound.
      if (workspaceId) {
        const profile = profiles.get(workspaceId);
        config = { ...EMPTY_WORKSPACE, ...profile?.config };
        sources = {};
        promptTemplate = profile?.promptTemplate ?? '';
        disabled = !profile;
        missingProfile = !profile;
        if (!profile) { environmentId = null; environmentSource = null; continue; }
        for (const key of WORKSPACE_CONFIG_KEYS) sources[key] = id;
      } else {
        config = { ...EMPTY_WORKSPACE };
        sources = {};
        promptTemplate = '';
        disabled = false;
        missingProfile = false;
      }
    }
    // A stale profile reference is a closed boundary until the user explicitly selects or detaches a profile.
    if (missingProfile) continue;
    if (binding.mode === 'override') {
      disabled = false;
      for (const key of WORKSPACE_CONFIG_KEYS) {
        const value = binding[key];
        if (value === undefined) continue;
        Object.assign(config, { [key]: value ?? EMPTY_WORKSPACE[key] });
        sources[key] = id;
      }
    }
    if (binding.environmentId !== undefined) {
      environmentId = binding.environmentId;
      environmentSource = id;
    }
  }
  return {
    config,
    sources,
    disabled,
    configured: !disabled && !!(config.runtime === 'kubernetes' && config.kubeConnectionId ? config.kubeConnectionId : config.serverId),
    workspaceId,
    workspaceSource,
    promptTemplate,
    path,
    environmentId,
    environmentSource,
  };
}

export interface WorkspaceEnvironment {
  workspaceId?: string;
  id: string;
  taskId: string;
  config: WorkspaceConfig;
  connectionHost: string;
  state: 'queued' | 'preparing' | 'ready' | 'failed' | 'unknown' | 'paused' | 'stopped';
  managed: boolean;
  name?: string;
  archivedAt?: number | null;
  workRoot?: string;
  layoutVersion?: 2;
  repositorySource?: 'local' | 'remote' | 'none';
  branch?: string;
  baseRef?: string;
  baseCommit?: string;
  prTarget?: string;
  executionUser?: string;
  executionUid?: number;
  credentialFile?: string;
  storage?: { kind: 'directory' | 'docker-volume' | 'pvc' | 'ephemeral'; name?: string; managed: boolean; mountRoot: string; uid?: string };
  dataDeletedAt?: number;
  /** Data removal checkpoint; remaining compute/storage cleanup can be retried. */
  dataClearedAt?: number;
  resourceId: string;
  resourceUid?: string;
  session: string;
  directory: string;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  error?: string;
  log?: string;
}
export interface WorkspacePane {
  id: string;
  sessionId: string;
  session: string;
  windowId: string;
  window: string;
  pid: number;
  serverPid: number;
  command: string;
  directory: string;
  dead: boolean;
}
export interface WorkspaceInstruction {
  id: string;
  taskId: string;
  environmentId: string;
  pane: WorkspacePane;
  text: string;
  submit: boolean;
  terminalInput: boolean;
  state: 'queued' | 'sending' | 'delivered' | 'failed' | 'unknown';
  createdAt: number;
  updatedAt: number;
  error?: string;
}

/** Runtime validation also protects actions made from older or partially edited configs. */
export function validateWorkspaceConfig(config: WorkspaceConfig): void {
  validateNodeWorkspace({ ...config, id: 'config', mode: 'override' });
  const optional = new Set(['terminalPolicy','kubeConnectionId', 'localRepository', 'source', 'branch', 'prTarget', 'workRoot', 'storage', 'volumeName', 'storageClass', 'storageSize', 'cpuLimit', 'memoryLimit', 'runUser', 'pidsLimit']);
  if (WORKSPACE_CONFIG_KEYS.some((key) => !optional.has(key) && typeof config[key] !== 'string'))
    throw new Error('Workspace 配置字段不完整');
  if (!(config.runtime === 'kubernetes' && config.kubeConnectionId) && !config.serverId)
    throw new Error('请选择控制主机的 SSH 连接或 Kubernetes 连接');
  if (!['ssh', 'linux-user'].includes(config.runtime) && !config.image.trim())
    throw new Error('请设置环境 image');
  if (config.image.startsWith('-') || /[\s\0]/.test(config.image))
    throw new Error('image 格式无效');
  if (
    config.directory &&
    (!config.directory.startsWith('/') || /[\r\n]/.test(config.directory))
  )
    throw new Error('工作目录需要使用绝对路径');
  if (config.ref.startsWith('-') || /[\r\n]/.test(config.ref))
    throw new Error('仓库版本格式无效');
  if (config.repository) {
    if (
      config.repository.startsWith('git@') &&
      /^git@[A-Za-z0-9.-]+:[A-Za-z0-9_.\/-]+$/.test(config.repository)
    ) {
      // SSH repository URLs use the environment's own Git credentials.
    } else {
      let url: URL;
      try {
        url = new URL(config.repository);
      } catch {
        throw new Error('请填写 HTTPS 或 SSH 仓库地址');
      }
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('仓库地址需要使用 HTTPS，凭据通过环境配置引用');
    }
  }
  for (const field of ['localRepository', 'workRoot'] as const) {
    const value = config[field];
    if (value && (!value.startsWith('/') || /[\0\r\n]/.test(value) || value.split('/').includes('..'))) throw new Error(`Workspace ${field} 需要使用执行环境内的绝对路径`);
  }
  if (['docker','kubernetes'].includes(config.runtime) && [config.workRoot, config.directory].some((path) => path && /[,\t]/.test(path))) throw new Error('Workspace 容器挂载路径不能包含逗号或制表符');
  if (config.runtime === 'kubernetes' && config.volumeName && !/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(config.volumeName)) throw new Error('Kubernetes PVC 名称无效');
  if (config.source === 'local' && !config.localRepository) throw new Error('Workspace 本地来源需要填写本地仓库路径');
  if (config.source === 'remote' && !config.repository) throw new Error('Workspace 远程来源需要填写仓库地址');
  for (const field of ['branch', 'prTarget'] as const) if (config[field] && (config[field]!.startsWith('-') || /[\s\0~^:?*\[\\]/.test(config[field]!))) throw new Error(`Workspace ${field} 分支名称无效`);
  if (config.volumeName && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(config.volumeName)) throw new Error('Workspace 持久卷名称无效');
  if (config.cpuLimit && (!/^[0-9]+(?:\.[0-9]+)?$/.test(config.cpuLimit) || Number(config.cpuLimit) <= 0 || Number(config.cpuLimit) > 1024)) throw new Error('Workspace CPU 上限需要使用 0–1024 之间的核数');
  if (config.memoryLimit && !/^[1-9][0-9]*(Mi|Gi|Ti)$/.test(config.memoryLimit)) throw new Error('Workspace 内存上限需要使用 Mi／Gi／Ti');
  if (config.runUser && !/^[0-9]{1,9}(?::[0-9]{1,9})?$/.test(config.runUser)) throw new Error('Workspace 运行用户需要使用 UID 或 UID:GID');
  if (config.pidsLimit && (!/^[1-9][0-9]{0,5}$/.test(config.pidsLimit) || Number(config.pidsLimit) < 16)) throw new Error('Workspace 进程上限需要至少 16');
  if (config.runtime === 'linux-user' && (config.cpuLimit || config.memoryLimit || config.runUser)) throw new Error('Workspace Linux 独立用户由系统分配 UID，当前只支持进程数上限；CPU／内存请使用容器预设');
  if (config.storageClass && !/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(config.storageClass)) throw new Error('Kubernetes StorageClass 无效');
  if (config.storageSize && !/^[1-9][0-9]*(Mi|Gi|Ti)$/.test(config.storageSize)) throw new Error('Kubernetes 存储容量需要使用 Mi／Gi／Ti');
  if (config.runtime === 'kubernetes') {
    if (
      config.namespace &&
      !/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(config.namespace)
    )
      throw new Error('Kubernetes namespace 格式无效');
    for (const key of ['namespace', 'secretRef', 'imagePullSecret'] as const) {
      if (
        config[key] &&
        !/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(config[key])
      )
        throw new Error(`Kubernetes ${key} 格式无效`);
    }
  } else if (config.secretRef && !config.secretRef.startsWith('/'))
    throw new Error('环境凭据文件需要使用远端绝对路径');
}
