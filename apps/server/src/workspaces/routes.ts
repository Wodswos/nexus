import type { Hono, Context } from 'hono';
import {
  resolveWorkspace,
  activeTasks,
  type WorkspaceConfig,
  type WorkspacePane,
} from '../../../../packages/core/src/index';
import type { DB } from '../db';
import type { Connections } from '../connections';
import type { setupSync } from '../sync';
import { RateLimit } from '../security';
import { WorkspaceError, WorkspaceService } from './service';
import { KubernetesError, type KubernetesConnections } from './kubernetesConnections';

type CurrentUser = (context: Context) => string | null;
export function setupWorkspaces(
  app: Hono,
  db: DB,
  connections: Connections,
  sync: () => Pick<ReturnType<typeof setupSync>, 'withStore'>,
  currentUser: CurrentUser,
  kubernetes?: KubernetesConnections,
) {
  const readTask = (userId: string, taskId: string) =>
    sync().withStore(userId, false, (store) => {
      const data = store.getData(),
        task = activeTasks(data.tasks).find((value) => value.id === taskId);
      if (!task || task.deletedAt != null || task.status === 'archived')
        throw new WorkspaceError('节点不存在或已归档', 404);
      const resolved = resolveWorkspace(data, taskId);
      return { ...resolved, title: task.title };
    });
  const service = new WorkspaceService(db, connections, (userId, taskId) => {
    const workspace = readTask(userId, taskId);
    if (workspace.disabled)
      throw new WorkspaceError('此分支的 Workspace 已停用');
    return workspace;
  }, undefined, kubernetes);
  const limits = new RateLimit(120, 60000);
  const handle =
    (
      operation: (
        context: Context,
        userId: string,
      ) => unknown | Promise<unknown>,
    ) =>
    async (context: Context) => {
      const userId = currentUser(context);
      if (!userId) return context.json({ error: '请先登录' }, 401);
      if (!limits.allow(userId))
        return context.json({ error: 'Workspace 请求过多，请稍后重试' }, 429);
      try {
        return context.json({ data: await operation(context, userId) });
      } catch (error) {
        if (error instanceof WorkspaceError || error instanceof KubernetesError)
          return context.json({ error: error.message }, error.status);
        if (
          error instanceof Error &&
          /^(Workspace|请选择|请设置|请填写|image|工作目录|仓库|Kubernetes|环境凭据)/.test(
            error.message,
          )
        )
          return context.json({ error: error.message }, 400);
        return context.json(
          { error: '环境操作失败，请核对控制主机与运行环境配置' },
          502,
        );
      }
    };
  const body = async (context: Context) => {
    const value: unknown = await context.req.json().catch(() => null);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new WorkspaceError('请求体需要使用 JSON 对象');
    return value as Record<string, unknown>;
  };
  app.get('/api/workspace-environments/:id/cleanup-plan',handle((c,u)=>service.cleanupPlan(u,c.req.param('id')!)));
  app.get('/api/workspace-environments', handle((_context, userId) => service.list(userId)));
  app.post('/api/workspaces/:id/preview', handle(async (context, userId) => service.preview(userId, context.req.param('id')!, await body(context))));
  app.post('/api/workspaces/:id/capabilities', handle(async (context, userId) => {
    const value = await body(context);
    return service.capabilities(userId, context.req.param('id')!, value.config as WorkspaceConfig | undefined);
  }));
  app.post('/api/workspace-environments/:id/stop', handle((context, userId) => service.pause(userId, context.req.param('id')!)));
  app.post('/api/workspace-environments/:id/resume', handle((context, userId) => service.resume(userId, context.req.param('id')!)));
  app.post('/api/workspace-environments/:id/archive', handle(async (context, userId) => {
    const value = await body(context);
    if (typeof value.archived !== 'boolean') throw new WorkspaceError('请指定是否归档');
    return service.archive(userId, context.req.param('id')!, value.archived);
  }));
  app.get('/api/workspace-environments/:id/git', handle((context, userId) => service.gitState(userId, context.req.param('id')!)));
  app.delete('/api/workspace-environments/:id/data', handle(async (context, userId) => {
    const value = await body(context);
    return service.deleteData(userId, context.req.param('id')!, value.confirm === true, value.force === true);
  }));
  app.get(
    '/api/workspaces/:id',
    handle((context, userId) => {
      const id = context.req.param('id')!;
      const workspace = readTask(userId, id);
      return { workspace, ...service.overview(userId, id, workspace.config) };
    }),
  );
  app.post(
    '/api/workspaces/:id/discover',
    handle(async (context, userId) => {
      const value = await body(context);
      return service.discover(
        userId,
        context.req.param('id')!,
        value.config as WorkspaceConfig | undefined,
      );
    }),
  );
  app.post(
    '/api/workspaces/:id/environments',
    handle(async (context, userId) => {
      const value = await body(context),
        id = context.req.param('id')!;
      return value.resourceId !== undefined
        ? service.attach(
            userId,
            id,
            value.resourceId,
            value.requestId,
            value.config as WorkspaceConfig | undefined,
          )
        : service.create(
            userId,
            id,
            value.requestId,
            value.config as WorkspaceConfig | undefined,
          );
    }),
  );
  app.post(
    '/api/workspaces/:id/instructions',
    handle(async (context, userId) => {
      const value = await body(context);
      return service.send(userId, context.req.param('id')!, {
        requestId: value.requestId,
        environmentId: String(value.environmentId ?? ''),
        pane: value.pane as WorkspacePane,
        text: value.text as string,
        submit: value.submit === true,
        terminalInput: value.terminalInput === true,
      });
    }),
  );
  app.get(
    '/api/workspace-environments/:id',
    handle((context, userId) =>
      service.environment(userId, context.req.param('id')!),
    ),
  );
  app.get(
    '/api/workspace-environments/:id/panes',
    handle((context, userId) =>
      service.panes(userId, context.req.param('id')!),
    ),
  );
  app.get(
    '/api/workspace-environments/:id/output',
    handle((context, userId) =>
      service.capture(
        userId,
        context.req.param('id')!,
        context.req.query('pane') ?? '',
      ),
    ),
  );
  app.post(
    '/api/workspace-environments/:id/check',
    handle((context, userId) =>
      service.check(userId, context.req.param('id')!),
    ),
  );
  app.post(
    '/api/workspace-environments/:id/retry',
    handle((context, userId) =>
      service.retry(userId, context.req.param('id')!),
    ),
  );
  app.delete(
    '/api/workspace-environments/:id',
    handle((context, userId) => service.stop(userId, context.req.param('id')!)),
  );
  return service;
}
