import { Task, Priority } from './types';
import { activeTasks, buildChildrenMap, isStructural, sortSiblings } from './tree';

export type QuadrantKey = 'do' | 'plan' | 'delegate' | 'eliminate';

/** 优先级 P0~P3 = 四象限(重要×紧急)的显式编码;两者互为同一事实 */
export const PRIORITY_META: Record<Priority, { label: string; important: boolean; urgent: boolean }> = {
  P0: { label: 'P0 · 重要且紧急', important: true, urgent: true },
  P1: { label: 'P1 · 重要', important: true, urgent: false },
  P2: { label: 'P2 · 紧急', important: false, urgent: true },
  P3: { label: 'P3 · 普通', important: false, urgent: false },
};

export const PRIORITY_ORDER: Priority[] = ['P0', 'P1', 'P2', 'P3'];

/** 任务的显式优先级;缺省时回退到 important/urgent 推导,保证新老数据一致 */
export function priorityOf(task: Task): Priority {
  if (task.priority) return task.priority;
  if (task.important && task.urgent) return 'P0';
  if (task.important) return 'P1';
  if (task.urgent) return 'P2';
  return 'P3';
}

/** An implicit ordinary priority still needs a deliberate choice, including P3. */
export function needsPriorityReview(task: Task): boolean {
  return !isStructural(task) && task.priority == null && !task.important && !task.urgent;
}

/** Unfinished tasks come first, then P0–P3, deadline and manual order. */
export function compareTaskPriority(a: Task, b: Task): number {
  return Number(a.status === 'done') - Number(b.status === 'done')
    || PRIORITY_ORDER.indexOf(priorityOf(a)) - PRIORITY_ORDER.indexOf(priorityOf(b))
    || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity)
    || sortSiblings(a, b);
}

/** Promote branches containing high-priority work while keeping every parent above its children. */
export function prioritySortedChildren(tasks: Task[]): Map<string | null, Task[]> {
  const children = buildChildrenMap(tasks);
  const ranks = new Map<string, number>();
  const traversal = [...(children.get(null) ?? [])];
  for (let index = 0; index < traversal.length; index++) {
    for (const child of children.get(traversal[index]!.id) ?? []) traversal.push(child);
  }
  for (const task of traversal.reverse()) {
    let value = isStructural(task) ? 4 : task.status === 'done' ? 4 : PRIORITY_ORDER.indexOf(priorityOf(task));
    for (const child of children.get(task.id) ?? []) value = Math.min(value, ranks.get(child.id)!);
    ranks.set(task.id, value);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)! || compareTaskPriority(a, b));
  return children;
}

/** 优先级 → 重要/紧急(写数据时同时落两处,四象限与优先级不会漂移) */
export function quadrantFields(p: Priority): { important: boolean; urgent: boolean } {
  const m = PRIORITY_META[p];
  return { important: m.important, urgent: m.urgent };
}

/** 四象限 → 优先级(矩阵拖拽等按象限改任务时使用) */
export function quadrantToPriority(q: QuadrantKey): Priority {
  if (q === 'do') return 'P0';
  if (q === 'plan') return 'P1';
  if (q === 'delegate') return 'P2';
  return 'P3';
}

export const QUADRANTS: {
  key: QuadrantKey;
  title: string;
  sub: string;
  important: boolean;
  urgent: boolean;
}[] = [
  { key: 'plan', title: '计划', sub: '重要 · 不紧急', important: true, urgent: false },
  { key: 'do', title: '立即做', sub: '重要 · 紧急', important: true, urgent: true },
  { key: 'eliminate', title: '淘汰', sub: '不重要 · 不紧急', important: false, urgent: false },
  { key: 'delegate', title: '委托 / 快速处理', sub: '不重要 · 紧急', important: false, urgent: true },
];

export function quadrantOf(task: Task): QuadrantKey {
  if (task.important && task.urgent) return 'do';
  if (task.important && !task.urgent) return 'plan';
  if (!task.important && task.urgent) return 'delegate';
  return 'eliminate';
}

/** 四象限任务:默认未完成,由视图设置决定是否一并显示已完成项。 */
export function matrixTasks(tasks: Task[], now: Date, showDone = false): Task[] {
  // 不再按 7 天窗口过滤:远期有日期的任务也会在矩阵里消失,违背"设了时间就该看见"。
  // 由视图按到期先后排序、限量展示;结构性节点(非 TODO)不进矩阵。
  void now;
  return activeTasks(tasks).filter(
    (t) => !t.deletedAt && !isStructural(t) && (t.status === 'todo' || t.status === 'doing' || showDone && t.status === 'done'),
  );
}
