import {
  test,
  expect,
  type Page,
  type BrowserContext,
  type Locator,
} from "@playwright/test";
import { readFile } from "node:fs/promises";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
import {
  config,
  tasks,
  workspace,
  choose,
  account,
  environment,
  environmentRoutes,
} from "../workspace-fixture";
import {
  nativeAgent,
  agentEvent,
  agentRoutes,
  agentPanel as panel,
} from "../agent-fixture";
async function seed(page: Page, bound = false) {
  await page.goto("/settings");
  await page.locator("input[type=file]").setInputFiles({
    name: "agent-ui.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        tasks,
        workspaces: [
          { id: "agent-project", mode: "override", ...config },
          ...(bound
            ? [{ id: "agent-task", mode: "inherit", environmentId: "env-1" }]
            : []),
        ],
        settings: {
          servers: [
            {
              id: "agent-host",
              name: "Agent 主机",
              host: "fixture@host.invalid",
            },
          ],
        },
      }),
    ),
  });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
  await page.goto("/tasks?project=agent-project&view=mindmap&scope=all");
  await page
    .locator('.react-flow__node[data-id="agent-task"] [data-mind-title]')
    .click();
  await expect(workspace(page)).toBeVisible();
}

function agent(id = "agent-1", name = "实现 Agent") {
  return {
    id,
    workspaceId: null,
    taskId: "agent-task",
    environmentId: "env-1",
    name,
    mode: "acp",
    command: config.agentCommand,
    prompt: "初始任务",
    directory: "/work",
    worktree: false,
    state: "idle",
    stage: "ready",
    canResume: true,
    remoteSessionId: `session-${id}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
function event(
  id: number,
  kind: string,
  text: string,
  agentId = "agent-1",
  data?: unknown,
) {
  return { id, agentId, kind, text, createdAt: 1000 + id, data };
}
test("shared Workspace creation and direct Kubernetes credentials stay outside exported configuration", async ({
  page,
  context,
}) => {
  await account(context);
  await environmentRoutes(page, []);
  await page.route("**/api/tasks/*/agents", (route) =>
    route.fulfill({ json: { data: [] } }),
  );
  const profiles: any[] = [],
    connectionWrites: any[] = [];
  await page.route("**/api/workspace-profiles", async (route) => {
    if (route.request().method() === "POST") {
      const { requestId, ...value } = route.request().postDataJSON();
      profiles.push({
        promptTemplate: "",
        id: "reusable-workspace",
        ...value,
        createdAt: 10,
        updatedAt: 10,
      });
      return route.fulfill({ json: { data: profiles[0] } });
    }
    return route.fulfill({ json: { data: profiles } });
  });
  await page.route("**/api/kubernetes-connections", async (route) => {
    if (route.request().method() === "POST") {
      const value = route.request().postDataJSON();
      connectionWrites.push(value);
      return route.fulfill({
        json: {
          data: {
            id: "kube-1",
            name: value.name,
            server: value.server,
            namespace: value.namespace,
            ca: "",
            tokenSet: true,
            certificateSet: false,
            createdAt: 10,
            updatedAt: 10,
          },
        },
      });
    }
    return route.fulfill({ json: { data: [] } });
  });
  await seed(page);
  await page
    .getByRole("button", { name: "打开 Workspace 配置", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Workspace 配置",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "创建 Workspace 模板", exact: true })
    .click();
  await dialog
    .getByLabel("Workspace 模板名称", { exact: true })
    .fill("研发环境");
  await choose(page, dialog, "运行方式", "Kubernetes Pod");
  await choose(page, dialog, "Kubernetes 连接方式", "直接连接 Kubernetes API");
  await dialog.getByRole("button", { name: "添加连接", exact: true }).click();
  await dialog
    .getByLabel("Kubernetes 连接名称", { exact: true })
    .fill("研发集群");
  await dialog
    .getByLabel("Kubernetes API Server", { exact: true })
    .fill("https://cluster.invalid:6443");
  await dialog
    .getByLabel("Kubernetes 访问 Token", { exact: true })
    .fill("fixture-kube-secret-not-for-export");
  await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Kubernetes API 连接", exact: true }),
  ).toContainText("研发集群");
  await dialog.getByLabel("Image", { exact: true }).fill("node:22");
  await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("button", { name: "打开 Workspace 配置", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "编辑此 Workspace 模板", exact: true })
    .click();
  await dialog.getByLabel("Image", { exact: true }).fill("unwanted:change");
  await dialog
    .getByRole("button", { name: "取消编辑共享配置", exact: true })
    .click();
  await expect(
    dialog.getByRole("combobox", { name: "Workspace 继承方式", exact: true }),
  ).toContainText("继承父节点");
  await choose(page, dialog, "Workspace 继承方式", "本节点覆盖");
  await expect(dialog.getByLabel("Image", { exact: true })).toHaveValue(
    "node:22",
  );
  await dialog.getByLabel("Image", { exact: true }).fill("local:override");
  await dialog
    .getByLabel("Image", { exact: true })
    .locator("..")
    .getByRole("button", { name: "恢复继承", exact: true })
    .click();
  await expect(dialog.getByLabel("Image", { exact: true })).toHaveValue(
    "node:22",
  );
  await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(connectionWrites[0].token).toBe("fixture-kube-secret-not-for-export");
  expect(profiles[0].config.kubeConnectionId).toBe("kube-1");
  expect(JSON.stringify(profiles)).not.toContain("fixture-kube-secret");
  await page.goto("/settings");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
  const download = await downloading;
  const backup = await readFile((await download.path())!, "utf8");
  expect(backup).toContain("reusable-workspace");
  expect(backup).not.toContain("fixture-kube-secret");
});

test("Agent-first creation uses a per-Agent template override and preserves project configuration", async ({
  page,
  context,
}) => {
  await account(context);
  const environments: any[] = [];
  await environmentRoutes(page, environments);
  const second = {
    id: "template-other",
    name: "独立验证模板",
    config: {
      ...config,
      runtime: "docker",
      image: "node:22",
      localRepository: "/sources/project",
      source: "local",
      ref: "main",
      branch: "test-work",
      prTarget: "main",
      workRoot: "/workspaces",
      storage: "persistent",
    },
    promptTemplate: "验证 {{task_title}}。上下文 {{task_context_url}}",
    createdAt: 1,
    updatedAt: 1,
  };
  await page.route("**/api/workspace-profiles", (route) =>
    route.fulfill({ json: { data: [second] } }),
  );
  let launch: any;
  const agents: any[] = [];
  await page.route("**/api/tasks/*/agents", (route) =>
    route.fulfill({ json: { data: agents } }),
  );
  await page.route("**/api/tasks/*/workspace-launch", (route) => {
    launch = route.request().postDataJSON();
    agents.push({ ...agent(), ...launch.agent });
    environments.push({ ...environment(), config: launch.config });
    return route.fulfill({
      json: {
        data: {
          environment: { ...environment(), config: launch.config },
          agent: agents[0],
        },
      },
    });
  });
  await agentRoutes(page, agents);
  await seed(page);
  await workspace(page)
    .getByRole("button", { name: "创建 Agent", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "创建 Agent", exact: true });
  await choose(page, dialog, "Agent Workspace 模板", "独立验证模板");
  await expect(
    dialog.getByLabel("初始 Prompt", { exact: true }),
  ).not.toHaveValue("验证 实现任务集成。上下文 {{task_context_url}}");
  const branch = await dialog
    .getByLabel("Workspace 工作分支", { exact: true })
    .inputValue();
  expect(branch).toMatch(/^nexus-agent\/workspace-/);
  expect(branch).not.toBe(second.config.branch);
  await dialog
    .getByLabel("Workspace 工作分支", { exact: true })
    .fill("nexus/design-review");
  await expect(dialog.getByText("本轮目标与验收", { exact: true })).toHaveCount(
    0,
  );
  await dialog
    .getByRole("button", { name: "创建 Workspace 与 Agent", exact: true })
    .click();
  await expect(panel(page)).toBeVisible();
  expect(launch.config).toMatchObject({
    runtime: "docker",
    localRepository: "/sources/project",
    source: "local",
    workRoot: "/workspaces",
    branch: "nexus/design-review",
    session: "",
  });
  expect(launch.agent).toMatchObject({ workspaceId: "template-other" });
  expect(launch.agent.round).toBeUndefined();
  await panel(page)
    .getByRole("link", { name: "返回任务视图", exact: true })
    .click();
  await page
    .locator('.react-flow__node[data-id="agent-task"] [data-mind-title]')
    .click();
  await workspace(page)
    .getByRole("button", { name: "创建 Agent", exact: true })
    .click();
  await expect(
    dialog.getByRole("tab", { name: "使用已有 Workspace", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await dialog
    .getByRole("tab", { name: "从模板创建新 Workspace", exact: true })
    .click();
  await expect(
    dialog.getByRole("combobox", { name: "Agent Workspace 模板", exact: true }),
  ).toContainText("使用任务 / 项目默认配置");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.goto("/settings");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
  const backup = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  expect(
    backup.data.workspaces.find((value: any) => value.id === "agent-project"),
  ).toMatchObject({ runtime: "ssh", serverId: "agent-host" });
});

test("global environment management creates a reusable template without binding a task and keeps lifecycle operations distinct", async ({
  page,
  context,
}, testInfo) => {
  await account(context);
  const env = environment(),
    profiles: any[] = [],
    actions: string[] = [];
  await environmentRoutes(page, [env]);
  await page.route("**/api/tasks/*/agents", (route) =>
    route.fulfill({ json: { data: [] } }),
  );
  await page.route("**/api/workspace-profiles", (route) => {
    if (route.request().method() === "POST") {
      const { requestId, ...value } = route.request().postDataJSON();
      profiles.push({
        promptTemplate: "",
        ...value,
        id: "global-template",
        createdAt: 1,
        updatedAt: 1,
      });
      return route.fulfill({ json: { data: profiles[0] } });
    }
    return route.fulfill({ json: { data: profiles } });
  });
  await page.route("**/api/workspace-environments/*/stop", (route) => {
    actions.push("stop");
    env.state = "paused";
    return route.fulfill({ json: { data: env } });
  });
  await page.route("**/api/workspace-environments/*/resume", (route) => {
    actions.push("resume");
    env.state = "ready";
    return route.fulfill({ json: { data: env } });
  });
  await seed(page);
  await page.goto("/workspaces");
  await page.getByRole("button", { name: "创建模板", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "创建 Workspace 模板",
    exact: true,
  });
  await dialog
    .getByLabel("Workspace 模板名称", { exact: true })
    .fill("主机开发模板");
  await choose(page, dialog, "运行方式", "SSH 主机");
  await dialog.getByText("执行身份", { exact: true }).click();
  await dialog.getByRole("checkbox", { name: "创建独立 Linux 用户" }).check();
  await choose(page, dialog, "控制主机", "Agent 主机");
  await dialog.getByLabel("本地仓库路径", { exact: true }).fill("/srv/source");
  await dialog
    .getByLabel("GitHub／Git 仓库", { exact: true })
    .fill("https://github.com/example/repo.git");
  await choose(page, dialog, "仓库来源策略", "自动 · 优先本地仓库");
  await dialog
    .getByRole("button", { name: "编辑持久化工作根目录", exact: true })
    .click();
  await dialog
    .getByLabel("持久化工作根目录", { exact: true })
    .fill("/srv/workspaces");
  await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /主机开发模板/ }),
  ).toBeVisible();
  expect(profiles[0].config).toMatchObject({
    runtime: "linux-user",
    repository: "https://github.com/example/repo.git",
    localRepository: "/srv/source",
    source: "auto",
    workRoot: "/srv/workspaces",
  });
  const environments = page.getByRole("region", {
    name: "Workspace",
    exact: true,
  });
  await environments.getByRole("button", { name: "停止", exact: true }).click();
  await expect(
    environments.getByRole("button", { name: "恢复", exact: true }),
  ).toBeVisible();
  await environments.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(
    environments.getByRole("button", { name: "停止", exact: true }),
  ).toBeVisible();
  expect(actions).toEqual(["stop", "resume"]);
  await environments
    .getByRole("button", { name: "销毁实例", exact: true })
    .click();
  const destroy = page.getByRole("dialog", {
    name: "销毁 Workspace",
    exact: true,
  });
  await expect(destroy).toContainText("持久化目录和存储会保留");
  await destroy.getByRole("button", { name: "取消", exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("environment-management.png"),
    animations: "disabled",
  });
  await page.goto("/settings");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
  const backup = JSON.parse(
    await readFile((await (await downloading).path())!, "utf8"),
  );
  expect(
    backup.data.workspaces.every(
      (binding: any) => binding.workspaceId !== "global-template",
    ),
  ).toBe(true);
  expect(
    backup.data.workspaceProfiles.some(
      (profile: any) => profile.id === "global-template",
    ),
  ).toBe(true);
});

test("ordinary week shortcut can be removed and does not return after reload", async ({
  page,
  context,
}) => {
  await account(context);
  await page.goto("/tasks?scope=week");
  const saved = page.getByRole("navigation", { name: "快捷视图", exact: true });
  const row = saved.locator('[data-saved-view="week-work"]');
  await expect(
    saved.getByRole("link", { name: "本周工作", exact: true }),
  ).toBeVisible();
  await row.hover();
  await row
    .getByRole("button", { name: "快捷视图 本周工作 菜单", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "移除快捷视图", exact: true })
    .click();
  await expect(
    saved.getByRole("link", { name: "本周工作", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page
      .getByRole("navigation", { name: "工作导航", exact: true })
      .getByRole("link", { name: "当前工作", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "快捷视图", exact: true })
      .getByRole("link", { name: "本周工作", exact: true }),
  ).toHaveCount(0);
});

test("creates a native Agent with the Workspace, preserves its prompt and defaults non-Git work to an independent directory", async ({
  page,
  context,
}) => {
  await account(context);
  const envs: any[] = [],
    rows: any[] = [],
    launches: any[] = [];
  await environmentRoutes(page, envs);
  await agentRoutes(page, rows, [
    agentEvent(1, "assistant", "正在实现", "agent-1"),
  ]);
  await page.route("**/api/tasks/*/workspace-launch", async (route) => {
    const input = route.request().postDataJSON();
    launches.push(input);
    envs.push(environment());
    rows.push({ ...nativeAgent(), ...input.agent });
    await route.fulfill({
      json: { data: { environment: envs[0], agent: rows[0] } },
    });
  });
  await seed(page);
  await workspace(page)
    .getByRole("button", { name: "创建 Workspace", exact: true })
    .click();
  const create = page.getByRole("dialog", {
    name: "创建 Workspace",
    exact: true,
  });
  await expect(
    create.getByRole("checkbox", { name: "同时创建并启动 Agent" }),
  ).toBeChecked();
  await expect(
    create.getByRole("combobox", { name: "Agent 产品", exact: true }),
  ).toContainText("Codex");
  await expect(
    create.getByRole("radio", { name: "创建空目录（不含仓库）", exact: true }),
  ).toBeChecked();
  await create.getByText("初始 Prompt", { exact: true }).click();
  await create
    .getByLabel("初始 Prompt", { exact: true })
    .fill("读取任务上下文，完成后写回；保留这个用户要求。");
  await create
    .getByRole("button", { name: "创建 Workspace 与 Agent", exact: true })
    .click();
  await expect(panel(page)).toBeVisible();
  expect(launches).toHaveLength(1);
  expect(launches[0].agent).toMatchObject({
    mode: "codex",
    command: "codex app-server",
    isolatedDirectory: true,
    worktree: false,
  });
  expect(launches[0].agent.prompt).toContain("用户要求");
  expect(launches[0].config.terminalPolicy).toBe("on-demand");
  await expect(page.getByRole("dialog", { name: "Agent 工作台" })).toHaveCount(
    0,
  );
});

test("resolved permissions survive reload and reports retain verification and artifacts", async ({
  page,
  context,
}) => {
  await account(context);
  await environmentRoutes(page, [environment()]);
  const row = { ...nativeAgent(), state: "waiting" },
    answers: any[] = [];
  const events = [
    agentEvent(1, "permission", "先前操作", "agent-1", {
      permissionId: "old",
      options: [{ optionId: "allow-old", name: "允许先前操作" }],
    }),
    agentEvent(2, "permission", "已处理", "agent-1", {
      permissionId: "old",
      resolved: true,
    }),
    agentEvent(3, "permission", "本轮检查", "agent-1", {
      permissionId: "new",
      options: [{ optionId: "allow", name: "允许本轮检查" }],
    }),
  ];
  await agentRoutes(page, [row], events, async (route, path) => {
    if (!path.endsWith("/permissions")) return false;
    answers.push(route.request().postDataJSON());
    events.push(
      agentEvent(4, "permission", "已处理", "agent-1", {
        permissionId: "new",
        resolved: true,
      }),
      agentEvent(5, "report", "完成设计", "agent-1", {
        verification: "通过 8 项检查",
        remaining: "等待验收",
        artifacts: ["https://example.com/result"],
      }),
    );
    row.state = "idle";
    row.updatedAt++;
    await route.fulfill({ json: { data: row } });
    return true;
  });
  await seed(page, true);
  await workspace(page)
    .getByRole("button", { name: /实现 Agent/ })
    .click();
  await page.reload();
  await expect(
    panel(page).getByRole("button", { name: "允许先前操作", exact: true }),
  ).toHaveCount(0);
  await panel(page)
    .getByRole("button", { name: "允许本轮检查", exact: true })
    .last()
    .click();
  await expect(panel(page).getByText("通过 8 项检查")).toBeVisible();
  await expect(
    panel(page).getByRole("link", { name: "https://example.com/result" }),
  ).toHaveAttribute("href", "https://example.com/result");
  expect(answers).toEqual([{ permissionId: "new", optionId: "allow" }]);
});

test("Agent opt-out prepares only the Workspace; terminal is an independent advanced feature", async ({
  page,
  context,
}) => {
  await account(context);
  const envs: any[] = [],
    launches: any[] = [];
  await environmentRoutes(page, envs);
  await agentRoutes(page, []);
  await page.route("**/api/tasks/*/workspace-launch", (route) => {
    launches.push(route.request().postDataJSON());
    envs.push(environment());
    return route.fulfill({ json: { data: { environment: envs[0] } } });
  });
  await seed(page);
  await workspace(page)
    .getByRole("button", { name: "创建 Workspace", exact: true })
    .click();
  let create = page.getByRole("dialog", {
    name: "创建 Workspace",
    exact: true,
  });
  await create
    .getByRole("checkbox", { name: "同时创建并启动 Agent" })
    .uncheck();
  await create
    .getByRole("button", { name: "创建 Workspace", exact: true })
    .click();
  await expect(create).toHaveCount(0);
  expect(launches[0].agent).toBeUndefined();
  await workspace(page)
    .getByRole("button", { name: "创建 Agent", exact: true })
    .click();
  create = page.getByRole("dialog", { name: "创建 Agent", exact: true });
  await create.getByText("高级设置", { exact: true }).click();
  await expect(
    create.getByRole("checkbox", { name: "同时创建人工终端" }),
  ).not.toBeChecked();
  await create.getByRole("checkbox", { name: "同时创建人工终端" }).check();
  await expect(
    create.getByRole("combobox", { name: "Agent 连接方式" }),
  ).toHaveCount(0);
});

test("reports and finished rounds permit direct conversation without workflow buttons", async ({ page, context }) => {
  await account(context);
  await environmentRoutes(page, [environment()]);
  const row = nativeAgent(), sent: string[] = [], mutations: string[] = [];
  row.currentRound = { id: "round-1", sequence: 1, state: "awaiting_review", objective: "接口设计", expectedOutcome: "设计文档", acceptanceCriteria: [] };
  await agentRoutes(page, [row], [agentEvent(1, "report", "已完成接口设计")], async (route, path) => {
    if (route.request().method() === "GET") return false;
    mutations.push(path);
    if (!path.endsWith("/messages")) return false;
    sent.push(route.request().postDataJSON().text);
    row.currentRound.state = "running";
    await route.fulfill({ json: { data: { id: "message-" + sent.length } } });
    return true;
  });
  await seed(page, true);
  for (const state of ["awaiting_review", "accepted", "cancelled"]) {
    row.currentRound.state = state;
    await page.goto("/work/agents/agent-1");
    await expect(panel(page).getByText("已完成接口设计", { exact: true })).toBeVisible();
    await expect(panel(page).getByRole("button", { name: /验收本轮|开始新一轮|提出调整/ })).toHaveCount(0);
    await panel(page).getByLabel("Agent 对话消息").fill(`继续讨论 ${state}`);
    await panel(page).getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(panel(page).getByLabel("Agent 对话消息")).toHaveValue("");
  }
  expect(sent).toHaveLength(3);
  expect(mutations).toEqual(Array(3).fill("/api/agents/agent-1/messages"));
});

test("terminal replaces the conversation and keeps one live screen, accepts Chinese input, reconnects and closes without stopping the Agent", async ({
  page,
  context,
}) => {
  await account(context);
  await environmentRoutes(page, [environment()]);
  const pane = {
    id: "%7",
    sessionId: "$1",
    session: "fixture",
    windowId: "@2",
    window: "agent",
    pid: 42,
    serverPid: 11,
    command: "agent-cli",
    directory: "/work",
    dead: false,
  };
  const row = { ...nativeAgent(), mode: "tmux", pane };
  const mutations: string[] = [];
  const history = [
    agentEvent(1, "user", "原来的工作指令"),
    agentEvent(2, "terminal", "旧的重叠快照"),
    agentEvent(3, "terminal", "最近保存的终端内容"),
    ...Array.from({ length: 270 }, (_, i) =>
      agentEvent(i + 4, "status", "连接检查"),
    ),
  ];
  await agentRoutes(page, [row], history, async (route, path) => {
    if (route.request().method() !== "GET") mutations.push(path);
    return false;
  });
  await page.route("**/api/auth/ticket?**", (route) =>
    new URL(route.request().url()).searchParams.get("purpose") ===
    "workspace-terminal"
      ? route.fulfill({ json: { ticket: "fixture" } })
      : route.continue(),
  );
  let connection: import("@playwright/test").WebSocketRoute,
    opened = 0;
  const closed = new Set<number>();
  const frames: (string | Buffer)[] = [];
  await page.routeWebSocket("**/api/workspace-terminal/attach?**", (ws) => {
    connection = ws;
    const connectionId = ++opened;
    expect(new URL(ws.url()).searchParams.get("pane")).toBe("%7");
    ws.onMessage((message) => {
      frames.push(message);
      if (message === '{"type":"start"}') {
        ws.send(JSON.stringify({ type: "ready" }));
        ws.send(Buffer.from("就绪\r\n"));
      }
    });
    ws.onClose(() => {
      closed.add(connectionId);
    });
  });
  await seed(page, true);
  await workspace(page)
    .getByRole("button", { name: /实现 Agent/ })
    .click();
  const terminal = panel(page).getByRole("region", { name: "Agent 终端会话" });
  await expect(terminal).toHaveCount(0);
  await expect(
    panel(page).getByText("原来的工作指令", { exact: true }),
  ).toBeVisible();
  const note = panel(page).getByRole("complementary", { name: "终端接入说明" });
  await expect(note).toContainText("旧版未采集结构化回复");
  await expect(
    panel(page).getByText("最近保存的终端快照（非完整对话）", { exact: true }),
  ).toHaveCount(1);
  await panel(page)
    .getByText("最近保存的终端快照（非完整对话）", { exact: true })
    .click();
  await expect(
    panel(page).getByText("最近保存的终端内容", { exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByText("旧的重叠快照", { exact: true }),
  ).toHaveCount(0);
  await panel(page).getByLabel("Agent 对话消息").fill("切换终端保留的草稿");
  await note.getByRole("button", { name: "查看原终端", exact: true }).click();
  await expect(panel(page).getByLabel("Agent 对话消息")).toBeHidden();
  await expect(panel(page).getByLabel("Agent 对话记录")).toBeHidden();
  await expect(panel(page).getByRole("button", { name: "返回对话", exact: true })).toBeVisible();
  await expect(terminal.getByRole("status")).toHaveText("已连接");
  expect((await terminal.boundingBox())!.height).toBeGreaterThan(600);
  await page.screenshot({path:test.info().outputPath('legacy-terminal-main-area.png')});
  const screen = await terminal.locator(".xterm-screen").elementHandle();
  for (let i = 0; i < 5; i++) connection!.send(Buffer.from(`进度 ${i}\r\n`));
  expect(await screen!.evaluate((e) => e.isConnected)).toBe(true);
  await terminal.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText("你好，继续工作");
  await page.keyboard.press("Escape");
  await terminal.getByRole("button", { name: "Enter", exact: true }).click();
  await expect.poll(() => frames.join("")).toContain("你好，继续工作");
  await expect.poll(() => frames.join("")).toContain("\u001b");
  await panel(page).getByRole("button", { name: "终端全屏" }).click();
  await expect(terminal).toBeVisible();
  connection!.send(
    JSON.stringify({
      type: "exit",
      reason: "Connection reset",
      retryable: true,
    }),
  );
  await connection!.close({ code: 1000 });
  await expect.poll(() => opened).toBeGreaterThan(1);
  await expect(terminal.getByRole("status")).toHaveText("已连接");
  await panel(page)
    .getByRole("button", { name: "关闭终端", exact: true })
    .click();
  await expect(terminal).toHaveCount(0);
  await expect(panel(page).getByLabel("Agent 对话消息")).toHaveValue("切换终端保留的草稿");
  await expect(panel(page).getByLabel("Agent 对话记录")).toBeVisible();
  await expect.poll(() => closed.size === opened).toBe(true);
  expect(mutations).toEqual(["/api/agents/agent-1/terminal"]);
  await page.screenshot({path:test.info().outputPath('legacy-agent-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('#workspace-sidebar')).toBeHidden();
  await expect(note.getByRole('button',{name:'查看原终端',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath('legacy-agent-mobile.png')});

});

test("SSE duplicate events are projected once and deleted Workspace disables new work", async ({
  page,
  context,
}) => {
  await account(context);
  const env = { ...environment(), dataClearedAt: 123 };
  await environmentRoutes(page, [env]);
  const row = { ...nativeAgent(), state: "disconnected" };
  await agentRoutes(page, [row], [], async (route, path) => {
    if (!path.endsWith("/stream")) return false;
    const item = agentEvent(1, "assistant", "推送只出现一次", "agent-1", {
      messageId: "native-1",
      delta: true,
    });
    await route.fulfill({
      contentType: "text/event-stream",
      body: `id: 1\nevent: agent-event\ndata: ${JSON.stringify(item)}\n\nid: 1\nevent: agent-event\ndata: ${JSON.stringify(item)}\n\n`,
    });
    return true;
  });
  await seed(page, true);
  await expect(
    workspace(page).getByRole("button", { name: "创建 Agent", exact: true }),
  ).toBeDisabled();
  await workspace(page)
    .getByRole("button", { name: /实现 Agent/ })
    .click();
  await expect(
    panel(page).getByText("推送只出现一次", { exact: true }),
  ).toHaveCount(1);
  await expect(panel(page)).toContainText("Workspace 数据已移除");
  await expect(
    panel(page).getByRole("button", { name: "恢复会话" }),
  ).toBeDisabled();
});
