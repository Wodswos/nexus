import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  sortedWorkspaceLinks,
  workspaceLinkHref,
  workspaceLinkKey,
  workspaceLinkTarget,
} from '@nexus/core';
import { NexusStore } from '../src/store';

function exchange(a: NexusStore, b: NexusStore) {
  const first = Y.encodeStateAsUpdate(a.docs.links),
    second = Y.encodeStateAsUpdate(b.docs.links);
  Y.applyUpdate(a.docs.links, second, 'remote');
  Y.applyUpdate(b.docs.links, first, 'remote');
}

describe('task workspace persistence', () => {
  it('preserves legacy links, merges independent edits from two devices, and restores snapshots', () => {
    const a = new NexusStore('u'),
      b = new NexusStore('u'),
      restored = new NexusStore('u');
    try {
      a.importJSON({
        links: [
          {
            id: 'old',
            taskId: 'task',
            type: 'tmux',
            target: 'tmux://server/dev',
            serverId: 'server',
            session: 'dev',
            ownerId: 'u',
            createdAt: 1,
          },
        ],
      });
      const webpage = a.addLink('task', 'url', 'https://example.com/docs');
      exchange(a, b);
      a.updateLink('old', { title: '开发环境' });
      b.updateLink('old', { pinned: true });
      b.moveLink(webpage.id, -1);
      exchange(a, b);
      expect(a.getData().links).toEqual(b.getData().links);
      expect(a.getData().links.find((link) => link.id === 'old')).toMatchObject({
        title: '开发环境',
        pinned: true,
        serverId: 'server',
        session: 'dev',
        createdAt: 1,
      });
      expect(sortedWorkspaceLinks(a.getData().links, 'task').map((link) => link.id)).toEqual([
        'old',
        webpage.id,
      ]);
      restored.importJSON(a.exportSnapshot());
      expect(restored.getData().links).toEqual(a.getData().links);
      a.importJSON({
        links: [
          {
            id: 'old',
            title: 'old backup name',
            taskId: 'task',
            type: 'tmux',
            target: 'tmux://server/dev',
          },
        ],
      });
      expect(a.getData().links.find((link) => link.id === 'old')?.title).toBe('开发环境');
    } finally {
      a.destroy();
      b.destroy();
      restored.destroy();
    }
  });

  it('reorders old equal-ranked links, keeps pinned groups separate, and supports undo', () => {
    const store = new NexusStore('u');
    try {
      store.importJSON({
        links: ['a', 'b', 'c'].map((id) => ({
          id,
          taskId: 'task',
          type: 'url',
          target: `https://example.com/${id}`,
          createdAt: 1,
        })),
      });
      store.stopUndoCapture();
      store.moveLink('c', -1);
      store.stopUndoCapture();
      expect(sortedWorkspaceLinks(store.getData().links, 'task').map((link) => link.id)).toEqual([
        'a',
        'c',
        'b',
      ]);
      store.undo();
      expect(sortedWorkspaceLinks(store.getData().links, 'task').map((link) => link.id)).toEqual([
        'a',
        'b',
        'c',
      ]);
      store.updateLink('c', { pinned: true });
      store.moveLink('b', -1);
      expect(sortedWorkspaceLinks(store.getData().links, 'task').map((link) => link.id)).toEqual([
        'c',
        'b',
        'a',
      ]);
    } finally {
      store.destroy();
    }
  });

  it('deduplicates resources within a task while retaining independent references and task history', () => {
    const store = new NexusStore('u');
    try {
      const task = store.createTask({ title: 'work' }),
        other = store.createTask({ title: 'other' });
      const original = store.addLink(task.id, 'url', 'https://github.com/org/repo/pull/123');
      expect(
        store.addLink(task.id, 'github-pr', 'https://github.com/ORG/REPO/pull/123/files#diff'),
      ).toEqual(original);
      const shared = store.addLink(other.id, 'github-pr', original.target);
      store.setTaskStatus(task.id, 'done');
      store.softDeleteTask(task.id);
      store.restoreTask(task.id);
      expect(store.getData().links).toHaveLength(2);
      store.stopUndoCapture();
      store.removeLink(original.id);
      store.stopUndoCapture();
      expect(store.getData().links.map((link) => link.id)).toEqual([shared.id]);
      store.undo();
      expect(store.getData().links).toHaveLength(2);
    } finally {
      store.destroy();
    }
  });

  it('validates new metadata before importing any task and preserves new link types in plain JSON', () => {
    const store = new NexusStore('u'),
      restored = new NexusStore('u');
    try {
      for (const metadata of [{ pinned: 'yes' }, { order: 'first' }, { order: Infinity }]) {
        expect(() =>
          store.importJSON({
            tasks: [{ id: 'unexpected', title: 'must not import' }],
            links: [{ id: 'bad', type: 'dsh', ...metadata }],
          }),
        ).toThrow();
        expect(store.getData().tasks).toHaveLength(0);
      }
      store.addLink('task', 'dsh', 'dsh://sessions/dev');
      store.addLink('task', 'github-pr', 'https://github.example.com/org/repo/pull/1');
      restored.importJSON(store.exportJSON());
      expect(restored.getData().links).toEqual(store.getData().links);
    } finally {
      store.destroy();
      restored.destroy();
    }
  });
});

describe('workspace URL boundaries', () => {
  it('recognizes PR links, preserves useful deep links, and uses canonical PR identity', () => {
    expect(workspaceLinkTarget('url', ' https://github.com/org/repo/pull/123/files#diff ')).toEqual(
      { type: 'github-pr', target: 'https://github.com/org/repo/pull/123/files#diff' },
    );
    expect(workspaceLinkTarget('github-pr', 'https://git.example.com/org/repo/pull/1').type).toBe(
      'github-pr',
    );
    expect(workspaceLinkTarget('dsh', 'dsh://sessions/dev?window=2').target).toBe(
      'dsh://sessions/dev?window=2',
    );
    expect(workspaceLinkKey({ type: 'url', target: 'https://github.com/org/repo/pull/123' })).toBe(
      workspaceLinkKey({
        type: 'github-pr',
        target: 'https://github.com/ORG/REPO/pull/123/files#diff',
      }),
    );
  });

  it('blocks executable schemes and credential-bearing URLs for new and imported links', () => {
    for (const target of [
      'javascript:alert(1)',
      'data:text/html,test',
      'file:///etc/passwd',
      'https://user:password@example.com',
    ]) {
      for (const kind of ['url', 'github-pr', 'note', 'agent', 'dsh'] as const)
        expect(() => workspaceLinkTarget(kind, target)).toThrow();
      expect(workspaceLinkHref({ type: 'url', target } as any)).toBeUndefined();
    }
    expect(() => workspaceLinkTarget('github-pr', 'https://github.com/org/repo')).toThrow();
    expect(workspaceLinkHref({ type: 'url', target: 'dsh://sessions/dev' } as any)).toBeUndefined();
    expect(workspaceLinkTarget('note', 'obsidian://open?vault=work&file=doc').type).toBe(
      'obsidian',
    );
    expect(workspaceLinkHref({ type: 'url', target: 'agent://sessions/legacy-note' } as any)).toBe(
      'agent://sessions/legacy-note',
    );
  });
});
