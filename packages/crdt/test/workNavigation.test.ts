import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { NexusStore } from '../src/store';

describe('work navigation defaults', () => {
  it('upgrades legacy view settings without writing over synchronization and keeps removal after reload/import', () => {
    const a = new NexusStore('work-user'), b = new NexusStore('work-user');
    try {
      a.importJSON({ settings: { savedViews: [{ id: 'calendar', name: '日历', view: 'timeline', scope: 'month' }] } });
      expect(a.getData().settings.savedViews.map((view) => view.id)).toEqual(['week-work', 'calendar']);
      a.updateSettings({ savedViews: a.getData().settings.savedViews.filter((view) => view.id !== 'week-work') });
      expect(a.getData().settings.workNavigationVersion).toBe(1);
      expect(a.getData().settings.savedViews.map((view) => view.id)).toEqual(['calendar']);
      Y.applyUpdate(b.docs.root, Y.encodeStateAsUpdate(a.docs.root));
      expect(b.getData().settings.savedViews.map((view) => view.id)).toEqual(['calendar']);
      b.importJSON(a.exportJSON());
      expect(b.getData().settings.savedViews.map((view) => view.id)).toEqual(['calendar']);
    } finally { a.destroy(); b.destroy(); }
  });
});
