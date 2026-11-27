import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { SlidersHorizontal } from 'lucide-react';
import { cn, SelectField } from '@nexus/ui';
import { useNexusData } from '@nexus/crdt';
import { readTaskFilters, readTaskSort, selectWorkspaceTasks, TASK_STATUSES, TASK_PRIORITIES } from './taskFilters';
import { useTaskWindow } from './TaskWindowControls';

export function TaskFilterControls() {
  const [params, setParams] = useSearchParams();
  const filters = readTaskFilters(params);
  const data = useNexusData();
  const { range } = useTaskWindow();
  const priorityPreset = filters.focus === 'all' && range.scope === 'all' && filters.status === 'unfinished' && !filters.tagId;
  const selected =
    priorityPreset && (filters.priority === 'high' || filters.priority === 'unreviewed')
      ? filters.priority
      : filters.focus === 'current'
      ? 'current'
      : filters.focus === 'overdue'
        ? 'overdue'
        : filters.focus === 'week' || (filters.focus === 'all' && range.scope === 'week')
          ? 'week'
          : filters.focus === 'all' && range.scope === 'all'
            ? 'all'
            : null;
  const presets = [
    ['all', '全部', '全部任务，不限制日期或工作状态'],
    ['current', '推进与逾期', '已到开始时间的进行中任务，以及所有未完成的逾期任务'],
    ['high', '高优', '集中查看未完成的 P0 / P1 任务，按优先级排列'],
    ['unreviewed', '待分级', '尚未主动选择优先级的未完成任务，当前按 P3 处理'],
    ['week', '本周', '本周有开始、截止或关联日程的任务'],
    ['overdue', '逾期', '截止时间已过且尚未完成的任务'],
  ] as const;
  const counts = useMemo(() => {
    const result = { high: 0, unreviewed: 0 };
    for (const key of ['high', 'unreviewed'] as const) {
      const query = new URLSearchParams(params);
      query.set('work', 'all'); query.set('scope', 'all'); query.set('taskStatus', 'unfinished'); query.set('taskPriority', key);
      query.delete('taskTag'); query.delete('focusTask');
      result[key] = selectWorkspaceTasks(data, query, new Date()).matching.size;
    }
    return result;
  }, [data, params]);
  return (
    <div role="region" aria-label="工作概览" className="flex shrink-0 items-center gap-1 text-xs">
      {presets.map(([key, label, hint]) => (
        <button
          key={key}
          type="button"
          aria-label={label}
          aria-pressed={selected === key}
          title={hint}
          onClick={() => {
            const next = new URLSearchParams(window.location.search);
            next.delete('focusTask');
            const priorityPreset = key === 'high' || key === 'unreviewed';
            next.set('work', key === 'week' || priorityPreset ? 'all' : key);
            next.set('scope', key === 'week' ? 'week' : 'all');
            next.delete('from');
            next.delete('to');
            next.delete('mindFocus');
            // A preset is a fresh starting point; avoid hidden contradictory conditions.
            next.delete('taskStatus');
            next.delete('taskPriority');
            next.delete('taskTag');
            if (priorityPreset) {
              next.set('taskPriority', key);
              next.set('taskStatus', 'unfinished');
              next.set('taskSort', 'priority');
            }
            setParams(next, { replace: true });
          }}
          className={cn(
            'h-8 shrink-0 whitespace-nowrap rounded-md px-2.5 transition-colors',
            selected === key
              ? 'bg-[var(--selection)] font-medium text-[var(--accent-solid)]'
              : 'text-muted hover:bg-[var(--surface)] hover:text-foreground',
          )}
        >
          {label}
          {(key === 'high' || key === 'unreviewed') && <span className="ml-1 tabular-nums opacity-70">{counts[key]}</span>}
        </button>
      ))}
    </div>
  );
}

export function MoreTaskFilters() {
  const [params, setParams] = useSearchParams();
  const data = useNexusData();
  const filters = readTaskFilters(params);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 0 });
  const count =
    Number(filters.status !== 'all') + Number(filters.priority !== 'all') + Number(!!filters.tagId);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-control-layer]')) return;
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-control-layer]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        ref.current?.querySelector('button')?.focus();
      }
    };
    const resize = () => setOpen(false);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', resize);
    };
  }, [open]);
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(window.location.search);
    next.delete('focusTask');
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const statusLabels = {
    all: '全部状态',
    unfinished: '未完成',
    todo: '待办',
    doing: '进行中',
    done: '已完成',
  };
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label="更多任务筛选"
        aria-expanded={open}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition({
            left: Math.max(12, Math.min(rect.right - 240, window.innerWidth - 252)),
            top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 300)),
          });
          setOpen((value) => !value);
        }}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs',
          count
            ? 'bg-[var(--selection)] text-[var(--accent-solid)]'
            : 'text-muted hover:bg-[var(--surface)] hover:text-foreground',
        )}
      >
        <SlidersHorizontal size={13} />
        筛选{count > 0 && <span className="tabular-nums">{count}</span>}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="更多任务筛选"
          style={position}
          className="fixed z-40 max-h-[calc(100dvh-24px)] w-60 max-w-[calc(100vw-24px)] space-y-3 overflow-y-auto rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)] p-3 shadow-[0_12px_40px_rgb(0_0_0/0.12)]"
        >
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
            <span className="text-xs font-medium">筛选任务</span>
            <span className="text-[10px] text-muted">{count ? `${count} 个条件` : '全部任务'}</span>
          </div>
          <label className="block space-y-1.5 text-xs">
            <span className="text-muted">状态</span>
            <SelectField
              aria-label="筛选任务状态"
              className="w-full"
              value={filters.status}
              onValueChange={(value) => change('taskStatus', value)}
              options={TASK_STATUSES.map((value) => ({ value, label: statusLabels[value] }))}
            />
          </label>
          <label className="block space-y-1.5 text-xs">
            <span className="text-muted">优先级</span>
            <SelectField
              aria-label="筛选任务优先级"
              className="w-full"
              value={filters.priority}
              onValueChange={(value) => change('taskPriority', value)}
              options={TASK_PRIORITIES.map((value) => ({
                value,
                label:
                  value === 'all' ? '全部优先级' : value === 'high' ? '高优先级 · P0 / P1' : value === 'unreviewed' ? '待分级 · 默认 P3' : value,
                ...(/^P[0-3]$/.test(value) ? { color: `var(--${value.toLowerCase()})` } : {}),
              }))}
            />
          </label>
          <label className="block space-y-1.5 text-xs">
            <span className="text-muted">标签</span>
            <SelectField
              aria-label="筛选任务标签"
              className="w-full"
              value={filters.tagId ?? ''}
              onValueChange={(value) => change('taskTag', value)}
              options={[
                { value: '', label: '全部标签' },
                ...data.tags
                  .filter((tag) => !tag.deletedAt)
                  .map((tag) => ({ value: tag.id, label: tag.name, color: tag.color })),
                ...(filters.tagId &&
                !data.tags.some((tag) => tag.id === filters.tagId && !tag.deletedAt)
                  ? [{ value: filters.tagId, label: '已移除的标签' }]
                  : []),
              ]}
            />
          </label>
          {count > 0 && (
            <button
              type="button"
              className="text-xs text-muted hover:text-foreground"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete('focusTask');
                next.delete('taskStatus');
                next.delete('taskPriority');
                next.delete('taskTag');
                setParams(next, { replace: true });
              }}
            >
              清除额外条件
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function TaskSortControl() {
  const [params, setParams] = useSearchParams();
  return <SelectField
    aria-label="任务排序"
    value={readTaskSort(params)}
    className="h-8 w-28 shrink-0 text-[11px]"
    options={[{ value: 'manual', label: '手动顺序' }, { value: 'priority', label: '优先级排序', description: 'P0 → P3，已完成靠后，父级随最高优先级子任务排列' }]}
    onValueChange={value => {
      const next = new URLSearchParams(window.location.search);
      if (value === 'priority') next.set('taskSort', value); else next.delete('taskSort');
      setParams(next, { replace: true });
    }}
  />;
}
