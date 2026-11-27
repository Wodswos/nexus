const text = { type: "string" };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const roundInput = {
  kind: {
    enum: ["auto", "clarify", "design", "explore", "implement", "deliver"],
  },
  objective: text,
  expectedOutcome: text,
  acceptanceCriteria: { type: "array", items: text, maxItems: 20 },
};
const suggestions = {
  type: "array",
  maxItems: 4,
  items: object(
    {
      label: { type: "string", maxLength: 40 },
      text: { type: "string", maxLength: 4000 },
    },
    ["label", "text"],
  ),
};
const questions = {
  type: "array",
  minItems: 1,
  maxItems: 10,
  items: object(
    {
      id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$", maxLength: 100 },
      question: { type: "string", maxLength: 4000 },
      multiSelect: { type: "boolean", default: false },
      options: {
        type: "array",
        maxItems: 20,
        items: object(
          {
            label: { type: "string", maxLength: 500 },
            description: { type: "string", maxLength: 2000 },
          },
          ["label"],
        ),
      },
    },
    ["id", "question"],
  ),
};
export const agentSecuritySchemes = {
  agentBearer: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "nxa_...",
    description:
      "仅当前 Agent 与任务可用的短期执行凭据。由 Nexus 注入执行环境，不能访问业务 REST API 或启动远端命令。",
  },
};
export const agentSchemas = {
  WorkspaceAgent: object({
    id: text,
    taskId: text,
    workspaceId: { type: "string", nullable: true },
    environmentId: text,
    name: text,
    mode: { enum: ["acp", "tmux", "codex", "claude"] },
    command: text,
    persistentSession: { type: "boolean", default: true },
    providerId: text,
    model: text,
    terminalPolicy: { enum: ["on-demand", "create", "disabled"] },
    capabilities: { type: "object", additionalProperties: true },
    prompt: text,
    directory: text,
    worktree: { type: "boolean" },
    isolatedDirectory: { type: "boolean" },
    worktreeName: {
      type: "string",
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$",
      description:
        "独立工作目录及分支名称；只用于 worktree=true，与 directory 互斥",
    },
    worktreeLayoutVersion: { type: "integer", enum: [2] },
    branch: text,
    productId: text,
    pane: ref("WorkspacePane"),
    terminalPane: ref("WorkspacePane"),
    terminalPanes: { type: "array", items: ref("WorkspacePane") },
    currentRoundId: text,
    currentRound: ref("AgentRound"),
    waitReason: { enum: ["user", "permission"] },
    state: {
      enum: [
        "queued",
        "preparing",
        "starting",
        "idle",
        "running",
        "waiting",
        "failed",
        "interrupted",
        "stopped",
        "disconnected",
      ],
    },
    stage: { enum: ["environment", "agent", "prompt", "ready"] },
    remoteSessionId: text,
    canResume: { type: "boolean" },
    error: text,
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
  }),
  CreateWorkspaceAgent: object(
    {
      requestId: text,
      workspaceId: text,
      environmentId: text,
      name: text,
      mode: { enum: ["acp", "tmux", "codex", "claude"] },
      command: text,
      persistentSession: { type: "boolean", default: true },
      providerId: text,
      model: text,
      terminalPolicy: { enum: ["on-demand", "create", "disabled"] },
      capabilities: { type: "object", additionalProperties: true },
      prompt: text,
      directory: text,
      worktree: { type: "boolean" },
      isolatedDirectory: { type: "boolean" },
      worktreeName: {
        type: "string",
        pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$",
        description:
          "独立工作目录及分支名称；只用于 worktree=true，与 directory 互斥",
      },
      productId: text,
      round: ref("AgentRoundInput"),
      pane: ref("WorkspacePane"),
    },
    ["requestId", "environmentId", "name", "mode"],
  ),
  AgentRoundInput: object(roundInput, ["kind", "objective"]),
  AgentRound: object({
    ...roundInput,
    id: text,
    agentId: text,
    taskId: text,
    sequence: { type: "integer" },
    state: {
      enum: [
        "running",
        "waiting_user",
        "awaiting_review",
        "accepted",
        "cancelled",
        "failed",
      ],
    },
    reportId: text,
    baseRevisionId: text,
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    acceptedAt: { type: "number" },
  }),
  AgentProductPreset: object({
    id: text,
    name: text,
    mode: { enum: ["acp", "tmux", "codex", "claude"] },
    command: text,
    description: text,
    verified: { type: "boolean", enum: [false] },
  }),
  AgentConnectionCheck: object({
    ok: { type: "boolean" },
    installed: { type: "boolean", nullable: true },
    protocol: {
      type: "string",
      nullable: true,
      enum: ["acp-v1", "codex-app-server", "terminal", null],
    },
    authentication: { enum: ["not_checked"] },
    message: text,
    checkedAt: { type: "number" },
    capabilities: object({ resume: { type: "boolean" } }),
  }),
  AgentWorkbenchRow: object({
    taskId: text,
    title: text,
    projectId: text,
    projectTitle: text,
    task: object({
      id: text,
      title: text,
      status: text,
      parentId: { type: "string", nullable: true },
    }),
    agents: { type: "array", items: ref("WorkspaceAgent") },
    rounds: { type: "array", items: ref("AgentRound") },
    attention: { enum: ["waiting", "review", "error", "running"] },
    reasons: { type: "array", items: text },
    latestReport: ref("AgentReport"),
    updatedAt: { type: "number" },
  }),
  AgentEvent: object({
    id: { type: "integer" },
    agentId: text,
    roundId: text,
    kind: {
      enum: [
        "user",
        "assistant",
        "thought",
        "tool",
        "plan",
        "permission",
        "status",
        "error",
        "report",
        "terminal",
      ],
    },
    text,
    data: { type: "object", additionalProperties: true },
    createdAt: { type: "number" },
  }),
  AgentEventsPage: object({
    events: { type: "array", items: ref("AgentEvent") },
    nextCursor: { type: "integer" },
    hasMore: { type: "boolean" },
  }),
  AgentMessage: object({
    id: text,
    agentId: text,
    roundId: text,
    text,
    state: {
      enum: [
        "queued",
        "sending",
        "delivered",
        "failed",
        "unknown",
        "cancelled",
      ],
    },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    acknowledgedAt: { type: "number" },
    error: text,
  }),
  AgentReport: object({
    suggestions,
    id: text,
    agentId: text,
    agentName: text,
    taskId: text,
    roundId: text,
    createdAt: { type: "number" },
    summary: text,
    verification: text,
    remaining: text,
    artifacts: {
      type: "array",
      items: { type: "string", format: "uri" },
      maxItems: 30,
    },
  }),
  AgentReportInput: object(
    {
      suggestions,
      requestId: text,
      roundId: text,
      summary: text,
      verification: text,
      remaining: text,
      artifacts: {
        type: "array",
        items: { type: "string", format: "uri" },
        maxItems: 30,
      },
      writeBack: {
        type: "boolean",
        default: false,
        description:
          "默认只保存独立报告；明确设为 true 才追加工作记录到任务正文。",
      },
    },
    ["requestId", "summary"],
  ),
};
export const agentPaths: Record<string, Record<string, unknown>> = {};
function add(
  path: string,
  method: string,
  summary: string,
  result: object,
  body?: object,
  scoped = false,
  parameters: unknown[] = [],
) {
  const params = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: text,
  }));
  agentPaths[path] ??= {};
  agentPaths[path]![method] = {
    tags: [scoped ? "Agent callbacks" : "Agents"],
    summary,
    operationId: `${method}${path.replace(/[^a-zA-Z0-9]/g, "_")}`,
    security: [scoped ? { agentBearer: [] } : { browserSession: [] }],
    parameters: [...params, ...parameters],
    ...(body
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: body } },
          },
        }
      : {}),
    responses: {
      "200": {
        description: "成功",
        content: { "application/json": { schema: object({ data: result }) } },
      },
      "400": { description: "输入无效" },
      "401": { description: "未登录或执行凭据无效" },
      "404": { description: "资源不存在或不属于当前账号／Agent" },
      "409": { description: "状态冲突或幂等请求内容变化" },
      "429": { description: "请求过多" },
      "502": { description: "运行环境连接失败" },
    },
  };
}
add(
  "/api/tasks/{taskId}/agent-prompt",
  "get",
  "生成当前任务的可编辑 Agent Prompt 模板",
  object({ prompt: text, contextUrlTemplate: text, taskUrl: text }),
);
add("/api/tasks/{taskId}/agents", "get", "列出当前任务的多个 Agent", {
  type: "array",
  items: ref("WorkspaceAgent"),
});
add(
  "/api/tasks/{taskId}/agents",
  "post",
  "创建 Agent 并在环境就绪后启动",
  ref("WorkspaceAgent"),
  ref("CreateWorkspaceAgent"),
);
add("/api/agents/{id}", "get", "查询 Agent 状态", ref("WorkspaceAgent"));
add(
  "/api/agents/{id}/events",
  "get",
  "按游标增量读取持久化对话与执行事件",
  ref("AgentEventsPage"),
  undefined,
  false,
  [
    {
      name: "after",
      in: "query",
      schema: { type: "integer", minimum: 0, default: 0 },
    },
  ],
);
add(
  "/api/agents/{id}/messages",
  "post",
  "发送后续工作消息，按 requestId 幂等",
  ref("AgentMessage"),
  object({ requestId: text, text }, ["requestId", "text"]),
);
for (const action of ["cancel", "stop", "retry"])
  add(
    `/api/agents/{id}/${action}`,
    "post",
    {
      cancel: "取消当前执行并取消尚未发送的消息",
      stop: "断开 Agent 并撤销执行凭据，保留工作目录",
      retry: "重试失败的 Agent 启动阶段",
    }[action]!,
    ref("WorkspaceAgent"),
  );
add(
  "/api/agents/{id}/resume",
  "post",
  "恢复支持 session/load 的会话，或明确创建新会话",
  ref("WorkspaceAgent"),
  object({ newSession: { type: "boolean", default: false } }),
);
add(
  "/api/agents/{id}/permissions",
  "post",
  "用户回应 ACP 权限请求",
  ref("WorkspaceAgent"),
  object(
    {
      permissionId: text,
      optionId: {
        type: "string",
        nullable: true,
        description: "null 拒绝，字符串必须为 Agent 提供的选项 ID",
      },
    },
    ["permissionId", "optionId"],
  ),
);
add(
  "/api/agent-context/{id}",
  "get",
  "Agent 获取最新正文版本、当前工作轮次、祖先／子任务／资源与未确认消息",
  object({
    task: { type: "object" },
    revision: ref("TaskRevision"),
    currentRound: ref("AgentRound"),
    roundHistory: { type: "array", items: ref("AgentRound") },
    reports: { type: "array", items: ref("AgentReport") },
    ancestors: { type: "array", items: { type: "object" } },
    children: { type: "array", items: { type: "object" } },
    resources: { type: "array", items: { type: "object" } },
    repository: { type: "object" },
    contextLimit: { type: "object" },
    interactionGuide: text,
    questions: {
      type: "array",
      description:
        "最近 10 组 REST 澄清问题，包含 resolved、answers 或 freeform。按 Agent 隔离。",
      items: { type: "object" },
    },
    messages: { type: "array", items: ref("AgentMessage") },
    messagesUrl: text,
    acknowledgeUrl: text,
    reportUrl: text,
    eventsUrl: text,
    descriptionUrl: text,
    taskUrl: text,
  }),
  undefined,
  true,
);
add(
  "/api/agent-context/{id}/messages",
  "get",
  "读取此 Agent 未确认的消息",
  { type: "array", items: ref("AgentMessage") },
  undefined,
  true,
);
add(
  "/api/agent-context/{id}/messages/ack",
  "post",
  "确认处理了指定消息，其他 Agent 不受影响",
  object({ acknowledged: { type: "array", items: text } }),
  object({ messageIds: { type: "array", items: text, maxItems: 100 } }, [
    "messageIds",
  ]),
  true,
);
add(
  "/api/agent-context/{id}/reports",
  "post",
  "保存独立报告及可选下一步建议，用户可直接回复继续；不自动完成 Task",
  ref("AgentReport"),
  ref("AgentReportInput"),
  true,
);
add(
  "/api/agent-context/{id}/events",
  "post",
  "回报结构化进展或等待用户的状态",
  ref("AgentEvent"),
  object(
    {
      requestId: text,
      kind: { enum: ["assistant", "thought", "waiting", "running", "idle"] },
      text,
      suggestions,
      questions: {
        ...questions,
        description:
          "仅 kind=waiting 时可用；生成可选择、可自定义回答的问题卡。",
      },
    },
    ["requestId", "kind", "text"],
  ),
  true,
);
add(
  "/api/agent-context/{id}/description",
  "patch",
  "按最新版本原子更新绑定 Task 正文；冲突返回 409，保留原文",
  ref("TaskRevision"),
  object(
    { expectedRevisionId: text, notes: { type: "string", maxLength: 100000 } },
    ["expectedRevisionId", "notes"],
  ),
  true,
);
add(
  "/api/agent-products",
  "get",
  "列出诚实标注兼容性未认证的产品与连接方式预设",
  { type: "array", items: ref("AgentProductPreset") },
);
add(
  "/api/agents/check",
  "post",
  "检测安装或 ACP 握手，不代表模型认证可用",
  ref("AgentConnectionCheck"),
  object(
    {
      taskId: text,
      environmentId: text,
      mode: { enum: ["acp", "tmux", "codex", "claude"] },
      command: text,
      productId: text,
      pane: ref("WorkspacePane"),
    },
    ["taskId", "environmentId", "mode"],
  ),
);
add(
  "/api/agent-workbench",
  "get",
  "按 Task 去重汇总所有项目中等待回复、待验收、异常和推进中的 Agent",
  object({
    groups: object(
      Object.fromEntries(
        ["waiting", "review", "error", "running"].map((group) => [
          group,
          { type: "array", items: ref("AgentWorkbenchRow") },
        ]),
      ),
    ),
    counts: { type: "object", additionalProperties: { type: "integer" } },
    total: { type: "integer" },
  }),
);
add("/api/agents/{id}/rounds", "get", "读取此 Agent 历次业务轮次", {
  type: "array",
  items: ref("AgentRound"),
});
add(
  "/api/agents/{id}/rounds",
  "post",
  "前一轮结束后显式开始新轮次",
  ref("AgentRound"),
  object({ ...roundInput, requestId: text, text }, [
    "requestId",
    "kind",
    "objective",
  ]),
);
add(
  "/api/agents/{id}/rounds/{roundId}/review",
  "post",
  "验收本轮、要求继续调整，或验收后明确完成 Task",
  object({
    agent: ref("WorkspaceAgent"),
    round: ref("AgentRound"),
    taskCompleted: { type: "boolean" },
  }),
  object(
    {
      requestId: text,
      action: { enum: ["accept", "revise", "complete_task"] },
      text,
    },
    ["requestId", "action"],
  ),
);
add(
  "/api/agents/{id}/rounds/{roundId}/cancel",
  "post",
  "放弃本轮：先取消执行与待发消息，保留代码和历史，不修改 Task 状态",
  object({ agent: ref("WorkspaceAgent"), round: ref("AgentRound") }),
  object({ requestId: text, text }, ["requestId"]),
);
add(
  "/api/agents/{id}/stream",
  "get",
  "SSE 实时事件，可用 after 或 Last-Event-ID 恢复；事件类型 agent-event、agent-state、ping",
  ref("AgentEvent"),
  undefined,
  false,
  [
    { name: "after", in: "query", schema: { type: "integer", minimum: 0 } },
    {
      name: "Last-Event-ID",
      in: "header",
      schema: { type: "integer", minimum: 0 },
    },
  ],
);
(
  agentPaths["/api/agents/{id}/stream"]!.get as {
    responses: Record<string, unknown>;
  }
).responses["200"] = {
  description:
    "事件流；agent-event 的 id 是持久化事件游标。agent-state 不推进游标。",
  content: { "text/event-stream": { schema: { type: "string" } } },
};
const providerSchema = object({
  id: text,
  name: text,
  harness: { enum: ["codex", "claude", "acp"] },
  command: text,
  model: text,
  configDirectory: text,
  createdAt: { type: "number" },
  updatedAt: { type: "number" },
});
add("/api/agents", "get", "当前账号的所有 Agent，包括空闲与历史会话", {
  type: "array",
  items: ref("WorkspaceAgent"),
});
add("/api/agent-providers", "get", "当前账号的产品配置，不返回凭据", {
  type: "array",
  items: providerSchema,
});
add(
  "/api/agent-providers",
  "post",
  "保存产品、模型及执行侧配置目录",
  providerSchema,
  providerSchema,
);
add(
  "/api/agent-providers/{id}",
  "put",
  "更新账号内产品配置",
  providerSchema,
  providerSchema,
);
add(
  "/api/agent-providers/{id}",
  "delete",
  "删除没有活动 Agent 引用的配置",
  object({ deleted: { type: "boolean" } }),
);
add(
  "/api/agents/{id}/conversation",
  "get",
  "分页读取稳定消息投影与事件高水位",
  object({
    items: {
      type: "array",
      items: object({
        id: text,
        agentId: text,
        kind: text,
        text,
        data: { type: "object", additionalProperties: true },
        sequence: { type: "integer" },
        createdAt: { type: "number" },
        updatedAt: { type: "number" },
      }),
    },
    sequence: { type: "integer" },
    before: { type: "integer" },
    hasMore: { type: "boolean" },
    runs: { type: "array", items: { type: "object" } },
    messages: { type: "array", items: ref("AgentMessage") },
  }),
  undefined,
  false,
  [{ name: "before", in: "query", schema: { type: "integer", minimum: 1 } }],
);
add(
  "/api/agents/{id}/messages/{messageId}",
  "patch",
  "编辑或取消尚未投递的消息；中断执行保留队列",
  ref("AgentMessage"),
  object({ text, cancel: { type: "boolean" } }),
);
add(
  "/api/agents/{id}/answers",
  "post",
  "回答当前代次的结构化问题；重复答案幂等",
  ref("WorkspaceAgent"),
  object(
    {
      permissionId: text,
      answers: {
        type: "object",
        additionalProperties: {
          oneOf: [
            text,
            { type: "array", minItems: 1, maxItems: 21, items: text },
          ],
        },
      },
    },
    ["permissionId", "answers"],
  ),
);
add(
  "/api/agents/{id}/terminal",
  "post",
  "按需创建或复用当前工作目录的终端；传 requestId 幂等创建额外终端",
  ref("WorkspacePane"),
  object({ requestId: text }),
);
add(
  "/api/agents/{id}/changes",
  "get",
  "读取当前 WorkArea 的 Git 变更（有界输出）",
  object({
    directory: text,
    branch: text,
    text,
    updatedAt: { type: "number" },
    truncated: { type: "boolean" },
  }),
);
const bindingSchema = object({
  id: text,
  taskId: text,
  environmentId: text,
  inherit: { type: "boolean" },
  inherited: { type: "boolean" },
  environment: ref("WorkspaceEnvironment"),
  createdAt: { type: "number" },
});
add(
  "/api/tasks/{taskId}/workspace-bindings",
  "get",
  "当前节点及祖先的可用 Workspace 关联",
  { type: "array", items: bindingSchema },
);
add(
  "/api/tasks/{taskId}/workspace-bindings",
  "post",
  "建立或解除节点到实例的显式关联，不改变父节点",
  bindingSchema,
  object(
    {
      environmentId: text,
      inherit: { type: "boolean", default: true },
      remove: { type: "boolean" },
    },
    ["environmentId"],
  ),
);
add(
  "/api/workspace-environments/{id}/cleanup-plan",
  "get",
  "只读预览关联 Task、Agent、存储及仓库改动",
  object({
    environmentId: text,
    managed: { type: "boolean" },
    taskIds: { type: "array", items: text },
    agents: { type: "array", items: { type: "object" } },
    terminals: { type: "array", items: object({ id: text, session: text }) },
    storage: { type: "object" },
    git: { type: "object" },
    inspectionError: text,
    dataRetained: { type: "boolean" },
  }),
);

add(
  "/api/agents/{id}/terminals/{paneId}",
  "delete",
  "按原 pane PID、server PID 与 Agent 归属结束人工终端，不停止 Agent",
  object({ ended: { type: "boolean" } }),
);
add(
  "/api/agents/{id}/runs/{runId}/reconcile",
  "post",
  "检查原生执行状态后人工核对未知结果，不重发消息",
  object({ id: text, state: text }),
  object({ resolution: { enum: ["completed", "cancelled"] } }, ["resolution"]),
);

add(
  "/api/agents/{id}/workarea/cleanup-plan",
  "get",
  "检查独立工作目录、共享引用、人工终端与代码产物",
  { type: "object" },
);
add(
  "/api/agents/{id}/workarea",
  "delete",
  "清理已结束且无未保存数据的独立目录，保留对话、报告与 Git 分支",
  ref("WorkspaceAgent"),
  object({ confirmDirectory: text }, ["confirmDirectory"]),
);
