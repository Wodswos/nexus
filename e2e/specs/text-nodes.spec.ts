import { test, expect, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const task = (id: string, patch: Record<string, unknown> = {}) => ({
  id, title: id, parentId: null, status: 'todo', order: 0, ownerId: 'fixture',
  tags: [], important: false, urgent: false, createdAt: 1, updatedAt: 1, ...patch,
});

async function seed(page: Page, tasks: unknown[], hidden = false) {
  await page.goto('/settings');
  await page.locator('input[type=file]').setInputFiles({
    name: 'text-nodes.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      tasks,
      tags: [{ id: 'notes', name: '知识记录', ownerId: 'fixture' }],
      settings: { completedDisplay: hidden ? 'hidden' : 'inline-gray' },
    })),
  });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
}

test('a text leaf keeps its readable content through completion hiding, edits, reload and tag filtering', async ({ page }, testInfo) => {
  await seed(page, [
    task('project', { title: '内容项目', kind: 'node', project: true }),
    task('record', { title: '实验结果 42', parentId: 'project', kind: 'node', project: false, status: 'done', completedAt: 100, tags: ['notes'], notes: '原始数据与结论' }),
    task('completed', { parentId: 'project', status: 'done' }),
  ], true);
  await page.goto('/tasks?project=project&view=mindmap&scope=all');
  await expect(node(page, 'record')).toBeVisible();
  await expect(node(page, 'completed')).toHaveCount(0);
  const title = node(page, 'record').locator('[data-mind-title]');
  await expect(title).toHaveCSS('text-decoration-line', 'none');
  await expect(node(page, 'record').locator('.mind-node')).toHaveCSS('opacity', '1');
  await expect(node(page, 'record').getByRole('checkbox')).toHaveCount(0);
  await title.click();
  const inspector = page.locator('[data-inspector]');
  await expect(inspector).toContainText('文本节点详情');
  await expect(inspector.getByPlaceholder('记录说明、结论或数据…')).toHaveValue('原始数据与结论');
  await inspector.getByPlaceholder('记录说明、结论或数据…').fill('样本数 42，误差 0.3%。后续沿用这个参数。');
  await inspector.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(inspector).toHaveCount(0);
  await page.reload();
  await node(page, 'record').locator('[data-mind-title]').click();
  await expect(inspector.getByPlaceholder('记录说明、结论或数据…')).toHaveValue('样本数 42，误差 0.3%。后续沿用这个参数。');
  await page.screenshot({ path: testInfo.outputPath('text-leaf-details.png') });
  await page.goto('/tasks?project=project&view=list&scope=all&taskTag=notes');
  const row = page.locator('[data-row][data-task-id="record"]');
  await expect(row).toBeVisible();
  await expect(row.getByTitle('文本节点', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '实验结果 42', exact: true })).toHaveCSS('text-decoration-line', 'none');
});

test('single root conversion creates a text leaf, preserves its content and restores TODO controls', async ({ page }) => {
  await seed(page, [task('standalone', { title: '单独一条记录', status: 'done', completedAt: 100, notes: 'keep this result' })]);
  await page.goto('/tasks?root=standalone&view=mindmap&scope=all');
  await node(page, 'standalone').click({ button: 'right' });
  await page.getByRole('button', { name: '转为文本节点', exact: true }).click();
  await expect(node(page, 'standalone').getByRole('checkbox')).toHaveCount(0);
  await expect(node(page, 'standalone').locator('[data-mind-title]')).toHaveCSS('text-decoration-line', 'none');
  await expect(page.getByRole('navigation', { name: '项目', exact: true }).getByRole('link', { name: '单独一条记录', exact: true })).toHaveCount(0);
  await node(page, 'standalone').locator('[data-mind-title]').click();
  const inspector = page.locator('[data-inspector]');
  await expect(inspector).toContainText('文本节点详情');
  await expect(inspector.getByRole('textbox', { name: '任务备注', exact: true })).toHaveValue('keep this result');
  await inspector.getByRole('button', { name: '更多任务设置', exact: true }).click();
  await expect(inspector.getByRole('button', { name: '文本节点', exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: 'TODO 任务', exact: true }).click();
  await expect(node(page, 'standalone').getByRole('checkbox')).toBeChecked();
  await expect(inspector.getByRole('textbox', { name: '任务备注', exact: true })).toHaveValue('keep this result');
});
