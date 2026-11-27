import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
for (const mobile of [false, true]) {
  test(`Workspace configuration is visible in the ${mobile ? 'mobile' : 'desktop'} task header and edits only the selected node`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 680 });
    const notes = '需要保留的长篇任务说明。\n'.repeat(150);
    const tasks = [
      { id: 'entry-project', title: '入口项目', parentId: null, kind: 'node', project: true },
      { id: 'entry-task', title: '配置当前任务', parentId: 'entry-project', kind: 'todo', notes },
    ].map(value => ({ status: 'todo', order: 0, ownerId: 'fixture', important: false, urgent: false, tags: [], createdAt: 1, updatedAt: 1, ...value }));
    await page.goto('/settings');
    await page.locator('input[type=file]').setInputFiles({ name: 'workspace-entry.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      tasks,
      settings: { servers: [{ id: 'entry-host', name: '测试主机', host: 'fixture@host.invalid' }] },
      workspaces: [{ id: 'entry-project', mode: 'override', runtime: 'ssh', serverId: 'entry-host', repository: 'https://github.com/example/repository.git', ref: 'project-development' }],
    })) });
    await expect(page.getByText(/已合并备份/)).toBeVisible();
    await page.goto('/tasks?project=entry-project&view=mindmap&scope=all');
    const inspector = page.getByRole('region', { name: '任务详情', exact: true });
    const open = async (id: string) => page.locator(`.react-flow__node[data-id="${id}"] [data-mind-title]`).click();
    await open('entry-task');
    const configure = inspector.getByRole('button', { name: '打开 Workspace 配置', exact: true });
    await expect(configure).toBeInViewport();
    await expect(configure).toHaveText('Workspace');
    await inspector.getByRole('textbox', { name: '任务标题', exact: true }).fill('修改后仍可配置');
    await inspector.locator('[data-sheet-scroll]').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(configure).toBeInViewport();
    await configure.click();
    const dialog = page.getByRole('dialog', { name: 'Workspace 配置', exact: true });
    await expect(dialog).toHaveCount(1);
    await dialog.getByRole('combobox', { name: 'Workspace 继承方式', exact: true }).click();
    await page.getByRole('option', { name: '本节点覆盖', exact: true }).click();
    await expect(dialog.getByLabel('基准分支或版本', { exact: true })).toHaveValue('project-development');
    await dialog.getByLabel('基准分支或版本', { exact: true }).fill('task-development');
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(inspector.getByLabel('任务标题', { exact: true })).toHaveValue('修改后仍可配置');
    await page.reload();
    await open('entry-task');
    await configure.click();
    await expect(dialog.getByLabel('基准分支或版本', { exact: true })).toHaveValue('task-development');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(inspector.getByRole('region', { name: '执行 Workspace', exact: true })).toHaveCount(1);
    await inspector.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await open('entry-project');
    await configure.click();
    await dialog.getByRole('combobox', { name: 'Workspace 继承方式', exact: true }).click();
    await page.getByRole('option', { name: '本节点覆盖', exact: true }).click();
    await expect(dialog.getByLabel('基准分支或版本', { exact: true })).toHaveValue('project-development');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(configure).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('workspace-entry.png'), animations: 'disabled' });
  });
}
