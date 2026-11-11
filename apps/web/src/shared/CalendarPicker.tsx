import React, { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn, Popover, PopoverContent, PopoverTrigger } from '@nexus/ui';
import { addDays, dateFromDayKey, dayKeyOf, startOfWeek } from '@nexus/core';
import { useNexusData } from '@nexus/crdt';

const validDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(dateFromDayKey(value).getTime()) &&
  dayKeyOf(dateFromDayKey(value)) === value;

interface CalendarPickerProps {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  range?: { from: string; to: string };
}

/** A local-date calendar; no UTC parsing, so selecting a day does not shift with timezone or DST. */
export function CalendarPicker({ value, onChange, min, max, range }: CalendarPickerProps) {
  const { settings } = useNexusData();
  const initial = validDate(value) ? dateFromDayKey(value) : new Date();
  const [month, setMonth] = useState(() => new Date(initial.getFullYear(), initial.getMonth(), 1));
  const [focusDay, setFocusDay] = useState(() => dayKeyOf(initial));
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const keyboardFocus = useRef(false);
  const today = dayKeyOf(new Date());
  const first = startOfWeek(month, settings.weekStartsOn);
  const weekdays = Array.from(
    { length: 7 },
    (_, index) => ['日', '一', '二', '三', '四', '五', '六'][(settings.weekStartsOn + index) % 7],
  );
  const allowed = (day: string) => (!min || day >= min) && (!max || day <= max);
  useEffect(() => {
    if (keyboardFocus.current) {
      buttons.current.get(focusDay)?.focus();
      keyboardFocus.current = false;
    }
  }, [focusDay, month]);
  const navigate = (direction: number) => {
    const next = new Date(month.getFullYear(), month.getMonth() + direction, 1);
    setMonth(next);
    setFocusDay(min && dayKeyOf(next) < min ? min : dayKeyOf(next));
  };
  const lastOf = (offset: number) =>
    dayKeyOf(new Date(month.getFullYear(), month.getMonth() + offset + 1, 0));
  return (
    <div data-calendar-picker>
      <div className="mb-3 flex items-center justify-between">
        <span aria-live="polite" className="text-[13px] font-medium">
          {month.getFullYear()} 年 {month.getMonth() + 1} 月
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            aria-label="上个月"
            disabled={!!min && lastOf(-1) < min}
            onClick={() => navigate(-1)}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-[var(--surface)] hover:text-foreground disabled:opacity-30"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            aria-label="下个月"
            disabled={
              !!max && dayKeyOf(new Date(month.getFullYear(), month.getMonth() + 1, 1)) > max
            }
            onClick={() => navigate(1)}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-[var(--surface)] hover:text-foreground disabled:opacity-30"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
      <div role="grid" aria-label="日期月历" className="space-y-1">
        <div role="row" className="grid grid-cols-7">
          {weekdays.map((day) => (
            <span role="columnheader" key={day} className="py-1 text-center text-[11px] text-muted">
              {day}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, week) => (
          <div key={week} role="row" className="grid grid-cols-7">
            {Array.from({ length: 7 }, (_, index) => {
              const date = addDays(first, week * 7 + index),
                key = dayKeyOf(date);
              const selected = key === value,
                inRange = !!range?.from && key >= range.from && key <= range.to;
              return (
                <div
                  key={key}
                  role="gridcell"
                  aria-selected={selected}
                  className={cn(
                    'flex justify-center rounded-lg',
                    inRange && 'bg-[var(--selection)]',
                  )}
                >
                  <button
                    type="button"
                    data-calendar-day={key}
                    ref={(button) => {
                      if (button) buttons.current.set(key, button);
                      else buttons.current.delete(key);
                    }}
                    disabled={!allowed(key)}
                    tabIndex={key === focusDay ? 0 : -1}
                    aria-label={`${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`}
                    aria-pressed={selected}
                    aria-current={key === today ? 'date' : undefined}
                    onClick={() => onChange(key)}
                    onKeyDown={(event) => {
                      let next: Date | undefined;
                      if (event.key === 'ArrowLeft') next = addDays(date, -1);
                      if (event.key === 'ArrowRight') next = addDays(date, 1);
                      if (event.key === 'ArrowUp') next = addDays(date, -7);
                      if (event.key === 'ArrowDown') next = addDays(date, 7);
                      if (event.key === 'Home') next = startOfWeek(date, settings.weekStartsOn);
                      if (event.key === 'End')
                        next = addDays(startOfWeek(date, settings.weekStartsOn), 6);
                      if (event.key === 'PageUp' || event.key === 'PageDown') {
                        const direction = event.key === 'PageUp' ? -1 : 1;
                        next = new Date(
                          date.getFullYear(),
                          date.getMonth() + direction,
                          Math.min(
                            date.getDate(),
                            new Date(
                              date.getFullYear(),
                              date.getMonth() + direction + 1,
                              0,
                            ).getDate(),
                          ),
                        );
                      }
                      if (!next) return;
                      event.preventDefault();
                      event.stopPropagation();
                      const nextKey = dayKeyOf(next);
                      if (!allowed(nextKey)) return;
                      keyboardFocus.current = true;
                      setFocusDay(nextKey);
                      if (
                        next.getMonth() !== month.getMonth() ||
                        next.getFullYear() !== month.getFullYear()
                      )
                        setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
                    }}
                    className={cn(
                      'relative grid h-9 w-9 place-items-center rounded-lg text-xs tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-25',
                      selected
                        ? 'bg-[var(--accent-solid)] font-medium text-white'
                        : 'hover:bg-[var(--selection)] hover:text-[var(--accent-solid)]',
                      !selected && date.getMonth() !== month.getMonth() && 'text-muted/45',
                      !selected && key === today && 'font-semibold text-[var(--accent-solid)]',
                    )}
                  >
                    {date.getDate()}
                    {key === today && !selected && (
                      <span
                        aria-hidden="true"
                        className="absolute bottom-1 h-0.5 w-0.5 rounded-full bg-current"
                      />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

interface CalendarDateFieldProps {
  value: string;
  onChange: (value: string) => void;
  'aria-label': string;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

/** Keep direct date entry while providing the same calendar surface in every form. */
export function CalendarDateField({
  value,
  onChange,
  className,
  ...props
}: CalendarDateFieldProps) {
  const [open, setOpen] = useState(false);
  const select = (day: string) => {
    onChange(day);
    setOpen(false);
  };
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          'flex h-9 min-w-0 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 focus-within:border-[var(--accent-solid)]',
          className,
        )}
      >
        <input
          {...props}
          type="date"
          value={value}
          onChange={(event) => {
            const day = event.target.value;
            if (
              validDate(day) &&
              (!props.min || day >= props.min) &&
              (!props.max || day <= props.max)
            )
              onChange(day);
          }}
          className="calendar-date-input min-w-0 flex-1 bg-transparent text-xs tabular-nums text-foreground outline-none disabled:opacity-50"
        />
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`选择${props['aria-label']}`}
            disabled={props.disabled}
            className="grid h-7 w-6 shrink-0 place-items-center rounded-md text-muted hover:text-[var(--accent-solid)] disabled:opacity-40"
          >
            <CalendarDays size={14} />
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent aria-label={`选择${props['aria-label']}`} className="w-[300px]">
        <CalendarPicker
          key={open ? value : 'closed'}
          value={value}
          onChange={select}
          min={props.min}
          max={props.max}
        />
        <button
          type="button"
          disabled={
            (!!props.min && dayKeyOf(new Date()) < props.min) ||
            (!!props.max && dayKeyOf(new Date()) > props.max)
          }
          className="mt-3 min-h-8 w-full rounded-lg border border-[var(--border)] text-xs text-muted hover:bg-[var(--surface)] disabled:opacity-40"
          onClick={() => select(dayKeyOf(new Date()))}
        >
          回到今天
        </button>
      </PopoverContent>
    </Popover>
  );
}
