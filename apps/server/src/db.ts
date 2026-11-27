import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { TaskRevisions } from './taskRevisions';
import { BrowserLogins } from './browserLogins';
import { AgentStore } from './agents/store';

export interface ApiTokenRow { id: string; user_id: string; name: string; token_hash: string; permission: 'read' | 'write'; created_at: number; expires_at: number }
export interface ApiRequestRow { fingerprint: string; status: number; response: string }
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * SQLite 存储:账号 / 会话 / 邀请码 / Yjs 文档快照。
 * node:sqlite 零原生依赖(node ≥ 22.5),Docker alpine 免编译。
 */
export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  salt: string;
  is_admin: number;
  created_at: number;
}

export interface InviteRow {
  code: string;
  created_by: string;
  used_by: string | null;
  revoked: number;
  created_at: number;
}

export interface SessionRow {
  token: string;
  user_id: string;
  expires_at: number;
}

export interface ServerRow {
  id: string;
  user_id: string;
  name: string;
  host: string;
  password_cipher: string | null;
  agent_proxy?: string | null;
}

export class DB {
  private db: DatabaseSync;
  private transactionActive=false;
  get inTransaction(){return this.transactionActive;}
  readonly taskRevisions: TaskRevisions;
  readonly browserLogins: BrowserLogins;
  readonly agentRuntime: AgentStore;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'cortex.db'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY,
        created_by TEXT NOT NULL,
        used_by TEXT,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS docs (
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        snapshot BLOB,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, name)
      );
      CREATE TABLE IF NOT EXISTS servers (
        user_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        password_cipher TEXT,
        PRIMARY KEY (user_id, id)
      );
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL, permission TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id);
      CREATE TABLE IF NOT EXISTS api_requests (
        user_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        status INTEGER NOT NULL, response TEXT NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, request_key)
      );
      CREATE TABLE IF NOT EXISTS workspace_records (
        user_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
        request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
        payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, kind, id), UNIQUE(user_id, kind, request_key)
      );
      CREATE INDEX IF NOT EXISTS workspace_queue ON workspace_records(state, updated_at);
      CREATE TABLE IF NOT EXISTS workspace_launches (
        user_id TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL,
        payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS agents (
        user_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL,
        state TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id,id)
      );
      CREATE INDEX IF NOT EXISTS agents_task ON agents(user_id,task_id,updated_at);
      CREATE TABLE IF NOT EXISTS agent_rounds (
        user_id TEXT NOT NULL, id TEXT NOT NULL, agent_id TEXT NOT NULL,
        task_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id,id)
      );
      CREATE INDEX IF NOT EXISTS agent_rounds_agent ON agent_rounds(user_id,agent_id,created_at);
      CREATE TABLE IF NOT EXISTS agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        payload TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_events_cursor ON agent_events(user_id,agent_id,id);
      CREATE TABLE IF NOT EXISTS agent_messages (
        user_id TEXT NOT NULL, agent_id TEXT NOT NULL, id TEXT NOT NULL,
        state TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id,agent_id,id)
      );
      CREATE TABLE IF NOT EXISTS agent_requests (
        user_id TEXT NOT NULL, scope TEXT NOT NULL, request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id,scope,request_id)
      );
      CREATE TABLE IF NOT EXISTS agent_tokens (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_reports (
        user_id TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT NOT NULL,
        id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id,agent_id,id)
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(servers)').all().some(column => column.name === 'agent_proxy'))
      this.db.exec('ALTER TABLE servers ADD COLUMN agent_proxy TEXT');
    this.taskRevisions = new TaskRevisions(this.db);
    this.browserLogins = new BrowserLogins(this.db);
    this.agentRuntime = new AgentStore(this.db);
  }

  workspaceLaunch<T>(userId: string, requestId: string): T | null {
    const row = this.db.prepare('SELECT payload FROM workspace_launches WHERE user_id=? AND request_id=?').get(userId, requestId);
    return row ? JSON.parse(String(row.payload)) as T : null;
  }
  saveWorkspaceLaunch(userId: string, value: { requestId: string; state: string }): void {
    this.db.prepare(`INSERT INTO workspace_launches(user_id,request_id,state,payload,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id,request_id) DO UPDATE SET state=excluded.state,payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(userId, value.requestId, value.state, JSON.stringify(value), Date.now());
  }
  pendingWorkspaceLaunches<T>(): { userId: string; value: T }[] {
    return this.db.prepare("SELECT user_id,payload FROM workspace_launches WHERE state='pending' ORDER BY updated_at LIMIT 100").all()
      .map(row => ({ userId: String(row.user_id), value: JSON.parse(String(row.payload)) as T }));
  }

  // users
  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }
  getUserByUsername(username: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as unknown as UserRow) ?? null;
  }
  getUser(id: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow) ?? null;
  }
  createUser(username: string, passwordHash: string, salt: string, isAdmin: boolean): UserRow {
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO users (id, username, password_hash, salt, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, username, passwordHash, salt, isAdmin ? 1 : 0, Date.now());
    return this.getUser(id)!;
  }

  registerUser(username: string, hash: string, salt: string, inviteCode?: string): UserRow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.getUserByUsername(username)) throw new Error('用户名已存在');
      const first = this.countUsers() === 0;
      if (!first) {
        const invite = inviteCode ? this.getInvite(inviteCode) : null;
        if (!invite || invite.revoked || invite.used_by) throw new Error('邀请码无效');
      }
      const user = this.createUser(username, hash, salt, first);
      if (!first) this.markInviteUsed(inviteCode!, user.id);
      this.db.exec('COMMIT');
      return user;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listServers(userId: string): ServerRow[] {
    return this.db.prepare('SELECT * FROM servers WHERE user_id = ? ORDER BY name, id').all(userId) as unknown as ServerRow[];
  }
  getServer(userId: string, id: string): ServerRow | null {
    return this.db.prepare('SELECT * FROM servers WHERE user_id = ? AND id = ?').get(userId, id) as unknown as ServerRow ?? null;
  }
  saveServer(server: ServerRow): void {
    this.db.prepare(`INSERT INTO servers (user_id, id, name, host, password_cipher, agent_proxy) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET name=excluded.name, host=excluded.host, password_cipher=excluded.password_cipher, agent_proxy=excluded.agent_proxy`)
      .run(server.user_id, server.id, server.name, server.host, server.password_cipher, server.agent_proxy === undefined ? this.getServer(server.user_id, server.id)?.agent_proxy ?? null : server.agent_proxy);
  }
  deleteServer(userId: string, id: string): void {
    this.db.prepare('DELETE FROM servers WHERE user_id = ? AND id = ?').run(userId, id);
  }
  close(): void { this.db.close(); }

  agentRecord<T>(userId: string, id: string): T | null {
    const row = this.db.prepare('SELECT payload FROM agents WHERE user_id=? AND id=?').get(userId, id);
    return row ? JSON.parse(String(row.payload)) as T : null;
  }
  agentRound<T>(userId: string, id: string): T | null {
    const row = this.db.prepare('SELECT payload FROM agent_rounds WHERE user_id=? AND id=?').get(userId,id);
    return row ? JSON.parse(String(row.payload)) as T : null;
  }
  agentRounds<T>(userId: string, agentId?: string): T[] {
    return (agentId
      ? this.db.prepare('SELECT payload FROM agent_rounds WHERE user_id=? AND agent_id=? ORDER BY created_at,rowid').all(userId,agentId)
      : this.db.prepare('SELECT payload FROM agent_rounds WHERE user_id=? ORDER BY updated_at DESC LIMIT 10000').all(userId))
      .map(row=>JSON.parse(String(row.payload)) as T);
  }
  saveAgentRound(userId: string, value: {id:string;agentId:string;taskId:string;state:string;createdAt:number;updatedAt:number}): void {
    this.db.prepare(`INSERT INTO agent_rounds(user_id,id,agent_id,task_id,state,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,id) DO UPDATE SET state=excluded.state,payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(userId,value.id,value.agentId,value.taskId,value.state,JSON.stringify(value),value.createdAt,value.updatedAt);
  }
  agentRecords<T>(userId: string, taskId?: string): T[] {
    return (taskId
      ? this.db.prepare('SELECT payload FROM agents WHERE user_id=? AND task_id=? ORDER BY updated_at DESC LIMIT 1000').all(userId, taskId)
      : this.db.prepare('SELECT payload FROM agents WHERE user_id=? ORDER BY updated_at DESC LIMIT 1000').all(userId))
      .map(row => JSON.parse(String(row.payload)) as T);
  }
  allAgentRecords<T>(): {userId: string; agent: T}[] {
    return this.db.prepare("SELECT user_id,payload FROM agents WHERE state NOT IN ('stopped','failed')").all()
      .map(row => ({ userId: String(row.user_id), agent: JSON.parse(String(row.payload)) as T }));
  }
  saveAgentRecord(userId: string, value: {id: string; taskId: string; state: string; updatedAt: number}): void {
    this.db.prepare(`INSERT INTO agents(user_id,id,task_id,state,payload,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,id) DO UPDATE SET task_id=excluded.task_id,state=excluded.state,payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(userId, value.id, value.taskId, value.state, JSON.stringify(value), value.updatedAt);
  }
  appendAgentEvent<T extends {agentId: string; createdAt: number}>(userId: string, value: T): T & {id: number} {
    const result = this.db.prepare('INSERT INTO agent_events(user_id,agent_id,payload,created_at) VALUES(?,?,?,?)')
      .run(userId, value.agentId, JSON.stringify(value), value.createdAt);
    return { ...value, id: Number(result.lastInsertRowid) };
  }
  agentEvents<T>(userId: string, agentId: string, after: number, limit = 201): T[] {
    return this.db.prepare('SELECT id,payload FROM agent_events WHERE user_id=? AND agent_id=? AND id>? ORDER BY id LIMIT ?')
      .all(userId, agentId, after, limit).map(row => ({ ...JSON.parse(String(row.payload)), id: Number(row.id) }) as T);
  }
  agentEventUsage(userId: string, agentId: string): {count: number; bytes: number} {
    const row = this.db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM agent_events WHERE user_id=? AND agent_id=?').get(userId, agentId)!;
    return { count: Number(row.n), bytes: Number(row.bytes) };
  }
  claimExecutionIdentity(identity:string,owner:string):boolean {
    this.db.exec('CREATE TABLE IF NOT EXISTS execution_identities (identity TEXT PRIMARY KEY, owner TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO execution_identities(identity,owner) VALUES(?,?)').run(identity,owner);
    return this.db.prepare('SELECT owner FROM execution_identities WHERE identity=?').get(identity)?.owner===owner;
  }
  agentEventBounds(userId:string,agentId:string):{first:number;last:number} {
    const row=this.db.prepare('SELECT MIN(id) AS first,MAX(id) AS last FROM agent_events WHERE user_id=? AND agent_id=?').get(userId,agentId)!;
    return {first:Number(row.first??0),last:Number(row.last??0)};
  }
  trimAgentEvents(userId:string,agentId:string,keep:number):void {
    this.db.prepare('DELETE FROM agent_events WHERE user_id=? AND agent_id=? AND id NOT IN (SELECT id FROM agent_events WHERE user_id=? AND agent_id=? ORDER BY id DESC LIMIT ?)').run(userId,agentId,userId,agentId,keep);
  }
  agentMessages<T>(userId: string, agentId: string): T[] {
    return this.db.prepare('SELECT payload FROM agent_messages WHERE user_id=? AND agent_id=? ORDER BY created_at,rowid')
      .all(userId, agentId).map(row => JSON.parse(String(row.payload)) as T);
  }
  saveAgentMessage(userId: string, value: {id: string; agentId: string; state: string; createdAt: number}): void {
    this.db.prepare(`INSERT INTO agent_messages(user_id,agent_id,id,state,payload,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,agent_id,id) DO UPDATE SET state=excluded.state,payload=excluded.payload`)
      .run(userId, value.agentId, value.id, value.state, JSON.stringify(value), value.createdAt);
  }
  agentRequest<T>(userId: string, scope: string, requestId: string): {fingerprint: string; value: T} | null {
    const row = this.db.prepare('SELECT fingerprint,payload FROM agent_requests WHERE user_id=? AND scope=? AND request_id=?').get(userId, scope, requestId);
    return row ? { fingerprint: String(row.fingerprint), value: JSON.parse(String(row.payload)) as T } : null;
  }
  rememberAgentRequest(userId: string, scope: string, requestId: string, fingerprint: string, value: unknown): void {
    this.db.prepare('INSERT INTO agent_requests(user_id,scope,request_id,fingerprint,payload,created_at) VALUES(?,?,?,?,?,?)')
      .run(userId, scope, requestId, fingerprint, JSON.stringify(value), Date.now());
  }
  createAgentToken(userId: string, agentId: string): string {
    this.revokeAgentTokens(userId, agentId);
    const token = `nxa_${randomBytes(32).toString('hex')}`;
    this.db.prepare('INSERT INTO agent_tokens(token_hash,user_id,agent_id,expires_at) VALUES(?,?,?,?)')
      .run(tokenHash(token), userId, agentId, Date.now() + 7 * 86400000);
    return token;
  }
  findAgentToken(token: string): {userId: string; agentId: string} | null {
    const row = this.db.prepare('SELECT user_id,agent_id FROM agent_tokens WHERE token_hash=? AND expires_at>?').get(tokenHash(token), Date.now());
    return row ? { userId: String(row.user_id), agentId: String(row.agent_id) } : null;
  }
  hasAgentToken(userId: string, agentId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM agent_tokens WHERE user_id=? AND agent_id=? AND expires_at>? LIMIT 1').get(userId, agentId, Date.now());
  }
  renewAgentToken(token: string): void {
    const now = Date.now();
    // Seven days of inactivity, with at most one renewal per six days. Never
    // recreate a revoked/expired credential or store the plaintext credential.
    this.db.prepare('UPDATE agent_tokens SET expires_at=? WHERE token_hash=? AND expires_at>? AND expires_at<?')
      .run(now + 7 * 86400000, tokenHash(token), now, now + 86400000);
  }
  revokeAgentTokens(userId: string, agentId: string): void {
    this.db.prepare('DELETE FROM agent_tokens WHERE user_id=? AND agent_id=?').run(userId, agentId);
  }
  saveAgentReport(userId: string, value: {id: string; agentId: string; taskId: string; createdAt: number}): void {
    this.db.prepare('INSERT INTO agent_reports(user_id,agent_id,task_id,id,payload,created_at) VALUES(?,?,?,?,?,?)')
      .run(userId, value.agentId, value.taskId, value.id, JSON.stringify(value), value.createdAt);
  }
  agentReports<T>(userId: string, taskId: string): T[] {
    return this.db.prepare('SELECT payload FROM agent_reports WHERE user_id=? AND task_id=? ORDER BY created_at,id')
      .all(userId, taskId).map(row => JSON.parse(String(row.payload)) as T);
  }

  workspaceRecords<T>(userId: string, kind: 'environment' | 'instruction'): T[] {
    return this.db.prepare('SELECT payload FROM workspace_records WHERE user_id=? AND kind=? ORDER BY updated_at DESC LIMIT 500')
      .all(userId, kind).map(row => JSON.parse(String(row.payload)) as T);
  }
  pendingWorkspaceCount(userId: string, kind: 'environment' | 'instruction'): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM workspace_records WHERE user_id=? AND kind=? AND state IN ('queued','preparing','sending')").get(userId, kind)!.n);
  }
  workspaceRecord<T>(userId: string, kind: 'environment' | 'instruction', id: string): T | null {
    const row = this.db.prepare('SELECT payload FROM workspace_records WHERE user_id=? AND kind=? AND id=?').get(userId, kind, id);
    return row ? JSON.parse(String(row.payload)) as T : null;
  }
  workspaceRequest<T>(userId: string, kind: 'environment' | 'instruction', key: string): { fingerprint: string; value: T } | null {
    const row = this.db.prepare('SELECT fingerprint,payload FROM workspace_records WHERE user_id=? AND kind=? AND request_key=?').get(userId, kind, key);
    return row ? { fingerprint: String(row.fingerprint), value: JSON.parse(String(row.payload)) as T } : null;
  }
  saveWorkspaceRecord(userId: string, kind: 'environment' | 'instruction', value: { id: string; state: string; updatedAt: number }, requestKey?: string, fingerprint?: string): void {
    if (requestKey !== undefined && fingerprint !== undefined) {
      this.db.prepare('INSERT INTO workspace_records(user_id,kind,id,request_key,fingerprint,state,payload,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(userId, kind, value.id, requestKey, fingerprint, value.state, JSON.stringify(value), value.updatedAt);
    } else {
      this.db.prepare('UPDATE workspace_records SET state=?,payload=?,updated_at=? WHERE user_id=? AND kind=? AND id=?')
        .run(value.state, JSON.stringify(value), value.updatedAt, userId, kind, value.id);
    }
  }
  recoverWorkspaceRecords(): void {
    const rows = this.db.prepare("SELECT user_id,kind,id,payload FROM workspace_records WHERE state IN ('preparing','sending')").all();
    for (const row of rows) {
      const value = JSON.parse(String(row.payload));
      Object.assign(value, { state: 'unknown', updatedAt: Date.now(), error: '服务重启，请核对远端现场后再继续' });
      this.saveWorkspaceRecord(String(row.user_id), row.kind as 'environment' | 'instruction', value);
    }
  }
  queuedWorkspaces(): { userId: string; kind: 'environment' | 'instruction'; id: string }[] {
    return this.db.prepare("SELECT user_id,kind,id FROM workspace_records WHERE state='queued' ORDER BY updated_at LIMIT 100")
      .all().map(row => ({ userId: String(row.user_id), kind: row.kind as 'environment' | 'instruction', id: String(row.id) }));
  }

  transaction<T>(operation: () => T): T {
    if(this.transactionActive)throw new Error('Nested database transaction');
    this.db.exec('BEGIN IMMEDIATE');this.transactionActive=true;
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally {this.transactionActive=false;}
  }
  listApiTokens(userId: string): ApiTokenRow[] {
    return this.db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, id').all(userId) as unknown as ApiTokenRow[];
  }
  createApiToken(userId: string, name: string, permission: 'read' | 'write', days: number): { row: ApiTokenRow; token: string } {
    const token = `ctx_${randomBytes(32).toString('hex')}`;
    const row: ApiTokenRow = { id: crypto.randomUUID(), user_id: userId, name, permission, token_hash: tokenHash(token), created_at: Date.now(), expires_at: Date.now() + days * 86400000 };
    this.db.prepare('INSERT INTO api_tokens (id,user_id,name,token_hash,permission,created_at,expires_at) VALUES (?,?,?,?,?,?,?)').run(row.id, row.user_id, row.name, row.token_hash, row.permission, row.created_at, row.expires_at);
    return { row, token };
  }
  findApiToken(token: string): ApiTokenRow | null {
    return this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ? AND expires_at > ?').get(tokenHash(token), Date.now()) as unknown as ApiTokenRow ?? null;
  }
  revokeApiToken(userId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM api_tokens WHERE user_id = ? AND id = ?').run(userId, id).changes) > 0;
  }
  apiRequest(userId: string, key: string): ApiRequestRow | null {
    return this.db.prepare('SELECT fingerprint,status,response FROM api_requests WHERE user_id = ? AND request_key = ? AND expires_at > ?').get(userId, key, Date.now()) as unknown as ApiRequestRow ?? null;
  }
  rememberApiRequest(userId: string, key: string, fingerprint: string, status: number, response: string): void {
    this.db.prepare('DELETE FROM api_requests WHERE expires_at <= ?').run(Date.now());
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM api_requests WHERE user_id = ?').get(userId) as { n: number };
    if (count.n >= 1000) throw new Error('幂等记录已达上限，请稍后重试');
    this.db.prepare('INSERT OR REPLACE INTO api_requests (user_id,request_key,fingerprint,status,response,expires_at) VALUES (?,?,?,?,?,?)').run(userId, key, fingerprint, status, response, Date.now() + 86400000);
  }

  // sessions
  createSession(userId: string, ttlMs = 180 * 86400_000): string {
    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    this.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, Date.now() + ttlMs);
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    return token;
  }
  getSession(token: string): SessionRow | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as SessionRow | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    return row;
  }
  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  // invites
  createInvite(createdBy: string): InviteRow {
    const code = crypto.randomUUID().replace(/-/g, '');
    this.db.prepare('INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)').run(code, createdBy, Date.now());
    return this.getInvite(code)!;
  }
  getInvite(code: string): InviteRow | null {
    return (this.db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as unknown as InviteRow) ?? null;
  }
  listInvites(): InviteRow[] {
    return this.db.prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT 50').all() as unknown as InviteRow[];
  }
  markInviteUsed(code: string, userId: string): void {
    this.db.prepare('UPDATE invites SET used_by = ? WHERE code = ?').run(userId, code);
  }
  revokeInvite(code: string): void {
    this.db.prepare('UPDATE invites SET revoked = 1 WHERE code = ?').run(code);
  }

  // docs
  loadDocSnapshot(userId: string, name: string): Uint8Array | null {
    const row = this.db.prepare('SELECT snapshot FROM docs WHERE user_id = ? AND name = ?').get(userId, name) as { snapshot: Uint8Array | null } | undefined;
    return row?.snapshot ?? null;
  }
  saveDocSnapshot(userId: string, name: string, snapshot: Uint8Array): void {
    this.db
      .prepare(
        `INSERT INTO docs (user_id, name, snapshot, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, name) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
      )
      .run(userId, name, snapshot, Date.now());
  }
}
