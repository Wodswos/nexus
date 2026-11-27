import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';

const TTL = 180 * 86400_000;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export class SavedAccountLimitError extends Error {
  constructor() { super('本设备最多保存 10 个账号，请先退出不再使用的账号'); }
}
export class BrowserLogins {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS browser_logins (
      device_hash TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY(device_hash,user_id));
      CREATE TABLE IF NOT EXISTS browser_sessions (
      session_token TEXT PRIMARY KEY, device_hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS browser_sessions_device ON browser_sessions(device_hash);`);
  }
  list(device?: string) {
    if (!device) return [];
    return this.db.prepare(`SELECT u.id,u.username,u.is_admin,l.expires_at FROM browser_logins l
      JOIN users u ON u.id=l.user_id WHERE l.device_hash=? AND l.expires_at>? ORDER BY u.username,u.id`)
      .all(digest(device), Date.now()) as unknown as { id: string; username: string; is_admin: number; expires_at: number }[];
  }
  checkCapacity(device: string | undefined, previousToken: string | undefined, userId?: string) {
    const identities = new Set(this.list(device).map(user => user.id));
    const previous = previousToken ? this.db.prepare('SELECT user_id FROM sessions WHERE token=? AND expires_at>?').get(previousToken, Date.now()) : undefined;
    if (previous) identities.add(String(previous.user_id));
    if (userId) identities.add(userId);
    if (identities.size + (userId ? 0 : 1) > 10) throw new SavedAccountLimitError();
  }
  /** Only password authentication may add a grant. An existing valid session can be adopted. */
  activate(userId: string, device: string | undefined, previousToken: string | undefined, authenticated: boolean) {
    const now = Date.now();
    const saved = this.list(device);
    if (!authenticated && !saved.some(user => user.id === userId)) return null;
    const key = device && saved.length ? device : randomBytes(32).toString('hex');
    const hash = digest(key);
    const previous = previousToken ? this.db.prepare('SELECT user_id,expires_at FROM sessions WHERE token=? AND expires_at>?').get(previousToken, now) : undefined;
    if (authenticated) this.checkCapacity(device, previousToken, userId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM browser_logins WHERE expires_at<=?').run(now);
      if (authenticated) {
        if (previous) this.db.prepare(`INSERT OR IGNORE INTO browser_logins VALUES(?,?,?)`).run(hash, String(previous.user_id), Number(previous.expires_at));
        this.db.prepare('INSERT OR REPLACE INTO browser_logins VALUES(?,?,?)').run(hash, userId, now + TTL);
      }
      const revoked = this.revokeSessions(hash, previousToken);
      const token = randomBytes(32).toString('hex');
      const grant = this.db.prepare('SELECT expires_at FROM browser_logins WHERE device_hash=? AND user_id=?').get(hash, userId)!;
      const expiresAt = Number(grant.expires_at);
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, userId, expiresAt);
      this.db.prepare('INSERT INTO browser_sessions VALUES(?,?)').run(token, hash);
      this.db.prepare('DELETE FROM browser_sessions WHERE session_token NOT IN (SELECT token FROM sessions)').run();
      this.db.exec('COMMIT');
      return { token, device: key, revoked, expiresAt };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private revokeSessions(hash: string, extra?: string) {
    const tokens = this.db.prepare('SELECT session_token FROM browser_sessions WHERE device_hash=?').all(hash).map(row => String(row.session_token));
    if (extra && !tokens.includes(extra)) tokens.push(extra);
    for (const token of tokens) {
      this.db.prepare('DELETE FROM sessions WHERE token=?').run(token);
      this.db.prepare('DELETE FROM browser_sessions WHERE session_token=?').run(token);
    }
    return tokens;
  }
  forget(device: string | undefined, userId: string | null, activeToken?: string, all = false) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const revoked: string[] = [];
      if (device) {
        const hash = digest(device);
        if (all) this.db.prepare('DELETE FROM browser_logins WHERE device_hash=?').run(hash);
        else this.db.prepare('DELETE FROM browser_logins WHERE device_hash=? AND user_id=?').run(hash, userId);
        const sessions = this.db.prepare(`SELECT s.token FROM sessions s JOIN browser_sessions b ON b.session_token=s.token
          WHERE b.device_hash=? AND (? OR s.user_id=?)`).all(hash, all ? 1 : 0, userId);
        for (const row of sessions) revoked.push(String(row.token));
      }
      if (activeToken && !revoked.includes(activeToken)) revoked.push(activeToken);
      for (const token of revoked) {
        this.db.prepare('DELETE FROM sessions WHERE token=?').run(token);
        this.db.prepare('DELETE FROM browser_sessions WHERE session_token=?').run(token);
      }
      this.db.exec('COMMIT');
      return revoked;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
