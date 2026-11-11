import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, Plus, CircleDot, Info, Trash2, Shapes, CornerUpRight } from 'lucide-react';
import { useNavigate } from 'react-router';
import { cn } from '@nexus/ui';
import { addDays, dayKeyOf, endOfDay, newOrder, PRIORITY_META, PRIORITY_ORDER, isStructural, isProject } from '@nexus/core';
import { useNexus, useNexusData } from '@nexus/crdt';
import { useUI } from '@/state/ui';
import { TASK_VIEWS } from '@/features/tasks/viewOptions';
import { taskCurrentViewHref, taskSavedViewHref, taskViewHref } from '@/features/tasks/taskNavigation';
import { commitTaskTextDrafts } from './useTaskTextDraft';

const TIME_OPTIONS: { label: string; apply: (now: Date) => number | null }[] = [
  { label: '今天', apply: (now) => endOfDay(now).getTime() - 60000 },
  { label: '明天', apply: (now) => endOfDay(addDays(now, 1)).getTime() - 60000 },
  { label: '未来 7 天内', apply: (now) => endOfDay(addDays(now, 7)).getTime() - 60000 },
  { label: '清除日期', apply: () => null },
];

const itemCls =
  'flex w-full cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors text-foreground hover:bg-[color-mix(in_srgb,var(--accent-from)_14%,transparent)] focus-visible:bg-[var(--surface)] disabled:opacity-50';

function MenuItem({ children, onSelect, danger, onHover, disabled = false }: {
  disabled?: boolean;
  children: React.ReactNode;
  onSelect: (el: HTMLElement) => void;
  danger?: boolean;
  /** 悬停:有子菜单的条目借它弹级联面板,普通条目借它收起面板 */
  onHover?: (el: HTMLElement) => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={(e) => onSelect(e.currentTarget)}
      onMouseEnter={(e) => onHover?.(e.currentTarget)}
      className={cn(itemCls, danger && 'text-[var(--danger)] hover:bg-[var(--danger)]/10')}
    >
      {children}
    </button>
  );
}

export function TaskMenu() {
  const data = useNexusData();
  const store = useNexus();
  const ui = useUI();
  const navigate = useNavigate();
  const menu = ui.taskMenu;
  const [sub, setSub] = useState<'main' | 'time' | 'priority' | 'views'>('main');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 级联子菜单的落点(悬停到条目时按其 rect 计算:右侧优先,放不下翻左侧) */
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelCloseSub = () => {
    if (closeTimer.current != null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  /** 离开菜单主体/子菜单一小段宽限期后才收起(鼠标跨过 4px 缝隙不算离开) */
  const scheduleCloseSub = () => {
    cancelCloseSub();
    closeTimer.current = window.setTimeout(() => { setSub('main'); setSubPos(null); }, 160);
  };
  const openSub = (which: 'time' | 'priority' | 'views', el: HTMLElement) => {
    cancelCloseSub();
    const SW = which === 'views' ? 224 : 176, SH = Math.min(which === 'views' ? 440 : 240, window.innerHeight - 16);
    const r = el.getBoundingClientRect();
    // 锚定主面板边缘(而非条目边缘),与面板齐平无缝隙;右侧优先,放不下翻左侧
    const panel = el.closest('.glass-raised')?.getBoundingClientRect();
    let left = (panel?.right ?? r.right) + 4;
    if (left + SW > window.innerWidth - 8) left = Math.max(8, (panel?.left ?? r.left) - SW - 4);
    let top = r.top - 6; // 与被悬停条目顶部对齐
    top = Math.max(8, Math.min(top, window.innerHeight - SH - 8));
    setSub(which);
    setSubPos({ left, top });
  };
  const clearSub = () => { cancelCloseSub(); setSub('main'); setSubPos(null); };

  // 每次打开都回到主菜单
  useEffect(() => {
    if (menu) { clearSub(); setError(''); }
  }, [menu]);
  useEffect(() => cancelCloseSub, []);

  // Escape 关闭
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) ui.closeTaskMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, ui, busy]);

  if (!menu) return null;
  const task = data.tasks.find((t) => t.id === menu.taskId);
  if (!task) return null;

  // 批量目标:右键时若已多选 → 操作作用于整批;否则仅当前任务
  const ids = [...new Set(menu.ids ?? [task.id])];
  const multi = ids.length > 1;
  const structural = isStructural(task); // 结构节点:菜单里不给时间/优先级,给「转回 TODO」
  const project = isProject(task);
  const selectedIds = new Set(ids);
  const targets = data.tasks.filter(item => selectedIds.has(item.id) && item.deletedAt == null && item.status !== 'archived');
  const editableCount = targets.filter(item => !isStructural(item)).length;
  const convertible = targets.filter(item => !isProject(item));
  const toGroupCount = convertible.filter(item => !isStructural(item)).length;
  const toTaskCount = convertible.filter(isStructural).length;
  const projectCount = targets.filter(isProject).length;

  // 视图越界修正
  const W = 232, H = Math.min(440, window.innerHeight - 16);
  const x = Math.max(8, Math.min(menu.x, window.innerWidth - W - 8));
  const y = Math.max(8, Math.min(menu.y, window.innerHeight - H - 8));

  // id → 直接子 id 映射(用于折叠/展开整棵子树)
  const childrenIds = new Map<string, string[]>();
  for (const t of data.tasks) {
    if (t.parentId == null || t.deletedAt) continue;
    const arr = childrenIds.get(t.parentId);
    if (arr) arr.push(t.id);
    else childrenIds.set(t.parentId, [t.id]);
  }
  const branchIds = ids.filter(id => (childrenIds.get(id)?.length ?? 0) > 0);

  const close = () => {
    if (busy) return;
    ui.closeTaskMenu();
    setSub('main');
  };

  const persistAction = async (action: () => void) => {
    if (busy) return;
    setBusy(true);
    setError('');
    let applied = false;
    try {
      store.stopUndoCapture();
      action();
      applied = true;
      store.stopUndoCapture();
      await store.flushPersistence();
      ui.closeTaskMenu();
    } catch (reason) {
      setError(applied ? '更改已应用，本地保存失败，请保持页面打开并导出备份。' : reason instanceof Error ? reason.message : '操作未完成，请重试。');
    } finally {
      setBusy(false);
    }
  };

  const addChild = () => {
    const kids = (childrenIds.get(task.id) ?? []).map((id) => data.tasks.find((t) => t.id === id)).filter(Boolean);
    const created = store.createTask({ title: '', status: 'todo', parentId: task.id, order: newOrder(kids.at(-1)?.order) });
    close();
    ui.selectTask(created.id);
  };

  const goTo = async (href: string) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await commitTaskTextDrafts();
      ui.selectTask(null); ui.closeTaskMenu(); navigate(href);
    } catch { setError('本地保存失败，尚未跳转，请重试。'); }
    finally { setBusy(false); }
  };


  return (
    <div
      data-task-menu
      className="fixed inset-0 z-50"
      onContextMenu={(e) => e.preventDefault()}
      onClick={close}
    >
      {/* 主菜单:悬停到带 › 的条目即在旁边弹级联子菜单(主菜单不消失) */}
      <div
        onClick={(e) => e.stopPropagation()}
        onMouseLeave={scheduleCloseSub}
        aria-label="任务菜单"
        className="glass-raised fixed max-h-[calc(100dvh-16px)] w-[232px] overflow-y-auto rounded-xl p-1.5 shadow-xl"
        style={{ left: x, top: y }}
      >
        <div className="flex flex-col">
          <div className="truncate px-2.5 py-1.5 text-xs text-muted">{multi ? `已选 ${ids.length} 项` : task.title || 'Untitled'}</div>
          {!multi && <><MenuItem disabled={busy} onHover={clearSub} onSelect={addChild}>
            <Plus className="h-4 w-4 shrink-0" /> 创建子任务
          </MenuItem>
          <MenuItem disabled={busy} onHover={clearSub} onSelect={() => { close(); ui.selectTask(task.id); }}>
            <Info className="h-4 w-4 shrink-0" /> {project ? '编辑项目' : '打开详情'}
          </MenuItem>
          <MenuItem disabled={busy} onHover={el => openSub('views', el)} onSelect={el => openSub('views', el)}><CornerUpRight className="h-4 w-4 shrink-0" />跳转到视图<ChevronRight className="ml-auto h-3.5 w-3.5 text-muted" /></MenuItem>
          </>}
          {multi && <>
            <MenuItem disabled={busy || toGroupCount === 0} onHover={clearSub} onSelect={() => { void persistAction(() => { store.setTaskKinds(ids, 'node'); }); }}>
              <Shapes className="h-4 w-4 shrink-0" />转为分组<span className="ml-auto text-xs text-muted">{toGroupCount} 项</span>
            </MenuItem>
            <MenuItem disabled={busy || toTaskCount === 0} onHover={clearSub} onSelect={() => { void persistAction(() => { store.setTaskKinds(ids, 'todo'); }); }}>
              <CircleDot className="h-4 w-4 shrink-0" />转为 Task<span className="ml-auto text-xs text-muted">{toTaskCount} 项</span>
            </MenuItem>
            {projectCount > 0 && <p className="px-2.5 py-1 text-[10px] text-muted">{projectCount} 个项目保留项目身份，不参与类型转换</p>}
          </>}
          {!project && !multi && <MenuItem disabled={busy}
            onHover={clearSub}
            onSelect={() => { void persistAction(() => store.setTaskKind(task.id, structural ? 'todo' : 'node')); }}
          >
            <Shapes className="h-4 w-4 shrink-0" />
            {structural ? '转为 TODO 任务' : task.parentId === null ? '转为项目' : '转为分组'}
          </MenuItem>}
          {project && !multi && <MenuItem disabled={busy} onHover={clearSub} onSelect={() => { void persistAction(() => store.setTaskStatus(task.id, 'archived')); }}>归档项目</MenuItem>}
          {editableCount > 0 && (
            <>
              <MenuItem disabled={busy} onHover={(el) => openSub('time', el)} onSelect={(el) => openSub('time', el)}>
                设定时间 <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted" />
              </MenuItem>
              <MenuItem disabled={busy} onHover={(el) => openSub('priority', el)} onSelect={(el) => openSub('priority', el)}>
                优先级 <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted" />
              </MenuItem>
            </>
          )}
          {multi && editableCount > 0 && (
            <div className="truncate px-2.5 pb-0.5 text-[10px] text-[var(--accent-from)]">
              时间与优先级可设置 {editableCount} 项 Task
            </div>
          )}
          {branchIds.length > 0 && (
            <>
              <div className="my-1 h-px bg-[var(--border)]" />
              <MenuItem disabled={busy} onHover={clearSub} onSelect={() => { ui.setSubtreesCollapsed(branchIds, childrenIds, true); close(); }}>
                折叠全部子任务
              </MenuItem>
              <MenuItem disabled={busy} onHover={clearSub} onSelect={() => { ui.setSubtreesCollapsed(branchIds, childrenIds, false); close(); }}>
                展开全部子任务
              </MenuItem>
            </>
          )}
          <div className="my-1 h-px bg-[var(--border)]" />
          <MenuItem disabled={busy} danger onHover={clearSub} onSelect={() => {
            if (data.tasks.some((task) => ids.includes(task.id) && isProject(task))) ui.requestTaskDeletion(store.userId, ids);
            else void persistAction(() => { ids.forEach((id) => store.softDeleteTask(id)); });
          }}>
            <Trash2 className="h-4 w-4 shrink-0" /> {multi ? `删除 ${ids.length} 个任务` : project ? '删除项目' : '删除任务'}
          </MenuItem>
          {busy && <p role="status" className="px-2.5 py-1 text-xs text-muted">正在保存…</p>}
          {error && <p role="alert" className="max-w-56 px-2.5 py-1 text-xs text-[var(--danger)]">{error}</p>}
        </div>
      </div>

      {/* 级联子菜单:右侧优先,右边放不下翻左侧;鼠标跨缝隙有 160ms 宽限 */}
      {sub !== 'main' && subPos && (
        <div
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={cancelCloseSub}
          onMouseLeave={scheduleCloseSub}
          aria-label={sub === 'views' ? '跳转到视图' : undefined}
          className={cn('glass-raised fixed z-50 max-h-[min(440px,calc(100dvh-16px))] overflow-y-auto rounded-xl p-1.5 shadow-xl', sub === 'views' ? 'w-56' : 'min-w-[176px]')}
          style={{ left: subPos.left, top: subPos.top }}
        >
          {sub === 'time' && (
            <div className="flex flex-col">
              {/* 子菜单里的选项不挂 onHover:悬停选项不收起子菜单(级联菜单语义);
                  曾因 clearSub 在 mouseenter 触发卸载面板,click 落在被移除节点上被吞 */}
              {TIME_OPTIONS.map((o) => (
                <MenuItem disabled={busy} key={o.label} onSelect={() => {
                  const value = o.apply(new Date());
                  void persistAction(() => {
                    store.setTaskBatch(ids, value === null
                      ? { startAt: { action: 'clear' }, dueAt: { action: 'clear' } }
                      : { dueAt: { action: 'set', date: dayKeyOf(value), ...(!multi ? { time: '23:59' } : {}) } });
                  });
                }}>
                  {o.label}
                </MenuItem>
              ))}
              <div className="my-1 h-px bg-[var(--border)]" />
              <MenuItem disabled={busy} onSelect={() => { if (multi) ui.openTaskBatch(store.userId, ids, 'time'); else { close(); ui.selectTask(task.id); } }}>
                <CircleDot className="h-4 w-4 shrink-0 text-muted" /> 自定义… <span className="text-xs text-muted/60">{multi ? '批量设置' : '打开详情'}</span>
              </MenuItem>
            </div>
          )}
          {sub === 'priority' && (
            <div className="flex flex-col">
              {PRIORITY_ORDER.map((p) => (
                <MenuItem disabled={busy} key={p} onSelect={() => { void persistAction(() => { store.setTaskBatch(ids, { priority: p }); }); }}>
                  {PRIORITY_META[p].label}
                </MenuItem>
              ))}
              <div className="my-1 h-px bg-[var(--border)]" />
              <MenuItem disabled={busy} onSelect={() => { void persistAction(() => { store.setTaskBatch(ids, { priority: 'P3' }); }); }}>
                清除优先级(P3)
              </MenuItem>
            </div>
          )}
          {sub === 'views' && <div className="flex flex-col">
            <p className="px-2.5 py-1.5 text-[11px] text-muted">所属项目／任务分支</p>
            {TASK_VIEWS.map(({ key, label, icon: Icon }) => {
              const href = taskViewHref(data, task.id, key);
              return <MenuItem key={key} disabled={busy || !href} onSelect={() => { if (href) void goTo(href); }}><Icon size={14} />{label}</MenuItem>;
            })}
            <div className="my-1 h-px bg-[var(--border)]" />
            <MenuItem disabled={busy || !taskCurrentViewHref(data, task.id)} onSelect={() => { const href = taskCurrentViewHref(data, task.id); if (href) void goTo(href); }}>当前任务</MenuItem>
            {data.settings.savedViews.length > 0 && <><div className="my-1 h-px bg-[var(--border)]" /><p className="px-2.5 py-1.5 text-[11px] text-muted">快捷视图</p></>}
            {data.settings.savedViews.map(saved => {
              const href = taskSavedViewHref(data, task.id, saved);
              return <MenuItem key={saved.id} disabled={busy || !href} onSelect={() => { if (href) void goTo(href); }}><span className="truncate" title={href ? saved.name : `${saved.name}：不包含此任务的项目，或不支持结构节点`}>{saved.name}</span></MenuItem>;
            })}
          </div>}
        </div>
      )}
    </div>
  );
}
