import { test, expect, type Page } from "@playwright/test";
import {
  account,
  tasks,
  config,
  environment,
  environmentRoutes,
} from "../workspace-fixture";
import { agentRoutes, nativeAgent, agentEvent } from "../agent-fixture";

async function setup(page: Page) {
  await environmentRoutes(page, [environment()]);
  const agents = [nativeAgent(), nativeAgent("agent-2", "审阅 Agent")];
  agents[0].state = "waiting";
  await agentRoutes(page, agents, [
    agentEvent(1, "assistant", "等待确认接口设计"),
  ]);
  const row = {
    task: tasks[1],
    taskId: tasks[1].id,
    title: tasks[1].title,
    projectId: tasks[0].id,
    projectTitle: tasks[0].title,
    agents,
    rounds: [],
    reasons: ["等待确认接口设计"],
    updatedAt: 1,
  };
  const work = {
    groups: {
      waiting: [row],
      review: [
        {
          ...row,
          task: { ...tasks[1], id: "review-task", title: "待验收任务" },
          agents: [],
          reasons: ["核对本轮交付"],
        },
      ],
      running: [],
      error: [],
    },
    counts: { waiting: 1, review: 1, running: 0, error: 0 },
  };
  await page.route("**/api/agent-workbench", (route) =>
    route.fulfill({ json: { data: work } }),
  );
  await page.goto("/settings");
  await page.locator("input[type=file]").setInputFiles({
    name: "current-work.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        tasks: [...tasks, work.groups.review[0].task],
        workspaces: [{ id: "agent-project", mode: "override", ...config }],
      }),
    ),
  });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
  return work;
}

test("current work keeps project navigation, groups by task and opens tasks in the remembered project view", async ({
  page,
  context,
}, info) => {
  await account(context);
  await setup(page);
  await page.goto("/tasks?project=agent-project&view=mindmap&scope=all");
  await expect(
    page.locator('[data-id="agent-task"].react-flow__node'),
  ).toBeVisible();
  await page
    .locator("#workspace-sidebar")
    .getByRole("link", { name: "当前工作", exact: true })
    .click();
  const board = page.getByRole("main", { name: "当前工作看板", exact: true });
  await expect(
    board.getByRole("heading", { name: "等我回复", exact: true }),
  ).toBeVisible();
  for (const name of ["待验收", "执行中", "异常"])
    await expect(
      board.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Agent 导航", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator("#workspace-sidebar")
      .getByRole("link", { name: "Agent 项目", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("#workspace-sidebar")
      .getByRole("link", { name: "本周工作", exact: true }),
  ).toBeVisible();
  const card = board.getByRole("article", {
    name: "实现任务集成",
    exact: true,
  });
  await expect(card).toHaveCount(1);
  await expect(card.locator('a[href^="/work/agents/"]')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("current-work-desktop.png") });
  await card
    .getByRole("link", { name: "打开 Task：实现任务集成", exact: true })
    .click();
  await expect(page).toHaveURL(/project=agent-project/);
  await expect(page).toHaveURL(/view=mindmap/);
  await expect(page).toHaveURL(/scope=all/);
  await expect(
    page.locator('[data-id="agent-task"].react-flow__node'),
  ).toHaveClass(/selected/);
  await expect(
    page.locator('[data-id="agent-task"].react-flow__node'),
  ).toBeInViewport();
  await page
    .locator("#workspace-sidebar")
    .getByRole("link", { name: "当前工作", exact: true })
    .click();
  await card.locator('a[href="/work/agents/agent-1"]').click();
  await expect(
    page.getByRole("region", { name: "Agent 导航", exact: true }),
  ).toBeVisible();
  const thread = page.getByRole("main", { name: "Agent 工作台", exact: true });
  await expect(
    thread.getByText("等待确认接口设计", { exact: true }),
  ).toBeVisible();
  await expect(
    thread.getByRole("link", { name: "打开 Task：实现任务集成", exact: true }),
  ).toHaveAttribute("href", /view=mindmap/);
  await thread.getByRole("link", { name: "返回当前工作", exact: true }).click();
  await expect(board).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Agent 导航", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator("#workspace-sidebar")
      .getByRole("link", { name: "Agent 项目", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#workspace-sidebar")).toBeHidden();
  await expect(
    card.getByRole("link", { name: "打开 Task：实现任务集成", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("current-work-mobile.png") });
});

test("current work refreshes task groups and a direct Agent link can locate its undated task", async ({
  page,
  context,
}) => {
  await account(context);
  const work = await setup(page);
  await page.goto("/work");
  const waiting = page.getByRole("region", { name: "等我回复", exact: true });
  await expect(waiting.getByRole("article")).toHaveCount(1);
  work.groups.running = work.groups.waiting as typeof work.groups.running;
  work.groups.waiting = [];
  await expect(waiting.getByRole("article")).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(
    page
      .getByRole("region", { name: "执行中", exact: true })
      .getByRole("article"),
  ).toHaveCount(1);
  await page.goto("/work/agents/agent-1");
  const thread = page.getByRole("main", { name: "Agent 工作台", exact: true });
  await thread
    .getByRole("link", { name: "打开 Task：实现任务集成", exact: true })
    .click();
  await expect(page).toHaveURL(/view=list/);
  await expect(page).toHaveURL(/project=agent-project/);
  await expect(page).toHaveURL(/scope=all/);
  await expect(
    page.locator('[data-row][data-task-id="agent-task"]'),
  ).toBeInViewport();
});

test("local current work has a useful empty state and does not request protected Agent data", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/api/agent-workbench", (route) => {
    reads++;
    return route.fulfill({ status: 401, json: { error: "需要登录" } });
  });
  await page.goto("/work");
  await expect(
    page.getByText("登录后可管理 Agent 工作", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "查看本周任务", exact: true }),
  ).toBeVisible();
  expect(reads).toBe(0);
});
