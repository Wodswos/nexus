import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { diffLines } from 'diff';
import { BookOpen, Code, History, Maximize2, RotateCcw, Search } from 'lucide-react';
import { Button, Dialog, DialogContent, SelectField } from '@nexus/ui';
import { apiRequest, currentStore, useNexus } from '@nexus/crdt';
import type { Task } from '@nexus/core';
import type { useTaskTextDraft } from './useTaskTextDraft';
import { MarkdownDocument } from './MarkdownDocument';
export { MarkdownDocument } from './MarkdownDocument';

type Revision = { id: string; taskId: string; title: string; notes: string; source: string; author: string; createdAt: number; agentId?: string; roundId?: string; restoredFrom?: string };
type RevisionRow = Omit<Revision, 'notes'> & { length: number };
const origins: Record<string, string> = { initial: '初始记录', user: '人工编辑', api: 'REST API', agent: 'Agent 回写', restore: '恢复版本' };
const get = async <T,>(path: string, method = 'GET', data?: unknown): Promise<T> => (await apiRequest<{ data: T }>(path, { method, ...(data ? { body: JSON.stringify(data) } : {}) })).data;

/** Freeform text stays editable; reading and immutable history are separate views. */
export function TaskDescription({ task, draft, textNode }: { task: Task; draft: ReturnType<typeof useTaskTextDraft>; textNode: boolean }) {
  const store = useNexus(), active = useRef(true);
  const [reading, setReading] = useState(() => (task.notes?.length ?? 0) > 1000);
  const [open, setOpen] = useState(false), [tab, setTab] = useState<'read' | 'edit' | 'history'>('read');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [search, setSearch] = useState('');
  const [rows, setRows] = useState<RevisionRow[]>([]), [total, setTotal] = useState(0), [latest, setLatest] = useState<Revision | null>(null);
  const [selected, setSelected] = useState<Revision | null>(null), [compare, setCompare] = useState(true), [confirmRestore, setConfirmRestore] = useState(false);
  const [compareTo, setCompareTo] = useState<Revision | null>(null), [loadingVersion, setLoadingVersion] = useState(false);
  const scroll = useRef<HTMLDivElement | null>(null), selectionRequest = useRef(0);
  const endpoint = `/api/tasks/${encodeURIComponent(task.id)}`;
  const value = draft.value('notes');
  const alive = () => active.current && currentStore() === store;
  const [headings, setHeadings] = useState<{ level: number; text: string }[]>([]);
  const readingElement = useCallback((element: HTMLDivElement | null) => {
    scroll.current = element;
    if (element) {
      const next = [...element.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(heading => ({ level: Number(heading.tagName.slice(1)), text: heading.textContent ?? '' }));
      setHeadings(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    }
  }, [value, tab, search]);
  const memoryKey = `nexus:reader:${store.userId}:${task.id}`;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, [task.id, store]);
  useEffect(() => {
    if (!open || tab !== 'read' || !scroll.current) return;
    try { scroll.current.scrollTop = Number(sessionStorage.getItem(memoryKey) ?? 0); } catch { /* unavailable private storage */ }
  }, [open, tab, memoryKey]);
  const act = async (operation: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError('');
    try { await operation(); } catch (reason) { if (alive()) setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { if (alive()) setBusy(false); }
  };
  const synced = async () => {
    await draft.commit();
    for (let i = 0; i < 12; i++) {
      const revision = await get<Revision>(`${endpoint}/description`);
      if (!alive()) throw new Error('任务已切换');
      const current = store.getData().tasks.find(row => row.id === task.id);
      if (revision.notes === (current?.notes ?? '') && revision.title === current?.title) return revision;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('本地内容仍在同步，请稍后重试；当前编辑已保留');
  };
  const history = async (more = false) => {
    const revision = await synced();
    const result = await get<{ revisions: RevisionRow[]; total: number }>(`${endpoint}/revisions?offset=${more ? rows.length : 0}`);
    if (!alive()) return;
    setLatest(revision); setTotal(result.total); setRows(previous => more ? [...previous, ...result.revisions] : result.revisions);
    if (!more) { setSelected(null); setCompareTo(null); setConfirmRestore(false); }
  };
  const show = (view: typeof tab) => {
    setTab(view); setOpen(true); setError('');
    if (view === 'history') void act(() => history());
  };
  const choose = async (id: string, baseline = false) => {
    const request = ++selectionRequest.current;
    setLoadingVersion(true); setConfirmRestore(false); setError('');
    try {
      const revision = await get<Revision>(`${endpoint}/revisions/${encodeURIComponent(id)}`);
      if (alive() && request === selectionRequest.current) { if (baseline) setCompareTo(revision); else setSelected(revision); }
    } catch (reason) { if (alive() && request === selectionRequest.current) setError(reason instanceof Error ? reason.message : '版本读取失败'); }
    finally { if (alive() && request === selectionRequest.current) setLoadingVersion(false); }
  };
  const restore = () => act(async () => {
    if (!selected || !latest) return;
    await draft.commit();
    await get<Revision>(`${endpoint}/revisions/${encodeURIComponent(selected.id)}/restore`, 'POST', { expectedRevisionId: latest.id });
    if (alive()) { setConfirmRestore(false); await history(); }
  });
  const editor = (expanded: boolean) => <textarea id={expanded ? undefined : `notes-${task.id}`} aria-label={expanded ? '编辑任务正文' : '任务备注'}
    value={value} placeholder={textNode ? '记录说明、结论或数据…' : '添加描述或记录下一步…'} rows={expanded ? 20 : 6}
    className={`w-full resize-y bg-transparent text-[13px] leading-7 outline-none placeholder:text-muted/60 ${expanded ? 'min-h-[60dvh] font-mono' : ''}`}
    onChange={event => draft.change('notes', event.target.value)} onBlur={draft.commit} onCompositionStart={draft.compositionStart} onCompositionEnd={draft.compositionEnd} />;
  const difference = useMemo(() => {
    if (!selected || !latest) return [];
    const target = (compareTo ?? latest).notes;
    // Keep very large rewrites from blocking the reader's main thread.
    return diffLines(selected.notes, target, { timeout: 100, maxEditLength: 5000 })
      ?? [{ removed: true, added: false, value: selected.notes }, { added: true, removed: false, value: target }];
  }, [selected, latest, compareTo]);
  const matches = useMemo(() => !search.trim() ? [] : value.split('\n').map((line, i) => ({ line, i })).filter(row => row.line.toLocaleLowerCase().includes(search.toLocaleLowerCase())).slice(0, 100), [value, search]);
  const close = (next: boolean) => { if (next) setOpen(true); else void draft.commit().then(() => { if (alive()) setOpen(false); }, () => { if (alive()) setError('保存失败，请保留编辑内容'); }); };
  return <section className="mb-4" aria-label="任务正文">
    <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">
      <label htmlFor={`notes-${task.id}`}>{textNode ? '内容' : '描述'}</label>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => setReading(previous => !previous)} aria-label={reading ? '编辑正文' : '预览正文'} className="rounded p-1.5 hover:bg-[var(--surface)]">{reading ? <Code size={13} /> : <BookOpen size={13} />}</button>
        <button type="button" onClick={() => show('history')} aria-label="正文历史版本" className="rounded p-1.5 hover:bg-[var(--surface)]"><History size={13} /></button>
        <button type="button" onClick={() => show('read')} aria-label="展开阅读全文" className="rounded p-1.5 hover:bg-[var(--surface)]"><Maximize2 size={13} /></button>
      </div>
    </div>
    {reading ? <><div className="max-h-64 overflow-hidden"><MarkdownDocument text={value.length > 3000 ? value.slice(0, 3000) + '\n\n…' : value} /></div>
      {value.length > 600 && <button className="mt-2 text-xs text-muted underline underline-offset-4" onClick={() => show('read')}>阅读全文 · {value.length.toLocaleString()} 字符</button>}</> : editor(false)}
    <Dialog open={open} onOpenChange={close}><DialogContent title={task.title} aria-describedby="task-document-description" data-task-detail-portal
      className="top-[3dvh] z-[80] flex h-[94dvh] w-[min(96vw,1120px)] flex-col overflow-hidden" overlayClassName="z-[70]" onEscapeKeyDown={event => event.stopPropagation()}>
      <p id="task-document-description" className="sr-only">自由编辑任务正文，查看、比较或恢复历史版本</p>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] pb-3">
        {(['read', 'edit', 'history'] as const).map(view => <Button key={view} size="sm" variant={view === tab ? 'outline' : 'ghost'} onClick={() => show(view)}>{view === 'read' ? '阅读' : view === 'edit' ? '编辑' : '历史版本'}</Button>)}
        <span className="ml-auto text-[11px] text-muted">{draft.status || `${value.length.toLocaleString()} 字符`}</span>
      </div>
      {error && <p role="alert" className="my-2 text-xs text-[var(--danger)]">{error}{tab === 'history' && <button className="ml-2 underline" onClick={() => void act(() => history())}>刷新版本</button>}</p>}
      {tab === 'edit' ? <div className="min-h-0 flex-1 overflow-auto py-4">{editor(true)}</div> : tab === 'read' ? <div className="flex min-h-0 flex-1 gap-5 pt-4">
        <aside className="hidden w-44 shrink-0 overflow-y-auto border-r border-[var(--border)] pr-3 text-xs md:block">
          <p className="mb-3 text-muted">目录</p>{headings.length ? headings.map((heading, i) => <button key={i} className="mb-2 block w-full text-left leading-5 text-muted hover:text-foreground" style={{ paddingLeft: (heading.level - 1) * 8 }} onClick={() => {
            const element = scroll.current?.querySelectorAll('h1,h2,h3,h4,h5,h6')[i];
            let parent = element?.parentElement;
            while (parent && parent !== scroll.current) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
            element?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          }}>{heading.text}</button>) : <p className="leading-5 text-muted">正文标题会显示在这里</p>}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <label className="mb-3 flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-xs"><Search size={13} className="text-muted" /><input aria-label="搜索正文" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索正文…" className="min-w-0 flex-1 bg-transparent outline-none" /></label>
          <div ref={readingElement} onScroll={event => { if (!search) { try { sessionStorage.setItem(memoryKey, String(event.currentTarget.scrollTop)); } catch { /* optional preference */ } } }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 pr-2">
            {search ? <div className="space-y-3 text-sm"><p className="text-xs text-muted">{matches.length >= 100 ? '前 100 条' : `${matches.length} 条`}匹配</p>{matches.map(row => <div key={row.i} className="rounded-lg border border-[var(--border)] px-3 py-2"><span className="mr-2 text-xs text-muted">第 {row.i + 1} 行</span><span className="whitespace-pre-wrap break-words">{row.line}</span></div>)}</div> : <MarkdownDocument text={value} />}
          </div>
        </div>
      </div> : <div className="flex min-h-0 flex-1 flex-col gap-4 pt-4 md:flex-row">
        <aside className="max-h-40 shrink-0 overflow-auto md:max-h-none md:w-56" aria-label="版本列表">
          {busy && !rows.length && <p role="status" className="text-xs text-muted">正在读取历史版本…</p>}
          {rows.map((row, index) => <button key={row.id} type="button" onClick={() => void choose(row.id)} aria-pressed={selected?.id === row.id}
            className={`mb-1 block w-full rounded-lg px-3 py-2 text-left text-xs ${selected?.id === row.id ? 'bg-[var(--surface)]' : 'hover:bg-[var(--surface)]'}`}>
            <span className="block">版本 {total - index}{row.id === latest?.id ? ' · 当前' : ''} · {new Date(row.createdAt).toLocaleString()}</span>
            <span className="mt-1 block text-[11px] text-muted">{origins[row.source] ?? row.source}{row.agentId ? ` · ${row.agentId.slice(0, 8)}` : row.author ? ` · ${row.author}` : ''}{row.roundId ? ` · 轮次 ${row.roundId.slice(0, 8)}` : ''} · {row.length} 字符</span>
          </button>)}
          {rows.length < total && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => history(true))}>加载更早版本</Button>}
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {loadingVersion ? <p role="status" className="text-xs text-muted">读取版本…</p> : selected ? <>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={compare} onChange={event => setCompare(event.target.checked)} />比较差异</label>
              {compare && <SelectField aria-label="比较目标版本" value={compareTo?.id ?? latest?.id ?? ''} options={rows.map(row => ({ value: row.id, label: row.id === latest?.id ? '当前版本' : new Date(row.createdAt).toLocaleString() }))} onValueChange={id => void choose(id, true)} />}
              <Button size="sm" variant="ghost" disabled={busy || selected.id === latest?.id} onClick={() => setConfirmRestore(true)}><RotateCcw size={12} />恢复此版本</Button>
            </div>
            {confirmRestore && <div className="mb-3 rounded-lg border border-[var(--border)] p-3 text-xs leading-6"><p>将标题和正文恢复到所选版本，并保留现有历史。状态、日期和其他配置不会变更。</p><div className="mt-2 flex gap-2"><Button size="sm" disabled={busy} onClick={restore}>确认恢复</Button><Button size="sm" variant="ghost" onClick={() => setConfirmRestore(false)}>取消</Button></div></div>}
            <div className="min-h-0 flex-1 overflow-auto">
              <p className="mb-3 text-sm font-medium">{selected.title}</p>
              {compare ? <><p className="mb-2 text-[11px] text-muted">− 所选版本移除的内容　＋ 比较目标新增的内容</p>{selected.title !== (compareTo ?? latest)?.title && <p className="mb-2 text-xs">标题：{selected.title} → {(compareTo ?? latest)?.title}</p>}
                <pre className="whitespace-pre-wrap break-words text-xs leading-6">{difference.map((part, i) => <span key={i} className={part.added ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : part.removed ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300' : ''}>{part.added ? '+ ' : part.removed ? '− ' : ''}{part.value}</span>)}</pre></> : <MarkdownDocument text={selected.notes} />}
            </div>
          </> : <p className="py-8 text-center text-xs text-muted">选择一个版本查看正文或比较差异</p>}
        </div>
      </div>}
    </DialogContent></Dialog>
  </section>;
}
