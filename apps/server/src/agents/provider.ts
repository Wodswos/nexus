import { randomUUID } from "node:crypto";
import type {
  AgentCapabilities,
  AgentEventKind,
  WorkspaceAgent,
} from "../../../../packages/core/src/index";
import { AcpConnection, type AgentTransport } from "./acp";

export interface ProviderEvent {
  kind: AgentEventKind;
  text: string;
  data?: Record<string, unknown>;
}
export interface ProviderOpen {
  directory: string;
  sessionId?: string;
  model?: string;
}
export interface ProviderSession {
  capabilities: AgentCapabilities;
  open(input: ProviderOpen): Promise<string>;
  turn(
    text: string,
    runId: string,
    accepted: (nativeTurnId?: string) => void,
  ): Promise<{ stopReason: string }>;
  cancel(): Promise<void>;
  close(): void;
}
export type ProviderRequest = (method: string, params: any) => Promise<any>;
const base: AgentCapabilities = {
  text: true,
  tools: true,
  approvals: true,
  questions: false,
  history: false,
  resume: false,
  cancel: true,
  steer: false,
  models: false,
  tuiHandoff: false,
  fork: false,
  rollback: false,
};

class AcpSession implements ProviderSession {
  readonly capabilities = { ...base };
  private rpc: AcpConnection;
  private sessionId = "";
  private runId = "";
  private recovering = false;
  private activeTurn?: Promise<any>;
  private messageId = "";
  private lastKind = "";
  constructor(
    transport: AgentTransport,
    private emit: (event: ProviderEvent) => void,
    request: ProviderRequest,
  ) {
    this.rpc = new AcpConnection(
      transport,
      (method, p) => {
        if (
          method !== "session/update" ||
          this.recovering ||
          p.sessionId !== this.sessionId
        )
          return;
        const u = p.update;
        if (!u) return;
        if (
          u.sessionUpdate === "agent_message_chunk" ||
          u.sessionUpdate === "agent_thought_chunk"
        ) {
          const kind =
            u.sessionUpdate === "agent_message_chunk" ? "assistant" : "thought";
          if (typeof u.messageId === "string") {
            this.messageId = `${this.sessionId}:${u.messageId}`;
            this.lastKind = kind;
          } else if (this.lastKind !== kind) {
            this.messageId = randomUUID();
            this.lastKind = kind;
          }
          if (u.content?.type === "text")
            this.emit({
              kind,
              text: String(u.content.text ?? ""),
              data: {
                messageId: this.messageId,
                runId: this.runId,
                delta: u.complete !== true,
                complete: u.complete === true,
              },
            });
        } else if (
          ["tool_call", "tool_call_update"].includes(u.sessionUpdate)
        ) {
          this.lastKind = "tool";
          this.emit({
            kind: "tool",
            text: String(u.title ?? "工具执行"),
            data: {
              ...u,
              runId: this.runId,
              toolCallId: `${this.sessionId}:${u.toolCallId}`,
            },
          });
        } else if (u.sessionUpdate === "plan")
          this.emit({
            kind: "plan",
            text: (u.entries ?? [])
              .map((e: any) => String(e.content ?? ""))
              .join("\n"),
            data: u,
          });
      },
      request,
    );
  }
  async open(input: ProviderOpen) {
    const result = await this.rpc.call("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "nexus", version: "1.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    if (result.protocolVersion !== 1) throw new Error("Agent 未协商到 ACP v1");
    this.capabilities.resume = result.agentCapabilities?.loadSession === true;
    this.capabilities.version = "ACP v1";
    if (input.sessionId) {
      if (!this.capabilities.resume)
        throw new Error("此 ACP 产品不支持恢复会话");
      this.recovering = true;
      this.sessionId = input.sessionId;
      try {
        await this.rpc.call("session/load", {
          sessionId: input.sessionId,
          cwd: input.directory,
          mcpServers: [],
        });
      } finally {
        this.recovering = false;
      }
    } else {
      const result = await this.rpc.call("session/new", {
        cwd: input.directory,
        mcpServers: [],
      });
      this.sessionId = result.sessionId;
    }
    if (typeof this.sessionId !== "string" || !this.sessionId)
      throw new Error("Agent 未返回有效会话 ID");
    return this.sessionId;
  }
  async turn(text: string, runId: string, accepted: () => void) {
    this.runId = runId;
    this.lastKind = "";
    // ACP v1 has no turn-accepted acknowledgement. Keep "sending" until evidence arrives.
    this.activeTurn = this.rpc.call(
      "session/prompt",
      { sessionId: this.sessionId, prompt: [{ type: "text", text }] },
      24 * 3600000,
    );
    const result = await this.activeTurn;
    this.activeTurn = undefined;
    accepted();
    return { stopReason: String(result?.stopReason ?? "end_turn") };
  }
  async cancel() {
    this.rpc.notify("session/cancel", { sessionId: this.sessionId });
    if (this.activeTurn)
      await Promise.race([
        this.activeTurn,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("尚未收到取消确认，请检查会话状态")),
            10000,
          );
          timer.unref();
        }),
      ]);
  }
  close() {
    this.rpc.close();
  }
}

class CodexSession implements ProviderSession {
  readonly capabilities: AgentCapabilities = {
    ...base,
    questions: true,
    history: true,
    resume: true,
    models: true,
  };
  private rpc: AcpConnection;
  private sessionId = "";
  private model?: string;
  private runId = "";
  private turnId = "";
  private completions = new Map<
    string,
    { stopReason: string; error?: string }
  >();
  private waiter?: {
    resolve: (value: { stopReason: string }) => void;
    reject: (error: Error) => void;
  };
  constructor(
    transport: AgentTransport,
    private emit: (event: ProviderEvent) => void,
    request: ProviderRequest,
  ) {
    this.rpc = new AcpConnection(
      transport,
      (method, p) => this.notification(method, p),
      async (method, p) => {
        if (p.threadId !== this.sessionId) throw new Error("会话不匹配");
        if (method === "item/tool/requestUserInput")
          return request("nexus/question", {
            sessionId: this.sessionId,
            questions: p.questions,
            nativeId: p.itemId,
          });
        if (
          ![
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
          ].includes(method)
        )
          throw new Error("不支持的原生请求");
        const nativeOptions = Array.isArray(p.availableDecisions)
          ? p.availableDecisions.filter(
              (x: unknown) =>
                typeof x === "string" &&
                ["accept", "acceptForSession", "decline", "cancel"].includes(x),
            )
          : ["accept", "decline", "cancel"];
        const options = nativeOptions.map((id: string) => ({
          optionId: id,
          name: (
            {
              accept: "允许一次",
              acceptForSession: "允许此会话",
              decline: "拒绝",
              cancel: "取消执行",
            } as Record<string, string>
          )[id],
          kind: id.startsWith("accept") ? "allow_once" : "reject_once",
        }));
        const result = await request("session/request_permission", {
          sessionId: this.sessionId,
          nativeId: p.approvalId ?? p.itemId,
          options,
          toolCall: {
            title: p.reason || p.command || "文件修改需要授权",
            ...p,
          },
        });
        return {
          decision:
            result?.outcome?.outcome === "selected"
              ? result.outcome.optionId
              : "cancel",
        };
      },
      "codex",
    );
    void transport.closed.then(() =>
      this.waiter?.reject(new Error("原生会话连接中断，执行结果待核对")),
    );
  }
  async open(input: ProviderOpen) {
    this.model = input.model;
    const result = await this.rpc.call("initialize", {
      clientInfo: { name: "nexus", title: "Nexus", version: "1.0" },
      capabilities: { experimentalApi: true },
    });
    this.capabilities.version =
      typeof result?.userAgent === "string" ? result.userAgent : undefined;
    this.rpc.notify("initialized", {});
    const params = {
      cwd: input.directory,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ...(input.model ? { model: input.model } : {}),
    };
    const value = await this.rpc.call(
      input.sessionId ? "thread/resume" : "thread/start",
      input.sessionId ? { ...params, threadId: input.sessionId } : params,
    );
    if (typeof value?.thread?.id !== "string")
      throw new Error("Codex 未返回 thread.id");
    this.sessionId = value.thread.id;
    for (const turn of value.thread.turns ?? [])
      for (const item of turn.items ?? []) this.item(item, turn.id, true);
    return this.sessionId;
  }
  private item(item: any, turnId: string, complete: boolean) {
    const common = {
      messageId: `${this.sessionId}:${item.id}`,
      nativeId: item.id,
      nativeTurnId: turnId,
      runId: this.runId || undefined,
      complete,
    };
    if (item.type === "agentMessage")
      this.emit({
        kind: "assistant",
        text: String(item.text ?? ""),
        data: common,
      });
    else if (item.type === "reasoning" && Array.isArray(item.summary))
      this.emit({
        kind: "thought",
        text: item.summary.join("\n"),
        data: common,
      });
    else if (
      [
        "commandExecution",
        "fileChange",
        "mcpToolCall",
        "webSearch",
        "dynamicToolCall",
      ].includes(item.type)
    )
      this.emit({
        kind: "tool",
        text: String(item.command ?? item.tool ?? item.type),
        data: {
          ...common,
          ...item,
          messageId: undefined,
          toolCallId: `${this.sessionId}:${item.id}`,
          status: complete ? (item.status ?? "completed") : "in_progress",
        },
      });
  }
  private notification(method: string, p: any) {
    if (p?.threadId && this.sessionId && p.threadId !== this.sessionId) return;
    if (method === "turn/completed") {
      const result = {
        stopReason:
          p.turn.status === "interrupted"
            ? "cancelled"
            : p.turn.status === "failed"
              ? "failed"
              : "end_turn",
        error: p.turn.error?.message,
      };
      this.completions.set(p.turn.id, result);
      if (p.turn.id === this.turnId && this.waiter) {
        if (result.error) this.emit({ kind: "error", text: result.error });
        this.waiter.resolve(result);
        this.waiter = undefined;
      }
    } else if (
      method === "item/agentMessage/delta" ||
      method === "item/reasoning/summaryTextDelta"
    ) {
      this.emit({
        kind: method.includes("agentMessage") ? "assistant" : "thought",
        text: String(p.delta ?? ""),
        data: {
          messageId: `${p.threadId}:${p.itemId}`,
          runId: this.runId,
          nativeTurnId: p.turnId,
          delta: true,
        },
      });
    } else if (method === "item/started" || method === "item/completed")
      this.item(p.item, p.turnId, method === "item/completed");
    else if (method === "turn/plan/updated")
      this.emit({
        kind: "plan",
        text: (p.plan ?? [])
          .map((x: any) => `${x.status === "completed" ? "✓" : "·"} ${x.step}`)
          .join("\n"),
        data: { messageId: `plan:${p.turnId}` },
      });
    else if (method === "error")
      this.emit({
        kind: "error",
        text: String(p.error?.message ?? "Codex 执行错误"),
        data: { willRetry: p.willRetry },
      });
  }
  async turn(text: string, runId: string, accepted: (id?: string) => void) {
    this.runId = runId;
    const result = await this.rpc.call("turn/start", {
      threadId: this.sessionId,
      input: [{ type: "text", text, text_elements: [] }],
      ...(this.model ? { model: this.model } : {}),
    });
    this.turnId = result.turn.id;
    accepted(this.turnId);
    const done = this.completions.get(this.turnId);
    if (done) {
      this.completions.delete(this.turnId);
      if (done.error) this.emit({ kind: "error", text: done.error });
      return done;
    }
    return new Promise<{ stopReason: string }>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
  async cancel() {
    if (!this.turnId) return;
    await this.rpc.call("turn/interrupt", {
      threadId: this.sessionId,
      turnId: this.turnId,
    });
    const deadline = Date.now() + 10000;
    while (!this.completions.has(this.turnId)) {
      if (Date.now() > deadline)
        throw new Error("尚未收到 Codex 的执行结束确认");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  close() {
    this.waiter?.reject(new Error("会话已断开"));
    this.waiter = undefined;
    this.rpc.close();
  }
}

export function providerSession(
  mode: WorkspaceAgent["mode"],
  transport: AgentTransport,
  emit: (event: ProviderEvent) => void,
  request: ProviderRequest,
): ProviderSession {
  if (mode === "codex") return new CodexSession(transport, emit, request);
  const session = new AcpSession(transport, emit, request);
  if (mode === "claude") session.capabilities.questions = true;
  return session;
}
