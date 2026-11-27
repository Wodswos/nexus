import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface RevisionMeta {
  source: 'user' | 'api' | 'agent' | 'restore' | 'initial';
  agentId?: string;
  roundId?: string;
  restoredFrom?: string;
}
export interface TaskText { id: string; title: string; notes?: string }
export interface TaskRevision extends RevisionMeta {
  id: string;
  taskId: string;
  title: string;
  notes: string;
  createdAt: number;
  author: string;
}
export type RevisionSummary = Omit<TaskRevision, 'notes'> & { length: number };
const same = (a: Pick<TaskText, 'title' | 'notes'>, b: Pick<TaskText, 'title' | 'notes'>) => a.title === b.title && (a.notes ?? '') === (b.notes ?? '');

/** Immutable checkpoints, separate from Yjs undo and the latest sync snapshot. */
export class TaskRevisions {
  constructor(private sql: DatabaseSync) {
    sql.exec(`CREATE TABLE IF NOT EXISTS task_revisions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL, task_id TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL,
      source TEXT NOT NULL, agent_id TEXT, round_id TEXT, restored_from TEXT, created_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS task_revision_order ON task_revisions(user_id,task_id,seq DESC);`);
  }
  private from(row: Record<string, unknown>): TaskRevision {
    return { id: String(row.id), taskId: String(row.task_id), title: String(row.title), notes: String(row.notes),
      source: row.source as RevisionMeta['source'], createdAt: Number(row.created_at), author: String(row.author ?? ''),
      ...(row.agent_id ? { agentId: String(row.agent_id) } : {}), ...(row.round_id ? { roundId: String(row.round_id) } : {}),
      ...(row.restored_from ? { restoredFrom: String(row.restored_from) } : {}) };
  }
  latest(userId: string, taskId: string): TaskRevision | null {
    const row = this.sql.prepare('SELECT r.*, u.username AS author FROM task_revisions r LEFT JOIN users u ON u.id=r.user_id WHERE r.user_id=? AND r.task_id=? ORDER BY r.seq DESC LIMIT 1').get(userId, taskId);
    return row ? this.from(row) : null;
  }
  get(userId: string, taskId: string, id: string): TaskRevision | null {
    const row = this.sql.prepare('SELECT r.*, u.username AS author FROM task_revisions r LEFT JOIN users u ON u.id=r.user_id WHERE r.user_id=? AND r.task_id=? AND r.id=?').get(userId, taskId, id);
    return row ? this.from(row) : null;
  }
  list(userId: string, taskId: string, offset = 0, limit = 50): { revisions: RevisionSummary[]; total: number } {
    const rows = this.sql.prepare('SELECT r.*, u.username AS author FROM task_revisions r LEFT JOIN users u ON u.id=r.user_id WHERE r.user_id=? AND r.task_id=? ORDER BY r.seq DESC LIMIT ? OFFSET ?').all(userId, taskId, limit, offset);
    const total = Number(this.sql.prepare('SELECT COUNT(*) AS n FROM task_revisions WHERE user_id=? AND task_id=?').get(userId, taskId)!.n);
    return { revisions: rows.map(row => { const { notes, ...value } = this.from(row); return { ...value, length: notes.length }; }), total };
  }
  record(userId: string, task: TaskText, meta: RevisionMeta = { source: 'initial' }): TaskRevision {
    const last = this.latest(userId, task.id);
    if (last && same(last, task)) return last;
    const id = randomUUID(), createdAt = Date.now();
    this.sql.prepare('INSERT INTO task_revisions(id,user_id,task_id,title,notes,source,agent_id,round_id,restored_from,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, userId, task.id, task.title, task.notes ?? '', meta.source, meta.agentId ?? null, meta.roundId ?? null, meta.restoredFrom ?? null, createdAt);
    return this.get(userId, task.id, id)!;
  }
  transition(userId: string, before: TaskText | undefined, after: TaskText, meta: RevisionMeta): void {
    if (before && same(before, after)) return;
    if (before) this.record(userId, before);
    this.record(userId, after, meta);
  }
}
