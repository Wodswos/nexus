import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, Dialog, DialogContent, SelectField } from '@nexus/ui';
import { useNexusData } from '@nexus/crdt';
import { addDays, calendarDaysBetween, dayKeyOf } from '@nexus/core';
import {
  isCalendarMonth,
  isDatedWindow,
  isScheduledOnlyWorkspace,
  MAX_WINDOW_DAYS,
  readTaskWindow,
  type WindowScope,
} from './taskWindow';
import { workspaceCanvasWindow } from './taskFilters';
import { CalendarDateField, CalendarPicker } from '@/shared/CalendarPicker';

export function useTaskWindow(temporal = false) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const data = useNexusData();
  const { settings } = data;
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const refresh = () => setClock((value) => value + 1);
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  const now = useMemo(() => new Date(), [clock, location.key]);
  const range = useMemo(() => {
    const scheduledOnly = isScheduledOnlyWorkspace(params, settings);
    const initial = readTaskWindow(params, now, settings.weekStartsOn, temporal, !scheduledOnly);
    const canvas = temporal ? workspaceCanvasWindow(data, params, now, initial) : initial;
    return { ...canvas, scheduledOnly };
  }, [params, data, settings, temporal, now]);
  const setRange = useCallback(
    (start: number, days: number) => {
      if (window.location.pathname !== '/tasks') return;
      // Suspense can retain the previous view while the next one loads. Its render-time
      // search params are stale; amend the actual BrowserRouter URL without reverting the view.
      const next = new URLSearchParams(window.location.search);
      next.delete('focusTask');
      next.set('scope', 'custom');
      next.set('from', dayKeyOf(start));
      next.set('to', dayKeyOf(addDays(start, Math.max(1, Math.min(MAX_WINDOW_DAYS, days)) - 1)));
      setParams(next, { replace: true });
    },
    [setParams],
  );
  const setScope = (scope: WindowScope) => {
    if (scope === 'custom') {
      setRange(range.start, range.days);
      return;
    }
    if (window.location.pathname !== '/tasks') return;
    const next = new URLSearchParams(window.location.search);
    next.delete('focusTask');
    next.set('scope', scope);
    next.delete('from');
    next.delete('to');
    setParams(next, { replace: true });
  };
  return { range, setRange, setScope, now };
}

export function TaskWindowControls({ temporal = false }: { temporal?: boolean }) {
  const [params] = useSearchParams();
  const { range, setRange, setScope } = useTaskWindow(temporal);
  const scope = params.get('scope');
  const selectedScope =
    scope === 'all' || (scope === 'undated' && !range.scheduledOnly) ? scope : range.scope;
  const dated = isDatedWindow(range);
  const [mobile, setMobile] = useState(() => window.matchMedia('(width < 48rem)').matches);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ from: '', to: '' });
  const scopeRef = useRef<HTMLButtonElement>(null);
  const [rangePart, setRangePart] = useState<'from' | 'to'>('from');
  const rangeFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const query = window.matchMedia('(width < 48rem)');
    const change = () => {
      setMobile(query.matches);
      if (!query.matches) setEditing(false);
    };
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  const editRange = (trigger: HTMLElement) => {
    rangeFocus.current = trigger;
    setDraft({ from: dayKeyOf(range.start), to: dayKeyOf(addDays(range.start, range.days - 1)) });
    setRangePart('from');
    setEditing(true);
  };
  const end = addDays(range.start, range.days - 1);
  const startYear = new Date(range.start).getFullYear();
  const endYear = end.getFullYear();
  const crossYear = startYear !== endYear;
  const shortDate = (value: number | Date, year: boolean) =>
    dayKeyOf(value)
      .slice(year ? 2 : 5)
      .replaceAll('-', '/');
  const startLabel = shortDate(range.start, crossYear || startYear !== new Date().getFullYear());
  const endLabel = shortDate(end, crossYear);
  const shift = (direction: number) => {
    if (['timeline', 'calendar'].includes(params.get('view') ?? '') && isCalendarMonth(range)) {
      const current = new Date(range.start);
      const next = new Date(current.getFullYear(), current.getMonth() + direction, 1);
      setRange(next.getTime(), new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate());
    } else setRange(addDays(range.start, direction * range.days).getTime(), range.days);
  };
  return (
    <div
      aria-label="任务时间区间"
      data-task-period
      className="flex min-w-0 items-center gap-1.5 md:flex-wrap md:gap-2"
    >
      <SelectField
        ref={scopeRef}
        aria-label="任务时间范围"
        value={selectedScope}
        onValueChange={(value) => {
          const scope = value as WindowScope;
          if (mobile && scope === 'custom' && scopeRef.current) editRange(scopeRef.current);
          else setScope(scope);
        }}
        onCloseAutoFocus={(event) => {
          if (editing) event.preventDefault();
        }}
        className="h-8 w-24 shrink-0 md:w-auto"
        options={[
          { value: 'today', label: '今天', description: '当天的任务与安排' },
          { value: 'week', label: '本周', description: '跟随每周自动更新' },
          { value: 'month', label: '本月', description: '跟随每月自动更新' },
          {
            value: 'custom',
            label: mobile ? '自选' : '自定义区间',
            description: '选择固定的开始和结束日期',
          },
          { value: 'all', label: mobile ? '全部' : '全部时间', description: '不限制任务日期' },
          ...(!range.scheduledOnly
            ? [{ value: 'undated', label: '未排期', description: '查看尚未安排日期的任务' }]
            : []),
        ]}
      />
      {dated && (
        <>
          {temporal && (selectedScope === 'all' || selectedScope === 'undated') && (
            <span className="hidden text-[11px] text-muted md:inline">画布</span>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-0.5 md:w-[330px] md:max-w-full md:flex-none md:gap-1">
            <button
              aria-label="上一个时间段"
              title={`向前 ${range.days} 天`}
              onClick={() => shift(-1)}
              className="grid h-8 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-[var(--surface)] hover:text-foreground"
            >
              <ChevronLeft size={15} />
            </button>
            {mobile ? (
              <button
                aria-label={`编辑日期区间：${dayKeyOf(range.start)} 至 ${dayKeyOf(end)}`}
                title={`${dayKeyOf(range.start)} 至 ${dayKeyOf(end)}`}
                onClick={(event) => editRange(event.currentTarget)}
                className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1 text-[11px] tabular-nums text-foreground hover:bg-[var(--surface)]"
              >
                {!crossYear && <CalendarDays className="h-3 w-3 shrink-0" />}
                <span className="truncate">
                  {startLabel}
                  {range.days > 1 && <>–{endLabel}</>}
                </span>
              </button>
            ) : (
              <>
                <CalendarDateField
                  aria-label="区间开始日期"
                  value={dayKeyOf(range.start)}
                  onChange={(value) =>
                    setRange(new Date(`${value}T00:00:00`).getTime(), range.days)
                  }
                  className="h-8 flex-1 px-2"
                />
                <span className="shrink-0 text-xs text-muted">—</span>
                <CalendarDateField
                  aria-label="区间结束日期"
                  value={dayKeyOf(addDays(range.start, range.days - 1))}
                  min={dayKeyOf(range.start)}
                  max={dayKeyOf(addDays(range.start, MAX_WINDOW_DAYS - 1))}
                  onChange={(value) =>
                    setRange(
                      range.start,
                      calendarDaysBetween(range.start, new Date(`${value}T00:00:00`)) + 1,
                    )
                  }
                  className="h-8 flex-1 px-2"
                />
              </>
            )}
            <button
              aria-label="下一个时间段"
              title={`向后 ${range.days} 天`}
              onClick={() => shift(1)}
              className="grid h-8 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-[var(--surface)] hover:text-foreground"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </>
      )}
      {mobile && editing && (
        <Dialog open onOpenChange={setEditing}>
          <DialogContent
            title="选择日期区间"
            className="top-[max(24px,env(safe-area-inset-top))] max-h-[calc(100dvh-48px)] w-[min(92vw,360px)] overflow-y-auto"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const trigger = rangeFocus.current;
              (trigger?.isConnected ? trigger : scopeRef.current)?.focus();
              rangeFocus.current = null;
            }}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!draft.from || !draft.to || draft.to < draft.from) return;
                const start = new Date(`${draft.from}T00:00:00`).getTime();
                setRange(start, calendarDaysBetween(start, new Date(`${draft.to}T00:00:00`)) + 1);
                setEditing(false);
              }}
              className="space-y-4"
            >
              <div className="grid grid-cols-2 gap-2">
                <label
                  className={`block min-w-0 space-y-1 rounded-xl border p-2.5 text-xs ${rangePart === 'from' ? 'border-[var(--accent-solid)] bg-[var(--selection)]' : 'border-[var(--border)]'}`}
                >
                  <span className="text-muted">开始日期</span>
                  <input
                    aria-label="区间开始日期"
                    required
                    type="date"
                    value={draft.from}
                    onFocus={() => setRangePart('from')}
                    onChange={(event) =>
                      setDraft((current) => ({
                        from: event.target.value,
                        to: current.to < event.target.value ? event.target.value : current.to,
                      }))
                    }
                    className="calendar-date-input h-8 w-full min-w-0 bg-transparent text-sm text-foreground outline-none"
                  />
                </label>
                <label
                  className={`block min-w-0 space-y-1 rounded-xl border p-2.5 text-xs ${rangePart === 'to' ? 'border-[var(--accent-solid)] bg-[var(--selection)]' : 'border-[var(--border)]'}`}
                >
                  <span className="text-muted">结束日期</span>
                  <input
                    aria-label="区间结束日期"
                    required
                    type="date"
                    value={draft.to}
                    min={draft.from}
                    max={
                      draft.from
                        ? dayKeyOf(addDays(new Date(`${draft.from}T00:00:00`), MAX_WINDOW_DAYS - 1))
                        : undefined
                    }
                    onFocus={() => setRangePart('to')}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, to: event.target.value }))
                    }
                    className="calendar-date-input h-8 w-full min-w-0 bg-transparent text-sm text-foreground outline-none"
                  />
                </label>
              </div>
              <CalendarPicker
                key={rangePart}
                value={rangePart === 'from' ? draft.from : draft.to}
                range={draft}
                min={rangePart === 'to' ? draft.from : undefined}
                max={
                  rangePart === 'to' && draft.from
                    ? dayKeyOf(addDays(new Date(`${draft.from}T00:00:00`), MAX_WINDOW_DAYS - 1))
                    : undefined
                }
                onChange={(day) => {
                  if (rangePart === 'from') {
                    setDraft({ from: day, to: day });
                    setRangePart('to');
                  } else setDraft((current) => ({ ...current, to: day }));
                }}
              />
              <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
                <span className="text-[11px] text-muted">
                  {draft.from && draft.to && draft.to >= draft.from
                    ? `共 ${calendarDaysBetween(new Date(`${draft.from}T00:00:00`), new Date(`${draft.to}T00:00:00`)) + 1} 天`
                    : '选择起止日期'}
                </span>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                    取消
                  </Button>
                  <Button type="submit">应用日期</Button>
                </div>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
