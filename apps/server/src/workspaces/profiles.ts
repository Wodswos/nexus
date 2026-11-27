import { createHash, randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { activeTasks, EMPTY_WORKSPACE, validateWorkspaceProfile, type WorkspaceProfile } from '../../../../packages/core/src/index';
import type { DB } from '../db';
import type { setupSync } from '../sync';
import { RateLimit } from '../security';
import { WorkspaceError } from './service';

export function setupWorkspaceProfiles(
  app: Hono, db: DB,
  sync: () => Pick<ReturnType<typeof setupSync>, 'withStore'>,
  currentUser: (context: Context) => string | null,
) {
  const limit = new RateLimit(120, 60000);
  const handle = (operation: (c: Context, userId: string) => unknown | Promise<unknown>) => async (c: Context) => {
    const userId = currentUser(c);
    if (!userId) return c.json({ error: '请先登录' }, 401);
    if (!limit.allow(userId)) return c.json({ error: 'Workspace 请求过多，请稍后重试' }, 429);
    try { return c.json({ data: await operation(c, userId) }); }
    catch (error) {
      if (error instanceof WorkspaceError) return c.json({ error: error.message }, error.status);
      if (error instanceof Error && error.message.startsWith('Workspace')) return c.json({ error: error.message }, 400);
      return c.json({ error: 'Workspace 档案操作失败' }, 500);
    }
  };
  const body = async (c: Context, allowed: string[]) => {
    const value: unknown = await c.req.json().catch(() => null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceError('请求体需要使用 JSON 对象');
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => !allowed.includes(key))) throw new WorkspaceError('Workspace 档案包含未知字段');
    return row;
  };
  const read = (userId: string, id: string) => sync().withStore(userId, false, store => {
    const profile = store.getData().workspaceProfiles?.find(value => value.id === id && value.deletedAt == null);
    if (!profile) throw new WorkspaceError('Workspace 档案不存在', 404);
    return profile;
  });
  app.get('/api/workspace-profiles', handle((_c, userId) => sync().withStore(userId, false, store =>
    (store.getData().workspaceProfiles ?? []).filter(profile => profile.deletedAt == null))));
  app.get('/api/workspace-profiles/:id', handle((c, userId) => read(userId, c.req.param('id')!)));
  app.post('/api/workspace-profiles', handle(async (c, userId) => {
    const row = await body(c, ['requestId', 'name', 'taskId', 'config', 'promptTemplate']);
    if (typeof row.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.requestId)) throw new WorkspaceError('请求 ID 无效');
    if (!row.config || typeof row.config !== 'object' || Array.isArray(row.config)) throw new WorkspaceError('Workspace 配置格式无效');
    const key = `workspace-profile:${row.requestId}`, digest = createHash('sha256').update(JSON.stringify(row)).digest('hex');
    const previous = db.apiRequest(userId, key);
    if (previous) {
      if (previous.fingerprint !== digest) throw new WorkspaceError('同一请求 ID 对应的配置已变化', 409);
      return JSON.parse(previous.response) as WorkspaceProfile;
    }
    const time = Date.now();
    const profile: WorkspaceProfile = {
      id: randomUUID(), name: row.name as string,
      ...(row.taskId !== undefined ? { taskId: row.taskId as string } : {}),
      config: { ...EMPTY_WORKSPACE, ...row.config },
      promptTemplate: (row.promptTemplate ?? '') as string,
      createdAt: time, updatedAt: time,
    };
    validateWorkspaceProfile(profile);
    return sync().withStore(userId, true, store => {
      if (profile.taskId && !activeTasks(store.getData().tasks).some(task => task.id === profile.taskId)) throw new WorkspaceError('模板所属 Task 不存在', 404);
      if ((store.getData().workspaceProfiles?.length ?? 0) >= 10000) throw new WorkspaceError('Workspace 档案数量达到上限', 429);
      store.saveWorkspaceProfile(profile);
      return profile;
    }, result => db.rememberApiRequest(userId, key, digest, 200, JSON.stringify(result)));
  }));
  app.patch('/api/workspace-profiles/:id', handle(async (c, userId) => {
    const row = await body(c, ['name', 'config', 'promptTemplate', 'expectedUpdatedAt']);
    if (row.config !== undefined && (!row.config || typeof row.config !== 'object' || Array.isArray(row.config)))
      throw new WorkspaceError('Workspace 配置格式无效');
    return sync().withStore(userId, true, store => {
      const profile = store.getData().workspaceProfiles?.find(value => value.id === c.req.param('id') && value.deletedAt == null);
      if (!profile) throw new WorkspaceError('Workspace 档案不存在', 404);
      if (row.expectedUpdatedAt !== undefined && row.expectedUpdatedAt !== profile.updatedAt)
        throw new WorkspaceError('Workspace 档案已更新，请重新打开配置', 409);
      const next = {
        ...profile,
        ...(row.name !== undefined ? { name: row.name as string } : {}),
        ...(row.config !== undefined ? { config: { ...EMPTY_WORKSPACE, ...row.config as object } } : {}),
        ...(row.promptTemplate !== undefined ? { promptTemplate: row.promptTemplate as string } : {}),
        updatedAt: Math.max(Date.now(), profile.updatedAt + 1),
      };
      store.saveWorkspaceProfile(next, profile.updatedAt);
      return next;
    });
  }));
  app.delete('/api/workspace-profiles/:id', handle((c, userId) => sync().withStore(userId, true, store => {
    const id = c.req.param('id')!;
    if (!store.getData().workspaceProfiles?.some(value => value.id === id && value.deletedAt == null))
      throw new WorkspaceError('Workspace 档案不存在', 404);
    store.deleteWorkspaceProfile(id);
    return { id, deleted: true };
  })));
  return { read };
}
