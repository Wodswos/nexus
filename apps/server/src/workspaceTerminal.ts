import { transientRemoteError } from './workspaces/remoteErrors';
import type { ServerType } from '@hono/node-server';
import { WebSocket, WebSocketServer } from 'ws';
import { socketOriginAllowed, upgradeUrl, type WsIdentity } from './security';
import type { AgentTransport } from './workspaces/transport';
import type { WorkspaceService } from './workspaces/service';

export function setupWorkspaceTerminal(server: ServerType, service: Pick<WorkspaceService, 'openTerminalTransport'>,
  verifyTicket: (value: string) => WsIdentity | null, validSession: (identity: WsIdentity) => boolean) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Map<WebSocket, { identity: WsIdentity; abort: AbortController }>();
  server.on('upgrade', (request, socket, head) => {
    const url = upgradeUrl(request.url);
    if (url?.pathname !== '/api/workspace-terminal/attach') return;
    const reject = (status: string) => { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (!socketOriginAllowed(request.headers)) return reject('403 Forbidden');
    const identity = verifyTicket(url.searchParams.get('ticket') ?? '');
    if (!identity || !validSession(identity)) return reject('401 Unauthorized');
    if (clients.size >= 32 || [...clients.values()].filter(value => value.identity.userId === identity.userId).length >= 4) return reject('429 Too Many Requests');
    const environmentId = url.searchParams.get('environmentId') ?? '', paneId = url.searchParams.get('pane') ?? '';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(environmentId) || !/^%\d+$/.test(paneId)) return reject('400 Bad Request');
    wss.handleUpgrade(request, socket, head, ws => {
      const abort = new AbortController(); clients.set(ws, { identity, abort });
      let transport: AgentTransport | undefined, starting = false, stderr = '';
      const cleanup = () => { clearTimeout(startup); abort.abort(); transport?.close(); clients.delete(ws); };
      const end = (reason: string, retryable = false) => { if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'exit', reason, retryable })); ws.close(); } cleanup(); };
      const startup = setTimeout(() => end('未收到终端启动消息'), 5000); startup.unref();
      ws.on('close', cleanup); ws.on('error', cleanup);
      ws.on('message', async (bytes, binary) => {
        if (!validSession(identity)) return end('登录会话已结束');
        if (!transport) {
          if (starting) return;
          try { if (binary || JSON.parse(bytes.toString()).type !== 'start') return end('终端启动消息无效'); }
          catch { return end('终端启动消息无效'); }
          starting = true; clearTimeout(startup);
          try {
            transport = await service.openTerminalTransport(identity.userId, environmentId, paneId, Number(url.searchParams.get('cols')), Number(url.searchParams.get('rows')), abort.signal);
            if (abort.signal.aborted) { transport.close(); return; }
            const output = (chunk: Buffer) => { if (ws.bufferedAmount > 2 * 1024 * 1024) return end('终端输出积压，请重新连接'); if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true }); };
            transport.stdout.on('data', output); transport.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); output(chunk); });
            ws.send(JSON.stringify({ type: 'ready' }));
            void transport.closed.then(() => { if (!abort.signal.aborted) end(stderr.trim() || '已断开终端连接，远端会话保留', transientRemoteError(stderr)); });
          } catch (error) { end(error instanceof Error ? error.message : '终端连接失败', transientRemoteError(error)); }
          return;
        }
        if (transport.stdin.writableLength > 1024 * 1024) return end('终端输入积压');
        transport.stdin.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as ArrayBuffer));
      });
    });
  });
  const heartbeat = setInterval(() => { for (const [ws, value] of clients) { if (!validSession(value.identity)) { value.abort.abort(); ws.close(1008, 'session ended'); } else ws.ping(); } }, 15000); heartbeat.unref();
  return {
    disconnectSession(token: string) { for (const [ws, value] of clients) if (value.identity.sessionToken === token) { value.abort.abort(); ws.close(1008, 'session ended'); } },
    close() { clearInterval(heartbeat); for (const [ws, value] of clients) { value.abort.abort(); ws.close(1001, 'server shutdown'); } wss.close(); },
  };
}
