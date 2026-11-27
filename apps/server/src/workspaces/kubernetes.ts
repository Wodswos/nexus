import { request } from 'node:https';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { WebSocket } from 'ws';
import type { WorkspaceEnvironment } from '../../../../packages/core/src/executionWorkspace';
import { KubernetesError, type KubernetesConnection } from './kubernetesConnections';
import type { AgentTransport } from './transport';
import { pvcManifest, containerConstraints } from './runtime';

interface Pod {
  metadata: { name: string; uid: string; labels?: Record<string, string> };
  spec?: { containers?: { name: string; image?: string }[] };
  status?: { phase?: string; conditions?: { type: string; status: string }[] };
}
const namespaceName = (value: string) => {
  if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(value)) throw new KubernetesError('Kubernetes Namespace 无效');
  return value;
};
const podName = (value: string) => {
  if (!/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(value)) throw new KubernetesError('Kubernetes Pod 名称无效');
  return value;
};
export const kubernetesIdentity = (connection: KubernetesConnection) => `${connection.server}#${createHash('sha256').update(connection.ca).digest('hex').slice(0, 24)}`;
const wait = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const aborted = () => { clearTimeout(timer); reject(new KubernetesError('Kubernetes 操作已取消')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, milliseconds);
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
});

export class KubernetesClient {
  constructor(private connection: KubernetesConnection) {}
  private options() {
    const { ca, cert, key, token } = this.connection;
    return {
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
      ...(cert ? { cert, key } : {}),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    };
  }
  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new KubernetesError('Kubernetes 操作已取消');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const options = this.options();
    return new Promise((resolve, reject) => {
      const req = request(new URL(path, this.connection.server), { ...options, headers: { ...options.headers, ...(payload !== undefined ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}) }, method, timeout: 12000 }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) req.destroy(new Error('response limit'));
          else chunks.push(chunk);
        });
        response.on('error', () => reject(new KubernetesError('Kubernetes 响应中断', 502)));
        response.on('end', () => {
          const status = response.statusCode ?? 502;
          if (status < 200 || status >= 300) {
            // Do not echo API response bodies: proxies can include request credentials.
            reject(new KubernetesError(status === 404 ? 'Kubernetes Pod 或 API 不存在' : status === 403 ? 'Kubernetes RBAC 权限不足' : status === 401 ? 'Kubernetes 凭据已失效' : `Kubernetes API 返回 ${status}`, status === 404 || status === 409 ? status : 502));
            return;
          }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new KubernetesError('Kubernetes API 响应格式无效', 502)); }
        });
      });
      const abort = () => req.destroy(new Error('aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      req.on('close', () => signal?.removeEventListener('abort', abort));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => reject(new KubernetesError(signal?.aborted ? 'Kubernetes 操作已取消' : 'Kubernetes 连接失败，请检查地址、TLS 证书与网络', 502)));
      if (signal?.aborted) abort();
      req.end(payload);
    });
  }
  private base(namespace: string) { return `/api/v1/namespaces/${namespaceName(namespace)}/pods`; }
  async pods(namespace: string, userId: string) {
    const response = await this.request<{ items: Pod[] }>('GET', this.base(namespace));
    return (response.items ?? []).filter((pod) => pod.status?.phase === 'Running' && (!pod.metadata.labels?.['nexus.owner'] || pod.metadata.labels['nexus.owner'] === userId))
      .map((pod) => ({ id: pod.metadata.name, name: pod.metadata.name, image: pod.spec?.containers?.[0]?.image }));
  }
  async inspect(namespace: string, resource: string, userId: string, expectedUid?: string, signal?: AbortSignal): Promise<Pod> {
    const pod = await this.request<Pod>('GET', `${this.base(namespace)}/${podName(resource)}`, undefined, signal);
    const owner = pod.metadata?.labels?.['nexus.owner'];
    if (!pod.metadata?.uid || !pod.metadata?.name || (owner && owner !== userId)) throw new KubernetesError('Pod 归属不匹配', 409);
    if (expectedUid && expectedUid !== pod.metadata.uid) throw new KubernetesError('Pod 已被替换，请重新关联环境', 409);
    return pod;
  }
  async prepare(environment: WorkspaceEnvironment, userId: string, signal?: AbortSignal): Promise<Pod> {
    const { config } = environment, namespace = config.namespace || this.connection.namespace;
    if (environment.storage?.kind === 'pvc') await this.ensurePvc(environment, userId, signal);
    let pod: Pod | null = null;
    try {
      pod = await this.inspect(namespace, environment.resourceId, userId, environment.resourceUid, signal);
      if (pod.metadata.labels?.['nexus.environment'] !== environment.id || pod.metadata.labels?.['nexus.owner'] !== userId) throw new KubernetesError('同名 Pod 不属于此环境', 409);
    } catch (error) { if (!(error instanceof KubernetesError && error.status === 404)) throw error; }
    if (!pod) {
      const manifest = {
        apiVersion: 'v1', kind: 'Pod',
        metadata: { name: podName(environment.resourceId), namespace, labels: { 'nexus.owner': userId, 'nexus.environment': environment.id } },
        spec: {
          restartPolicy: 'Never',
          ...(config.runUser ? { securityContext: { fsGroup: Number(config.runUser.split(':')[1] || config.runUser.split(':')[0]) } } : {}),
          ...(environment.storage?.kind === 'pvc' ? { volumes: [{ name: 'workspace-data', persistentVolumeClaim: { claimName: environment.storage.name } }] } : {}),
          ...(config.imagePullSecret ? { imagePullSecrets: [{ name: config.imagePullSecret }] } : {}),
          containers: [{ name: 'workspace', image: config.image, ...containerConstraints(config), ...(environment.storage?.kind === 'pvc' ? { volumeMounts: [{ name: 'workspace-data', mountPath: environment.storage.mountRoot }] } : {}), command: ['sh', '-c', 'while :; do sleep 3600; done'],
            ...(config.secretRef ? { envFrom: [{ secretRef: { name: config.secretRef } }] } : {}) }],
        },
      };
      try { pod = await this.request<Pod>('POST', this.base(namespace), manifest, signal); }
      catch (error) {
        if (!(error instanceof KubernetesError && error.status === 409)) throw error;
        pod = await this.inspect(namespace, environment.resourceId, userId, environment.resourceUid, signal);
        if (pod.metadata.labels?.['nexus.environment'] !== environment.id || pod.metadata.labels?.['nexus.owner'] !== userId) throw new KubernetesError('同名 Pod 不属于此环境', 409);
      }
    }
    const uid = pod.metadata?.uid;
    if (!uid) throw new KubernetesError('Kubernetes 未返回 Pod UID', 502);
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      pod = await this.inspect(namespace, environment.resourceId, userId, uid, signal);
      if (pod.status?.phase === 'Running' && pod.status.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True')) return pod;
      if (['Failed', 'Succeeded'].includes(pod.status?.phase ?? '')) throw new KubernetesError('Pod 已退出，请检查镜像和集群事件', 502);
      await wait(1000, signal);
    }
    throw new KubernetesError('等待 Pod 就绪超时，请检查镜像拉取、资源和集群事件', 502);
  }
  private async ensurePvc(environment: WorkspaceEnvironment, userId: string, signal?: AbortSignal, create = true): Promise<void> {
    const storage = environment.storage!;
    const path = `/api/v1/namespaces/${namespaceName(environment.config.namespace || this.connection.namespace)}/persistentvolumeclaims`;
    let pvc: { metadata: { uid: string; labels?: Record<string, string> } };
    try { pvc = await this.request('GET', `${path}/${podName(storage.name!)}`, undefined, signal); }
    catch (error) {
      if (!(error instanceof KubernetesError && error.status === 404) || !storage.managed || !create || !!storage.uid) throw error;
      try { pvc = await this.request('POST', path, pvcManifest(environment, userId), signal); }
      catch (race) { if (!(race instanceof KubernetesError && race.status === 409)) throw race; pvc = await this.request('GET', `${path}/${podName(storage.name!)}`, undefined, signal); }
    }
    const labels = pvc.metadata?.labels;
    if (!pvc.metadata?.uid || (labels?.['nexus.owner'] && labels['nexus.owner'] !== userId) || (storage.managed && (labels?.['nexus.owner'] !== userId || labels?.['nexus.environment'] !== environment.id))) throw new KubernetesError('PVC 归属不匹配', 409);
    if (storage.uid && storage.uid !== pvc.metadata.uid) throw new KubernetesError('PVC 已被替换，请重新核对数据', 409);
    storage.uid = pvc.metadata.uid;
  }
  async deleteVolume(environment: WorkspaceEnvironment, userId: string): Promise<void> {
    const storage = environment.storage;
    if (!storage || storage.kind !== 'pvc' || !storage.managed) throw new KubernetesError('只能删除此实例创建的 PVC', 409);
    try { await this.ensurePvc(environment, userId, undefined, false); }
    catch (error) { if (error instanceof KubernetesError && error.status === 404) return; throw error; }
    await this.request('DELETE', `/api/v1/namespaces/${namespaceName(environment.config.namespace || this.connection.namespace)}/persistentvolumeclaims/${podName(storage.name!)}`, { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: storage.uid } });
  }
  async delete(environment: WorkspaceEnvironment, userId: string) {
    const namespace = environment.config.namespace || this.connection.namespace;
    let pod: Pod;
    try { pod = await this.inspect(namespace, environment.resourceId, userId, environment.resourceUid); }
    catch (error) { if (error instanceof KubernetesError && error.status === 404) return; throw error; }
    if (pod.metadata.labels?.['nexus.environment'] !== environment.id || pod.metadata.labels?.['nexus.owner'] !== userId) throw new KubernetesError('Pod 不属于此环境，不能删除', 409);
    await this.request('DELETE', `${this.base(namespace)}/${podName(environment.resourceId)}`, { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: pod.metadata.uid } });
  }
  async open(environment: WorkspaceEnvironment, userId: string, command: string[], signal?: AbortSignal, tty = false): Promise<AgentTransport> {
    if (signal?.aborted) throw new KubernetesError('Kubernetes 操作已取消');
    const namespace = environment.config.namespace || this.connection.namespace;
    const pod = await this.inspect(namespace, environment.resourceId, userId, environment.resourceUid, signal);
    if (pod.status?.phase !== 'Running') throw new KubernetesError('Pod 当前未运行', 409);
    const url = new URL(`${this.base(namespace)}/${podName(environment.resourceId)}/exec`, this.connection.server);
    url.protocol = 'wss:';
    url.searchParams.set('container', pod.spec?.containers?.[0]?.name || 'workspace');
    url.searchParams.set('stdin', 'true'); url.searchParams.set('stdout', 'true'); url.searchParams.set('stderr', tty ? 'false' : 'true'); url.searchParams.set('tty', String(tty));
    for (const argument of command) url.searchParams.append('command', argument);
    const socket = new WebSocket(url, ['v5.channel.k8s.io'], { ...this.options(), handshakeTimeout: 12000, maxPayload: 2 * 1024 * 1024, followRedirects: false });
    const stdout = new PassThrough(), stderr = new PassThrough();
    let code: number | null = null, finished = false;
    let resolveClosed!: (value: { code: number | null; signal?: string }) => void;
    const closed = new Promise<{ code: number | null; signal?: string }>((resolve) => { resolveClosed = resolve; });
    const close = () => { socket.terminate(); };
    const finish = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', close);
      stdout.end(); stderr.end();
      resolveClosed({ code, ...(signal?.aborted ? { signal: 'abort' } : {}) });
    };
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (socket.readyState !== WebSocket.OPEN) return callback(new Error('Kubernetes exec 已断开'));
        if (socket.bufferedAmount > 2 * 1024 * 1024) { close(); return callback(new Error('Kubernetes exec 输入积压')); }
        socket.send(Buffer.concat([Buffer.from([0]), Buffer.from(chunk)]), callback);
      },
      final(callback) {
        if (socket.readyState === WebSocket.OPEN) socket.send(Buffer.from([255, 0]), callback);
        else callback();
      },
    });
    stdin.on('error', close);
    socket.on('message', (data) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (!bytes.length) return;
      const channel = bytes[0];
      if (channel === 1 || channel === 2) {
        const output = channel === 1 ? stdout : stderr;
        if (output.readableLength > 2 * 1024 * 1024) { close(); return; }
        output.write(bytes.subarray(1));
      } else if (channel === 3) {
        try {
          const status = JSON.parse(bytes.subarray(1).toString('utf8'));
          code = status.status === 'Success' ? 0 : Number(status.details?.causes?.find((cause: { reason?: string }) => cause.reason === 'ExitCode')?.message ?? 1);
          if (!Number.isSafeInteger(code)) code = 1;
        } catch { code = -1; }
      }
    });
    socket.on('error', () => { code ??= -1; finish(); });
    socket.on('close', finish);
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) close();
    await new Promise<void>((resolve, reject) => {
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new KubernetesError('Kubernetes exec 连接失败，需要 pods/exec 权限及 v5 WebSocket 支持（Kubernetes 1.29+）', 502)); };
      const cleanup = () => { socket.off('open', opened); socket.off('error', failed); socket.off('close', failed); };
      socket.once('open', opened); socket.once('error', failed); socket.once('close', failed);
    });
    return { stdin, stdout, stderr, closed, close };
  }
  async execute(environment: WorkspaceEnvironment, userId: string, command: string, input?: string, signal?: AbortSignal, timeoutMs = 12000): Promise<string> {
    const transport = await this.open(environment, userId, ['sh', '-c', command], signal);
    const out = new StringDecoder('utf8'), err = new StringDecoder('utf8');
    let stdout = '', stderr = '', size = 0, exceeded = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; transport.close(); }, timeoutMs);
    transport.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 262144) { exceeded = true; transport.close(); } else stdout += out.write(chunk); });
    transport.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + err.write(chunk)).slice(-2000); });
    transport.stdin.end(input);
    const result = await transport.closed;
    clearTimeout(timer);
    stdout += out.end(); stderr += err.end();
    if (timedOut || exceeded || result.code !== 0) throw new KubernetesError(timedOut ? 'Kubernetes 命令超时' : exceeded ? 'Kubernetes 命令输出过大' : stderr || 'Kubernetes 命令失败或连接中断', 502);
    return stdout;
  }
}
