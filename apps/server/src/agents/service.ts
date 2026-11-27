import { createHash, randomUUID } from "node:crypto";
import {
  activeTasks,
  resolveWorkspace,
  DEFAULT_AGENT_PROMPT,
  AGENT_INTERACTION_GUIDE,
  type AgentQuestion,
  renderAgentPrompt,
  AGENT_PRODUCT_PRESETS,
  type WorkspaceAgent,
  type WorkspaceAgentState,
  type AgentEvent,
  type AgentEventKind,
  type AgentMessage,
  type CreateWorkspaceAgent,
  type WorkspaceEnvironment,
  type WorkspacePane,
  type AgentRound,
  type AgentRoundInput,
  type AgentReport,
} from "../../../../packages/core/src/index";
import type { DB } from "../db";
import type { setupSync } from "../sync";
import { shellQuote as q } from "../connections";
import { WorkspaceError, type WorkspaceService } from "../workspaces/service";
import { deliveryCommand } from "../workspaces/runtime";
import { agentLaunchScript } from "../workspaces/transport";
import { transientRemoteError } from "../workspaces/remoteErrors";
import { agentLoginCommand, agentRuntimeSetup } from "../workspaces/agentShell";
import { AcpConnection } from "./acp";
import { providerSession, type ProviderSession } from "./provider";
import { HostSession, hostSource, installHostScript } from "./host";
import { CLAUDE_BRIDGE } from "./claudeBridge";
import { readSuggestions, readQuestions, questionAnswers } from "./interaction";
import { workAreaScript } from "./workarea";

type Sync = Pick<ReturnType<typeof setupSync>, "withStore">;
export interface AgentServiceOptions {
  readWorkspace?: (userId: string, id: string) => unknown;
  readTaskRevision?: (
    userId: string,
    taskId: string,
  ) => {
    id: string;
    taskId: string;
    title: string;
    notes: string;
    createdAt: number;
    source: string;
    agentId?: string;
    roundId?: string;
  } | null;
  updateTaskDescription?: (
    userId: string,
    taskId: string,
    input: {
      expectedRevisionId: string;
      notes: string;
      agentId?: string;
      roundId?: string;
    },
  ) => unknown;
  publicOrigin?: string;
}
interface AgentRecord extends WorkspaceAgent {
  callbackOrigin: string;
  initialMessageId: string;
  resumeExisting?: boolean;
  ownedPane?: boolean;
  hostRoot?: string;
  hostSequence?: number;
  persistentHost?: boolean;
  reconnectAt?: number;
  hostGeneration?: number;
}
type Report = AgentReport;
interface TaskQuestion {
  id: string;
  agentId: string;
  questions: AgentQuestion[];
  roundId: string;
  generation: number;
  resolved?: boolean;
  answers?: unknown;
  freeform?: string;
}
interface Permission {
  questions?: AgentQuestion[];
  resolve: (value: unknown) => void;
  options: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}
interface LiveAgent {
  userId: string;
  agentId: string;
  abort: AbortController;
  provider?: ProviderSession;
  generation?: number;
  token: string;
  processing: boolean;
  closing: boolean;
  permissions: Map<string, Permission>;
  checkingPane?: boolean;
  nextPaneCheckAt?: number;
  paneCheckFailures?: number;
  recovering?: boolean;
  preserveToken?: boolean;
}
const digest = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_, item: unknown) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
            )
          : item,
      ),
    )
    .digest("hex");
const key = (userId: string, id: string) => `${userId}:${id}`;
const shells = new Set(["sh", "bash", "zsh", "fish", "dash", "ash", "ksh"]);
const redact = (value: string) =>
  value.replace(/nxa_[a-f0-9]{64}/gi, "[凭据已隐藏]").slice(0, 64000);
const validateId = (value: unknown, label = "请求 ID"): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new WorkspaceError(`${label} 无效`);
  return value;
};
const string = (
  value: unknown,
  label: string,
  max: number,
  empty = false,
): string => {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    Buffer.byteLength(value) > max ||
    value.includes("\0")
  )
    throw new WorkspaceError(`${label} 格式无效或过长`);
  return value;
};
const ROUND_KINDS = [
  "auto",
  "clarify",
  "design",
  "explore",
  "implement",
  "deliver",
] as const;
function roundInput(value: unknown): AgentRoundInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WorkspaceError("本轮目标需要使用 JSON 对象");
  const row = value as Record<string, unknown>;
  if (!(ROUND_KINDS as readonly unknown[]).includes(row.kind))
    throw new WorkspaceError("本轮工作类型无效");
  const acceptance = row.acceptanceCriteria ?? [];
  if (
    !Array.isArray(acceptance) ||
    acceptance.length > 20 ||
    acceptance.some(
      (item) =>
        typeof item !== "string" ||
        !item.trim() ||
        Buffer.byteLength(item) > 2000,
    )
  )
    throw new WorkspaceError("验收条件最多 20 项，每项最多 2000 字节");
  return {
    kind: row.kind as AgentRoundInput["kind"],
    objective: string(row.objective, "本轮目标", 4000),
    expectedOutcome: string(row.expectedOutcome ?? "", "预期产物", 4000, true),
    acceptanceCriteria: acceptance as string[],
  };
}
export function validateAgentInput(
  input: unknown,
): asserts input is CreateWorkspaceAgent {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new WorkspaceError("Agent 配置需要使用 JSON 对象");
  const value = input as CreateWorkspaceAgent;
  validateId(value.requestId);
  string(value.name, "Agent 名称", 160);
  if (!["acp", "tmux", "codex", "claude"].includes(value.mode))
    throw new WorkspaceError("请选择有效的 Agent 产品");
  string(
    value.command ?? "",
    "启动命令",
    4096,
    value.mode === "tmux" && !!value.pane,
  );
  if (
    value.mode === "tmux" &&
    !value.pane &&
    /^(?:exec\s+)?(?:\/[^\s]+\/)?(?:ba|z|fi|da|a|k|tc)?sh(?:\s+-[a-zA-Z]+)*\s*$/.test(
      value.command.trim(),
    )
  )
    throw new WorkspaceError(
      "请设置实际 Agent 启动命令，不能将工作指令发送到交互式 Shell",
    );
  if (value.prompt !== undefined)
    string(value.prompt, "初始 Prompt", 24000, true);
  if (
    value.directory !== undefined &&
    (typeof value.directory !== "string" ||
      value.directory.length > 2048 ||
      (value.directory &&
        (!value.directory.startsWith("/") || /[\0\r\n]/.test(value.directory))))
  )
    throw new WorkspaceError("Agent 工作目录需要使用绝对路径");
  if (value.worktree !== undefined && typeof value.worktree !== "boolean")
    throw new WorkspaceError("worktree 需要使用布尔值");
  if (
    value.isolatedDirectory !== undefined &&
    typeof value.isolatedDirectory !== "boolean"
  )
    throw new WorkspaceError("独立目录参数无效");
  if (value.isolatedDirectory && (value.worktree || value.directory))
    throw new WorkspaceError("独立目录与 worktree／已有目录互斥");
  if (value.worktree && value.directory)
    throw new WorkspaceError("独立 Git worktree 与自定义工作目录互斥");
  if (
    value.worktreeName !== undefined &&
    ((!value.worktree && !value.isolatedDirectory) ||
      typeof value.worktreeName !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.worktreeName))
  )
    throw new WorkspaceError(
      "worktree 名称需为 1–80 位字母、数字、短横线或下划线",
    );
  if (
    value.pane &&
    (value.mode !== "tmux" ||
      !/^%\d+$/.test(value.pane.id) ||
      !Number.isSafeInteger(value.pane.pid) ||
      !Number.isSafeInteger(value.pane.serverPid))
  )
    throw new WorkspaceError("tmux pane 无效");
  if (value.pane && value.worktree)
    throw new WorkspaceError(
      "已有 pane 无法切换到新 worktree，请创建独立 Agent",
    );
  if (
    value.persistentSession !== undefined &&
    typeof value.persistentSession !== "boolean"
  )
    throw new WorkspaceError("持久会话参数无效");
  if (value.model !== undefined) string(value.model, "模型", 200, true);
  if (value.providerId !== undefined)
    validateId(value.providerId, "Provider ID");
  if (
    value.terminalPolicy !== undefined &&
    !["on-demand", "create", "disabled"].includes(value.terminalPolicy)
  )
    throw new WorkspaceError("终端策略无效");
  if (value.round !== undefined) roundInput(value.round);
  if (
    value.productId !== undefined &&
    !AGENT_PRODUCT_PRESETS.some(
      (product) =>
        product.id === value.productId && product.mode === value.mode,
    )
  )
    throw new WorkspaceError("Agent 产品预设与连接方式不匹配");
}
function publicAgent(record: AgentRecord): WorkspaceAgent {
  const {
    callbackOrigin: _,
    initialMessageId: __,
    resumeExisting: ___,
    ownedPane: ____,
    hostRoot: _host,
    hostSequence: _seq,
    persistentHost: _persistent,
    reconnectAt: _reconnect,
    hostGeneration: _hostGeneration,
    ...agent
  } = record;
  return agent;
}
function origin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WorkspaceError("请配置 Agent 可以访问的 Nexus URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new WorkspaceError("Nexus URL 格式无效");
  return url.origin;
}

export class AgentService {
  private live = new Map<string, LiveAgent>();
  private cleaningEnvironments = new Set<string>();
  private terminalOperations = new Set<string>();
  private usage = new Map<string, { count: number; bytes: number }>();
  private subscriptions = new Map<string, Set<() => void>>();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(
    private db: DB,
    private workspaces: WorkspaceService,
    private sync: () => Sync,
    private options: AgentServiceOptions = {},
  ) {
    for (const { userId, agent } of db.allAgentRecords<AgentRecord>()) {
      if (!db.agentRuntime.get(userId, "migration", agent.id)) {
        for (const event of db.agentEvents<AgentEvent>(
          userId,
          agent.id,
          0,
          20001,
        ))
          db.agentRuntime.project(userId, event);
        db.agentRuntime.put(userId, "migration", { id: agent.id });
      }
      if (
        agent.persistentHost &&
        agent.state !== "stopped" &&
        agent.state !== "failed"
      ) {
        agent.state = "queued";
        agent.connectionState = "reconnecting";
        db.saveAgentRecord(userId, agent);
      } else if (
        ["starting", "idle", "running", "waiting", "interrupted"].includes(
          agent.state,
        ) &&
        !this.persistentTmux(userId, agent)
      ) {
        this.setState(
          userId,
          agent,
          "disconnected",
          "服务重启，远端执行结果需要核对。恢复会话不会重发已投递的指令。",
        );
        db.revokeAgentTokens(userId, agent.id);
      }
      const pendingPermissions = new Set<string>();
      for (const event of db.agentEvents<AgentEvent>(
        userId,
        agent.id,
        0,
        20001,
      ))
        if (
          event.kind === "permission" &&
          typeof event.data?.permissionId === "string"
        ) {
          if (event.data.resolved)
            pendingPermissions.delete(event.data.permissionId);
          else pendingPermissions.add(event.data.permissionId);
        }
      for (const permissionId of pendingPermissions)
        this.event(
          userId,
          agent.id,
          "permission",
          "连接中断，旧授权请求已取消",
          { permissionId, resolved: true },
        );
      for (const message of db.agentMessages<AgentMessage>(userId, agent.id))
        if (message.state === "sending") {
          message.state = "unknown";
          message.error = "服务重启，投递结果待核对";
          message.updatedAt = Date.now();
          db.saveAgentMessage(userId, message);
        }
    }
    this.timer = setInterval(() => void this.tick(), 800);
    this.timer.unref();
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const [id, live] of this.live) {
      const agent = this.db.agentRecord<AgentRecord>(
        live.userId,
        id.slice(live.userId.length + 1),
      );
      // tmux owns the CLI lifetime. Detaching Nexus must not revoke credentials
      // still in use by that process; explicit stop/exit still revokes them.
      const persistent =
        agent &&
        (this.persistentTmux(live.userId, agent) || agent.persistentHost);
      if (agent && agent.state !== "stopped" && !persistent)
        this.setState(
          live.userId,
          agent,
          "disconnected",
          "服务连接已关闭，可在重新连接后恢复会话",
        );
      this.closeLive(live);
      if (!persistent) this.db.revokeAgentTokens(live.userId, agent?.id ?? "");
    }
    this.live.clear();
    for (const listeners of this.subscriptions.values())
      for (const listener of listeners) listener();
    this.subscriptions.clear();
  }
  private persistentTmux(userId: string, agent: AgentRecord): boolean {
    return (
      agent.mode === "tmux" &&
      agent.stage === "ready" &&
      !!agent.pane &&
      ["idle", "running", "waiting", "interrupted"].includes(agent.state) &&
      this.db.hasAgentToken(userId, agent.id)
    );
  }
  private closeLive(live: LiveAgent): void {
    live.closing = true;
    for (const [permissionId, permission] of live.permissions) {
      clearTimeout(permission.timer);
      if (!(live.provider instanceof HostSession))
        permission.resolve({ outcome: { outcome: "cancelled" } });
      if (!this.closed)
        this.db.appendAgentEvent(live.userId, {
          agentId: live.agentId,
          kind: "permission",
          text: "会话已关闭，授权请求已取消",
          data: { permissionId, resolved: true },
          createdAt: Date.now(),
        });
    }
    live.permissions.clear();
    live.abort.abort();
    live.provider?.close();
  }
  private task(userId: string, taskId: string, existingAgent = false) {
    const result = this.sync().withStore(userId, false, (store) => {
      const data = store.getData();
      const visible = existingAgent
        ? data.tasks.filter((t) => !t.deletedAt)
        : activeTasks(data.tasks);
      const task = visible.find((t) => t.id === taskId);
      if (!task) throw new WorkspaceError("任务不存在或已归档", 404);
      const resolved = resolveWorkspace(
        existingAgent
          ? {
              ...data,
              tasks: data.tasks.map((t) =>
                t.status === "archived" ? { ...t, status: "todo" as const } : t,
              ),
            }
          : data,
        taskId,
      );
      if (resolved.disabled && !existingAgent)
        throw new WorkspaceError("此分支的 Workspace 已停用", 409);
      const summarize = (t: typeof task) => ({
        id: t.id,
        title: t.title,
        notes: t.notes ?? "",
        status: t.status,
        parentId: t.parentId,
      });
      return {
        task,
        resolved,
        ancestors: resolved.path
          .filter((id) => id !== taskId)
          .map((id) => visible.find((t) => t.id === id))
          .filter(Boolean)
          .map((t) => summarize(t!)),
        children: visible
          .filter((t) => t.parentId === taskId)
          .slice(0, 100)
          .map(summarize),
        resources: data.links
          .filter((link) => link.taskId === taskId && !link.deletedAt)
          .slice(0, 100),
      };
    });
    // Flush browser checkpoints before any Agent transaction begins. In legacy
    // workspaces this also establishes the initial immutable text revision.
    this.options.readTaskRevision?.(userId, taskId);
    return result;
  }
  private record(userId: string, id: string): AgentRecord {
    const record = this.db.agentRecord<AgentRecord>(userId, id);
    if (!record) throw new WorkspaceError("Agent 不存在", 404);
    return record;
  }
  private public(userId: string, agent: AgentRecord): WorkspaceAgent {
    return {
      ...publicAgent(agent),
      currentRound: agent.currentRoundId
        ? (this.db.agentRound<AgentRound>(userId, agent.currentRoundId) ??
          undefined)
        : undefined,
    };
  }
  get(userId: string, id: string): WorkspaceAgent {
    return this.public(userId, this.record(userId, id));
  }
  list(userId: string, taskId: string): WorkspaceAgent[] {
    this.task(userId, taskId);
    return this.db
      .agentRecords<AgentRecord>(userId, taskId)
      .map((agent) => this.public(userId, agent));
  }
  prompt(userId: string, taskId: string, incomingOrigin: string) {
    const { task } = this.task(userId, taskId);
    const base = origin(this.options.publicOrigin || incomingOrigin);
    const template = DEFAULT_AGENT_PROMPT;
    const taskUrl = `${base}/tasks?focusTask=${encodeURIComponent(taskId)}`;
    return {
      prompt: renderAgentPrompt(template, {
        taskTitle: task.title,
        taskUrl,
        contextUrl: "{{task_context_url}}",
      }),
      contextUrlTemplate: `${base}/api/agent-context/{agentId}?taskId=${encodeURIComponent(taskId)}`,
      taskUrl,
    };
  }
  private createRound(
    userId: string,
    agent: AgentRecord,
    input: AgentRoundInput,
  ): AgentRound {
    const previous = this.db.agentRounds<AgentRound>(userId, agent.id);
    if (previous.length >= 1000)
      throw new WorkspaceError(
        "此 Agent 的工作轮次已达上限，请创建新 Agent",
        429,
      );
    // Only read SQLite here: this helper also runs inside an Agent transaction.
    const time = Date.now(),
      round: AgentRound = {
        ...input,
        id: randomUUID(),
        agentId: agent.id,
        taskId: agent.taskId,
        sequence: previous.length + 1,
        state: "running",
        baseRevisionId: this.db.taskRevisions.latest(userId, agent.taskId)?.id,
        createdAt: time,
        updatedAt: time,
      };
    this.db.saveAgentRound(userId, round);
    agent.currentRoundId = round.id;
    agent.updatedAt = time;
    this.db.saveAgentRecord(userId, agent);
    this.event(userId, agent.id, "status", `开始第 ${round.sequence} 轮`, {
      roundId: round.id,
      round,
    });
    return round;
  }
  private currentRound(userId: string, agent: AgentRecord): AgentRound {
    const round = agent.currentRoundId
      ? this.db.agentRound<AgentRound>(userId, agent.currentRoundId)
      : null;
    return (
      round ??
      this.createRound(userId, agent, {
        kind: "auto",
        objective: "根据 Task 当前情况和 Prompt 自主判断并推进本轮工作",
        expectedOutcome: "符合本轮范围的实际成果与验证依据",
        acceptanceCriteria: [],
      })
    );
  }
  rounds(userId: string, id: string): AgentRound[] {
    this.record(userId, id);
    return this.db.agentRounds<AgentRound>(userId, id);
  }
  startRound(
    userId: string,
    id: string,
    input: Record<string, unknown>,
  ): AgentRound {
    const agent = this.record(userId, id);
    this.task(userId, agent.taskId, true);
    const requestId = validateId(input.requestId),
      fields = roundInput(input),
      text = string(input.text ?? fields.objective, "本轮指令", 24000);
    const fingerprint = digest({ fields, text }),
      scope = `round:${id}`,
      previous = this.db.agentRequest<AgentRound>(userId, scope, requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new WorkspaceError("同一轮次请求 ID 内容已变化", 409);
      return (
        this.db.agentRound<AgentRound>(userId, previous.value.id) ??
        previous.value
      );
    }
    if (
      ["stopped", "failed", "disconnected"].includes(agent.state) ||
      (agent.state === "interrupted" && !this.live.has(key(userId, id)))
    )
      throw new WorkspaceError("请先恢复 Agent，再开始新一轮", 409);
    if (["queued", "preparing", "starting"].includes(agent.state))
      throw new WorkspaceError("请等待 Agent 连接完成，再开始新一轮", 409);
    const current = agent.currentRoundId
      ? this.db.agentRound<AgentRound>(userId, agent.currentRoundId)
      : null;
    if (current && !["accepted", "cancelled", "failed"].includes(current.state))
      throw new WorkspaceError("请先验收或结束当前轮次，再开始新一轮", 409);
    if (this.live.get(key(userId, id))?.processing)
      throw new WorkspaceError("当前执行尚未结束，请稍后开始新一轮", 409);
    let round!: AgentRound;
    this.db.transaction(() => {
      round = this.createRound(userId, agent, fields);
      if (agent.state === "interrupted") this.setState(userId, agent, "idle");
      this.addMessage(
        userId,
        agent,
        randomUUID(),
        `开始第 ${round.sequence} 轮。\n本轮目标：${round.objective}\n预期产物：${round.expectedOutcome}\n验收条件：${round.acceptanceCriteria.join("；") || "按用户本轮要求验收"}\n${text}`,
      );
      this.db.rememberAgentRequest(
        userId,
        scope,
        requestId,
        fingerprint,
        round,
      );
    });
    void this.pump(userId, id);
    return round;
  }
  reviewRound(
    userId: string,
    id: string,
    roundId: string,
    input: Record<string, unknown>,
  ): { agent: WorkspaceAgent; round: AgentRound; taskCompleted: boolean } {
    const agent = this.record(userId, id);
    this.task(userId, agent.taskId, true);
    const requestId = validateId(input.requestId),
      action = String(input.action),
      scope = `review:${id}:${roundId}`;
    if (!["accept", "revise", "complete_task"].includes(action))
      throw new WorkspaceError("轮次处理方式无效");
    const feedback = string(
      input.text ?? "",
      "调整意见",
      24000,
      action !== "revise",
    );
    const fingerprint = digest({ action, feedback }),
      prior = this.db.agentRequest<{
        round: AgentRound;
        taskCompleted: boolean;
      }>(userId, scope, requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new WorkspaceError("验收请求内容已变化", 409);
      return {
        agent: this.get(userId, id),
        round:
          this.db.agentRound<AgentRound>(userId, roundId) ?? prior.value.round,
        taskCompleted: prior.value.taskCompleted,
      };
    }
    const round = this.db.agentRound<AgentRound>(userId, roundId);
    if (!round || round.agentId !== id || agent.currentRoundId !== roundId)
      throw new WorkspaceError("只能处理此 Agent 当前轮次", 409);
    if (
      action === "complete_task"
        ? round.state !== "accepted"
        : round.state !== "awaiting_review"
    )
      throw new WorkspaceError(
        action === "complete_task"
          ? "请先验收本轮，再明确完成 Task"
          : "当前轮次尚未提交待验收报告",
        409,
      );
    if (
      action === "accept" &&
      (this.live.get(key(userId, id))?.processing ||
        this.live.get(key(userId, id))?.permissions.size ||
        this.db
          .agentMessages<AgentMessage>(userId, id)
          .some(
            (message) =>
              message.roundId === roundId &&
              ["queued", "sending"].includes(message.state),
          ))
    )
      throw new WorkspaceError(
        "本轮仍有执行或待发送消息，请等待结束后验收",
        409,
      );
    if (
      action === "revise" &&
      ["stopped", "failed", "disconnected"].includes(agent.state)
    )
      throw new WorkspaceError("请先恢复 Agent，再发送调整意见", 409);
    const commit = () => {
      if (action === "accept") {
        round.state = "accepted";
        round.acceptedAt = Date.now();
      } else if (action === "revise") {
        round.state = "running";
        round.acceptedAt = undefined;
        this.addMessage(
          userId,
          agent,
          randomUUID(),
          `继续调整第 ${round.sequence} 轮，沿用本轮目标与验收条件。\n${feedback}`,
        );
        if (agent.waitReason === "user") {
          agent.waitReason = undefined;
          this.setState(userId, agent, "idle");
        }
      }
      round.updatedAt = Date.now();
      this.db.saveAgentRound(userId, round);
      this.event(
        userId,
        id,
        "status",
        action === "accept"
          ? "本轮已验收"
          : action === "revise"
            ? "本轮继续调整"
            : "用户已明确完成 Task",
        { roundId, action },
      );
      this.db.rememberAgentRequest(userId, scope, requestId, fingerprint, {
        round,
        taskCompleted: action === "complete_task",
      });
    };
    if (action === "complete_task")
      this.sync().withStore(
        userId,
        true,
        (store) => {
          store.setTaskStatus(agent.taskId, "done");
        },
        commit,
      );
    else this.db.transaction(commit);
    if (action === "revise") void this.pump(userId, id);
    return {
      agent: this.get(userId, id),
      round,
      taskCompleted: action === "complete_task",
    };
  }
  async cancelRound(
    userId: string,
    id: string,
    roundId: string,
    input: Record<string, unknown>,
  ): Promise<{ agent: WorkspaceAgent; round: AgentRound }> {
    let agent = this.record(userId, id);
    this.task(userId, agent.taskId, true);
    const requestId = validateId(input.requestId),
      reason = string(input.text ?? "", "放弃本轮说明", 4000, true),
      scope = `cancel-round:${id}:${roundId}`,
      fingerprint = digest(reason);
    const previous = this.db.agentRequest<AgentRound>(userId, scope, requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new WorkspaceError("放弃本轮请求内容已变化", 409);
      return {
        agent: this.get(userId, id),
        round:
          this.db.agentRound<AgentRound>(userId, roundId) ?? previous.value,
      };
    }
    let round = this.db.agentRound<AgentRound>(userId, roundId);
    if (!round || round.agentId !== id || agent.currentRoundId !== roundId)
      throw new WorkspaceError("只能放弃此 Agent 当前轮次", 409);
    if (round.state === "accepted")
      throw new WorkspaceError("已验收轮次不能放弃，请明确开始新一轮", 409);
    const live = this.live.get(key(userId, id));
    if (live && ["running", "waiting"].includes(agent.state))
      await this.cancel(userId, id);
    agent = this.record(userId, id);
    round = this.db.agentRound<AgentRound>(userId, roundId)!;
    if (agent.currentRoundId !== roundId || round.state === "accepted")
      throw new WorkspaceError("当前轮次状态已变化，请刷新后重试", 409);
    const raced = this.db.agentRequest<AgentRound>(userId, scope, requestId);
    if (raced) {
      if (raced.fingerprint !== fingerprint)
        throw new WorkspaceError("放弃本轮请求内容已变化", 409);
      return { agent: this.public(userId, agent), round };
    }
    this.db.transaction(() => {
      for (const message of this.db.agentMessages<AgentMessage>(userId, id))
        if (
          (!message.roundId || message.roundId === roundId) &&
          message.state === "queued"
        ) {
          message.state = "failed";
          message.error = "用户已放弃本轮";
          message.updatedAt = Date.now();
          this.db.saveAgentMessage(userId, message);
        }
      round!.state = "cancelled";
      round!.updatedAt = Date.now();
      this.db.saveAgentRound(userId, round!);
      this.event(userId, id, "status", "用户已放弃本轮，代码与历史已保留", {
        roundId,
        reason,
      });
      this.db.rememberAgentRequest(
        userId,
        scope,
        requestId,
        fingerprint,
        round,
      );
    });
    return { agent: this.get(userId, id), round };
  }
  workbench(userId: string) {
    return this.sync().withStore(userId, false, (store) => {
      const tasks = activeTasks(store.getData().tasks),
        byId = new Map(tasks.map((task) => [task.id, task]));
      const groups: {
        waiting: unknown[];
        review: unknown[];
        running: unknown[];
        error: unknown[];
      } = { waiting: [], review: [], running: [], error: [] };
      const byTask = new Map<string, WorkspaceAgent[]>();
      for (const record of this.db.agentRecords<AgentRecord>(userId)) {
        if (!byId.has(record.taskId)) continue;
        const values = byTask.get(record.taskId) ?? [];
        values.push(this.public(userId, record));
        byTask.set(record.taskId, values);
      }
      for (const [taskId, agents] of byTask) {
        const task = byId.get(taskId)!,
          rounds = agents.flatMap((agent) =>
            agent.currentRound ? [agent.currentRound] : [],
          ),
          reasons: string[] = [];
        const waiting =
          agents.some((agent) => agent.state === "waiting") ||
          rounds.some((round) => round.state === "waiting_user");
        const review = rounds.some(
            (round) => round.state === "awaiting_review",
          ),
          error = agents.some((agent) =>
            ["failed", "disconnected"].includes(agent.state),
          );
        const running =
          rounds.some((round) => round.state === "running") ||
          agents.some(
            (agent) =>
              !agent.currentRound &&
              ["queued", "preparing", "starting", "running"].includes(
                agent.state,
              ),
          );
        if (!waiting && !review && !error && !running) continue;
        if (waiting)
          reasons.push(
            agents.some((agent) => agent.waitReason === "permission")
              ? "等待工具授权"
              : "等待用户回复",
          );
        if (review) reasons.push("本轮产物待验收");
        if (error) reasons.push("连接或执行异常");
        if (running) reasons.push("有轮次正在推进");
        const attention = waiting
          ? "waiting"
          : review
            ? "review"
            : error
              ? "error"
              : "running";
        let project = task,
          seen = new Set<string>();
        while (project.parentId && !seen.has(project.id)) {
          seen.add(project.id);
          const parent = byId.get(project.parentId);
          if (!parent) break;
          project = parent;
        }
        const reports = this.db.agentReports<Report>(userId, taskId),
          latestReport = reports.at(-1);
        groups[attention].push({
          taskId,
          title: task.title,
          projectId: project.id,
          projectTitle: project.title,
          task: {
            id: task.id,
            title: task.title,
            status: task.status,
            parentId: task.parentId,
          },
          agents,
          rounds,
          attention,
          reasons,
          latestReport,
          updatedAt: Math.max(
            ...agents.map((agent) => agent.updatedAt),
            ...rounds.map((round) => round.updatedAt),
          ),
        });
      }
      for (const rows of Object.values(groups))
        rows.sort((a: any, b: any) => b.updatedAt - a.updatedAt);
      return {
        groups,
        counts: Object.fromEntries(
          Object.entries(groups).map(([group, rows]) => [group, rows.length]),
        ),
        total: Object.values(groups).reduce(
          (sum, rows) => sum + rows.length,
          0,
        ),
      };
    });
  }
  subscribe(userId: string, id: string, wake: () => void): () => void {
    this.record(userId, id);
    const idKey = key(userId, id),
      set = this.subscriptions.get(idKey) ?? new Set();
    const userCount = [...this.subscriptions]
      .filter(([value]) => value.startsWith(userId + ":"))
      .reduce((sum, [, values]) => sum + values.size, 0);
    if (
      userCount >= 16 ||
      [...this.subscriptions.values()].reduce(
        (sum, values) => sum + values.size,
        0,
      ) >= 128
    )
      throw new WorkspaceError("实时连接过多", 429);
    set.add(wake);
    this.subscriptions.set(idKey, set);
    return () => {
      set.delete(wake);
      if (!set.size) this.subscriptions.delete(idKey);
    };
  }
  isClosed(): boolean {
    return this.closed;
  }
  async checkConnection(userId: string, input: Record<string, unknown>) {
    const taskId = validateId(input.taskId, "任务 ID"),
      environmentId = validateId(input.environmentId, "环境 ID");
    this.task(userId, taskId);
    const environment = this.workspaces.environment(userId, environmentId);
    if (environment.state !== "ready")
      throw new WorkspaceError("请先准备可用环境，再检测 Agent", 409);
    const checkedAt = Date.now(),
      base = { checkedAt, authentication: "not_checked" as const };
    if (!["acp", "tmux", "codex", "claude"].includes(String(input.mode)))
      throw new WorkspaceError("连接方式无效");
    if (input.pane) {
      const expected = input.pane as WorkspacePane,
        pane = (await this.workspaces.panes(userId, environmentId)).find(
          (value) => value.id === expected.id && !value.dead,
        );
      if (
        !pane ||
        pane.pid !== expected.pid ||
        pane.serverPid !== expected.serverPid
      )
        throw new WorkspaceError("pane 已变化，请重新选择", 409);
      if (shells.has(pane.command.replace(/^-/, "")))
        return {
          ...base,
          ok: false,
          installed: null,
          protocol: null,
          message: "当前 pane 是 Shell，请先启动 Agent。",
        };
      return {
        ...base,
        ok: true,
        installed: true,
        protocol: "terminal" as const,
        message:
          "已确认正在运行的终端进程和 pane 身份；模型认证与具体产品兼容性未检测。",
      };
    }
    const command = string(input.command, "启动命令", 4096);
    const executable = /^(?:exec\s+)?(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))/
      .exec(command)
      ?.slice(1)
      .find(Boolean);
    let installed: boolean | null = null;
    if (executable && /^[A-Za-z0-9_./@+-]+$/.test(executable)) {
      const result = await this.workspaces.executeInEnvironment(
        userId,
        environmentId,
        `sh -lc ${q(agentRuntimeSetup(executable) + `\nif command -v ${q(executable)} >/dev/null 2>&1; then printf installed; fi`)}`,
      );
      installed = result.trim() === "installed";
      if (!installed)
        return {
          ...base,
          ok: false,
          installed: false,
          protocol: null,
          message:
            "目标环境中未找到启动命令。请先安装对应 Agent，再进行连接检测。",
        };
    }
    if (input.mode === "tmux")
      return {
        ...base,
        ok: installed === true,
        installed,
        protocol: installed ? "terminal" : null,
        message: installed
          ? "已找到可执行文件；这不代表模型认证或该版本的 TUI 兼容性已通过。"
          : "复杂自定义命令无法仅凭名称判断安装状态，请启动后核对终端。",
      };
    const abort = new AbortController();
    let rpc: AcpConnection | undefined;
    try {
      const transport = await this.workspaces.openAgentTransport(
        userId,
        environmentId,
        input.mode === "claude" ? `node -e ${q(CLAUDE_BRIDGE)}` : command,
        { directory: environment.directory, signal: abort.signal },
      );
      rpc = new AcpConnection(
        transport,
        () => {},
        async () => {
          throw new Error("连接检测不执行工具请求");
        },
        input.mode === "codex" ? "codex" : "acp",
      );
      if (input.mode === "codex") {
        const info = await rpc.call(
          "initialize",
          { clientInfo: { name: "nexus-probe", version: "1.0" } },
          8000,
        );
        rpc.notify("initialized", {});
        return {
          ...base,
          ok: true,
          installed: true,
          protocol: "codex-app-server",
          version: info?.userAgent,
          message: "Codex App Server 握手成功；未发起模型调用。",
        };
      }
      const response = await rpc.call(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: { name: "nexus-connection-check", version: "0.5.0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        8000,
      );
      if (response?.protocolVersion !== 1)
        return {
          ...base,
          ok: false,
          installed: true,
          protocol: null,
          message: "命令未协商到 ACP v1。",
        };
      return {
        ...base,
        ok: true,
        installed: true,
        protocol: "acp-v1" as const,
        capabilities: {
          resume: response.agentCapabilities?.loadSession === true,
        },
        message:
          "ACP v1 握手成功。未创建任务会话、发送工作 Prompt 或测试模型认证。",
      };
    } catch {
      return {
        ...base,
        ok: false,
        installed,
        protocol: null,
        message:
          "ACP 握手失败，请检查命令是否为支持 ACP 的适配器及其启动依赖。",
      };
    } finally {
      abort.abort();
      rpc?.close();
    }
  }
  validateProvider(
    userId: string,
    input: { providerId?: string; mode: string },
  ) {
    if (!input.providerId) return;
    const provider = this.db.agentRuntime.get<
      import("../../../../packages/core/src/index").ProviderInstance
    >(userId, "provider", input.providerId);
    if (!provider || provider.harness !== input.mode)
      throw new WorkspaceError("Provider 配置不存在或产品不匹配", 400);
  }
  create(
    userId: string,
    taskId: string,
    input: CreateWorkspaceAgent,
    incomingOrigin = this.options.publicOrigin ??
      process.env.PUBLIC_ORIGIN ??
      "",
  ): WorkspaceAgent {
    validateAgentInput(input);
    const { task, resolved } = this.task(userId, taskId);
    const requestId = validateId(input.requestId);
    const fingerprint = digest({ taskId, input });
    const previous = this.db.agentRequest<{ id: string }>(
      userId,
      "create",
      requestId,
    );
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new WorkspaceError("同一请求 ID 已用于其他 Agent 配置", 409);
      return this.get(userId, previous.value.id);
    }
    const name = string(input.name, "Agent 名称", 160).trim();
    if (!["acp", "tmux", "codex", "claude"].includes(input.mode))
      throw new WorkspaceError("请选择有效的 Agent 产品");
    const command = string(
      input.command ?? "",
      "启动命令",
      4096,
      input.mode === "tmux" && !!input.pane,
    );
    const workspaceId =
      input.workspaceId ||
      (resolved as { workspaceId?: string | null }).workspaceId ||
      null;
    if (workspaceId) {
      validateId(workspaceId, "Workspace ID");
      this.options.readWorkspace?.(userId, workspaceId);
    }
    this.validateProvider(userId, input);
    const environment = this.workspaces.environment(
      userId,
      validateId(input.environmentId, "环境 ID"),
    );
    if (environment.state === "stopped")
      throw new WorkspaceError("所选环境已结束");
    if (
      this.cleaningEnvironments.has(key(userId, environment.id)) ||
      this.db
        .agentRecords<AgentRecord>(userId)
        .some(
          (a) =>
            a.environmentId === environment.id && a.workArea?.cleanupStartedAt,
        )
    )
      throw new WorkspaceError("Workspace 正在清理工作目录，请稍后重试", 409);
    if (
      input.pane &&
      (input.mode !== "tmux" ||
        !/^%\d+$/.test(input.pane.id) ||
        !Number.isSafeInteger(input.pane.pid) ||
        !Number.isSafeInteger(input.pane.serverPid))
    )
      throw new WorkspaceError("tmux pane 无效");
    const directory = input.directory ?? environment.directory;
    if (
      typeof directory !== "string" ||
      directory.length > 2048 ||
      (directory && (!directory.startsWith("/") || /[\0\r\n]/.test(directory)))
    )
      throw new WorkspaceError("Agent 工作目录需要使用绝对路径");
    if (input.worktree && input.pane)
      throw new WorkspaceError(
        "已有 pane 无法切换到新 worktree，请创建独立 Agent",
      );
    const template = string(
      input.prompt !== undefined ? input.prompt : DEFAULT_AGENT_PROMPT,
      "初始 Prompt",
      24000,
      true,
    );
    const callbackOrigin = origin(this.options.publicOrigin || incomingOrigin);
    const all = this.db.agentRecords<AgentRecord>(userId);
    if (
      input.worktreeName &&
      all.some(
        (agent) =>
          agent.environmentId === environment.id &&
          agent.worktree &&
          (agent.worktreeName ?? agent.id) === input.worktreeName,
      )
    )
      throw new WorkspaceError(
        "此 Workspace 中的 worktree 名称已被使用，请更换名称",
        409,
      );
    if (
      all.length >= 1000 ||
      all.filter(
        (a) =>
          !["stopped", "failed", "disconnected", "interrupted"].includes(
            a.state,
          ),
      ).length >= 24
    )
      throw new WorkspaceError(
        "Agent 数量已达上限，请结束不再使用的 Agent",
        429,
      );
    const id = randomUUID(),
      time = Date.now();
    const prompt = renderAgentPrompt(template, {
      taskTitle: task.title,
      taskUrl: `${callbackOrigin}/tasks?focusTask=${encodeURIComponent(taskId)}`,
      contextUrl: `${callbackOrigin}/api/agent-context/${id}?taskId=${encodeURIComponent(taskId)}`,
    });
    const agent: AgentRecord = {
      id,
      workspaceId,
      taskId,
      environmentId: environment.id,
      name,
      mode: input.mode,
      command,
      prompt,
      directory,
      worktree: input.worktree === true,
      isolatedDirectory: input.isolatedDirectory === true,
      ...(input.worktree ? { worktreeLayoutVersion: 2 as const } : {}),
      ...(input.worktreeName ? { worktreeName: input.worktreeName } : {}),
      ...(input.pane ? { pane: structuredClone(input.pane) } : {}),
      productId: input.productId,
      providerId: input.providerId,
      model: input.model,
      terminalPolicy: input.terminalPolicy ?? "on-demand",
      sessionGeneration: 0,
      persistentHost:
        input.mode !== "tmux" && input.persistentSession !== false,
      persistentSession:
        input.mode !== "tmux" && input.persistentSession !== false,
      hostGeneration: 1,
      state: "queued",
      stage: "environment",
      canResume: false,
      createdAt: time,
      updatedAt: time,
      callbackOrigin,
      initialMessageId: `initial-${id}`,
      ownedPane: input.mode === "tmux" && !input.pane,
    };
    this.db.transaction(() => {
      this.db.saveAgentRecord(userId, agent);
      this.db.agentRuntime.put(userId, "migration", { id });
      if (input.round) this.createRound(userId, agent, roundInput(input.round));
      else this.currentRound(userId, agent);
      this.db.rememberAgentRequest(userId, "create", requestId, fingerprint, {
        id,
      });
      this.event(userId, id, "status", "等待环境准备完成", {
        state: "queued",
        stage: "environment",
      });
      if (prompt.trim())
        this.addMessage(userId, agent, agent.initialMessageId, prompt);
    });
    void this.tick();
    return this.public(userId, agent);
  }
  private event(
    userId: string,
    agentId: string,
    kind: AgentEventKind,
    text: string,
    data?: Record<string, unknown>,
  ): AgentEvent {
    if (!this.db.inTransaction)
      return this.db.transaction(() =>
        this.event(userId, agentId, kind, text, data),
      );
    const serialized = data
      ? JSON.stringify(data, (_, value: unknown) =>
          typeof value === "string" ? redact(value).slice(0, 24000) : value,
        ).replace(/nxa_[a-f0-9]{64}/gi, "[凭据已隐藏]")
      : "";
    const cleanData = serialized
      ? Buffer.byteLength(serialized) > 64000
        ? { truncated: true }
        : (JSON.parse(serialized) as Record<string, unknown>)
      : undefined;
    const roundId = this.db.agentRecord<AgentRecord>(
      userId,
      agentId,
    )?.currentRoundId;
    const value = {
      agentId,
      kind,
      text: redact(text),
      ...(cleanData ? { data: cleanData } : {}),
      ...(roundId ? { roundId } : {}),
      createdAt: Date.now(),
    };
    const usageKey = key(userId, agentId),
      usage =
        this.usage.get(usageKey) ?? this.db.agentEventUsage(userId, agentId);
    this.usage.set(usageKey, usage);
    const size = Buffer.byteLength(JSON.stringify(value));
    if (usage.count >= 20000 || usage.bytes + size > 16 * 1024 * 1024) {
      this.db.trimAgentEvents(
        userId,
        agentId,
        Math.max(100, Math.floor(usage.count / 2)),
      );
      const remaining = this.db.agentEventUsage(userId, agentId);
      usage.count = remaining.count;
      usage.bytes = remaining.bytes;
    }
    usage.count++;
    usage.bytes += size;
    const event = this.db.appendAgentEvent(userId, value);
    this.db.agentRuntime.project(userId, event);
    for (const listener of this.subscriptions.get(usageKey) ?? []) listener();
    return event;
  }
  private setState(
    userId: string,
    agent: AgentRecord,
    state: WorkspaceAgentState,
    error?: string,
  ): void {
    if (!this.db.inTransaction) {
      this.db.transaction(() => this.setState(userId, agent, state, error));
      return;
    }
    if (state !== "waiting") agent.waitReason = undefined;
    const persisted = this.db.agentRecord<AgentRecord>(userId, agent.id);
    if (persisted?.hostSequence)
      agent.hostSequence = Math.max(
        agent.hostSequence ?? 0,
        persisted.hostSequence,
      );
    agent.state = state;
    agent.error = error ? redact(error) : undefined;
    agent.updatedAt = Date.now();
    this.db.saveAgentRecord(userId, agent);
    this.event(userId, agent.id, error ? "error" : "status", error ?? state, {
      state,
      stage: agent.stage,
    });
  }
  events(userId: string, id: string, after: number) {
    this.record(userId, id);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new WorkspaceError("事件游标无效");
    const bounds = this.db.agentEventBounds(userId, id);
    if (after > 0 && after < bounds.first - 1)
      throw new WorkspaceError(
        "事件游标已过期，请重新读取 conversation 快照",
        409,
      );
    const rows = this.db.agentEvents<AgentEvent>(userId, id, after);
    const events = rows.slice(0, 200);
    return {
      events,
      nextCursor: events.at(-1)?.id ?? after,
      hasMore: rows.length > 200,
    };
  }
  private addMessage(
    userId: string,
    agent: AgentRecord,
    id: string,
    text: string,
  ): AgentMessage {
    const message: AgentMessage = {
      id,
      agentId: agent.id,
      roundId: agent.currentRoundId,
      text,
      state: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.db.saveAgentMessage(userId, message);
    this.db.agentRuntime.enqueue(userId, message, agent.sessionGeneration ?? 0);
    this.event(userId, agent.id, "user", text, {
      messageId: id,
      state: "queued",
    });
    return message;
  }
  send(
    userId: string,
    id: string,
    input: { requestId: unknown; text: unknown },
    questionAnswer?: {
      permissionId: string;
      answers: unknown;
      response: Record<string, { answers: string[] }>;
    },
  ): AgentMessage {
    const agent = this.record(userId, id);
    this.task(userId, agent.taskId, true);
    const requestId = validateId(input.requestId),
      text = string(input.text, "消息", 24000);
    const fingerprint = digest(text),
      scope = `message:${id}`,
      previous = this.db.agentRequest<AgentMessage>(userId, scope, requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new WorkspaceError("同一请求 ID 的消息内容已变化", 409);
      return (
        this.db
          .agentMessages<AgentMessage>(userId, id)
          .find((m) => m.id === previous.value.id) ?? previous.value
      );
    }
    if (
      ["stopped", "failed"].includes(agent.state) ||
      (agent.state === "disconnected" && !agent.persistentHost)
    )
      throw new WorkspaceError("请先恢复或重试 Agent", 409);
    let round = this.currentRound(userId, agent);
    if (
      this.db
        .agentMessages<AgentMessage>(userId, id)
        .filter((m) => m.state === "queued").length >= 50
    )
      throw new WorkspaceError("Agent 待发送消息过多", 429);
    let message!: AgentMessage;
    this.db.transaction(() => {
      if (["accepted", "cancelled", "failed"].includes(round.state)) {
        round = this.createRound(userId, agent, {
          kind: "auto",
          objective: text.slice(0, 4000),
          expectedOutcome: "根据最新对话确定推进内容",
          acceptanceCriteria: [],
        });
        if (agent.state === "interrupted") this.setState(userId, agent, "idle");
      }
      round.state = "running";
      round.updatedAt = Date.now();
      this.db.saveAgentRound(userId, round);
      if (
        agent.state === "waiting" &&
        agent.waitReason !== "permission" &&
        !this.live.get(key(userId, id))?.permissions.size
      )
        this.setState(userId, agent, "idle");
      message = this.addMessage(userId, agent, randomUUID(), text);
      for (const question of this.db.agentRuntime
        .list<TaskQuestion>(userId, "task-question", id)
        .filter((q) => !q.resolved)) {
        this.db.agentRuntime.put(userId, "task-question", {
          ...question,
          ...{ resolved: true, freeform: text },
        });
        this.event(userId, id, "permission", "已通过对话回复", {
          permissionId: question.id,
          resolved: true,
          freeform: text,
        });
      }
      if (questionAnswer) {
        const question = this.db.agentRuntime.get<TaskQuestion>(
          userId,
          "task-question",
          questionAnswer.permissionId,
        )!;
        this.db.agentRuntime.put(userId, "task-question", {
          ...question,
          ...{ resolved: true, answers: questionAnswer.response },
        });
        this.db.agentRuntime.put(userId, "permission-answer", {
          id: question.id,
          agentId: id,
          ...{
            answers: questionAnswer.answers,
            response: { answers: questionAnswer.response },
          },
        });
        this.event(userId, id, "permission", "已回答", {
          permissionId: question.id,
          resolved: true,
          answers: questionAnswer.response,
        });
      }
      this.db.rememberAgentRequest(
        userId,
        scope,
        requestId,
        fingerprint,
        message,
      );
    });
    void this.pump(userId, id);
    return message;
  }
  async cancel(userId: string, id: string): Promise<WorkspaceAgent> {
    const agent = this.record(userId, id),
      live = this.live.get(key(userId, id));
    if (!live || !["running", "waiting"].includes(agent.state))
      throw new WorkspaceError("Agent 当前没有可取消的执行", 409);
    for (const [permissionId, permission] of live.permissions) {
      clearTimeout(permission.timer);
      permission.resolve({ outcome: { outcome: "cancelled" } });
      this.event(userId, id, "permission", "执行已取消，授权请求已取消", {
        permissionId,
        resolved: true,
      });
    }
    live.permissions.clear();
    if (agent.mode !== "tmux") {
      await live.provider?.cancel();
    } else if (agent.pane) {
      const current = (
        await this.workspaces.panes(userId, agent.environmentId)
      ).find((p) => p.id === agent.pane!.id);
      if (
        !current ||
        current.pid !== agent.pane.pid ||
        current.serverPid !== agent.pane.serverPid
      )
        throw new WorkspaceError("tmux pane 已变化，请重新关联", 409);
      await this.workspaces.executeInEnvironment(
        userId,
        agent.environmentId,
        `test "$(tmux display-message -p -t ${q(current.id)} '#{pane_pid} #{pid}')" = ${q(`${current.pid} ${current.serverPid}`)} && tmux send-keys -t ${q(current.id)} C-c`,
      );
    }
    this.setState(userId, agent, "interrupted");
    return this.public(userId, agent);
  }
  async stop(userId: string, id: string): Promise<WorkspaceAgent> {
    const agent = this.record(userId, id),
      live = this.live.get(key(userId, id));
    if (live?.provider instanceof HostSession) await live.provider.stop();
    else if (agent.persistentHost && !live && agent.hostRoot) {
      await this.workspaces.executeInEnvironment(
        userId,
        agent.environmentId,
        agentLoginCommand(
          `node ${q(agent.hostRoot + "/host.cjs")} ${q(agent.hostRoot)} stop`,
        ),
        undefined,
        undefined,
        15000,
      );
    }
    if (live) this.closeLive(live);
    this.live.delete(key(userId, id));
    this.db.revokeAgentTokens(userId, id);
    let stopError: string | undefined;
    if (agent.mode === "tmux" && agent.ownedPane && agent.pane) {
      try {
        const panes = await this.workspaces.panes(userId, agent.environmentId);
        const pane = panes.find((p) => p.id === agent.pane!.id);
        if (
          pane &&
          pane.pid === agent.pane.pid &&
          pane.serverPid === agent.pane.serverPid
        )
          await this.workspaces.executeInEnvironment(
            userId,
            agent.environmentId,
            `test "$(tmux display-message -p -t ${q(pane.id)} '#{pane_pid} #{pid}')" = ${q(`${pane.pid} ${pane.serverPid}`)} && tmux kill-pane -t ${q(pane.id)}`,
          );
      } catch {
        stopError = "执行凭据已撤销，但无法确认远端 Agent 是否停止，请核对终端";
      }
    }
    for (const message of this.db
      .agentMessages<AgentMessage>(userId, id)
      .filter((m) => ["queued", "sending"].includes(m.state))) {
      message.state = message.state === "sending" ? "unknown" : "failed";
      message.error = "Agent 连接已结束";
      message.updatedAt = Date.now();
      this.db.saveAgentMessage(userId, message);
    }
    this.setState(
      userId,
      agent,
      stopError ? "disconnected" : "stopped",
      stopError,
    );
    return this.public(userId, agent);
  }
  resume(userId: string, id: string, newSession = false): WorkspaceAgent {
    const agent = this.record(userId, id);
    if (
      agent.workArea?.dataDeletedAt ||
      agent.workArea?.cleanupStartedAt ||
      this.cleaningEnvironments.has(key(userId, agent.environmentId))
    )
      throw new WorkspaceError(
        "工作目录已清理或正在核对清理结果，请创建新的 Agent",
        409,
      );
    this.task(userId, agent.taskId, true);
    if (
      !["disconnected", "interrupted", "stopped", "failed"].includes(
        agent.state,
      )
    )
      throw new WorkspaceError("当前 Agent 无需恢复", 409);
    if (
      this.db.agentRuntime
        .list<
          import("../../../../packages/core/src/index").AgentRun
        >(userId, "run", id)
        .some((run) => run.state === "unknown")
    )
      throw new WorkspaceError("请先核对投递未知的执行结果，再继续队列", 409);
    const live = this.live.get(key(userId, id));
    if (live && !live.closing) {
      this.setState(userId, agent, "idle");
      void this.pump(userId, id);
      return this.public(userId, agent);
    }
    if (
      agent.mode !== "tmux" &&
      agent.remoteSessionId &&
      !agent.canResume &&
      !newSession
    )
      throw new WorkspaceError(
        "此 Agent 不支持恢复已有会话，请明确选择新会话",
        409,
      );
    agent.resumeExisting =
      agent.mode !== "tmux" &&
      !!agent.remoteSessionId &&
      agent.canResume &&
      !newSession;
    if (
      newSession ||
      (agent.mode === "tmux" && agent.ownedPane && agent.state === "stopped")
    ) {
      agent.remoteSessionId = undefined;
      agent.canResume = false;
      agent.hostRoot = undefined;
      agent.hostSequence = 0;
      agent.hostGeneration = (agent.hostGeneration ?? 1) + 1;
      if (agent.ownedPane && agent.state === "stopped") agent.pane = undefined;
      this.event(userId, id, "status", "开始新的远端会话，历史记录继续保留");
      const prompt = `这是 Nexus 任务的新会话。通过 ${agent.callbackOrigin}/api/agent-context/${id}?taskId=${encodeURIComponent(agent.taskId)} 读取最新任务上下文，认证使用 NEXUS_AGENT_TOKEN 或 NEXUS_AGENT_TOKEN_FILE。先核对远端文件与历史结果，旧会话的执行可能已经发生；不要自动重放历史指令。请等待用户的新消息。完成后使用上下文中的报告接口回写执行记录。`;
      this.addMessage(userId, agent, `bootstrap-${randomUUID()}`, prompt);
    }
    agent.stage = "environment";
    this.setState(userId, agent, "queued");
    void this.tick();
    return this.public(userId, agent);
  }
  retry(userId: string, id: string): WorkspaceAgent {
    const agent = this.record(userId, id);
    if (agent.state !== "failed")
      throw new WorkspaceError("只有失败的启动阶段可以重试", 409);
    const initial = this.db
      .agentMessages<AgentMessage>(userId, id)
      .find(
        (message) =>
          message.id === agent.initialMessageId && message.state === "failed",
      );
    if (initial) {
      initial.state = "queued";
      initial.error = undefined;
      initial.updatedAt = Date.now();
      this.db.saveAgentMessage(userId, initial);
    }
    return this.resume(userId, id, false);
  }
  permission(
    userId: string,
    id: string,
    permissionId: unknown,
    optionId: unknown,
  ): WorkspaceAgent {
    const agent = this.record(userId, id),
      live = this.live.get(key(userId, id));
    const permission =
      typeof permissionId === "string"
        ? live?.permissions.get(permissionId)
        : undefined;
    const answered =
      typeof permissionId === "string"
        ? this.db.agentRuntime.get<{ id: string; optionId: unknown }>(
            userId,
            "permission-answer",
            permissionId,
          )
        : null;
    if (answered) {
      if (answered.optionId !== optionId)
        throw new WorkspaceError("此请求已使用其他答案回应", 409);
      return this.public(userId, agent);
    }
    if (
      !permission ||
      (optionId !== null &&
        (typeof optionId !== "string" || !permission.options.has(optionId)))
    )
      throw new WorkspaceError("权限请求已过期或选项无效", 409);
    clearTimeout(permission.timer);
    live!.permissions.delete(permissionId as string);
    const response = {
      outcome:
        optionId === null
          ? { outcome: "cancelled" }
          : { outcome: "selected", optionId },
    };
    this.db.agentRuntime.put(userId, "permission-answer", {
      id: permissionId as string,
      agentId: id,
      ...{ optionId, response },
    });
    permission.resolve(response);
    this.event(
      userId,
      id,
      "permission",
      optionId === null ? "已拒绝授权" : "已选择授权选项",
      { permissionId, resolved: true, optionId },
    );
    this.setState(
      userId,
      agent,
      live!.permissions.size ? "waiting" : "running",
    );
    return this.public(userId, agent);
  }
  snapshot(userId: string, id: string, before?: number) {
    const agent = this.record(userId, id);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      throw new WorkspaceError("历史游标无效");
    if (!this.db.agentRuntime.get(userId, "migration", id)) {
      this.db.transaction(() => {
        for (const event of this.db.agentEvents<AgentEvent>(
          userId,
          id,
          0,
          20001,
        ))
          this.db.agentRuntime.project(userId, event);
        this.db.agentRuntime.put(userId, "migration", { id });
      });
    }
    const page = this.db.agentRuntime.page(
      userId,
      id,
      before,
      100,
      agent.mode === "tmux",
    );
    const sequence = this.db.agentEventBounds(userId, id).last;
    return {
      ...page,
      sequence,
      before: page.items[0]?.sequence,
      runs: this.db.agentRuntime
        .list<
          import("../../../../packages/core/src/index").AgentRun
        >(userId, "run", id)
        .slice(-100),
      messages: this.db.agentMessages<AgentMessage>(userId, id).slice(-100),
    };
  }
  queue(
    userId: string,
    id: string,
    messageId: string,
    input: { text?: unknown; cancel?: unknown },
  ) {
    this.record(userId, id);
    const message = this.db
      .agentMessages<AgentMessage>(userId, id)
      .find((row) => row.id === messageId);
    if (!message || message.state !== "queued")
      throw new WorkspaceError("只能修改尚未投递的消息", 409);
    this.db.transaction(() => {
      if (input.cancel === true) {
        message.state = "cancelled";
        this.db.agentRuntime.runState(userId, message.id, "cancelled");
      } else message.text = string(input.text, "消息", 24000);
      message.updatedAt = Date.now();
      this.db.saveAgentMessage(userId, message);
      this.event(userId, id, "user", message.text, {
        messageId: message.id,
        state: message.state,
      });
    });
    return message;
  }
  async reconcile(
    userId: string,
    id: string,
    runId: string,
    input: Record<string, unknown>,
  ) {
    const agent = this.record(userId, id);
    const run = this.db.agentRuntime.get<
      import("../../../../packages/core/src/index").AgentRun
    >(userId, "run", runId);
    if (!run || run.agentId !== id) throw new WorkspaceError("执行不存在", 404);
    if (!["completed", "cancelled"].includes(String(input.resolution)))
      throw new WorkspaceError("请选择已核对的执行结果");
    if (run.state === input.resolution) return run;
    if (run.state !== "unknown")
      throw new WorkspaceError("仅投递未知的执行需要人工核对", 409);
    const live = this.live.get(key(userId, id));
    if (live?.processing)
      throw new WorkspaceError("执行仍在运行，请先等待或中断", 409);
    if (live?.provider instanceof HostSession)
      await live.provider.reconcile(
        runId,
        input.resolution as "completed" | "cancelled",
      );
    else if (agent.state !== "stopped")
      throw new WorkspaceError(
        "请先连接宿主核对状态，或确认结束 Agent 后再核对",
        409,
      );
    return this.db.transaction(() => {
      const result = this.db.agentRuntime.runState(
        userId,
        runId,
        input.resolution as "completed" | "cancelled",
      );
      const message = this.db
        .agentMessages<AgentMessage>(userId, id)
        .find((row) => row.id === run.messageId);
      if (message) {
        message.state =
          input.resolution === "completed" ? "delivered" : "cancelled";
        message.error = undefined;
        message.updatedAt = Date.now();
        this.db.saveAgentMessage(userId, message);
      }
      this.event(userId, id, "status", "用户已核对执行结果；未重发指令", {
        messageId: run.messageId,
        state: message?.state,
        resolution: input.resolution,
      });
      return result;
    });
  }
  providers(userId: string) {
    return this.db.agentRuntime.providers(userId);
  }
  saveProvider(
    userId: string,
    input: Record<string, unknown>,
    id: string = randomUUID(),
  ) {
    if (!["codex", "claude", "acp"].includes(String(input.harness)))
      throw new WorkspaceError("产品无效");
    const old = this.db.agentRuntime.get<
      import("../../../../packages/core/src/index").ProviderInstance
    >(userId, "provider", id);
    const directory = string(
      input.configDirectory ?? "",
      "凭据目录",
      2048,
      true,
    );
    if (directory && (!directory.startsWith("/") || /[\r\n]/.test(directory)))
      throw new WorkspaceError("凭据目录必须是执行侧绝对路径");
    const value: import("../../../../packages/core/src/index").ProviderInstance =
      {
        id,
        name: string(input.name, "配置名称", 160),
        harness: input.harness as "codex" | "claude" | "acp",
        command: string(
          input.command ??
            (input.harness === "codex"
              ? "codex app-server"
              : input.harness === "claude"
                ? "node"
                : ""),
          "启动命令",
          4096,
        ),
        model: string(input.model ?? "", "模型", 200, true) || undefined,
        configDirectory: directory || undefined,
        createdAt: old?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
    this.db.agentRuntime.put(userId, "provider", value);
    return value;
  }
  deleteProvider(userId: string, id: string) {
    if (
      this.db
        .agentRecords<AgentRecord>(userId)
        .some(
          (row) =>
            row.providerId === id && !["stopped", "failed"].includes(row.state),
        )
    )
      throw new WorkspaceError("配置仍被 Agent 使用", 409);
    this.db.agentRuntime.remove(userId, "provider", id);
    return { deleted: true };
  }
  bindings(userId: string, taskId: string) {
    const { ancestors } = this.task(userId, taskId);
    const path = [taskId, ...ancestors.map((row) => row.id).reverse()];
    const blocked = this.sync().withStore(userId, false, (store) =>
      path.findIndex((id) =>
        store
          .getData()
          .workspaces.some((b) => b.id === id && b.mode === "disabled"),
      ),
    );
    const available = blocked >= 0 ? path.slice(0, blocked) : path;
    const seen = new Set<string>();
    return this.db.agentRuntime
      .bindings(userId)
      .filter(
        (row) =>
          available.includes(row.taskId) &&
          (row.taskId === taskId || row.inherit),
      )
      .sort((a, b) => available.indexOf(a.taskId) - available.indexOf(b.taskId))
      .filter((row) => {
        if (seen.has(row.environmentId)) return false;
        seen.add(row.environmentId);
        return true;
      })
      .map((row) => ({
        ...row,
        inherited: row.taskId !== taskId,
        environment: this.workspaces.environment(userId, row.environmentId),
      }));
  }
  bind(
    userId: string,
    taskId: string,
    input: { environmentId?: unknown; inherit?: unknown; remove?: unknown },
  ) {
    this.task(userId, taskId);
    const environment = this.workspaces.environment(
      userId,
      validateId(input.environmentId, "Workspace ID"),
    );
    const id = `${taskId}:${environment.id}`;
    if (input.remove === true) {
      this.db.agentRuntime.remove(userId, "binding", id);
      return { removed: true };
    }
    const value = {
      id,
      taskId,
      environmentId: environment.id,
      inherit: input.inherit !== false,
      createdAt: Date.now(),
    };
    this.db.agentRuntime.put(userId, "binding", value);
    return value;
  }
  private async question(
    userId: string,
    id: string,
    live: LiveAgent,
    params: any,
  ): Promise<unknown> {
    const agent = this.record(userId, id);
    if (
      live.closing ||
      params?.sessionId !== agent.remoteSessionId ||
      !Array.isArray(params.questions) ||
      !params.questions.length ||
      params.questions.length > 10
    )
      throw new WorkspaceError("问题无效");
    const permissionId = params.nexusHostRequestId
        ? digest([id, params.nexusHostRequestId])
        : randomUUID(),
      questions = params.questions.map((row: any, i: number) => ({
        id: String(row.id ?? i).slice(0, 100),
        question: String(row.question ?? row.header ?? "").slice(0, 4000),
        multiSelect: row.multiSelect === true,
        options: Array.isArray(row.options)
          ? row.options.slice(0, 20).map((v: any) => ({
              label: String(v.label ?? v.name ?? "").slice(0, 500),
              description: String(v.description ?? "").slice(0, 2000),
            }))
          : [],
      }));
    const answered = this.db.agentRuntime.get<{ response: unknown }>(
      userId,
      "permission-answer",
      permissionId,
    );
    if (answered) return answered.response;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        live.permissions.delete(permissionId);
        resolve({ answers: {} });
        if (!live.closing)
          this.event(userId, id, "permission", "问题已过期", {
            permissionId,
            resolved: true,
          });
      }, 30 * 60000);
      timer.unref();
      live.permissions.set(permissionId, {
        resolve,
        options: new Set(),
        timer,
        questions,
      });
      this.event(userId, id, "permission", "Agent 需要你补充信息", {
        permissionId,
        questions,
        resolved: false,
        sessionGeneration: live.generation,
      });
      agent.waitReason = "user";
      this.setState(userId, agent, "waiting");
    });
  }
  answer(userId: string, id: string, permissionId: unknown, answers: unknown) {
    const live = this.live.get(key(userId, id)),
      agent = this.record(userId, id);
    const pending =
      typeof permissionId === "string"
        ? live?.permissions.get(permissionId)
        : undefined;
    const prior =
      typeof permissionId === "string"
        ? this.db.agentRuntime.get<{ agentId: string; answers: unknown }>(
            userId,
            "permission-answer",
            permissionId,
          )
        : null;
    if (prior) {
      if (prior.agentId !== id)
        throw new WorkspaceError("问题不属于此 Agent", 404);
      if (digest(prior.answers) !== digest(answers))
        throw new WorkspaceError("此问题已有不同答案", 409);
      return this.public(userId, agent);
    }
    const callbackQuestion =
      typeof permissionId === "string"
        ? this.db.agentRuntime.get<TaskQuestion>(
            userId,
            "task-question",
            permissionId,
          )
        : null;
    if (callbackQuestion) {
      if (callbackQuestion.agentId !== id)
        throw new WorkspaceError("问题不属于此 Agent", 404);
      if (
        callbackQuestion.resolved ||
        callbackQuestion.roundId !== agent.currentRoundId ||
        callbackQuestion.generation !== (agent.sessionGeneration ?? 0)
      )
        throw new WorkspaceError("问题已过期或已经回复", 409);
      const response = questionAnswers(callbackQuestion.questions, answers);
      const text = callbackQuestion.questions
        .map(
          (q) => `${q.question}\n回答：${response[q.id]!.answers.join("；")}`,
        )
        .join("\n\n");
      this.send(
        userId,
        id,
        { requestId: `question-${permissionId}`, text },
        { permissionId: permissionId as string, answers, response },
      );
      return this.public(userId, this.record(userId, id));
    }
    if (!pending?.questions)
      throw new WorkspaceError("问题已过期或答案无效", 409);
    const response = questionAnswers(pending.questions, answers);
    clearTimeout(pending.timer);
    live!.permissions.delete(permissionId as string);
    this.db.agentRuntime.put(userId, "permission-answer", {
      id: permissionId as string,
      agentId: id,
      ...{ answers, response: { answers: response } },
    });
    pending.resolve({ answers: response });
    this.event(userId, id, "permission", "已回答", {
      permissionId,
      resolved: true,
      answers: response,
    });
    this.setState(
      userId,
      agent,
      live!.permissions.size ? "waiting" : "running",
    );
    return this.public(userId, agent);
  }
  async terminal(userId: string, id: string, requestId?: string) {
    const agent = this.record(userId, id),
      lock = key(userId, agent.environmentId);
    if (this.terminalOperations.has(lock))
      throw new WorkspaceError("正在准备此 Workspace 的终端，请稍后重试", 409);
    this.terminalOperations.add(lock);
    try {
      return await this.createTerminal(userId, id, requestId);
    } finally {
      this.terminalOperations.delete(lock);
    }
  }
  private async createTerminal(userId: string, id: string, requestId?: string) {
    const agent = this.record(userId, id);
    if (
      agent.workArea?.dataDeletedAt ||
      agent.workArea?.cleanupStartedAt ||
      this.cleaningEnvironments.has(key(userId, agent.environmentId))
    )
      throw new WorkspaceError("工作目录已清理或正在清理", 409);
    if (agent.terminalPolicy === "disabled")
      throw new WorkspaceError("此 Agent 禁用了终端", 409);
    if (agent.mode === "tmux" && agent.pane) return agent.pane;
    if (!agent.directory || agent.stage === "environment")
      throw new WorkspaceError("工作目录尚未就绪", 409);
    if (requestId) validateId(requestId);
    if (
      requestId &&
      (agent.terminalPanes?.length ?? 0) >= 16 &&
      !agent.terminalPanes?.some(
        (p) =>
          p.session === `nxt-${agent.id}-${digest(requestId).slice(0, 12)}`,
      )
    )
      throw new WorkspaceError(
        "每个 Agent 最多保留 16 个终端，请先结束不需要的终端",
        429,
      );
    if (!requestId && agent.terminalPane) {
      const current = (
        await this.workspaces.panes(userId, agent.environmentId)
      ).find(
        (p) =>
          p.id === agent.terminalPane!.id &&
          p.pid === agent.terminalPane!.pid &&
          p.serverPid === agent.terminalPane!.serverPid &&
          !p.dead,
      );
      if (current) return current;
    }
    const name = `nxt-${agent.id}${requestId ? "-" + digest(requestId).slice(0, 12) : ""}`,
      script = [
        "set -eu",
        'command -v tmux >/dev/null || { echo "打开持久终端需要在 Workspace 中安装 tmux" >&2; exit 1; }',
        `name=${q(name)}`,
        'if tmux has-session -t "=$name" 2>/dev/null; then',
        `test "$(tmux show-option -qv -t "=$name" @nexus_agent)" = ${q(agent.id)} || exit 1`,
        "else",
        `tmux new-session -d -s "$name" -c ${q(agent.directory)}`,
        `tmux set-option -t "=$name" @nexus_agent ${q(agent.id)}`,
        "fi",
        'tmux list-panes -t "=$name" -F "#{pane_id}"',
      ].join("\n");
    const result = await this.workspaces.executeInEnvironment(
      userId,
      agent.environmentId,
      "sh -s",
      script,
    );
    const paneId = result
      .trim()
      .split("\n")
      .find((value) => /^%\d+$/.test(value));
    // Workspace listing can be restricted to its original session; query the new target explicitly.
    const rows = await this.workspaces.panes(userId, agent.environmentId);
    let pane = rows.find((row) => row.id === paneId);
    if (!pane) {
      const raw = await this.workspaces.executeInEnvironment(
        userId,
        agent.environmentId,
        `tmux display-message -p -t ${q("=" + name)} '#{pane_id}\t#{session_id}\t#{session_name}\t#{window_id}\t#{window_name}\t#{pane_pid}\t#{pid}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_dead}'`,
      );
      const values = raw.trim().split("\t");
      if (values.length >= 10 && /^%\d+$/.test(values[0]!))
        pane = {
          id: values[0]!,
          sessionId: values[1]!,
          session: values[2]!,
          windowId: values[3]!,
          window: values[4]!,
          pid: Number(values[5]),
          serverPid: Number(values[6]),
          command: values[7]!,
          directory: values[8]!,
          dead: values[9] === "1",
        };
    }
    if (!pane) throw new WorkspaceError("终端准备失败", 502);
    const current = this.record(userId, id);
    const terminals =
      current.terminalPanes ??
      (current.terminalPane ? [current.terminalPane] : []);
    current.terminalPanes = [
      ...terminals.filter((p) => p.id !== pane!.id),
      pane,
    ];
    current.terminalPane = pane;
    this.db.saveAgentRecord(userId, current);
    return pane;
  }
  async endTerminal(userId: string, id: string, paneId: string) {
    const agent = this.record(userId, id);
    const pane = (
      agent.terminalPanes ?? (agent.terminalPane ? [agent.terminalPane] : [])
    ).find((p) => p.id === paneId);
    if (!pane) throw new WorkspaceError("终端不存在", 404);
    await this.workspaces.executeInEnvironment(
      userId,
      agent.environmentId,
      [
        "set -eu",
        `test "$(tmux display-message -p -t ${q(pane.id)} '#{pane_pid} #{pid}')" = ${q(`${pane.pid} ${pane.serverPid}`)}`,
        `test "$(tmux show-option -qv -t ${q("=" + pane.session)} @nexus_agent)" = ${q(agent.id)}`,
        `tmux kill-session -t ${q("=" + pane.session)}`,
      ].join("\n"),
    );
    const current = this.record(userId, id);
    current.terminalPanes = (current.terminalPanes ?? []).filter(
      (p) => p.id !== paneId,
    );
    if (current.terminalPane?.id === paneId)
      current.terminalPane = current.terminalPanes.at(-1);
    this.db.saveAgentRecord(userId, current);
    return { ended: true };
  }
  async workAreaPlan(userId: string, id: string) {
    const agent = this.record(userId, id),
      area = agent.workArea;
    if (!area?.owned)
      throw new WorkspaceError("此 Agent 没有可清理的独立工作目录", 409);
    const environment = this.workspaces.environment(
      userId,
      agent.environmentId,
    );
    const related = this.db
      .agentRecords<AgentRecord>(userId)
      .filter(
        (a) =>
          a.environmentId === agent.environmentId &&
          a.directory &&
          (a.directory === area.directory ||
            a.directory.startsWith(area.directory + "/") ||
            area.directory.startsWith(a.directory + "/")),
      );
    const blockers = related.flatMap((a) => [
      ...(a.state !== "stopped" ? [`${a.name} 尚未结束`] : []),
      ...(this.db.agentRuntime
        .list<
          import("../../../../packages/core/src/index").AgentRun
        >(userId, "run", a.id)
        .some((r) => r.state === "unknown")
        ? [`${a.name} 有待核对的执行结果`]
        : []),
      ...(a.terminalPanes?.length || a.terminalPane
        ? [`${a.name} 仍有人工终端`]
        : []),
      ...(a.directory !== area.directory ? [`${a.name} 引用嵌套目录`] : []),
    ]);
    if (this.terminalOperations.has(key(userId, agent.environmentId)))
      blockers.push("此 Workspace 有正在准备的终端");
    let inspection:
        | { exists: boolean; dirty: boolean; unpushed: boolean }
        | undefined,
      inspectionError: string | undefined;
    if (!area.dataDeletedAt)
      try {
        inspection = JSON.parse(
          await this.workspaces.executeInEnvironment(
            userId,
            agent.environmentId,
            "sh -s",
            workAreaScript(area, environment),
            undefined,
            30000,
          ),
        );
        if (
          !inspection ||
          typeof inspection.exists !== "boolean" ||
          typeof inspection.dirty !== "boolean" ||
          typeof inspection.unpushed !== "boolean"
        )
          throw new Error("工作目录状态无法确认");
      } catch (error) {
        inspectionError =
          error instanceof Error ? error.message : "无法检查目录";
      }
    return {
      directory: area.directory,
      branch: area.branch,
      kind: area.kind,
      dataDeletedAt: area.dataDeletedAt,
      agents: related.map((a) => ({ id: a.id, name: a.name, state: a.state })),
      artifacts: related.flatMap((a) =>
        this.db
          .agentReports<Report>(userId, a.taskId)
          .filter((r) => r.agentId === a.id)
          .flatMap((r) => r.artifacts),
      ),
      blockers,
      inspection,
      inspectionError,
    };
  }
  async cleanWorkArea(
    userId: string,
    id: string,
    input: Record<string, unknown>,
  ) {
    const agent = this.record(userId, id),
      area = agent.workArea;
    if (!area?.owned || input.confirmDirectory !== area.directory)
      throw new WorkspaceError("请确认完整工作目录路径");
    if (area.dataDeletedAt) return this.public(userId, agent);
    const lock = key(userId, agent.environmentId);
    if (this.cleaningEnvironments.has(lock))
      throw new WorkspaceError("工作目录正在清理", 409);
    this.cleaningEnvironments.add(lock);
    try {
      const plan = await this.workAreaPlan(userId, id);
      if (
        plan.blockers.length ||
        plan.inspectionError ||
        plan.inspection?.dirty ||
        plan.inspection?.unpushed
      )
        throw new WorkspaceError(
          plan.blockers.join("；") ||
            plan.inspectionError ||
            "目录有未保存数据或未推送提交，请先保存并推送",
          409,
        );
      const related = this.db
        .agentRecords<AgentRecord>(userId)
        .filter(
          (a) =>
            a.environmentId === agent.environmentId &&
            a.directory === area.directory,
        );
      for (const a of related) {
        if (a.workArea) {
          a.workArea.cleanupStartedAt = Date.now();
          this.db.saveAgentRecord(userId, a);
        }
      }
      const environment = this.workspaces.environment(
        userId,
        agent.environmentId,
      );
      await this.workspaces.executeInEnvironment(
        userId,
        agent.environmentId,
        "sh -s",
        workAreaScript(area, environment, true),
        undefined,
        30000,
      );
      for (const a of related)
        if (a.workArea) {
          a.workArea.dataDeletedAt = Date.now();
          a.workArea.cleanupStartedAt = undefined;
          this.db.agentRuntime.put(userId, "workarea", a.workArea);
          this.db.saveAgentRecord(userId, a);
          this.event(
            userId,
            a.id,
            "status",
            "已清理独立工作目录；对话、报告和 Git 分支保留",
          );
        }
      return this.get(userId, id);
    } finally {
      this.cleaningEnvironments.delete(lock);
    }
  }
  async changes(userId: string, id: string) {
    const agent = this.record(userId, id);
    if (!agent.directory) throw new WorkspaceError("目录尚未准备完成", 409);
    const result = await this.workspaces.executeInEnvironment(
      userId,
      agent.environmentId,
      `cd -- ${q(agent.directory)} && git -c core.fsmonitor=false status --porcelain=v1 && printf '\\n---NEXUS_DIFF---\\n' && git --no-pager -c core.fsmonitor=false diff HEAD --no-ext-diff --no-textconv --stat && printf '\\n---NEXUS_PATCH---\\n' && git --no-pager diff HEAD --no-ext-diff --no-textconv -- .`,
      undefined,
      undefined,
      15000,
    );
    return {
      directory: agent.directory,
      branch: agent.branch,
      source: "Workspace Git",
      updatedAt: Date.now(),
      text: result.slice(0, 200000),
      truncated: result.length > 200000,
    };
  }
  authenticate(
    token: string,
    id: string,
  ): { userId: string; agent: WorkspaceAgent } {
    const identity = /^nxa_[a-f0-9]{64}$/.test(token)
      ? this.db.findAgentToken(token)
      : null;
    if (!identity || identity.agentId !== id)
      throw new WorkspaceError("Agent 凭据无效或已过期", 404);
    const agent = this.record(identity.userId, id);
    if (
      ["stopped", "failed"].includes(agent.state) ||
      (agent.state === "disconnected" && !agent.persistentHost)
    )
      throw new WorkspaceError("Agent 会话已结束", 409);
    this.task(identity.userId, agent.taskId, true);
    this.db.renewAgentToken(token);
    return { userId: identity.userId, agent: publicAgent(agent) };
  }
  context(userId: string, id: string) {
    const agent = this.record(userId, id),
      { task, ancestors, children, resources } = this.task(
        userId,
        agent.taskId,
        true,
      );
    const base = `${agent.callbackOrigin}/api/agent-context/${id}`;
    const currentRound = this.currentRound(userId, agent),
      history = this.db
        .agentRounds<AgentRound>(userId, id)
        .filter((round) => round.id !== currentRound.id)
        .slice(-10);
    const reports = this.db
      .agentReports<Report>(userId, task.id)
      .filter((report) => report.agentId === id)
      .slice(-10);
    const environment = this.workspaces.environment(
      userId,
      agent.environmentId,
    );
    return {
      task,
      revision: this.options.readTaskRevision?.(userId, task.id) ?? null,
      ancestors,
      children,
      resources,
      contextLimit: { children: 100, resources: 100, history: 10 },
      currentRound,
      roundHistory: history,
      reports,
      repository: {
        directory: agent.directory,
        branch: agent.branch ?? environment.branch ?? null,
        source: environment.repositorySource ?? null,
        baseRef: environment.baseRef ?? environment.config.ref,
        prTarget: environment.prTarget ?? null,
      },
      agent: { id, name: agent.name, workspaceId: agent.workspaceId },
      messages: this.unread(userId, id),
      interactionGuide: AGENT_INTERACTION_GUIDE,
      questions: this.db.agentRuntime
        .list<TaskQuestion>(userId, "task-question", id)
        .slice(-10),
      messagesUrl: `${base}/messages`,
      acknowledgeUrl: `${base}/messages/ack`,
      reportUrl: `${base}/reports`,
      eventsUrl: `${base}/events`,
      descriptionUrl: `${base}/description`,
      taskUrl: `${agent.callbackOrigin}/tasks?focusTask=${encodeURIComponent(task.id)}`,
    };
  }
  updateDescription(
    userId: string,
    id: string,
    input: Record<string, unknown>,
  ): unknown {
    const agent = this.record(userId, id);
    this.task(userId, agent.taskId, true);
    if (!this.options.updateTaskDescription)
      throw new WorkspaceError("正文版本服务当前不可用", 502);
    const round = this.currentRound(userId, agent);
    if (["accepted", "cancelled"].includes(round.state))
      throw new WorkspaceError("本轮已结束，请在新轮次中修改正文", 409);
    const expectedRevisionId = validateId(
        input.expectedRevisionId,
        "正文版本 ID",
      ),
      notes = string(input.notes, "任务正文", 512000, true);
    return this.options.updateTaskDescription(userId, agent.taskId, {
      expectedRevisionId,
      notes,
      agentId: id,
      roundId: round.id,
    });
  }
  unread(userId: string, id: string): AgentMessage[] {
    const agent = this.record(userId, id);
    return this.db
      .agentMessages<AgentMessage>(userId, id)
      .filter(
        (m) =>
          !m.acknowledgedAt &&
          m.state !== "failed" &&
          (!m.roundId || m.roundId === agent.currentRoundId),
      )
      .slice(0, 100);
  }
  acknowledge(
    userId: string,
    id: string,
    ids: unknown,
  ): { acknowledged: string[] } {
    this.record(userId, id);
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((value) => typeof value !== "string")
    )
      throw new WorkspaceError("请提供最多 100 个消息 ID");
    const known = this.db
      .agentMessages<AgentMessage>(userId, id)
      .filter((message) => ids.includes(message.id));
    if (new Set(known.map((m) => m.id)).size !== new Set(ids).size)
      throw new WorkspaceError("消息不属于此 Agent", 404);
    this.db.transaction(() => {
      for (const message of known) {
        message.acknowledgedAt ??= Date.now();
        this.db.saveAgentMessage(userId, message);
      }
    });
    return { acknowledged: known.map((m) => m.id) };
  }
  callbackEvent(userId: string, id: string, input: Record<string, unknown>) {
    const agent = this.record(userId, id),
      requestId = validateId(input.requestId),
      text = string(input.text, "进展内容", 24000);
    this.task(userId, agent.taskId, true);
    if (
      !["assistant", "thought", "waiting", "running", "idle"].includes(
        String(input.kind),
      )
    )
      throw new WorkspaceError("进展类型无效");
    const questions = readQuestions(input.questions),
      suggestions = readSuggestions(input.suggestions);
    if (questions && input.kind !== "waiting")
      throw new WorkspaceError("澄清问题须使用 waiting 类型");
    const fingerprint = digest({
        kind: input.kind,
        text,
        questions,
        suggestions,
      }),
      scope = `event:${id}`,
      previous = this.db.agentRequest<AgentEvent>(userId, scope, requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new WorkspaceError("重复请求内容不一致", 409);
      return previous.value;
    }
    let event!: AgentEvent;
    this.db.transaction(() => {
      event = this.event(
        userId,
        id,
        questions
          ? "permission"
          : input.kind === "thought"
            ? "thought"
            : "assistant",
        text,
        questions
          ? {
              permissionId: digest([id, requestId]),
              questions,
              resolved: false,
              source: "callback",
            }
          : { suggestions },
      );
      const round = this.currentRound(userId, agent);
      if (questions)
        this.db.agentRuntime.put(userId, "task-question", {
          id: digest([id, requestId]),
          agentId: id,
          ...{
            questions,
            roundId: round.id,
            generation: agent.sessionGeneration ?? 0,
          },
        });
      if (!["accepted", "awaiting_review", "cancelled"].includes(round.state)) {
        if (input.kind === "waiting") round.state = "waiting_user";
        else if (input.kind === "running" || input.kind === "idle")
          round.state = "running";
        round.updatedAt = Date.now();
        this.db.saveAgentRound(userId, round);
      }
      if (["waiting", "running", "idle"].includes(String(input.kind))) {
        if (input.kind === "waiting")
          agent.waitReason = this.live.get(key(userId, id))?.permissions.size
            ? "permission"
            : "user";
        // Tool approval cannot be cleared by an Agent self-report.
        if (this.live.get(key(userId, id))?.permissions.size) {
          agent.waitReason = "permission";
          this.setState(userId, agent, "waiting");
        } else this.setState(userId, agent, input.kind as WorkspaceAgentState);
      }
      this.db.rememberAgentRequest(
        userId,
        scope,
        requestId,
        fingerprint,
        event,
      );
    });
    return event;
  }
  report(userId: string, id: string, input: Record<string, unknown>): Report {
    const agent = this.record(userId, id),
      requestId = validateId(input.requestId);
    this.task(userId, agent.taskId, true);
    const summary = string(input.summary, "工作总结", 16000),
      verification = string(input.verification ?? "", "验证结果", 8000, true),
      remaining = string(input.remaining ?? "", "遗留问题", 8000, true);
    const artifacts = input.artifacts ?? [];
    if (
      !Array.isArray(artifacts) ||
      artifacts.length > 30 ||
      artifacts.some(
        (v) =>
          typeof v !== "string" || v.length > 2048 || !/^https?:\/\//.test(v),
      )
    )
      throw new WorkspaceError(
        "产物需要使用 HTTP 或 HTTPS 链接数组，最多 30 项",
      );
    const payload = {
      summary: redact(summary),
      verification: redact(verification),
      remaining: redact(remaining),
      artifacts: (artifacts as string[]).map(redact),
      ...(input.suggestions !== undefined
        ? { suggestions: readSuggestions(input.suggestions) }
        : {}),
    };
    const fingerprint = digest({
        ...payload,
        roundId: input.roundId,
        writeBack: input.writeBack === true,
      }),
      scope = `report:${id}`,
      previous = this.db.agentRequest<Report>(userId, scope, requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new WorkspaceError("同一报告请求 ID 的内容已变化", 409);
      return previous.value;
    }
    const round = this.currentRound(userId, agent);
    if (input.roundId !== undefined && input.roundId !== round.id)
      throw new WorkspaceError("报告必须绑定当前轮次", 409);
    if (["accepted", "cancelled"].includes(round.state))
      throw new WorkspaceError("此轮次已经结束", 409);
    if (
      this.db
        .agentMessages<AgentMessage>(userId, id)
        .some(
          (message) =>
            message.roundId === round.id && message.state === "queued",
        )
    )
      throw new WorkspaceError(
        "用户有新的待处理消息，请先读取并处理后再提交本轮报告",
        409,
      );
    const report: Report = {
      ...payload,
      id: randomUUID(),
      agentId: id,
      agentName: agent.name,
      taskId: agent.taskId,
      roundId: round.id,
      createdAt: Date.now(),
    };
    const commit = () => {
      this.db.saveAgentReport(userId, report);
      this.db.rememberAgentRequest(
        userId,
        scope,
        requestId,
        fingerprint,
        report,
      );
      round.state = "awaiting_review";
      round.reportId = report.id;
      round.updatedAt = Date.now();
      this.db.saveAgentRound(userId, round);
      if (agent.state === "waiting" && agent.waitReason !== "permission")
        this.setState(userId, agent, "idle");
      this.event(userId, id, "report", summary, {
        reportId: report.id,
        roundId: round.id,
        verification,
        remaining,
        artifacts,
        writeBack: input.writeBack === true,
        suggestions: payload.suggestions,
      });
      this.event(userId, id, "status", "本轮产物已提交，等待用户验收", {
        roundId: round.id,
        roundState: "awaiting_review",
      });
    };
    if (input.writeBack === true)
      this.sync().withStore(
        userId,
        true,
        (store) => {
          const task = activeTasks(store.getData().tasks).find(
            (t) => t.id === agent.taskId,
          );
          if (!task) throw new WorkspaceError("任务不存在或已归档", 404);
          const block = [
            `<!-- nexus-agent-report:${report.id} -->`,
            `### Agent 工作记录 · ${agent.name}`,
            new Date(report.createdAt).toISOString(),
            "",
            summary,
            verification ? `\n验证结果\n${verification}` : "",
            remaining ? `\n遗留问题\n${remaining}` : "",
            artifacts.length ? `\n产物\n${artifacts.join("\n")}` : "",
            `<!-- /nexus-agent-report:${report.id} -->`,
          ]
            .filter(Boolean)
            .join("\n");
          const notes = `${task.notes || ""}${task.notes ? "\n\n" : ""}${redact(block)}`;
          if (notes.length > 100000)
            throw new WorkspaceError(
              "任务描述已超过 100000 字符，请整理历史记录后提交报告",
              422,
            );
          store.updateTask(task.id, { notes });
        },
        commit,
        { source: "agent", agentId: id, roundId: round.id },
      );
    else {
      this.task(userId, agent.taskId, true);
      this.db.transaction(commit);
    }
    return report;
  }
  private async tick() {
    if (this.closed) return;
    for (const { userId, agent } of this.db.allAgentRecords<AgentRecord>()) {
      if (
        this.cleaningEnvironments.has(key(userId, agent.environmentId)) ||
        agent.workArea?.cleanupStartedAt ||
        agent.workArea?.dataDeletedAt
      )
        continue;
      const live = this.live.get(key(userId, agent.id));
      if (live) {
        if (
          agent.mode === "tmux" &&
          agent.stage === "ready" &&
          !live.checkingPane &&
          Date.now() >= (live.nextPaneCheckAt ?? 0)
        )
          void this.checkTerminal(userId, agent, live);
        if (
          !live.recovering &&
          !live.processing &&
          ["idle", "running"].includes(agent.state)
        )
          void this.pump(userId, agent.id);
        continue;
      }
      if (
        this.live.size >= 24 ||
        [...this.live.values()].filter(
          (value) => value.userId === userId && value.processing,
        ).length >= 4
      )
        continue;
      if (this.persistentTmux(userId, agent)) {
        // Reconcile the original process before delivering any queued work.
        // No CLI launch, credential rotation or prompt replay on server restart.
        const recovered: LiveAgent = {
          userId,
          agentId: agent.id,
          abort: new AbortController(),
          token: "",
          processing: false,
          closing: false,
          permissions: new Map(),
          recovering: true,
        };
        this.live.set(key(userId, agent.id), recovered);
        void this.checkTerminal(userId, agent, recovered);
        continue;
      }
      if (
        agent.persistentHost &&
        agent.state === "disconnected" &&
        Date.now() >= (agent.reconnectAt ?? 0)
      ) {
        agent.state = "queued";
        this.db.saveAgentRecord(userId, agent);
      }
      if (!["queued", "preparing"].includes(agent.state)) continue;
      try {
        this.task(userId, agent.taskId, true);
        const environment = this.workspaces.environment(
          userId,
          agent.environmentId,
        );
        if (["queued", "preparing"].includes(environment.state)) {
          if (agent.state !== "preparing")
            this.setState(userId, agent, "preparing");
          continue;
        }
        if (environment.state !== "ready") {
          this.setState(
            userId,
            agent,
            "failed",
            `Workspace 尚不可用${environment.error ? `：${environment.error}` : `（${environment.state}）`}。请先在 Workspace 中检查或恢复环境，再重试 Agent`,
          );
          continue;
        }
        const live: LiveAgent = {
          userId,
          agentId: agent.id,
          abort: new AbortController(),
          token:
            agent.mode !== "tmux" && !agent.persistentHost
              ? this.db.createAgentToken(userId, agent.id)
              : "",
          processing: false,
          closing: false,
          permissions: new Map(),
        };
        this.live.set(key(userId, agent.id), live);
        void this.start(userId, agent, environment, live);
      } catch (reason) {
        this.setState(
          userId,
          agent,
          "failed",
          reason instanceof Error ? reason.message : "环境检查失败",
        );
      }
    }
  }
  private async start(
    userId: string,
    agent: AgentRecord,
    environment: WorkspaceEnvironment,
    live: LiveAgent,
  ) {
    try {
      agent.sessionGeneration = (agent.sessionGeneration ?? 0) + 1;
      live.generation = agent.sessionGeneration;
      agent.connectionState = "connecting";
      await this.workspaces.ensureExecutionIdentity?.(userId, environment);
      agent.stage = "agent";
      this.setState(userId, agent, "starting");
      let directory = agent.directory || environment.directory;
      if (!directory || !directory.startsWith("/"))
        throw new WorkspaceError("环境未提供绝对工作目录");
      if (agent.isolatedDirectory) {
        const root = await this.workspaces.agentWorkRoot(
          userId,
          environment,
          live.abort.signal,
        );
        directory = `${root}/nexus-agent/${agent.worktreeName ?? agent.id}`;
        await this.workspaces.executeInEnvironment(
          userId,
          agent.environmentId,
          "sh -s",
          [
            "set -eu",
            `work=${q(directory)}`,
            `id=${q(agent.id)}`,
            'test ! -L "$work"',
            'if [ -e "$work" ]; then test "$(cat "$work/.nexus-agent")" = "$id"; else mkdir -p "$work"; printf \'%s\' "$id" > "$work/.nexus-agent"; fi',
          ].join("\n"),
          live.abort.signal,
        );
      }
      if (agent.worktree) {
        const legacy =
          directory.endsWith(`/.nexus-worktrees/${agent.id}`) &&
          directory !== environment.directory;
        if (!legacy) {
          const workRoot = await this.workspaces.agentWorkRoot(
            userId,
            environment,
            live.abort.signal,
          );
          const prefix =
            agent.worktreeLayoutVersion === 2 ? "nexus-agent" : "worktrees";
          const base = environment.directory.replace(/\/$/, ""),
            worktree = `${workRoot.replace(/\/$/, "")}/${prefix}/${agent.worktreeName ?? agent.id}`,
            branch =
              agent.branch ??
              (agent.worktreeLayoutVersion === 2
                ? `nexus-agent/${agent.worktreeName ?? agent.id}`
                : agent.worktreeName
                  ? `nexus/${agent.worktreeName}`
                  : `nexus/agent-${agent.id}`);
          if (directory !== environment.directory && directory !== worktree)
            throw new WorkspaceError(
              "独立工作树使用 Workspace 管理目录，请清空单独指定的工作目录",
            );
          const baseline =
            environment.baseCommit ||
            environment.baseRef ||
            environment.config.ref ||
            "HEAD";
          const script = [
            "set -eu",
            `baseline=${q(baseline)}`,
            `base=${q(base)}`,
            `work=${q(worktree)}`,
            `branch=${q(branch)}`,
            'git -C "$base" rev-parse --is-inside-work-tree >/dev/null',
            'mkdir -p "$(dirname "$work")"',
            'if [ -e "$work/.git" ]; then',
            '  test "$(git -C "$work" rev-parse --path-format=absolute --git-common-dir)" = "$(git -C "$base" rev-parse --path-format=absolute --git-common-dir)" || { echo "已有工作树不属于此仓库" >&2; exit 1; }',
            '  test "$(git -C "$work" symbolic-ref --short HEAD)" = "$branch" || { echo "工作树分支已变化，请先核对" >&2; exit 1; }',
            "else",
            '  git -c core.hooksPath=/dev/null -C "$base" worktree add -b "$branch" "$work" "$baseline"',
            "fi",
          ].join("\n");
          await this.workspaces.executeInEnvironment(
            userId,
            agent.environmentId,
            "sh -s",
            script,
            live.abort.signal,
            120000,
          );
          directory = worktree;
          agent.directory = directory;
          agent.branch = branch;
          this.db.saveAgentRecord(userId, agent);
        }
      }
      agent.directory = directory;
      agent.workArea = {
        id: agent.id,
        agentId: agent.id,
        environmentId: agent.environmentId,
        directory,
        kind: agent.worktree ? "worktree" : "directory",
        owned: agent.worktree || agent.isolatedDirectory === true,
        branch: agent.branch,
        baseCommit: environment.baseCommit,
        createdAt: agent.createdAt,
      };
      this.db.agentRuntime.put(userId, "workarea", agent.workArea);
      this.db.saveAgentRecord(userId, agent);
      if (agent.mode === "tmux") {
        await this.startTmux(userId, agent, environment, live);
        if (live.closing || this.closed) return;
        agent.stage = "prompt";
        this.setState(userId, agent, "idle");
      } else {
        const selectedProvider = agent.providerId
          ? this.db.agentRuntime.get<
              import("../../../../packages/core/src/index").ProviderInstance
            >(userId, "provider", agent.providerId)
          : null;
        const providerEnv: Record<string, string> = {
          NEXUS_AGENT_TOKEN: live.token,
          NEXUS_AGENT_ID: agent.id,
          NEXUS_TASK_ID: agent.taskId,
          NEXUS_TASK_CONTEXT_URL: `${agent.callbackOrigin}/api/agent-context/${agent.id}?taskId=${encodeURIComponent(agent.taskId)}`,
        };
        if (agent.model || selectedProvider?.model)
          providerEnv.NEXUS_AGENT_MODEL =
            agent.model || selectedProvider!.model!;
        if (selectedProvider?.configDirectory)
          providerEnv.NEXUS_PROVIDER_ISOLATED = "1";
        if (selectedProvider?.configDirectory)
          providerEnv[
            agent.mode === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"
          ] = selectedProvider.configDirectory;
        const command =
          agent.mode === "claude"
            ? `node -e ${q(CLAUDE_BRIDGE)}`
            : selectedProvider?.command || agent.command;
        let launchCommand = command;
        if (agent.persistentHost) {
          const root = await this.workspaces.agentWorkRoot(
            userId,
            environment,
            live.abort.signal,
          );
          agent.hostRoot ??= `${root}/.nexus-sessions/${agent.id}-${agent.hostGeneration ?? 1}`;
          this.db.saveAgentRecord(userId, agent);
          if (this.db.hasAgentToken(userId, agent.id)) {
            const existing = await this.workspaces.executeInEnvironment(
              userId,
              agent.environmentId,
              `if [ -f ${q(agent.hostRoot + "/token")} ] && [ ! -L ${q(agent.hostRoot + "/token")} ]; then head -c 69 ${q(agent.hostRoot + "/token")}; fi`,
              undefined,
              live.abort.signal,
            );
            const identity = this.db.findAgentToken(existing);
            if (identity?.userId === userId && identity.agentId === agent.id) {
              live.token = existing;
              this.db.renewAgentToken(existing);
            }
          }
          if (!live.token)
            live.token = this.db.createAgentToken(userId, agent.id);
          delete providerEnv.NEXUS_AGENT_TOKEN;
          const config = {
            mode: agent.mode,
            command,
            directory,
            model: providerEnv.NEXUS_AGENT_MODEL,
            env: providerEnv,
            sessionId: agent.remoteSessionId,
          };
          await this.workspaces.executeInEnvironment(
            userId,
            agent.environmentId,
            "sh -s",
            installHostScript(agent.hostRoot, config, live.token, hostSource()),
            live.abort.signal,
            30000,
          );
          launchCommand = `node ${q(agent.hostRoot + "/host.cjs")} ${q(agent.hostRoot)}`;
        }
        const transport = await this.workspaces.openAgentTransport(
          userId,
          agent.environmentId,
          launchCommand,
          { directory, env: providerEnv, signal: live.abort.signal },
        );
        if (live.closing || this.closed) {
          transport.close();
          return;
        }
        let stderrBytes = 0;
        transport.stderr.on("data", (bytes: Buffer) => {
          if (stderrBytes > 128000 || live.closing) return;
          stderrBytes += bytes.length;
          this.event(
            userId,
            agent.id,
            "terminal",
            bytes.toString("utf8").slice(-4000),
            { stream: "stderr" },
          );
        });
        const request = (method: string, params: any) =>
          this.request(userId, agent.id, live, method, params);
        live.provider = agent.persistentHost
          ? new HostSession(
              transport,
              agent.hostSequence ?? 0,
              (event, sequence) => {
                if (
                  live.closing ||
                  this.record(userId, agent.id).sessionGeneration !==
                    live.generation
                )
                  return;
                this.db.transaction(() => {
                  this.event(userId, agent.id, event.kind, event.text, {
                    ...event.data,
                    sessionGeneration: live.generation,
                  });
                  const current = this.record(userId, agent.id);
                  current.hostSequence = sequence;
                  this.db.saveAgentRecord(userId, current);
                });
              },
              request,
            )
          : providerSession(
              agent.mode,
              transport,
              (event) => {
                if (
                  live.closing ||
                  this.record(userId, agent.id).sessionGeneration !==
                    live.generation
                )
                  return;
                this.event(userId, agent.id, event.kind, event.text, {
                  ...event.data,
                  sessionGeneration: live.generation,
                });
              },
              request,
            );
        agent.remoteSessionId = await live.provider.open({
          directory,
          sessionId: agent.resumeExisting ? agent.remoteSessionId : undefined,
          model: providerEnv.NEXUS_AGENT_MODEL,
        });
        agent.capabilities = live.provider.capabilities;
        agent.canResume = agent.capabilities.resume;
        agent.resumeExisting = false;
        agent.connectionState = "connected";
        if (live.closing || this.closed) return;
        this.db.agentRuntime.put(userId, "session", {
          id: `${agent.id}:${agent.sessionGeneration}`,
          agentId: agent.id,
          ...{
            nativeId: agent.remoteSessionId,
            generation: agent.sessionGeneration,
            state: "ready",
            capabilities: agent.capabilities,
          },
        });
        agent.stage = "prompt";
        this.setState(userId, agent, "idle");
        if (live.provider instanceof HostSession) {
          await live.provider.subscribe();
          let uncertain = false;
          for (const message of this.db.agentMessages<AgentMessage>(
            userId,
            agent.id,
          )) {
            const run = this.db.agentRuntime.get<
              import("../../../../packages/core/src/index").AgentRun
            >(userId, "run", message.id);
            if (
              ["sending", "unknown", "delivered"].includes(message.state) &&
              run &&
              !["completed", "cancelled", "failed"].includes(run.state) &&
              live.provider.hasOperation(message.id)
            ) {
              if (live.provider.operationState(message.id) === "unknown") {
                uncertain = true;
                this.db.agentRuntime.runState(userId, message.id, "unknown");
              } else {
                message.state = "queued";
                this.db.saveAgentMessage(userId, message);
              }
            } else if (message.state === "unknown") uncertain = true;
          }
          if (uncertain)
            this.setState(
              userId,
              this.record(userId, agent.id),
              "interrupted",
              "存在投递结果待核对的消息；未重发指令，请查看记录后核对执行结果",
            );
        }
        void transport.closed.then(() => {
          if (live.closing || this.closed) return;
          this.closeLive(live);
          this.live.delete(key(userId, agent.id));
          const current = this.record(userId, agent.id);
          current.connectionState = current.persistentHost
            ? "reconnecting"
            : "disconnected";
          current.reconnectAt = Date.now() + 5000;
          this.setState(
            userId,
            current,
            "disconnected",
            "Agent 连接已断开，执行结果需要核对；已保存的消息与工作目录保留",
          );
        });
      }
      if (agent.terminalPolicy === "create" && agent.mode !== "tmux")
        await this.terminal(userId, agent.id);
      void this.pump(userId, agent.id);
    } catch (reason) {
      if (live.closing || this.closed) return;
      this.closeLive(live);
      this.live.delete(key(userId, agent.id));
      const preserve =
        agent.persistentHost ||
        (live.preserveToken && transientRemoteError(reason));
      if (!preserve) this.db.revokeAgentTokens(userId, agent.id);
      const current = this.record(userId, agent.id);
      current.reconnectAt = Date.now() + 30000;
      this.setState(
        userId,
        current,
        preserve && transientRemoteError(reason) ? "disconnected" : "failed",
        reason instanceof Error ? reason.message : "Agent 启动失败",
      );
    }
  }
  private async startTmux(
    userId: string,
    agent: AgentRecord,
    environment: WorkspaceEnvironment,
    live: LiveAgent,
  ) {
    if (agent.pane) {
      const current = (
        await this.workspaces.panes(userId, agent.environmentId)
      ).find((p) => p.id === agent.pane!.id);
      if (!current) {
        if (!agent.ownedPane)
          throw new WorkspaceError("所选 pane 已退出，请重新关联");
        agent.pane = undefined;
      } else if (
        current.pid !== agent.pane.pid ||
        current.serverPid !== agent.pane.serverPid
      )
        throw new WorkspaceError("原 Agent pane 已被替换，请重新核对环境", 409);
      else if (current.dead) {
        if (!agent.ownedPane)
          throw new WorkspaceError("所选 pane 已退出，请重新关联");
        await this.workspaces.executeInEnvironment(
          userId,
          agent.environmentId,
          `test "$(tmux display-message -p -t ${q(current.id)} '#{pane_pid} #{pid}')" = ${q(`${current.pid} ${current.serverPid}`)} && tmux kill-pane -t ${q(current.id)}`,
        );
        agent.pane = undefined;
      }
      this.db.saveAgentRecord(userId, agent);
    }
    const tokenDir = `/tmp/nexus-agent-${agent.id}`,
      tokenFile = `${tokenDir}/token`;
    if (agent.pane && this.db.hasAgentToken(userId, agent.id)) {
      live.preserveToken = true;
      const existing = await this.workspaces.executeInEnvironment(
        userId,
        agent.environmentId,
        [
          `test "$(tmux display-message -p -t ${q(agent.pane.id)} '#{pane_pid} #{pid}')" = ${q(`${agent.pane.pid} ${agent.pane.serverPid}`)} || exit 1`,
          `if [ -f ${q(tokenFile)} ] && [ ! -L ${q(tokenFile)} ] && [ ! -L ${q(tokenDir)} ]; then head -c 69 ${q(tokenFile)}; fi`,
        ].join("\n"),
        undefined,
        live.abort.signal,
      );
      const identity = /^nxa_[a-f0-9]{64}$/.test(existing)
        ? this.db.findAgentToken(existing)
        : null;
      if (identity?.userId === userId && identity.agentId === agent.id) {
        live.token = existing;
        this.db.renewAgentToken(existing);
      }
    }
    if (!live.token) live.token = this.db.createAgentToken(userId, agent.id);
    const tokenTemp = `${tokenDir}/token-${randomUUID()}`;
    const script = [
      "set -eu",
      "umask 077",
      `token_dir=${q(tokenDir)}`,
      '[ ! -L \"$token_dir\" ] || exit 1',
      'if [ -e \"$token_dir\" ]; then test \"$(stat -c %u \"$token_dir\" 2>/dev/null || stat -f %u \"$token_dir\")\" = \"$(id -u)\"; chmod 700 \"$token_dir\"; else mkdir -m 700 \"$token_dir\"; fi',
      `trap ${q(`rm -f ${q(tokenTemp)}`)} EXIT`,
      `(set -C; printf '%s' ${q(live.token)} > ${q(tokenTemp)})`,
      `chmod 600 ${q(tokenTemp)}`,
      `mv -f ${q(tokenTemp)} ${q(tokenFile)}`,
    ];
    if (!agent.pane) {
      const session =
        environment.session ||
        (await this.workspaces.panes(userId, environment.id))[0]?.session;
      if (!session) throw new WorkspaceError("环境没有可用的 tmux 会话");
      const credentialFile =
        environment.credentialFile ||
        (environment.config.runtime === "ssh"
          ? environment.config.secretRef
          : "");
      const launch = agentLaunchScript(agent.command, { env: {
        ...this.workspaces.agentProxyEnvironment(userId, environment),
        NEXUS_AGENT_TOKEN_FILE: tokenFile,
        NEXUS_AGENT_ID: agent.id,
        NEXUS_TASK_ID: agent.taskId,
        NEXUS_TASK_CONTEXT_URL: `${agent.callbackOrigin}/api/agent-context/${agent.id}?taskId=${encodeURIComponent(agent.taskId)}`,
      } }, ["ssh", "linux-user"].includes(environment.config.runtime) ? credentialFile : undefined);
      const windowName = `nxa-${agent.id}`;
      script.push(
        `existing=$(tmux list-windows -t ${q("=" + session)} -F '#{window_name} #{window_id}' | while read -r name window; do [ \"$name\" != ${q(windowName)} ] || printf '%s' \"$window\"; done)`,
        'if [ -n \"$existing\" ]; then',
        `  test \"$(tmux show-option -wqv -t \"$existing\" @nexus_agent)\" = ${q(agent.id)} || { echo '同名窗口归属不明，请核对远端现场' >&2; exit 1; }`,
        `  tmux list-panes -t \"$existing\" -F '#{pane_id}'`,
        "else",
        // Park the pane until ownership and exit retention are in place. A CLI
        // that exits immediately must not disappear between new-window/set-option.
        `  pane=$(tmux new-window -d -P -F '#{pane_id}' -t ${q(session + ":")} -n ${q(windowName)} -c ${q(agent.directory)} 'exec sleep 86400')`,
        `  window=$(tmux display-message -p -t "$pane" '#{window_id}')`,
        `  tmux set-option -w -t "$window" @nexus_agent ${q(agent.id)}`,
        `  tmux set-option -w -t "$window" remain-on-exit on`,
        `  tmux respawn-pane -k -t "$pane" -c ${q(agent.directory)} ${q("sh -c " + q(launch))}`,
        // Let immediate shell/exec errors settle, preserving their output in the pane.
        `  sleep 0.15`,
        `  printf '%s\\n' "$pane"`,
        "fi",
      );
    }
    const output = await this.workspaces.executeInEnvironment(
      userId,
      agent.environmentId,
      "sh -s",
      script.join("\n"),
      live.abort.signal,
      30000,
    );
    const paneId =
      agent.pane?.id ||
      output
        .trim()
        .split("\n")
        .find((line) => /^%\d+$/.test(line));
    const pane = (
      await this.workspaces.panes(userId, agent.environmentId)
    ).find((value) => value.id === paneId);
    if (
      !pane ||
      (agent.pane &&
        (pane.pid !== agent.pane.pid ||
          pane.serverPid !== agent.pane.serverPid))
    )
      throw new WorkspaceError("所选 pane 已退出或变化，请重新关联");
    if (pane.dead) {
      if (agent.ownedPane) {
        agent.pane = pane;
        this.db.saveAgentRecord(userId, agent);
        throw await this.terminalExit(userId, agent, pane);
      }
      throw new WorkspaceError("所选 pane 已退出，请重新关联");
    }
    if (!agent.ownedPane && shells.has(pane.command.replace(/^-/, "")))
      throw new WorkspaceError("所选 pane 正在运行 Shell，请先启动 Agent");
    agent.pane = pane;
    live.nextPaneCheckAt = Date.now() + 30000;
    this.event(
      userId,
      agent.id,
      "status",
      "tmux 已连接。终端输出按原样显示，等待 Agent 回报执行状态。",
      { credentialFile: tokenFile },
    );
    const initial = this.db
      .agentMessages<AgentMessage>(userId, agent.id)
      .find((m) => m.id === agent.initialMessageId);
    if (initial?.state === "queued") {
      initial.text += `\n本会话的 Nexus API 凭据文件位于 ${tokenFile}，请读取文件作为 Bearer Token；不要输出文件内容。`;
      this.db.saveAgentMessage(userId, initial);
    }
  }
  private async terminalExit(
    userId: string,
    agent: AgentRecord,
    pane: WorkspacePane,
  ): Promise<WorkspaceError> {
    const output = await this.workspaces.executeInEnvironment(
      userId,
      agent.environmentId,
      [
        `test "$(tmux display-message -p -t ${q(pane.id)} '#{pane_pid} #{pid}')" = ${q(`${pane.pid} ${pane.serverPid}`)}`,
        `tmux display-message -p -t ${q(pane.id)} 'NEXUS_EXIT=#{pane_dead_status}'`,
        `tmux capture-pane -p -S -40 -t ${q(pane.id)}`,
      ].join(" && "),
    );
    const status = /^NEXUS_EXIT=(\d+)$/m.exec(output)?.[1];
    const detail = redact(output.replace(/^NEXUS_EXIT=.*\n?/, "").trim()).slice(
      -4000,
    );
    if (detail)
      this.event(userId, agent.id, "terminal", detail, {
        snapshot: true,
        startupFailure: agent.stage !== "ready",
      });
    return new WorkspaceError(
      `Agent ${agent.stage === "ready" ? "进程" : "启动命令"}已退出${status ? `（退出码 ${status}）` : ""}。请检查启动命令、运行环境或登录状态${detail ? `：\n${detail}` : ""}`,
      502,
    );
  }
  /** Terminal rendering uses the viewer's persistent attachment. Background work
   * only checks process identity, once per 30s, without storing screen snapshots. */
  private async checkTerminal(
    userId: string,
    agent: AgentRecord,
    live: LiveAgent,
  ) {
    if (!agent.pane || live.closing) return;
    live.checkingPane = true;
    live.nextPaneCheckAt = Date.now() + 30000;
    let exited = false;
    try {
      this.task(userId, agent.taskId, true);
      if (
        this.workspaces.environment(userId, agent.environmentId).state !==
        "ready"
      )
        throw new WorkspaceError("Workspace 尚不可用，请检查环境", 409);
      const pane = (
        await this.workspaces.panes(userId, agent.environmentId)
      ).find((value) => value.id === agent.pane?.id);
      if (live.closing) return;
      if (
        !pane ||
        pane.pid !== agent.pane.pid ||
        pane.serverPid !== agent.pane.serverPid
      )
        throw new WorkspaceError("Agent pane 已退出或被替换，请核对终端", 409);
      if (pane.dead) {
        exited = true;
        throw agent.ownedPane
          ? await this.terminalExit(userId, agent, pane)
          : new WorkspaceError("Agent 进程已退出，请核对终端", 409);
      }
      if (live.paneCheckFailures)
        this.event(userId, agent.id, "status", "已恢复远端会话状态检查");
      if (live.recovering)
        this.event(
          userId,
          agent.id,
          "status",
          "服务重启后已重新关联原 tmux 会话，凭据保持有效",
        );
      live.recovering = false;
      live.paneCheckFailures = 0;
    } catch (reason) {
      if (live.closing) return;
      if (!exited && transientRemoteError(reason)) {
        live.paneCheckFailures = (live.paneCheckFailures ?? 0) + 1;
        live.nextPaneCheckAt =
          Date.now() +
          Math.min(120000, 30000 * 2 ** Math.min(live.paneCheckFailures, 2));
        if (live.paneCheckFailures === 1)
          this.event(
            userId,
            agent.id,
            "status",
            "暂时无法检查远端连接，将稍后自动重试；原会话与指令保持不变",
          );
        return; // A failed probe is not evidence that the CLI stopped. Keep its API token valid.
      }
      this.closeLive(live);
      this.live.delete(key(userId, agent.id));
      this.db.revokeAgentTokens(userId, agent.id);
      this.setState(
        userId,
        this.record(userId, agent.id),
        "disconnected",
        reason instanceof Error ? reason.message : "终端连接断开",
      );
    } finally {
      live.checkingPane = false;
    }
  }
  private request(
    userId: string,
    id: string,
    live: LiveAgent,
    method: string,
    params: any,
  ): Promise<unknown> {
    if (method === "nexus/question")
      return this.question(userId, id, live, params);
    if (live.closing || method !== "session/request_permission")
      return Promise.reject(new Error("unsupported method"));
    const agent = this.record(userId, id);
    if (
      params?.sessionId !== agent.remoteSessionId ||
      !Array.isArray(params.options) ||
      !params.options.length ||
      params.options.length > 20 ||
      live.permissions.size >= 8
    )
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const options = params.options
      .filter(
        (option: any) =>
          typeof option?.optionId === "string" &&
          typeof option.name === "string" &&
          [
            "allow_once",
            "allow_always",
            "reject_once",
            "reject_always",
          ].includes(option.kind),
      )
      .map((option: any) => ({
        optionId: option.optionId.slice(0, 256),
        name: option.name.slice(0, 1000),
        kind: option.kind,
      }));
    if (!options.length)
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const permissionId = params.nexusHostRequestId
      ? digest([id, params.nexusHostRequestId])
      : randomUUID();
    const answered = this.db.agentRuntime.get<{
      id: string;
      response: unknown;
    }>(userId, "permission-answer", permissionId);
    if (answered) return Promise.resolve(answered.response);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        live.permissions.delete(permissionId);
        resolve({ outcome: { outcome: "cancelled" } });
        if (!live.closing) {
          const current = this.record(userId, id);
          this.event(userId, id, "permission", "授权请求已过期", {
            permissionId,
            resolved: true,
          });
          this.setState(
            userId,
            current,
            live.permissions.size ? "waiting" : "running",
          );
        }
      }, 30 * 60000);
      timer.unref();
      live.permissions.set(permissionId, {
        resolve,
        options: new Set(options.map((value: any) => value.optionId)),
        timer,
      });
      this.event(
        userId,
        id,
        "permission",
        String(params.toolCall?.title ?? "Agent 请求授权"),
        {
          permissionId,
          resolved: false,
          toolCall: params.toolCall,
          options,
          sessionGeneration: live.generation,
        },
      );
      agent.waitReason = "permission";
      this.setState(userId, agent, "waiting");
    });
  }
  private async pump(userId: string, id: string) {
    const live = this.live.get(key(userId, id));
    if (!live || live.recovering || live.processing || live.closing) return;
    if (
      [...this.live.values()].filter(
        (value) => value.userId === userId && value.processing,
      ).length >= 4
    )
      return;
    let agent = this.record(userId, id);
    if (!["idle", "running"].includes(agent.state)) return;
    const round = agent.currentRoundId
      ? this.db.agentRound<AgentRound>(userId, agent.currentRoundId)
      : null;
    const queued = this.db
      .agentMessages<AgentMessage>(userId, id)
      .filter(
        (value) =>
          value.state === "queued" &&
          (!value.roundId || value.roundId === agent.currentRoundId) &&
          (!round ||
            !["awaiting_review", "accepted", "cancelled"].includes(
              round.state,
            ) ||
            value.id.startsWith("bootstrap-")),
      );
    const message =
      queued.find((value) => value.id.startsWith("bootstrap-")) ?? queued[0];
    if (
      message &&
      this.db
        .agentRecords<AgentRecord>(userId)
        .some(
          (other) =>
            other.id !== id &&
            other.environmentId === agent.environmentId &&
            other.directory === agent.directory &&
            this.db.agentRuntime
              .list<
                import("../../../../packages/core/src/index").AgentRun
              >(userId, "run", other.id)
              .some((run) =>
                ["starting", "running", "waiting_input", "unknown"].includes(
                  run.state,
                ),
              ),
        )
    )
      return;
    if (!message) {
      if (agent.stage === "prompt") {
        agent.stage = "ready";
        this.db.saveAgentRecord(userId, agent);
      }
      return;
    }
    live.processing = true;
    let transmitted = false;
    try {
      this.task(userId, agent.taskId, true);
      if (agent.mode === "tmux") {
        const pane = (
          await this.workspaces.panes(userId, agent.environmentId)
        ).find((p) => p.id === agent.pane?.id);
        if (
          !pane ||
          pane.pid !== agent.pane?.pid ||
          pane.serverPid !== agent.pane?.serverPid
        )
          throw new WorkspaceError("目标 pane 已变化，请重新关联");
        if (pane.dead)
          throw agent.ownedPane
            ? await this.terminalExit(userId, agent, pane)
            : new WorkspaceError("所选 pane 已退出，请重新关联");
        if (!agent.ownedPane && shells.has(pane.command.replace(/^-/, "")))
          throw new WorkspaceError(
            "目标当前为 Shell，未投递工作指令，请检查 Agent 启动命令",
          );
      }
      this.db.agentRuntime.runState(userId, message.id, "starting", {
        generation: agent.sessionGeneration ?? 0,
      });
      message.state = "sending";
      message.updatedAt = Date.now();
      this.db.saveAgentMessage(userId, message);
      this.setState(userId, agent, "running");
      transmitted = true;
      if (agent.mode !== "tmux") {
        if (!live.provider || !agent.remoteSessionId)
          throw new WorkspaceError("Agent 会话未连接");
        const result = await live.provider.turn(
          message.text,
          message.id,
          (nativeTurnId) => {
            if (live.closing) return;
            this.db.transaction(() => {
              message.state = "delivered";
              message.updatedAt = Date.now();
              this.db.saveAgentMessage(userId, message);
              this.db.agentRuntime.runState(userId, message.id, "running", {
                nativeTurnId,
              });
              this.event(userId, id, "status", "Provider 已接收消息", {
                messageId: message.id,
                state: "delivered",
                nativeTurnId,
              });
            });
          },
        );
        if (
          live.closing ||
          this.closed ||
          this.record(userId, id).sessionGeneration !== live.generation
        )
          return;
        this.db.agentRuntime.runState(
          userId,
          message.id,
          result.stopReason === "cancelled"
            ? "cancelled"
            : result.stopReason === "failed"
              ? "failed"
              : "completed",
        );
        this.event(userId, id, "status", "本次执行已结束", {
          stopReason: result.stopReason,
          messageId: message.id,
        });
      } else {
        await this.workspaces.executeInEnvironment(
          userId,
          agent.environmentId,
          deliveryCommand(agent.pane!.id, message.id, true, agent.pane),
          message.text,
          live.abort.signal,
          20000,
        );
      }
      if (live.closing || this.closed) return;
      message.state = "delivered";
      message.updatedAt = Date.now();
      this.db.saveAgentMessage(userId, message);
      agent = this.record(userId, id);
      agent.stage = "ready";
      // A callback may have requested a user reply while the transport was finishing.
      if (!["interrupted", "waiting"].includes(agent.state))
        this.setState(
          userId,
          agent,
          agent.mode === "tmux" ? "running" : "idle",
        );
      this.event(userId, id, "status", "消息已投递", {
        messageId: message.id,
        state: "delivered",
      });
    } catch (reason) {
      if (
        this.closed ||
        (live.generation &&
          this.record(userId, id).sessionGeneration !== live.generation)
      )
        return;
      this.db.agentRuntime.runState(
        userId,
        message.id,
        transmitted ? "unknown" : "failed",
      );
      message.state = transmitted ? "unknown" : "failed";
      message.error = redact(
        reason instanceof Error ? reason.message : "指令投递失败",
      );
      message.updatedAt = Date.now();
      this.db.saveAgentMessage(userId, message);
      this.event(userId, id, "status", message.error, {
        messageId: message.id,
        state: message.state,
      });
      if (!live.closing && !this.closed) {
        agent = this.record(userId, id);
        this.setState(
          userId,
          agent,
          transmitted ? "disconnected" : "failed",
          message.error,
        );
        this.closeLive(live);
        this.live.delete(key(userId, id));
        if (!agent.persistentHost) this.db.revokeAgentTokens(userId, id);
      }
    } finally {
      live.processing = false;
    }
  }
}
