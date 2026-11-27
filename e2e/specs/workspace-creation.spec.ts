import { test, expect } from '@playwright/test';
import { account, config, environment, environmentRoutes, tasks, workspace } from '../workspace-fixture';
import {agentRoutes} from '../agent-fixture';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
test('creation offers ancestral resources, previews unique directories and always launches an Agent from its own entry', async ({ page, context }, testInfo) => {
  await account(context);
  const config = {...(await import('../workspace-fixture')).config,localRepository:'/sources/repository'};
  const profiles = [
    { id: 'root-template', name: '项目开发模板', taskId: 'agent-project', config, promptTemplate: '处理 {{task_title}}', createdAt: 1, updatedAt: 1 },
    { id: 'own-template', name: '任务容器模板', taskId: 'agent-task', config, promptTemplate: '当前节点指令', createdAt: 1, updatedAt: 1 },
    { id: 'root-template-2', name: '项目测试模板', taskId: 'agent-project', config, promptTemplate: '', createdAt: 1, updatedAt: 1 },
  ];
  const environments = [
    { ...environment(),config, id: 'root-env-1', taskId: 'agent-project', name: '项目开发环境', workRoot: '/managed/root-1' },
    { ...environment(),config, id: 'root-env-2', taskId: 'agent-project', name: '项目测试环境', workRoot: '/managed/root-2' },
    { ...environment(),config, id: 'own-env', taskId: 'agent-task', name: '任务环境', workRoot: '/managed/own' },
    { ...environment(),config, id: 'other-env', taskId: 'another-task', name: '其他项目环境' },
  ];
  await environmentRoutes(page, environments);
  await page.route('**/api/workspace-profiles', route => route.fulfill({ json: { data: profiles } }));
  let submitted: any;
  const agents: any[] = [];
  await page.route('**/api/tasks/*/agents', route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { data: agents } });
    submitted = route.request().postDataJSON();
    const agent = { ...submitted, id: 'created-agent', taskId: 'agent-task', state: 'queued', stage: 'environment', canResume: false, createdAt: 1, updatedAt: 1 };
    agents.push(agent);
    return route.fulfill({ json: { data: agent } });
  });
  await agentRoutes(page,agents);
  await page.route('**/api/tasks/*/agents',route=>{if(route.request().method()!=='POST')return route.fulfill({json:{data:agents}});submitted=route.request().postDataJSON();const agent={...submitted,id:'created-agent',taskId:'agent-task',state:'queued',stage:'environment',canResume:false,createdAt:1,updatedAt:1};agents.push(agent);return route.fulfill({json:{data:agent}});});
  await page.goto('/settings');
  await page.locator('input[type=file]').setInputFiles({ name: 'choices.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ tasks, workspaceProfiles: profiles, workspaces: [{ id: 'agent-project', mode: 'override', ...config }], settings: { servers: [{ id: 'agent-host', name: '主机', host: 'fixture@host.invalid' }] } })) });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
  await page.goto('/tasks?project=agent-project&view=mindmap&scope=all');
  await page.locator('.react-flow__node[data-id="agent-task"] [data-mind-title]').click();
  await expect(workspace(page).getByRole('button', { name: '创建 Workspace 模板', exact: true })).toBeVisible();
  await workspace(page).getByRole('button', { name: '创建 Workspace', exact: true }).click();
  const createWorkspace = page.getByRole('dialog', { name: '创建 Workspace', exact: true });
  await expect(createWorkspace.getByRole('checkbox', { name: '同时创建并启动 Agent' })).toBeChecked();
  await expect(createWorkspace.getByRole('combobox', { name: 'Agent Workspace 模板' })).toContainText('任务容器模板');
  await createWorkspace.getByRole('combobox', { name: 'Agent Workspace 模板' }).click();
  for (const name of profiles.map(profile => profile.name)) await expect(page.getByRole('option', { name, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const firstName = await createWorkspace.getByLabel('Workspace 名称', { exact: true }).inputValue();
  expect(firstName).toMatch(/^workspace-[a-z0-9-]+$/);
  await createWorkspace.getByRole('button', { name: '取消', exact: true }).click();
  await workspace(page).getByRole('button', { name: '创建 Workspace', exact: true }).click();
  expect(await createWorkspace.getByLabel('Workspace 名称', { exact: true }).inputValue()).not.toBe(firstName);
  await createWorkspace.getByRole('button', { name: '取消', exact: true }).click();
  await workspace(page).getByRole('button', { name: '创建 Agent', exact: true }).click();
  const create = page.getByRole('dialog', { name: '创建 Agent', exact: true });
  await expect(create.getByRole('checkbox', { name: '同时创建并启动 Agent' })).toHaveCount(0);
  await expect(create.getByRole('tab', { name: '使用已有 Workspace', exact: true })).toHaveAttribute('aria-selected', 'true');
  await create.getByRole('tab', { name: '从模板创建新 Workspace', exact: true }).click();
  await expect(create.getByRole('combobox', { name: 'Agent Workspace 模板', exact: true })).toBeVisible();
  await create.getByRole('tab', { name: '使用已有 Workspace', exact: true }).click();
  await expect(create.getByText('本轮目标与验收', { exact: true })).toHaveCount(0);
  await expect(create.getByRole('combobox', { name: '本轮类型', exact: true })).toHaveCount(0);
  await expect(create.getByRole('combobox', { name: 'Agent Workspace', exact: true })).toContainText('任务环境');
  await create.getByRole('combobox', { name: 'Agent Workspace', exact: true }).click();
  for (const name of ['项目开发环境', '项目测试环境', '任务环境']) await expect(page.getByRole('option', { name: name, exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: '其他项目环境', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: '项目测试环境', exact: true }).click();
  await expect(create.getByRole('radio', { name: '自动创建 Git worktree', exact: true })).toBeChecked();
  const worktreeName = await create.getByLabel('Worktree 名称', { exact: true }).inputValue();
  await expect(create.getByRole('group', { name: 'Agent 工作目录配置' })).toContainText(`/managed/root-2/nexus-agent/${worktreeName}`);
  await expect(create.getByLabel('Agent 工作目录', { exact: true })).toHaveCount(0);
  const directoryGroup = create.getByRole('group', { name: 'Agent 工作目录配置' });
  await expect(directoryGroup).toContainText('检出 Workspace 仓库的代码并创建独立分支');
  await create.getByRole('radio', { name: '创建空目录（不含仓库）', exact: true }).check();
  await expect(directoryGroup).toContainText('不复制仓库、不创建分支');
  await expect(directoryGroup).not.toContainText('分支：');
  await create.getByLabel('目录名称', { exact: true }).fill('../escape');
  await expect(create.getByRole('button', { name: '创建并启动', exact: true })).toBeDisabled();
  await create.getByLabel('目录名称', { exact: true }).fill(worktreeName);
  await create.getByRole('radio', { name: '使用自定义工作目录', exact: true }).check();
  await expect(create.getByLabel('Worktree 名称', { exact: true })).toHaveCount(0);
  await create.getByLabel('Agent 工作目录', { exact: true }).fill('/work/custom');
  await create.getByRole('radio', { name: '自动创建 Git worktree', exact: true }).check();
  await expect(create.getByLabel('Worktree 名称', { exact: true })).toHaveValue(worktreeName);
  await page.screenshot({ path: testInfo.outputPath('agent-create-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(create.getByRole('button', { name: '创建并启动', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('agent-create-mobile.png') });
  await create.getByRole('button', { name: '创建并启动', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Agent 工作台', exact: true })).toBeVisible();
  expect(submitted).toMatchObject({ environmentId: 'root-env-2', worktree: true, worktreeName, command: "codex app-server" });
  expect(submitted.directory).toBeUndefined();
  expect(submitted.round).toBeUndefined();
});
