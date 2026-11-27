import type { NexusData, Review, ReviewFacts, ReviewKind, ReviewPeriod, Settings, Task } from './types';
import { addDays, dateFromDayKey, dayKeyOf, startOfDay, startOfWeek } from './time';
import { activeTasks, ancestorsOf, isProject, isStructural } from './tree';
import { workProgress } from './work';
import { compareTaskPriority } from './quadrant';

export function validDayKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && dayKeyOf(dateFromDayKey(value)) === value;
}
export function reviewId(period: ReviewPeriod): string { return `${period.kind}_${period.start}`; }
export function reviewPeriod(kind: ReviewKind, date: Date | number, weekStartsOn: 0 | 1 = 1): ReviewPeriod {
  const start = kind === 'weekly' ? startOfWeek(date, weekStartsOn) : startOfDay(date);
  return { kind, start: dayKeyOf(start), end: dayKeyOf(addDays(start, kind === 'weekly' ? 7 : 1)) };
}
export function validReviewPeriod(period: ReviewPeriod): boolean {
  return ['daily', 'weekly'].includes(period.kind) && validDayKey(period.start) && validDayKey(period.end)
    && dayKeyOf(addDays(dateFromDayKey(period.start), period.kind === 'daily' ? 1 : 7)) === period.end;
}
export function periodOfReview(review: Review): ReviewPeriod {
  return { kind: review.kind, start: review.periodStart, end: review.periodEnd };
}

/** Current task facts, never inferred from updatedAt. Finalizing stores an immutable snapshot. */
export function reviewFacts(data: NexusData, period: ReviewPeriod, now = Date.now(), bounds?: { start: number; end: number; todayEnd?: number }): ReviewFacts {
  const start = bounds?.start ?? dateFromDayKey(period.start).getTime();
  const periodEnd = bounds?.end ?? dateFromDayKey(period.end).getTime();
  const end = Math.min(periodEnd, now);
  const pendingEnd = Math.min(periodEnd, bounds?.todayEnd ?? addDays(startOfDay(now), 1).getTime());
  const byId = new Map(data.tasks.map(task => [task.id, task]));
  const projectOf = (task: Task) => ancestorsOf(task.id, byId).find(isProject);
  const fact = (task: Task) => ({ id: task.id, title: task.title, project: projectOf(task)?.title ?? '未归项目' });
  const live = activeTasks(data.tasks);
  const completed = data.tasks.filter(task => !task.deletedAt && !isStructural(task) && task.status === 'done'
    && task.completedAt != null && task.completedAt >= start && task.completedAt < periodEnd && task.completedAt <= now)
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  const scheduled = live.filter(task => !isStructural(task) && task.status !== 'inbox'
    && (task.startAt != null || task.dueAt != null));
  const planned = scheduled.filter(task => {
    const taskStart = task.startAt ?? task.dueAt!;
    const taskEnd = Math.max(taskStart, task.dueAt ?? taskStart);
    return taskStart < periodEnd && taskEnd >= start;
  }).sort(compareTaskPriority);
  // Carry unfinished work forward through the selected day, capped at today for an ongoing week.
  const pending = scheduled.filter(task => task.status !== 'done'
    && Math.min(task.startAt ?? Infinity, task.dueAt ?? Infinity) < pendingEnd)
    .sort(compareTaskPriority);
  let focusMin = 0;
  for (const session of data.sessions) {
    if (session.mode !== 'focus' || session.endedAt <= session.startedAt || session.actualMin <= 0) continue;
    const overlap = Math.max(0, Math.min(end, session.endedAt) - Math.max(start, session.startedAt));
    focusMin += session.actualMin * overlap / (session.endedAt - session.startedAt);
  }
  const touched = new Set([...completed, ...planned, ...pending].map(task => projectOf(task)?.id));
  for (const session of data.sessions) if (session.mode === 'focus' && session.startedAt < end && session.endedAt > start && session.taskId) {
    const task = byId.get(session.taskId); if (task) touched.add(projectOf(task)?.id);
  }
  const progress = workProgress(live);
  const projects = live.filter(task => isProject(task) && touched.has(task.id)).map(task => ({
    id: task.id, title: task.title, done: progress.get(task.id)?.done ?? 0, total: progress.get(task.id)?.total ?? 0,
  }));
  return {
    capturedAt: now,
    completed: completed.map(fact),
    planned: planned.map(task => ({ ...fact(task), done: task.status === 'done' })),
    pending: pending.map(fact),
    focusMin: Math.round(focusMin),
    projects,
  };
}

/** Only the most recent due day/week is nudged; missed reviews never become a task backlog. */
export function dueReviews(reviews: Review[], settings: Settings, now = Date.now()): ReviewPeriod[] {
  const atTime = (date: Date, time: string) => {
    const [hour, minute] = time.split(':').map(Number); const result = new Date(date);
    result.setHours(hour!, minute!, 0, 0); return result;
  };
  const today = new Date(now);
  const dailyDue = atTime(today, settings.reviewDailyTime);
  const daily = reviewPeriod('daily', dailyDue.getTime() > now ? addDays(today, -1) : today);
  let weeklyDate = addDays(startOfDay(today), -((today.getDay() - settings.reviewWeeklyDay + 7) % 7));
  if (atTime(weeklyDate, settings.reviewWeeklyTime).getTime() > now) weeklyDate = addDays(weeklyDate, -7);
  const weekly = reviewPeriod('weekly', weeklyDate, settings.weekStartsOn);
  return [settings.reviewWeeklyEnabled ? weekly : null, settings.reviewDailyEnabled ? daily : null]
    .filter((period): period is ReviewPeriod => period !== null)
    .filter(period => !reviews.some(review => review.id === reviewId(period) && review.completedAt != null));
}

export function reviewMarkdown(review: Review, facts: ReviewFacts): string {
  const lines = [`# ${review.kind === 'daily' ? '日报' : '周报'} · ${review.periodStart}${review.kind === 'weekly' ? ` ～ ${dayKeyOf(addDays(dateFromDayKey(review.periodEnd), -1))}` : ''}`,
    '', `完成 ${facts.completed.length} 项任务 · 专注 ${facts.focusMin} 分钟`, '', review.kind === 'daily' ? '## 今天真正推进了什么？' : '## 本周真正推进了什么？',
    ...facts.completed.map(task => `- [x] ${task.title}（${task.project}）`), '', review.highlights || '（未填写）',
    '', review.kind === 'daily' ? '## 今天需要推进什么？' : '## 本周需要推进什么？',
    ...(facts.planned ?? []).map(task => `- [${task.done ? 'x' : ' '}] ${task.title}（${task.project}）`), '', review.plan || '（未填写）',
    '', '## 尚未完成', ...facts.pending.map(task => `- [ ] ${task.title}（${task.project}）`),
    '', '## 阻碍与反思', review.friction || '（未填写）', '', '### 如何解决？', review.resolution || '（未填写）', '', '## 下一步', review.nextSteps || '（未填写）'];
  return lines.join('\n');
}
