import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { selectValue } from '../controls';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
const stamp = (day: string, time: string) => new Date(`${day}T${time}:00+08:00`).getTime();
const task = (id: string, patch = {}) => ({ id, title: id, parentId: 'batch_project', status: 'todo', ownerId: 'fixture', order: 0, tags: [], important: false, urgent: false, createdAt: 1, updatedAt: 1, ...patch });
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const toolbar = (page: Page) => page.getByRole('toolbar', { name: '所选任务操作', exact: true });
const editor = (page: Page) => page.getByRole('dialog', { name: '批量设置任务', exact: true });
async function seed(page: Page) {
  await page.goto('/settings');
  await page.locator('input[type=file]').setInputFiles({ name: 'batch.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ tasks: [
    task('batch_project', { title: '批量操作测试', parentId: null, kind: 'node', project: true }),
    task('alpha', { title: '任务 Alpha', priority: 'P3', startAt: stamp('2026-11-01', '09:00'), dueAt: stamp('2026-11-03', '18:30'), notes: 'keep notes' }),
    task('beta', { title: '任务 Beta', order: 1, priority: 'P2', startAt: null, dueAt: stamp('2026-11-04', '20:00') }),
    task('other', { title: '不应被修改', order: 2, priority: 'P0', important: true, urgent: true, dueAt: stamp('2026-11-10', '12:00') }),
  ] })) });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
  await page.goto('/tasks?project=batch_project&view=mindmap&scope=all');
  await expect(node(page, 'beta')).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  await expect.poll(() => node(page, 'alpha').evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(20);
}
async function lasso(page: Page) {
  const a = (await node(page, 'alpha').boundingBox())!, b = (await node(page, 'beta').boundingBox())!;
  const x = Math.min(a.x, b.x) - 12, y = Math.min(a.y, b.y) - 12;
  const right = Math.max(a.x + a.width, b.x + b.width) + 12, bottom = Math.max(a.y + a.height, b.y + b.height) + 12;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(right, bottom, { steps: 12 });
  await expect(page.locator('.react-flow__selection')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(page.locator('.react-flow__nodesselection')).toBeHidden();
  await expect(toolbar(page)).toContainText('已选 2 项');
}
async function exported(page: Page) {
  await page.locator('a[href="/settings"]').first().click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  return JSON.parse(await readFile((await (await downloading).path())!, 'utf8')).data.tasks as any[];
}

test('lasso keeps only individual selection markers and selected-node context priority is one undo', async ({ page }) => {
  await seed(page); await lasso(page);
  await page.evaluate(() => { document.addEventListener('contextmenu', event => { document.body.dataset.contextPrevented = String(event.defaultPrevented); }); });
  await node(page, 'alpha').click({ button: 'right' });
  await expect(page.locator('body')).toHaveAttribute('data-context-prevented', 'true');
  await expect(page.getByLabel('任务菜单', { exact: true })).toContainText('已选 2 项');
  await page.getByRole('button', { name: '优先级', exact: true }).hover();
  await page.getByRole('button', { name: 'P1 · 重要', exact: true }).click();
  await page.getByRole('button', { name: '撤销 (⌘Z)', exact: true }).click();
  let tasks = await exported(page);
  expect(tasks.find(task => task.id === 'alpha').priority).toBe('P3');
  expect(tasks.find(task => task.id === 'beta').priority).toBe('P2');
  await page.getByRole('button', { name: '重做 (⌘⇧Z)', exact: true }).click();
  tasks = await exported(page);
  for (const id of ['alpha', 'beta']) expect(tasks.find(task => task.id === id)).toMatchObject({ priority: 'P1', important: true, urgent: false });
  expect(tasks.find(task => task.id === 'other')).toMatchObject({ priority: 'P0', dueAt: stamp('2026-11-10', '12:00') });
});

test('selection toolbar edits only chosen date endpoints, cancel does not write and the batch persists', async ({ page }, testInfo) => {
  await seed(page); await lasso(page);
  const a = (await node(page, 'alpha').boundingBox())!, b = (await node(page, 'beta').boundingBox())!;
  // The former invisible selection overlay must not intercept this empty gap.
  await page.mouse.click(a.x + 10, (a.y + a.height + b.y) / 2, { button: 'right' });
  await page.getByRole('button', { name: '设定时间', exact: true }).hover();
  await page.getByRole('button', { name: /自定义…/ }).click();
  await expect(editor(page)).toContainText('多个值');
  await selectValue(editor(page).getByRole('combobox', { name: '截止操作', exact: true }), 'set');
  await editor(page).getByLabel('截止日期', { exact: true }).fill('2026-11-20');
  await editor(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await toolbar(page).getByRole('button', { name: '批量设置时间', exact: true }).click();
  await selectValue(editor(page).getByRole('combobox', { name: '截止操作', exact: true }), 'set');
  await editor(page).getByLabel('截止日期', { exact: true }).fill('2026-11-06');
  await page.screenshot({ path: testInfo.outputPath('batch-dates.png') });
  await editor(page).getByRole('button', { name: '应用到 2 项', exact: true }).click();
  await page.getByRole('dialog', { name: '批量设置完成', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  const tasks = await exported(page);
  expect(tasks.find(task => task.id === 'alpha')).toMatchObject({ startAt: stamp('2026-11-01', '09:00'), dueAt: stamp('2026-11-06', '18:30'), notes: 'keep notes', priority: 'P3' });
  expect(tasks.find(task => task.id === 'beta')).toMatchObject({ startAt: null, dueAt: stamp('2026-11-06', '20:00'), priority: 'P2' });
});

test('batch menu converts selected tasks and groups without offering single-item actions or converting projects', async ({ page }) => {
  await seed(page);
  await page.getByRole('region', { name: '任务导图画布', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+a');
  await node(page, 'alpha').click({ button: 'right' });
  const menu = page.locator('[data-task-menu] div[aria-label="任务菜单"]');
  for (const name of ['创建子任务', '打开详情', '编辑项目', '跳转到视图']) await expect(menu.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(menu).toContainText('1 个项目保留项目身份');
  await menu.getByRole('button', { name: /^转为分组/ }).click();
  await expect(node(page, 'alpha').getByRole('checkbox')).toHaveCount(0);
  await node(page, 'alpha').click({ button: 'right' });
  await menu.getByRole('button', { name: /^转为 Task/ }).click();
  await expect(node(page, 'alpha').getByRole('checkbox')).toHaveCount(1);
  await page.getByRole('button', { name: '撤销 (⌘Z)', exact: true }).click();
  for (const id of ['alpha', 'beta', 'other']) await expect(node(page, id).getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('button', { name: '重做 (⌘⇧Z)', exact: true }).click();
  const tasks = await exported(page);
  for (const id of ['alpha', 'beta', 'other']) expect(tasks.find(task => task.id === id)).toMatchObject({ kind: 'todo', parentId: 'batch_project', project: false });
  expect(tasks.find(task => task.id === 'batch_project')).toMatchObject({ kind: 'node', parentId: null, project: true });
  expect(tasks.find(task => task.id === 'alpha')).toMatchObject({ notes: 'keep notes', startAt: stamp('2026-11-01', '09:00'), dueAt: stamp('2026-11-03', '18:30'), priority: 'P3' });
});

test('batch folding traverses every selected branch including descendants, with a leaf as the context anchor', async ({ page }) => {
  await seed(page);
  await page.goto('/settings');
  await page.locator('input[type=file]').setInputFiles({ name: 'branches.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ tasks: [
    task('a_child', { parentId: 'alpha' }), task('a_grandchild', { parentId: 'a_child' }),
    task('b_child', { parentId: 'beta' }), task('b_grandchild', { parentId: 'b_child' }),
    task('other_child', { parentId: 'other' }),
  ] })) });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
  await page.goto('/tasks?project=batch_project&view=mindmap&scope=all');
  await page.getByRole('button', { name: '全局视图', exact: true }).click();
  await node(page, 'alpha').locator('[data-mind-title]').click({ modifiers: ['ControlOrMeta'] });
  await node(page, 'beta').locator('[data-mind-title]').click({ modifiers: ['ControlOrMeta'] });
  await node(page, 'a_grandchild').locator('[data-mind-title]').click({ modifiers: ['ControlOrMeta'] });
  await expect(toolbar(page)).toContainText('已选 3 项');
  await node(page, 'a_grandchild').click({ button: 'right' });
  await page.getByRole('button', { name: '折叠全部子任务', exact: true }).click();
  for (const id of ['a_child', 'a_grandchild', 'b_child', 'b_grandchild']) await expect(node(page, id)).toHaveCount(0);
  await expect(node(page, 'other_child')).toBeVisible();
  await expect(toolbar(page)).toContainText('已选 2 项');
  await node(page, 'alpha').click({ button: 'right' });
  await page.getByRole('button', { name: '展开全部子任务', exact: true }).click();
  for (const id of ['a_child', 'a_grandchild', 'b_child', 'b_grandchild']) await expect(node(page, id)).toBeVisible();
  await node(page, 'other').click({ button: 'right' });
  await expect(page.locator('[data-task-menu] div[aria-label="任务菜单"]').getByRole('button', { name: '创建子任务', exact: true })).toBeVisible();
});

test('right-click outside a list selection only affects that task; list toolbar exposes batch settings', async ({ page }) => {
  await seed(page);
  await page.getByRole('tab', { name: '列表', exact: true }).click();
  const row = (id: string) => page.locator(`[data-row][data-task-id="${id}"]`);
  await row('alpha').click({ modifiers: ['ControlOrMeta'] });
  await row('beta').click({ modifiers: ['ControlOrMeta'] });
  await expect(toolbar(page)).toContainText('已选 2 项');
  await expect(toolbar(page).getByRole('button', { name: '批量设置时间', exact: true })).toBeVisible();
  await toolbar(page).getByRole('button', { name: '批量设置优先级', exact: true }).click();
  await editor(page).getByRole('button', { name: 'P1 · 重要', exact: true }).click();
  await editor(page).getByRole('button', { name: '应用到 2 项', exact: true }).click();
  await page.getByRole('dialog', { name: '批量设置完成', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await row('other').click({ button: 'right' });
  await expect(page.locator('[data-task-menu] div[aria-label="任务菜单"]')).not.toContainText('已选 2 项');
  await page.getByRole('button', { name: '优先级', exact: true }).hover();
  await page.getByRole('button', { name: 'P2 · 紧急', exact: true }).click();
  const tasks = await exported(page);
  for (const id of ['alpha', 'beta']) expect(tasks.find(task => task.id === id).priority).toBe('P1');
  expect(tasks.find(task => task.id === 'other').priority).toBe('P2');
});

test('mixed structure selection skips the root and date conflicts block the entire apply', async ({ page }) => {
  await seed(page);
  await page.getByRole('region', { name: '任务导图画布', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(toolbar(page)).toContainText('已选 4 项');
  await toolbar(page).getByRole('button', { name: '批量设置时间', exact: true }).click();
  await expect(editor(page)).toContainText('3 项任务可设置');
  await expect(editor(page)).toContainText('1 项分组');
  await selectValue(editor(page).getByRole('combobox', { name: '截止操作', exact: true }), 'set');
  await editor(page).getByLabel('截止日期', { exact: true }).fill('2026-10-01');
  await expect(editor(page).getByRole('alert')).toContainText('截止早于开始');
  await expect(editor(page).getByRole('button', { name: /^应用到/ })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(editor(page)).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const tasks = await exported(page);
  expect(tasks.find(task => task.id === 'alpha').dueAt).toBe(stamp('2026-11-03', '18:30'));
  expect(tasks.find(task => task.id === 'beta').dueAt).toBe(stamp('2026-11-04', '20:00'));
});
