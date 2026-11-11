import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.use({ serviceWorkers: 'block', viewport: { width: 1600, height: 1000 } });
const stamp = new Date('2026-11-09T18:00:00+08:00').getTime();
const task = (id: string, patch = {}) => ({ id, title: id, status: 'todo', parentId: null, ownerId: 'fixture', order: 0, tags: [], important: false, urgent: false, createdAt: 1, updatedAt: 1, ...patch });
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const inspector = (page: Page) => page.getByRole('region', { name: '任务详情', exact: true });
async function seed(page: Page, tasks: unknown[], settings = {}) {
  await page.clock.setFixedTime(new Date('2026-11-09T12:00:00+08:00'));
  await page.goto('/settings');
  await page.locator('input[type=file]').setInputFiles({ name: 'navigation.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ tasks, settings })) });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
}
async function exported(page: Page) {
  await page.locator('a[href="/settings"]').first().click();
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  return JSON.parse(await readFile((await (await waiting).path())!, 'utf8')).data;
}

test('mind-map details are discoverable and remain open while switching tasks, without moving the camera or losing drafts', async ({ page }) => {
  await seed(page, [task('p', { kind: 'node', project: true }), task('alpha', { parentId: 'p' }), task('beta', { parentId: 'p', order: 1 })]);
  await page.goto('/tasks?project=p&view=mindmap&scope=all');
  await expect(page.locator('.react-flow__edge-path')).toHaveCount(2);
  await node(page, 'alpha').hover();
  const camera = await page.locator('.react-flow__viewport').getAttribute('style');
  await node(page, 'alpha').getByRole('button', { name: '查看任务详情 alpha', exact: true }).click();
  await expect(inspector(page).getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue('alpha');
  await inspector(page).getByRole('textbox', { name: '任务备注', exact: true }).fill('切换时保留的笔记');
  await page.evaluate(() => { (window as any).__detailElement = document.querySelector('[data-inspector]'); });
  await node(page, 'beta').locator('[data-mind-title]').click();
  await expect(inspector(page).getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue('beta');
  expect(await page.evaluate(() => (window as any).__detailElement === document.querySelector('[data-inspector]'))).toBe(true);
  expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(camera);
  await node(page, 'alpha').locator('[data-mind-title]').click();
  await expect(inspector(page).getByRole('textbox', { name: '任务备注', exact: true })).toHaveValue('切换时保留的笔记');
  await inspector(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(inspector(page)).toHaveCount(0);
  await page.keyboard.press('Control+Enter');
  await expect(inspector(page)).toBeVisible();
});

test('calendar, mind map and list locate the same nested task and preserve pending notes', async ({ page }) => {
  await seed(page, [task('p', { kind: 'node', project: true }), task('phase', { parentId: 'p', kind: 'node' }), task('target', { parentId: 'phase', dueAt: stamp }), task('other-project', { kind: 'node', project: true }), task('foreign', { parentId: 'other-project', dueAt: stamp + 86400000 })]);
  await page.goto('/tasks?view=timeline&scope=custom&from=2026-11-09&to=2026-11-09');
  await page.locator('[data-calendar-task="target"]').click();
  await page.getByRole('textbox', { name: '任务备注', exact: true }).fill('定位前未失焦的备注');
  await page.getByRole('link', { name: '在导图中定位', exact: true }).click();
  await expect(page).toHaveURL(/focusTask=target/);
  await expect(page).toHaveURL(/project=p/);
  await expect(node(page, 'target')).toHaveClass(/selected/);
  await expect(node(page, 'target')).toBeInViewport();
  await expect(node(page, 'foreign')).toHaveCount(0);
  await node(page, 'target').getByRole('button', { name: '查看任务详情 target', exact: true }).click();
  await expect(inspector(page).getByRole('textbox', { name: '任务备注', exact: true })).toHaveValue('定位前未失焦的备注');
  await inspector(page).getByRole('link', { name: '在日历中定位', exact: true }).click();
  await expect(page.getByTestId('day-scroll')).toBeVisible();
  const marker = page.locator('[data-calendar-task="target"]');
  await expect(marker).toHaveAttribute('data-focused', 'true');
  await expect(marker).toBeInViewport();
  await marker.click();
  await page.getByRole('link', { name: '在列表中定位', exact: true }).click();
  await expect(page.locator('[data-row][data-task-id="target"]')).toBeInViewport();
  await expect(inspector(page).getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue('target');
  expect((await exported(page)).tasks.find((task: any) => task.id === 'target').notes).toBe('定位前未失焦的备注');
});

test('navigation unfolds collapsed ancestry and reveals a completed target without changing hidden-completed preferences', async ({ page }) => {
  await seed(page, [task('p', { kind: 'node', project: true }), task('phase', { parentId: 'p', kind: 'node' }), task('done', { parentId: 'phase', status: 'done', dueAt: stamp - 60 * 86400000 }), task('other-done', { parentId: 'p', status: 'done', dueAt: stamp })], { completedDisplay: 'hidden' });
  await page.goto('/tasks?project=p&view=mindmap&scope=all');
  await node(page, 'p').getByRole('button', { name: '折叠 p 的子项', exact: true }).click();
  await page.goto('/tasks?project=p&view=mindmap&scope=all&focusTask=done');
  await expect(node(page, 'done')).toHaveClass(/selected/);
  await expect(node(page, 'done')).toBeInViewport();
  await expect(node(page, 'other-done')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '隐藏已完成', exact: true })).toBeChecked();
  await node(page, 'done').getByRole('button', { name: '查看任务详情 done', exact: true }).click();
  await inspector(page).getByRole('link', { name: '在列表中定位', exact: true }).click();
  await expect(page.locator('[data-row][data-task-id="done"]')).toBeVisible();
  await page.getByRole('region', { name: '工作概览', exact: true }).getByRole('button', { name: '本周', exact: true }).click();
  await expect(page).not.toHaveURL(/focusTask/);
  await expect(page.locator('[data-row][data-task-id="done"]')).toHaveCount(0);
  expect((await exported(page)).settings.completedDisplay).toBe('hidden');
});

test('standalone unscheduled tasks can move between mind-map, calendar and list contexts', async ({ page }) => {
  await seed(page, [task('standalone')]);
  await page.goto('/tasks?view=mindmap&scope=all&root=standalone&focusTask=standalone');
  await expect(node(page, 'standalone')).toBeVisible();
  await node(page, 'standalone').getByRole('button', { name: '查看任务详情 standalone', exact: true }).click();
  await inspector(page).getByRole('link', { name: '在日历中定位', exact: true }).click();
  const tray = page.getByRole('region', { name: '日历未排期任务', exact: true });
  await expect(tray.getByText('standalone', { exact: true })).toBeVisible();
  await tray.getByText('standalone', { exact: true }).click();
  await page.getByRole('link', { name: '在列表中定位', exact: true }).click();
  await expect(page.locator('[data-row][data-task-id="standalone"]')).toBeVisible();
});

test('a delayed close for one calendar task cannot dismiss a newly selected task', async ({ page }) => {
  await seed(page, [task('alpha', { dueAt: stamp }), task('beta', { dueAt: stamp + 3600000 })]);
  await page.goto('/tasks?view=timeline&scope=custom&from=2026-11-09&to=2026-11-09');
  await page.locator('[data-calendar-task="alpha"]').click();
  await page.getByRole('textbox', { name: '任务备注', exact: true }).fill('需要落盘的笔记');
  await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
    (window as any).__pendingCompletions = [];
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { configurable: true, get: original.get, set(callback) {
      original.set!.call(this, function (this: IDBTransaction, event: Event) { (window as any).__pendingCompletions.push(() => callback.call(this, event)); });
    } });
    (window as any).__restoreCompletions = () => { Object.defineProperty(IDBTransaction.prototype, 'oncomplete', original); for (const complete of (window as any).__pendingCompletions.splice(0)) complete(); };
  });
  const heading = (await page.getByRole('heading', { name: '当前任务', exact: true }).boundingBox())!;
  await page.mouse.click(heading.x + 8, heading.y + 8);
  await page.locator('[data-calendar-task="beta"]').click();
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue('beta');
  await expect.poll(() => page.evaluate(() => (window as any).__pendingCompletions.length)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).__restoreCompletions());
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue('beta');
  expect((await exported(page)).tasks.find((task: any) => task.id === 'alpha').notes).toBe('需要落盘的笔记');
});

test('switching calendar task details reuses the same panel and keeps pending text', async ({ page }) => {
  await seed(page, [task('alpha', { dueAt: stamp }), task('beta', { dueAt: stamp + 3600000 })]);
  await page.goto('/tasks?view=timeline&scope=custom&from=2026-11-09&to=2026-11-09');
  await page.locator('[data-calendar-task="alpha"]').click();
  await page.getByRole('textbox', { name: '任务备注', exact: true }).fill('即时切换保留');
  await page.evaluate(() => { (window as any).__sheetElement = document.querySelector('[data-task-sheet]'); });
  await page.locator('[data-calendar-task="beta"]').click();
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue('beta');
  expect(await page.evaluate(() => (window as any).__sheetElement === document.querySelector('[data-task-sheet]'))).toBe(true);
  await page.locator('[data-calendar-task="alpha"]').click();
  await expect(page.getByRole('textbox', { name: '任务备注', exact: true })).toHaveValue('即时切换保留');
});

test('mobile task details open without focusing the title and can locate the task in its mind map', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, [task('p', { kind: 'node', project: true }), task('mobile', { parentId: 'p', dueAt: stamp })]);
  await page.goto('/tasks?project=p&view=timeline&scope=custom&from=2026-11-09&to=2026-11-09');
  await page.locator('[data-calendar-task="mobile"]').click();
  const sheet = page.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(sheet).toBeFocused();
  await expect(sheet.getByRole('textbox', { name: '任务标题', exact: true })).not.toBeFocused();
  await sheet.getByRole('link', { name: '在导图中定位', exact: true }).click();
  await expect(node(page, 'mobile')).toHaveClass(/selected/);
  await expect(node(page, 'mobile')).toBeInViewport();
  await node(page, 'mobile').getByRole('button', { name: '查看任务详情 mobile', exact: true }).click();
  await expect(inspector(page)).toBeInViewport();
  const bounds = (await inspector(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
});

for (const view of ['gantt', 'matrix']) test(`${view} task selection keeps the same details panel open`, async ({ page }) => {
  await seed(page, [task('alpha', { dueAt: stamp }), task('beta', { dueAt: stamp + 3600000 })]);
  await page.goto(`/tasks?view=${view}&scope=week`);
  const item = (id: string) => view === 'gantt' ? page.getByRole('button', { name: id, exact: true }) : page.getByText(id, { exact: true });
  await item('alpha').click();
  await page.getByRole('textbox', { name: '任务备注', exact: true }).fill('切换前的备注');
  await page.evaluate(() => { (window as any).__sheetElement = document.querySelector('[data-task-sheet]'); });
  await item('beta').click();
  await expect(page.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue('beta');
  expect(await page.evaluate(() => (window as any).__sheetElement === document.querySelector('[data-task-sheet]'))).toBe(true);
  expect((await exported(page)).tasks.find((task: any) => task.id === 'alpha').notes).toBe('切换前的备注');
});

test('single click opens MindMap details by default; its account preference survives reload and modifiers keep multiselect', async ({ page }) => {
  await seed(page, [task('p', { kind: 'node', project: true }), task('alpha', { parentId: 'p' }), task('beta', { parentId: 'p', order: 1 })]);
  await page.goto('/tasks?project=p&view=mindmap&scope=all');
  await node(page, 'alpha').locator('[data-mind-title]').click();
  await expect(inspector(page).getByLabel('任务标题', { exact: true })).toHaveValue('alpha');
  await inspector(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.getByRole('button', { name: '任务交互设置', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: '单击任务打开详情', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemcheckbox', { name: '单击任务打开详情', exact: true }).click();
  await node(page, 'beta').locator('[data-mind-title]').click();
  await expect(inspector(page)).toHaveCount(0);
  await page.keyboard.press('Control+Enter');
  await expect(inspector(page)).toBeVisible();
  await inspector(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.reload();
  await node(page, 'beta').locator('[data-mind-title]').click();
  await expect(inspector(page)).toHaveCount(0);
  await page.getByRole('button', { name: '任务交互设置', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: '单击任务打开详情', exact: true })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('menuitemcheckbox', { name: '单击任务打开详情', exact: true }).click();
  await node(page, 'alpha').locator('[data-mind-title]').click();
  await node(page, 'beta').locator('[data-mind-title]').click({ modifiers: ['Control'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(inspector(page)).toHaveCount(0);
});

test('all task workspaces share the compact inspector, navigation caption and advanced fields', async ({ page }) => {
  await seed(page, [task('p', { kind: 'node', project: true }), task('target', { parentId: 'p', dueAt: stamp })]);
  for (const view of ['mindmap', 'gantt', 'matrix', 'timeline']) {
    await page.goto(`/tasks?project=p&view=${view}&scope=custom&from=2026-11-09&to=2026-11-09`);
    if (view === 'mindmap') await node(page, 'target').locator('[data-mind-title]').click();
    else if (view === 'gantt') await page.getByRole('button', { name: 'target', exact: true }).click();
    else if (view === 'matrix') await page.locator('[data-matrix-task="target"]').click();
    else await page.locator('[data-calendar-task="target"]').click();
    await expect(page.locator('[data-inspector]')).toHaveCount(1);
    await expect(inspector(page).getByText('跳转到', { exact: true })).toBeVisible();
    await expect(inspector(page).getByRole('navigation', { name: '任务定位', exact: true }).getByRole('link')).toHaveText(['列表', '导图', '四象限', '甘特图', '日历']);
    await expect(inspector(page).getByLabel('任务备注', { exact: true })).toBeVisible();
    await inspector(page).getByRole('button', { name: '更多任务设置', exact: true }).click();
    await expect(inspector(page).getByLabel('添加任务标签', { exact: true })).toBeVisible();
  }
});

test('task context menu reaches all project views, current tasks and valid shortcuts without changing task dates', async ({ page }) => {
  await seed(page, [task('p', { kind: 'node', project: true }), task('foreign', { kind: 'node', project: true }), task('target', { parentId: 'p', dueAt: stamp })], { savedViews: [
    { id: 'month', name: '全局月历', view: 'timeline', scope: 'month' },
    { id: 'mine', name: '项目清单', view: 'list', scope: 'all', projectId: 'p' },
    { id: 'foreign', name: '其他项目', view: 'mindmap', scope: 'all', projectId: 'foreign' },
  ] });
  for (const [name, view] of [['列表', 'list'], ['导图', 'mindmap'], ['四象限', 'matrix'], ['甘特图', 'gantt'], ['日历', 'timeline'], ['当前任务', 'gantt'], ['全局月历', 'timeline'], ['项目清单', 'list']]) {
    await page.goto('/tasks?project=p&view=mindmap&scope=all');
    await node(page, 'target').locator('[data-mind-title]').click({ button: 'right' });
    await page.getByLabel('任务菜单', { exact: true }).getByRole('button', { name: '跳转到视图', exact: true }).click();
    const menu = page.getByLabel('跳转到视图', { exact: true });
    await expect(menu.getByRole('button', { name: '其他项目', exact: true })).toBeDisabled();
    await menu.getByRole('button', { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`view=${view}`));
    await expect(page).toHaveURL(/focusTask=target/);
    if (name === '当前任务') await expect(page).not.toHaveURL(/project=/);
    else if (name === '全局月历') await expect(page).toHaveURL(/saved=month/);
    else await expect(page).toHaveURL(/project=p/);
    const marker = view === 'list' ? page.locator('[data-row][data-task-id="target"]') : view === 'mindmap' ? node(page, 'target') : view === 'matrix' ? page.locator('[data-matrix-task="target"]') : view === 'gantt' ? page.locator('[data-gantt-bar="target"]') : page.locator('[data-calendar-task="target"]').first();
    await expect(marker).toBeInViewport();
  }
  expect((await exported(page)).tasks.find((task: any) => task.id === 'target').dueAt).toBe(stamp);
});

test('calendar context navigation saves an open inspector draft and can reveal a completed matrix task beyond its 24-item limit', async ({ page }) => {
  await seed(page, [task('p', { kind: 'node', project: true }), ...Array.from({ length: 30 }, (_, i) => task(`extra-${i}`, { parentId: 'p', order: i })), task('target', { parentId: 'p', status: 'done', dueAt: stamp })], { completedDisplay: 'hidden' });
  await page.goto('/tasks?project=p&view=timeline&scope=custom&from=2026-11-09&to=2026-11-09&focusTask=target');
  await page.locator('[data-calendar-task="target"]').click();
  await inspector(page).getByLabel('任务备注', { exact: true }).fill('右键跳转也保留草稿');
  await page.locator('[data-calendar-task="target"]').click({ button: 'right' });
  await page.getByLabel('任务菜单', { exact: true }).getByRole('button', { name: '跳转到视图', exact: true }).click();
  await page.getByLabel('跳转到视图', { exact: true }).getByRole('button', { name: '四象限', exact: true }).click();
  const target = page.locator('[data-matrix-task="target"]');
  await expect(target).toBeInViewport();
  await target.click();
  await expect(inspector(page).getByLabel('任务备注', { exact: true })).toHaveValue('右键跳转也保留草稿');
});

test('undated tasks remain reachable through current tasks without receiving a fabricated schedule', async ({ page }) => {
  await seed(page, [task('p', { kind: 'node', project: true }), task('target', { parentId: 'p' })]);
  await page.goto('/tasks?project=p&view=mindmap&scope=all');
  await node(page, 'target').locator('[data-mind-title]').click({ button: 'right' });
  await page.getByLabel('任务菜单', { exact: true }).getByRole('button', { name: '跳转到视图', exact: true }).click();
  await page.getByLabel('跳转到视图', { exact: true }).getByRole('button', { name: '当前任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '当前任务', exact: true })).toBeVisible();
  await expect(page.locator('[data-row][data-task-id="target"]')).toBeInViewport();
  const target = (await exported(page)).tasks.find((task: any) => task.id === 'target');
  expect(target.startAt == null && target.dueAt == null).toBe(true);
});

test('narrow MindMap keeps its top settings accessible and uses the same mobile details surface', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await seed(page, [task('p', { kind: 'node', project: true }), task('target', { parentId: 'p' })]);
  await page.goto('/tasks?project=p&view=mindmap&scope=all');
  await expect(page.getByRole('button', { name: '任务交互设置', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await node(page, 'target').locator('[data-mind-title]').click();
  const sheet = page.getByRole('dialog', { name: '任务详情', exact: true });
  await expect(sheet).toBeFocused();
  await expect(sheet.getByLabel('任务标题', { exact: true })).toHaveValue('target');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/task-details-mobile.png' });
});
