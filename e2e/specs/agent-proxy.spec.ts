import { test, expect } from "@playwright/test";
import { account } from "../workspace-fixture";

test("server Agent proxy settings persist, can be edited and can be disabled", async ({
  page,
  context,
}, info) => {
  await account(context);
  await page.goto("/settings");
  await page.getByPlaceholder("名称,如 A100 训练机").fill("代理测试主机");
  await page.getByPlaceholder("user@host[:port]").fill("fixture@host.invalid");
  const proxy = page.getByRole("group", { name: "Agent 代理" });
  await proxy.getByRole("checkbox").check();
  await proxy.getByLabel("Agent 代理地址").fill("http://127.0.0.1:7890");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  const row = page.getByText("代理测试主机", { exact: true }).locator("..");
  await expect(row.getByText("代理", { exact: true })).toBeVisible();
  await page.reload();
  await row.getByRole("button", { name: "配置", exact: true }).click();
  await expect(proxy.getByRole("checkbox")).toBeChecked();
  await expect(proxy.getByLabel("Agent 代理地址")).toHaveValue(
    "http://127.0.0.1:7890",
  );
  await page.screenshot({ path: info.outputPath("agent-proxy-settings.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await proxy.getByRole("checkbox").uncheck();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(row.getByText("代理", { exact: true })).toHaveCount(0);
  await page.reload();
  await row.getByRole("button", { name: "配置", exact: true }).click();
  await expect(proxy.getByRole("checkbox")).not.toBeChecked();
});
