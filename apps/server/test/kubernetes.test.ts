import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { Hono } from 'hono';
import { EMPTY_WORKSPACE, validateWorkspaceConfig, type WorkspaceEnvironment } from '../../../packages/core/src/executionWorkspace';
import { KubernetesConnections, setupKubernetesConnections, type KubernetesConnection } from '../src/workspaces/kubernetesConnections';
import { KubernetesClient, kubernetesIdentity } from '../src/workspaces/kubernetes';
import { agentLaunchLine, BOOTSTRAP_READER } from '../src/workspaces/transport';
import { WorkspaceService } from '../src/workspaces/service';
import { DB } from '../src/db';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
function temporary() {
  const path = mkdtempSync(join(tmpdir(), 'nexus-kube-'));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
async function fixture() {
  const dir = temporary(), keyPath = join(dir, 'key.pem'), certPath = join(dir, 'cert.pem');
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  if (result.status !== 0) throw new Error('openssl fixture failed');
  const ca = readFileSync(certPath, 'utf8'), token = 'fixture-kubernetes-token';
  const state = { uid: 'pod-uid-1', owner: 'alice', phase: 'Running', failExit: false, execCount: 0, created: false, session: 'dev', namespace: 'team', pvcs: new Map<string, any>(), requests: [] as { method: string; url: string; authorization: string; body: unknown }[] };
  const pod = (name: string) => ({ metadata: { name, uid: state.uid, labels: { 'nexus.owner': state.owner, 'nexus.environment': name.replace(/^nexus-/, '') } }, spec: { containers: [{ name: 'workspace', image: 'node:24' }] }, status: { phase: state.phase, conditions: [{ type: 'Ready', status: 'True' }] } });
  const server = createServer({ key: readFileSync(keyPath), cert: ca }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      state.requests.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization ?? '', body });
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end('{}'); return; }
      const name = req.url?.split('/').pop() ?? '';
      if (req.url?.includes('/persistentvolumeclaims')) {
        if (req.method === 'POST') { const pvc = { ...body, metadata: { ...body.metadata, uid: `pvc-${body.metadata.name}` } }; state.pvcs.set(body.metadata.name, pvc); res.end(JSON.stringify(pvc)); }
        else if (req.method === 'DELETE') { const pvc = state.pvcs.get(name); if (!pvc || body.preconditions?.uid !== pvc.metadata.uid) { res.statusCode = 409; res.end('{}'); } else { state.pvcs.delete(name); res.end('{}'); } }
        else { const pvc = state.pvcs.get(name); if (pvc) res.end(JSON.stringify(pvc)); else { res.statusCode = 404; res.end('{}'); } }
        return;
      }
      if (req.method === 'POST') { state.created = true; res.end(JSON.stringify(pod(body.metadata.name))); }
      else if (req.method === 'DELETE') { state.created = false; res.end('{}'); }
      else if (name === 'pods') res.end(JSON.stringify({ items: [pod('existing'), { ...pod('other'), metadata: { name: 'other', uid: 'other', labels: { 'nexus.owner': 'bob' } } }] }));
      else if (name.startsWith('nexus-') && !state.created) { res.statusCode = 404; res.end('{}'); }
      else res.end(JSON.stringify(pod(name)));
    });
  });
  const wss = new WebSocketServer({ server, handleProtocols: (protocols) => protocols.has('v5.channel.k8s.io') ? 'v5.channel.k8s.io' : false });
  wss.on('connection', (ws, req) => {
    state.execCount++;
    if (req.headers.authorization !== `Bearer ${token}`) { ws.close(); return; }
    const url = new URL(req.url!, 'https://localhost');
    state.requests.push({ method: 'EXEC', url: req.url!, authorization: req.headers.authorization ?? '', body: null });
    const command = url.searchParams.getAll('command');
    const script = command[2] ?? '';
    let input = '';
    const respond = (output: string, code = 0) => {
      ws.send(Buffer.concat([Buffer.from([1]), Buffer.from(output)]));
      ws.send(Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify(code ? { status: 'Failure', details: { causes: [{ reason: 'ExitCode', message: String(code) }] } } : { status: 'Success' }))]));
      ws.close();
    };
    if (script === BOOTSTRAP_READER) {
      const child = spawn('sh', ['-c', script], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => ws.send(Buffer.concat([Buffer.from([1]), chunk])));
      child.stderr.on('data', (chunk) => ws.send(Buffer.concat([Buffer.from([2]), chunk])));
      child.on('close', (code) => respond('', code ?? 1));
      ws.on('close', () => child.kill('SIGKILL'));
      child.stdin.on('error', () => {});
      ws.on('message', (data) => { const bytes = Buffer.from(data as Buffer); if (bytes[0] === 0) child.stdin.write(bytes.subarray(1)); else if (bytes[0] === 255 && bytes[1] === 0) child.stdin.end(); });
      return;
    }
    ws.on('message', (data) => {
      const bytes = Buffer.from(data as Buffer);
      if (bytes[0] === 0) input += bytes.subarray(1).toString('utf8');
      if (bytes[0] === 255 && bytes[1] === 0) {
        if (script.includes('list-panes')) respond(`%1\t$0\t@0\t42\t100\t0\t${state.session}\tmain\tsh\t/workspace\n`);
        else if (script === 'sh -s') { state.session = /tmux new-session -d -s '([^']+)'/.exec(input)?.[1] ?? 'dev'; respond('NEXUS_DIRECTORY=/workspace\n'); }
        else if (state.failExit) respond('failed output', 7);
        else respond(`echo:${input}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { for (const client of wss.clients) client.terminate(); await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve()))); });
  const address = server.address() as { port: number };
  const connection: KubernetesConnection = { id: 'cluster', name: 'Fixture', server: `https://127.0.0.1:${address.port}`, namespace: 'team', ca, token, cert: '', key: '', createdAt: 1, updatedAt: 1 };
  const environment: WorkspaceEnvironment = { id: 'env', taskId: 'task', config: { ...EMPTY_WORKSPACE, runtime: 'kubernetes', kubeConnectionId: 'cluster', image: 'node:24', namespace: 'team' }, connectionHost: kubernetesIdentity(connection), state: 'ready', managed: true, resourceId: 'existing', resourceUid: state.uid, session: 'dev', directory: '/tmp', createdAt: 1, updatedAt: 1 };
  return { dir, state, connection, environment, client: new KubernetesClient(connection) };
}

describe('direct Kubernetes connection credentials', () => {
  it('encrypts credentials, preserves omitted secret fields, and isolates accounts', () => {
    const dir = temporary(), connections = new KubernetesConnections(dir);
    const first = connections.save('alice', { id: 'cluster', name: 'Private cluster', server: 'https://kube.example', token: 'do-not-disclose', namespace: 'dev' });
    expect(first.tokenSet).toBe(true);
    expect(JSON.stringify(first)).not.toContain('do-not-disclose');
    const disk = readdirSync(join(dir, 'kubernetes')).filter((name) => name.endsWith('.json')).map((name) => readFileSync(join(dir, 'kubernetes', name), 'utf8')).join('');
    expect(disk).not.toContain('do-not-disclose');
    expect(connections.resolve('bob', 'cluster')).toBeNull();
    expect(connections.list('bob')).toEqual([]);
    expect(() => connections.delete('bob', 'cluster')).toThrow('不存在');
    connections.save('alice', { name: 'Renamed' }, 'cluster');
    expect(new KubernetesConnections(dir).resolve('alice', 'cluster')?.token).toBe('do-not-disclose');
    expect(() => connections.save('alice', { token: null }, 'cluster')).toThrow('Token');
    expect(() => connections.save('alice', { name: 'x', server: 'http://kube.example', token: 'secret' })).toThrow('HTTPS');
  });
  it('requires a browser account for CRUD and never returns credentials', async () => {
    const app = new Hono();
    setupKubernetesConnections(app, temporary(), (context) => context.req.header('test-user') ?? null);
    expect((await app.request('/api/kubernetes-connections')).status).toBe(401);
    const response = await app.request('/api/kubernetes-connections', { method: 'POST', headers: { 'Content-Type': 'application/json', 'test-user': 'alice' }, body: JSON.stringify({ id: 'cluster', name: 'cluster', server: 'https://cluster.example', token: 'private-token' }) });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('private-token');
    const second = await app.request('/api/kubernetes-connections', { headers: { 'test-user': 'bob' } });
    expect(await second.json()).toEqual({ data: [] });
  });
});

describe('direct Kubernetes API and Agent stdio', () => {
  it('uses verified TLS and bearer headers, filters foreign Pods, enforces UID, and reports nonzero exits', async () => {
    const f = await fixture();
    expect(await f.client.pods('team', 'alice')).toEqual([{ id: 'existing', name: 'existing', image: 'node:24' }]);
    expect(await f.client.execute(f.environment, 'alice', 'echo-input', '中文\nline two')).toBe('echo:中文\nline two');
    expect(f.state.requests.every((value) => value.authorization === `Bearer ${f.connection.token}`)).toBe(true);
    expect(f.state.requests.every((value) => !value.url.includes(f.connection.token))).toBe(true);
    f.state.failExit = true;
    await expect(f.client.execute(f.environment, 'alice', 'echo-input', 'x')).rejects.toThrow('命令失败');
    f.state.uid = 'replaced';
    const count = f.state.execCount;
    await expect(f.client.execute(f.environment, 'alice', 'echo-input', 'x')).rejects.toThrow('已被替换');
    expect(f.state.execCount).toBe(count);
    await expect(new KubernetesClient({ ...f.connection, ca: '' }).pods('team', 'alice')).rejects.toThrow('TLS');
  });
  it('streams Agent stdin/stdout without putting scoped credentials into the Kubernetes exec URL', async () => {
    const f = await fixture();
    const transport = await f.client.open(f.environment, 'alice', ['sh', '-c', BOOTSTRAP_READER]);
    let output = '';
    transport.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    transport.stdin.write(agentLaunchLine('printf "ready:%s\\n" "$NEXUS_AGENT_TOKEN"; while IFS= read -r line; do printf "message:%s\\n" "$line"; done', { env: { NEXUS_AGENT_TOKEN: 'scoped-token' }, directory: '/tmp' }));
    await expect.poll(() => output).toContain('ready:scoped-token');
    transport.stdin.write('第一条消息\n');
    await expect.poll(() => output).toContain('message:第一条消息');
    transport.stdin.end('second message\n');
    expect(await transport.closed).toEqual({ code: 0 });
    expect(output).toContain('message:second message');
    expect(f.state.requests.find((request) => request.method === 'EXEC')?.url).not.toContain('scoped-token');
  });
  it('prepares and removes a managed Pod with exact owner/environment and UID delete preconditions', async () => {
    const f = await fixture();
    const environment = { ...f.environment, resourceId: 'nexus-env', resourceUid: undefined };
    const pod = await f.client.prepare(environment, 'alice');
    expect(pod.metadata.uid).toBe('pod-uid-1');
    expect(f.state.requests.find((request) => request.method === 'POST')?.body).toMatchObject({ metadata: { labels: { 'nexus.owner': 'alice', 'nexus.environment': 'env' } } });
    await f.client.delete({ ...environment, resourceUid: pod.metadata.uid }, 'alice');
    expect(f.state.requests.find((request) => request.method === 'DELETE')?.body).toMatchObject({ preconditions: { uid: 'pod-uid-1' } });
    f.state.owner = 'bob';
    await expect(f.client.inspect('team', 'existing', 'alice')).rejects.toThrow('归属');
  });
  it('prepares a complete Workspace without an SSH server, then protects the connection snapshot and user ownership', async () => {
    const f = await fixture(), db = new DB(f.dir), connections = new KubernetesConnections(f.dir);
    connections.save('alice', { id: 'cluster', name: f.connection.name, server: f.connection.server, namespace: 'team', ca: f.connection.ca, token: f.connection.token });
    const config = { ...f.environment.config, namespace: '' };
    validateWorkspaceConfig(config);
    const service = new WorkspaceService(db, { resolve: () => { throw new Error('SSH should not be used'); } }, () => ({ config, title: 'task' }), undefined, connections);
    cleanup.push(() => { service.close(); db.close(); });
    const environment = service.create('alice', 'task', 'unique-create');
    await expect.poll(() => service.environment('alice', environment.id).state).toBe('ready');
    expect(service.create('alice', 'task', 'unique-create').id).toBe(environment.id);
    await expect(service.executeInEnvironment('alice', environment.id, 'echo-input', 'abc')).resolves.toBe('echo:abc');
    expect(() => service.environment('bob', environment.id)).toThrow('不存在');
    const ready = service.environment('alice', environment.id), claim = ready.storage!.name!;
    expect(ready.config.namespace).toBe('team');
    expect(f.state.requests.filter(request => request.method === 'POST' && /\/(pods|persistentvolumeclaims)$/.test(request.url)).every(request => request.url.startsWith('/api/v1/namespaces/team/'))).toBe(true);
    expect(f.state.pvcs.has(claim)).toBe(true);
    expect(f.state.requests.find(request => request.method === 'POST' && request.url.endsWith('/pods'))?.body).toMatchObject({ spec: { volumes: [{ name: 'workspace-data', persistentVolumeClaim: { claimName: claim } }], containers: [{ volumeMounts: [{ name: 'workspace-data', mountPath: '/workspace' }] }] } });
    expect(await service.pause('alice', environment.id)).toMatchObject({ state: 'paused' });
    expect(f.state.pvcs.has(claim)).toBe(true);
    f.state.uid = 'pod-uid-after-resume';
    service.resume('alice', environment.id);
    await expect.poll(() => service.environment('alice', environment.id).state).toBe('ready');
    expect(service.environment('alice', environment.id).resourceUid).toBe('pod-uid-after-resume');
    expect(f.state.requests.filter(request => request.method === 'POST' && request.url.endsWith('/persistentvolumeclaims'))).toHaveLength(1);
    const transport = await service.openAgentTransport('alice', environment.id, 'printf \"agent-ready\\n\"; cat', { directory: '/tmp' });
    let output = '';
    transport.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    await expect.poll(() => output).toContain('agent-ready');
    await expect(service.stop('alice', environment.id)).rejects.toThrow('Agent');
    transport.close();
    await transport.closed;
    connections.save('alice', { server: 'https://another.example' }, 'cluster');
    await expect(service.executeInEnvironment('alice', environment.id, 'echo-input', 'abc')).rejects.toThrow('目标');
  });
});
