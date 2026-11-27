import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import type { Context, Hono } from 'hono';
import { RateLimit } from '../security';

export interface KubernetesConnection {
  id: string;
  name: string;
  server: string;
  namespace: string;
  ca: string;
  token: string;
  cert: string;
  key: string;
  createdAt: number;
  updatedAt: number;
}
export type PublicKubernetesConnection = Omit<KubernetesConnection, 'token' | 'cert' | 'key'> & { tokenSet: boolean; certificateSet: boolean };
export class KubernetesError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 502 = 400) { super(message); }
}
const publicConnection = ({ token, cert, key, ...connection }: KubernetesConnection): PublicKubernetesConnection => ({ ...connection, tokenSet: !!token, certificateSet: !!(cert && key) });
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new KubernetesError('Kubernetes 连接 ID 无效');
  return value;
};

/** Account files contain authenticated ciphertext. Neither credentials nor private keys enter Yjs. */
export class KubernetesConnections {
  private readonly dir: string;
  private readonly encryptionKey: Buffer;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'kubernetes');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const keyPath = join(this.dir, '.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.encryptionKey = readFileSync(keyPath);
    if (this.encryptionKey.length !== 32) throw new Error('Kubernetes 凭据加密密钥损坏');
  }
  private path(userId: string) { return join(this.dir, `${createHash('sha256').update(userId).digest('hex')}.json`); }
  private read(userId: string): KubernetesConnection[] {
    const path = this.path(userId);
    if (!existsSync(path)) return [];
    const encrypted = Buffer.from(readFileSync(path, 'utf8'), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, encrypted.subarray(0, 12));
    decipher.setAAD(Buffer.from(userId));
    decipher.setAuthTag(encrypted.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8'));
  }
  private write(userId: string, connections: KubernetesConnection[]) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(userId));
    const content = Buffer.concat([cipher.update(JSON.stringify(connections)), cipher.final()]);
    const path = this.path(userId), temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(temporary, Buffer.concat([nonce, cipher.getAuthTag(), content]).toString('base64'), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  }
  list(userId: string) { return this.read(userId).map(publicConnection); }
  resolve(userId: string, id: string) { return this.read(userId).find((connection) => connection.id === id) ?? null; }
  save(userId: string, body: Record<string, unknown>, existingId?: string): PublicKubernetesConnection {
    const connections = this.read(userId);
    const id = existingId ? identifier(existingId) : body.id === undefined ? randomUUID() : identifier(body.id);
    const existing = connections.find((connection) => connection.id === id);
    if (existingId && !existing) throw new KubernetesError('Kubernetes 连接不存在', 404);
    if (!existingId && existing) throw new KubernetesError('Kubernetes 连接 ID 已存在', 409);
    if (!existing && connections.length >= 50) throw new KubernetesError('Kubernetes 连接数量已达到上限', 429);
    if (Object.keys(body).some((field) => !['id', 'name', 'server', 'namespace', 'ca', 'token', 'cert', 'key'].includes(field))) throw new KubernetesError('Kubernetes 连接字段无效');
    const get = (field: 'name' | 'server' | 'namespace' | 'ca' | 'token' | 'cert' | 'key', max = 32000) => {
      const value = body[field] === undefined ? existing?.[field] ?? '' : body[field] === null ? '' : body[field];
      if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new KubernetesError(`Kubernetes ${field} 无效`);
      return value.trim();
    };
    const name = get('name', 120), rawServer = get('server', 2048);
    let url: URL;
    try { url = new URL(rawServer); } catch { throw new KubernetesError('请填写有效的 Kubernetes HTTPS 地址'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new KubernetesError('Kubernetes 地址需要使用 HTTPS API Server 根地址');
    const namespace = get('namespace', 63) || 'default';
    if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace) || !name) throw new KubernetesError('请填写连接名称和有效的 Namespace');
    const ca = get('ca'), token = get('token'), cert = get('cert'), key = get('key');
    if ((!token && !(cert && key)) || (!!cert !== !!key) || /[\r\n]/.test(token)) throw new KubernetesError('请填写 Bearer Token 或成对的客户端证书与私钥');
    try { createSecureContext({ ...(ca ? { ca } : {}), ...(cert ? { cert, key } : {}) }); } catch { throw new KubernetesError('Kubernetes CA 或客户端证书格式无效'); }
    const value = { id, name, server: url.origin, namespace, ca, token, cert, key, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() };
    this.write(userId, [...connections.filter((connection) => connection.id !== id), value]);
    return publicConnection(value);
  }
  delete(userId: string, id: string) {
    const connections = this.read(userId);
    if (!connections.some((value) => value.id === identifier(id))) throw new KubernetesError('Kubernetes 连接不存在', 404);
    this.write(userId, connections.filter((value) => value.id !== id));
  }
}

export function setupKubernetesConnections(app: Hono, dataDir: string, currentUser: (context: Context) => string | null): KubernetesConnections {
  const connections = new KubernetesConnections(dataDir), limit = new RateLimit(60, 60000);
  const handle = (operation: (context: Context, userId: string) => unknown | Promise<unknown>) => async (context: Context) => {
    const userId = currentUser(context);
    if (!userId) return context.json({ error: '请先登录' }, 401);
    if (!limit.allow(userId)) return context.json({ error: '连接请求过多，请稍后重试' }, 429);
    try { return context.json({ data: await operation(context, userId) }); }
    catch (error) { return error instanceof KubernetesError ? context.json({ error: error.message }, error.status) : context.json({ error: 'Kubernetes 连接操作失败' }, 502); }
  };
  const body = async (context: Context): Promise<Record<string, unknown>> => {
    const value = await context.req.json().catch(() => null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KubernetesError('请求体需要使用 JSON 对象');
    return value;
  };
  app.get('/api/kubernetes-connections', handle((_, userId) => connections.list(userId)));
  app.post('/api/kubernetes-connections', handle(async (context, userId) => connections.save(userId, await body(context))));
  app.put('/api/kubernetes-connections/:id', handle(async (context, userId) => connections.save(userId, await body(context), context.req.param('id'))));
  app.delete('/api/kubernetes-connections/:id', handle((context, userId) => { connections.delete(userId, context.req.param('id')!); return { deleted: true }; }));
  return connections;
}
