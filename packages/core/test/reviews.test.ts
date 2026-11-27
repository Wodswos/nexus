import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, EMPTY_DATA, type Review, type Task } from '../src/types';
import { dueReviews, reviewFacts, reviewId, reviewMarkdown, reviewPeriod, validDayKey } from '../src/reviews';
import { validateNexusData } from '../src/validation';

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id, title: id, parentId: null, status: 'todo', ownerId: 'u', order: 0, tags: [], important: false,
  urgent: false, createdAt: 1, updatedAt: 1, ...patch,
});

describe('review calendar and facts', () => {
  it('uses explicit caller-zone boundaries for Agent-generated review facts', () => {
    const start = Date.parse('2026-11-03T16:00:00Z'), end = Date.parse('2026-11-04T16:00:00Z');
    const data = { ...EMPTY_DATA, tasks: [task('local-morning', { status: 'done' as const, completedAt: start + 3600000 }), task('before', { status: 'done' as const, completedAt: start - 1 }), task('after', { status: 'done' as const, completedAt: end })] };
    const facts = reviewFacts(data, { kind: 'daily', start: '2026-11-04', end: '2026-11-05' }, end, { start, end });
    expect(facts.completed.map(task => task.id)).toEqual(['local-morning']);
  });
  it('uses local calendar boundaries and the configured week start', () => {
    const date = new Date(2026, 9, 25, 23, 40);
    expect(reviewPeriod('daily', date)).toEqual({ kind: 'daily', start: '2026-10-25', end: '2026-10-26' });
    expect(reviewPeriod('weekly', date, 1)).toEqual({ kind: 'weekly', start: '2026-10-19', end: '2026-10-26' });
    expect(reviewPeriod('weekly', date, 0)).toEqual({ kind: 'weekly', start: '2026-10-25', end: '2026-11-01' });
    expect(validDayKey('2026-02-30')).toBe(false);
    expect(validDayKey('2024-02-29')).toBe(true);
  });
  it('uses completion timestamps, excludes structural/deleted tasks and prorates cross-midnight focus', () => {
    const start = new Date(2026, 9, 25).getTime(), now = start + 20 * 3600000;
    const tasks = [task('project', { kind: 'node', project: true }),
      task('done', { parentId: 'project', status: 'done', completedAt: start + 1000 }),
      task('old', { status: 'done', completedAt: start - 1, updatedAt: now }),
      task('boundary', { status: 'done', completedAt: start + 86400000 }),
      task('deleted', { status: 'done', completedAt: start + 2000, deletedAt: now }),
      task('due', { parentId: 'project', dueAt: start + 3000 }),
      task('upcoming', { dueAt: now + 1000 })];
    const session = { id: 's', taskId: 'done', startedAt: start - 1800000, endedAt: start + 1800000, actualMin: 40, plannedMin: 60, mode: 'focus' as const, completed: false, ownerId: 'u' };
    const facts = reviewFacts({ ...EMPTY_DATA, tasks, sessions: [session, { ...session, id: 'break', mode: 'short-break' }] }, reviewPeriod('daily', start), now);
    expect(facts.completed.map(task => task.id)).toEqual(['done']);
    expect(facts.completed[0]!.project).toBe('project');
    expect(facts.pending.map(task => task.id)).toEqual(['due', 'upcoming']);
    expect(facts.focusMin).toBe(20);
    expect(facts.projects).toEqual([{ id: 'project', title: 'project', done: 1, total: 2 }]);
  });
  it('handles DST days without assuming twenty-four hours', () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      const start = new Date(2026, 2, 8).getTime(), end = new Date(2026, 2, 9).getTime();
      expect(end - start).toBe(23 * 3600000);
      const facts = reviewFacts({ ...EMPTY_DATA, sessions: [{ id: 'dst', taskId: null, startedAt: start, endedAt: end, actualMin: 60, plannedMin: 60, mode: 'focus', completed: true, ownerId: 'u' }] }, reviewPeriod('daily', start), end);
      expect(facts.focusMin).toBe(60);
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  it('fills the daily plan from date ranges and carries unfinished earlier work forward', () => {
    const start = new Date(2026, 9, 25).getTime(), end = new Date(2026, 9, 26).getTime(), now = start + 10 * 3600000;
    const tasks = [
      task('today', { dueAt: end - 1, priority: 'P1' }),
      task('started', { startAt: start + 1000 }),
      task('spanning', { startAt: start - 86400000, dueAt: end + 86400000 }),
      task('overdue', { dueAt: start - 1, priority: 'P0' }),
      task('old-start', { startAt: start - 86400000 }),
      task('tomorrow', { dueAt: end }),
      task('done-now', { status: 'done', completedAt: now, dueAt: now }),
      task('unscheduled'), task('text', { kind: 'node', dueAt: start }),
      task('inbox', { status: 'inbox', dueAt: start }),
      task('archived', { status: 'archived', dueAt: start }),
      task('deleted', { dueAt: start, deletedAt: start }),
      task('hidden-project', { project: true, status: 'archived' }),
      task('hidden-child', { parentId: 'hidden-project', dueAt: start }),
    ];
    const facts = reviewFacts({ ...EMPTY_DATA, tasks }, reviewPeriod('daily', start), now);
    expect(facts.completed.map(task => task.id)).toEqual(['done-now']);
    expect(facts.planned?.map(task => task.id)).toEqual(['today', 'spanning', 'started', 'done-now']);
    expect(facts.planned?.find(task => task.id === 'done-now')?.done).toBe(true);
    expect(facts.pending.map(task => task.id)).toEqual(['overdue', 'today', 'spanning', 'old-start', 'started']);
  });
  it('includes the full week in the plan and caps pending work at today in the caller timezone', () => {
    const start = Date.parse('2026-11-15T16:00:00Z'), end = Date.parse('2026-11-22T16:00:00Z');
    const now = Date.parse('2026-11-17T16:30:00Z'), todayEnd = Date.parse('2026-11-18T16:00:00Z');
    const tasks = [task('last-week', { dueAt: start - 1 }),
      task('tonight', { dueAt: todayEnd - 1 }), task('later-this-week', { dueAt: todayEnd }),
      task('next-week', { dueAt: end })];
    const facts = reviewFacts({ ...EMPTY_DATA, tasks }, { kind: 'weekly', start: '2026-11-16', end: '2026-11-23' }, now, { start, end, todayEnd });
    expect(facts.planned?.map(task => task.id)).toEqual(['tonight', 'later-this-week']);
    expect(facts.pending.map(task => task.id)).toEqual(['last-week', 'tonight']);
  });
  it('keeps completions on their actual day and uses the selected past day for pending work', () => {
    const start = new Date(2026, 9, 25).getTime(), end = new Date(2026, 9, 26).getTime();
    const tasks = [task('due-then', { dueAt: end - 1 }), task('due-later', { dueAt: end }),
      task('finished-later', { dueAt: start, status: 'done', completedAt: end + 1000 })];
    const facts = reviewFacts({ ...EMPTY_DATA, tasks }, reviewPeriod('daily', start), end + 3600000);
    expect(facts.pending.map(task => task.id)).toEqual(['due-then']);
    expect(facts.completed).toEqual([]);
    expect(facts.planned?.find(task => task.id === 'finished-later')?.done).toBe(true);
  });
});

describe('review reminders and validation', () => {
  it('defaults to daily 21:30 and Sunday 20:00, advances exactly at the configured minute', () => {
    expect(DEFAULT_SETTINGS.reviewDailyTime).toBe('21:30');
    expect(DEFAULT_SETTINGS.reviewWeeklyTime).toBe('20:00');
    expect(DEFAULT_SETTINGS.reviewWeeklyDay).toBe(0);
    const before = dueReviews([], DEFAULT_SETTINGS, new Date(2026, 9, 25, 19, 59).getTime());
    expect(before.map(reviewId)).toEqual(['weekly_2026-10-12', 'daily_2026-10-24']);
    const weekly = dueReviews([], DEFAULT_SETTINGS, new Date(2026, 9, 25, 20).getTime());
    expect(weekly.map(reviewId)).toEqual(['weekly_2026-10-19', 'daily_2026-10-24']);
    const daily = dueReviews([], DEFAULT_SETTINGS, new Date(2026, 9, 25, 21, 30).getTime());
    expect(daily.map(reviewId)).toEqual(['weekly_2026-10-19', 'daily_2026-10-25']);
  });
  it('does not keep prompting completed periods or create a backlog, and respects disabled reminders', () => {
    const now = new Date(2026, 9, 25, 22).getTime();
    const completed = dueReviews([], DEFAULT_SETTINGS, now).map(period => ({ id: reviewId(period), completedAt: now } as Review));
    expect(dueReviews(completed, DEFAULT_SETTINGS, now)).toEqual([]);
    expect(dueReviews([], { ...DEFAULT_SETTINGS, reviewDailyEnabled: false, reviewWeeklyEnabled: false }, now)).toEqual([]);
    expect(dueReviews([], DEFAULT_SETTINGS, new Date(2027, 0, 1, 22).getTime())).toHaveLength(2);
  });
  it('rejects invalid periods, snapshots and reminder settings before import', () => {
    expect(() => validateNexusData({ settings: { reviewDailyTime: '24:00' } })).toThrow();
    expect(() => validateNexusData({ settings: { reviewWeeklyDay: 7 } })).toThrow();
    expect(() => validateNexusData({ reviews: [{ id: 'daily_2026-02-30', kind: 'daily', periodStart: '2026-02-30', periodEnd: '2026-03-03' }] })).toThrow();
    expect(() => validateNexusData({ tasks: [] })).not.toThrow();
  });
  it('accepts older backups and validates and exports the separate solution field', () => {
    const legacy = { id: 'daily_2026-10-25', kind: 'daily', periodStart: '2026-10-25', periodEnd: '2026-10-26', highlights: '', friction: 'Late feedback', nextSteps: '' };
    expect(() => validateNexusData({ reviews: [legacy] })).not.toThrow();
    expect(() => validateNexusData({ reviews: [{ ...legacy, resolution: null }] })).toThrow();
    expect(() => validateNexusData({ reviews: [{ ...legacy, resolution: 7 }] })).toThrow();
    expect(() => validateNexusData({ reviews: [{ ...legacy, resolution: 'x'.repeat(100001) }] })).toThrow();
    const review: Review = { ...legacy, kind: 'daily', plan: '', resolution: 'Review together before implementation', facts: null, completedAt: null, ownerId: 'u', createdAt: 1, updatedAt: 1 };
    expect(() => validateNexusData({ reviews: [review] })).not.toThrow();
    const facts = { capturedAt: 1, completed: [], pending: [], focusMin: 0, projects: [] };
    expect(reviewMarkdown(review, facts)).toContain('## 阻碍与反思\nLate feedback\n\n### 如何解决？\nReview together before implementation\n\n## 下一步');
  });
  it('validates optional planning data and exports plans, progress and pending checklists separately', () => {
    const review: Review = { id: 'daily_2026-10-25', kind: 'daily', periodStart: '2026-10-25', periodEnd: '2026-10-26',
      highlights: 'Validated the first milestone', plan: 'Focus on feedback', friction: '', resolution: '', nextSteps: '', facts: null, completedAt: null, ownerId: 'u', createdAt: 1, updatedAt: 1 };
    const facts = { capturedAt: 1, completed: [{ id: 'done', title: 'Shipped', project: 'A' }],
      planned: [{ id: 'done', title: 'Shipped', project: 'A', done: true }, { id: 'todo', title: 'Gather feedback', project: 'A', done: false }],
      pending: [{ id: 'todo', title: 'Gather feedback', project: 'A' }], focusMin: 0, projects: [] };
    expect(() => validateNexusData({ reviews: [{ ...review, facts }] })).not.toThrow();
    for (const plan of [null, 3, 'x'.repeat(100001)]) expect(() => validateNexusData({ reviews: [{ ...review, plan }] })).toThrow();
    expect(() => validateNexusData({ reviews: [{ ...review, facts: { ...facts, planned: 'invalid' } }] })).toThrow();
    expect(() => validateNexusData({ reviews: [{ ...review, facts: { ...facts, planned: [{ ...facts.planned[0], done: 'yes' }] } }] })).toThrow();
    const markdown = reviewMarkdown(review, facts);
    expect(markdown).toContain('## 今天真正推进了什么？\n- [x] Shipped（A）');
    expect(markdown).toContain('## 今天需要推进什么？\n- [x] Shipped（A）\n- [ ] Gather feedback（A）');
    expect(markdown).toContain('Focus on feedback');
    expect(markdown).toContain('## 尚未完成\n- [ ] Gather feedback（A）');
  });
});
