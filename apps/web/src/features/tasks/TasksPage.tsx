import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger, Segmented, SegmentedList, SegmentedTrigger } from '@nexus/ui';
import {
  BookmarkPlus,
  Check,
  Inbox,
  Library,
  MoreHorizontal,
  SlidersHorizontal,
} from 'lucide-react';
import { useNexus, useNexusData } from '@nexus/crdt';
import { activeTasks, isProject, normalizeTaskView, workProgress } from '@nexus/core';
import { useUI } from '@/state/ui';
import { isTaskView, projectView, rememberProjectView, useProjectViewMemory } from './projectViews';
import { TaskWindowControls } from './TaskWindowControls';
import { TASK_VIEWS } from './viewOptions';
import { SaveViewButton } from './savedViews/SaveViewButton';
import { MoreTaskFilters, TaskFilterControls, TaskSortControl } from './TaskFilterControls';
import { isScheduledOnlyWorkspace } from './taskWindow';
import { taskPath } from './taskNavigation';
const ListView = lazy(() => import('./list/ListView').then((module) => ({ default: module.ListView })));
const MatrixView = lazy(() =>
  import('./matrix/MatrixView').then((module) => ({ default: module.MatrixView })),
);
const MindMapView = lazy(() =>
  import('./mindmap/MindMapView').then((module) => ({ default: module.MindMapView })),
);
const CalendarView = lazy(() =>
  import('./timeline/TimelineView').then((module) => ({ default: module.CalendarView })),
);
const GanttView = lazy(() => import('./gantt/GanttView').then((module) => ({ default: module.GanttView })));

export default function TasksPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const revealed = useRef('');
  const requested = params.get('view');
  const scope = params.get('scope');
  const data = useNexusData();
  const store = useNexus();
  const memory = useProjectViewMemory();
  const projectId = params.get('project');
  const saved = data.settings.savedViews.find((item) => item.id === params.get('saved'));
  const project = data.tasks.find((task) => task.id === projectId && !task.deletedAt && task.status !== 'archived' && isProject(task));
  const view = normalizeTaskView(requested) ?? (
    projectId ? projectView(memory, projectId) : scope === 'week' ? 'gantt' : 'list');
  const scheduledOnly = isScheduledOnlyWorkspace(params, data.settings);
  useEffect(() => {
    const unsupportedUndated = scheduledOnly && scope === 'undated';
    const needsTimeRange = ['gantt', 'timeline'].includes(view) && !['today', 'week', 'month', 'custom', 'all', 'undated'].includes(scope ?? '');
    if (isTaskView(requested) && !needsTimeRange && !unsupportedUndated) return;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('view', view);
      if (needsTimeRange || unsupportedUndated) { next.set('scope', 'week'); next.delete('from'); next.delete('to'); }
      return next;
    }, { replace: true });
  }, [requested, view, scheduledOnly, scope, setParams]);
  useEffect(() => {
    if (project && !saved) rememberProjectView(store.userId, project.id, view);
  }, [store.userId, project?.id, saved?.id, view]);
  const progress = useMemo(() => workProgress(activeTasks(data.tasks)), [data.tasks]);
  const projectProgress = project ? progress.get(project.id) : null;
  const title = saved?.name || project?.title || '任务';
  const display = data.settings.completedDisplay ?? 'inline-gray';
  const ui = useUI();
  const setCompletedDisplay = (hidden: boolean) => {
    if (params.has('focusTask')) {
      const next = new URLSearchParams(window.location.search); next.delete('focusTask'); setParams(next, { replace: true });
    }
    store.updateSettings({ completedDisplay: hidden ? 'hidden' : 'inline-gray' });
  };
  useEffect(() => {
    const id = params.get('focusTask'), request = `${location.key}:${id}`;
    if (!id || revealed.current === request) return;
    const path = taskPath(data.tasks, id);
    if (!path.length) return;
    revealed.current = request;
    useUI.setState(state => ({ collapsed: { ...state.collapsed, ...Object.fromEntries(path.map(task => [task.id, false])) } }));
  }, [params, location.key, data.tasks]);
  const [focusToolbar, setFocusToolbar] = useState<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const savingView = useRef(false);

  if (projectId && !project) return (
    <div className="space-y-3 p-6 text-sm text-muted">
      <p>项目不存在或已归档。</p>
      <Link to="/tasks?scope=week" className="text-[var(--accent-solid)]">返回本周任务</Link>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div data-task-toolbar className="task-toolbar flex min-h-12 shrink-0 items-center gap-1 px-3 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 title={title} aria-label={title} className="task-toolbar-title min-w-0 flex-1 truncate">
            {project && !saved ? <button className="block w-full truncate text-left" aria-label={`编辑项目 ${title}`} onClick={() => ui.selectTask(project.id)}>{title}</button> : title}
          </h1>
        </div>
        <Segmented
          className="flex shrink-0 md:order-2"
          value={view}
          onValueChange={(v) => {
            const next = new URLSearchParams(window.location.search);
            next.set('view', v);
            if (projectId && !saved) {
              next.delete('root');
            }
            setParams(next, { replace: true });
          }}
        >
          <SegmentedList aria-label="任务视图" className="gap-0">
            {TASK_VIEWS.map(({ key, label, icon: Icon }) => (
              <SegmentedTrigger
                key={key}
                value={key}
                aria-label={label}
                title={label}
                className="inline-flex h-7 w-7 items-center justify-center gap-1.5 p-0 md:w-auto md:px-2"
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="hidden md:inline">{label}</span>
              </SegmentedTrigger>
            ))}
          </SegmentedList>
        </Segmented>

        {view === 'mindmap' && <Dropdown>
          <DropdownTrigger asChild><button aria-label="任务交互设置" title="任务交互设置" className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] text-muted hover:bg-[var(--surface)] hover:text-foreground md:order-last md:ml-0"><SlidersHorizontal size={16} /></button></DropdownTrigger>
          <DropdownContent align="end" collisionPadding={12}>
            <DropdownLabel>导图交互</DropdownLabel>
            <DropdownItem role="menuitemcheckbox" aria-checked={data.settings.mindClickOpensDetails !== false} onSelect={() => store.updateSettings({ mindClickOpensDetails: data.settings.mindClickOpensDetails === false })}><Check size={15} className={data.settings.mindClickOpensDetails !== false ? '' : 'opacity-0'} />单击任务打开详情</DropdownItem>
            <p className="max-w-64 px-2.5 py-1.5 text-micro leading-relaxed text-muted">关闭后，单击仅选中；仍可用详情按钮或 ⌘ / Ctrl + Enter 打开。</p>
          </DropdownContent>
        </Dropdown>}

        <div className={view === 'mindmap' ? 'shrink-0 md:order-3 xl:hidden' : 'ml-auto shrink-0 md:order-3 xl:hidden'}>
          <SaveViewButton key={store.userId} view={view} restoreFocus={() => moreRef.current?.focus()} trigger={(openSave) => (
          <Dropdown>
            <DropdownTrigger asChild><button ref={moreRef} aria-label="任务更多操作" title="任务更多操作" className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-muted hover:bg-[var(--surface)] hover:text-foreground"><MoreHorizontal size={17} /></button></DropdownTrigger>
            <DropdownContent align="end" collisionPadding={12} aria-label="任务更多操作" onCloseAutoFocus={(event) => {
              if (savingView.current) { event.preventDefault(); savingView.current = false; }
            }}>
              {projectProgress && projectProgress.total > 0 && <DropdownLabel>项目进度 {projectProgress.done}/{projectProgress.total}</DropdownLabel>}
              <DropdownItem role="menuitemcheckbox" aria-checked={display === 'hidden'} onSelect={() => setCompletedDisplay(display !== 'hidden')}><Check size={15} className={display === 'hidden' ? '' : 'opacity-0'} />隐藏已完成</DropdownItem>
              <DropdownItem onSelect={() => { savingView.current = true; openSave(); }}><BookmarkPlus size={15} />保存为快捷视图</DropdownItem>
              {project && <DropdownItem onSelect={() => {
                const rect = moreRef.current?.getBoundingClientRect();
                if (rect) ui.openTaskMenu(project.id, rect.left, rect.bottom + 4);
              }}><MoreHorizontal size={15} />项目操作</DropdownItem>}
              <DropdownSeparator />
              <DropdownItem asChild><Link to="/gallery"><Library size={15} />模板</Link></DropdownItem>
              <DropdownItem asChild><Link to="/inbox"><Inbox size={15} />收集箱</Link></DropdownItem>
            </DropdownContent>
          </Dropdown>
          )} />
        </div>

        {/* 右上角:已完成任务展现 + Gallery 入口 */}
        <div className="hidden shrink-0 items-center gap-2 xl:flex">
          <SaveViewButton key={store.userId} view={view} />
          {projectProgress && projectProgress.total > 0 && <span aria-label="项目进度" className="text-xs tabular-nums text-muted">{projectProgress.done}/{projectProgress.total}</span>}
          {project && <button aria-label="项目菜单" title="项目菜单" className="text-muted hover:text-foreground" onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            ui.openTaskMenu(project.id, rect.left, rect.bottom + 4);
          }}><MoreHorizontal size={16} /></button>}
          <label className="inline-flex h-8 cursor-pointer select-none items-center gap-2 rounded-[var(--radius-sm)] px-2 text-xs text-muted hover:text-foreground">
            <input
              type="checkbox"
              checked={display === 'hidden'}
              onChange={(event) => setCompletedDisplay(event.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-[var(--accent-solid)]"
            />
            隐藏已完成
          </label>
          <Link
            to="/gallery"
            className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1 text-xs text-muted transition-colors hover:text-foreground"
            title="Gallery 精选路线图"
          >
            <Library className="h-3.5 w-3.5" /> 模板
          </Link>
        </div>
      </div>
      <div ref={setFocusToolbar} aria-label="任务筛选与强调" className="task-filters flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border-hairline)] px-3 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <div className="min-w-0 overflow-x-auto no-scrollbar"><TaskFilterControls /></div>
          <div className="shrink-0 md:order-2"><MoreTaskFilters /></div>
          {['list', 'gantt'].includes(view) && <div className="shrink-0 md:order-3"><TaskSortControl /></div>}
        </div>
        <div className="order-first min-w-0 w-full md:order-1 md:flex md:w-auto md:max-w-full md:items-center md:gap-2">
          <span className="hidden shrink-0 text-micro text-muted md:inline">时间</span>
          <TaskWindowControls temporal={['gantt', 'timeline'].includes(view)} />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div role="status" className="p-6 text-sm text-muted">
              正在载入视图…
            </div>
          }
        >
          {view === 'list' && <ListView key={`list:${projectId ?? 'all'}`} />}
          {view === 'timeline' && <CalendarView key={`timeline:${projectId ?? 'all'}`} />}
          {view === 'gantt' && <GanttView key={`gantt:${projectId ?? 'all'}`} />}
          {view === 'matrix' && <MatrixView key={`matrix:${projectId ?? 'all'}`} />}
          {view === 'mindmap' && <MindMapView key={`mindmap:${projectId ?? 'all'}`} focusToolbar={focusToolbar} />}
        </Suspense>
      </div>
    </div>
  );
}
