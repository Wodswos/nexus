import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DB } from '../src/db';
import { WorkspaceService, WorkspaceError } from '../src/workspaces/service';
import { workspaceLaunchOperationId } from '../src/workspaces/identity';
import { EMPTY_WORKSPACE, type WorkspaceConfig, type WorkspaceEnvironment } from '../../../packages/core/src/index';
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-preview-')), db = new DB(dir);
  const calls: { command: string; input?: string }[] = [];
  const config: WorkspaceConfig = { ...EMPTY_WORKSPACE, serverId: 'host' };
  const service = new WorkspaceService(db, { resolve: userId => ({ userId, host: 'fixture', password: '', sshDir: dir }) }, (userId, taskId) => {
    if (taskId !== `task-${userId}`) throw new WorkspaceError('节点不存在', 404);
    return { config, title: 'Task' };
  }, async (_connection, command, options) => {
    calls.push({ command, input: options?.input });
    return { code: 0, stdout: 'NEXUS_HOME=/home/remote-user\n', stderr: '' };
  });
  service.close(); // No asynchronous runtime preparation in this read-only contract test.
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, config, service, calls };
}
describe('read-only Workspace path preview', () => {
  it.each(['ssh', 'linux-user', 'docker', 'kubernetes'] as const)('matches subsequent %s creation, never allocating resources during preview', async runtime => {
    const { db, service, config, calls } = fixture();
    const requestId = 'request-1', taskId = 'task-alice';
    const settings = { ...config, runtime, image: runtime === 'docker' || runtime === 'kubernetes' ? 'node:24' : '' };
    const preview = await service.preview('alice', taskId, { requestId, config: settings, worktreeName: 'feature-123' });
    expect(db.workspaceRecords('alice', 'environment')).toHaveLength(0);
    expect(calls).toHaveLength(runtime === 'ssh' ? 1 : 0);
    if (runtime === 'ssh') expect(calls[0]).toMatchObject({ command: 'sh -s', input: expect.stringContaining('NEXUS_HOME=') });
    expect(JSON.stringify(calls)).not.toMatch(/mkdir|clone|worktree add|kubectl|docker/);
    expect(preview.directory).toBe(`${preview.workRoot}/nexus-agent/feature-123`);
    expect(preview.branch).toBe('nexus-agent/feature-123');
    const created = service.create('alice', taskId, workspaceLaunchOperationId(taskId, requestId), settings);
    expect(created.id).toBe(preview.environmentId);
    expect(created.workRoot || `/home/remote-user/.local/share/nexus/workspaces/${created.id}`).toBe(preview.workRoot);
  });
  it('uses explicit roots, preserves existing identities and isolates accounts and tasks', async () => {
    const { db, service, config, calls } = fixture();
    const input = { requestId: 'shared-key', config: { ...config, workRoot: '/srv/work' }, worktreeName: 'feature-123' };
    const first = await service.preview('alice', 'task-alice', input);
    const other = await service.preview('bob', 'task-bob', input);
    expect(first.environmentId).not.toBe(other.environmentId);
    expect(calls).toHaveLength(0);
    await expect(service.preview('bob', 'task-alice', input)).rejects.toThrow('节点不存在');
    const environment = service.create('alice', 'task-alice', workspaceLaunchOperationId('task-alice', input.requestId), input.config);
    const existing = await service.preview('alice', 'task-alice', { environmentId: environment.id, worktreeName: 'other' });
    expect(existing.directory).toBe(`${environment.workRoot}/nexus-agent/other`);
    await expect(service.preview('bob', 'task-bob', { environmentId: environment.id, worktreeName: 'other' })).rejects.toThrow('环境不存在');
    for (const worktreeName of ['../escape', 'one/two', 'bad\nname', '']) await expect(service.preview('alice', 'task-alice', { ...input, worktreeName })).rejects.toThrow('名称无效');
    db.saveWorkspaceRecord('alice', 'environment', { ...environment, state: 'stopped' } as WorkspaceEnvironment);
    await expect(service.preview('alice', 'task-alice', { environmentId: environment.id, worktreeName: 'other' })).rejects.toThrow('不可用');
    expect(db.workspaceRecords('alice', 'environment')).toHaveLength(1);
  });
});
