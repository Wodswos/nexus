import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

export interface AgentTransport {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  closed: Promise<{ code: number | null; signal?: string }>;
  close(): void;
}
type RpcMessage = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number };
};
export class AcpConnection {
  private sequence = Math.floor(Math.random() * 1000000000);
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private ended = false;
  private rateWindow = Date.now();
  private rateCount = 0;
  constructor(
    readonly transport: AgentTransport,
    private notification: (method: string, params: any) => void,
    private request: (method: string, params: any) => Promise<unknown>,
    private protocol: "acp" | "codex" = "acp",
  ) {
    transport.stdout.on("data", (bytes: Buffer) => {
      this.buffer += this.decoder.write(bytes);
      if (Buffer.byteLength(this.buffer) > 2 * 1024 * 1024)
        return this.fail(new Error("Agent 协议消息超过 2 MiB"));
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line);
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            (this.protocol === "acp"
              ? value.jsonrpc !== "2.0"
              : value.jsonrpc !== undefined && value.jsonrpc !== "2.0")
          )
            throw new Error("invalid");
          if (Date.now() - this.rateWindow >= 1000) {
            this.rateWindow = Date.now();
            this.rateCount = 0;
          }
          if (++this.rateCount > 1000) {
            this.fail(new Error("Agent 协议输出过快"));
            return;
          }
          void this.receive(value as RpcMessage).catch((error) =>
            this.fail(
              error instanceof Error ? error : new Error("Agent 协议处理失败"),
            ),
          );
        } catch {
          this.fail(
            new Error(
              "启动命令未输出有效的 Agent（ACP / App Server）JSON-RPC 协议，请检查产品与命令",
            ),
          );
          return;
        }
      }
    });
    transport.stdin.on("error", () =>
      this.fail(new Error("Agent 输入通道已断开")),
    );
    transport.stdout.on("error", () =>
      this.fail(new Error("Agent 输出通道已断开")),
    );
    void transport.closed.then(
      () => this.fail(new Error("Agent 连接已断开")),
      () => this.fail(new Error("Agent 连接失败")),
    );
  }
  private write(value: unknown) {
    if (this.ended || !this.transport.stdin.writable)
      throw new Error("Agent 连接已断开");
    if (this.transport.stdin.writableLength > 1024 * 1024)
      throw new Error("Agent 输入通道繁忙");
    this.transport.stdin.write(JSON.stringify(value) + "\n");
  }
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }
  call<T = any>(
    method: string,
    params: unknown,
    timeoutMs = 30000,
  ): Promise<T> {
    if (this.ended) return Promise.reject(new Error("Agent 连接已断开"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent ${method} 请求超时`));
        if (method === "session/prompt")
          this.fail(new Error("Agent 执行超过会话时限"));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private async receive(value: RpcMessage) {
    if (this.ended) return;
    if (typeof value.method === "string") {
      if (value.id === undefined) {
        this.notification(value.method, value.params);
        return;
      }
      try {
        const result = await this.request(value.method, value.params);
        if (!this.ended) this.write({ jsonrpc: "2.0", id: value.id, result });
      } catch {
        if (!this.ended)
          this.write({
            jsonrpc: "2.0",
            id: value.id,
            error: { code: -32601, message: "此客户端未提供该能力" },
          });
      }
      return;
    }
    if (typeof value.id !== "number") return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if (value.error)
      pending.reject(
        new Error(
          String(value.error.message ?? "Agent 请求失败").slice(0, 2000),
        ),
      );
    else pending.resolve(value.result);
  }
  fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.transport.close();
  }
  close(): void {
    this.fail(new Error("Agent 连接已关闭"));
  }
}
