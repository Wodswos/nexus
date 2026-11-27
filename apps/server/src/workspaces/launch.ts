import { workspaceLaunchOperationId } from './identity';
import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { validateWorkspaceConfig, type CreateWorkspaceAgent, type WorkspaceConfig, type WorkspaceEnvironment, type WorkspaceAgent } from '../../../../packages/core/src/index';
import type { DB } from '../db';
import { AgentService, validateAgentInput } from '../agents/service';
import { RateLimit } from '../security';
import { WorkspaceService, WorkspaceError } from './service';
import { KubernetesError } from './kubernetesConnections';

interface Launch {
  requestId: string;
  fingerprint: string;
  taskId: string;
  config: WorkspaceConfig;
  name?: string;
  workspaceId?: string;
  resourceId?: string;
  agent?: Omit<CreateWorkspaceAgent, 'environmentId' | 'requestId'>;
  callbackOrigin: string;
  state: 'pending' | 'complete' | 'failed';
  environmentId?: string;
  agentId?: string;
  error?: string;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Result = { environment: WorkspaceEnvironment; agent?: WorkspaceAgent };

/** Persist the intent first. A restart resumes between environment creation and Agent creation. */
export function setupWorkspaceLaunch(
  app: Hono, db: DB, workspaces: WorkspaceService, agents: AgentService,
  currentUser: (c: Context) => string | null,
  readWorkspace: (userId: string, id: string) => unknown,
) {
  const running = new Map<string, Promise<Result>>(), limit = new RateLimit(60, 60000);
  let closed = false;
  const run = (userId: string, launch: Launch): Promise<Result> => {
    const key = `${userId}:${launch.requestId}`, active = running.get(key);
    if (active) return active;
    const operation = (async () => {
      try {
        // This also checks that the task is active and its Workspace is enabled.
        agents.prompt(userId, launch.taskId, launch.callbackOrigin);
        if (launch.agent?.workspaceId) readWorkspace(userId, launch.agent.workspaceId);
        if (launch.workspaceId) readWorkspace(userId, launch.workspaceId);
        const operationId = workspaceLaunchOperationId(launch.taskId, launch.requestId);
        // Legacy launch retries must retain the original environment fingerprint.
        const metadata = launch.name !== undefined || launch.workspaceId !== undefined
          ? { name: launch.name, workspaceId: launch.workspaceId } : undefined;
        const environment = launch.environmentId ? workspaces.environment(userId, launch.environmentId)
          : launch.resourceId !== undefined ? await workspaces.attach(userId, launch.taskId, launch.resourceId, operationId, launch.config)
            : workspaces.create(userId, launch.taskId, operationId, launch.config, metadata);
        launch.environmentId = environment.id;
        db.saveWorkspaceLaunch(userId, launch);
        if (closed) throw new WorkspaceError('服务正在重启，创建流程会在恢复后继续', 409);
        const agent = launch.agentId ? agents.get(userId, launch.agentId) : launch.agent ? agents.create(userId, launch.taskId, {
          ...launch.agent, environmentId: environment.id, requestId: operationId,
        }, launch.callbackOrigin) : undefined;
        launch.agentId = agent?.id;
        launch.state = 'complete'; launch.error = undefined;
        db.saveWorkspaceLaunch(userId, launch);
        return { environment, ...(agent ? { agent } : {}) };
      } catch (error) {
        if (!closed) {
          launch.state = 'failed'; launch.error = error instanceof WorkspaceError ? error.message : '创建流程中断，请使用相同内容重试';
          db.saveWorkspaceLaunch(userId, launch);
        }
        throw error;
      }
    })();
    running.set(key, operation);
    void operation.finally(() => running.delete(key)).catch(() => {});
    return operation;
  };
  const timer = setInterval(() => {
    if (closed || running.size >= 4) return;
    for (const { userId, value } of db.pendingWorkspaceLaunches<Launch>()) {
      if (running.size >= 4) break;
      void run(userId, value).catch(() => {});
    }
  }, 1500);
  timer.unref();
  app.post('/api/tasks/:taskId/workspace-launch', async c => {
    const userId = currentUser(c);
    if (!userId) return c.json({ error: '请先登录' }, 401);
    if (!limit.allow(userId)) return c.json({ error: '创建请求过多，请稍后重试' }, 429);
    try {
      const value: unknown = await c.req.json().catch(() => null);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceError('请求体需要使用 JSON 对象');
      const body = value as Record<string, unknown>;
      if (Object.keys(body).some(key => !['requestId', 'name', 'workspaceId', 'config', 'resourceId', 'agent'].includes(key))) throw new WorkspaceError('创建请求包含未知字段');
      if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120 || /[\0\r\n]/.test(body.name))) throw new WorkspaceError('Workspace 名称需要 1–120 个字符');
      if (body.workspaceId !== undefined) {
        if (typeof body.workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.workspaceId)) throw new WorkspaceError('Workspace 模板 ID 无效');
        readWorkspace(userId, body.workspaceId);
      }
      if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.requestId)) throw new WorkspaceError('请求 ID 无效');
      if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) throw new WorkspaceError('Workspace 配置格式无效');
      validateWorkspaceConfig(body.config as WorkspaceConfig);
      if (body.resourceId !== undefined && (typeof body.resourceId !== 'string' || !body.resourceId || body.resourceId.length > 256 || body.resourceId.includes('\0'))) throw new WorkspaceError('已有环境标识无效');
      const taskId = c.req.param('taskId')!, callbackOrigin = process.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
      agents.prompt(userId, taskId, callbackOrigin);
      if (body.agent !== undefined) {
        if (!body.agent || typeof body.agent !== 'object' || Array.isArray(body.agent)) throw new WorkspaceError('Agent 配置需要使用 JSON 对象');
        if (Object.keys(body.agent).some(key => !['workspaceId', 'name', 'mode', 'command', 'prompt', 'directory', 'worktree', 'worktreeName', 'pane', 'productId', 'round', 'providerId', 'model', 'terminalPolicy', 'isolatedDirectory', 'persistentSession'].includes(key))) throw new WorkspaceError('Agent 配置包含未知字段');
        validateAgentInput({ ...body.agent, requestId: body.requestId });
        agents.validateProvider(userId, body.agent as CreateWorkspaceAgent);
        const workspaceId = (body.agent as CreateWorkspaceAgent).workspaceId;
        if (workspaceId) readWorkspace(userId, workspaceId);
      }
      const fingerprint = hash({ taskId, ...body }), previous = db.workspaceLaunch<Launch>(userId, body.requestId);
      if (previous && previous.fingerprint !== fingerprint) throw new WorkspaceError('同一创建请求的配置已变化，请使用新的请求 ID', 409);
      if (previous?.state === 'complete') return c.json({ data: { environment: workspaces.environment(userId, previous.environmentId!), ...(previous.agentId ? { agent: agents.get(userId, previous.agentId) } : {}) } });
      if (running.size >= 4 && !running.has(`${userId}:${body.requestId}`)) throw new WorkspaceError('创建队列繁忙，请稍后重试', 429);
      const launch: Launch = previous ?? {
        requestId: body.requestId, fingerprint, taskId, callbackOrigin, state: 'pending',
        ...(body.name !== undefined ? { name: body.name as string } : {}),
        ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId as string } : {}),
        // The managed Agent starts exactly once in its own session after preparation.
        config: { ...body.config as WorkspaceConfig, ...(body.agent ? { agentCommand: '' } : {}) },
        ...(body.resourceId !== undefined ? { resourceId: body.resourceId as string } : {}),
        ...(body.agent ? { agent: body.agent as Launch['agent'] } : {}),
      };
      launch.state = 'pending'; launch.error = undefined; db.saveWorkspaceLaunch(userId, launch);
      return c.json({ data: await run(userId, launch) });
    } catch (error) {
      if (error instanceof WorkspaceError || error instanceof KubernetesError) return c.json({ error: error.message }, error.status);
      if (error instanceof Error && /^(Workspace|请选择|请设置|请填写|image|工作目录|仓库|Kubernetes|环境凭据)/.test(error.message)) return c.json({ error: error.message }, 400);
      return c.json({ error: 'Workspace 创建失败，可使用相同内容重试' }, 502);
    }
  });
  return { close() { closed = true; clearInterval(timer); } };
}
