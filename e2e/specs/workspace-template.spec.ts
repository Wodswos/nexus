import { test, expect } from '@playwright/test';
import { account, choose } from '../workspace-fixture';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });

test('template groups repository settings, follows the base ref and edits default roots only on request', async ({ page, context }, testInfo) => {
  await account(context);
  await page.goto('/workspaces');
  await page.getByRole('button', { name: '创建模板', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建 Workspace 模板', exact: true });
  await dialog.getByLabel('Workspace 模板名称', { exact: true }).fill('环境配置边界');
  for (const name of ['Workspace 默认 Prompt 模板', '优先选择的 tmux 会话', '新工作分支']) {
    await expect(dialog.getByLabel(name, { exact: true })).toHaveCount(0);
  }
  const git = dialog.getByRole('group', { name: 'Git 仓库', exact: true });
  await git.getByLabel('GitHub／Git 仓库', { exact: true }).fill('https://github.com/example/project.git');
  await git.getByLabel('本地仓库路径', { exact: true }).fill('/srv/source');
  await expect(git.getByRole('combobox', { name: '仓库来源策略', exact: true })).toContainText('自动');
  const ref = git.getByLabel('基准分支或版本', { exact: true });
  const target = git.getByLabel('PR 目标分支', { exact: true });
  await ref.fill('develop');
  await expect(target).toHaveValue('develop');
  await expect(git.getByText('跟随基准分支或版本', { exact: true })).toHaveCount(0);
  await expect(git.getByText('跟随仓库默认分支', { exact: true })).toHaveCount(0);
  await ref.fill('release/next');
  await expect(target).toHaveValue('release/next');
  await target.fill('integration');
  await ref.fill('feature/base');
  await expect(target).toHaveValue('integration');
  await git.getByRole('button', { name: '跟随基准分支', exact: true }).click();
  await expect(target).toHaveValue('feature/base');

  const root = dialog.getByLabel('持久化工作根目录', { exact: true });
  await expect(root).toHaveText('$HOME/.local/share/nexus/workspaces');
  await expect(dialog.getByRole('textbox', { name: '持久化工作根目录', exact: true })).toHaveCount(0);
  await choose(page, dialog, '运行方式', '独立 Linux 用户');
  await expect(root).toHaveText('/var/lib/nexus/workspaces');
  await choose(page, dialog, '运行方式', 'Docker 容器');
  await expect(root).toHaveText('/workspace');
  await choose(page, dialog, '运行方式', 'SSH 主机 / tmux');
  await dialog.getByRole('button', { name: '编辑持久化工作根目录', exact: true }).click();
  await root.fill('/srv/nexus');
  await dialog.getByRole('button', { name: '完成工作根目录编辑', exact: true }).click();
  await expect(root).toHaveText('/srv/nexus');
  await dialog.getByRole('button', { name: '恢复默认工作根目录', exact: true }).click();
  await expect(root).toHaveText('$HOME/.local/share/nexus/workspaces');
  await page.screenshot({ path: testInfo.outputPath('workspace-template-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('button', { name: '保存配置', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workspace-template-mobile.png') });
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const response = await context.request.get('/api/workspace-profiles');
  const profiles = (await response.json()).data;
  expect(profiles[0]).toMatchObject({ name: '环境配置边界', promptTemplate: '', config: { ref: 'feature/base', prTarget: '', workRoot: '', branch: '', session: '' } });
  await page.getByRole('button', { name: /环境配置边界/ }).click();
  const edit = page.getByRole('dialog', { name: '编辑 Workspace 模板', exact: true });
  await edit.getByLabel('基准分支或版本', { exact: true }).fill('next-base');
  await expect(edit.getByLabel('PR 目标分支', { exact: true })).toHaveValue('next-base');
});
