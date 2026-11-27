import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DB } from '../src/db';
import { setupSync } from '../src/sync';
import { setupWorkspaceProfiles } from '../src/workspaces/profiles';
import { EMPTY_WORKSPACE, resolveWorkspace, type WorkspaceProfile } from '../../../packages/core/src/index';

const payload = async <T = WorkspaceProfile>(response: Response): Promise<T> => ((await response.json()) as { data: T }).data;

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-profiles-')), db = new DB(dir), server = createServer(), app = new Hono();
  const sync = setupSync(server, db, () => null);
  setupWorkspaceProfiles(app, db, () => sync, c => c.req.header('test-user') ?? null);
  cleanups.push(() => { sync.close(); server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const req = (path = '', method = 'GET', data?: unknown, user = 'alice') => app.request(`/api/workspace-profiles${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(user ? { 'test-user': user } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { req, sync };
}
describe('Workspace profile API', () => {
  it('keeps multiple templates attached to their task and rejects a foreign task before creating anything', async () => {
    const { req, sync } = fixture();
    const taskId = sync.withStore('alice', true, store => store.createTask({ title: '模板所属节点' }).id);
    const input = { requestId: 'attached', name: '本地研发', config: EMPTY_WORKSPACE, taskId };
    expect((await req('', 'POST', input, 'bob')).status).toBe(404);
    expect(await payload<WorkspaceProfile[]>(await req('', 'GET', undefined, 'bob'))).toHaveLength(0);
    expect(await payload(await req('', 'POST', input))).toMatchObject({ taskId });
    expect(await payload(await req('', 'POST', { ...input, requestId: 'second', name: '容器研发' }))).toMatchObject({ taskId });
    expect(await payload<WorkspaceProfile[]>(await req())).toHaveLength(2);
  });
  it('isolates accounts and persists idempotent creates, version checks and inherited config edits', async () => {
    const { req, sync } = fixture();
    const body = { requestId: 'create-profile', name: '研发', config: { ...EMPTY_WORKSPACE, serverId: 'host' }, promptTemplate: '{{task_title}}' };
    expect((await req('', 'GET', undefined, '')).status).toBe(401);
    const first = await req('', 'POST', body), profile = await payload(first);
    expect(first.status).toBe(200);
    expect((await payload(await req('', 'POST', body))).id).toBe(profile.id);
    expect((await req('', 'POST', { ...body, name: 'changed' })).status).toBe(409);
    expect((await req(`/${profile.id}`, 'GET', undefined, 'bob')).status).toBe(404);
    expect((await req(`/${profile.id}`, 'PATCH', { name: 'stolen' }, 'bob')).status).toBe(404);
    expect((await req(`/${profile.id}`, 'DELETE', undefined, 'bob')).status).toBe(404);
    const taskId = sync.withStore('alice', true, store => {
      const root = store.createTask({ title: 'Parent' }), child = store.createTask({ title: 'Child', parentId: root.id });
      store.setWorkspace(root.id, { workspaceId: profile.id, mode: 'inherit' });
      return child.id;
    });
    const updated = await req(`/${profile.id}`, 'PATCH', { expectedUpdatedAt: profile.updatedAt, config: { ...body.config, directory: '/project' } });
    expect(updated.status).toBe(200);
    expect(sync.withStore('alice', false, store => resolveWorkspace(store.getData(), taskId).config.directory)).toBe('/project');
    expect((await req(`/${profile.id}`, 'PATCH', { expectedUpdatedAt: profile.updatedAt, name: 'stale' })).status).toBe(409);
    expect((await req(`/${profile.id}`, 'DELETE')).status).toBe(400);
  });
  it('rejects invalid secret-bearing config and keeps tombstones after deletion', async () => {
    const { req } = fixture();
    const body = { requestId: 'create', name: 'Good', config: EMPTY_WORKSPACE };
    expect((await req('', 'POST', { ...body, config: { ...EMPTY_WORKSPACE, token: 'forbidden' } })).status).toBe(400);
    expect(await payload<WorkspaceProfile[]>(await req())).toHaveLength(0);
    const profile = await payload(await req('', 'POST', body));
    expect((await req(`/${profile.id}`, 'DELETE')).status).toBe(200);
    expect((await req(`/${profile.id}`)).status).toBe(404);
    expect(await payload<WorkspaceProfile[]>(await req())).toHaveLength(0);
  });
});
