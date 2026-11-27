import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { account, config, environment, environmentRoutes, tasks, workspace } from '../workspace-fixture';
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });

test('created Workspaces replace default selectors and switching instances preserves task configuration through refresh', async ({ page, context }, testInfo) => {
  await account(context);
  const profiles = [{ id: 'default-one', name: '项目模板', taskId: 'agent-project', config, promptTemplate: '', createdAt: 1, updatedAt: 1 }];
  const values = [
    { ...environment(), id: 'env-default', name: '项目 Workspace', taskId: 'agent-project' },
    { ...environment(), id: 'env-task', name: '任务 Workspace', taskId: 'agent-task' },
    { ...environment(), id: 'env-other', name: '其他项目 Workspace', taskId: 'another-task' },
  ];
  await environmentRoutes(page, values);
  let refreshes = 0;
  await page.route('**/api/workspace-environments', route => { refreshes++; return route.fulfill({ json: { data: values } }); });
  await page.route('**/api/workspace-profiles', route => route.fulfill({ json: { data: profiles } }));
  await page.route('**/api/tasks/*/agents', route => route.fulfill({ json: { data: [] } }));
  await page.goto('/settings');
  await page.locator('input[type=file]').setInputFiles({ name: 'instances.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    workspaceProfiles: profiles,
    workspaces: [{ id: 'agent-project', mode: 'inherit', workspaceId: 'default-one', environmentId: 'env-default' }],
    tasks, settings: { servers: [{ id: 'agent-host', name: 'Agent 主机', host: 'fixture@host.invalid' }] },
  })) });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
  await page.goto('/tasks?project=agent-project&view=mindmap&scope=all');
  await page.locator('.react-flow__node[data-id="agent-task"] [data-mind-title]').click();
  const section = workspace(page), instances = section.getByRole('region', { name: '已创建 Workspace', exact: true });
  await expect(section.getByText('默认选择', { exact: true })).toHaveCount(0);
  await expect(section.getByRole('combobox', { name: '默认 Workspace', exact: true })).toHaveCount(0);
  await expect(section.getByRole('combobox', { name: '默认 Workspace 模板', exact: true })).toHaveCount(0);
  await expect(section.getByRole('button', { name: '创建 Workspace 模板', exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: '创建 Workspace', exact: true })).toBeVisible();
  await expect(instances.getByRole('button')).toHaveCount(2);
  await expect(instances).not.toContainText('其他项目 Workspace');
  await expect(instances.getByRole('button', { name: /任务 Workspace/ })).toHaveAttribute('aria-pressed', 'true');
  await instances.getByRole('button', { name: /项目 Workspace/ }).click();
  const refreshed = refreshes;
  await expect.poll(() => refreshes).toBeGreaterThan(refreshed);
  await expect(instances.getByRole('button', { name: /项目 Workspace/ })).toHaveAttribute('aria-pressed', 'true');
  await section.getByRole('button', { name: '创建 Agent', exact: true }).click();
  const create = page.getByRole('dialog', { name: '创建 Agent', exact: true });
  await expect(create.getByRole('combobox', { name: 'Agent Workspace', exact: true })).toContainText('项目 Workspace');
  await create.getByRole('button', { name: '取消', exact: true }).click();
  await instances.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('workspace-instances.png'), animations: 'disabled' });
  await page.goto('/settings');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const backup = JSON.parse(await readFile((await (await downloading).path())!, 'utf8'));
  expect(backup.data.workspaces.find((row: any) => row.id === 'agent-project')).toMatchObject({ workspaceId: 'default-one', environmentId: 'env-default' });
  expect(backup.data.workspaces.find((row: any) => row.id === 'agent-task')).toBeUndefined();
});

test('an existing Workspace can receive instructions without configuring task defaults', async ({ page, context }) => {
  await account(context);
  await environmentRoutes(page, [environment()]);
  await page.route('**/api/workspace-environments/*/panes', route => route.fulfill({ json: { data: [{ id: '%1', sessionId: '$1', session: 'nexus-fixture', windowId: '@1', window: 'agent', pid: 42, serverPid: 101, command: 'agent-cli', directory: '/work', dead: false }] } }));
  await page.route('**/api/tasks/*/agents', route => route.fulfill({ json: { data: [] } }));
  await page.goto('/settings');
  await page.locator('input[type=file]').setInputFiles({ name: 'instances-only.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ tasks })) });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
  await page.goto('/tasks?project=agent-project&view=mindmap&scope=all');
  await page.locator('.react-flow__node[data-id="agent-task"] [data-mind-title]').click();
  const section = workspace(page);
  await expect(section.getByRole('region', { name: '已创建 Workspace', exact: true })).toContainText('nexus-fixture');
  await section.getByRole('textbox', { name: '发送给 Agent 的指令', exact: true }).fill('继续推进当前任务');
  await expect(section.getByRole('button', { name: '发送给 Agent', exact: true })).toBeEnabled();
});
