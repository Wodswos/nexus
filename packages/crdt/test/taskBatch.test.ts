import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { buildChildrenMap, dayKeyOf, isProject, needsPriorityReview, planTaskBatch } from '@nexus/core';
import { NexusStore } from '../src/store';

const stamp = (day: string, time = '09:00') => new Date(`${day}T${time}:00`).getTime();

describe('batch task settings', () => {
  it('creates and converts standalone text leaves while preserving existing project identities', () => {
    const store = new NexusStore('u');
    const leaf = store.createTask({ title: 'Recorded result', kind: 'node', notes: '42' });
    expect(leaf).toMatchObject({ kind: 'node', project: false, parentId: null, status: 'todo', notes: '42' });
    const single = store.createTask({ title: 'single', status: 'done', completedAt: 100, dueAt: 200 });
    store.setTaskKind(single.id, 'node');
    expect(store.getData().tasks.find(task => task.id === single.id)).toMatchObject({ kind: 'node', project: false, status: 'done', completedAt: 100, dueAt: 200 });
    const direct = store.createTask({ title: 'direct', status: 'todo' });
    store.updateTask(direct.id, { kind: 'node' });
    expect(isProject(store.getData().tasks.find(task => task.id === direct.id)!)).toBe(false);
    const archived = store.createTask({ title: 'archived record', status: 'archived' });
    store.setTaskKind(archived.id, 'node');
    expect(store.getData().tasks.find(task => task.id === archived.id)).toMatchObject({ kind: 'node', project: false, status: 'archived' });
    store.importJSON({ tasks: [{ id: 'legacy-project', title: 'legacy', kind: 'node', parentId: null }] });
    store.setTaskKind('legacy-project', 'todo');
    store.updateTask('legacy-project', { notes: 'retain project' });
    expect(isProject(store.getData().tasks.find(task => task.id === 'legacy-project')!)).toBe(true);
    expect(isProject(store.createProject('explicit project'))).toBe(true);
    store.destroy();
  });

  it('converts tasks and groups atomically without changing projects, descendants or task data', () => {
    const store = new NexusStore('u');
    const project = store.createProject('Project');
    const a = store.createTask({ title: 'A', status: 'done', completedAt: 123, parentId: project.id, startAt: 1000, dueAt: 2000, priority: 'P1', notes: 'keep', tags: ['t'], mindFontSize: 20 });
    const child = store.createTask({ title: 'unselected', parentId: a.id });
    const root = store.createTask({ title: 'ordinary root', status: 'todo' });
    const group = store.createTask({ title: 'root group', kind: 'node', project: false });
    const deleted = store.createTask({ title: 'deleted' }); store.softDeleteTask(deleted.id);
    const archived = store.createTask({ title: 'archived', status: 'archived' });
    const before = store.getData().tasks;
    let updates = 0; store.onDocUpdate = id => { if (id === 'tasks') updates++; };
    expect(store.setTaskKinds([project.id, a.id, root.id, a.id, group.id, deleted.id, archived.id, 'missing'], 'node')).toBe(2);
    expect(updates).toBe(1);
    const converted = store.getData().tasks;
    expect(converted.find(task => task.id === a.id)).toMatchObject({ ...before.find(task => task.id === a.id)!, kind: 'node', project: false, updatedAt: expect.any(Number) });
    expect(converted.find(task => task.id === root.id)).toMatchObject({ kind: 'node', project: false, parentId: null });
    for (const task of [project, child, group, archived]) expect(converted.find(value => value.id === task.id)).toEqual(task);
    store.undo(); expect(store.getData().tasks).toEqual(before);
    store.redo(); expect(store.getData().tasks).toEqual(converted);
    expect(store.setTaskKinds([project.id, a.id, root.id, group.id], 'todo')).toBe(3);
    expect(store.getData().tasks.find(task => task.id === a.id)).toMatchObject({ ...before.find(task => task.id === a.id)!, updatedAt: expect.any(Number) });
    expect(store.getData().tasks.find(task => task.id === project.id)).toEqual(project);
    store.undo(); expect(store.getData().tasks).toEqual(converted);
    store.destroy();
  });

  it('does not create undo records for unchanged types and rejects an invalid target before writing', () => {
    const store = new NexusStore('u');
    const a = store.createTask({ title: 'A', kind: 'todo' });
    const before = store.exportJSON();
    let updates = 0; store.onDocUpdate = () => updates++;
    expect(store.setTaskKinds([a.id], 'todo')).toBe(0);
    expect(() => store.setTaskKinds([a.id], 'invalid' as 'node')).toThrow();
    expect(updates).toBe(0);
    expect(store.exportJSON()).toEqual(before);
    store.destroy();
  });

  it('deduplicates targets, excludes structure, changes no descendants and undoes as a single independent operation', () => {
    const store = new NexusStore('u');
    const project = store.createProject('Project');
    const parent = store.createTask({ title: 'parent', parentId: project.id, priority: 'P3' });
    const child = store.createTask({ title: 'unselected child', parentId: parent.id, priority: 'P2' });
    const other = store.createTask({ title: 'other', priority: 'P0' });
    const deleted = store.createTask({ title: 'deleted' }); store.softDeleteTask(deleted.id);
    const before = store.getData().tasks;
    let updates = 0;
    store.onDocUpdate = id => { if (id === 'tasks') updates++; };
    const plan = store.setTaskBatch([parent.id, other.id, project.id, parent.id, deleted.id, 'missing'], { priority: 'P1' });
    expect(plan).toMatchObject({ eligible: 2, skipped: 3 });
    expect(updates).toBe(1);
    expect(store.getData().tasks.find(task => task.id === parent.id)).toMatchObject({ priority: 'P1', important: true, urgent: false });
    expect(store.getData().tasks.find(task => task.id === child.id)).toEqual(child);
    expect(store.getData().tasks.find(task => task.id === project.id)).toEqual(project);
    expect(store.undo()).toBe(true);
    expect(store.getData().tasks).toEqual(before);
    store.redo();
    expect(store.getData().tasks.find(task => task.id === other.id)?.priority).toBe('P1');
    store.destroy();
  });

  it('preserves per-task times, absent endpoints, completion and unrelated fields, and supports explicit shared time and clearing', () => {
    const store = new NexusStore('u');
    const a = store.createTask({ title: 'A', status: 'done', completedAt: 123, startAt: stamp('2026-11-01'), dueAt: stamp('2026-11-03', '18:30'), notes: 'keep' });
    const b = store.createTask({ title: 'B', dueAt: null });
    store.setTaskBatch([a.id, b.id], { dueAt: { action: 'set', date: '2026-11-06' } });
    expect(store.getData().tasks.find(task => task.id === a.id)).toMatchObject({ startAt: a.startAt, dueAt: stamp('2026-11-06', '18:30'), completedAt: 123, status: 'done', notes: 'keep' });
    expect(store.getData().tasks.find(task => task.id === b.id)).toMatchObject({ startAt: null, dueAt: stamp('2026-11-06', '23:59') });
    store.setTaskBatch([a.id, b.id], { startAt: { action: 'set', date: '2026-11-04', time: '10:00' }, dueAt: { action: 'set', date: '2026-11-05', time: '17:00' } });
    for (const task of store.getData().tasks) expect(task).toMatchObject({ startAt: stamp('2026-11-04', '10:00'), dueAt: stamp('2026-11-05', '17:00') });
    store.setTaskBatch([a.id, b.id], { startAt: { action: 'clear' }, dueAt: { action: 'clear' } });
    expect(store.getData().tasks.find(task => task.id === a.id)).toMatchObject({ startAt: null, dueAt: null, status: 'done', completedAt: 123 });
    store.destroy();
  });

  it('validates all date ranges and input before writing anything, and avoids writes for unchanged values', () => {
    const store = new NexusStore('u');
    const a = store.createTask({ title: 'A', startAt: stamp('2026-11-01'), dueAt: stamp('2026-11-30'), priority: 'P1' });
    const b = store.createTask({ title: 'B conflict', startAt: stamp('2026-11-20'), dueAt: stamp('2026-11-30') });
    const before = store.exportJSON();
    let updates = 0; store.onDocUpdate = () => updates++;
    for (const edit of [{ action: 'set', date: '2026-11-10' }, { action: 'set', date: '2026-02-30' }, { action: 'set', date: '2026-11-30', time: '25:00' }] as const) {
      expect(() => store.setTaskBatch([a.id, b.id], { dueAt: edit })).toThrow();
      expect(store.exportJSON()).toEqual(before);
    }
    const plan = store.setTaskBatch([a.id], { priority: 'P1' });
    expect(plan.writes).toHaveLength(0);
    expect(updates).toBe(0);
    expect(needsPriorityReview(store.getData().tasks.find(task => task.id === b.id)!)).toBe(true);
    expect(store.setTaskBatch([b.id], { priority: 'P3' }).writes).toHaveLength(1);
    expect(needsPriorityReview(store.getData().tasks.find(task => task.id === b.id)!)).toBe(false);
    store.undo();
    expect(needsPriorityReview(store.getData().tasks.find(task => task.id === b.id)!)).toBe(true);
    store.destroy();
  });

  it('shifts calendar days across month boundaries while retaining times and missing dates', () => {
    const store = new NexusStore('u');
    const a = store.createTask({ title: 'A', startAt: stamp('2026-12-31', '23:30'), dueAt: stamp('2027-01-02', '17:15') });
    const b = store.createTask({ title: 'B', dueAt: stamp('2026-12-31', '18:00') });
    const c = store.createTask({ title: 'unscheduled' });
    const plan = store.setTaskBatch([a.id, b.id, c.id], { shiftDays: 1 });
    expect(plan).toMatchObject({ eligible: 2, skipped: 1 });
    expect(store.getData().tasks.find(task => task.id === a.id)).toMatchObject({ startAt: stamp('2027-01-01', '23:30'), dueAt: stamp('2027-01-03', '17:15') });
    expect(store.getData().tasks.find(task => task.id === b.id)).toMatchObject({ startAt: null, dueAt: stamp('2027-01-01', '18:00') });
    expect(store.getData().tasks.find(task => task.id === c.id)).toEqual(c);
    store.destroy();
  });

  it('uses calendar days over DST and rejects a nonexistent local time rather than silently moving it', () => {
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== 'America/New_York') return;
    const store = new NexusStore('u');
    const a = store.createTask({ title: 'DST', dueAt: stamp('2026-03-07', '12:00') });
    store.setTaskBatch([a.id], { shiftDays: 1 });
    const due = store.getData().tasks[0]!.dueAt!;
    expect(dayKeyOf(due)).toBe('2026-03-08');
    expect(new Date(due).getHours()).toBe(12);
    expect(due - a.dueAt!).toBe(23 * 3600000);
    expect(() => planTaskBatch([a], [a.id], { dueAt: { action: 'set', date: '2026-03-08', time: '02:30' } })).toThrow(/夏令时/);
    store.setTaskBatch([a.id], { dueAt: { action: 'set', date: '2026-03-09', time: '02:30' } });
    expect(store.getData().tasks[0]?.dueAt).toBe(stamp('2026-03-09', '02:30'));
    store.destroy();
  });

  it('detects conflicts before applying while merging unrelated remote changes, and undo preserves them', () => {
    const local = new NexusStore('u'), remote = new NexusStore('u');
    const a = local.createTask({ title: 'A', priority: 'P3' });
    Y.applyUpdate(remote.docs.tasks, Y.encodeStateAsUpdate(local.docs.tasks), 'remote');
    const baseline = local.getData().tasks;
    remote.updateTask(a.id, { title: 'remote title' });
    Y.applyUpdate(local.docs.tasks, Y.encodeStateAsUpdate(remote.docs.tasks), 'remote');
    local.setTaskBatch([a.id], { priority: 'P1' }, baseline);
    local.undo();
    expect(local.getData().tasks[0]).toMatchObject({ title: 'remote title', priority: 'P3' });
    const changed = local.getData().tasks;
    local.updateTask(a.id, { dueAt: 456 });
    expect(() => local.setTaskBatch([a.id], { dueAt: { action: 'clear' } }, changed)).toThrow(/发生变化/);
    expect(local.getData().tasks[0]?.dueAt).toBe(456);
    local.destroy(); remote.destroy();
  });
});

describe('moving selected task branches', () => {
  it('moves the whole selection in source order in one transaction, retaining selected descendants and undo history', () => {
    const store = new NexusStore('u');
    const project = store.createProject('Project');
    const a = store.createTask({ title: 'A', parentId: project.id, order: 0 });
    const child = store.createTask({ title: 'child', parentId: a.id });
    const b = store.createTask({ title: 'B', parentId: project.id, order: 1 });
    const target = store.createTask({ title: 'target', parentId: project.id, order: 2 });
    const existing = store.createTask({ title: 'existing', parentId: target.id });
    const before = store.getData().tasks;
    let updates = 0;
    store.onDocUpdate = id => { if (id === 'tasks') updates++; };
    expect(store.reparentTasks([b.id, child.id, a.id, b.id], target.id)).toBe(2);
    expect(updates).toBe(1);
    const moved = store.getData().tasks;
    expect(buildChildrenMap(moved).get(target.id)!.map(task => task.id)).toEqual([existing.id, a.id, b.id]);
    expect(moved.find(task => task.id === child.id)).toEqual(child);
    store.undo(); expect(store.getData().tasks).toEqual(before);
    store.redo(); expect(store.getData().tasks).toEqual(moved);
    store.destroy();
  });

  it('rejects an invalid destination for the entire batch and preserves exact insertion with exhausted numeric gaps', () => {
    const store = new NexusStore('u');
    const a = store.createTask({ title: 'A', status: 'todo' });
    const child = store.createTask({ title: 'child', parentId: a.id });
    const b = store.createTask({ title: 'B', status: 'todo', order: 1 });
    const before = store.exportJSON();
    expect(store.reparentTasks([a.id, b.id], child.id)).toBe(0);
    expect(store.reparentTasks([a.id, b.id], 'missing')).toBe(0);
    expect(store.exportJSON()).toEqual(before);
    const target = store.createTask({ title: 'target', status: 'todo' });
    const first = store.createTask({ title: 'first', parentId: target.id, order: 1 });
    const next = store.createTask({ title: 'next', parentId: target.id, order: 1 + Number.EPSILON });
    const original = store.getData().tasks;
    expect(store.reparentTasks([b.id, a.id], target.id, next.id)).toBe(2);
    expect(buildChildrenMap(store.getData().tasks).get(target.id)!.map(task => task.id)).toEqual([first.id, a.id, b.id, next.id]);
    store.undo(); expect(store.getData().tasks).toEqual(original);
    store.destroy();
  });
});
