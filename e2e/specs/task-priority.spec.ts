import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { selectValue } from '../controls';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
const dueAt = new Date('2026-11-04T18:00:00+08:00').getTime();
const task = (id: string, patch = {}) => ({ id, title: id, parentId: 'priority_project', status: 'todo', ownerId: 'fixture', order: 0, tags: [], important: false, urgent: false, createdAt: 1, updatedAt: 1, dueAt, ...patch });
const rows = (page: Page) => page.locator('[data-row]');
const overview = (page: Page) => page.getByRole('region', { name: '工作概览', exact: true });
const rowIds = (page: Page) => rows(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-task-id')));

async function seed(page: Page) {
  await page.clock.setFixedTime(new Date('2026-11-04T12:00:00+08:00'));
  await page.goto('/settings');
  await page.locator('input[type=file]').setInputFiles({ name: 'priority.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ tasks: [
    task('priority_project', { title: '优先级测试', kind: 'node', project: true, parentId: null, dueAt: null }),
    task('p3', { priority: 'P3' }), task('p2', { priority: 'P2', urgent: true, order: 1 }), task('p1', { priority: 'P1', important: true, order: 2 }), task('p0', { priority: 'P0', important: true, urgent: true, order: 3 }),
    task('pending', { order: 4 }), task('pending2', { order: 4.5 }), task('done', { priority: 'P0', status: 'done', order: 5 }), task('parent', { priority: 'P3', order: 6 }), task('child', { parentId: 'parent', priority: 'P0' }),
  ] })) });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
  await page.goto('/tasks?project=priority_project&view=list&scope=all');
  await expect(rows(page)).toHaveCount(9);
}

test('priority ordering retains the tree, crosses date groups, follows view changes and persists in saved views', async ({ page }, testInfo) => {
  await seed(page);
  await selectValue(page.getByRole('combobox', { name: '任务排序', exact: true }), 'priority');
  const sorted = ['p0', 'parent', 'child', 'p1', 'p2', 'p3', 'pending', 'pending2', 'done'];
  await expect.poll(() => rowIds(page)).toEqual(sorted);
  await page.screenshot({ path: testInfo.outputPath('priority-list.png') });
  await expect(rows(page).filter({ has: page.locator('[data-priority="P3"]') })).toHaveCount(4);
  await page.getByRole('tab', { name: '甘特图', exact: true }).click();
  await expect.poll(() => page.locator('[data-gantt-bar]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-gantt-bar')))).toEqual(sorted);
  await page.getByRole('button', { name: '保存为快捷视图', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '保存快捷视图', exact: true });
  await dialog.getByLabel('视图名称', { exact: true }).fill('优先级甘特图');
  await dialog.getByRole('button', { name: '保存快捷视图', exact: true }).click();
  await expect(page).toHaveURL(/taskSort=priority/);
  await page.reload();
  await expect.poll(() => page.locator('[data-gantt-bar]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-gantt-bar')))).toEqual(sorted);
  await page.getByRole('tab', { name: '列表', exact: true }).click();
  await selectValue(page.getByRole('combobox', { name: '任务排序', exact: true }), 'manual');
  await expect.poll(() => rowIds(page)).toEqual(['p3', 'p2', 'p1', 'p0', 'pending', 'pending2', 'done', 'parent', 'child']);
});

test('high and unreviewed presets surface unfinished tasks and bulk-confirming P3 removes the review queue in one undo', async ({ page }) => {
  await seed(page);
  await expect(overview(page).getByRole('button', { name: '高优', exact: true })).toHaveText('高优3');
  await overview(page).getByRole('button', { name: '高优', exact: true }).click();
  await expect.poll(() => rowIds(page)).toEqual(['p0', 'parent', 'child', 'p1']);
  await overview(page).getByRole('button', { name: '待分级', exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).locator('[data-priority-review="pending"]')).toHaveCount(2);
  await rows(page).getByText('pending', { exact: true }).click({ modifiers: ['ControlOrMeta'] });
  await rows(page).getByText('pending2', { exact: true }).click({ modifiers: ['ControlOrMeta'] });
  await page.getByRole('toolbar', { name: '所选任务操作', exact: true }).getByRole('button', { name: '批量设置优先级', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '批量设置任务', exact: true });
  await expect(editor).toContainText('待分级 · 默认 P3');
  await editor.getByRole('button', { name: 'P3 · 普通', exact: true }).click();
  await editor.getByRole('button', { name: '应用到 2 项', exact: true }).click();
  await page.getByRole('dialog', { name: '批量设置完成', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await expect(overview(page).getByRole('button', { name: '待分级', exact: true })).toHaveText('待分级0');
  await expect(rows(page)).toHaveCount(0);
  await page.getByRole('button', { name: '撤销 (⌘Z)', exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('combobox', { name: '任务排序', exact: true })).toBeInViewport();
  }
});

test('calendar month puts high-priority tasks first and a child created under P0 defaults to an unreviewed P3', async ({ page }) => {
  await seed(page);
  await page.goto('/tasks?project=priority_project&view=timeline&scope=month');
  const day = page.locator('[data-calendar-date="2026-11-04"]');
  await expect.poll(() => day.locator('[data-calendar-task]').evaluateAll(nodes => nodes.slice(0, 2).map(node => node.getAttribute('data-calendar-task')))).toEqual(['child', 'p0']);
  await page.goto('/tasks?project=priority_project&view=mindmap&scope=all');
  await page.getByRole('button', { name: '全局视图', exact: true }).click();
  await page.locator('.react-flow__node[data-id="p0"] [data-mind-title]').click();
  await page.getByRole('region', { name: '任务导图画布', exact: true }).focus();
  await page.keyboard.press('Tab');
  const title = page.getByRole('textbox', { name: '导图节点标题', exact: true });
  await title.fill('新任务默认P3');
  await title.press('Enter');
  await page.locator('a[href="/settings"]').first().click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const data = JSON.parse(await readFile((await (await downloading).path())!, 'utf8'));
  const created = data.data.tasks.find((task: any) => task.title === '新任务默认P3');
  expect(created).toMatchObject({ parentId: 'p0', important: false, urgent: false });
  expect(created.priority ?? 'P3').toBe('P3');
});
