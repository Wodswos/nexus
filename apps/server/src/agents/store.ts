import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentRun,
  AgentMessage,
  ConversationItem,
  ProviderInstance,
  NodeWorkspaceBinding,
} from "../../../../packages/core/src/index";

/** All primary keys include the owner. Callers compose writes in DB.transaction. */
export class AgentStore {
  constructor(private sql: DatabaseSync) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_runtime_records (
        owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner,kind,id));
      CREATE INDEX IF NOT EXISTS agent_runtime_by_agent ON agent_runtime_records(owner,kind,agent_id);
      CREATE TABLE IF NOT EXISTS agent_conversation (
        owner TEXT NOT NULL, agent_id TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(owner,agent_id,id));
      CREATE INDEX IF NOT EXISTS agent_conversation_order ON agent_conversation(owner,agent_id,sequence);
    `);
  }
  get<T>(owner: string, kind: string, id: string): T | null {
    const row = this.sql
      .prepare(
        "SELECT payload FROM agent_runtime_records WHERE owner=? AND kind=? AND id=?",
      )
      .get(owner, kind, id);
    return row ? (JSON.parse(String(row.payload)) as T) : null;
  }
  list<T>(owner: string, kind: string, agentId?: string): T[] {
    const rows =
      agentId === undefined
        ? this.sql
            .prepare(
              "SELECT payload FROM agent_runtime_records WHERE owner=? AND kind=? ORDER BY updated_at,id",
            )
            .all(owner, kind)
        : this.sql
            .prepare(
              "SELECT payload FROM agent_runtime_records WHERE owner=? AND kind=? AND agent_id=? ORDER BY updated_at,id",
            )
            .all(owner, kind, agentId);
    return rows.map((row) => JSON.parse(String(row.payload)) as T);
  }
  put(
    owner: string,
    kind: string,
    value: { id: string; agentId?: string },
  ): void {
    this.sql
      .prepare(
        "INSERT INTO agent_runtime_records VALUES (?,?,?,?,?,?) ON CONFLICT(owner,kind,id) DO UPDATE SET agent_id=excluded.agent_id,payload=excluded.payload,updated_at=excluded.updated_at",
      )
      .run(
        owner,
        kind,
        value.id,
        value.agentId ?? "",
        JSON.stringify(value),
        Date.now(),
      );
  }
  remove(owner: string, kind: string, id: string): void {
    this.sql
      .prepare(
        "DELETE FROM agent_runtime_records WHERE owner=? AND kind=? AND id=?",
      )
      .run(owner, kind, id);
  }
  enqueue(owner: string, message: AgentMessage, generation: number): AgentRun {
    const run: AgentRun = {
      id: message.id,
      agentId: message.agentId,
      messageId: message.id,
      roundId: message.roundId,
      state: "queued",
      generation,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
    this.put(owner, "run", run);
    this.put(owner, "outbox", {
      id: run.id,
      agentId: run.agentId,
      ...{ state: "pending", operation: "prompt", createdAt: Date.now() },
    });
    return run;
  }
  runState(
    owner: string,
    messageId: string,
    state: AgentRun["state"],
    fields: Partial<AgentRun> = {},
  ): AgentRun | null {
    const run = this.get<AgentRun>(owner, "run", messageId);
    if (!run) return null;
    Object.assign(run, fields, { state, updatedAt: Date.now() });
    if (state === "starting") {
      run.attemptId = randomUUID();
      this.put(owner, "attempt", {
        id: run.attemptId,
        agentId: run.agentId,
        ...{ runId: run.id, generation: run.generation, createdAt: Date.now() },
      });
    }
    this.put(owner, "run", run);
    this.put(owner, "outbox", {
      id: run.id,
      agentId: run.agentId,
      ...{
        state:
          state === "queued"
            ? "pending"
            : state === "unknown"
              ? "unknown"
              : state,
        attemptId: run.attemptId,
      },
    });
    return run;
  }
  project(owner: string, event: AgentEvent): void {
    const data = event.data ?? {};
    // Legacy events retain their identity; adjacency is not a message boundary.
    const logical =
      typeof data.messageId === "string"
        ? `message:${event.kind}:${data.messageId}`
        : typeof data.toolCallId === "string"
          ? `tool:${data.toolCallId}`
          : typeof data.permissionId === "string"
            ? `permission:${data.permissionId}`
            : `event:${event.id}`;
    if (event.kind === "status" && typeof data.messageId === "string") {
      const id = `message:user:${data.messageId}`,
        previous = this.sql
          .prepare(
            "SELECT payload FROM agent_conversation WHERE owner=? AND agent_id=? AND id=?",
          )
          .get(owner, event.agentId, id);
      if (previous) {
        const item = JSON.parse(String(previous.payload)) as ConversationItem;
        item.data = { ...item.data, ...data };
        item.updatedAt = event.createdAt;
        this.saveItem(owner, item);
      }
      return;
    }
    const previous = this.sql
      .prepare(
        "SELECT payload FROM agent_conversation WHERE owner=? AND agent_id=? AND id=?",
      )
      .get(owner, event.agentId, logical);
    const old = previous
      ? (JSON.parse(String(previous.payload)) as ConversationItem)
      : null;
    // Stable native IDs + snapshot updates let resume replace, never duplicate history.
    const append =
      (event.kind === "assistant" || event.kind === "thought") &&
      data.delta === true;
    const text = append ? (old?.text ?? "") + event.text : event.text;
    const item: ConversationItem = {
      id: logical,
      agentId: event.agentId,
      kind: event.kind,
      text: text.slice(-524288),
      data: { ...old?.data, ...data },
      sequence: old?.sequence ?? event.id,
      createdAt: old?.createdAt ?? event.createdAt,
      updatedAt: event.createdAt,
      roundId: event.roundId,
      runId: typeof data.runId === "string" ? data.runId : old?.runId,
    };
    this.saveItem(owner, item);
  }
  private saveItem(owner: string, item: ConversationItem) {
    this.sql
      .prepare(
        "INSERT INTO agent_conversation VALUES (?,?,?,?,?) ON CONFLICT(owner,agent_id,id) DO UPDATE SET payload=excluded.payload",
      )
      .run(owner, item.agentId, item.id, item.sequence, JSON.stringify(item));
  }
  page(
    owner: string,
    agentId: string,
    before = Number.MAX_SAFE_INTEGER,
    limit = 100,
    latestTerminalOnly = false,
  ): { items: ConversationItem[]; hasMore: boolean } {
    const rows = this.sql
      .prepare(
        `SELECT payload FROM agent_conversation
         WHERE owner=? AND agent_id=? AND sequence<?
           AND json_extract(payload,'$.kind') <> 'status'
           ${
             latestTerminalOnly
               ? `AND (json_extract(payload,'$.kind') <> 'terminal' OR sequence = (
             SELECT MAX(sequence) FROM agent_conversation AS terminal
             WHERE terminal.owner=agent_conversation.owner AND terminal.agent_id=agent_conversation.agent_id
               AND json_extract(terminal.payload,'$.kind')='terminal'
           ))`
               : ""
           }
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(owner, agentId, before, limit + 1);
    return {
      items: rows
        .slice(0, limit)
        .map((row) => JSON.parse(String(row.payload)) as ConversationItem)
        .reverse(),
      hasMore: rows.length > limit,
    };
  }
  providers(owner: string) {
    return this.list<ProviderInstance>(owner, "provider");
  }
  bindings(owner: string) {
    return this.list<NodeWorkspaceBinding>(owner, "binding");
  }
}
