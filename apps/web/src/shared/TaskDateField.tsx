import React, { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronDown, Clock3, X } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from '@nexus/ui';
import { addDays, dateFromDayKey, dayKeyOf } from '@nexus/core';
import { CalendarPicker } from './CalendarPicker';

const timeOf = (value: number) => {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

export function DateTimeField({
  value,
  onChange,
  className,
  title = '时间',
  autoOpenKey,
}: {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  className?: string;
  title?: string;
  autoOpenKey?: number;
}) {
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const change = () => setMobile(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  const [date, setDate] = useState(() => dayKeyOf(value ?? Date.now()));
  const [time, setTime] = useState(() => (value == null ? '00:00' : timeOf(value)));
  const seenAutoOpen = useRef(false);
  const show = (next: boolean) => {
    if (next) {
      setDate(dayKeyOf(value ?? Date.now()));
      setTime(value == null ? '00:00' : timeOf(value));
    }
    setOpen(next);
  };
  useEffect(() => {
    if (!seenAutoOpen.current) {
      seenAutoOpen.current = true;
      return;
    }
    if (autoOpenKey) show(true);
  }, [autoOpenKey]);
  const stamp = new Date(`${date}T${time || '00:00'}`).getTime();
  const label =
    value == null
      ? '设置日期'
      : `${new Date(value).getMonth() + 1}/${new Date(value).getDate()}${timeOf(value) === '00:00' ? '' : ` · ${timeOf(value)}`}`;
  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={mobile ? () => show(true) : undefined}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex min-h-8 min-w-[112px] items-center justify-between gap-2 rounded-lg border px-2.5 py-1 text-xs outline-none transition-colors hover:border-[var(--border-strong)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
        value == null
          ? 'border-dashed border-[var(--border-strong)] text-muted'
          : 'border-[var(--border)] bg-[var(--surface)]',
      )}
    >
      <span className="truncate tabular-nums">{label}</span>
      <ChevronDown size={12} className="shrink-0 text-muted" />
    </button>
  );
  const editor = (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!Number.isFinite(stamp) || dayKeyOf(dateFromDayKey(date)) !== date) return;
        setOpen(false);
        onChange(stamp);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <div className="min-h-0 overflow-y-auto">
        {!mobile && (
          <div className="mb-3 flex items-center gap-2 text-[13px] font-medium">
            <CalendarDays size={15} className="text-muted" />
            {title}
          </div>
        )}
        <div className="mb-3 grid grid-cols-3 gap-1.5">
          {[
            ['今天', 0],
            ['明天', 1],
            ['下周', 7],
          ].map(([text, offset]) => {
            const day = dayKeyOf(addDays(new Date(), Number(offset)));
            return (
              <button
                key={text}
                type="button"
                aria-pressed={date === day}
                onClick={() => setDate(day)}
                className={cn(
                  'min-h-8 rounded-lg border text-xs',
                  date === day
                    ? 'border-transparent bg-[var(--selection)] text-[var(--accent-solid)]'
                    : 'border-[var(--border)] text-muted hover:bg-[var(--surface)]',
                )}
              >
                {text}
              </button>
            );
          })}
        </div>
        <CalendarPicker key={date.slice(0, 7)} value={date} onChange={setDate} />
        <div className="mt-3 grid grid-cols-[1.3fr_1fr] gap-2 border-t border-[var(--border)] pt-3">
          <label className="block min-w-0 space-y-1.5 text-[11px] text-muted">
            <span>日期</span>
            <input
              aria-label={`${title}日期`}
              type="date"
              required
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="calendar-date-input h-9 w-full min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-foreground outline-none focus:border-[var(--accent-solid)]"
            />
          </label>
          <label className="block min-w-0 space-y-1.5 text-[11px] text-muted">
            <span className="flex items-center gap-1">
              <Clock3 size={11} />
              时间
            </span>
            <input
              aria-label={`${title}时刻`}
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className="h-9 w-full min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-foreground outline-none focus:border-[var(--accent-solid)]"
            />
          </label>
        </div>
      </div>
      <div className="mt-4 flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
        <button
          type="button"
          disabled={value == null}
          onClick={() => {
            setOpen(false);
            onChange(null);
          }}
          className="min-h-8 rounded-md px-1 text-xs text-muted hover:text-[var(--danger)] disabled:opacity-35"
        >
          清除日期
        </button>
        <div className="flex gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={!date || !Number.isFinite(stamp)}>
            应用时间
          </Button>
        </div>
      </div>
    </form>
  );
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <Popover modal open={open && !mobile} onOpenChange={show}>
        {mobile ? trigger : <PopoverTrigger asChild>{trigger}</PopoverTrigger>}
        {!mobile && (
          <PopoverContent
            aria-label={`设置${title}`}
            data-date-editor
            className="flex flex-col overflow-hidden"
            onCloseAutoFocus={(event) => {
              if (document.querySelector('[data-date-editor][data-state="open"]'))
                event.preventDefault();
            }}
          >
            {editor}
          </PopoverContent>
        )}
      </Popover>
      {mobile && (
        <Dialog open={open} onOpenChange={show}>
          <DialogContent
            title={`设置${title}`}
            overlayClassName="z-[60]"
            aria-describedby={undefined}
            data-date-editor
            data-task-detail-portal
            data-control-layer
            className="top-4 z-[70] flex max-h-[calc(var(--app-height,100dvh)-32px)] w-[min(92vw,360px)] flex-col overflow-hidden p-4"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!document.querySelector('[data-date-editor][data-state="open"]'))
                triggerRef.current?.focus({ preventScroll: true });
            }}
          >
            {editor}
          </DialogContent>
        </Dialog>
      )}
      {value != null && (
        <button
          type="button"
          aria-label={`清除${title}`}
          title="清除时间"
          onClick={() => onChange(null)}
          className="grid h-8 w-6 shrink-0 place-items-center rounded-md text-muted/60 hover:bg-[var(--surface)] hover:text-[var(--danger)]"
        >
          <X size={12} />
        </button>
      )}
    </span>
  );
}
