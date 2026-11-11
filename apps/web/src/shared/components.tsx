import React from 'react';
import { Check, Folder, X } from 'lucide-react';
import { cn, Badge } from '@nexus/ui';
import {
  EventKind,
  Task,
  Tag,
  dayKeyOf,
  addDays,
  fmtDuration,
  Priority,
  PRIORITY_META,
  PRIORITY_ORDER,
  priorityOf,
  taskViewStatus,
} from '@nexus/core';

/** A quiet visual mark with a larger independent pointer target. */
export function TaskCheckbox({
  done,
  onChange,
  className,
}: {
  done: boolean;
  onChange: () => void;
  className?: string;
}) {
  return (
    <button
      role="checkbox"
      aria-checked={done}
      aria-label={done ? '标记未完成' : '完成'}
      onClick={(event) => {
        event.stopPropagation();
        onChange();
      }}
      className={cn('task-check', className)}
    >
      <span className="task-check-mark">{done && <Check size={11} strokeWidth={1.8} />}</span>
    </button>
  );
}

export function DueBadge({ task, now = new Date() }: { task: Task; now?: Date }) {
  if (task.dueAt == null) return null;
  const d = new Date(task.dueAt);
  const todayKey = dayKeyOf(now);
  const key = dayKeyOf(d);
  const overdue = task.status !== 'done' && task.dueAt < new Date(now).setHours(0, 0, 0, 0);
  const label =
    key === todayKey
      ? '今天'
      : key === dayKeyOf(addDays(now, 1))
        ? '明天'
        : `${d.getMonth() + 1}/${d.getDate()}`;
  const time =
    d.getHours() !== 0 || d.getMinutes() !== 0
      ? ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : '';
  return (
    <span
      className={cn(
        'shrink-0 text-[11px]',
        overdue ? 'text-[var(--danger)]' : key === todayKey ? 'text-[var(--accent-solid)]' : 'text-muted',
      )}
    >
      {label}
      {time}
      {overdue && ' · 逾期'}
    </span>
  );
}

export function TagChip({ tag, onClick }: { tag: Tag; onClick?: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-[var(--border-strong)]"
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: tag.color ?? 'var(--accent-from)' }} />
      <span className="ml-1">{tag.name}</span>
    </button>
  );
}

export function EstimateBadge({ min }: { min: number }) {
  return <Badge>⏱ {fmtDuration(min)}</Badge>;
}

export function SubtreeProgress({ done, total }: { done: number; total: number }) {
  if (total === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted">
      <span className="relative h-1 w-8 overflow-hidden rounded-full bg-[var(--border)]">
        <span
          className="absolute inset-y-0 left-0 gradient-bg"
          style={{ width: `${(done / total) * 100}%` }}
        />
      </span>
      {done}/{total}
    </span>
  );
}

export const EVENT_KIND_STYLE: Record<EventKind, { label: string; color: string; dim: string }> = {
  focus: { label: '专注', color: '#5375b4', dim: 'rgba(83,117,180,0.10)' },
  meeting: { label: '会议', color: '#8b76ab', dim: 'rgba(139,118,171,0.10)' },
  personal: { label: '个人', color: '#618576', dim: 'rgba(97,133,118,0.10)' },
  routine: { label: '例行', color: '#9f845c', dim: 'rgba(159,132,92,0.10)' },
};

/** 优先级固定色(滴答清单惯例:红 P0 / 橙 P1 / 蓝 P2 / 灰 P3),不随 accent 主题变 */
export const PRIORITY_VAR: Record<Priority, string> = {
  P0: 'var(--p0)',
  P1: 'var(--p1)',
  P2: 'var(--p2)',
  P3: 'var(--p3)',
};

export function PriorityDot({ task }: { task: Task }) {
  const p = priorityOf(task);
  if (p === 'P3') return null;
  return (
    <span
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: PRIORITY_VAR[p] }}
      title={PRIORITY_META[p].label}
    />
  );
}

/** 优先级选择器:P0~P3 一段式,与四象限(重要×紧急)联动。
 *  选中项整块填充该优先级自己的颜色(而不是只描一圈边)。 */
export function PriorityPicker({
  value: priority,
  onChange,
}: {
  value: Priority;
  onChange: (p: Priority) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {PRIORITY_ORDER.map((p) => {
        const active = p === priority;
        const color = PRIORITY_VAR[p];
        return (
          <button
            key={p}
            type="button"
            title={PRIORITY_META[p].label}
            onClick={() => onChange(p)}
            className={cn(
              'flex flex-col items-center gap-1 rounded-lg border py-1.5 transition-all',
              active ? 'border-transparent text-white shadow-sm' : 'text-muted hover:text-foreground',
            )}
            style={active ? { background: color, borderColor: color } : { borderColor: 'var(--border)' }}
          >
            <span
              className="h-1.5 w-6 rounded-full"
              style={{ background: active ? 'rgba(255,255,255,0.85)' : color }}
            />
            <span className="text-[10px] font-medium leading-none">{p}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 节点类型切换:TODO 任务(可完成) ↔ 结构节点(分组/主题,无完成态)。
 *  右击菜单和详情面板共用;转换后各视图渲染随之不同(列表/甘特无勾选框等)。 */
export function KindToggle({
  value,
  onChange,
}: {
  value: 'todo' | 'node';
  onChange: (k: 'todo' | 'node') => void;
}) {
  const opts: { k: 'todo' | 'node'; label: string; icon: React.ReactNode; hint: string }[] = [
    {
      k: 'todo',
      label: 'TODO 任务',
      icon: <Check className="h-3.5 w-3.5" />,
      hint: '可勾选完成、有状态/优先级/时间',
    },
    {
      k: 'node',
      label: '结构节点',
      icon: <Folder className="h-3.5 w-3.5" />,
      hint: '分组/主题容器,无完成态与排期',
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {opts.map(({ k, label, icon, hint }) => {
        const active = value === k;
        return (
          <button
            key={k}
            type="button"
            title={hint}
            onClick={() => onChange(k)}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-lg border py-1.5 text-[11px] transition-all',
              active
                ? 'gradient-bg border-transparent text-white shadow-sm'
                : 'text-muted hover:text-foreground',
            )}
            style={active ? undefined : { borderColor: 'var(--border)' }}
          >
            {icon}
            <span className="font-medium leading-none">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

export { DateTimeField } from './TaskDateField';

/** 自动状态徽标:完成 + 开始/截止时间窗推导(taskViewStatus),零操作 */
export function StatusBadge({ task }: { task: Task }) {
  const s = taskViewStatus(task);
  const dot: Record<typeof s.tone, string> = {
    success: 'bg-[var(--success)]',
    danger: 'bg-[var(--danger)]',
    warning: 'bg-[var(--warning)]',
    accent: 'bg-[var(--accent-from)]',
    muted: 'bg-[var(--muted-foreground)]',
    default: 'bg-[var(--muted-foreground)]',
  };
  const text: Record<typeof s.tone, string> = {
    success: 'text-[var(--success)]',
    danger: 'text-[var(--danger)]',
    warning: 'text-[var(--warning)]',
    accent: 'text-[var(--accent-from)]',
    muted: 'text-muted',
    default: 'text-muted',
  };
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 text-[10px]', text[s.tone])}
      title={`状态:${s.label}(按完成/开始/截止自动判断)`}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot[s.tone])} />
      {s.label}
    </span>
  );
}

/** 统计小方块 */
export function StatTile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="glass rounded-xl px-3.5 py-3">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular">{value}</div>
      {sub && <div className="text-[10px] text-muted/70">{sub}</div>}
    </div>
  );
}
