import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import { DB } from '../src/db';
import { setupSync } from '../src/sync';
import { setupTaskDescriptions } from '../src/taskDescriptions';
let dir: string, db: DB, sync: ReturnType<typeof setupSync>, descriptions: ReturnType<typeof setupTaskDescriptions>, app: Hono, userId: string, otherId: string, taskId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-revisions-')); db = new DB(dir); app = new Hono();
  userId = db.createUser('alice', 'hash', 'salt', true).id; otherId = db.createUser('bob', 'hash', 'salt', false).id;
  sync = setupSync(createAdaptorServer(app), db, () => null);
  descriptions = setupTaskDescriptions(app, db, () => sync, c => c.req.header('Test-User') ?? null);
  taskId = sync.withStore(userId, true, store => store.createTask({ title: '原始任务', notes: '人工说明', status: 'todo' }).id);
});
afterEach(() => { sync.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
it('keeps immutable text revisions, ignores unrelated changes, and restores as a new revision', () => {
  const initial = descriptions.read(userId, taskId);
  sync.withStore(userId, true, store => store.updateTask(taskId, { important: true }));
  expect(descriptions.list(userId, taskId).total).toBe(1);
  const updated = descriptions.update(userId, taskId, { expectedRevisionId: initial.id, notes: '# 设计\n新的中文正文', agentId: 'agent-1', roundId: 'round-1' });
  expect(updated).toMatchObject({ source: 'agent', agentId: 'agent-1', roundId: 'round-1' });
  expect(descriptions.get(userId, taskId, initial.id).notes).toBe('人工说明');
  const restored = descriptions.restore(userId, taskId, initial.id, updated.id);
  expect(restored.id).not.toBe(initial.id); expect(restored).toMatchObject({ notes: '人工说明', source: 'restore', restoredFrom: initial.id });
  expect(descriptions.list(userId, taskId).total).toBe(3);
  expect(descriptions.get(userId, taskId, updated.id).notes).toContain('新的中文正文');
});
it('rejects stale updates and restores without overwriting another edit', () => {
  const original = descriptions.read(userId, taskId);
  sync.withStore(userId, true, store => store.updateTask(taskId, { notes: '用户刚刚补充' }));
  expect(() => descriptions.update(userId, taskId, { expectedRevisionId: original.id, notes: '过期Agent结果' })).toThrow('正文已更新');
  expect(() => descriptions.restore(userId, taskId, original.id, original.id)).toThrow('内容已更新');
  expect(descriptions.read(userId, taskId).notes).toBe('用户刚刚补充');
});
it('commits task contents and history atomically when the surrounding write fails', () => {
  expect(() => sync.withStore(userId, true, store => store.updateTask(taskId, { notes: 'rolled back' }), () => { throw new Error('rollback'); })).toThrow('rollback');
  expect(descriptions.read(userId, taskId).notes).toBe('人工说明'); expect(descriptions.list(userId, taskId).total).toBe(1);
});
it('isolates account histories, enforces read-only tokens, and does not accept an Agent token on business routes', async () => {
  const original = descriptions.read(userId, taskId), route = `/api/tasks/${taskId}/revisions/${original.id}`;
  expect((await app.request(route)).status).toBe(401);
  expect((await app.request(route, { headers: { 'Test-User': otherId } })).status).toBe(404);
  expect((await app.request(route, { headers: { 'Test-User': userId } })).status).toBe(200);
  const token = db.createApiToken(userId, 'read', 'read', 1).token;
  expect((await app.request(`/api/v1/tasks/${taskId}/revisions`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  expect((await app.request(`/api/v1/tasks/${taskId}/description`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevisionId: original.id, notes: 'forbidden' }) })).status).toBe(403);
  expect((await app.request(`/api/v1/tasks/${taskId}/description`, { headers: { Authorization: `Bearer nxa_${'0'.repeat(64)}` } })).status).toBe(401);
});
