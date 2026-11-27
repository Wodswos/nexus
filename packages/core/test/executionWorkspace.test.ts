import { describe, expect, it } from 'vitest';
import {
  EMPTY_WORKSPACE,
  resolveWorkspace,
  validateNodeWorkspace,
  validateWorkspaceConfig,
} from '../src/executionWorkspace';
import type { Task, NodeWorkspace, WorkspaceProfile } from '../src/index';
import { validateWorkspaceProfile } from '../src/workspaceProfiles';

const task = (
  id: string,
  parentId: string | null,
  kind: Task['kind'] = 'node',
): Task => ({
  id,
  parentId,
  kind,
  title: id,
  status: 'todo',
  order: 0,
  ownerId: 'u',
  important: false,
  urgent: false,
  tags: [],
  createdAt: 1,
  updatedAt: 1,
});

describe('execution workspace inheritance', () => {
  const tasks = [
    task('project', null),
    task('record', 'project'),
    task('leaf', 'record', 'todo'),
  ];
  const root: NodeWorkspace = {
    id: 'project',
    mode: 'override',
    runtime: 'docker',
    serverId: 'host',
    image: 'node:22',
    repository: 'https://github.com/org/repo.git',
    environmentId: 'env',
  };

  it('supports structural, leaf and content-bearing intermediate nodes with per-field sources', () => {
    const data = {
      tasks,
      workspaces: [
        root,
        { id: 'record', mode: 'override', ref: 'experiment' } as NodeWorkspace,
      ],
    };
    const result = resolveWorkspace(data, 'leaf');
    expect(result).toMatchObject({
      configured: true,
      disabled: false,
      config: { image: 'node:22', ref: 'experiment', serverId: 'host' },
      sources: { image: 'project', ref: 'record' },
      environmentId: 'env',
      environmentSource: 'project',
    });
    expect(resolveWorkspace(data, 'record').config).toEqual(result.config);
    expect(
      resolveWorkspace(
        { tasks: [task('alone', null)], workspaces: [] },
        'alone',
      ).config,
    ).toEqual(EMPTY_WORKSPACE);
  });

  it('clears fields explicitly, follows moves and respects disabled boundaries', () => {
    const workspaces: NodeWorkspace[] = [
      root,
      { id: 'record', mode: 'override', repository: null, environmentId: null },
    ];
    expect(resolveWorkspace({ tasks, workspaces }, 'leaf')).toMatchObject({
      config: { repository: '', image: 'node:22' },
      environmentId: null,
    });
    expect(
      resolveWorkspace(
        {
          tasks: tasks.map((value) =>
            value.id === 'leaf' ? { ...value, parentId: null } : value,
          ),
          workspaces,
        },
        'leaf',
      ).configured,
    ).toBe(false);
    workspaces[1] = { id: 'record', mode: 'disabled' };
    expect(resolveWorkspace({ tasks, workspaces }, 'leaf')).toMatchObject({
      disabled: true,
      configured: false,
      config: EMPTY_WORKSPACE,
      environmentId: null,
    });
    workspaces.push({ id: 'leaf', mode: 'override', serverId: 'another' });
    expect(resolveWorkspace({ tasks, workspaces }, 'leaf')).toMatchObject({
      disabled: false,
      configured: true,
      config: { runtime: 'ssh', serverId: 'another', image: '' },
    });
  });

  it('inherits reusable profiles and prompts while keeping task binding environment selection explicit', () => {
    const profile: WorkspaceProfile = { id: 'shared', name: 'Shared', config: { ...EMPTY_WORKSPACE, runtime: 'kubernetes', kubeConnectionId: 'cluster', image: 'node:24', namespace: 'team' }, promptTemplate: 'Task {{task_title}}: {{task_context_url}}', createdAt: 1, updatedAt: 1 };
    const data = { tasks, workspaceProfiles: [profile], workspaces: [
      root,
      { id: 'record', mode: 'override', workspaceId: profile.id, ref: 'feature' } as NodeWorkspace,
    ] };
    const resolved = resolveWorkspace(data, 'leaf');
    expect(resolved).toMatchObject({ configured: true, workspaceId: 'shared', workspaceSource: 'record', promptTemplate: profile.promptTemplate, config: { runtime: 'kubernetes', kubeConnectionId: 'cluster', serverId: '', ref: 'feature' }, environmentId: 'env', environmentSource: 'project' });
    expect(() => validateWorkspaceConfig(resolved.config)).not.toThrow();
    data.workspaces.push({ id: 'leaf', mode: 'inherit', environmentId: 'current-environment' });
    expect(resolveWorkspace(data, 'leaf').environmentSource).toBe('leaf');
    data.workspaces[1] = { id: 'record', mode: 'disabled' };
    expect(resolveWorkspace(data, 'leaf')).toMatchObject({ configured: false, disabled: true, workspaceId: null, promptTemplate: '' });
  });

  it('keeps missing or deleted profile references disabled even when descendant fields override configuration', () => {
    const profile: WorkspaceProfile = { id: 'gone', name: 'Gone', config: { ...EMPTY_WORKSPACE, serverId: 'host' }, promptTemplate: 'old prompt', createdAt: 1, updatedAt: 1, deletedAt: 2 };
    const workspaces: NodeWorkspace[] = [root, { id: 'record', mode: 'inherit', workspaceId: 'gone' }, { id: 'leaf', mode: 'override', serverId: 'other', environmentId: 'old-env' }];
    const data = { tasks, workspaces, workspaceProfiles: [profile] };
    expect(resolveWorkspace(data, 'leaf')).toMatchObject({ disabled: true, configured: false, workspaceId: 'gone', promptTemplate: '', environmentId: null, config: EMPTY_WORKSPACE });
    expect(resolveWorkspace({ ...data, workspaceProfiles: [] }, 'leaf').disabled).toBe(true);
    workspaces[2] = { id: 'leaf', mode: 'override', workspaceId: null, serverId: 'other' };
    expect(resolveWorkspace(data, 'leaf')).toMatchObject({ disabled: false, configured: true, workspaceId: null, config: { serverId: 'other' } });
    workspaces[2] = { id: 'leaf', mode: 'inherit', workspaceId: 'valid' };
    data.workspaceProfiles.push({ ...profile, id: 'valid', deletedAt: null });
    expect(resolveWorkspace(data, 'leaf')).toMatchObject({ disabled: false, configured: true, workspaceId: 'valid', promptTemplate: 'old prompt' });
  });

  it('rejects malformed profiles and secrets while accepting partial non-executable configuration drafts', () => {
    const profile = { id: 'profile', name: 'Draft', config: { runtime: 'ssh' }, promptTemplate: '', createdAt: 1, updatedAt: 1 };
    expect(() => validateWorkspaceProfile(profile)).not.toThrow();
    for (const config of [{ token: 'secret' }, { serverId: null }, { runtime: 'bad' }, { directory: '\0' }]) expect(() => validateWorkspaceProfile({ ...profile, config })).toThrow();
    expect(() => validateWorkspaceProfile({ ...profile, promptTemplate: 123 })).toThrow();
  });

  it('validates partial overrides and complete runtime configurations before execution', () => {
    expect(() =>
      validateNodeWorkspace({ id: 'leaf', mode: 'override', image: null }),
    ).not.toThrow();
    for (const patch of [
      { mode: 'bad' },
      { image: 3 },
      { password: 'secret' },
      { runtime: 'bad' },
      { directory: '\0' },
    ])
      expect(() =>
        validateNodeWorkspace({ id: 'leaf', mode: 'override', ...patch }),
      ).toThrow();
    for (const patch of [
      { serverId: '' },
      { runtime: 'docker' },
      { repository: 'https://token@github.com/org/repo' },
      { repository: 'file:///tmp/repo' },
      { directory: 'relative' },
      { image: '--privileged' },
      { ref: '--upload-pack=bad' },
      { runtime: 'kubernetes', image: 'node:22', namespace: 'bad/name' },
    ])
      expect(() =>
        validateWorkspaceConfig({
          ...EMPTY_WORKSPACE,
          serverId: 'host',
          ...patch,
        } as typeof EMPTY_WORKSPACE),
      ).toThrow();
    expect(() =>
      validateWorkspaceConfig({
        ...EMPTY_WORKSPACE,
        serverId: 'host',
        repository: 'git@github.com:org/repo.git',
      }),
    ).not.toThrow();
  });
});
