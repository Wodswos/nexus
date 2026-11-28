import { test, expect, type Page } from '@playwright/test';

const task = (id: string, patch: Record<string, unknown> = {}) => ({ id, title: id, parentId: null, status: 'todo', order: 0, ownerId: 'fixture', tags: [], important: false, urgent: false, createdAt: 1, updatedAt: 1, ...patch });
async function seed(page: Page, tasks: unknown[]) {
  await page.goto('/settings');
  await page.locator('input[type=file]').setInputFiles({ name: 'ui.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ tasks, settings: { mindClickOpensDetails: false } })) });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
}
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const fixture = [task('design', { title: 'AIDD & Bio', kind: 'node', project: true }), task('branch', { title: 'Design', kind: 'node', parentId: 'design' }), task('action', { title: '统一默认界面 Design tokens', parentId: 'branch' }), task('done', { title: '规范文档', status: 'done', parentId: 'branch', order: 1 })];

test('desktop chrome, semantic colors, nested controls and keyboard states follow the specification', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ colorScheme: 'light' });
  await seed(page, fixture);
  await page.goto('/tasks?project=design&view=mindmap');
  await expect(node(page, 'action')).toBeVisible();
  const toolbar = page.locator('[data-task-toolbar]');
  expect((await toolbar.boundingBox())!.y).toBe(0);
  await expect(toolbar).toHaveCSS('height', '52px');
  await expect(page.getByRole('region', { name: '任务导图画布', exact: true })).toBeVisible();
  await expect(page.locator('[aria-label="任务筛选与强调"]')).toHaveCSS('height', '40px');
  await expect(page.locator('.workspace-sidebar')).toHaveCSS('width', '232px');
  await expect(page.getByRole('button', { name: '添加任务' })).toHaveCSS('height', '34px');
  await expect(page.getByRole('button', { name: '添加任务' }).locator('kbd')).toHaveText('N');
  const tabs = page.getByRole('tablist', { name: '任务视图' });
  await expect(tabs).toHaveCSS('height', '32px');
  await expect(tabs).toHaveCSS('border-radius', '8px');
  await expect(tabs.getByRole('tab', { name: '导图', exact: true })).toHaveCSS('height', '28px');
  await expect(tabs.getByRole('tab', { name: '导图', exact: true })).toHaveCSS('border-radius', '6px');
  await expect(node(page, 'branch').locator('.mind-node')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(node(page, 'design').locator('.mind-node')).toHaveCSS('background-color', 'rgb(46, 111, 94)');
  await expect(node(page, 'design').locator('[data-mind-title]')).toHaveCSS('font-size', '14px');
  await expect(node(page, 'design').getByRole('progressbar')).toHaveCSS('height', '2px');
  const capture = page.getByRole('button', { name: '添加任务' });
  await capture.hover();
  await expect(capture).toHaveCSS('border-color', 'rgba(15, 23, 42, 0.18)');
  await capture.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  await expect(capture).toHaveCSS('outline-width', '2px');
  await expect(capture).toHaveCSS('outline-color', 'rgb(46, 111, 94)');
  const redo = page.getByRole('button', { name: '重做 (⌘⇧Z)', exact: true }).filter({ visible: true });
  await expect(redo).toBeDisabled();
  await expect(redo).toHaveCSS('opacity', '0.45');
  await page.mouse.move(800, 100);
  await page.screenshot({ path: info.outputPath('desktop-mindmap.png') });
  await page.getByRole('tab', { name: '列表', exact: true }).click();
  await expect(page.getByText('统一默认界面 Design tokens', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('desktop-list.png') });
});

test('Bezier paths highlight related nodes without moving them; dots fade below half zoom', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await seed(page, fixture);
  await page.goto('/tasks?project=design&view=mindmap');
  const edge = page.locator('.react-flow__edge').filter({ has: page.locator('path') }).first().locator('path').first();
  await expect(edge).toHaveAttribute('d', / C /);
  const geometry = await edge.getAttribute('d');
  const numbers = geometry!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = numbers;
  expect(c1x).toBeCloseTo((x1! + x2!) / 2); expect(c2x).toBeCloseTo(c1x!);
  expect(c1y).toBe(y1); expect(c2y).toBe(y2);
  await expect(edge).toHaveCSS('stroke-width', '1.5px');
  const before = await node(page, 'branch').evaluate(el => (el as HTMLElement).style.transform);
  await node(page, 'branch').hover();
  await expect(edge).toHaveCSS('stroke', 'rgb(46, 111, 94)');
  await expect(edge).toHaveCSS('stroke-width', '2px');
  await node(page, 'branch').click();
  expect(await node(page, 'branch').evaluate(el => (el as HTMLElement).style.transform)).toBe(before);
  await expect(node(page, 'branch').locator('.mind-node')).toHaveClass(/mind-node-selected/);
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: '缩小', exact: true }).click();
  await expect(page.locator('.react-flow__background')).toHaveCSS('opacity', '0');
  await page.getByRole('button', { name: '恢复100%缩放', exact: true }).click();
  await expect(page.locator('.react-flow__background')).toHaveCSS('opacity', '1');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('.mindmap-flow')).toHaveCSS('background-color', 'rgb(15, 23, 42)');
  await expect(node(page, 'branch').locator('.mind-node')).toHaveCSS('background-color', 'rgb(15, 23, 42)');
  await expect(node(page, 'branch').locator('[data-mind-title]')).toHaveCSS('color', 'rgb(248, 250, 252)');
  await page.screenshot({ path: info.outputPath('dark-mindmap.png') });
});

test('long mixed titles, empty data and 999+ counts remain inside the viewport', async ({ page }, info) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  const long = '超长项目标题 Long project name '.repeat(15);
  await seed(page, [task('empty', { title: long, kind: 'node', project: true }), ...Array.from({ length: 1001 }, (_, i) => task(`count-${i}`, { dueAt: Date.now() + 86400000 }))]);
  await page.goto('/tasks?project=empty&view=list');
  const title = page.locator('[data-task-toolbar] h1 button');
  await expect(title).toHaveCSS('text-overflow', 'ellipsis');
  expect(await title.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(page.locator('.task-filters .ui-count').first()).toHaveText('0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto('/tasks?view=list');
  await expect(page.getByRole('button', { name: '待分级', exact: true }).locator('.ui-count')).toHaveText('999+');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tasks?project=empty&view=list');
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await expect(page.locator('.workspace-sidebar')).toHaveCSS('position', 'fixed');
  await expect.poll(async () => (await page.locator('.workspace-sidebar').boundingBox())!.x).toBe(0);
  await expect(page.getByRole('button', { name: '添加任务' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-sidebar.png') });
});

test('legacy themes migrate to the single accent; controls keep readable text in both modes', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cortex-theme', JSON.stringify({ state: { mode: 'light', accent: 'cyan-violet' }, version: 0 })));
  await page.goto('/settings');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'emerald');
  const choices = page.getByRole('group', { name: '强调色', exact: true });
  await expect(choices.getByRole('button')).toHaveCount(2);
  await choices.getByRole('button', { name: '石墨', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'mono');
  await expect(choices.getByRole('button', { name: '松绿', exact: true })).toHaveCSS('background-color', 'rgb(46, 111, 94)');
  await choices.getByRole('button', { name: '松绿', exact: true }).click();
  const ratios = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    const rgb = (token: string) => { const el = document.createElement('span'); el.style.color = styles.getPropertyValue(token); document.body.append(el); const value = getComputedStyle(el).color.match(/[\d.]+/g)!.slice(0, 3).map(Number); el.remove(); return value; };
    const lum = (color: number[]) => color.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    return [['--text-primary', '--bg-canvas'], ['--text-secondary', '--bg-subtle'], ['--text-muted', '--bg-canvas'], ['--text-secondary', '--bg-muted'], ['--text-inverse', '--accent-primary']].map(([fg, bg]) => { const a = lum(rgb(fg!)), b = lum(rgb(bg!)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); });
  });
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(15, 23, 42)');
});
