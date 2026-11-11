import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
const detail = (page: Page) => page.locator('[data-inspector]');
const workspace = (page: Page) =>
  detail(page).getByRole('region', { name: '任务工作区', exact: true });
const resources = (page: Page) => workspace(page).locator('[data-workspace-resource]');
const task = (id: string) => ({
  id,
  title: id,
  parentId: null,
  status: 'todo',
  dueAt: Date.now(),
  ownerId: 'fixture',
  order: 0,
  tags: [],
  important: false,
  urgent: false,
  createdAt: 1,
  updatedAt: 1,
});

async function seed(page: Page, extra = {}) {
  await page.goto('/settings');
  await page
    .locator('input[type=file]')
    .setInputFiles({
      name: 'workspace.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ tasks: [task('workspace-task'), task('other-task')], ...extra }),
      ),
    });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
  await page.goto('/tasks?view=list&scope=all');
  await page.getByText('workspace-task', { exact: true }).click();
  await expect(workspace(page)).toBeVisible();
}

async function add(page: Page, kind: string, url: string, title?: string) {
  await workspace(page).getByRole('button', { name: '添加工作资源', exact: true }).click();
  await page.getByRole('menuitem', { name: kind, exact: true }).click();
  await workspace(page).getByLabel('资源链接', { exact: true }).fill(url);
  if (title) await workspace(page).getByLabel('资源名称', { exact: true }).fill(title);
  await workspace(page).getByRole('button', { name: '添加资源', exact: true }).click();
}

async function resourceMenu(page: Page, label: string, action: string) {
  await workspace(page)
    .getByRole('button', { name: `资源 ${label} 菜单`, exact: true })
    .click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

test('workspace resources keep names, order, pins and PR identity across reload and backup', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await seed(page);
  await expect(resources(page)).toHaveCount(0);
  await workspace(page).getByRole('button', { name: '添加工作资源' }).click();
  await page.getByRole('menuitem', { name: '网页', exact: true }).click();
  await workspace(page).getByLabel('资源链接', { exact: true }).fill('https://discard.example.com');
  await workspace(page).getByRole('button', { name: '取消添加资源' }).click();
  await expect(resources(page)).toHaveCount(0);
  await add(page, '网页', 'https://example.com/docs', '接口文档');
  await add(page, '网页', 'https://github.com/org/repo/pull/128');
  await expect(resources(page).nth(1)).toHaveAttribute('data-resource-type', 'github-pr');
  await add(page, 'GitHub PR', 'https://github.com/ORG/REPO/pull/128/files#diff');
  await expect(resources(page)).toHaveCount(2);
  await add(page, 'dsh 会话', 'dsh://sessions/dev', '调试会话');
  await expect(
    workspace(page).getByRole('link', { name: '打开资源 调试会话', exact: true }),
  ).toHaveAttribute('href', 'dsh://sessions/dev');
  await resourceMenu(page, '调试会话', '上移');
  await expect(resources(page).nth(1)).toContainText('调试会话');
  await resourceMenu(page, '接口文档', '重命名');
  await workspace(page).getByLabel('资源名称', { exact: true }).fill('API 文档');
  await workspace(page).getByRole('button', { name: '保存名称', exact: true }).click();
  await workspace(page)
    .getByRole('button', { name: '置顶资源 org/repo #128', exact: true })
    .click();
  await expect(resources(page).first()).toHaveAttribute('data-pinned', 'true');
  await expect(
    detail(page)
      .getByRole('navigation', { name: '工作区快捷入口' })
      .getByRole('link', { name: '打开置顶资源 org/repo #128', exact: true }),
  ).toHaveAttribute('href', 'https://github.com/org/repo/pull/128');
  const ids = await resources(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-workspace-resource')),
  );
  await page.reload();
  await page.getByText('workspace-task', { exact: true }).click();
  await expect
    .poll(() =>
      resources(page).evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-workspace-resource')),
      ),
    )
    .toEqual(ids);
  await expect(resources(page).nth(1)).toContainText('API 文档');
  await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.goto('/settings');
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const snapshot = JSON.parse(await readFile((await (await waiting).path())!, 'utf8'));
  expect(snapshot.data.links).toHaveLength(3);
  expect(snapshot.data.links.find((link: any) => link.type === 'github-pr')).toMatchObject({
    pinned: true,
    taskId: 'workspace-task',
  });
  expect(snapshot.data.links.find((link: any) => link.type === 'url')).toMatchObject({
    title: 'API 文档',
  });
  expect(snapshot.docs.links).toBeTruthy();
  expect(errors).toEqual([]);
});

test('legacy tmux links survive and session creation, association, unlinking and ending stay distinct', async ({
  page,
}) => {
  const calls: string[] = [];
  await page.route('**/api/tmux/*', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)!;
    calls.push(action);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(action === 'sessions' ? { sessions: [] } : { ok: true }),
    });
  });
  await seed(page, {
    settings: {
      servers: [{ id: 'dev', name: '开发机', host: 'user@host.invalid', registered: true }],
    },
    links: [
      {
        id: 'legacy',
        taskId: 'workspace-task',
        type: 'tmux',
        target: 'tmux://开发机/existing',
        serverId: 'dev',
        session: 'existing',
        createdAt: 1,
      },
    ],
  });
  await expect(resources(page)).toHaveCount(1);
  await resourceMenu(page, 'existing', '解除关联');
  await expect(resources(page)).toHaveCount(0);
  expect(calls).not.toContain('kill-session');
  await workspace(page).getByRole('button', { name: '添加工作资源' }).click();
  await page.getByRole('menuitem', { name: 'tmux 会话', exact: true }).click();
  await workspace(page).getByLabel('tmux 服务器', { exact: true }).selectOption('dev');
  await expect(workspace(page).getByLabel('tmux 会话', { exact: true })).toBeEnabled();
  await expect(
    workspace(page).getByLabel('tmux 会话', { exact: true }).locator('option:checked'),
  ).toHaveText('连接成功，暂无会话');
  await workspace(page).getByRole('button', { name: '新建远程会话', exact: true }).click();
  await workspace(page).getByLabel('新 tmux 会话名', { exact: true }).fill('new-dev');
  await workspace(page).getByRole('button', { name: '创建并关联', exact: true }).click();
  await expect(resources(page)).toHaveCount(1);
  expect(calls).toContain('new-session');
  await resourceMenu(page, 'new-dev', '结束远程会话');
  expect(calls).not.toContain('kill-session');
  await workspace(page).getByRole('button', { name: '确认结束', exact: true }).click();
  await expect(resources(page)).toContainText('远程会话已结束');
  expect(calls.filter((action) => action === 'kill-session')).toHaveLength(1);
  await expect(resources(page)).toHaveCount(1);
  await page.reload();
  await page.getByText('workspace-task', { exact: true }).click();
  await expect(resources(page)).toHaveCount(1);
});

test('mobile workspace supports safe links, pinned shortcuts and task changes without carrying drafts', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, {
    links: [
      {
        id: 'old-note',
        taskId: 'workspace-task',
        type: 'obsidian',
        target: 'obsidian://open?vault=work&file=旧笔记',
        createdAt: 1,
      },
    ],
  });
  await expect(
    workspace(page).getByRole('link', { name: '打开资源 旧笔记', exact: true }),
  ).toHaveAttribute('href', 'obsidian://open?vault=work&file=旧笔记');
  await workspace(page).getByRole('button', { name: '添加工作资源' }).click();
  await page.getByRole('menuitem', { name: '网页', exact: true }).click();
  await workspace(page).getByLabel('资源链接', { exact: true }).fill('javascript:alert(1)');
  await workspace(page).getByRole('button', { name: '添加资源', exact: true }).click();
  await expect(workspace(page).getByRole('alert')).toContainText('不支持');
  await expect(resources(page)).toHaveCount(1);
  await workspace(page).getByRole('button', { name: '取消添加资源' }).click();
  await add(page, 'GitHub PR', 'https://git.example.com/team/app/pull/42', '修复登录');
  await workspace(page).getByRole('button', { name: '置顶资源 修复登录', exact: true }).click();
  await expect(
    detail(page).getByRole('link', { name: '打开置顶资源 修复登录', exact: true }),
  ).toBeVisible();
  await resourceMenu(page, '修复登录', '重命名');
  await workspace(page).getByLabel('资源名称', { exact: true }).fill('未保存名称');
  await workspace(page).getByLabel('资源名称', { exact: true }).press('Escape');
  await expect(detail(page)).toBeVisible();
  await expect(workspace(page).getByRole('form', { name: '重命名资源', exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({ path: testInfo.outputPath('mobile-workspace.png') });
  const bounds = await workspace(page).boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await workspace(page).getByRole('button', { name: '添加工作资源' }).click();
  await page.getByRole('menuitem', { name: 'dsh 会话', exact: true }).click();
  await workspace(page).getByLabel('资源链接', { exact: true }).fill('dsh://discarded');
  await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.getByText('other-task', { exact: true }).click();
  await expect(resources(page)).toHaveCount(0);
  await expect(workspace(page).getByLabel('资源链接', { exact: true })).toHaveCount(0);
});

for (const mobile of [false, true]) {
  test(`tmux opens from the ${mobile ? 'mobile sheet' : 'desktop inspector'} and closes without ending the session`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await seed(page, {
      settings: {
        servers: [{ id: 'dev', name: '开发机', host: 'user@host.invalid', registered: true }],
      },
      links: [
        {
          id: 'terminal',
          taskId: 'workspace-task',
          type: 'tmux',
          target: 'tmux://server/dev',
          serverId: 'dev',
          session: 'dev',
          createdAt: 1,
        },
      ],
    });
    await detail(page).getByLabel('任务备注', { exact: true }).fill('切换终端前的任务记录');
    await workspace(page).getByRole('button', { name: '打开资源 dev', exact: true }).click();
    await expect(page.locator('.xterm')).toBeVisible();
    await page.getByTitle('关闭(detach,不影响远端会话)', { exact: true }).click();
    await expect(page.locator('.xterm')).toHaveCount(0);
    await expect(workspace(page)).toBeVisible();
    await expect(detail(page).getByLabel('任务备注', { exact: true })).toHaveValue(
      '切换终端前的任务记录',
    );
  });
}

test('the floating mind-map inspector keeps resource menus and additions within the selected task', async ({
  page,
}) => {
  await seed(page);
  await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.goto('/tasks?view=mindmap&scope=all');
  const node = page.locator('.react-flow__node[data-id="workspace-task"]');
  await expect(node).toBeVisible();
  await node.hover();
  await node.getByRole('button', { name: '查看任务详情 workspace-task', exact: true }).click();
  await add(page, '网页', 'https://example.com/design', '设计文档');
  await expect(resources(page)).toHaveCount(1);
  await resourceMenu(page, '设计文档', '重命名');
  await workspace(page).getByLabel('资源名称', { exact: true }).fill('任务设计');
  await workspace(page).getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(resources(page)).toContainText('任务设计');
});
