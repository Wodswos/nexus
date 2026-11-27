import { workspaceEnvironmentId, workspaceLaunchOperationId } from './identity';
import { createHash, randomUUID } from 'node:crypto';
import {
  validateWorkspaceConfig,
  EMPTY_WORKSPACE,
  type WorkspaceConfig,
  type WorkspaceEnvironment,
  type WorkspaceInstruction,
  type WorkspacePane,
  type WorkspaceAgent,
} from '../../../../packages/core/src/index';
import { DB } from '../db';
import { Connections, shellQuote, type SshConnection } from '../connections';
import { sshRun } from '../tmux';
import { gitStatusScript, parseGitState, deleteWorkspaceDataScript, type WorkspaceGitState } from './git';
import { KubernetesClient, kubernetesIdentity } from './kubernetes';
import { KubernetesConnections, KubernetesError } from './kubernetesConnections';
import { agentLaunchLine, BOOTSTRAP_READER, openSshTransport, type AgentTransport, type AgentTransportOptions } from './transport';
import { agentProxyEnvironment } from '../agentProxy';
import {
  bootstrapScript,
  createRuntimeCommand,
  deliveryCommand,
  environmentCommand,
  inspectResourceCommand,
  listResourcesCommand,
  PANES_COMMAND,
  parsePanes,
  resourceIdentity,
  stopRuntimeCommand,
  initializeWorkspaceLayout,
  pauseRuntimeCommand,
  linuxUserStopCommand,
  linuxUserRemoveCommand,
} from './runtime';

type SshRunner = typeof sshRun;
type TaskReader = (
  userId: string,
  taskId: string,
) => { config: WorkspaceConfig; title: string };
export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 | 429 | 502 = 400,
    readonly log?: string,
  ) {
    super(message);
  }
}
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new WorkspaceError('请求 ID 无效');
  return value;
}
const shellCommands = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ash',
  'ksh',
  'tcsh',
]);
function environmentKey(
  userId: string,
  environment: WorkspaceEnvironment,
): string {
  const { config } = environment;
  return JSON.stringify([
    userId,
    environment.connectionHost,
    config.runtime,
    config.runtime === 'ssh' ? environment.session : environment.resourceId,
    config.runtime === 'kubernetes'
      ? [config.context, config.namespace, environment.resourceUid]
      : null,
  ]);
}
export interface RemoteResource {
  id: string;
  name: string;
  image?: string;
}

export class WorkspaceService {
  private closed = false;
  private stopping = new Set<string>();
  private checking = new Set<string>();
  private active = new Map<
    string,
    {
      userId: string;
      target: string;
      environmentKey: string;
      abort: AbortController;
    }
  >();
  private agentOperations = new Map<string, { userId: string; environmentKey: string; abort: AbortController; transport?: AgentTransport }>();
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private db: DB,
    private connections: Pick<Connections, 'resolve'>,
    private readTask: TaskReader,
    private run: SshRunner = sshRun,
    private kubernetes?: KubernetesConnections,
  ) {
    db.recoverWorkspaceRecords();
    this.timer = setInterval(() => this.tick(), 400);
    this.timer.unref();
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const job of this.active.values()) job.abort.abort();
    for (const operation of this.agentOperations.values()) { operation.abort.abort(); operation.transport?.close(); }
  }
  private connection(userId: string, config: WorkspaceConfig): SshConnection {
    const connection = this.connections.resolve(userId, config.serverId);
    if (!connection) throw new WorkspaceError('控制主机的 SSH 连接不存在', 404);
    return connection;
  }
  private isDirect(config: WorkspaceConfig) { return config.runtime === 'kubernetes' && !!config.kubeConnectionId; }
  private cluster(userId: string, config: WorkspaceConfig) {
    const connection = this.kubernetes?.resolve(userId, config.kubeConnectionId ?? '');
    if (!connection) throw new WorkspaceError('Kubernetes 连接不存在', 404);
    return connection;
  }
  private connectionIdentity(userId: string, config: WorkspaceConfig) {
    return this.isDirect(config) ? kubernetesIdentity(this.cluster(userId, config)) : this.connection(userId, config).host;
  }
  private kubeClient(userId: string, environment: WorkspaceEnvironment) {
    const connection = this.cluster(userId, environment.config);
    if (kubernetesIdentity(connection) !== environment.connectionHost) throw new WorkspaceError('Kubernetes 连接目标或 CA 已变化，请重新关联环境', 409);
    return new KubernetesClient(connection);
  }
  private async inspect(userId: string, environment: WorkspaceEnvironment, signal?: AbortSignal) {
    if (this.isDirect(environment.config)) return JSON.stringify(await this.kubeClient(userId, environment).inspect(environment.config.namespace, environment.resourceId, userId, environment.resourceUid, signal));
    return this.execute(userId, environment, inspectResourceCommand(environment.config, environment.resourceId), undefined, signal);
  }
  private verifiedIdentities=new Map<string,number>();
  private async executeInside(userId: string, environment: WorkspaceEnvironment, command: string, input?: string, signal?: AbortSignal, timeoutMs = 12000): Promise<string> {
    await this.ensureExecutionIdentity(userId,environment);
    if (this.isDirect(environment.config)) return this.kubeClient(userId, environment).execute(environment, userId, command, input, signal, timeoutMs);
    return this.execute(userId, environment, environmentCommand(environment, command, input !== undefined), input, signal, timeoutMs);
  }
  async ensureExecutionIdentity(userId:string,environment:WorkspaceEnvironment):Promise<void> {
    if(environment.config.runtime!=='ssh')return;
    const cacheKey=`${userId}:${environment.config.serverId}:${environment.connectionHost}`;
    if(Date.now()-(this.verifiedIdentities.get(cacheKey)??0)<30000)return;
    const identity=await this.execute(userId,environment,"printf 'NEXUS_UID=%s\\n' \"$(id -u)\"; printf 'NEXUS_MACHINE='; cat /etc/machine-id 2>/dev/null || hostname");
    const uid=/^NEXUS_UID=(\d+)$/m.exec(identity)?.[1],machine=/^NEXUS_MACHINE=(.+)$/m.exec(identity)?.[1];
    if(!uid||!machine)throw new WorkspaceError('无法确认执行身份，未启动 Agent',409);
    if(!this.db.claimExecutionIdentity(fingerprint([machine.trim(),uid]),userId))throw new WorkspaceError('此执行用户已被另一个 Nexus 账号使用；请配置独立 SSH 用户或隔离的容器／Pod',409);
    this.verifiedIdentities.set(cacheKey,Date.now());
  }
  private acquireAgentOperation(userId: string, environment: WorkspaceEnvironment) {
    const key = environmentKey(userId, environment);
    if (this.closed || environment.state !== 'ready' || this.stopping.has(key)) throw new WorkspaceError('环境当前不可用', 409);
    if (this.agentOperations.size >= 64 || [...this.agentOperations.values()].filter((value) => value.userId === userId).length >= 12) throw new WorkspaceError('Agent 连接数已达到上限', 429);
    const id = randomUUID(), operation = { userId, environmentKey: key, abort: new AbortController(), transport: undefined as AgentTransport | undefined };
    this.agentOperations.set(id, operation);
    return { id, operation };
  }
  async executeInEnvironment(userId: string, id: string, command: string, input?: string, signal?: AbortSignal, timeoutMs = 12000): Promise<string> {
    const environment = this.environment(userId, id);

    const lease = this.acquireAgentOperation(userId, environment);
    try { return await this.executeInside(userId, environment, command, input, signal ? AbortSignal.any([signal, lease.operation.abort.signal]) : lease.operation.abort.signal, timeoutMs); }
    finally { this.agentOperations.delete(lease.id); }
  }
  agentProxyEnvironment(userId: string, environment: WorkspaceEnvironment): Record<string, string> {
    // Loopback on Docker/Pod is a different network namespace, so do not inherit host proxies there.
    if (!['ssh', 'linux-user'].includes(environment.config.runtime)) return {};
    return agentProxyEnvironment(this.connection(userId, environment.config).agentProxy, process.env.PUBLIC_ORIGIN);
  }
  async openAgentTransport(userId: string, id: string, command: string, options: AgentTransportOptions = {}): Promise<AgentTransport> {
    const environment = this.environment(userId, id);

    await this.ensureExecutionIdentity(userId,environment);
    const launch = agentLaunchLine(command, { ...options, env: { ...this.agentProxyEnvironment(userId, environment), ...options.env }, directory: options.directory || environment.directory || undefined }, ['ssh', 'linux-user'].includes(environment.config.runtime) ? (environment.credentialFile || environment.config.secretRef) : undefined);
    const lease = this.acquireAgentOperation(userId, environment);
    const signal = options.signal ? AbortSignal.any([options.signal, lease.operation.abort.signal]) : lease.operation.abort.signal;
    try {
      let transport: AgentTransport;
      if (this.isDirect(environment.config)) transport = await this.kubeClient(userId, environment).open(environment, userId, ['sh', '-c', BOOTSTRAP_READER], signal);
      else {
        const connection = this.connection(userId, environment.config);
        if (connection.host !== environment.connectionHost) throw new WorkspaceError('SSH 连接目标已变化，请重新关联环境', 409);
        transport = openSshTransport(connection, environmentCommand(environment, BOOTSTRAP_READER, true), signal);
      }
      lease.operation.transport = transport;
      void transport.closed.finally(() => this.agentOperations.delete(lease.id));
      transport.stdin.write(launch);
      return transport;
    } catch (error) { lease.operation.abort.abort(); this.agentOperations.delete(lease.id); throw error; }
  }
  /** Interactive attachment is account-scoped and does not own or terminate the pane. */
  async openTerminalTransport(userId: string, id: string, paneId: string, cols: number, rows: number, signal?: AbortSignal): Promise<AgentTransport> {
    const environment = this.environment(userId, id);

    const pane = (await this.panes(userId, id)).find(value => value.id === paneId && !value.dead);
    if (!pane) throw new WorkspaceError('目标 pane 不属于此工作环境或已退出', 404);
    const lease = this.acquireAgentOperation(userId, environment);
    const abort = signal ? AbortSignal.any([signal, lease.operation.abort.signal]) : lease.operation.abort.signal;
    const width = Math.floor(Math.max(20, Math.min(500, cols || 120))), height = Math.floor(Math.max(5, Math.min(300, rows || 36)));
    // attach-session accepts a pane target and selects its window as well.
    // select-pane + a session target can otherwise show the session's old window.
    const command = `test "$(tmux display-message -p -t ${shellQuote(pane.id)} '#{pane_pid} #{pid}')" = ${shellQuote(`${pane.pid} ${pane.serverPid}`)} && export TERM=xterm-256color && stty rows ${height} cols ${width} && exec tmux attach-session -t ${shellQuote(pane.id)}`;
    try {
      let transport: AgentTransport;
      if (this.isDirect(environment.config)) transport = await this.kubeClient(userId, environment).open(environment, userId, ['sh', '-c', command], abort, true);
      else {
        const connection = this.connection(userId, environment.config);
        if (connection.host !== environment.connectionHost) throw new WorkspaceError('SSH 连接目标已变化', 409);
        transport = openSshTransport(connection, environmentCommand(environment, command, true, true), abort, true);
      }
      lease.operation.transport = transport;
      void transport.closed.finally(() => this.agentOperations.delete(lease.id));
      return transport;
    } catch (error) { lease.operation.abort.abort(); this.agentOperations.delete(lease.id); throw error; }
  }
  private async execute(
    userId: string,
    environment: WorkspaceEnvironment,
    command: string,
    input?: string,
    signal?: AbortSignal,
    timeoutMs = 12000,
  ): Promise<string> {
    const connection = this.connection(userId, environment.config);
    if (connection.host !== environment.connectionHost)
      throw new WorkspaceError('SSH 连接目标已变化，请重新关联环境', 409);
    const result = await this.run(connection, command, {
      input,
      signal,
      timeoutMs,
    });
    if (result.code)
      throw new WorkspaceError(
        result.stderr || `远端执行失败，退出码 ${result.code}`,
        502,
        result.stdout.slice(-32000),
      );
    return result.stdout;
  }
  private config(
    userId: string,
    taskId: string,
    supplied?: WorkspaceConfig,
  ): WorkspaceConfig {
    const current = this.readTask(userId, taskId);
    const config = supplied ?? current.config;
    validateWorkspaceConfig(config);
    const normalized = { ...EMPTY_WORKSPACE, ...config };
    if (this.isDirect(config)) normalized.namespace ||= this.cluster(userId, config).namespace;
    this.connectionIdentity(userId, normalized);
    return structuredClone(normalized);
  }
  overview(userId: string, taskId: string, config: WorkspaceConfig) {
    const environments = this.db
      .workspaceRecords<WorkspaceEnvironment>(userId, 'environment')
      .filter(
        (environment) =>
          environment.taskId === taskId ||
          (environment.config.serverId === config.serverId &&
            environment.config.runtime === config.runtime &&
            (environment.config.kubeConnectionId ?? '') === (config.kubeConnectionId ?? '')),
      );
    const instructions = this.db
      .workspaceRecords<WorkspaceInstruction>(userId, 'instruction')
      .filter((instruction) => instruction.taskId === taskId)
      .slice(0, 100);
    return { environments, instructions };
  }
  environment(userId: string, id: string): WorkspaceEnvironment {
    const environment = this.db.workspaceRecord<WorkspaceEnvironment>(
      userId,
      'environment',
      id,
    );
    if (!environment) throw new WorkspaceError('环境不存在', 404);
    return environment;
  }
  /** Read only: resolves the same execution-side root used when starting an Agent. */
  async agentWorkRoot(userId: string, environment: WorkspaceEnvironment, signal?: AbortSignal): Promise<string> {
    if (environment.workRoot) return environment.workRoot;
    const config = environment.config;
    if (config.workRoot) return `${config.workRoot.replace(/\/$/, '')}/${environment.id}`;
    if (!['ssh', 'linux-user'].includes(config.runtime)) return `/workspace/${environment.id}`;
    const output = await this.executeInEnvironment(userId, environment.id, 'sh -s', `set -eu\nprintf 'NEXUS_HOME=%s\\n' "\${HOME:?}"\n`, signal, 12000);
    return `${this.homeFromOutput(output)}/.local/share/nexus/workspaces/${environment.id}`;
  }
  private homeFromOutput(output: string): string {
    const home = /^NEXUS_HOME=(.+)$/m.exec(output)?.[1];
    if (!home?.startsWith('/') || /[\0\r\n]/.test(home)) throw new WorkspaceError('无法确定远端用户目录，请配置 Workspace 持久化工作根目录');
    return home.replace(/\/$/, '');
  }
  async preview(userId: string, taskId: string, input: Record<string, unknown>) {
    this.readTask(userId, taskId);
    if (Object.keys(input).some(key => !['requestId', 'environmentId', 'config', 'worktreeName'].includes(key))) throw new WorkspaceError('路径预览包含未知字段');
    if (typeof input.worktreeName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(input.worktreeName)) throw new WorkspaceError('worktree 名称无效');
    let id: string, workRoot: string;
    if (input.environmentId !== undefined) {
      if (typeof input.environmentId !== 'string') throw new WorkspaceError('Workspace ID 无效');
      const environment = this.environment(userId, input.environmentId);
      if (environment.archivedAt || environment.dataDeletedAt || environment.dataClearedAt || !['ready','queued','preparing'].includes(environment.state)) throw new WorkspaceError('所选 Workspace 当前不可用', 409);
      id = environment.id;
      workRoot = await this.agentWorkRoot(userId, environment);
    } else {
      const config = this.config(userId, taskId, input.config as WorkspaceConfig | undefined);
      const key = workspaceLaunchOperationId(taskId, requestId(input.requestId));
      const previous = this.db.workspaceRequest<WorkspaceEnvironment>(userId, 'environment', key);
      if (previous) {
        id = previous.value.id;
        workRoot = await this.agentWorkRoot(userId, previous.value);
      } else {
        id = workspaceEnvironmentId(userId, taskId, key);
        const transient = { id, config } as WorkspaceEnvironment;
        initializeWorkspaceLayout(transient);
        workRoot = transient.workRoot || '';
        if (!workRoot) {
          const result = await this.run(this.connection(userId, config), 'sh -s', { input: `set -eu\nprintf 'NEXUS_HOME=%s\\n' "\${HOME:?}"\n`, timeoutMs: 12000 });
          if (result.code) throw new WorkspaceError('无法读取远端用户目录，请检查 SSH 连接', 502);
          workRoot = `${this.homeFromOutput(result.stdout)}/.local/share/nexus/workspaces/${id}`;
        }
      }
    }
    return { environmentId: id, workRoot, directory: `${workRoot.replace(/\/$/, '')}/nexus-agent/${input.worktreeName}`, branch: `nexus-agent/${input.worktreeName}` };
  }
  create(
    userId: string,
    taskId: string,
    key: unknown,
    supplied?: WorkspaceConfig,
    metadata?: { name?: string; workspaceId?: string },
  ): WorkspaceEnvironment {
    const config = this.config(userId, taskId, supplied);
    const requestKey = requestId(key),
      digest = fingerprint({ taskId, config, ...(metadata ? { metadata } : {}) });
    if (metadata?.name !== undefined && (!metadata.name.trim() || metadata.name.length > 120 || /[\0\r\n]/.test(metadata.name))) throw new WorkspaceError('Workspace 名称需要 1–120 个字符');
    const existing = this.db.workspaceRequest<WorkspaceEnvironment>(
      userId,
      'environment',
      requestKey,
    );
    if (existing) {
      if (existing.fingerprint !== digest)
        throw new WorkspaceError('同一请求 ID 对应的配置已变化', 409);
      return existing.value;
    }
    if (this.db.pendingWorkspaceCount(userId, 'environment') >= 10)
      throw new WorkspaceError('环境准备队列已满，请等待已有任务结束', 429);
    const id = workspaceEnvironmentId(userId, taskId, requestKey),
      time = Date.now();
    const environment: WorkspaceEnvironment = {
      id,
      taskId,
      config,
      connectionHost: this.connectionIdentity(userId, config),
      state: 'queued',
      managed: true,
      resourceId: config.runtime === 'ssh' ? '' : `nexus-${id}`,
      session: `nexus-${id.replaceAll('-', '').slice(0, 16)}`,
      directory: config.directory,
      createdAt: time,
      updatedAt: time,
      name: metadata?.name?.trim() || `${this.readTask(userId, taskId).title} · ${id.slice(0, 8)}`,
      ...(metadata?.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
    };
    initializeWorkspaceLayout(environment);
    this.db.saveWorkspaceRecord(
      userId,
      'environment',
      environment,
      requestKey,
      digest,
    );
    void this.tick();
    return environment;
  }
  async discover(
    userId: string,
    taskId: string,
    supplied?: WorkspaceConfig,
  ): Promise<RemoteResource[]> {
    const config = this.config(userId, taskId, supplied);
    if (config.runtime === 'linux-user') return [];
    if (this.isDirect(config)) return new KubernetesClient(this.cluster(userId, config)).pods(config.namespace, userId);
    const result = await this.run(
      this.connection(userId, config),
      listResourcesCommand(config),
      { timeoutMs: 12000 },
    );
    if (
      config.runtime === 'ssh' &&
      result.code &&
      /no server running|no sessions|failed to connect to server/.test(
        result.stderr,
      )
    )
      return [];
    if (result.code)
      throw new WorkspaceError(result.stderr || '环境列表读取失败', 502);
    if (config.runtime === 'ssh')
      return result.stdout
        .split('\n')
        .filter(Boolean)
        .map((session) => ({ id: session, name: session }));
    if (config.runtime === 'docker')
      return result.stdout
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          const row = JSON.parse(line),
            owner = /(?:^|,)nexus.owner=([^,]+)/.exec(row.Labels ?? '')?.[1];
          return owner && owner !== userId
            ? []
            : [
                {
                  id: String(row.ID),
                  name: String(row.Names),
                  image: String(row.Image),
                },
              ];
        });
    return (JSON.parse(result.stdout).items ?? [])
      .filter(
        (row: any) =>
          row.status?.phase === 'Running' &&
          (!row.metadata?.labels?.['nexus.owner'] ||
            row.metadata.labels['nexus.owner'] === userId),
      )
      .map((row: any) => ({
        id: String(row.metadata.name),
        name: String(row.metadata.name),
        image: String(row.spec?.containers?.[0]?.image ?? ''),
      }));
  }
  async attach(
    userId: string,
    taskId: string,
    resource: unknown,
    key: unknown,
    supplied?: WorkspaceConfig,
  ): Promise<WorkspaceEnvironment> {
    const config = this.config(userId, taskId, supplied);
    if (config.runtime === 'linux-user') throw new WorkspaceError('Linux 独立用户需要创建新实例，不能接管已有系统用户');
    if (
      typeof resource !== 'string' ||
      !resource ||
      resource.length > 256 ||
      resource.includes('\0')
    )
      throw new WorkspaceError('请选择已有环境');
    const requestKey = requestId(key),
      digest = fingerprint({ taskId, config, resource });
    const previous = this.db.workspaceRequest<WorkspaceEnvironment>(
      userId,
      'environment',
      requestKey,
    );
    if (previous) {
      if (previous.fingerprint !== digest)
        throw new WorkspaceError('请求内容已变化', 409);
      return previous.value;
    }
    const time = Date.now();
    const environment: WorkspaceEnvironment = {
      id: randomUUID(),
      taskId,
      config,
      connectionHost: this.connectionIdentity(userId, config),
      state: 'ready',
      managed: false,
      resourceId: config.runtime === 'ssh' ? '' : resource,
      session: config.runtime === 'ssh' ? resource : '',
      directory: config.directory,
      createdAt: time,
      updatedAt: time,
    };
    if (config.runtime !== 'ssh') {
      const result = await this.inspect(userId, environment);
      const identity = resourceIdentity(config, result, userId);
      environment.resourceId = identity.id;
      environment.resourceUid = identity.uid;
    }
    const panes = await this.panes(userId, environment);
    if (!panes.length)
      throw new WorkspaceError(
        '所选环境中没有可用的 tmux pane，请先启动 tmux／Agent',
      );
    if (!environment.directory) environment.directory = panes[0]!.directory;
    // Concurrent duplicate requests can arrive while the remote inspection is in flight.
    const raced = this.db.workspaceRequest<WorkspaceEnvironment>(
      userId,
      'environment',
      requestKey,
    );
    if (raced) {
      if (raced.fingerprint !== digest)
        throw new WorkspaceError('请求内容已变化', 409);
      return raced.value;
    }
    this.db.saveWorkspaceRecord(
      userId,
      'environment',
      environment,
      requestKey,
      digest,
    );
    return environment;
  }
  async panes(
    userId: string,
    value: WorkspaceEnvironment | string,
  ): Promise<WorkspacePane[]> {
    const environment =
      typeof value === 'string' ? this.environment(userId, value) : value;
    if (environment.state === 'stopped') return [];
    const output = await this.executeInside(userId, environment, environment.config.terminalPolicy==='on-demand' ? `if command -v tmux >/dev/null && tmux list-sessions >/dev/null 2>&1; then ${PANES_COMMAND}; fi` : PANES_COMMAND);
    return parsePanes(output).filter(
      (pane) =>
        environment.config.runtime !== 'ssh' ||
        !environment.session ||
        pane.session === environment.session ||
        this.db.agentRecords<import('../../../../packages/core/src/index').WorkspaceAgent>(userId).some(agent=>agent.environmentId===environment.id && (agent.terminalPanes??(agent.terminalPane?[agent.terminalPane]:[])).some(saved=>saved.id===pane.id && saved.pid===pane.pid && saved.serverPid===pane.serverPid)),
    );
  }
  async capture(userId: string, id: string, paneId: string, expected?: Pick<WorkspacePane, 'pid' | 'serverPid'>): Promise<string> {
    const environment = this.environment(userId, id);
    const pane = (await this.panes(userId, environment)).find(
      (value) => value.id === paneId,
    );
    if (!pane) throw new WorkspaceError('pane 已变化，请刷新会话列表', 404);
    if (expected && (pane.dead || pane.pid !== expected.pid || pane.serverPid !== expected.serverPid)) throw new WorkspaceError('Agent pane 已变化，请重新关联', 409);
    const command = `${expected ? `test \"$(tmux display-message -p -t ${shellQuote(pane.id)} '#{pane_pid} #{pid}')\" = ${shellQuote(`${expected.pid} ${expected.serverPid}`)} && ` : ''}tmux capture-pane -p -S -200 -t ${shellQuote(pane.id)}`;
    return this.executeInside(userId, environment, command);
  }
  send(
    userId: string,
    taskId: string,
    body: {
      requestId: unknown;
      environmentId: string;
      pane: WorkspacePane;
      text: string;
      submit?: boolean;
      terminalInput?: boolean;
    },
  ): WorkspaceInstruction {
    this.readTask(userId, taskId);
    const environment = this.environment(userId, body.environmentId);
    if (environment.state !== 'ready')
      throw new WorkspaceError('请先选择可用环境');
    if (
      typeof body.text !== 'string' ||
      !body.text.trim() ||
      Buffer.byteLength(body.text) > 32000 ||
      body.text.includes('\0')
    )
      throw new WorkspaceError('请输入指令，最多 32000 字节');
    if (
      !body.pane ||
      !/^%\d+$/.test(body.pane.id) ||
      !Number.isSafeInteger(body.pane.pid) ||
      !Number.isSafeInteger(body.pane.serverPid)
    )
      throw new WorkspaceError('请选择具体的 tmux pane');
    const requestKey = requestId(body.requestId);
    const request = {
      taskId,
      environmentId: body.environmentId,
      pane: body.pane,
      text: body.text,
      submit: body.submit === true,
      terminalInput: body.terminalInput === true,
    };
    const digest = fingerprint(request),
      old = this.db.workspaceRequest<WorkspaceInstruction>(
        userId,
        'instruction',
        requestKey,
      );
    if (old) {
      if (old.fingerprint !== digest)
        throw new WorkspaceError('指令请求 ID 已用于其他内容', 409);
      return old.value;
    }
    if (this.db.pendingWorkspaceCount(userId, 'instruction') >= 50)
      throw new WorkspaceError('指令队列已满，请等待投递完成', 429);
    const time = Date.now();
    const instruction: WorkspaceInstruction = {
      ...request,
      id: randomUUID(),
      state: 'queued',
      createdAt: time,
      updatedAt: time,
    };
    this.db.saveWorkspaceRecord(
      userId,
      'instruction',
      instruction,
      requestKey,
      digest,
    );
    void this.tick();
    return instruction;
  }
  async check(userId: string, id: string): Promise<WorkspaceEnvironment> {
    const environment = this.environment(userId, id);
    const key = environmentKey(userId, environment);
    if (this.stopping.has(key) || this.checking.has(key))
      throw new WorkspaceError('环境正在执行操作，请稍后检查', 409);
    if (['queued', 'preparing', 'stopped'].includes(environment.state))
      throw new WorkspaceError('当前环境状态不能检查');
    this.checking.add(key);
    try {
      if (!['ssh', 'linux-user'].includes(environment.config.runtime)) {
        const output = await this.inspect(userId, environment);
        const identity = resourceIdentity(environment.config, output, userId);
        if (environment.resourceUid && identity.uid !== environment.resourceUid)
          throw new WorkspaceError('Pod 已被替换，请重新关联');
      }
      const panes = environment.config.terminalPolicy==='on-demand' ? [] : await this.panes(userId, environment);
      if (environment.config.terminalPolicy==='on-demand') await this.executeInside(userId,environment,`test -d ${shellQuote(environment.directory)}`);
      if (environment.config.terminalPolicy!=='on-demand' && !panes.length) throw new WorkspaceError('环境中没有对应的 tmux 会话');
      Object.assign(environment, {
        state: 'ready',
        directory: panes[0]?.directory || environment.directory,
        error: undefined,
        updatedAt: Date.now(),
      });
      this.db.saveWorkspaceRecord(userId, 'environment', environment);
      return environment;
    } finally {
      this.checking.delete(key);
    }
  }
  retry(userId: string, id: string): WorkspaceEnvironment {
    const environment = this.environment(userId, id);
    this.assertNoAgents(userId, environment);
    const key = environmentKey(userId, environment);
    if (this.stopping.has(key) || this.checking.has(key))
      throw new WorkspaceError('环境正在执行操作', 409);
    if (
      !environment.managed || environment.dataClearedAt ||
      !['failed', 'unknown'].includes(environment.state)
    )
      throw new WorkspaceError('当前环境不能重新准备');
    if (this.active.has(`environment:${id}`))
      throw new WorkspaceError('环境准备仍在退出，请稍后再试', 409);
    Object.assign(environment, {
      state: 'queued',
      error: undefined,
      updatedAt: Date.now(),
    });
    this.db.saveWorkspaceRecord(userId, 'environment', environment);
    void this.tick();
    return environment;
  }
  async stop(userId: string, id: string): Promise<WorkspaceEnvironment> {
    const environment = this.environment(userId, id);
    const key = environmentKey(userId, environment);
    if (environment.state === 'stopped') return environment;
    if (environment.managed && ['docker', 'kubernetes'].includes(environment.config.runtime) && (!environment.storage || environment.storage.kind === 'ephemeral') && !environment.dataDeletedAt)
      throw new WorkspaceError('此实例的数据尚未持久化，请先备份并通过删除数据操作明确确认，或只暂停 Docker 容器', 409);
    if (this.db.agentRecords<WorkspaceAgent & {persistentHost?:boolean}>(userId).some((agent) => agent.environmentId === id && (agent.persistentHost ? agent.state!=='stopped' : !['stopped', 'failed', 'disconnected', 'interrupted'].includes(agent.state))))
      throw new WorkspaceError('请先结束此环境中的 Agent', 409);
    if (this.stopping.has(key) || this.checking.has(key))
      throw new WorkspaceError('环境正在执行操作', 409);
    if (
      this.active.has(`environment:${id}`) ||
      [...this.active.values()].some((job) => job.environmentKey === key) ||
      [...this.agentOperations.values()].some((job) => job.environmentKey === key)
    )
      throw new WorkspaceError(
        '环境仍在执行操作或有 Agent 连接，请先结束 Agent 再结束环境',
        409,
      );
    const queued = environment.state === 'queued' && !environment.startedAt;
    this.stopping.add(key);
    Object.assign(environment, {
      state: 'unknown',
      error: '正在结束环境',
      updatedAt: Date.now(),
    });
    this.db.saveWorkspaceRecord(userId, 'environment', environment);
    try {
      if (environment.managed && !queued) {
        await this.stopManagedTerminals(userId,environment);
        if (!['ssh', 'linux-user'].includes(environment.config.runtime)) {
          const output = await this.inspect(userId, environment);
          const identity = resourceIdentity(environment.config, output, userId, true);
          if (
            environment.resourceUid &&
            identity.uid !== environment.resourceUid
          )
            throw new WorkspaceError('Pod 已被替换，请重新核对环境');
          environment.resourceUid ??= identity.uid;
        }
        if (this.isDirect(environment.config)) await this.kubeClient(userId, environment).delete(environment, userId);
        else if (environment.config.runtime === 'linux-user') await this.execute(userId, environment, linuxUserStopCommand(environment));
        else await this.execute(userId, environment, stopRuntimeCommand(environment));
      }
      Object.assign(environment, {
        state: 'stopped',
        error: undefined,
        updatedAt: Date.now(),
      });
      this.db.saveWorkspaceRecord(userId, 'environment', environment);
      return environment;
    } catch (reason) {
      const missing = (this.isDirect(environment.config) && reason instanceof KubernetesError && reason.status === 404) || (
        reason instanceof WorkspaceError &&
        reason.status === 502 &&
        ((environment.config.runtime === 'docker' &&
          /No such (object|container)/i.test(reason.message)) ||
          (environment.config.runtime === 'kubernetes' &&
            /\(NotFound\).*pods? .*not found/i.test(reason.message)) ||
          (environment.config.runtime === 'ssh' &&
            /can't find session|no server running|no sessions|failed to connect to server/i.test(
              reason.message,
            ))));
      if (missing) {
        Object.assign(environment, {
          state: 'stopped',
          error: undefined,
          updatedAt: Date.now(),
        });
        this.db.saveWorkspaceRecord(userId, 'environment', environment);
        return environment;
      }
      environment.error =
        reason instanceof Error ? reason.message : '环境结束结果需要核对';
      environment.updatedAt = Date.now();
      this.db.saveWorkspaceRecord(userId, 'environment', environment);
      throw reason;
    } finally {
      this.stopping.delete(key);
    }
  }
  list(userId: string): WorkspaceEnvironment[] {
    return this.db.workspaceRecords<WorkspaceEnvironment>(userId, 'environment');
  }
  archive(userId: string, id: string, archived: boolean): WorkspaceEnvironment {
    const environment = this.environment(userId, id);
    environment.archivedAt = archived ? Date.now() : null;
    environment.updatedAt = Date.now();
    this.db.saveWorkspaceRecord(userId, 'environment', environment);
    return environment;
  }
  async cleanupPlan(userId:string,id:string){
    const environment=this.environment(userId,id),agents=this.db.agentRecords<WorkspaceAgent>(userId).filter(agent=>agent.environmentId===id),bindings=this.db.agentRuntime.bindings(userId).filter(binding=>binding.environmentId===id);
    let git:Awaited<ReturnType<WorkspaceService['gitState']>>|undefined,inspectionError:string|undefined;
    try{git=await this.gitState(userId,id);}catch(error){inspectionError=error instanceof Error?error.message:'未能检查仓库';}
    return {terminals:agents.flatMap(a=>a.terminalPanes??(a.terminalPane?[a.terminalPane]:[])).map(p=>({id:p.id,session:p.session})),environmentId:id,managed:environment.managed,taskIds:[...new Set([environment.taskId,...bindings.map(b=>b.taskId),...agents.map(a=>a.taskId)])],agents:agents.map(a=>({id:a.id,name:a.name,state:a.state,directory:a.directory})),git,inspectionError,storage:environment.storage,dataRetained:environment.config.storage!=='ephemeral'};
  }
  private async stopManagedTerminals(userId:string,environment:WorkspaceEnvironment) {
    if(environment.config.runtime!=='ssh')return;
    for(const agent of this.db.agentRecords<WorkspaceAgent>(userId).filter(agent=>agent.environmentId===environment.id)) {
      const panes=agent.terminalPanes??(agent.terminalPane?[agent.terminalPane]:[]);
      for(const pane of panes) await this.executeInside(userId,environment,[
        'set -eu',
        `if command -v tmux >/dev/null && tmux has-session -t ${shellQuote('='+pane.session)} 2>/dev/null; then`,
        `test "$(tmux display-message -p -t ${shellQuote(pane.id)} '#{pane_pid} #{pid}')" = ${shellQuote(`${pane.pid} ${pane.serverPid}`)}`,
        `test "$(tmux show-option -qv -t ${shellQuote('='+pane.session)} @nexus_agent)" = ${shellQuote(agent.id)}`,
        `tmux kill-session -t ${shellQuote('='+pane.session)}`,
        'fi'
      ].join('\n'));
      if(panes.length){agent.terminalPanes=[];agent.terminalPane=undefined;this.db.saveAgentRecord(userId,agent);}
    }
  }
  private assertNoAgents(userId: string, environment: WorkspaceEnvironment) {
    const key = environmentKey(userId, environment);
    if (this.db.agentRecords<WorkspaceAgent & {persistentHost?:boolean}>(userId).some((agent) => agent.environmentId === environment.id && (agent.persistentHost ? agent.state!=='stopped' : !['stopped', 'failed', 'disconnected', 'interrupted'].includes(agent.state))) || [...this.agentOperations.values()].some((job) => job.environmentKey === key)) throw new WorkspaceError('请先结束此环境中的 Agent', 409);
    if (this.stopping.has(key) || this.checking.has(key) || [...this.active.values()].some((job) => job.environmentKey === key)) throw new WorkspaceError('环境仍在执行操作', 409);
  }
  async pause(userId: string, id: string): Promise<WorkspaceEnvironment> {
    const environment = this.environment(userId, id);
    if (!environment.managed) throw new WorkspaceError('复用环境只能解除关联，不会停止外部资源', 409);
    if (environment.state === 'paused') return environment;
    if (environment.state !== 'ready') throw new WorkspaceError('只有运行中的环境可以暂停', 409);
    this.assertNoAgents(userId, environment);
    if (environment.config.runtime === 'kubernetes' && environment.storage?.kind !== 'pvc') throw new WorkspaceError('此 Pod 没有持久 PVC，暂停会丢失数据；请先备份并明确销毁', 409);
    const key = environmentKey(userId, environment); this.stopping.add(key);
    try {
      await this.stopManagedTerminals(userId,environment);
      if (this.isDirect(environment.config)) await this.kubeClient(userId, environment).delete(environment, userId);
      else await this.execute(userId, environment, environment.config.runtime === 'linux-user' ? linuxUserStopCommand(environment) : pauseRuntimeCommand(environment));
      environment.state = 'paused'; environment.error = undefined; environment.updatedAt = Date.now();
      if (environment.config.runtime === 'kubernetes') environment.resourceUid = undefined;
      this.db.saveWorkspaceRecord(userId, 'environment', environment);
      return environment;
    } finally { this.stopping.delete(key); }
  }
  resume(userId: string, id: string): WorkspaceEnvironment {
    const environment = this.environment(userId, id);
    if (!environment.managed || environment.state !== 'paused' || environment.dataDeletedAt || environment.dataClearedAt) throw new WorkspaceError('只有保留数据的已暂停实例可以恢复', 409);
    this.assertNoAgents(userId, environment);

    environment.state = 'queued'; environment.error = undefined; environment.updatedAt = Date.now();
    this.db.saveWorkspaceRecord(userId, 'environment', environment); void this.tick(); return environment;
  }
  async capabilities(userId: string, taskId: string, supplied?: WorkspaceConfig) {
    const config = this.config(userId, taskId, supplied);
    if (this.isDirect(config)) {
      await new KubernetesClient(this.cluster(userId, config)).pods(config.namespace, userId);
      return { runtime: config.runtime, available: true, tools: { kubernetes: true }, notes: ['已验证 Pods 列表权限；创建时继续验证 Pod/PVC/exec 权限与镜像工具'] };
    }
    const command = 'for tool in git tmux docker kubectl sudo useradd userdel getent realpath stat pkill prlimit; do if command -v "$tool" >/dev/null 2>&1; then printf "%s=1\\n" "$tool"; else printf "%s=0\\n" "$tool"; fi; done; if sudo -n true 2>/dev/null; then printf "sudo_noninteractive=1\\n"; else printf "sudo_noninteractive=0\\n"; fi';
    const result = await this.run(this.connection(userId, config), command, { timeoutMs: 12000 });
    if (result.code) throw new WorkspaceError('主机能力检查失败', 502);
    const tools = Object.fromEntries(result.stdout.trim().split('\n').map((line) => { const [name, value] = line.split('='); return [name, value === '1']; }));
    const needed = config.runtime === 'linux-user' ? ['git','tmux','sudo','sudo_noninteractive','useradd','userdel','getent','realpath','stat','pkill','prlimit'] : config.runtime === 'docker' ? ['docker'] : config.runtime === 'kubernetes' ? ['kubectl'] : ['tmux', ...(config.repository || config.localRepository ? ['git'] : [])];
    return { runtime: config.runtime, available: needed.every((name) => tools[name]), tools, missing: needed.filter((name) => !tools[name]) };
  }
  private async withDataAccess<T>(userId: string, environment: WorkspaceEnvironment, operation: () => Promise<T>): Promise<T> {
    if (['ssh','linux-user'].includes(environment.config.runtime) || environment.state === 'ready') return operation();
    const pausedDocker = environment.config.runtime === 'docker' && environment.state === 'paused';
    if (!pausedDocker && (!environment.storage || environment.storage.kind === 'ephemeral')) throw new WorkspaceError('环境未运行且没有可重新挂载的持久存储，请先恢复或明确放弃数据', 409);
    const originalId = environment.resourceId, originalUid = environment.resourceUid;
    const helperName = `nexus-check-${randomUUID().replaceAll('-', '')}`;
    let acquired = false, helperAttempted = false;
    try {
      if (pausedDocker) {
        resourceIdentity(environment.config, await this.inspect(userId, environment), userId, true);
        await this.execute(userId, environment, `docker start ${shellQuote(environment.resourceId)}`);
        acquired = true;
      } else if (this.isDirect(environment.config)) {
        environment.resourceId = helperName; environment.resourceUid = undefined; helperAttempted = true;
        const pod = await this.kubeClient(userId, environment).prepare(environment, userId);
        environment.resourceUid = pod.metadata.uid; acquired = true;
      } else {
        environment.resourceId = helperName; environment.resourceUid = undefined; helperAttempted = true;
        const create = createRuntimeCommand(environment, userId);
        if (create) await this.execute(userId, environment, 'sh -s', create, undefined, 300000);
        const identity = resourceIdentity(environment.config, await this.inspect(userId, environment), userId);
        environment.resourceId = identity.id; environment.resourceUid = identity.uid; acquired = true;
      }
      return await operation();
    } finally {
      try {
        if (helperAttempted && !acquired) {
          try {
            const inspected = await this.inspect(userId, environment);
            const identity = resourceIdentity(environment.config, inspected, userId, true);
            const metadata = JSON.parse(inspected);
            const labels = environment.config.runtime === 'docker' ? metadata[0]?.Config?.Labels : metadata.metadata?.labels;
            if (labels?.['nexus.owner'] === userId && labels?.['nexus.environment'] === environment.id) { environment.resourceId = identity.id; environment.resourceUid = identity.uid; acquired = true; }
          } catch { /* A failed inspection cannot authorize deletion. The unique name remains in the thrown diagnostic. */ }
        }
        if (acquired) {
          if (this.isDirect(environment.config)) await this.kubeClient(userId, environment).delete(environment, userId);
          else await this.execute(userId, environment, pausedDocker ? pauseRuntimeCommand(environment) : stopRuntimeCommand(environment));
        }
      } finally { environment.resourceId = originalId; environment.resourceUid = originalUid; }
    }
  }
  async gitState(userId: string, id: string): Promise<WorkspaceGitState> {
    const environment = this.environment(userId, id), key = environmentKey(userId, environment);
    if (this.stopping.has(key) || this.checking.has(key)) throw new WorkspaceError('环境正在执行操作', 409);
    if (['queued','preparing'].includes(environment.state) || environment.dataDeletedAt || environment.dataClearedAt) throw new WorkspaceError('此环境当前不能检查 Git 数据', 409);
    this.checking.add(key);
    try { return await this.withDataAccess(userId, environment, async () => parseGitState(await this.executeInside(userId, environment, 'sh -s', gitStatusScript(environment), undefined, 30000))); }
    finally { this.checking.delete(key); }
  }
  async deleteData(userId: string, id: string, confirm: boolean, force = false): Promise<WorkspaceEnvironment> {
    const environment = this.environment(userId, id);
    if (!confirm) throw new WorkspaceError('删除数据需要明确确认', 400);
    if (!environment.managed) throw new WorkspaceError('外部环境的数据不由 Nexus 删除', 409);
    if (environment.dataDeletedAt) return environment;
    if (!environment.layoutVersion && ['ssh','linux-user'].includes(environment.config.runtime)) throw new WorkspaceError('旧主机环境没有受管目录标记，请手动核对和清理数据', 409);
    this.assertNoAgents(userId, environment);
    if (['queued','preparing'].includes(environment.state)) throw new WorkspaceError('请先等待环境操作完成', 409);
    const key = environmentKey(userId, environment); this.stopping.add(key);
    try {
      if (!environment.dataClearedAt) await this.withDataAccess(userId, environment, async () => {
        let state: WorkspaceGitState;
        try { state = parseGitState(await this.executeInside(userId, environment, 'sh -s', gitStatusScript(environment), undefined, 30000)); }
        catch (error) { if (!force) throw error; state = { repository: false, dirty: true, unpushed: true, trees: [] }; }
        if (!force && (state.dirty || state.unpushed)) throw new WorkspaceError('存在未提交或未推送的更改。请先保存，或明确选择强制删除数据', 409);
        if (environment.config.runtime === 'linux-user') await this.execute(userId, environment, linuxUserStopCommand(environment));
        if (environment.layoutVersion === 2 && environment.workRoot) await this.executeInside(userId, environment, 'sh -s', deleteWorkspaceDataScript(environment, force), undefined, 120000);
        else if (!force) throw new WorkspaceError('旧环境数据范围无法确认，需先备份并明确强制删除', 409);
        environment.dataClearedAt = Date.now();
      });
      environment.state = 'unknown'; environment.updatedAt = Date.now();
      this.db.saveWorkspaceRecord(userId, 'environment', environment);
      // Compute deletion is separate from clearing data. Destroy it after the user explicitly selected deletion.
      if (environment.config.runtime !== 'kubernetes' || environment.resourceUid) {
        try {
          if (this.isDirect(environment.config)) await this.kubeClient(userId, environment).delete(environment, userId);
          else await this.execute(userId, environment, environment.config.runtime === 'linux-user' ? linuxUserStopCommand(environment) : stopRuntimeCommand(environment));
        } catch (error) {
          const missing = error instanceof KubernetesError && error.status === 404 || error instanceof Error && /No such (object|container)|\(NotFound\).*pods? .*not found|can't find session|no server running|no sessions|failed to connect to server/i.test(error.message);
          if (!missing) throw error;
        }
      }
      if (environment.config.runtime === 'linux-user') await this.execute(userId, environment, linuxUserRemoveCommand(environment));
      if (environment.storage?.managed && environment.storage.kind === 'docker-volume') {
        await this.execute(userId, environment, `set -eu; if docker volume inspect ${shellQuote(environment.storage.name!)} >/dev/null 2>&1; then test "$(docker volume inspect --format '{{index .Labels "nexus.environment"}}' ${shellQuote(environment.storage.name!)})" = ${shellQuote(environment.id)}; ${environment.storage.uid ? `test "$(docker volume inspect --format '{{.CreatedAt}}' ${shellQuote(environment.storage.name!)})" = ${shellQuote(environment.storage.uid)}; ` : ''}docker volume rm -- ${shellQuote(environment.storage.name!)}; else docker info >/dev/null; fi`);
      }
      if (environment.storage?.managed && environment.storage.kind === 'pvc') {
        if (this.isDirect(environment.config)) await this.kubeClient(userId, environment).deleteVolume(environment, userId);
        else {
          if (!environment.storage.uid) throw new WorkspaceError('PVC 缺少实例 UID，请先重新核对存储', 409);
          const path = `/api/v1/namespaces/${encodeURIComponent(environment.config.namespace)}/persistentvolumeclaims/${encodeURIComponent(environment.storage.name!)}`;
          const payload = JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: environment.storage.uid } });
          await this.execute(userId, environment, `kubectl ${environment.config.context ? '--context=' + shellQuote(environment.config.context) : ''} --namespace=${shellQuote(environment.config.namespace)} delete --raw ${shellQuote(path)} -f -`, payload);
        }
      }
      environment.dataDeletedAt = Date.now(); environment.state = 'stopped'; environment.updatedAt = Date.now(); environment.error = undefined;
      this.db.saveWorkspaceRecord(userId, 'environment', environment); return environment;
    } catch (error) {
      if (environment.dataClearedAt) {
        environment.state = 'unknown'; environment.error = '数据已清空，剩余资源清理失败；可重试删除数据'; environment.updatedAt = Date.now();
        this.db.saveWorkspaceRecord(userId, 'environment', environment);
      }
      throw error;
    } finally { this.stopping.delete(key); }
  }
  private async tick() {
    if (this.closed || this.active.size >= 4) return;
    for (const job of this.db.queuedWorkspaces()) {
      const key = `${job.kind}:${job.id}`;
      if (
        this.active.has(key) ||
        this.active.size >= 4 ||
        [...this.active.values()].filter((value) => value.userId === job.userId)
          .length >= 2
      )
        continue;
      const instruction =
        job.kind === 'instruction'
          ? this.db.workspaceRecord<WorkspaceInstruction>(
              job.userId,
              'instruction',
              job.id,
            )
          : null;
      const environment = this.environment(
        job.userId,
        instruction?.environmentId ?? job.id,
      );
      const remoteKey = environmentKey(job.userId, environment);
      const target = instruction
        ? `${remoteKey}:${instruction.pane.serverPid}:${instruction.pane.id}`
        : key;
      if (
        this.stopping.has(remoteKey) ||
        [...this.active.values()].some((value) => value.target === target)
      )
        continue;
      const abort = new AbortController();
      this.active.set(key, {
        userId: job.userId,
        target,
        environmentKey: remoteKey,
        abort,
      });
      const promise =
        job.kind === 'environment'
          ? this.prepare(job.userId, job.id, abort.signal)
          : this.deliver(job.userId, job.id, abort.signal);
      void promise
        .catch((error) => {
          console.error(
            'Workspace job state could not be saved',
            error instanceof Error ? error.message : 'unknown error',
          );
        })
        .finally(() => this.active.delete(key));
    }
  }
  private async prepare(userId: string, id: string, signal: AbortSignal) {
    const environment = this.environment(userId, id);
    environment.startedAt ??= Date.now();
    Object.assign(environment, { state: 'preparing', updatedAt: Date.now() });
    this.db.saveWorkspaceRecord(userId, 'environment', environment);
    let log = '';
    try {

      if (!['ssh', 'linux-user'].includes(environment.config.runtime))
        environment.resourceId = `nexus-${environment.id}`;
      if (this.isDirect(environment.config)) {
        const pod = await this.kubeClient(userId, environment).prepare(environment, userId, signal);
        environment.resourceUid = pod.metadata.uid;
      }
      const create = this.isDirect(environment.config) ? null : createRuntimeCommand(environment, userId);
      if (create) {
        log += await this.execute(
          userId,
          environment,
          'sh -s',
          create,
          signal,
          300000,
        );
        if (environment.config.runtime === 'linux-user') {
          const uid = Number(/^NEXUS_UID=(\d+)$/m.exec(log)?.[1]);
          if (!Number.isSafeInteger(uid) || uid < 1) throw new WorkspaceError('Linux 用户 UID 无法确认', 502);
          if (environment.executionUid && environment.executionUid !== uid) throw new WorkspaceError('Linux 用户 UID 已变化', 409);
          environment.executionUid = uid;
          this.db.saveWorkspaceRecord(userId, 'environment', environment);
        } else {
          const output = await this.execute(userId, environment, inspectResourceCommand(environment.config, environment.resourceId), undefined, signal);
          const identity = resourceIdentity(environment.config, output, userId);
          environment.resourceId = identity.id;
          environment.resourceUid = identity.uid;
        }
      }
      log += await this.executeInside(
        userId,
        environment,
        'sh -s',
        bootstrapScript(environment),
        signal,
        600000,
      );
      environment.directory = /^NEXUS_DIRECTORY=(.*)$/m.exec(log)?.[1] ?? environment.config.directory;
      if (environment.storage?.kind === 'docker-volume') environment.storage.uid = /^NEXUS_VOLUME_UID=(.*)$/m.exec(log)?.[1] || environment.storage.uid;
      if (environment.storage?.kind === 'pvc' && !this.isDirect(environment.config)) environment.storage.uid = /^NEXUS_PVC_UID=(.*)$/m.exec(log)?.[1] || environment.storage.uid;
      if (environment.layoutVersion === 2) {
        environment.workRoot = /^NEXUS_ROOT=(.*)$/m.exec(log)?.[1] ?? environment.workRoot;
        environment.branch = /^NEXUS_BRANCH=(.*)$/m.exec(log)?.[1] ?? environment.branch;
        environment.baseCommit = /^NEXUS_BASE_COMMIT=([a-f0-9]{40,64})$/m.exec(log)?.[1] ?? environment.baseCommit;
        environment.baseRef = /^NEXUS_BASE_REF=(.*)$/m.exec(log)?.[1] ?? environment.baseRef;
        environment.prTarget = /^NEXUS_PR_TARGET=(.*)$/m.exec(log)?.[1] ?? environment.prTarget;
        if (environment.storage?.kind === 'directory') environment.storage.mountRoot = environment.workRoot || '';
      }
      if (environment.config.terminalPolicy!=='on-demand' && !(await this.panes(userId, environment)).some((pane) => !pane.dead))
        throw new WorkspaceError(
          '环境已准备，但 tmux／Agent 已退出，请检查启动命令',
          502,
        );
      Object.assign(environment, {
        state: 'ready',
        error: undefined,
        log: log.slice(-32000),
      });
    } catch (error) {
      Object.assign(environment, {
        state: signal.aborted ? 'unknown' : 'failed',
        error: error instanceof Error ? error.message : '环境准备失败',
        log: (
          log + (error instanceof WorkspaceError ? (error.log ?? '') : '')
        ).slice(-32000),
      });
    }
    if (this.closed) return;
    environment.updatedAt = Date.now();
    this.db.saveWorkspaceRecord(userId, 'environment', environment);
  }
  private async deliver(userId: string, id: string, signal: AbortSignal) {
    const instruction = this.db.workspaceRecord<WorkspaceInstruction>(
      userId,
      'instruction',
      id,
    )!;
    Object.assign(instruction, { state: 'sending', updatedAt: Date.now() });
    this.db.saveWorkspaceRecord(userId, 'instruction', instruction);
    let transmitted = false;
    try {
      this.readTask(userId, instruction.taskId);
      const environment = this.environment(userId, instruction.environmentId);
      if (environment.state !== 'ready')
        throw new WorkspaceError('目标环境当前不可用');
      const pane = (await this.panes(userId, environment)).find(
        (value) => value.id === instruction.pane.id,
      );
      if (
        !pane ||
        pane.dead ||
        pane.pid !== instruction.pane.pid ||
        pane.serverPid !== instruction.pane.serverPid
      )
        throw new WorkspaceError('目标 pane 已变化，请重新选择后发送');
      if (
        !instruction.terminalInput &&
        shellCommands.has(pane.command.replace(/^-/, ''))
      )
        throw new WorkspaceError(
          '目标当前是 Shell，请选择运行 Agent 的 pane，或使用终端输入模式',
        );
      transmitted = true;
      await this.executeInside(
        userId,
        environment,
        deliveryCommand(pane.id, instruction.id, instruction.submit, pane),
        instruction.text,
        signal,
      );
      instruction.state = 'delivered';
    } catch (error) {
      instruction.state = transmitted ? 'unknown' : 'failed';
      instruction.error = error instanceof Error ? error.message : '投递失败';
    }
    if (this.closed) return;
    instruction.updatedAt = Date.now();
    this.db.saveWorkspaceRecord(userId, 'instruction', instruction);
  }
}
