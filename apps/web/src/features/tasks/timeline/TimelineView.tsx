import { TaskTitle, TaskTitleButton } from '@/shared/TaskTitle';
import React, { useRef, useState } from 'react';
import { DayView } from './DayView';
import { WeekView } from './WeekView';
import { MonthView } from './MonthView';
import { CalendarTaskDraft, type TaskDraftAnchor } from './CalendarTaskDraft';
import { useTaskWindow } from '../TaskWindowControls';
import { isCalendarMonth } from '../taskWindow';
import { useTaskViewData } from '../useTaskViewData';
import { useUI } from '@/state/ui';
import { useTaskDomFocus } from '../useTaskDomFocus';
import { compareTaskPriority } from '@nexus/core';
import { PriorityDot } from '@/shared/components';

/** The calendar is a task workspace view; the former /calendar route redirects here. */
export function CalendarView() {
  const { range, setRange } = useTaskWindow(true);
  const data = useTaskViewData({ ancestors: false });
  const container = useRef<HTMLDivElement>(null);
  useTaskDomFocus(container, 'data-calendar-task', data);
  const selectTask = useUI(state => state.selectTask);
  const scheduled = new Set(data.events.filter(event => !event.completed && event.end > Date.now()).map(event => event.taskId));
  const undated = data.tasks.filter(task => task.startAt == null && task.dueAt == null && !scheduled.has(task.id)).sort(compareTaskPriority);
  const [taskDraft, setTaskDraft] = useState<TaskDraftAnchor | null>(null);
  const viewProps = {
    date: new Date(range.start),
    onDateChange: (next: Date) => setRange(next.getTime(), 1),
    onCreateTask: (dueAt: number, event: { clientX: number; clientY: number }) => setTaskDraft({ dueAt, x: event.clientX, y: event.clientY }),
  };
  return <div ref={container} className="flex h-full flex-col">
    <div className="min-h-0 flex-1">
      {range.days === 1 ? <DayView {...viewProps} /> : isCalendarMonth(range) ? <MonthView {...viewProps} /> : <WeekView {...viewProps} rangeStart={new Date(range.start)} dayCount={range.days} />}
    </div>
    {range.days > 1 && undated.length > 0 && <div role="region" aria-label="日历未排期任务" className="flex max-h-24 shrink-0 flex-wrap items-center gap-2 overflow-y-auto border-t border-[var(--border)] px-4 py-2 text-xs">
      <span className="text-muted">未排期 · {undated.length}</span>
      {undated.map(task => <TaskTitleButton taskTitle={task.title} key={task.id} data-task-detail-trigger data-calendar-task={task.id} data-focused={task.id === data.focusedTaskId || undefined} className="inline-flex max-w-60 items-center gap-1.5 rounded-md bg-[var(--surface)] px-2 py-1 text-left hover:bg-[var(--selection)] data-[focused]:ring-2 data-[focused]:ring-[var(--accent-solid)]" onContextMenu={event => { event.preventDefault(); event.stopPropagation(); useUI.getState().openTaskMenu(task.id, event.clientX, event.clientY); }} onClick={() => selectTask(task.id)}><PriorityDot task={task} /><span className="truncate"><TaskTitle title={task.title} /></span></TaskTitleButton>)}
    </div>}
    {taskDraft && <CalendarTaskDraft key={`${taskDraft.dueAt}:${taskDraft.x}:${taskDraft.y}`} anchor={taskDraft} onDismiss={() => setTaskDraft(null)} onCreated={() => setTaskDraft(null)} />}
  </div>;
}
