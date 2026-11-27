import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { EMPTY_WORKSPACE, resolveWorkspace, type WorkspaceProfile } from '@nexus/core';
import { NexusStore } from '../src/store';

const profile = (id = 'shared'): WorkspaceProfile => ({ id, name: '开发环境', config: { ...EMPTY_WORKSPACE, serverId: 'host', directory: '/repo' }, promptTemplate: '处理 {{task_title}}', createdAt: 1, updatedAt: 1 });

describe('reusable workspace profiles', () => {
  it('inherits template and instance independently, preserves overrides and restores inheritance across reload', () => {
    const store = new NexusStore('alice'), restored = new NexusStore('alice');
    try {
      const parent = store.createTask({ title: 'Parent' }), child = store.createTask({ title: 'Child', parentId: parent.id }), leaf = store.createTask({ title: 'Leaf', parentId: child.id }), sibling = store.createTask({ title: 'Sibling', parentId: parent.id });
      store.saveWorkspaceProfile(profile('one')); store.saveWorkspaceProfile(profile('two'));
      store.setWorkspace(parent.id, { workspaceId: 'one', environmentId: 'env-one' });
      store.setWorkspace(child.id, { workspaceId: 'two' });
      expect(resolveWorkspace(store.getData(), leaf.id)).toMatchObject({ workspaceId: 'two', environmentId: 'env-one' });
      store.setWorkspace(child.id, { environmentId: 'env-two' });
      store.setWorkspace(parent.id, { environmentId: 'env-new' });
      expect(resolveWorkspace(store.getData(), sibling.id)).toMatchObject({ workspaceId: 'one', environmentId: 'env-new' });
      expect(resolveWorkspace(store.getData(), leaf.id)).toMatchObject({ workspaceId: 'two', environmentId: 'env-two' });
      store.setWorkspace(child.id, { workspaceId: undefined, environmentId: undefined });
      restored.importJSON(store.exportJSON());
      expect(resolveWorkspace(restored.getData(), leaf.id)).toMatchObject({ workspaceId: 'one', environmentId: 'env-new' });
      store.setWorkspace(child.id, { environmentId: null });
      expect(resolveWorkspace(store.getData(), leaf.id)).toMatchObject({ workspaceId: 'one', environmentId: null });
    } finally { store.destroy(); restored.destroy(); }
  });
  it('inherits reusable config through text and TODO nodes, allows field overrides and disable boundaries', () => {
    const store = new NexusStore('alice');
    try {
      const parent = store.createTask({ title: '项目' }), child = store.createTask({ title: '记录', parentId: parent.id }), leaf = store.createTask({ title: '执行', parentId: child.id });
      store.saveWorkspaceProfile(profile());
      store.setWorkspace(parent.id, { mode: 'inherit', workspaceId: 'shared' });
      store.setWorkspace(child.id, { mode: 'override', directory: '/different' });
      expect(resolveWorkspace(store.getData(), leaf.id)).toMatchObject({ workspaceId: 'shared', promptTemplate: '处理 {{task_title}}', config: { serverId: 'host', directory: '/different' } });
      store.setWorkspace(child.id, { mode: 'disabled' });
      expect(resolveWorkspace(store.getData(), leaf.id)).toMatchObject({ disabled: true, workspaceId: null });
      store.setWorkspace(child.id, { mode: 'inherit', workspaceId: null });
      expect(resolveWorkspace(store.getData(), leaf.id).workspaceId).toBeNull();
    } finally { store.destroy(); }
  });
  it('preserves profiles across sync, JSON export/import and rejects stale updates or deleting referenced config', () => {
    const a = new NexusStore('alice'), b = new NexusStore('alice'), restored = new NexusStore('alice');
    try {
      const root = a.createTask({ title: 'Root' });
      a.saveWorkspaceProfile(profile());
      a.setWorkspace(root.id, { workspaceId: 'shared' });
      for (const name of ['root', 'tasks'] as const) Y.applyUpdate(b.docs[name], Y.encodeStateAsUpdate(a.docs[name]));
      expect(b.getData().workspaceProfiles).toEqual([profile()]);
      restored.importJSON(a.exportJSON());
      expect(restored.getData().workspaceProfiles).toEqual([profile()]);
      a.saveWorkspaceProfile({ ...profile(), name: 'Updated', updatedAt: 2 }, 1);
      expect(() => a.saveWorkspaceProfile({ ...profile(), name: 'Stale', updatedAt: 3 }, 1)).toThrow(/其他设备/);
      expect(() => a.deleteWorkspaceProfile('shared')).toThrow(/引用/);
      a.setWorkspace(root.id, { workspaceId: null });
      a.deleteWorkspaceProfile('shared', 2);
      expect(a.getData().workspaceProfiles![0]!.deletedAt).toEqual(expect.any(Number));
    } finally { a.destroy(); b.destroy(); restored.destroy(); }
  });
  it('validates an entire import before modifying data and rejects embedded credential fields', () => {
    const store = new NexusStore('alice');
    try {
      expect(() => store.importJSON({ workspaceProfiles: [profile(), { ...profile('bad'), config: { ...EMPTY_WORKSPACE, token: 'secret' } }] })).toThrow();
      expect(store.getData().workspaceProfiles).toEqual([]);
    } finally { store.destroy(); }
  });
});
