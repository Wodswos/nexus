import { describe, expect, it } from 'vitest';
import { compareTaskPriority, needsPriorityReview, priorityOf, prioritySortedChildren, type Task } from '../src';

const task = (id: string, patch: Partial<Task> = {}): Task => ({ id, title: id, parentId: null, status: 'todo', ownerId: 'u', order: 0, important: false, urgent: false, tags: [], createdAt: 1, updatedAt: 1, ...patch });

describe('task priority and review', () => {
  it('defaults to ordinary P3 and distinguishes a deliberate P3 choice from an unreviewed task', () => {
    const fresh = task('fresh');
    expect(priorityOf(fresh)).toBe('P3');
    expect(needsPriorityReview(fresh)).toBe(true);
    expect(needsPriorityReview(task('confirmed', { priority: 'P3' }))).toBe(false);
    expect(needsPriorityReview(task('legacy', { important: true }))).toBe(false);
    expect(priorityOf(task('legacy', { important: true }))).toBe('P1');
    expect(needsPriorityReview(task('text', { kind: 'node' }))).toBe(false);
  });

  it('sorts unfinished work P0 to P3, then completed work, with deadline and manual ties', () => {
    const tasks = [task('done', { priority: 'P0', status: 'done' }), task('normal', { priority: 'P3' }), task('urgent', { priority: 'P2' }), task('important', { priority: 'P1' }), task('later', { priority: 'P0', dueAt: 200 }), task('first', { priority: 'P0', dueAt: 100 })];
    expect(tasks.sort(compareTaskPriority).map(task => task.id)).toEqual(['first', 'later', 'important', 'urgent', 'normal', 'done']);
  });

  it('promotes a branch containing high-priority work while preserving the hierarchy and underlying order', () => {
    const tasks = [task('low', { priority: 'P3', order: 0 }), task('parent', { priority: 'P3', order: 1 }), task('child-low', { parentId: 'parent', priority: 'P3', order: 0 }), task('child-high', { parentId: 'parent', priority: 'P0', order: 1 })];
    const original = structuredClone(tasks);
    const sorted = prioritySortedChildren(tasks);
    expect(sorted.get(null)!.map(task => task.id)).toEqual(['parent', 'low']);
    expect(sorted.get('parent')!.map(task => task.id)).toEqual(['child-high', 'child-low']);
    expect(tasks).toEqual(original);
  });

  it('handles deep trees and imported cycles through the normalized forest', () => {
    const tasks = Array.from({ length: 12000 }, (_, index) => task(String(index), { parentId: index ? String(index - 1) : null, priority: index === 11999 ? 'P0' : 'P3' }));
    expect(prioritySortedChildren(tasks).get(null)![0]!.id).toBe('0');
    expect(prioritySortedChildren([task('a', { parentId: 'b' }), task('b', { parentId: 'a' })]).get(null)).toHaveLength(1);
  });
});
