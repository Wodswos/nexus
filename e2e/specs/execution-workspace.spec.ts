import { test, expect, type Page, type Locator } from '@playwright/test';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
const tasks = [
  {
    id: 'workspace-root',
    title: '执行项目',
    parentId: null,
    kind: 'node',
    project: true,
  },
  {
    id: 'workspace-record',
    title: '实验记录',
    parentId: 'workspace-root',
    kind: 'node',
    project: false,
    notes: '中间层的参数与结论',
  },
  {
    id: 'workspace-leaf',
    title: '下一步实验',
    parentId: 'workspace-record',
    kind: 'todo',
  },
].map((task) => ({
  status: 'todo',
  order: 0,
  ownerId: 'fixture',
  important: false,
  urgent: false,
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  ...task,
}));
const config = {
  runtime: 'ssh',
  serverId: 'fixture-host',
  image: '',
  repository: '',
  ref: '',
  directory: '',
  session: '',
  agentCommand: '',
  context: '',
  namespace: 'default',
  secretRef: '',
  imagePullSecret: '',
};
const workspace = (page: Page) =>
  page.getByRole('region', { name: '执行 Workspace', exact: true });
async function select(
  page: Page,
  container: Page | Locator,
  label: string,
  option: string,
) {
  await container.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function seed(page: Page, workspaces: unknown[] = []) {
  await page.goto('/settings');
  await page.locator('input[type=file]').setInputFiles({
    name: 'execution-workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        tasks,
        workspaces,
        settings: {
          servers: [
            {
              id: 'fixture-host',
              name: '测试控制主机',
              host: 'fixture@host.invalid',
            },
          ],
        },
      }),
    ),
  });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
}
async function open(page: Page, id: string) {
  await page.goto('/tasks?project=workspace-root&view=mindmap&scope=all');
  await page
    .locator(`.react-flow__node[data-id="${id}"] [data-mind-title]`)
    .click();
  await expect(workspace(page)).toBeVisible();
}

test('content-bearing middle nodes retain structure and inherit editable workspace fields', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await seed(page, [
    {
      id: 'workspace-root',
      mode: 'override',
      ...config,
      runtime: 'docker',
      image: 'node:22',
      repository: 'https://github.com/org/repo.git',
    },
  ]);
  await open(page, 'workspace-record');
  await expect(
    page.getByRole('textbox', { name: '任务备注', exact: true }),
  ).toHaveValue('中间层的参数与结论');
  await page
    .getByRole('button', { name: '打开 Workspace 配置', exact: true })
    .click();
  let dialog = page.getByRole('dialog', {
    name: 'Workspace 配置',
    exact: true,
  });
  await select(page, dialog, 'Workspace 继承方式', '本节点覆盖');
  await dialog.getByLabel('基准分支或版本', { exact: true }).fill('experiment');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await open(page, 'workspace-leaf');
  await page
    .getByRole('button', { name: '打开 Workspace 配置', exact: true })
    .click();
  dialog = page.getByRole('dialog', { name: 'Workspace 配置', exact: true });
  await select(page, dialog, 'Workspace 继承方式', '本节点覆盖');
  await expect(dialog.getByLabel('基准分支或版本', { exact: true })).toHaveValue('experiment');
  const revision = dialog
    .getByLabel('基准分支或版本', { exact: true })
    .locator('..');
  await expect(revision).toContainText('来自 实验记录');
  await expect(dialog.getByLabel('Image', { exact: true })).toHaveValue(
    'node:22',
  );
  await select(page, dialog, '运行方式', 'Kubernetes Pod');
  await dialog.getByLabel('Namespace', { exact: true }).fill('experiments');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page
    .locator('.react-flow__node[data-id="workspace-leaf"] [data-mind-title]')
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('button', { name: '打开 Workspace 配置', exact: true })
    .click();
  await expect(dialog.getByLabel('Namespace', { exact: true })).toHaveValue(
    'experiments',
  );
  await expect(
    dialog.getByLabel('基准分支或版本', { exact: true }),
  ).toHaveValue('experiment');
  await page.screenshot({
    path: testInfo.outputPath('workspace-mobile-config.png'),
    animations: 'disabled',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await select(page, dialog, 'Workspace 继承方式', '继承父节点');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, 'workspace-root');
  await page
    .getByRole('button', { name: '打开 Workspace 配置', exact: true })
    .click();
  await select(page, dialog, 'Workspace 继承方式', '停用此分支 Workspace 配置');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(workspace(page)).toContainText('此分支已停用');
  await page
    .getByRole('button', { name: '打开 Workspace 配置', exact: true })
    .click();
  await select(page, dialog, 'Workspace 继承方式', '本节点覆盖');
  await expect(dialog.getByLabel('Image', { exact: true })).toHaveValue(
    'node:22',
  );
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('selects an existing Agent pane and preserves a failed request id for safe retries', async ({
  page,
  context,
}, testInfo) => {
  const invite = await context.request
    .post('/api/invites', {
      headers: { Cookie: process.env.E2E_ADMIN_COOKIE! },
      data: {},
    })
    .then((response) => response.json());
  const registered = await context.request.post('/api/auth/register', {
    data: {
      username: `workspace_${Date.now()}`,
      password: 'fixture-password',
      inviteCode: invite.code,
    },
  });
  expect(registered.ok()).toBe(true);
  expect(
    (
      await context.request.put('/api/servers/fixture-host', {
        data: { name: '测试控制主机', host: 'fixture@host.invalid' },
      })
    ).ok(),
  ).toBe(true);
  const pane = {
    id: '%7',
    sessionId: '$0',
    session: 'dev',
    windowId: '@0',
    window: 'agent',
    pid: 42,
    serverPid: 100,
    command: 'codex',
    directory: '/workspace',
    dead: false,
  };
  let environment: any = null;
  const instructions: any[] = [],
    sends: any[] = [];
  await page.route('**/api/workspaces/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    let data: unknown;
    if (url.pathname.endsWith('/discover')) data = [{ id: 'dev', name: 'dev' }];
    else if (url.pathname.endsWith('/environments')) {
      const body = request.postDataJSON();
      environment = {
        id: 'fixture-environment',
        taskId: 'workspace-leaf',
        config: body.config,
        connectionHost: 'fixture@host.invalid',
        managed: false,
        state: 'ready',
        resourceId: '',
        session: body.resourceId,
        directory: '/workspace',
        createdAt: 1,
        updatedAt: 1,
      };
      data = environment;
    } else if (url.pathname.endsWith('/instructions')) {
      sends.push(request.postDataJSON());
      if (sends.length === 1) {
        await route.fulfill({ status: 502, json: { error: '临时网络错误' } });
        return;
      }
      data = {
        ...request.postDataJSON(),
        id: 'fixture-instruction',
        taskId: 'workspace-leaf',
        state: 'delivered',
        createdAt: 1,
        updatedAt: 1,
      };
      instructions.unshift(data);
    } else
      data = { environments: environment ? [environment] : [], instructions };
    await route.fulfill({ json: { data } });
  });
  await page.route('**/api/workspace-environments/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'DELETE') environment = { ...environment, state: 'stopped' };
    await route.fulfill({
      json: {
        data: url.pathname.endsWith('/panes')
          ? [pane]
          : url.pathname.endsWith('/output')
            ? 'Agent fixture output'
            : environment,
      },
    });
  });
  await seed(page, [{ id: 'workspace-root', mode: 'override', ...config }]);
  await open(page, 'workspace-leaf');
  await workspace(page)
    .getByRole('button', { name: '使用已有 Workspace', exact: true })
    .click();
  await workspace(page)
    .getByRole('button', { name: '关联此 Workspace', exact: true })
    .click();
  await expect(
    workspace(page).getByRole('combobox', {
      name: '目标 Agent 或 tmux pane',
      exact: true,
    }),
  ).toContainText('codex');
  await page
    .getByRole('textbox', { name: '任务备注', exact: true })
    .fill('发送前保存的参数');
  await workspace(page)
    .getByRole('textbox', { name: '发送给 Agent 的指令', exact: true })
    .fill('中文指令\n$(literal) `text`');
  await workspace(page)
    .getByRole('checkbox', { name: '附带当前节点内容', exact: true })
    .check();
  await workspace(page)
    .getByRole('button', { name: '发送给 Agent', exact: true })
    .click();
  await expect(workspace(page).getByRole('alert')).toContainText(
    '临时网络错误',
  );
  await workspace(page)
    .getByRole('button', { name: '发送给 Agent', exact: true })
    .click();
  await expect(
    workspace(page).getByText('指令已进入投递队列', { exact: true }),
  ).toBeVisible();
  expect(sends).toHaveLength(2);
  expect(sends[0]).toEqual(sends[1]);
  expect(sends[1].text).toBe(
    '中文指令\n$(literal) `text`\n\n当前节点\n下一步实验\n发送前保存的参数',
  );
  expect(sends[1].pane).toEqual(pane);
  await workspace(page)
    .getByRole('button', { name: '查看输出', exact: true })
    .click();
  await expect(
    workspace(page).getByLabel('目标 pane 输出', { exact: true }),
  ).toContainText('Agent fixture output');
  await page.screenshot({
    path: testInfo.outputPath('workspace-agent-delivery.png'),
    animations: 'disabled',
  });
  await page.reload();
  await page
    .locator('.react-flow__node[data-id="workspace-leaf"] [data-mind-title]')
    .click();
  await expect(workspace(page).getByRole('region', { name: '已创建 Workspace', exact: true })).toContainText('dev');
  await expect(
    workspace(page).getByRole('textbox', {
      name: '发送给 Agent 的指令',
      exact: true,
    }),
  ).toHaveValue('');
  await workspace(page)
    .getByRole('button', { name: '解除关联', exact: true })
    .click();
  await expect(
    workspace(page).getByText('已解除当前节点的 Workspace 关联', { exact: true }),
  ).toBeVisible();
  await expect(
    workspace(page).getByRole('textbox', {
      name: '发送给 Agent 的指令',
      exact: true,
    }),
  ).toHaveCount(0);
});
