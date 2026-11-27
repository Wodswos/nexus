import { calendarDaysBetween, dayKeyOf } from './time';
import { WORK_FOCUS, type WorkFocus } from './work';

export const TASK_FILTER_STATUSES = ['all', 'unfinished', 'todo', 'doing', 'done'] as const;
export const TASK_FILTER_PRIORITIES = ['all', 'high', 'unreviewed', 'P0', 'P1', 'P2', 'P3'] as const;
export const TASK_SORTS = ['manual', 'priority'] as const;

export const TASK_VIEW_KEYS = ['list', 'mindmap', 'matrix', 'gantt', 'timeline'] as const;
export type TaskViewKey = (typeof TASK_VIEW_KEYS)[number];
export const VIEW_SCOPES = ['today', 'week', 'month', 'custom', 'all', 'undated'] as const;
export type ViewScope = (typeof VIEW_SCOPES)[number];
export interface SavedTaskView {
  id: string;
  name: string;
  view: TaskViewKey;
  scope: ViewScope;
  projectId?: string | null;
  from?: string;
  to?: string;
  work?: WorkFocus;
  taskStatus?: typeof TASK_FILTER_STATUSES[number];
  taskPriority?: typeof TASK_FILTER_PRIORITIES[number];
  taskSort?: typeof TASK_SORTS[number];
  taskTag?: string;
}
export const MAX_SAVED_VIEWS = 50;
export const WEEK_WORK_VIEW: SavedTaskView = { id: 'week-work', name: '本周工作', view: 'gantt', scope: 'week', projectId: null };
export const DEFAULT_SAVED_VIEWS: SavedTaskView[] = [
  WEEK_WORK_VIEW,
  { id: 'calendar-month', name: '本月日历', view: 'timeline', scope: 'month', projectId: null },
];
export function normalizeTaskView(value: unknown): TaskViewKey | null {
  if (value === 'calendar') return 'timeline';
  return TASK_VIEW_KEYS.includes(value as TaskViewKey) ? value as TaskViewKey : null;
}
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const validDay = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00`);
  return Number.isFinite(date.getTime()) && dayKeyOf(date) === value;
};
export function isSavedTaskView(value: unknown): value is SavedTaskView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !idPattern.test(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 60 || !TASK_VIEW_KEYS.includes(item.view as TaskViewKey) || !VIEW_SCOPES.includes(item.scope as ViewScope)) return false;
  if (item.projectId != null && (typeof item.projectId !== 'string' || !idPattern.test(item.projectId))) return false;
  if (item.work != null && !WORK_FOCUS.includes(item.work as WorkFocus)) return false;
  if (item.taskStatus != null && !TASK_FILTER_STATUSES.includes(item.taskStatus as SavedTaskView['taskStatus'] & string)) return false;
  if (item.taskPriority != null && !TASK_FILTER_PRIORITIES.includes(item.taskPriority as SavedTaskView['taskPriority'] & string)) return false;
  if (item.taskSort != null && !TASK_SORTS.includes(item.taskSort as SavedTaskView['taskSort'] & string)) return false;
  if (item.taskTag != null && (typeof item.taskTag !== 'string' || !idPattern.test(item.taskTag))) return false;
  if (item.scope === 'custom') {
    if (!validDay(item.from) || !validDay(item.to)) return false;
    const days = calendarDaysBetween(new Date(`${item.from}T00:00:00`), new Date(`${item.to}T00:00:00`));
    if (days < 0 || days >= 366) return false;
  }
  return true;
}
export function validateSavedViews(value: unknown): asserts value is SavedTaskView[] {
  if (!Array.isArray(value) || value.length > MAX_SAVED_VIEWS || !value.every(isSavedTaskView) || new Set(value.map((item) => item.id)).size !== value.length) throw new Error('快捷视图配置无效，请检查名称和日期区间');
}
/** Always generate an internal route; stored presets never contain arbitrary URLs. */
export function savedViewHref(view: SavedTaskView): string {
  const params = new URLSearchParams({ saved: view.id, view: view.view, scope: view.scope });
  if (view.projectId) params.set('project', view.projectId);
  if (view.scope === 'custom') { params.set('from', view.from!); params.set('to', view.to!); }
  for (const key of ['work', 'taskStatus', 'taskPriority', 'taskTag', 'taskSort'] as const) {
    if (view[key] && view[key] !== 'all') params.set(key, view[key]);
  }
  return `/tasks?${params}`;
}

/** A one-time derived default; saving any view edit records the migration, so removal stays removed. */
export function migrateWorkViews(views: SavedTaskView[], version = 0): SavedTaskView[] {
  if (version >= 1 || views.length >= MAX_SAVED_VIEWS || views.some(view => view.id === WEEK_WORK_VIEW.id || (!view.projectId && view.view === 'gantt' && view.scope === 'week' && (!view.work || view.work === 'all') && (!view.taskStatus || view.taskStatus === 'all') && (!view.taskPriority || view.taskPriority === 'all') && !view.taskTag))) return views;
  return [{ ...WEEK_WORK_VIEW }, ...views];
}
