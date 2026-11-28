import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';
import { terminalTheme, Button, Dialog, DialogContent } from '@nexus/ui';
import { apiRequest, currentStore, socketUrl, useNexus } from '@nexus/crdt';
import type { WorkspacePane } from '@nexus/core';

/** Closing the viewer only detaches the PTY; it never ends its remote tmux session. */
export default function WorkspaceTerminal({ environmentId, pane, onClose, embedded = false }: { environmentId: string; pane: WorkspacePane; onClose?: () => void; embedded?: boolean }) {
  const store = useNexus();
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const terminal = useRef<XTerm | null>(null), socket = useRef<WebSocket | null>(null), ready = useRef(false);
  const [status, setStatus] = useState('正在连接…'), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!box) return;
    let disposed = false, generation = 0, dimensions = { cols: 0, rows: 0 };
    let resizeTimer: ReturnType<typeof setTimeout> | undefined, reconnectTimer: ReturnType<typeof setTimeout> | undefined, stableTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnects = 0;
    const active = () => !disposed && currentStore() === store;
    const term = new XTerm({ fontSize: 13, fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace", cursorBlink: true, convertEol: false, rightClickSelectsWord: true, theme: terminalTheme() });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(box);
    try { term.loadAddon(new CanvasAddon()); } catch { /* DOM renderer remains available. */ }
    fit.fit(); terminal.current = term;
    const reconnect = () => {
      if (!active() || reconnectTimer) return;
      if (reconnects >= 5) { setStatus('连接未恢复，请手动重连'); return; }
      const delay = Math.min(30000, 2000 * 2 ** reconnects++);
      setStatus(`连接中断，${delay / 1000} 秒后重连`);
      reconnectTimer = setTimeout(() => { reconnectTimer = undefined; if (active()) void connect(); }, delay);
    };
    const connect = async () => {
      clearTimeout(stableTimer); clearTimeout(reconnectTimer); reconnectTimer = undefined;
      const attempt = ++generation;
      ready.current = false; socket.current?.close(); socket.current = null;
      setStatus('正在连接…'); setError('');
      try {
        const { ticket } = await apiRequest<{ ticket: string }>(`/api/auth/ticket?userId=${encodeURIComponent(store.userId)}&purpose=workspace-terminal`);
        if (!active() || generation !== attempt) return;
        fit.fit(); dimensions = { cols: term.cols, rows: term.rows };
        const params = new URLSearchParams({ ticket, environmentId, pane: pane.id, cols: String(term.cols), rows: String(term.rows) });
        const ws = new WebSocket(`${socketUrl('/api/workspace-terminal/attach')}?${params}`);
        ws.binaryType = 'arraybuffer'; socket.current = ws;
        const current = () => active() && generation === attempt;
        let ended = false;
        // A new attachment redraws the same tmux screen; never append it as a transcript.
        term.reset();
        ws.onopen = () => { if (current()) ws.send(JSON.stringify({ type: 'start' })); else ws.close(); };
        ws.onmessage = (event) => {
          if (!current()) return;
          if (typeof event.data !== 'string') { term.write(new Uint8Array(event.data)); return; }
          try {
            const message = JSON.parse(event.data) as { type: string; reason?: string; retryable?: boolean };
            if (message.type === 'ready') { ready.current = true; setStatus('已连接'); if (!embedded) term.focus(); stableTimer = setTimeout(() => { reconnects = 0; }, 30000); }
            if (message.type === 'exit') { ended = true; ready.current = false; clearTimeout(stableTimer); setStatus('连接已结束'); setError(message.reason ?? '远端会话已退出'); if (message.retryable) reconnect(); }
          } catch { term.write(event.data); }
        };
        ws.onclose = (event) => { if (current()) { ready.current = false; clearTimeout(stableTimer); if (!ended) { setStatus('已断开'); if (event.code !== 1000 && event.code !== 1008) reconnect(); } } };
        ws.onerror = () => { if (current()) { ready.current = false; setError('连接失败，请检查 Workspace 状态后重连。'); } };
      } catch (reason) { if (active() && generation === attempt) { setStatus('连接失败'); setError(reason instanceof Error ? reason.message : '连接失败'); } }
    };
    const input = term.onData((text) => { if (active() && ready.current && socket.current?.readyState === WebSocket.OPEN) socket.current.send(text); });
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!active()) return;
        fit.fit();
        if (ready.current && (dimensions.cols !== term.cols || dimensions.rows !== term.rows)) void connect();
      }, 750);
    });
    observer.observe(box); void connect();
    return () => { disposed = true; ready.current = false; generation++; clearTimeout(resizeTimer); clearTimeout(reconnectTimer); clearTimeout(stableTimer); observer.disconnect(); input.dispose(); socket.current?.close(); socket.current = null; terminal.current = null; term.dispose(); };
  }, [store, environmentId, pane.id, retry, box]);
  const sendKey = (text: string) => { if (currentStore() === store && ready.current && socket.current?.readyState === WebSocket.OPEN) socket.current.send(text); terminal.current?.focus(); };
  const copy = async () => {
    const text = terminal.current?.getSelection(); if (!text) { setStatus('先按住 Shift 拖选要复制的内容'); return; }
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else { const input = document.createElement('textarea'); input.value = text; input.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove(); }
      setStatus('已复制选区');
    } catch { setError('无法复制，请检查浏览器剪贴板权限。'); }
  };
  const content = <>
    <div className="mb-2 flex items-center justify-between gap-2"><p role="status" title={status} className="min-w-0 flex-1 truncate text-micro text-muted">{status}</p><div className="flex shrink-0 gap-1"><Button size="sm" variant="ghost" onClick={() => void copy()}>复制选区</Button><Button size="sm" variant="ghost" onClick={() => setRetry((value) => value + 1)}>重新连接</Button></div></div>
    <div className="relative min-h-32 flex-1">
      <div ref={setBox} aria-label="Workspace 交互终端" className="h-full overflow-hidden rounded-[var(--radius-md)] bg-[var(--terminal-bg)] p-2" />
      {error && <p role="alert" className="absolute inset-x-2 bottom-2 max-h-24 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--background)] p-2 text-xs text-[var(--danger)]">{error}</p>}
    </div>
    <div className="mt-2 flex flex-wrap gap-1">{[['Esc','\u001b'],['Tab','\t'],['↑','\u001b[A'],['↓','\u001b[B'],['Ctrl+C','\u0003'],['Enter','\r']].map(([label, key]) => <Button key={label} size="sm" variant="ghost" onClick={() => sendKey(key!)}>{label}</Button>)}</div>
    <p id="workspace-terminal-hint" className="mt-2 text-micro leading-5 text-muted">直接输入与 Agent 交互；Shift + 拖动选择文字。关闭面板后会话继续运行。</p>
  </>;
  if (embedded) return <section aria-label="Agent 终端会话" data-workspace-terminal className="flex min-h-0 flex-1 flex-col px-3 py-2">{content}</section>;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose?.(); }}><DialogContent title={`终端 · ${pane.session} / ${pane.window}`} aria-describedby="workspace-terminal-hint" data-task-detail-portal data-workspace-terminal className="top-[4dvh] z-[90] flex h-[92dvh] w-[min(96vw,1200px)] flex-col overflow-hidden" overlayClassName="z-[80]" onEscapeKeyDown={(event) => event.preventDefault()}>{content}</DialogContent></Dialog>;
}
