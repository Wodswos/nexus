import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { CalendarDays, Flag } from 'lucide-react';
import { Button, Dialog, DialogContent, SelectField, cn } from '@nexus/ui';
import { dayKeyOf, isStructural, planTaskBatch, priorityOf, PRIORITY_META, PRIORITY_ORDER, type BatchDateEdit, type Priority, type Task, type TaskBatchChange } from '@nexus/core';
import { useNexus } from '@nexus/crdt';
import { useUI } from '@/state/ui';

export function TaskBatchActions({ ids, onOpen }: { ids: string[]; onOpen?: () => void }) {
  const store = useNexus();
  const selected = new Set(ids);
  const disabled = !store.getData().tasks.some(task => selected.has(task.id) && !isStructural(task) && task.deletedAt == null && task.status !== 'archived');
  const open = (section: 'time' | 'priority') => {
    onOpen?.();
    useUI.getState().openTaskBatch(store.userId, ids, section);
  };
  return <>
    <button type="button" aria-label="批量设置时间" disabled={disabled} title={disabled ? '项目和分组不设置任务时间' : undefined} onClick={() => open('time')} className="flex min-h-8 items-center gap-1 rounded-lg px-2 text-muted hover:bg-[var(--surface)] hover:text-foreground disabled:opacity-40"><CalendarDays size={14} />时间</button>
    <button type="button" aria-label="批量设置优先级" disabled={disabled} title={disabled ? '项目和分组不设置任务优先级' : undefined} onClick={() => open('priority')} className="flex min-h-8 items-center gap-1 rounded-lg px-2 text-muted hover:bg-[var(--surface)] hover:text-foreground disabled:opacity-40"><Flag size={14} />优先级</button>
  </>;
}

type Request = NonNullable<ReturnType<typeof useUI.getState>['taskBatch']>;
type DateDraft = { action: 'keep' | 'set' | 'clear'; date: string; time: string };
const initialDate = (): DateDraft => ({ action: 'keep', date: dayKeyOf(Date.now()), time: '' });
const inputClass = 'h-9 min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-xs outline-none focus:border-[var(--accent-solid)]';
const dateEdit = (draft: DateDraft): BatchDateEdit | undefined => draft.action === 'keep' ? undefined : draft.action === 'clear' ? { action: 'clear' } : { action: 'set', date: draft.date, ...(draft.time ? { time: draft.time } : {}) };

function summary(tasks: Task[], field: 'startAt' | 'dueAt' | 'priority') {
  const values = [...new Set(tasks.map(task => field === 'priority' ? priorityOf(task) : task[field] ?? null))];
  if (values.length > 1) return '多个值';
  if (values[0] == null) return '未设置';
  return field === 'priority' ? PRIORITY_META[values[0] as Priority].label : new Date(Number(values[0])).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function DateRow({ title, current, value, onChange }: { title: string; current: string; value: DateDraft; onChange: (value: DateDraft) => void }) {
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2 text-xs"><span>{title}</span><span className="text-muted">当前：{current}</span></div>
    <div className="flex flex-wrap items-center gap-2">
      <SelectField aria-label={`${title}操作`} value={value.action} onValueChange={action => onChange({ ...value, action: action as DateDraft['action'] })} options={[{ value: 'keep', label: '不修改' }, { value: 'set', label: '设置日期' }, { value: 'clear', label: '清除' }]} className="w-28 shrink-0" />
      {value.action === 'set' && <>
        <input aria-label={`${title}日期`} type="date" required value={value.date} onChange={e => onChange({ ...value, date: e.target.value })} className={cn(inputClass, 'w-36 flex-1')} />
        <input aria-label={`${title}时刻（留空保留原时刻）`} title="留空保留各任务原时刻" type="time" value={value.time} onChange={e => onChange({ ...value, time: e.target.value })} className={cn(inputClass, 'w-28')} />
      </>}
    </div>
  </div>;
}

function Editor({ request }: { request: Request }) {
  const store = useNexus();
  const [baseline] = useState(() => store.getData().tasks.filter(task => request.ids.includes(task.id)));
  const eligible = baseline.filter(task => !isStructural(task) && task.deletedAt == null && task.status !== 'archived');
  const [section, setSection] = useState(request.section);
  const [start, setStart] = useState(initialDate);
  const [due, setDue] = useState(initialDate);
  const [mode, setMode] = useState<'fields' | 'shift'>('fields');
  const [days, setDays] = useState('1');
  const [priority, setPriority] = useState<Priority>();
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const change: TaskBatchChange = section === 'priority' ? { priority } : mode === 'shift' ? { shiftDays: Number(days) } : { startAt: dateEdit(start), dueAt: dateEdit(due) };
  const hasChange = section === 'priority' ? !!priority : mode === 'shift' ? days.trim() !== '' && Number(days) !== 0 : start.action !== 'keep' || due.action !== 'keep';
  let validation = '', count = 0, skipped = request.ids.length - eligible.length;
  try {
    const plan = planTaskBatch(baseline, request.ids, change);
    count = plan.writes.length; skipped = plan.skipped;
  } catch (reason) { validation = reason instanceof Error ? reason.message : '日期无效'; }
  const close = () => { if (!busy) useUI.getState().closeTaskBatch(); };
  const apply = async () => {
    if (busy || applied) return;
    setBusy(true); setError('');
    let changed = false;
    try {
      const plan = store.setTaskBatch(request.ids, change, baseline);
      changed = plan.writes.length > 0;
      setApplied(true);
      setMessage(`已更新 ${plan.writes.length} 项${plan.skipped ? `，${plan.skipped} 项不适用` : ''}。可用顶部撤销或 ⌘ / Ctrl + Z 撤销整批操作。`);
      await store.flushPersistence();
    } catch (reason) {
      setError(changed ? '更改已应用，本地保存失败。请保持页面打开并导出备份，不要重复应用。' : reason instanceof Error ? reason.message : '尚未修改，请重试。');
    } finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent title={applied ? '批量设置完成' : '批量设置任务'} aria-describedby="task-batch-scope" data-task-batch-editor className="top-[max(16px,10%)] max-h-[calc(100dvh-32px)] overflow-y-auto" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}>
      <p id="task-batch-scope" className="mb-4 text-xs leading-5 text-muted">已选 {request.ids.length} 项；{eligible.length} 项任务可设置。{skipped > 0 && `${skipped} 项分组、项目、归档或无排期项不适用。`}仅修改选中任务，不包含未选中的子任务。</p>
      {applied ? <p role="status" className="py-4 text-sm">{message}</p> : <>
        <div role="tablist" aria-label="批量设置属性" className="mb-5 flex gap-1 border-b border-[var(--border)] pb-2">
          {(['time', 'priority'] as const).map(key => <button key={key} role="tab" aria-selected={section === key} onClick={() => { setSection(key); setError(''); }} className={cn('rounded-lg px-3 py-1.5 text-xs', section === key ? 'bg-[var(--selection)] text-foreground' : 'text-muted hover:bg-[var(--surface)]')}>{key === 'time' ? '时间' : '优先级'}</button>)}
        </div>
        {section === 'time' ? <div className="space-y-4">
          <SelectField aria-label="批量时间方式" value={mode} onValueChange={value => setMode(value as typeof mode)} options={[{ value: 'fields', label: '设置或清除日期' }, { value: 'shift', label: '整体提前 / 顺延' }]} className="w-full" />
          {mode === 'fields' ? <>
            <DateRow title="开始" current={summary(eligible, 'startAt')} value={start} onChange={setStart} />
            <DateRow title="截止" current={summary(eligible, 'dueAt')} value={due} onChange={setDue} />
            <button type="button" onClick={() => { setStart({ ...start, action: 'clear' }); setDue({ ...due, action: 'clear' }); }} className="text-xs text-muted underline underline-offset-4 hover:text-foreground">清除全部排期</button>
            <p className="text-xs leading-5 text-muted">时刻留空时保留各任务原时刻；原来没有日期时，开始为 00:00，截止为 23:59。开始和截止都设为「设置日期」可统一排期。</p>
          </> : <label className="block space-y-2 text-xs"><span>移动天数（正数顺延，负数提前）</span><input aria-label="移动天数" type="number" min={-3660} max={3660} step={1} value={days} onChange={e => setDays(e.target.value)} className={cn(inputClass, 'w-full')} /><span className="block leading-5 text-muted">保留每项原时刻和起止间隔，未排期任务不修改。</span></label>}
        </div> : <div className="space-y-3">
          <p className="text-xs text-muted">当前：{summary(eligible, 'priority')}</p>
          <div className="grid grid-cols-2 gap-2">{PRIORITY_ORDER.map(value => <button key={value} type="button" aria-pressed={priority === value} onClick={() => setPriority(value)} className={cn('min-h-11 rounded-lg border px-3 py-2 text-left text-xs', priority === value ? 'border-[var(--accent-solid)] bg-[var(--selection)]' : 'border-[var(--border)] hover:bg-[var(--surface)]')}>{PRIORITY_META[value].label}</button>)}</div>
        </div>}
        {hasChange && <p role={validation ? 'alert' : 'status'} className={cn('mt-4 text-xs leading-5', validation ? 'text-[var(--danger)]' : 'text-muted')}>{validation || `将更新 ${count} 项${skipped ? `，${skipped} 项不适用` : ''}。`}</p>}
      </>}
      {error && <p role="alert" className="mt-3 text-xs text-[var(--danger)]">{error}</p>}
      <div className="mt-5 flex justify-end gap-2 border-t border-[var(--border)] pt-3">
        <Button size="sm" variant="ghost" disabled={busy} onClick={close}>{applied ? '关闭' : '取消'}</Button>
        {!applied && <Button size="sm" disabled={busy || !hasChange || !!validation || count === 0} onClick={() => void apply()}>{busy ? '正在保存…' : `应用到 ${count} 项`}</Button>}
      </div>
    </DialogContent>
  </Dialog>;
}

export function TaskBatchEditor() {
  const request = useUI(state => state.taskBatch);
  const store = useNexus();
  const location = useLocation();
  useEffect(() => () => useUI.getState().closeTaskBatch(), [location.key, store.userId]);
  if (!request || request.userId !== store.userId) return null;
  return <Editor key={`${request.userId}:${request.ids.join(',')}:${request.section}`} request={request} />;
}
