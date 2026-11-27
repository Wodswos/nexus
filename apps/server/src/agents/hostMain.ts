/** Lightweight execution-side supervisor. No listening TCP port, credentials stay on stdin/disk. */
import { createServer, createConnection, type Socket } from "node:net";
import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  existsSync,
  unlinkSync,
  chmodSync,
  readdirSync,
  mkdirSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  providerSession,
  type ProviderEvent,
  type ProviderSession,
} from "./provider";
import { agentLoginCommand } from "../workspaces/agentShell";
import { CLAUDE_BRIDGE } from "./claudeBridge";
const root = process.argv[2]!,
  socketDir = join(
    tmpdir(),
    `nexus-host-${process.getuid?.() ?? 0}-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`,
  ),
  socketPath = join(socketDir, "socket"),
  configPath = join(root, "config.json");
try {
  mkdirSync(socketDir, { mode: 0o700 });
} catch {}
const socketStat = lstatSync(socketDir);
if (
  !socketStat.isDirectory() ||
  socketStat.isSymbolicLink() ||
  socketStat.uid !== process.getuid?.()
)
  throw new Error("宿主 socket 目录归属不匹配");
chmodSync(socketDir, 0o700);
interface Config {
  mode: "codex" | "claude" | "acp";
  command: string;
  directory: string;
  model?: string;
  env: Record<string, string>;
  sessionId?: string;
}
interface Operation {
  id: string;
  fingerprint: string;
  state: string;
  nativeId?: string;
  result?: unknown;
  error?: string;
}
interface RecordState {
  process?: { pid: number; birth: string };
  sessionId?: string;
  capabilities?: ProviderSession["capabilities"];
  sequence: number;
  operations: Record<string, Operation>;
  pending: Record<string, { method: string; params: any }>;
  error?: string;
}
const atomic = (file: string, value: unknown) => {
  const temp = file + "." + randomUUID();
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temp, file);
};
const read = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(
      `会话记录无法读取：${file.split("/").at(-1)}；为避免重复执行，已停止自动恢复`,
    );
  }
};
const print = (socket: Socket, value: unknown) => {
  if (socket.destroyed) return;
  if (socket.writableLength > 2 * 1024 * 1024) {
    socket.destroy();
    return;
  }
  socket.write(JSON.stringify(value) + "\n");
};
const processInfo = (pid: number) => {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8")
      .split(") ")
      .at(-1)!
      .split(" ");
    return { state: fields[0], group: Number(fields[2]), birth: fields[19]! };
  } catch {
    return null;
  }
};
const birth = (pid: number) => processInfo(pid)?.birth ?? null;
const groupAlive = (identity: NonNullable<RecordState["process"]>) => {
  const leader = processInfo(identity.pid);
  if (leader && leader.birth !== identity.birth)
    throw new Error("原进程标识已被替换，拒绝操作其他进程");
  return readdirSync("/proc").some((name) => {
    if (!/^\d+$/.test(name)) return false;
    const info = processInfo(Number(name));
    return (
      info &&
      info.state !== "Z" &&
      info.group === identity.pid &&
      Number(info.birth) >= Number(identity.birth)
    );
  });
};
async function stopProcessGroup(identity?: RecordState["process"]) {
  if (!identity || !groupAlive(identity)) return;
  process.kill(-identity.pid, "SIGTERM");
  const deadline = Date.now() + 8000;
  while (groupAlive(identity)) {
    if (Date.now() >= deadline)
      throw new Error("原生进程尚未确认退出，请核对终端后重试；未标为已停止");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function attach() {
  const connect = () =>
    new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
  let socket: Socket;
  try {
    socket = await connect();
  } catch {
    const child = spawn(process.execPath, [__filename, root, "daemon"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    let connected: Socket | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        connected = await connect();
        break;
      } catch {}
    }
    if (!connected)
      throw new Error(
        "Workspace 会话宿主启动失败，请检查 Node.js 版本和目录权限",
      );
    socket = connected;
  }
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.on("close", () => process.exit(0));
  process.stdin.on("end", () => socket.end());
}
async function daemon() {
  const lock = join(root, "host.lock");
  const old = read<{ pid: number; birth: string }>(lock, { pid: 0, birth: "" });
  if (existsSync(lock)) {
    if (old.pid && birth(old.pid) === old.birth) process.exit(0);
    unlinkSync(lock);
  }
  try {
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, birth: birth(process.pid) }),
      { flag: "wx", mode: 0o600 },
    );
  } catch {
    process.exit(0);
  }
  if (existsSync(socketPath)) unlinkSync(socketPath);
  process.on("exit", () => {
    try {
      unlinkSync(socketPath);
      unlinkSync(lock);
    } catch {}
  });
  const config = read<Config>(configPath, null as unknown as Config);
  if (!config) throw new Error("Missing private host configuration");
  const statePath = join(root, "state.json"),
    eventsPath = join(root, "events.jsonl");
  const state = read<RecordState>(statePath, {
      sequence: 0,
      operations: {},
      pending: {},
    }),
    subscribers = new Set<Socket>();
  const replies = new Map<string, (value: unknown) => void>();
  // A dead host cannot infer whether an in-flight operation ran. Never replay it.
  for (const operation of Object.values(state.operations))
    if (["starting", "running"].includes(operation.state))
      operation.state = "unknown";
  if (
    !Number.isSafeInteger(state.sequence) ||
    !state.operations ||
    !state.pending
  )
    throw new Error("宿主记录格式不正确，已停止恢复");
  state.pending = {};
  state.error = undefined;
  let provider: ProviderSession,
    stopping = false,
    activeRun = "";
  const persist = () => atomic(statePath, state);
  const events: { sequence: number; event: ProviderEvent }[] = existsSync(
    eventsPath,
  )
    ? readFileSync(eventsPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(-5000)
    : [];
  state.sequence = Math.max(
    state.sequence,
    ...events.map((row) => row.sequence),
  );
  let eventBytes = events.reduce(
    (n, event) => n + Buffer.byteLength(JSON.stringify(event)),
    0,
  );
  const persistEvent = (event: ProviderEvent) => {
    event = {
      ...event,
      text: event.text.replace(/nxa_[a-f0-9]{64}/gi, "[凭据已隐藏]"),
      data: { ...event.data, ...(activeRun ? { runId: activeRun } : {}) },
    };
    const value = { sequence: ++state.sequence, event };
    appendFileSync(eventsPath, JSON.stringify(value) + "\n", { mode: 0o600 });
    events.push(value);
    eventBytes += Buffer.byteLength(JSON.stringify(value));
    if (events.length > 5000 || eventBytes > 32 * 1024 * 1024) {
      events.splice(0, Math.max(100, Math.floor(events.length / 4)));
      const temp = eventsPath + ".tmp";
      writeFileSync(
        temp,
        events.map((v) => JSON.stringify(v)).join("\n") + "\n",
        { mode: 0o600 },
      );
      renameSync(temp, eventsPath);
      eventBytes = events.reduce(
        (n, event) => n + Buffer.byteLength(JSON.stringify(event)),
        0,
      );
    }
    persist();
    for (const socket of subscribers)
      print(socket, { jsonrpc: "2.0", method: "host/event", params: value });
  };
  let buffered: ProviderEvent | undefined,
    flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (buffered) {
      const event = buffered;
      buffered = undefined;
      persistEvent(event);
    }
  };
  const emit = (event: ProviderEvent) => {
    if (
      event.data?.delta === true &&
      ["assistant", "thought"].includes(event.kind)
    ) {
      if (
        buffered &&
        (buffered.data?.messageId !== event.data.messageId ||
          buffered.kind !== event.kind)
      )
        flush();
      if (buffered) buffered.text += event.text;
      else buffered = { ...event };
      flushTimer ??= setTimeout(flush, 40);
    } else {
      flush();
      persistEvent(event);
    }
  };
  const pending = (method: string, params: any) =>
    new Promise((resolve) => {
      const id = randomUUID();
      state.pending[id] = { method, params };
      const timer = setTimeout(() => {
        const reply = replies.get(id);
        if (reply) {
          replies.delete(id);
          delete state.pending[id];
          persist();
          reply(
            method === "nexus/question"
              ? { answers: {} }
              : { outcome: { outcome: "cancelled" } },
          );
        }
      }, 30 * 60000);
      timer.unref();
      replies.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      persist();
      for (const socket of subscribers)
        print(socket, {
          jsonrpc: "2.0",
          method: "host/request",
          params: { id, method, params },
        });
    });
  const tokenFile = join(root, "token");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...config.env,
    NEXUS_AGENT_TOKEN_FILE: tokenFile,
  };
  delete env.NEXUS_AGENT_TOKEN;
  if (config.env.NEXUS_PROVIDER_ISOLATED === "1")
    for (const key of [
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ])
      delete env[key];
  const ready = (() => {
    if (state.process && groupAlive(state.process)) {
      state.error =
        "宿主已重启，但原生进程仍在运行。请先结束或核对原进程，未创建重复会话。";
      persist();
      return Promise.resolve();
    }
    const child = spawn(
      config.mode === "claude" ? process.execPath : "/bin/sh",
      config.mode === "claude"
        ? ["-e", CLAUDE_BRIDGE]
        : ["-c", agentLoginCommand(config.command)],
      {
        cwd: config.directory,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    if (child.pid)
      state.process = { pid: child.pid, birth: birth(child.pid) ?? "" };
    persist();
    const closed = new Promise<{ code: number | null }>((resolve) => {
      child.on("error", () => resolve({ code: -1 }));
      child.on("close", (code) => resolve({ code }));
    });
    provider = providerSession(
      config.mode,
      {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        closed,
        close: () => {
          if (
            child.pid &&
            child.exitCode === null &&
            birth(child.pid) === state.process?.birth
          ) {
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {}
          }
        },
      },
      emit,
      pending,
    );
    let stderr = 0;
    child.stderr.on("data", (bytes: Buffer) => {
      if (stderr > 128000) return;
      stderr += bytes.length;
      emit({
        kind: "terminal",
        text: bytes.toString("utf8").slice(-4000),
        data: { stream: "stderr" },
      });
    });
    void closed.then(() => {
      if (!state.process || !groupAlive(state.process))
        state.process = undefined;
      persist();
      if (!stopping) {
        state.error = "原生 Agent 进程已退出";
        persist();
        emit({ kind: "error", text: state.error });
      }
    });

    return provider
      .open({
        directory: config.directory,
        sessionId: state.sessionId || config.sessionId,
        model: config.model,
      })
      .then((id) => {
        state.sessionId = id;
        state.capabilities = provider.capabilities;
        persist();
      })
      .catch((error) => {
        state.error = String(error.message);
        persist();
      });
  })();
  const server = createServer((socket) => {
    const lines = createInterface({ input: socket });
    socket.on("error", () => {});
    socket.on("close", () => subscribers.delete(socket));
    lines.on(
      "line",
      (line) =>
        void (async () => {
          let message: any;
          try {
            if (line.length > 1024 * 1024) throw new Error("输入过长");
            message = JSON.parse(line);
            const { id, method, params: p = {} } = message;
            let result: unknown = {};
            if (method === "host/open") {
              await ready;
              result = { ...state, protocolVersion: 1 };
            } else if (method === "host/subscribe") {
              const first = events[0]?.sequence ?? state.sequence;
              if (p.after && p.after < first - 1)
                throw new Error("远端事件游标已过期，请核对原生历史");
              subscribers.add(socket);
              for (const value of events)
                if (value.sequence > Number(p.after || 0))
                  print(socket, {
                    jsonrpc: "2.0",
                    method: "host/event",
                    params: value,
                  });
              for (const [id, value] of Object.entries(state.pending))
                print(socket, {
                  jsonrpc: "2.0",
                  method: "host/request",
                  params: { id, ...value },
                });
            } else if (method === "host/turn") {
              await ready;
              if (state.error) throw new Error(state.error);
              const fingerprint = createHash("sha256")
                .update(String(p.text))
                .digest("hex");
              const old = state.operations[p.runId];
              if (old) {
                if (old.fingerprint !== fingerprint)
                  throw new Error("同一执行 ID 的消息内容发生变化");
                result = old;
              } else {
                if (activeRun) throw new Error("会话正在执行");
                if (
                  !/^[A-Za-z0-9_-]{1,128}$/.test(p.runId) ||
                  typeof p.text !== "string" ||
                  p.text.length > 24000
                )
                  throw new Error("执行参数无效");
                const operation: Operation = {
                  id: p.runId,
                  fingerprint,
                  state: "starting",
                };
                state.operations[p.runId] = operation;
                activeRun = p.runId;
                persist();
                result = operation;
                void provider
                  .turn(p.text, p.runId, (nativeId) => {
                    operation.state = "running";
                    operation.nativeId = nativeId;
                    persist();
                    emit({
                      kind: "status",
                      text: "Provider 已接收消息",
                      data: {
                        messageId: p.runId,
                        state: "delivered",
                        hostRun: operation,
                      },
                    });
                  })
                  .then(
                    (value) => {
                      operation.state =
                        value.stopReason === "cancelled"
                          ? "cancelled"
                          : value.stopReason === "failed"
                            ? "failed"
                            : "completed";
                      operation.result = value;
                      persist();
                      emit({
                        kind: "status",
                        text: "本次执行已结束",
                        data: { messageId: p.runId, hostRun: operation },
                      });
                    },
                    (error) => {
                      operation.state = "unknown";
                      operation.error = String(error.message);
                      persist();
                      emit({
                        kind: "error",
                        text: operation.error,
                        data: { hostRun: operation },
                      });
                    },
                  )
                  .finally(() => {
                    activeRun = "";
                  });
              }
            } else if (method === "host/reconcile") {
              const operation = state.operations[p.runId];
              if (activeRun)
                throw new Error("原生执行仍在运行，不能核对为已结束");
              if (!["completed", "cancelled"].includes(p.resolution))
                throw new Error("核对结果无效");
              if (
                operation &&
                operation.state !== "unknown" &&
                operation.state !== p.resolution
              )
                throw new Error("原生执行状态与核对结果不一致");
              if (operation) {
                operation.state = p.resolution;
                operation.result = {
                  stopReason:
                    p.resolution === "cancelled" ? "cancelled" : "end_turn",
                };
                persist();
              }
              result = operation ?? { id: p.runId, state: p.resolution };
            } else if (method === "host/result") {
              result = state.operations[p.runId] ?? null;
            } else if (method === "host/answer") {
              const reply = replies.get(p.id);
              if (!reply) throw new Error("请求已处理或过期");
              replies.delete(p.id);
              delete state.pending[p.id];
              persist();
              reply(p.value);
            } else if (method === "host/cancel") {
              if (!provider)
                throw new Error("原生会话未连接，请核对进程或结束会话");
              await provider.cancel();
            } else if (method === "host/stop") {
              stopping = true;
              try {
                await stopProcessGroup(state.process);
              } catch (error) {
                stopping = false;
                throw error;
              }
              if (provider) provider.close();
              state.process = undefined;
              state.error = "用户已结束会话";
              persist();
              setTimeout(() => process.exit(0), 100);
            } else throw new Error("未知的宿主操作");
            print(socket, { jsonrpc: "2.0", id, result });
          } catch (error) {
            print(socket, {
              jsonrpc: "2.0",
              id: message?.id,
              error: {
                code: -32000,
                message:
                  error instanceof Error ? error.message : "宿主操作失败",
              },
            });
          }
        })(),
    );
  });
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  server.on("error", () => process.exit(1));
}
async function stopHost() {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const value = createConnection(socketPath);
    value.once("connect", () => resolve(value));
    value.once("error", reject);
  }).catch(() => null);
  if (socket) {
    await new Promise<void>((resolve, reject) => {
      socket.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "host/stop",
          params: {},
        }) + "\n",
      );
      const input = createInterface({ input: socket });
      input.on("line", (line) => {
        const reply = JSON.parse(line);
        if (reply.id === 1) {
          socket.end();
          reply.error ? reject(new Error(reply.error.message)) : resolve();
        }
      });
      setTimeout(() => {
        socket.destroy();
        reject(new Error("停止宿主超时"));
      }, 10000).unref();
    });
    return;
  }
  const path = join(root, "state.json"),
    state = read<RecordState>(path, {
      sequence: 0,
      operations: {},
      pending: {},
    });
  await stopProcessGroup(state.process);
  state.process = undefined;
  state.error = "用户已结束会话";
  atomic(path, state);
}
void (
  process.argv[3] === "daemon"
    ? daemon()
    : process.argv[3] === "stop"
      ? stopHost()
      : attach()
).catch((error) => {
  process.stderr.write(String(error.message));
  process.exit(1);
});
