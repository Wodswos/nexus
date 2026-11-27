import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DB } from '../src/db';
import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import WebSocket from 'ws';

let child: ChildProcess, dir: string, base: string, adminCookie: string;
async function request(path: string, data?: unknown, cookie = '') {
  return fetch(base + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
async function invite() {
  const response = await request('/api/invites', {}, adminCookie);
  expect(response.status).toBe(200);
  return (await response.json() as { code: string }).code;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-accounts-'));
  const require = createRequire(import.meta.url);
  child = spawn(process.execPath, ['--import', require.resolve('tsx/esm'), fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
    env: { ...process.env, PORT: '0', NODE_ENV: 'test', COOKIE_SECURE: 'false', PUBLIC_ORIGIN: '', DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr!.on('data', (bytes) => { diagnostics += bytes.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup failed: ${diagnostics}`)), 10000);
    child.stdout!.on('data', (bytes) => {
      const match = /Nexus server on :(\d+)/.exec(bytes.toString());
      if (match) { base = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); resolve(); }
    });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Server exited: ${diagnostics}`)); });
  });
  const response = await request('/api/auth/register', { username: 'admin', password: 'fixture-password' });
  expect(response.status).toBe(200);
  adminCookie = response.headers.get('set-cookie')!.split(';')[0]!;
}, 15000);

afterAll(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

class Browser {
  cookies = new Map<string, string>();
  async request(path: string, data?: unknown, options: { method?: string; headers?: Record<string,string> } = {}) {
    const response = await fetch(base + path, {
      method: options.method ?? (data === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', Cookie: [...this.cookies].map(([k,v])=>`${k}=${v}`).join('; '), ...options.headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'); const [key, value] = pair!.split('=');
      if (value) this.cookies.set(key!, value); else this.cookies.delete(key!);
      expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Lax');
    }
    return response;
  }
  async accounts() { const res = await this.request('/api/auth/accounts'); expect(res.status).toBe(200); return (await res.json() as {accounts:{id:string}[]}).accounts.map(a=>a.id); }
}

describe('saved browser accounts', () => {
  it('bounds saved accounts, hashes device credentials and never extends expiry by switching', () => {
    const location = mkdtempSync(join(tmpdir(), 'nexus-grants-'));
    const db = new DB(location);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const ids = Array.from({ length: 11 }, (_, i) => db.createUser(`grant-${i}`, 'hash', 'salt', false).id);
      let login = db.browserLogins.activate(ids[0]!, undefined, undefined, true)!;
      const expiry = login.expiresAt;
      for (const id of ids.slice(1, 10)) login = db.browserLogins.activate(id, login.device, login.token, true)!;
      expect(() => db.browserLogins.activate(ids[10]!, login.device, login.token, true)).toThrow('最多保存 10');
      expect(db.getSession(login.token)).not.toBeNull();
      clock.mockReturnValue(now + 86400_000);
      login = db.browserLogins.activate(ids[0]!, login.device, login.token, false)!;
      expect(login.expiresAt).toBe(expiry);
      const inspection = new DatabaseSync(join(location, 'cortex.db'), { readOnly: true });
      try {
        const stored = inspection.prepare('SELECT device_hash FROM browser_logins').all();
        expect(stored).toHaveLength(10);
        expect(stored.every(row => row.device_hash !== login.device && String(row.device_hash).length === 64)).toBe(true);
      } finally { inspection.close(); }
      clock.mockReturnValue(expiry + 1);
      expect(db.browserLogins.list(login.device)).toEqual([]);
      expect(db.browserLogins.activate(ids[0]!, login.device, login.token, false)).toBeNull();
      expect(db.getSession(login.token)).toBeNull();
    } finally { clock.mockRestore(); db.close(); rmSync(location, { recursive: true, force: true }); }
  });
  it('isolates grants, revokes old transports, preserves other devices and removes logout grants', async () => {
    const browser = new Browser(), other = new Browser(), foreign = new Browser();
    // Upgrade an existing login that has no saved-account cookie.
    browser.cookies.set('cortex_session', adminCookie.split('=')[1]!);
    const admin = await (await browser.request('/api/auth/me')).json() as {id:string};
    const second = await (await other.request('/api/auth/register', {username:'second',password:'fixture-password',inviteCode:await invite()})).json() as {id:string};
    const third = await (await foreign.request('/api/auth/register', {username:'third',password:'fixture-password',inviteCode:await invite()})).json() as {id:string};
    expect(await browser.accounts()).toEqual([admin.id]);
    expect(await other.accounts()).toEqual([second.id]);
    const ticket = await (await browser.request(`/api/auth/ticket?userId=${admin.id}`)).json() as {ticket:string};
    const unused = await (await browser.request(`/api/auth/ticket?userId=${admin.id}`)).json() as {ticket:string};
    const ws = new WebSocket(base.replace('http:', 'ws:') + `/api/sync?ticket=${ticket.ticket}`);
    await once(ws,'open');
    const closed = once(ws,'close');
    expect((await browser.request('/api/auth/login', {username:'second',password:'wrong-password'})).status).toBe(401);
    expect((await browser.request('/api/auth/me')).status).toBe(200);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const signedIn = await browser.request('/api/auth/login',{username:'second',password:'fixture-password'});
    expect(signedIn.status).toBe(200); await closed;
    expect(new Set(await browser.accounts())).toEqual(new Set([admin.id,second.id]));
    expect((await request('/api/auth/me',undefined,adminCookie)).status).toBe(401);
    const staleTicket = await new Promise<number>(resolve => {
      const socket = new WebSocket(base.replace('http:', 'ws:') + `/api/sync?ticket=${unused.ticket}`);
      socket.on('unexpected-response',(_, response)=>{resolve(response.statusCode!);response.resume();socket.terminate();}); socket.on('error',()=>{});
    });
    expect(staleTicket).toBe(401);
    expect((await browser.request('/api/servers',undefined,{headers:{'X-Cortex-User':admin.id}})).status).toBe(409);
    expect((await other.request('/api/auth/me')).status).toBe(200);
    expect((await browser.request('/api/auth/switch',{userId:third.id})).status).toBe(401);
    expect((await foreign.request('/api/auth/switch',{userId:admin.id})).status).toBe(401);
    const back = await browser.request('/api/auth/switch',{userId:admin.id});
    expect(back.status).toBe(200); expect(await back.json()).toMatchObject({id:admin.id});
    expect((await browser.request('/api/auth/switch',{userId:second.id},{headers:{Origin:'https://evil.example'}})).status).toBe(403);
    expect((await browser.request('/api/auth/accounts/'+second.id,undefined,{method:'DELETE'})).status).toBe(200);
    expect((await browser.request('/api/auth/switch',{userId:second.id})).status).toBe(401);
    expect((await other.request('/api/auth/me')).status).toBe(200);
    expect((await browser.request('/api/auth/login',{username:'second',password:'fixture-password'})).status).toBe(200);
    expect((await browser.request('/api/auth/logout',{})).status).toBe(200);
    expect(await browser.accounts()).toEqual([admin.id]);
    expect((await browser.request('/api/auth/switch',{userId:second.id})).status).toBe(401);
    expect((await browser.request('/api/auth/switch',{userId:admin.id})).status).toBe(200);
    const savedCookie = browser.cookies.get('nexus_accounts')!;
    expect((await browser.request('/api/auth/logout-all',{})).status).toBe(200);
    expect(browser.cookies.size).toBe(0);
    browser.cookies.set('nexus_accounts',savedCookie);
    expect(await browser.accounts()).toEqual([]);
    expect((await browser.request('/api/auth/switch',{userId:admin.id})).status).toBe(401);
    expect((await other.request('/api/auth/me')).status).toBe(200);
  },15000);
});
