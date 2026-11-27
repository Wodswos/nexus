const text = { type: 'string' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const config = {
  runtime: { type: 'string', enum: ['ssh', 'docker', 'kubernetes', 'linux-user'] },
  serverId: { ...text, description: '当前账号的 SSH 控制主机档案 ID' },
  kubeConnectionId: { ...text, description: 'Kubernetes 直连档案 ID。设置后无需 SSH 控制主机，留空继续使用 kubectl。' },
  image: text,
  repository: text,
  ref: text,
  directory: text,
  session: text,
  terminalPolicy:{enum:["on-demand","create"]},
  agentCommand: text,
  context: text,
  namespace: text,
  secretRef: {
    ...text,
    description:
      'SSH／Docker 为远端 env 文件绝对路径，Kubernetes 为已有 Secret 名称',
  },
  imagePullSecret: text,
  localRepository: { ...text, description: '执行侧绝对路径。本地来源通过独立 worktree 使用，不切换源目录分支。Linux 独立用户先复制私有 Git 对象。' },
  source: { type: 'string', enum: ['auto','local','remote'], default: 'auto', description: 'auto 配置两者时选 local，本地不存在或 origin 不匹配时失败，不静默改远程。' },
  branch: { ...text, description: '实例独立新分支，空值自动生成 nexus-agent/workspace-<id>' },
  prTarget: { ...text, description: 'PR 目标分支；空值动态跟随 ref，两者均空则采用仓库默认分支。' },
  workRoot: { ...text, description: '持久存储基目录，每个实例按 ID 隔离。空值沿用旧 directory 或运行方式默认值：SSH 为执行用户 $HOME/.local/share/nexus/workspaces，Linux 独立用户为 /var/lib/nexus/workspaces，Docker/Pod 为 /workspace。' },
  storage: { type: 'string', enum: ['persistent','ephemeral'], default: 'persistent' },
  volumeName: { ...text, description: '已有 Docker volume 或 PVC 名称，空值为实例创建独立持久卷。外部卷不会整体删除。' },
  storageClass: text,
  storageSize: { ...text, default: '10Gi' },
  cpuLimit: { ...text, description: 'Docker/K8s CPU 核数，例如 0.5、2' }, memoryLimit: { ...text, description: 'Docker/K8s 内存上限，例如 2Gi' }, runUser: { ...text, description: 'Docker/K8s UID 或 UID:GID' }, pidsLimit: { ...text, default: '256', description: 'Docker pids-limit；Linux 独立用户继承 prlimit nproc；K8s 由集群限制' },
};
const object = (properties: object) => ({ type: 'object', properties });
const list = (name: string) => ({ type: 'array', items: ref(name) });
export const workspaceSchemas = {
  WorkspaceConfig: {
    ...object(config),
    required: Object.keys(config).filter((key) => !['terminalPolicy','kubeConnectionId','localRepository','source','branch','prTarget','workRoot','storage','volumeName','storageClass','storageSize','cpuLimit','memoryLimit','runUser','pidsLimit'].includes(key)),
    additionalProperties: false,
  },
  WorkspacePane: object({
    id: text,
    sessionId: text,
    session: text,
    windowId: text,
    window: text,
    pid: { type: 'integer' },
    serverPid: { type: 'integer' },
    command: text,
    directory: text,
    dead: { type: 'boolean' },
  }),
  WorkspaceEnvironment: object({
    id: text,
    taskId: text,
    workspaceId: text,
    config: ref('WorkspaceConfig'),
    connectionHost: text,
    state: {
      type: 'string',
      enum: ['queued', 'preparing', 'ready', 'failed', 'unknown', 'paused', 'stopped'],
    },
    managed: { type: 'boolean' },
    name: text, archivedAt: { type: 'number', nullable: true }, workRoot: text, repositorySource: { enum: ['local','remote','none'] }, branch: text, baseRef: text, prTarget: text, dataDeletedAt: { type: 'number' }, dataClearedAt: { type: 'number' }, storage: { type: 'object' },
    resourceId: text,
    resourceUid: text,
    session: text,
    directory: text,
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
    error: text,
    log: text,
  }),
  WorkspaceInstruction: object({
    id: text,
    taskId: text,
    environmentId: text,
    pane: ref('WorkspacePane'),
    text,
    submit: { type: 'boolean' },
    terminalInput: { type: 'boolean' },
    state: {
      type: 'string',
      enum: ['queued', 'sending', 'delivered', 'failed', 'unknown'],
    },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
    error: text,
  }),
  WorkspaceResource: object({ id: text, name: text, image: text }),
};

export const workspacePaths: Record<string, Record<string, unknown>> = {};
function operation(
  path: string,
  method: string,
  summary: string,
  schema: object,
  body?: object,
  parameters: object[] = [],
) {
  (workspacePaths[path] ??= {})[method] = {
    summary,
    tags: ['Workspace'],
    operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`,
    security: [{ browserSession: [] }],
    description:
      '使用当前账号的浏览器 Cookie 会话，遵循 Origin 检查。执行操作需要账号自有的 SSH 或 Kubernetes 档案。创建与投递通过 JSON 中的 requestId 幂等，重试相同请求时复用原 ID。返回 data 字段。',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: text },
      {
        name: 'X-Cortex-User',
        in: 'header',
        schema: text,
        description: '当前账号 ID，用于检测请求期间的账号切换',
      },
      ...parameters,
    ],
    ...(body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: body } },
          },
        }
      : {}),
    responses: {
      200: {
        description: '成功，异步操作返回当前记录状态',
        content: { 'application/json': { schema: object({ data: schema }) } },
      },
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 413, 429, 502].map((code) => [
          code,
          {
            description: (
              {
                400: '配置或参数无效',
                401: '需要登录 Cookie 会话',
                403: '来源不受信任',
                404: '当前账号内没有此节点、连接或环境',
                409: '幂等冲突、目标已变化或操作进行中',
                413: '请求体超过 64 KiB',
                429: '请求或队列超限',
                502: '远端执行失败',
              } as Record<number, string>
            )[code],
            content: { 'application/json': { schema: ref('Error') } },
          },
        ]),
      ),
    },
  };
}
const requestId = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{1,128}$',
  description: '请求幂等键，同账号内创建和投递分别持久保留',
};
const configInput = object({ config: ref('WorkspaceConfig') });
operation(
  '/api/workspaces/{id}',
  'get',
  '读取节点有效配置、环境和最近投递记录',
  object({
    workspace: object({
      config: ref('WorkspaceConfig'),
      sources: { type: 'object', additionalProperties: text },
      disabled: { type: 'boolean' },
      configured: { type: 'boolean' },
      path: { type: 'array', items: text },
      environmentId: { ...text, nullable: true },
      environmentSource: { ...text, nullable: true },
      title: text,
      workspaceId: { ...text, nullable: true },
      workspaceSource: { ...text, nullable: true },
      promptTemplate: text,
    }),
    environments: list('WorkspaceEnvironment'),
    instructions: list('WorkspaceInstruction'),
  }),
);
operation(
  '/api/workspaces/{id}/discover',
  'post',
  '发现已有 tmux 会话、容器或 Pod',
  list('WorkspaceResource'),
  configInput,
);
operation(
  '/api/workspaces/{id}/environments',
  'post',
  '排队创建环境或关联已有环境',
  ref('WorkspaceEnvironment'),
  {
    ...object({
      requestId,
      config: ref('WorkspaceConfig'),
      resourceId: {
        ...text,
        description:
          '提供时关联已有资源，SSH 使用完整 session 名，Docker 使用容器 ID，Kubernetes 使用 Pod 名称。省略时创建新环境。',
      },
    }),
    required: ['requestId'],
  },
);
operation(
  '/api/workspaces/{id}/instructions',
  'post',
  '向既有 Agent pane 投递文本',
  ref('WorkspaceInstruction'),
  {
    ...object({
      requestId,
      environmentId: text,
      pane: ref('WorkspacePane'),
      text: {
        type: 'string',
        description: 'UTF-8 最多 32000 字节，通过 stdin 按字面发送',
      },
      submit: {
        type: 'boolean',
        default: false,
        description: '粘贴后按 Enter',
      },
      terminalInput: {
        type: 'boolean',
        default: false,
        description: '允许向 Shell 输入，默认仅向运行其他前台程序的 pane 投递',
      },
    }),
    required: ['requestId', 'environmentId', 'pane', 'text'],
  },
);
operation(
  '/api/workspace-environments/{id}',
  'get',
  '读取环境实例与配置快照',
  ref('WorkspaceEnvironment'),
);
operation(
  '/api/workspace-environments/{id}/panes',
  'get',
  '列出可用 tmux pane 与进程身份',
  list('WorkspacePane'),
);
operation(
  '/api/workspace-environments/{id}/output',
  'get',
  '读取 pane 最近 200 行输出',
  text,
  undefined,
  [
    {
      name: 'pane',
      in: 'query',
      required: true,
      schema: { type: 'string', example: '%1' },
    },
  ],
);
operation(
  '/api/workspace-environments/{id}/check',
  'post',
  '检查远端现场并恢复可用状态',
  ref('WorkspaceEnvironment'),
);
operation(
  '/api/workspace-environments/{id}/retry',
  'post',
  '重新准备失败或待核对的托管环境',
  ref('WorkspaceEnvironment'),
);
operation(
  '/api/workspace-environments/{id}',
  'delete',
  '结束托管环境或解除已有环境关联',
  ref('WorkspaceEnvironment'),
);

operation('/api/workspace-environments', 'get', '列出当前账号跨项目的工作环境实例', list('WorkspaceEnvironment'));
(workspacePaths['/api/workspace-environments']!.get as {parameters: {in: string}[]}).parameters = [];
operation('/api/workspaces/{id}/capabilities', 'post', '检查执行主机或 Kubernetes 的可用能力', { type: 'object' }, configInput);
operation('/api/workspace-environments/{id}/stop', 'post', '暂停托管计算资源并保留数据，外部资源不停止', ref('WorkspaceEnvironment'));
operation('/api/workspace-environments/{id}/resume', 'post', '恢复已暂停实例，保持持久目录和分支', ref('WorkspaceEnvironment'));
operation('/api/workspace-environments/{id}/archive', 'post', '归档或取消归档实例，计算资源不变', ref('WorkspaceEnvironment'), { ...object({ archived: { type: 'boolean' } }), required: ['archived'] });
operation('/api/workspace-environments/{id}/git', 'get', '检查实例所属工作树的未提交和未推送改动', { type: 'object' });
operation('/api/workspace-environments/{id}/data', 'delete', '明确删除工作数据；默认拒绝未提交或未推送改动', ref('WorkspaceEnvironment'), { ...object({ confirm: { type: 'boolean', enum: [true] }, force: { type: 'boolean', default: false } }), required: ['confirm'] });

operation('/api/workspaces/{id}/preview', 'post', '只读预览 Agent 完整工作目录，不创建环境或目录', object({ environmentId: text, workRoot: text, directory: text, branch: text }), { ...object({ requestId, environmentId: text, config: ref('WorkspaceConfig'), worktreeName: { ...text, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$' } }), required: ['worktreeName'], description: '已有实例传 environmentId；新实例传 config 和与 workspace-launch 相同的 requestId。SSH 默认根目录通过只读连接解析远端 HOME。' });
