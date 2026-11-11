import { isStructural } from './tree';
import { priorityOf, quadrantFields } from './quadrant';
import type { Priority, Task } from './types';

export type BatchDateEdit = { action: 'clear' } | { action: 'set'; date: string; time?: string };
export interface TaskBatchChange {
  priority?: Priority;
  startAt?: BatchDateEdit;
  dueAt?: BatchDateEdit;
  shiftDays?: number;
}
export interface TaskBatchPlan {
  eligible: number;
  skipped: number;
  writes: { id: string; patch: Partial<Task> }[];
}

function dateValue(edit: BatchDateEdit, previous: number | null | undefined, endpoint: 'startAt' | 'dueAt'): number | null {
  if (edit.action === 'clear') return null;
  if (edit.action !== 'set' || !/^\d{4}-\d{2}-\d{2}$/.test(edit.date)) throw new Error('请选择有效日期。');
  const [year, month, day] = edit.date.split('-').map(Number) as [number, number, number];
  if (year < 100 || year > 9999) throw new Error('请选择有效日期。');
  const reference = previous == null ? null : new Date(previous);
  let hours = reference?.getHours() ?? (endpoint === 'dueAt' ? 23 : 0);
  let minutes = reference?.getMinutes() ?? (endpoint === 'dueAt' ? 59 : 0);
  let seconds = reference?.getSeconds() ?? 0, milliseconds = reference?.getMilliseconds() ?? 0;
  if (edit.time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(edit.time)) throw new Error('请选择有效时刻。');
    [hours, minutes] = edit.time.split(':').map(Number) as [number, number];
    seconds = 0; milliseconds = 0;
  }
  // Set the destination day before its clock time; the original day may have a DST gap.
  const date = new Date(2000, 0, 1, 12);
  date.setFullYear(year, month - 1, day);
  date.setHours(hours, minutes, seconds, milliseconds);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day)
    throw new Error('请选择有效日期。');
  if (date.getHours() !== hours || date.getMinutes() !== minutes) throw new Error('该日期的时刻受夏令时影响，请明确选择有效时刻。');
  return date.getTime();
}

/** Plan and validate the entire selection before opening a Yjs transaction (which cannot roll back). */
export function planTaskBatch(tasks: readonly Task[], ids: readonly string[], change: TaskBatchChange): TaskBatchPlan {
  if (change.priority !== undefined && !['P0', 'P1', 'P2', 'P3'].includes(change.priority)) throw new Error('优先级无效。');
  if (change.shiftDays !== undefined && (!Number.isInteger(change.shiftDays) || Math.abs(change.shiftDays) > 3660 || change.startAt || change.dueAt))
    throw new Error('整体移动需要单独设置有效的天数（最多 3660 天）。');
  const byId = new Map(tasks.map(task => [task.id, task]));
  const plan: TaskBatchPlan = { eligible: 0, skipped: 0, writes: [] };
  for (const id of new Set(ids)) {
    const task = byId.get(id);
    if (!task || task.deletedAt != null || isStructural(task) || task.status === 'archived' ||
      (change.shiftDays !== undefined && task.startAt == null && task.dueAt == null)) {
      plan.skipped++;
      continue;
    }
    plan.eligible++;
    const patch: Partial<Task> = {};
    if (change.priority !== undefined) {
      if (priorityOf(task) !== change.priority) patch.priority = change.priority;
      Object.assign(patch, quadrantFields(change.priority));
    }
    for (const endpoint of ['startAt', 'dueAt'] as const) {
      const edit = change[endpoint];
      if (edit) patch[endpoint] = dateValue(edit, task[endpoint], endpoint);
      if (change.shiftDays !== undefined && task[endpoint] != null) {
        const date = new Date(task[endpoint]);
        const hours = date.getHours(), minutes = date.getMinutes();
        date.setDate(date.getDate() + change.shiftDays);
        if (!Number.isFinite(date.getTime()) || date.getHours() !== hours || date.getMinutes() !== minutes)
          throw new Error(`「${task.title || '未命名任务'}」移动后时刻无效，请单独调整。`);
        patch[endpoint] = date.getTime();
      }
    }
    const start = patch.startAt !== undefined ? patch.startAt : task.startAt;
    const due = patch.dueAt !== undefined ? patch.dueAt : task.dueAt;
    if ((change.startAt || change.dueAt || change.shiftDays !== undefined) && start != null && due != null && due < start)
      throw new Error(`「${task.title || '未命名任务'}」的截止早于开始；整批尚未修改，请调整日期。`);
    for (const key of Object.keys(patch) as (keyof Task)[]) {
      if (task[key] === patch[key] || (patch[key] === null && task[key] == null)) delete patch[key];
    }
    if (Object.keys(patch).length) plan.writes.push({ id, patch });
  }
  return plan;
}
