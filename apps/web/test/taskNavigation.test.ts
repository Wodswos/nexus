import { describe, expect, it } from 'vitest';
import { EMPTY_DATA, type Task, type NexusData } from '@nexus/core';
import { taskCurrentViewHref, taskPath, taskSavedViewHref, taskViewHref } from '../src/features/tasks/taskNavigation';
import { isScheduledOnlyWorkspace } from '../src/features/tasks/taskWindow';
import { selectWorkspaceTasks, workspaceCanvasWindow } from '../src/features/tasks/taskFilters';

const task = (id: string, patch: Partial<Task> = {}): Task => ({ id, title: id, status: 'todo', parentId: null, ownerId: 'u', order: 0, tags: [], important: false, urgent: false, createdAt: 1, updatedAt: 1, ...patch });
const data = (tasks: Task[]): NexusData => ({ ...EMPTY_DATA, tasks, settings: { ...EMPTY_DATA.settings } });
const params = (href: string | null) => new URL(href!, 'https://nexus.test').searchParams;

describe('task navigation', () => {
  it('locates a nested task within its real project, with no inherited time or priority filters', () => {
    const values = data([task('p', { kind: 'node', project: true }), task('group', { parentId: 'p', kind: 'node' }), task('leaf', { parentId: 'group' })]);
    expect(taskPath(values.tasks, 'leaf').map(task => task.id)).toEqual(['leaf', 'group', 'p']);
    expect(Object.fromEntries(params(taskViewHref(values, 'leaf', 'mindmap')))).toEqual({ project: 'p', scope: 'all', view: 'mindmap', focusTask: 'leaf' });
  });
  it('uses a standalone branch without turning current tasks into an undated workspace', () => {
    const values = data([task('parent'), task('leaf', { parentId: 'parent' })]);
    const target = params(taskViewHref(values, 'leaf', 'list'));
    expect(target.get('root')).toBe('parent');
    expect(isScheduledOnlyWorkspace(target, values.settings)).toBe(false);
    expect(isScheduledOnlyWorkspace(new URLSearchParams('view=list'), values.settings)).toBe(true);
  });
  it('opens the exact task day and puts unscheduled work in the undated calendar tray', () => {
    const values = data([task('dated', { startAt: new Date(2026, 10, 1, 8).getTime(), dueAt: new Date(2026, 10, 9, 18).getTime() }), task('undated')]);
    expect(Object.fromEntries(params(taskViewHref(values, 'dated', 'timeline')))).toMatchObject({ scope: 'custom', from: '2026-11-09', to: '2026-11-09' });
    expect(params(taskViewHref(values, 'undated', 'timeline')).get('scope')).toBe('undated');
  });
  it('uses linked calendar events for tasks without explicit dates', () => {
    const values = data([task('linked')]);
    const stamp = new Date(2026, 10, 9, 9).getTime();
    values.events = [{ id: 'event', taskId: 'linked', title: 'meeting', kind: 'meeting', start: stamp, end: stamp + 3600000, ownerId: 'u', createdAt: 1, updatedAt: 1 }];
    expect(params(taskViewHref(values, 'linked', 'timeline', stamp - 1000)).get('from')).toBe('2026-11-09');
  });
  it('rejects deleted, archived, inbox, orphan and cyclic paths without promoting structural dates', () => {
    const values = data([task('deleted', { deletedAt: 2 }), task('archived', { status: 'archived' }), task('inbox', { status: 'inbox' }), task('orphan', { parentId: 'missing' }), task('a', { parentId: 'b' }), task('b', { parentId: 'a' }), task('node', { kind: 'node', project: true })]);
    for (const id of ['missing', 'deleted', 'archived', 'inbox', 'orphan', 'a']) expect(taskViewHref(values, id, 'mindmap')).toBeNull();
    expect(taskViewHref(values, 'node', 'timeline')).toBeNull();
  });
  it('reveals only the requested completed task and keeps project boundaries intact', () => {
    const values = data([task('p', { kind: 'node', project: true }), task('done', { parentId: 'p', status: 'done' }), task('other-done', { parentId: 'p', status: 'done' }), task('foreign', { status: 'done' })]);
    values.settings.completedDisplay = 'hidden';
    const target = params(taskViewHref(values, 'done', 'mindmap'));
    expect([...selectWorkspaceTasks(values, target, new Date()).matching]).toEqual(['done']);
    target.set('focusTask', 'foreign');
    expect([...selectWorkspaceTasks(values, target, new Date()).matching]).toEqual([]);
    expect(values.settings.completedDisplay).toBe('hidden');
  });
  it('supports all five project views and never gives a structural node a task-only destination', () => {
    const values = data([task('p', { kind: 'node', project: true }), task('leaf', { parentId: 'p' })]);
    for (const view of ['list', 'mindmap', 'matrix', 'gantt', 'timeline'] as const) expect(params(taskViewHref(values, 'leaf', view)).get('project')).toBe('p');
    for (const view of ['matrix', 'gantt', 'timeline'] as const) expect(taskViewHref(values, 'p', view)).toBeNull();
  });
  it('keeps shortcut filters and project boundaries while moving the visible calendar to a past target', () => {
    const values = data([task('p', { kind: 'node', project: true }), task('other', { kind: 'node', project: true }), task('leaf', { parentId: 'p', dueAt: new Date(2026, 8, 8, 18).getTime() })]);
    const saved = { id: 'saved', name: '月历', view: 'timeline', scope: 'month', projectId: 'p', taskStatus: 'doing', taskPriority: 'high' } as const;
    const destination = params(taskSavedViewHref(values, 'leaf', saved, new Date(2026, 10, 9).getTime()));
    expect(Object.fromEntries(destination)).toMatchObject({ saved: 'saved', project: 'p', view: 'timeline', scope: 'custom', from: '2026-09-01', to: '2026-09-30', taskStatus: 'doing', taskPriority: 'high', focusTask: 'leaf' });
    expect(saved.scope).toBe('month');
    expect(taskSavedViewHref(values, 'leaf', { ...saved, projectId: 'other' })).toBeNull();
  });
  it('can locate unscheduled work in a temporal shortcut or current tasks without inventing dates', () => {
    const values = data([task('leaf')]);
    expect(params(taskSavedViewHref(values, 'leaf', { id: 'saved', name: '周计划', view: 'gantt', scope: 'week' })).get('view')).toBe('list');
    expect(Object.fromEntries(params(taskCurrentViewHref(values, 'leaf')))).toMatchObject({ view: 'list', scope: 'week', focusTask: 'leaf' });
    expect(values.tasks[0]!.dueAt).toBeUndefined();
  });
  it('locates the calendar marker date even when a long task overlaps the shortcut month', () => {
    const values = data([task('long', { startAt: new Date(2026, 0, 1).getTime(), dueAt: new Date(2026, 11, 9, 18).getTime() })]);
    const destination = params(taskSavedViewHref(values, 'long', { id: 'month', name: '月历', view: 'timeline', scope: 'month' }, new Date(2026, 10, 9).getTime()));
    expect(Object.fromEntries(destination)).toMatchObject({ from: '2026-12-01', to: '2026-12-31', scope: 'custom' });
  });
  it('keeps a historic focus target inside Gantt and calendar canvases spanning multiple years', () => {
    const historic = new Date(2020, 0, 9, 18).getTime();
    const values = data([task('old', { dueAt: historic }), task('new', { dueAt: new Date(2026, 10, 9, 18).getTime() })]);
    for (const view of ['gantt', 'timeline']) {
      const range = workspaceCanvasWindow(values, new URLSearchParams({ scope: 'all', view, focusTask: 'old' }), new Date(2026, 10, 9), { scope: 'week', start: 0, days: 7 });
      expect(range.start).toBeLessThanOrEqual(historic);
      expect(new Date(range.start).getFullYear()).toBe(2020);
    }
  });
});
