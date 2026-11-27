import type { Hono, Context } from 'hono';
import type { DB } from './db';
import type { setupSync } from './sync';
import type { TaskRevision, RevisionMeta } from './taskRevisions';
import type { NexusStore } from '../../../packages/crdt/src/store';
import { RateLimit } from './security';

export class DescriptionError extends Error {
  constructor(message: string, public status: 400 | 401 | 403 | 404 | 409 | 429 = 400) { super(message); }
}
export interface DescriptionInput { expectedRevisionId: string; notes: string; agentId?: string; roundId?: string }
export function taskDescriptionService(db: DB, sync: () => Pick<ReturnType<typeof setupSync>, 'withStore'>) {
  const task = (store: NexusStore, taskId: string) => {
    const value = store.getData().tasks.find(row => row.id === taskId && !row.deletedAt);
    if (!value) throw new DescriptionError('任务不存在', 404);
    return value;
  };
  const read = (userId: string, taskId: string): TaskRevision => sync().withStore(userId, false, store => db.taskRevisions.record(userId, task(store, taskId)));
  const update = (userId: string, taskId: string, input: DescriptionInput, meta: RevisionMeta = { source: input.agentId ? 'agent' : 'user', agentId: input.agentId, roundId: input.roundId }) => {
    if (!input || typeof input.expectedRevisionId !== 'string' || !input.expectedRevisionId) throw new DescriptionError('请提供最新 expectedRevisionId', 409);
    if (typeof input.notes !== 'string' || input.notes.length > 100000) throw new DescriptionError('正文最多 100000 字符');
    // Materialize any pending browser checkpoint before the atomic compare/write.
    read(userId, taskId);
    sync().withStore(userId, true, store => {
      const current = task(store, taskId), revision = db.taskRevisions.latest(userId, taskId);
      if (revision?.id !== input.expectedRevisionId || revision.notes !== (current.notes ?? '') || revision.title !== current.title)
        throw new DescriptionError('正文已更新，请重新读取并合并，当前内容未被覆盖', 409);
      store.updateTask(taskId, { notes: input.notes });
    }, undefined, meta);
    return read(userId, taskId);
  };
  const restore = (userId: string, taskId: string, revisionId: string, expectedRevisionId: string) => {
    read(userId, taskId);
    const target = db.taskRevisions.get(userId, taskId, revisionId);
    if (!target) throw new DescriptionError('历史版本不存在', 404);
    sync().withStore(userId, true, store => {
      const current = task(store, taskId), revision = db.taskRevisions.latest(userId, taskId);
      if (revision?.id !== expectedRevisionId || revision.notes !== (current.notes ?? '') || revision.title !== current.title)
        throw new DescriptionError('内容已更新，请重新比较后再恢复', 409);
      store.updateTask(taskId, { title: target.title, notes: target.notes });
    }, undefined, { source: 'restore', restoredFrom: target.id });
    return read(userId, taskId);
  };
  return { read, update, restore,
    list: (userId: string, taskId: string, offset = 0) => { const current = read(userId, taskId); return { ...db.taskRevisions.list(userId, taskId, offset), currentRevisionId: current.id }; },
    get: (userId: string, taskId: string, revisionId: string) => { read(userId, taskId); const revision = db.taskRevisions.get(userId, taskId, revisionId); if (!revision) throw new DescriptionError('历史版本不存在', 404); return revision; },
  };
}
export function setupTaskDescriptions(app: Hono, db: DB, sync: () => Pick<ReturnType<typeof setupSync>, 'withStore'>, currentUser: (context: Context) => string | null) {
  const service = taskDescriptionService(db, sync), limit = new RateLimit(180, 60000);
  const identity = (c: Context, api: boolean, write: boolean) => {
    if (!api) { const userId = currentUser(c); if (!userId) throw new DescriptionError('请先登录', 401); return userId; }
    const auth = c.req.header('Authorization') ?? '';
    const token = /^Bearer ctx_[a-f0-9]{64}$/.test(auth) ? db.findApiToken(auth.slice(7)) : null;
    if (!token || !db.getUser(token.user_id)) throw new DescriptionError('请提供有效的 Bearer Token', 401);
    if (write && token.permission !== 'write') throw new DescriptionError('该 Token 只有读取权限', 403);
    if (c.req.header('X-Cortex-User') && c.req.header('X-Cortex-User') !== token.user_id) throw new DescriptionError('账号已切换', 409);
    return token.user_id;
  };
  const handle = (api: boolean, write: boolean, operation: (c: Context, userId: string) => unknown | Promise<unknown>) => async (c: Context) => {
    try {
      const userId = identity(c, api, write);
      if (!limit.allow(userId)) throw new DescriptionError('版本请求过于频繁', 429);
      return c.json({ data: await operation(c, userId) });
    } catch (error) {
      if (error instanceof DescriptionError) return c.json({ error: error.message }, error.status);
      return c.json({ error: '正文版本操作失败' }, 500);
    }
  };
  const body = async (c: Context) => {
    const input = await c.req.json().catch(() => null);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DescriptionError('请提供 JSON 对象');
    return input as Record<string, unknown>;
  };
  for (const api of [false, true]) for (const collection of api ? ['tasks', 'projects'] : ['tasks']) {
    const base = `/api${api ? '/v1' : ''}/${collection}/:taskId`;
    app.get(`${base}/description`, handle(api, false, (c, userId) => service.read(userId, c.req.param('taskId')!)));
    app.patch(`${base}/description`, handle(api, true, async (c, userId) => {
      const input = await body(c);
      return service.update(userId, c.req.param('taskId')!, { expectedRevisionId: input.expectedRevisionId as string, notes: input.notes as string }, { source: api ? 'api' : 'user' });
    }));
    app.get(`${base}/revisions`, handle(api, false, (c, userId) => {
      const offset = Number(c.req.query('offset') ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new DescriptionError('offset 无效');
      return service.list(userId, c.req.param('taskId')!, offset);
    }));
    app.get(`${base}/revisions/:revisionId`, handle(api, false, (c, userId) => service.get(userId, c.req.param('taskId')!, c.req.param('revisionId')!)));
    app.post(`${base}/revisions/:revisionId/restore`, handle(api, true, async (c, userId) => {
      const input = await body(c);
      return service.restore(userId, c.req.param('taskId')!, c.req.param('revisionId')!, String(input.expectedRevisionId ?? ''));
    }));
  }
  return service;
}
