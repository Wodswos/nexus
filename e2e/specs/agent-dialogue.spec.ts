import { test, expect } from "@playwright/test";
import { account, environment, environmentRoutes } from "../workspace-fixture";
import {
  agentRoutes,
  nativeAgent,
  agentEvent,
  agentPanel,
} from "../agent-fixture";

test("model catalog diagnostics are readable, expandable and do not replace a working conversation", async ({
  page,
  context,
}) => {
  await account(context);
  await environmentRoutes(page, [environment()]);
  await agentRoutes(
    page,
    [nativeAgent()],
    [
      agentEvent(
        1,
        "terminal",
        "\x1b[2m2026-11-27T02:58:07Z\x1b[0m \x1b[31mERROR\x1b[0m failed to refresh available models: request timed out",
      ),
      agentEvent(2, "assistant", "会话仍然保留"),
    ],
  );
  await page.goto("/work/agents/agent-1");
  const panel = agentPanel(page);
  await expect(panel.getByText("会话仍然保留", { exact: true })).toBeVisible();
  await panel
    .locator("summary")
    .filter({ hasText: "模型列表连接超时" })
    .click();
  await expect(
    panel.getByText(
      "检查 Codex 所在执行环境的网络与代理。模型列表刷新失败本身不等于会话启动失败。",
    ),
  ).toBeVisible();
  await expect(panel.locator("pre")).toHaveText(
    "2026-11-27T02:58:07Z ERROR failed to refresh available models: request timed out",
  );
  await expect(panel.getByLabel("Agent 对话消息")).toBeEnabled();
});

test("Agent suggestions fill an editable draft, never send automatically, and expire after a user reply", async ({
  page,
  context,
}) => {
  await account(context);
  await environmentRoutes(page, [environment()]);
  const row = nativeAgent(),
    sent: string[] = [],
    events = [
      agentEvent(1, "assistant", "设计已经明确", "agent-1", {
        suggestions: [
          { label: "实现最小原型", text: "请按已确认的设计实现最小原型。" },
        ],
      }),
    ];
  await agentRoutes(page, [row], events, async (route, path) => {
    if (!path.endsWith("/messages")) return false;
    sent.push(route.request().postDataJSON().text);
    events.push(
      agentEvent(2, "user", sent[0], "agent-1", { messageId: "reply" }),
    );
    await route.fulfill({ json: { data: { id: "reply" } } });
    return true;
  });
  await page.goto("/work/agents/agent-1");
  const shell = agentPanel(page),
    input = shell.getByLabel("Agent 对话消息");
  await input.fill("保留的草稿");
  await shell
    .getByRole("button", { name: "实现最小原型", exact: true })
    .click();
  await expect(input).toHaveValue(
    "保留的草稿\n\n请按已确认的设计实现最小原型。",
  );
  await expect(input).toBeFocused();
  expect(sent).toHaveLength(0);
  await input.fill("请先解释性能代价");
  await shell.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(
    shell.getByRole("button", { name: "实现最小原型", exact: true }),
  ).toHaveCount(0);
  await shell.getByRole("button", { name: "部署", exact: true }).click();
  await expect(input).toHaveValue(/请推进部署/);
  expect(sent).toEqual(["请先解释性能代价"]);
});

test("clarification cards show option descriptions, accept multiple choices and custom answers without preselection", async ({
  page,
  context,
}, info) => {
  await account(context);
  await environmentRoutes(page, [environment()]);
  const row = { ...nativeAgent(), state: "waiting" },
    answers: unknown[] = [];
  const events = [
    agentEvent(1, "permission", "先确认任务目标", "agent-1", {
      permissionId: "clarify",
      questions: [
        {
          id: "goal",
          question: "希望先交付什么？",
          options: [
            { label: "设计方案", description: "先讨论范围与取舍" },
            { label: "可运行原型", description: "先验证核心体验" },
          ],
        },
        {
          id: "platform",
          question: "支持哪些端？",
          multiSelect: true,
          options: [
            { label: "桌面端", description: "键鼠操作" },
            { label: "手机端", description: "触屏操作" },
          ],
        },
      ],
      resolved: false,
    }),
  ];
  await agentRoutes(page, [row], events, async (route, path) => {
    if (!path.endsWith("/answers")) return false;
    const body = route.request().postDataJSON();
    answers.push(body);
    events.push(
      agentEvent(2, "permission", "已回答", "agent-1", {
        permissionId: "clarify",
        resolved: true,
        answers: body.answers,
      }),
    );
    await route.fulfill({ json: { data: row } });
    return true;
  });
  await page.goto("/work/agents/agent-1");
  const shell = agentPanel(page),
    submit = shell.getByRole("button", { name: "发送回答", exact: true });
  await expect(submit).toBeDisabled();
  await expect(shell.getByRole("button", { name: /设计方案/ })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await shell.getByRole("button", { name: /设计方案/ }).click();
  await shell.getByRole("button", { name: /桌面端/ }).click();
  await shell.getByRole("button", { name: /手机端/ }).click();
  await shell
    .getByLabel("自定义回答：希望先交付什么？")
    .fill("先分析目前性能问题");
  await expect(shell.getByRole("button", { name: /设计方案/ })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await shell.getByLabel("自定义回答：支持哪些端？").fill("平板");
  await expect(submit).toBeEnabled();
  expect(answers).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("clarification-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#workspace-sidebar")).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("clarification-mobile.png") });
  await submit.click();
  await expect(submit).toHaveCount(0);
  expect(answers).toEqual([
    {
      permissionId: "clarify",
      answers: {
        goal: "先分析目前性能问题",
        platform: ["桌面端", "手机端", "平板"],
      },
    },
  ]);
});
