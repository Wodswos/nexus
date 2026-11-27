import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentRuntimeSetup } from "../workspaces/agentShell";
import { shellQuote as q } from "../connections";
import { AcpConnection, type AgentTransport } from "./acp";
import type {
  ProviderSession,
  ProviderEvent,
  ProviderRequest,
  ProviderOpen,
} from "./provider";
import type {
  AgentCapabilities,
  WorkspaceAgent,
} from "../../../../packages/core/src/index";
export function hostSource() {
  const locations = [
    join(dirname(fileURLToPath(import.meta.url)), "agent-host.cjs"),
    join(process.cwd(), "dist/agent-host.cjs"),
    join(process.cwd(), "apps/server/dist/agent-host.cjs"),
  ];
  const path = locations.find(existsSync);
  if (!path) throw new Error("缺少会话宿主构建产物，请重新构建服务");
  return readFileSync(path, "utf8");
}
export function installHostScript(
  root: string,
  config: unknown,
  token: string,
  source: string,
) {
  return [
    "set -eu",
    "umask 077",
    agentRuntimeSetup("node"),
    `root=${q(root)}`,
    'test ! -L "$root"',
    'mkdir -p "$root"',
    'test "$(stat -c %u "$root")" = "$(id -u)"',
    'chmod 700 "$root"',
    `printf '%s' ${q(Buffer.from(source).toString("base64"))} | base64 -d > "$root/host.cjs.tmp"`,
    'mv "$root/host.cjs.tmp" "$root/host.cjs"',
    `printf '%s' ${q(JSON.stringify(config))} > "$root/config.json.tmp"`,
    'mv "$root/config.json.tmp" "$root/config.json"',
    `printf '%s' ${q(token)} > "$root/token.tmp"`,
    'mv "$root/token.tmp" "$root/token"',
    'command -v node >/dev/null || { echo "结构化持久会话需要执行环境安装 Node.js 18+" >&2; exit 1; }',
  ].join("\n");
}
export class HostSession implements ProviderSession {
  capabilities = {} as AgentCapabilities;
  private rpc: AcpConnection;
  private waiters = new Map<
    string,
    {
      resolve: (value: { stopReason: string }) => void;
      reject: (reason: Error) => void;
      accepted: (id?: string) => void;
    }
  >();
  private results = new Map<string, any>();
  private requestIds = new Set<string>();
  constructor(
    transport: AgentTransport,
    private after: number,
    emit: (value: ProviderEvent, sequence: number) => void,
    request: ProviderRequest,
  ) {
    this.rpc = new AcpConnection(
      transport,
      (method, p) => {
        if (method === "host/event") {
          if (p.sequence <= this.after) return;
          emit(p.event, p.sequence);
          this.after = p.sequence;
          const run = p.event.data?.hostRun;
          if (run) {
            this.results.set(run.id, run);
            this.finish(run);
          }
        } else if (method === "host/request" && !this.requestIds.has(p.id)) {
          this.requestIds.add(p.id);
          void request(p.method, { ...p.params, nexusHostRequestId: p.id })
            .then((value) => this.rpc.call("host/answer", { id: p.id, value }))
            .catch(() => {});
        }
      },
      async () => {
        throw new Error("unsupported");
      },
    );
    void transport.closed.then(() => {
      for (const w of this.waiters.values())
        w.reject(new Error("宿主连接中断，远端工作可能继续；正在重新连接"));
      this.waiters.clear();
    });
  }
  async open(_: ProviderOpen) {
    const state = await this.rpc.call("host/open", {}, 60000);
    if (state.error) throw new Error(state.error);
    this.capabilities = state.capabilities;
    for (const run of Object.values(state.operations))
      this.results.set((run as any).id, run);
    return state.sessionId;
  }
  operationState(id: string) {
    return this.results.get(id)?.state;
  }
  async reconcile(runId: string, resolution: "completed" | "cancelled") {
    const result = await this.rpc.call("host/reconcile", { runId, resolution });
    this.results.set(runId, result);
  }
  hasOperation(id: string) {
    return this.results.has(id);
  }
  async subscribe() {
    await this.rpc.call("host/subscribe", { after: this.after });
  }
  private finish(run: any) {
    const wait = this.waiters.get(run.id);
    if (!wait) return;
    if (run.state === "running" || run.state === "completed")
      wait.accepted(run.nativeId);
    if (["completed", "cancelled", "failed"].includes(run.state)) {
      wait.resolve(
        run.result ?? {
          stopReason: run.state === "cancelled" ? "cancelled" : "end_turn",
        },
      );
      this.waiters.delete(run.id);
    } else if (run.state === "unknown") {
      wait.reject(new Error(run.error ?? "原生投递结果待核对，未自动重发"));
      this.waiters.delete(run.id);
    }
  }
  async turn(text: string, runId: string, accepted: (id?: string) => void) {
    const operation = await this.rpc.call("host/turn", { text, runId });
    return new Promise<{ stopReason: string }>((resolve, reject) => {
      this.waiters.set(runId, { resolve, reject, accepted });
      this.finish(
        ["completed", "cancelled", "unknown"].includes(operation.state)
          ? operation
          : (this.results.get(runId) ?? operation),
      );
    });
  }
  async cancel() {
    await this.rpc.call("host/cancel", {});
  }
  async stop() {
    await this.rpc.call("host/stop", {});
  }
  close() {
    this.rpc.close();
  }
}
