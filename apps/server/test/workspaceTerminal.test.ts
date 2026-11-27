import { it, expect } from 'vitest';
import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import { setupWorkspaceTerminal } from '../src/workspaceTerminal';
import type { AgentTransport } from '../src/workspaces/transport';

it('uses one-time tickets, scopes pane attachment, streams Unicode, and detaches on logout', async () => {
  const app = new Hono(), server = createAdaptorServer(app);
  const tickets = new Map([['once', { userId: 'alice', sessionToken: 'session' }], ['other', { userId: 'bob', sessionToken: 'other-session' }]]);
  let closed = 0, opened = 0, valid = true, input = '';
  const bridge = setupWorkspaceTerminal(server, { async openTerminalTransport(userId, environmentId, paneId) {
    if (userId !== 'alice' || environmentId !== 'owned-env' || paneId !== '%7') throw new Error('此账号无法访问目标 pane');
    opened++;
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    let resolve!: (result: { code: number | null }) => void;
    const ended = new Promise<{ code: number | null }>(done => { resolve = done; });
    stdin.on('data', bytes => { input += bytes.toString(); stdout.write(bytes); });
    let done = false;
    return { stdin, stdout, stderr, closed: ended, close() { if (!done) { done = true; closed++; resolve({ code: 0 }); } } } satisfies AgentTransport;
  } }, ticket => { const identity = tickets.get(ticket); tickets.delete(ticket); return identity ?? null; }, () => valid);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }, base = `ws://127.0.0.1:${address.port}/api/workspace-terminal/attach?environmentId=owned-env&pane=%257&ticket=`;
  const clients: WebSocket[] = [];
  const connect = (ticket: string) => { const ws = new WebSocket(base + ticket); clients.push(ws); return ws; };
  try {
    const ws = connect('once'), messages: string[] = [];
    ws.on('message', bytes => messages.push(bytes.toString()));
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'start' }));
    await expect.poll(() => messages.some(value => value.includes('ready'))).toBe(true);
    ws.send('中文输入\n第二行\r');
    await expect.poll(() => input).toBe('中文输入\n第二行\r');
    expect(messages).toContain('中文输入\n第二行\r');
    ws.send('继续'); ws.send('执行');
    await expect.poll(() => input).toBe('中文输入\n第二行\r继续执行');
    expect(opened).toBe(1);
    const repeat = connect('once');
    expect(await new Promise<number>(resolve => { repeat.once('unexpected-response', (_request, response) => { response.resume(); repeat.terminate(); resolve(response.statusCode!); }); repeat.on('error', () => {}); })).toBe(401);
    const other = connect('other'), otherMessages: string[] = [];
    other.on('message', bytes => otherMessages.push(bytes.toString()));
    await new Promise<void>((resolve, reject) => { other.once('open', resolve); other.once('error', reject); });
    other.send(JSON.stringify({ type: 'start' }));
    await expect.poll(() => otherMessages.some(value => value.includes('无法访问'))).toBe(true);
    expect(JSON.parse(otherMessages[0]!)).toMatchObject({ type: 'exit', retryable: false });
    valid = false; bridge.disconnectSession('session');
    await expect.poll(() => closed).toBe(1);
    await expect.poll(() => ws.readyState).toBe(WebSocket.CLOSED);
  } finally {
    clients.forEach(ws => ws.terminate()); bridge.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it.each([
  { phase: 'open', reason: 'kex_exchange_identification: read: Connection reset by peer', retryable: true },
  { phase: 'stream', reason: 'Connection reset by 115.190.3.4 port 22', retryable: true },
  { phase: 'open', reason: '目标 pane 已退出或变化', retryable: false },
  { phase: 'stream', reason: '', retryable: false },
])('classifies $phase transport closure without retrying command delivery: $reason', async ({ phase, reason, retryable }) => {
  const server = createAdaptorServer(new Hono());
  let finish: (() => void) | undefined;
  const bridge = setupWorkspaceTerminal(server, { async openTerminalTransport() {
    if (phase === 'open') throw new Error(reason);
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    let resolve!: (value: { code: number | null }) => void;
    const closed = new Promise<{ code: number | null }>(done => { resolve = done; });
    finish = () => { stderr.write(reason); resolve({ code: reason ? 255 : 0 }); };
    return { stdin, stdout, stderr, closed, close() { resolve({ code: 0 }); } };
  } }, () => ({ userId: 'alice', sessionToken: 'session' }), () => true);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/workspace-terminal/attach?environmentId=env&pane=%257&ticket=once`);
  const controls: any[] = [];
  ws.on('message', (bytes, binary) => { if (!binary) controls.push(JSON.parse(bytes.toString())); });
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'start' }));
    if (phase === 'stream') { await expect.poll(() => controls.some(value => value.type === 'ready')).toBe(true); finish!(); }
    await expect.poll(() => controls.find(value => value.type === 'exit')).toMatchObject({ type: 'exit', retryable });
    await expect.poll(() => ws.readyState).toBe(WebSocket.CLOSED);
  } finally { ws.terminate(); bridge.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
