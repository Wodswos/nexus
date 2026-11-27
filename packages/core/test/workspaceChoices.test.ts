import { describe, expect, it } from 'vitest';
import { EMPTY_DATA, EMPTY_WORKSPACE, workspaceChoices, workspaceUniqueName, type Task, type WorkspaceEnvironment, type WorkspaceProfile } from '../src';

const task = (id: string, parentId: string | null = null): Task => ({ id, parentId, title: id, status: 'todo', ownerId: 'u', order: 0, createdAt: 1, updatedAt: 1, tags: [], important: false, urgent: false });
const profile = (id: string, taskId?: string): WorkspaceProfile => ({ id, taskId, name: id, config: EMPTY_WORKSPACE, promptTemplate: '', createdAt: 1, updatedAt: 1 });
const environment = (id: string, taskId: string, patch = {}): WorkspaceEnvironment => ({ id, taskId, config: EMPTY_WORKSPACE, state: 'ready', connectionHost: '', managed: true, resourceId: '', session: id, directory: '/repo', createdAt: 1, updatedAt: 1, ...patch });

describe('Workspace creation choices', () => {
  it('collects every ancestral template and instance, prioritizes the nearest node and preserves explicit bindings', () => {
    const data = { ...EMPTY_DATA, tasks: [task('project'), task('parent', 'project'), task('child', 'parent'), task('sibling', 'project')], workspaces: [{ id: 'parent', mode: 'inherit' as const, workspaceId: 'legacy', environmentId: 'bound' }] };
    const profiles = [profile('shared'), profile('root', 'project'), profile('own2', 'child'), profile('legacy'), profile('own1', 'child'), profile('unrelated', 'sibling')];
    const envs = [environment('root1', 'project'), environment('root2', 'project'), environment('own', 'child'), environment('bound', 'sibling'), environment('foreign', 'sibling'), environment('archived', 'parent', { archivedAt: 1 }), environment('cleared', 'parent', { dataClearedAt: 1 })];
    const selected = workspaceChoices(data, 'child', profiles, envs);
    expect(selected.profiles.filter(item => item.sourceId).map(item => item.value.id)).toEqual(['own2', 'own1', 'legacy', 'root']);
    expect(selected.environments.filter(item => item.sourceId).map(item => item.value.id)).toEqual(['own', 'bound', 'root1', 'root2']);
    expect(selected.environments.at(-1)?.value.id).toBe('foreign');
    expect(selected.source('child')).toBe('当前 Task');
    expect(selected.source('parent')).toBe('parent');
    expect(data.workspaces[0]?.environmentId).toBe('bound');
  });
  it('handles cyclic ancestry, deleted tasks and safe unique names', () => {
    const data = { ...EMPTY_DATA, tasks: [task('a', 'b'), task('b', 'a')] };
    expect(workspaceChoices(data, 'a', [profile('p', 'b')], []).profiles[0]?.sourceId).toBe('b');
    const name = workspaceUniqueName('agent', '实现功能 ../../feature hello', '12345678-abcd-abcd-1234-123456789abc');
    expect(name).toMatch(/^[a-z0-9][a-z0-9_-]{0,79}$/);
    expect(name).not.toContain('/');
    expect(name).not.toBe(workspaceUniqueName('agent', '实现功能 ../../feature hello', '87654321-abcd-abcd-1234-123456789abc'));
  });
});
