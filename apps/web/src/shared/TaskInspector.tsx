import React, { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Plus, X, MoreHorizontal, ChevronRight, Folder, FileText, Settings2 } from 'lucide-react';
import { cn, SheetTitle, SelectField } from '@nexus/ui';
import {
  type Task,
  ancestorsOf,
  isStructural,
  isProject,
  isTextNode,
  priorityOf,
  needsPriorityReview,
  type Priority,
} from '@nexus/core';
import { useNexus, useNexusData } from '@nexus/crdt';
import { useUI } from '@/state/ui';
import { TaskCheckbox, DateTimeField } from './components';
import { isComposing } from './ime';
import { TaskWorkspace, TaskWorkspaceShortcuts } from './TaskWorkspace';
import { useTaskTextDraft } from './useTaskTextDraft';
import { TaskViewLinks } from './TaskViewLinks';
import { TaskAdvancedSettings } from './TaskAdvancedSettings';
import { NodeWorkspace } from './NodeWorkspace';
import { TaskDescription } from './TaskDescription';
import { WorkspaceConfiguration } from './WorkspaceConfiguration';
import { TaskTitle, TaskTitleButton } from './TaskTitle';
import { parseTaskTitle } from '@nexus/core';
import { pasteTaskTitle } from './taskTitlePaste';

export interface TaskInspectorHandle {
  commit: () => Promise<void>;
}
interface Props {
  task: Task | null;
  onAddChild?: () => void;
  onClose: () => void;
  onSelectTask?: (id: string) => void;
  position?: { x: number; y: number };
  docked?: boolean;
  embedded?: boolean;
}

/** One detail UI for maps, calendars, Gantt, matrix and the compact list dock. */
export const TaskInspector = forwardRef<TaskInspectorHandle, Props>(function TaskInspector(
  { task: selectedTask, onAddChild, onClose, onSelectTask, position, docked, embedded },
  ref,
) {
  const data = useNexusData(),
    store = useNexus();
  const globalSelect = useUI((state) => state.selectTask);
  const selectTask = onSelectTask ?? globalSelect;
  const task = selectedTask
    ? (data.tasks.find((item) => item.id === selectedTask.id) ?? null)
    : null;
  const draft = useTaskTextDraft(task);
  useImperativeHandle(ref, () => ({ commit: draft.commit }));
  const body = useRef<HTMLDivElement>(null),
    advancedRef = useRef<HTMLDivElement>(null),
    subRef = useRef<HTMLInputElement>(null);
  const activeId = useRef(task?.id);
  activeId.current = task?.id;
  const [advanced, setAdvanced] = useState(false),
    [addingChild, setAddingChild] = useState(false),
    [workspaceConfigOpen, setWorkspaceConfigOpen] = useState(false);
  const [subInput, setSubInput] = useState(''),
    [chainDue, setChainDue] = useState(0);
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
    setAdvanced(false);
    setAddingChild(false);
    setWorkspaceConfigOpen(false);
    setSubInput('');
    setChainDue(0);
  }, [task?.id, store.userId]);
  useLayoutEffect(() => {
    if (advanced) advancedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [advanced]);
  useLayoutEffect(() => {
    if (addingChild) subRef.current?.focus();
  }, [addingChild]);
  if (!task) return null;
  const parents = ancestorsOf(task.id, new Map(data.tasks.map((item) => [item.id, item])));
  const children = data.tasks
    .filter((item) => item.parentId === task.id && !item.deletedAt && item.status !== 'archived')
    .sort((a, b) => a.order - b.order);
  const node = isStructural(task),
    Title = embedded ? SheetTitle : 'span';
  const text = isTextNode(task);
  const NodeIcon = isProject(task) ? Folder : FileText;
  const dismiss = () => {
    const id = task.id;
    draft.close(() => {
      if (activeId.current === id) onClose();
    });
  };
  const configureWorkspace = () => {
    const id = task.id;
    draft.close(() => {
      if (activeId.current === id) setWorkspaceConfigOpen(true);
    });
  };
  const style =
    !docked && !embedded
      ? {
          right: position ? Math.max(12, window.innerWidth - position.x) : 12,
          top: position ? Math.max(12, Math.min(position.y, window.innerHeight - 430)) : 12,
        }
      : undefined;
  return (
    <section
      data-inspector
      aria-label="任务详情"
      style={style}
      onKeyDown={(event) => {
        if (
          event.key !== 'Escape' ||
          isComposing(event) ||
          (event.target as HTMLElement).matches('input[type="datetime-local"]')
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }}
      className={cn(
        docked || embedded
          ? 'flex h-full min-h-0 w-full flex-col'
          : 'fixed z-30 flex max-h-[min(760px,calc(100dvh-112px))] w-[min(360px,calc(100vw-24px))] flex-col rounded-lg border border-[var(--border)] bg-[var(--background)] shadow-lg',
      )}
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-5">
        <Title className="text-xs font-normal text-muted">
          {isProject(task) ? '项目详情' : text ? '文本节点详情' : '任务详情'}
        </Title>
        <span
          role="status"
          aria-label="任务保存状态"
          className="ml-auto mr-3 text-[10px] text-muted"
        >
          {draft.status}
        </span>
        <button
          type="button"
          aria-label="打开 Workspace 配置"
          aria-haspopup="dialog"
          onClick={configureWorkspace}
          className="mr-2 flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-[var(--surface)] hover:text-foreground"
        >
          <Settings2 size={14} />
          Workspace
        </button>
        <button
          aria-label="关闭任务详情"
          onClick={dismiss}
          className="rounded p-1 text-muted hover:text-foreground"
        >
          <X size={16} strokeWidth={1.6} />
        </button>
      </header>
      <TaskViewLinks task={task} beforeNavigate={draft.commit} onNavigate={onClose} />
      <TaskWorkspaceShortcuts taskId={task.id} />
      <div ref={body} data-sheet-scroll className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {parents.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-1 text-[11px] text-muted">
            {parents.map((parent) => (
              <React.Fragment key={parent.id}>
                <button
                  className="max-w-full truncate hover:text-foreground"
                  onClick={() => selectTask(parent.id)}
                >
                  {parent.title}
                </button>
                <ChevronRight size={11} />
              </React.Fragment>
            ))}
          </div>
        )}
        <div className="mb-5 flex items-start gap-2">
          {node ? (
            <NodeIcon size={18} className="mt-1 shrink-0 text-muted" />
          ) : (
            <TaskCheckbox
              className="-ml-1 -mt-0.5"
              done={task.status === 'done'}
              onChange={() => store.toggleTaskDone(task.id)}
            />
          )}
          <div className="min-w-0 flex-1">
          <input
            aria-label="任务标题"
            className={cn(
              'w-full min-w-0 bg-transparent text-[15px] font-medium leading-6 outline-none',
              !node && task.status === 'done' && 'text-muted line-through',
            )}
            value={draft.value('title')}
            onPaste={event => pasteTaskTitle(event, value => draft.change('title', value))}
            onChange={(event) => draft.change('title', event.target.value)}
            onBlur={draft.commit}
            onCompositionStart={draft.compositionStart}
            onCompositionEnd={draft.compositionEnd}
            onKeyDown={(event) => {
              if (!isComposing(event) && event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          {parseTaskTitle(draft.value('title')).some(part => part.href) && <div aria-label="标题链接预览" className="mt-2 break-words text-xs leading-6 text-muted"><TaskTitle title={draft.value('title')} /></div>}
          </div>
        </div>
        {!node && (
          <div aria-label="任务日期与优先级" role="group" className="mb-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,.85fr)] items-start gap-2 text-xs">
            <div className="min-w-0 space-y-1.5">
              <span className="block text-[11px] text-muted">
                开始日期
              </span>
              <DateTimeField
                compact
                key={`${task.id}:start`}
                title="开始时间"
                value={task.startAt}
                onChange={(value) => {
                  store.updateTask(task.id, { startAt: value });
                  if (value != null && task.dueAt == null) setChainDue((key) => key + 1);
                }}
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <span className="block text-[11px] text-muted">
                截止日期
              </span>
              <DateTimeField
                compact
                key={`${task.id}:due`}
                title="截止时间"
                value={task.dueAt}
                autoOpenKey={chainDue}
                onChange={(value) => store.updateTask(task.id, { dueAt: value })}
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <span className="block text-[11px] text-muted">
                优先级
              </span>
              <SelectField
                aria-label="优先级"
                value={needsPriorityReview(task) ? 'unreviewed' : priorityOf(task)}
                onValueChange={(value) => store.setTaskPriority(task.id, value as Priority)}
                className="h-8 w-full gap-1 px-2 [&>span:first-child]:gap-1.5"
                triggerLabel={needsPriorityReview(task) ? '待分级' : priorityOf(task)}
                title={needsPriorityReview(task) ? '待分级 · 默认 P3' : `优先级 ${priorityOf(task)}`}
                options={[
                  ...(needsPriorityReview(task) ? [{ value: 'unreviewed', label: '待分级 · 默认 P3', description: '选择优先级完成分级', color: 'var(--p3)', disabled: true }] : []),
                  { value: 'P0', label: 'P0 · 重要且紧急', description: '立即处理', color: 'var(--p0)' },
                  { value: 'P1', label: 'P1 · 重要', description: '优先投入时间', color: 'var(--p1)' },
                  { value: 'P2', label: 'P2 · 紧急', description: '尽快处理或委托', color: 'var(--p2)' },
                  { value: 'P3', label: 'P3 · 普通', description: '按常规安排', color: 'var(--p3)' },
                ]}
              />
            </div>
          </div>
        )}
        <NodeWorkspace key={`workspace:${store.userId}:${task.id}`} taskId={task.id} beforeAction={draft.commit} />
        <div className="mb-5"><TaskWorkspace key={task.id} taskId={task.id} /></div>
        <TaskDescription key={`description:${store.userId}:${task.id}`} task={task} draft={draft} textNode={text} />
        {(children.length > 0 || addingChild) && (
          <div className="mt-5 border-t border-[var(--border)] pt-4">
            <div className="mb-3 flex items-center justify-between text-xs text-muted">
              <span>
                子任务 ·{' '}
                {children.filter((item) => !isStructural(item) && item.status === 'done').length}/
                {children.filter((item) => !isStructural(item)).length}
              </span>
              {children.some((item) => !isStructural(item) && item.status !== 'done') && (
                <button
                  onClick={() => {
                    for (const item of children)
                      if (!isStructural(item) && item.status !== 'done')
                        store.setTaskStatus(item.id, 'done');
                  }}
                >
                  全部完成
                </button>
              )}
            </div>
            {children.map((item) => (
              <div key={item.id} className="flex items-center gap-1 py-1">
                {!isStructural(item) && (
                  <TaskCheckbox
                    done={item.status === 'done'}
                    onChange={() => store.toggleTaskDone(item.id)}
                  />
                )}
                <TaskTitleButton taskTitle={item.title}
                  onClick={() => selectTask(item.id)}
                  className={cn(
                    'truncate text-left text-xs',
                    !isStructural(item) && item.status === 'done' && 'text-muted line-through',
                  )}
                >
                  <TaskTitle title={item.title} />
                </TaskTitleButton>
              </div>
            ))}
            {addingChild && (
              <input
                ref={subRef}
                aria-label="新子任务标题"
                value={subInput}
                onPaste={event => pasteTaskTitle(event, setSubInput)}
                onChange={(event) => setSubInput(event.target.value)}
                placeholder="添加子任务，回车确认"
                className="mt-2 w-full bg-transparent py-2 text-xs outline-none"
                onKeyDown={(event) => {
                  if (isComposing(event) || event.key !== 'Enter' || !subInput.trim()) return;
                  store.createTask({
                    title: subInput.trim(),
                    status: 'todo',
                    parentId: task.id,
                    order: (children.at(-1)?.order ?? 0) + 1,
                  });
                  setSubInput('');
                }}
              />
            )}
          </div>
        )}
        {advanced && (
          <div
            ref={advancedRef}
            id={`task-advanced-${task.id}`}
            className="mt-5 border-t border-[var(--border)] pt-4"
          >
            <TaskAdvancedSettings
              key={task.id}
              task={task}
              beforeLeave={draft.commit}
              onClose={onClose}
            />
          </div>
        )}
      </div>
      <footer className="flex h-12 shrink-0 items-center justify-between border-t border-[var(--border)] px-5">
        <button
          onClick={() => {
            if (onAddChild) onAddChild();
            else {
              setAddingChild(true);
              subRef.current?.focus();
            }
          }}
          className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
        >
          <Plus size={14} />
          添加子任务
        </button>
        <button
          aria-label="更多任务设置"
          aria-expanded={advanced}
          aria-controls={`task-advanced-${task.id}`}
          onClick={() => setAdvanced((value) => !value)}
          className="flex items-center gap-1 text-xs text-muted hover:text-foreground"
        >
          <MoreHorizontal size={16} />
          更多设置
        </button>
      </footer>
      {workspaceConfigOpen && (
        <WorkspaceConfiguration key={`configuration:${store.userId}:${task.id}`} taskId={task.id} onClose={() => setWorkspaceConfigOpen(false)} />
      )}
    </section>
  );
});
