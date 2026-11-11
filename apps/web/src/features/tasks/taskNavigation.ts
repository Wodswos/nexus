import {
  activeTasks,
  addDays,
  dayKeyOf,
  isProject,
  isStructural,
  savedViewHref,
  type NexusData,
  type Task,
  type TaskViewKey,
  type SavedTaskView,
} from '@nexus/core';
import { readTaskWindow, taskMatchesWindow, windowEnd } from './taskWindow';

export type TaskDestination = TaskViewKey;

/** Child first, root last. Imported cycles and unavailable ancestors cannot form a deep link. */
export function taskPath(tasks: Task[], id: string): Task[] {
  const byId = new Map(activeTasks(tasks).map((task) => [task.id, task]));
  const path: Task[] = [],
    seen = new Set<string>();
  let task = byId.get(id);
  while (task) {
    if (seen.has(task.id) || task.status === 'inbox') return [];
    seen.add(task.id);
    path.push(task);
    if (task.parentId && !byId.has(task.parentId)) return [];
    task = task.parentId ? byId.get(task.parentId) : undefined;
  }
  return path;
}

export function taskViewHref(
  data: NexusData,
  id: string,
  view: TaskDestination,
  now = Date.now(),
): string | null {
  const path = taskPath(data.tasks, id),
    task = path[0];
  if (!task || (!['mindmap', 'list'].includes(view) && isStructural(task))) return null;
  const params = new URLSearchParams({ view, scope: 'all', focusTask: id });
  const project = path.find(isProject);
  params.set(project ? 'project' : 'root', project?.id ?? path[path.length - 1]!.id);
  if (view === 'timeline') {
    const events = data.events
      .filter((event) => !event.deletedAt && event.taskId === id)
      .sort((a, b) => a.start - b.start);
    const event =
      events.find((event) => !event.completed && event.end > now) ?? events[events.length - 1];
    const date = task.dueAt ?? task.startAt ?? event?.start;
    if (date != null) {
      params.set('scope', 'custom');
      params.set('from', dayKeyOf(date));
      params.set('to', dayKeyOf(date));
    } else params.set('scope', 'undated');
  }
  return `/tasks?${params}`;
}

/** Preserve the destination's filters; a focus request reveals only this task.
 * Temporal destinations outside its day get a temporary URL range, never a preset edit. */
function locateInWorkspace(
  data: NexusData,
  id: string,
  params: URLSearchParams,
  now: number,
): string | null {
  const path = taskPath(data.tasks, id),
    task = path[0];
  if (!task || (!['list', 'mindmap'].includes(params.get('view') ?? '') && isStructural(task)))
    return null;
  const boundary = params.get('project') ?? params.get('root');
  if (boundary && !path.some((task) => task.id === boundary)) return null;
  params.set('focusTask', id);
  if (['gantt', 'timeline'].includes(params.get('view') ?? '')) {
    const range = readTaskWindow(params, new Date(now), data.settings.weekStartsOn);
    const events = data.events
      .filter((event) => !event.deletedAt && event.taskId === id)
      .sort((a, b) => a.start - b.start);
    const date =
      task.dueAt ??
      task.startAt ??
      events.find((event) => !event.completed && event.end > now)?.start ??
      events.at(-1)?.start;
    if (date == null) {
      // A named workspace may intentionally hide its backlog. An explicit jump
      // still needs a visible destination, without assigning the task a date.
      params.set('view', 'list');
    } else if (
      !['all', 'undated'].includes(range.scope) &&
      (params.get('view') === 'timeline'
        ? date < range.start || date >= windowEnd(range)
        : !taskMatchesWindow(task, range))
    ) {
      const atTask = readTaskWindow(
        new URLSearchParams({ scope: range.scope === 'custom' ? 'today' : range.scope }),
        new Date(date),
        data.settings.weekStartsOn,
      );
      params.set('scope', 'custom');
      params.set('from', dayKeyOf(atTask.start));
      params.set(
        'to',
        dayKeyOf(
          addDays(atTask.start, range.scope === 'custom' ? range.days - 1 : atTask.days - 1),
        ),
      );
    } else if (range.scope === 'undated') params.set('scope', 'all');
  }
  return `/tasks?${params}`;
}

export function taskSavedViewHref(
  data: NexusData,
  id: string,
  saved: SavedTaskView,
  now = Date.now(),
): string | null {
  return locateInWorkspace(data, id, new URLSearchParams(savedViewHref(saved).split('?')[1]), now);
}

export function taskCurrentViewHref(data: NexusData, id: string, now = Date.now()): string | null {
  return locateInWorkspace(data, id, new URLSearchParams({ view: 'gantt', scope: 'week' }), now);
}

/** A navigation target may be revealed without changing saved completion preferences. */
export function focusedTaskPath(tasks: Task[], params: URLSearchParams): Set<string> {
  const id = params.get('focusTask');
  return new Set(id ? taskPath(tasks, id).map((task) => task.id) : []);
}
