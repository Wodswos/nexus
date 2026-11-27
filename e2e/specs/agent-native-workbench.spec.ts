import { test, expect } from "@playwright/test";
import {
  account,
  environmentRoutes,
  environment,
  tasks,
  config,
} from "../workspace-fixture";
import { applyConversationEvent } from "../../apps/web/src/features/work/conversation";
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
const agent = (id = "agent-1") => ({
  id,
  name: id === "agent-1" ? "日历优化" : "方案审阅",
  taskId: "agent-task",
  environmentId: "env-1",
  workspaceId: null,
  mode: "codex",
  command: "codex app-server",
  prompt: "初始工作",
  directory: "/work",
  worktree: false,
  state: "idle",
  stage: "ready",
  canResume: true,
  remoteSessionId: "thread-" + id,
  createdAt: 1000,
  updatedAt: 1000,
});
test("routed conversations retain account-scoped drafts, IME, history position and compact tools", async ({
  page,
  context,
}, info) => {
  await account(context);
  await environmentRoutes(page, [environment()]);
  const rows = [agent(), agent("agent-2")],
    sends: any[] = [],
    events: any[] = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      agentId: "agent-1",
      kind: i % 2 ? "assistant" : "user",
      text: `历史内容 ${i + 1}。这是一段需要保持阅读位置的文字。`,
      data: { messageId: `m-${i}`, state: "delivered" },
      createdAt: 1000 + i,
    }));
  events.push({
    id: 51,
    agentId: "agent-1",
    kind: "tool",
    text: "运行 pnpm test",
    data: { toolCallId: "t1", status: "completed", rawOutput: "固定工具日志" },
    createdAt: 1051,
  });
  await page.route("**/api/agents", (r) => r.fulfill({ json: { data: rows } }));
  await page.route("**/api/tasks/*/agents", (r) =>
    r.fulfill({ json: { data: rows } }),
  );
  await page.route("**/api/agents/**", async (route) => {
    const url = new URL(route.request().url()),
      id = url.pathname.split("/")[3],
      row = rows.find((v) => v.id === id)!;
    const history = id === "agent-1" ? events : [];
    if (url.pathname.endsWith("/stream"))
      return route.fulfill({ status: 503, body: "use polling" });
    if (url.pathname.endsWith("/conversation"))
      return route.fulfill({
        json: {
          data: {
            items: history.reduce(applyConversationEvent, []),
            sequence: history.at(-1)?.id ?? 0,
            hasMore: false,
            messages: [],
            runs: [],
          },
        },
      });
    if (url.pathname.endsWith("/events"))
      return route.fulfill({
        json: {
          data: {
            events: history.filter(
              (e) => e.id > Number(url.searchParams.get("after")),
            ),
            hasMore: false,
            nextCursor: history.at(-1)?.id ?? 0,
          },
        },
      });
    if (url.pathname.endsWith("/messages")) {
      sends.push(route.request().postDataJSON());
      if (sends.length === 1)
        return route.fulfill({
          status: 502,
          json: { error: "网络中断，请重试" },
        });
      events.push({
        id: events.length + 1,
        agentId: id,
        kind: "user",
        text: sends.at(-1).text,
        data: { messageId: "new-message", state: "queued" },
        createdAt: Date.now(),
      });
      return route.fulfill({ json: { data: { id: "new-message" } } });
    }
    if (url.pathname.endsWith("/changes"))
      return route.fulfill({
        json: {
          data: {
            text: "diff --git a/test.ts b/test.ts\n+fixed",
            updatedAt: 1000,
            truncated: false,
          },
        },
      });
    return route.fulfill({ json: { data: row } });
  });
  await page.goto("/settings");
  await page.locator("input[type=file]").setInputFiles({
    name: "native.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        tasks,
        workspaces: [{ id: "agent-project", mode: "override", ...config }],
      }),
    ),
  });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
  await page.goto("/work/agents/agent-1");
  const shell = page.getByRole("main", { name: "Agent 工作台" });
  await expect(shell.getByText("运行 pnpm test")).toBeVisible();
  await expect(shell.getByText("固定工具日志")).toBeHidden();
  await shell.getByText("运行 pnpm test").click();
  await expect(shell.getByText("固定工具日志")).toBeVisible();
  const input = shell.getByLabel("Agent 对话消息");
  await shell.getByRole("button", { name: "添加引用", exact: true }).click();
  const reference = page.getByRole("dialog", { name: "添加引用", exact: true });
  await reference
    .getByRole("textbox", { name: "引用文件路径" })
    .fill("src/example.ts");
  await reference
    .getByRole("button", { name: "引用文件", exact: true })
    .click();
  await expect(input).toHaveValue(/src\/example.ts/);
  await input.fill("尚未发送的中文草稿");
  await page
    .getByRole("region", { name: "Agent 导航" })
    .getByRole("link")
    .filter({ hasText: "方案审阅" })
    .click();
  await expect(input).toHaveValue("");
  await page
    .getByRole("region", { name: "Agent 导航" })
    .getByRole("link")
    .filter({ hasText: "日历优化" })
    .click();
  await expect(input).toHaveValue("尚未发送的中文草稿");
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  expect(sends).toHaveLength(0);
  await input.dispatchEvent("compositionend");
  await shell.getByRole("button", { name: "发送消息" }).click();
  await expect(shell.getByRole("alert")).toContainText("网络中断");
  await shell.getByRole("button", { name: "发送消息" }).click();
  await expect(input).toHaveValue("");
  expect(sends).toHaveLength(2);
  expect(sends[0]).toEqual(sends[1]);
  const scroll = shell.getByLabel("Agent 对话记录");
  await scroll.evaluate((e) => {
    e.scrollTop = 0;
    e.dispatchEvent(new Event("scroll"));
  });
  events.push({
    id: events.length + 1,
    agentId: "agent-1",
    kind: "assistant",
    text: "新进展",
    data: { messageId: "live" },
    createdAt: Date.now(),
  });
  await expect(shell.getByRole("button", { name: "有新内容" })).toBeVisible();
  expect(await scroll.evaluate((e) => e.scrollTop)).toBeLessThan(20);
  await shell.getByRole("button", { name: "查看详情" }).click();
  await shell.getByRole("button", { name: "变更", exact: true }).click();
  await expect(
    shell.getByText("diff --git a/test.ts b/test.ts", { exact: false }),
  ).toBeVisible();
  await shell.getByRole("button", { name: "关闭详情" }).click();
  await page.screenshot({ path: info.outputPath("agent-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#workspace-sidebar")).toBeHidden();
  await expect(input).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("agent-mobile.png") });
});

test("large conversation pages history, bounds tool output, and keeps local controls responsive in light and dark layouts", async ({
  page,
  context,
  browser,
}, info) => {
  await account(context);
  await environmentRoutes(page, [environment()]);
  const { agentRoutes, agentEvent, nativeAgent } = await import(
    "../agent-fixture"
  );
  const row = nativeAgent(),
    events = Array.from({ length: 1000 }, (_, i) =>
      agentEvent(
        i + 1,
        i % 2 ? "assistant" : "user",
        `第 ${i + 1} 项上下文。\n这是一个固定的长会话样本。`,
        "agent-1",
        { messageId: "native-" + i },
      ),
    );
  events.push(
    agentEvent(1001, "tool", "构建日志 10000 行", "agent-1", {
      toolCallId: "large-tool",
      status: "completed",
      rawOutput: Array.from(
        { length: 10000 },
        (_, i) => `日志第 ${i + 1} 行：验证独立 Workspace 中的构建结果。`,
      ).join("\n"),
    }),
  );
  await agentRoutes(
    page,
    [row, nativeAgent("agent-2"), nativeAgent("agent-3")],
    events,
    async (route, path) => {
      if (!path.endsWith("/conversation")) return false;
      const before =
        Number(new URL(route.request().url()).searchParams.get("before")) ||
        1002;
      const items = events
        .filter((e) => e.id < before)
        .slice(-100)
        .reduce(applyConversationEvent, []);
      await route.fulfill({
        json: {
          data: {
            items,
            sequence: 1001,
            before: items[0]?.sequence,
            hasMore: (items[0]?.sequence ?? 1) > 1,
            runs: [],
            messages: [],
          },
        },
      });
      return true;
    },
  );
  await page.goto("/work/agents/agent-1");
  const shell = page.getByRole("main", { name: "Agent 工作台" });
  await expect(shell.getByText("构建日志 10000 行")).toBeVisible();
  await expect(shell.locator("[data-message-id]")).toHaveCount(100);
  await shell.getByText("构建日志 10000 行").click();
  await expect(
    shell.getByRole("button", { name: "显示更多日志" }),
  ).toBeVisible();
  expect(await shell.locator("pre").last().textContent()).not.toContain(
    "日志第 10000 行",
  );
  const scroll = shell.getByLabel("Agent 对话记录");
  await scroll.evaluate((e) => {
    e.scrollTop = 0;
    e.dispatchEvent(new Event("scroll"));
  });
  await shell.getByRole("button", { name: "加载更早的消息" }).click();
  await expect(shell.locator("[data-message-id]")).toHaveCount(200);
  const times = await page.evaluate(async () => {
    const values: number[] = [];
    for (let i = 0; i < 20; i++) {
      const button = document.querySelector<HTMLButtonElement>(
        'button[aria-label="查看详情"]',
      )!;
      const start = performance.now();
      button.click();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      values.push(performance.now() - start);
    }
    return values.sort((a, b) => a - b);
  });
  await info.attach("local-interaction-budget", {
    body: JSON.stringify({
      browser: browser.version(),
      sample: "1000 conversation items, 10000 log lines, 3 Agents",
      renderedItems: 200,
      p95Ms: times[18],
      measurements: times,
    }),
    contentType: "application/json",
  });
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(
      info.outputPath("local-interaction-budget.json"),
      JSON.stringify(
        {
          browser: browser.version(),
          sample: "1000 conversation items, 10000 log lines, 3 Agents",
          renderedItems: 200,
          p95Ms: times[18],
          measurements: times,
        },
        null,
        2,
      ),
    ),
  );
  expect(times[18]).toBeLessThan(250);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({ path: info.outputPath("agent-large-dark.png") });
  for (const width of [1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(shell.getByLabel("Agent 对话消息")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(page.locator("#workspace-sidebar")).toBeHidden();
  await page.screenshot({
    path: info.outputPath("agent-large-mobile-dark.png"),
  });
});

test("cached conversations recover after a failed opening and work area cleanup requires the exact path", async ({
  page,
  context,
}) => {
  const { agentRoutes, agentEvent, nativeAgent } = await import(
    "../agent-fixture"
  );
  await account(context);
  await environmentRoutes(page, [environment()]);
  const row = nativeAgent();
  row.state = "stopped";
  row.workArea = {
    id: row.id,
    agentId: row.id,
    environmentId: row.environmentId,
    directory: "/work/nexus-agent/a",
    kind: "worktree",
    owned: true,
    createdAt: 1,
  };
  let unavailable = false,
    cleaned = 0;
  const events = [agentEvent(1, "assistant", "缓存中的连续对话")];
  await agentRoutes(page, [row], events, async (route, path) => {
    if (unavailable) {
      await route.abort();
      return true;
    }
    if (path.endsWith("/workarea/cleanup-plan")) {
      await route.fulfill({
        json: {
          data: {
            directory: row.workArea.directory,
            kind: "worktree",
            branch: "nexus-agent/a",
            agents: [row],
            artifacts: [],
            blockers: [],
            inspection: { exists: true, dirty: false, unpushed: false },
          },
        },
      });
      return true;
    }
    if (path.endsWith("/workarea")) {
      expect(route.request().postDataJSON().confirmDirectory).toBe(
        row.workArea.directory,
      );
      cleaned++;
      row.workArea.dataDeletedAt = Date.now();
      await route.fulfill({ json: { data: row } });
      return true;
    }
    return false;
  });
  await page.goto("/work/agents/agent-1");
  await expect(
    page.getByText("缓存中的连续对话", { exact: true }),
  ).toBeVisible();
  unavailable = true;
  await page.reload();
  await expect(
    page.getByText("缓存中的连续对话", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Agent 对话消息" })
    .fill("恢复后再发送的草稿");
  unavailable = false;
  await expect(
    page.getByRole("alert").filter({ hasText: "Failed to fetch" }),
  ).toHaveCount(0, { timeout: 10000 });
  await page.getByRole("button", { name: "查看详情", exact: true }).click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page
    .getByRole("button", { name: "清理独立工作目录…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "清理工作目录" });
  await expect(
    dialog.getByRole("button", { name: "确认清理", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "确认清理目录" })
    .fill(row.workArea.directory);
  await dialog.getByRole("button", { name: "确认清理", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(cleaned).toBe(1);
  await expect(
    page.getByRole("textbox", { name: "Agent 对话消息" }),
  ).toHaveValue("恢复后再发送的草稿");
  await expect(
    page.getByRole("button", { name: "恢复会话", exact: true }),
  ).toBeDisabled();
});
