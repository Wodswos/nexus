import { networkInterfaces } from 'node:os';
import { test, expect } from '@playwright/test';
import { account, config, environment, tasks, workspace } from '../workspace-fixture';

// localhost is a secure context even over HTTP; a private interface exercises the public-IP behavior.
test.use({ serviceWorkers: 'block', launchOptions: {
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args: ['--no-proxy-server'],
  env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' },
} });

test('plain HTTP can save templates, open Workspace creation and submit stable request IDs', async ({ page, context }) => {
  await account(context);
  const local = `http://127.0.0.1:${process.env.E2E_PORT ?? '39901'}`;
  const host = Object.values(networkInterfaces()).flat().find(value => value?.family === 'IPv4' && !value.internal)?.address;
  expect(host).toBeTruthy();
  const origin = `http://${host}:${process.env.E2E_PORT ?? '39901'}`;
  await context.addCookies((await context.cookies(local)).map(cookie => ({ ...cookie, domain: host! })));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/settings`);
  expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues }))).toEqual({ secure: false, uuid: 'undefined', random: 'function' });
  await page.locator('input[type=file]').setInputFiles({ name: 'http-workspace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    tasks, workspaces: [{ id: 'agent-project', mode: 'override', ...config }],
    settings: { servers: [{ id: 'agent-host', name: 'HTTP 测试主机', host: 'fixture@host.invalid' }] },
  })) });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
  await page.goto(`${origin}/tasks?project=agent-project&view=mindmap&scope=all`);
  await page.locator('.react-flow__node[data-id="agent-task"] [data-mind-title]').click();
  await workspace(page).getByRole('button', { name: '创建 Workspace 模板', exact: true }).click();
  const template = page.getByRole('dialog', { name: '创建 Workspace 模板', exact: true });
  await template.getByLabel('Workspace 模板名称', { exact: true }).fill('HTTP 可用模板');
  await template.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(template).toHaveCount(0);
  expect((await (await context.request.get('/api/workspace-profiles')).json()).data.some((row: any) => row.name === 'HTTP 可用模板')).toBe(true);

  const launches: any[] = [];
  await page.route('**/api/tasks/*/workspace-launch', route => {
    const body = route.request().postDataJSON(); launches.push(body);
    if (launches.length === 1) return route.fulfill({ status: 502, json: { error: '临时连接失败，请重试' } });
    return route.fulfill({ json: { data: { environment: { ...environment(), name: body.name, state: 'queued' } } } });
  });
  await workspace(page).getByRole('button', { name: '创建 Workspace', exact: true }).click();
  const create = page.getByRole('dialog', { name: '创建 Workspace', exact: true });
  await expect(create).toBeVisible();
  expect(await create.getByLabel('Workspace 名称', { exact: true }).inputValue()).toMatch(/^workspace-[a-z0-9-]+$/);
  // The freshly created template is intentionally incomplete; use the project's existing valid config.
  await create.getByRole('combobox', { name: 'Agent Workspace 模板', exact: true }).click();
  await page.getByRole('option', { name: '使用任务 / 项目默认配置', exact: true }).click();
  await create.getByRole('checkbox', { name: '同时创建并启动 Agent' }).uncheck();
  await create.getByRole('button', { name: '创建 Workspace', exact: true }).click();
  await expect(create.getByRole('alert')).toContainText('临时连接失败');
  await create.getByRole('button', { name: '创建 Workspace', exact: true }).click();
  await expect(create).toHaveCount(0);
  expect(launches).toHaveLength(2);
  expect(launches[0].requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(launches[0].requestId).toBe(launches[1].requestId);
  expect(errors).toEqual([]);
});
