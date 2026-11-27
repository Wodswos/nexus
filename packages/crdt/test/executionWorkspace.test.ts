import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { resolveWorkspace } from '@nexus/core';
import { NexusStore } from '../src/store';

describe('execution workspace persistence', () => {
  it('merges independent fields and preserves JSON, binary snapshots and undo', () => {
    const a = new NexusStore('u'),
      b = new NexusStore('u'),
      json = new NexusStore('u'),
      binary = new NexusStore('u');
    try {
      const parent = a.createProject('Project');
      const leaf = a.createTask({
        title: 'content',
        parentId: parent.id,
        kind: 'node',
        notes: 'data',
      });
      a.setWorkspace(parent.id, {
        mode: 'override',
        runtime: 'docker',
        serverId: 'host',
        image: 'node:22',
      });
      b.importJSON(a.exportSnapshot());
      a.setWorkspace(leaf.id, { mode: 'override', ref: 'work' });
      b.setWorkspace(leaf.id, { mode: 'override', directory: '/experiment' });
      const left = Y.encodeStateAsUpdate(a.docs.root),
        right = Y.encodeStateAsUpdate(b.docs.root);
      Y.applyUpdate(a.docs.root, right, 'remote');
      Y.applyUpdate(b.docs.root, left, 'remote');
      expect(a.getData().workspaces).toEqual(b.getData().workspaces);
      expect(resolveWorkspace(a.getData(), leaf.id).config).toMatchObject({
        image: 'node:22',
        ref: 'work',
        directory: '/experiment',
      });
      json.importJSON(a.exportJSON());
      binary.importJSON(a.exportSnapshot());
      expect(json.getData().workspaces).toEqual(a.getData().workspaces);
      expect(binary.getData().workspaces).toEqual(a.getData().workspaces);
      a.setWorkspace(leaf.id, { ref: undefined, directory: null });
      expect(resolveWorkspace(a.getData(), leaf.id).config).toMatchObject({
        ref: '',
        directory: '',
      });
      a.undo();
      expect(resolveWorkspace(a.getData(), leaf.id).config).toMatchObject({
        ref: 'work',
        directory: '/experiment',
      });
      a.redo();
      expect(resolveWorkspace(a.getData(), leaf.id).config).toMatchObject({
        ref: '',
        directory: '',
      });
    } finally {
      for (const store of [a, b, json, binary]) store.destroy();
    }
  });

  it('checks conflicts and invalid input before any CRDT writes, and accepts legacy backups', () => {
    const store = new NexusStore('u');
    try {
      store.importJSON({ tasks: [{ id: 'legacy', title: 'legacy' }] });
      expect(store.getData().workspaces).toEqual([]);
      store.setWorkspace('legacy', { mode: 'override', serverId: 'host' });
      const baseline = store.getData().workspaces[0]!;
      store.setWorkspace('legacy', { image: 'new' });
      expect(() =>
        store.setWorkspace('legacy', { image: 'stale' }, baseline),
      ).toThrow(/其他设备/);
      store.setWorkspace('legacy', { directory: '/allowed' }, baseline);
      const before = store.exportJSON();
      expect(() =>
        store.setWorkspace('legacy', {
          mode: 'invalid' as 'inherit',
          image: 'broken',
        }),
      ).toThrow();
      expect(store.exportJSON()).toEqual(before);
      expect(() =>
        store.setWorkspace('missing', { mode: 'override' }),
      ).toThrow();
      store.importJSON({ workspaces: [{ id: 'legacy', mode: 'disabled' }] });
      expect(store.getData().workspaces[0]!.mode).toBe('override');
    } finally {
      store.destroy();
    }
  });
});
