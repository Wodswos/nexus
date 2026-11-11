import { test, expect, type Page } from '@playwright/test';
import { expectSelectValue, selectValue } from '../controls';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
const panel = (page: Page) => page.locator('[data-inspector]');
const period = (page: Page) => page.getByRole('combobox', { name: '任务时间范围', exact: true });
async function seed(page: Page, taskPatch = {}) {
  await page.clock.setFixedTime(new Date('2026-11-10T10:00:00+08:00'));
  await page.goto('/settings');
  const base = {
    ownerId: 'fixture',
    status: 'todo',
    order: 0,
    tags: [],
    important: false,
    urgent: false,
    createdAt: 1,
    updatedAt: 1,
  };
  await page.locator('input[type=file]').setInputFiles({
    name: 'controls.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        tasks: [
          {
            ...base,
            id: 'project',
            title: '设置体验',
            kind: 'node',
            project: true,
            parentId: null,
          },
          {
            ...base,
            id: 'task',
            title: '调整设置面板',
            parentId: 'project',
            dueAt: new Date('2026-11-15T18:00:00+08:00').getTime(),
            ...taskPatch,
          },
        ],
        links: [
          {
            id: 'resource',
            taskId: 'task',
            type: 'url',
            target: 'https://example.com/design',
            title: '设计文档',
            createdAt: 1,
          },
        ],
      }),
    ),
  });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
  await page.goto('/tasks?project=project&view=list&scope=all');
}
async function openTask(page: Page) {
  await page.locator('[data-row]').getByText('调整设置面板', { exact: true }).click();
  await expect(panel(page)).toBeVisible();
}

test('workspace precedes notes; date drafts, keyboard calendar navigation and priority selection persist correctly', async ({
  page,
}, testInfo) => {
  await seed(page);
  await openTask(page);
  const workspace = await panel(page)
    .getByRole('region', { name: '任务工作区', exact: true })
    .boundingBox();
  const notes = await panel(page).getByLabel('任务备注', { exact: true }).boundingBox();
  expect(workspace!.y + workspace!.height).toBeLessThan(notes!.y);
  await panel(page).getByRole('button', { name: '开始时间', exact: true }).click();
  const dates = page.getByRole('dialog', { name: '设置开始时间', exact: true });
  await expect(dates.getByRole('grid', { name: '日期月历' })).toBeVisible();
  await dates.getByRole('button', { name: '明天', exact: true }).click();
  await dates.getByRole('button', { name: '取消', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: '开始时间', exact: true })).toHaveText(
    '设置日期',
  );
  await panel(page).getByRole('button', { name: '开始时间', exact: true }).click();
  await dates.getByLabel('开始时间日期', { exact: true }).fill('2026-11-12');
  await dates.getByLabel('开始时间时刻', { exact: true }).fill('09:30');
  await dates.getByRole('button', { name: '2026年11月12日', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(dates.getByLabel('开始时间日期', { exact: true })).toHaveValue('2026-11-13');
  await expect(dates.getByLabel('开始时间时刻', { exact: true })).toHaveValue('09:30');
  await page.screenshot({ path: testInfo.outputPath('desktop-date-picker.png') });
  await dates.getByRole('button', { name: '应用时间', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: '开始时间', exact: true })).toContainText(
    '11/13 · 09:30',
  );
  const priority = panel(page).getByRole('combobox', { name: '优先级', exact: true });
  await selectValue(priority, 'P1');
  await expectSelectValue(priority, 'P1');
  await priority.click();
  await expect(page.locator('[role="option"][data-value="P1"]')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.locator('[role="option"][data-value="P0"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expectSelectValue(priority, 'P0');
  await priority.click();
  await page.screenshot({ path: testInfo.outputPath('desktop-priority-menu.png') });
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeVisible();
  await expect(priority).toBeFocused();
  await page.reload();
  await openTask(page);
  await expectSelectValue(panel(page).getByRole('combobox', { name: '优先级', exact: true }), 'P0');
  await expect(panel(page).getByRole('button', { name: '开始时间', exact: true })).toContainText(
    '11/13 · 09:30',
  );
  await panel(page).getByRole('button', { name: '清除开始时间', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: '开始时间', exact: true })).toHaveText(
    '设置日期',
  );
});

test('mobile date editor chains to the due date and Escape preserves the task and unsaved due date', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, { dueAt: null });
  await openTask(page);
  await panel(page).getByRole('button', { name: '开始时间', exact: true }).click();
  const start = page.getByRole('dialog', { name: '设置开始时间', exact: true });
  await start.getByRole('button', { name: '明天', exact: true }).click();
  await expect(start.getByRole('button', { name: '2026年11月11日', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(start.getByRole('button', { name: '应用时间', exact: true })).toBeInViewport();
  const bounds = await start.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('mobile-date-picker.png') });
  await start.getByRole('button', { name: '应用时间', exact: true }).click();
  const due = page.getByRole('dialog', { name: '设置截止时间', exact: true });
  await expect(due).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(due).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole('button', { name: '截止时间', exact: true })).toHaveText(
    '设置日期',
  );
  await expect(panel(page).getByRole('button', { name: '开始时间', exact: true })).toContainText(
    '11/11',
  );
  await selectValue(panel(page).getByRole('combobox', { name: '优先级', exact: true }), 'P2');
  await expect(panel(page)).toBeVisible();
  await page.reload();
  await openTask(page);
  await expect(page.locator('[data-date-editor]')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: '开始时间', exact: true })).toContainText(
    '11/11',
  );
});

test('project periods use calendar popovers and nested filter selections keep their containing panel open', async ({
  page,
}) => {
  await seed(page);
  await page.goto('/tasks?project=project&view=gantt&scope=week');
  await selectValue(period(page), 'custom');
  await page.getByRole('button', { name: '选择区间开始日期', exact: true }).click();
  await page
    .getByRole('dialog', { name: '选择区间开始日期', exact: true })
    .getByRole('button', { name: '2026年11月10日', exact: true })
    .click();
  await expect(page.getByLabel('区间开始日期', { exact: true })).toHaveValue('2026-11-10');
  await page.getByRole('button', { name: '选择区间结束日期', exact: true }).click();
  const calendar = page.getByRole('dialog', { name: '选择区间结束日期', exact: true });
  await expect(calendar.getByRole('button', { name: '2026年11月9日', exact: true })).toBeDisabled();
  await calendar.getByRole('button', { name: '2026年11月12日', exact: true }).click();
  await expect(page.getByLabel('区间结束日期', { exact: true })).toHaveValue('2026-11-12');
  await page.getByRole('button', { name: '更多任务筛选', exact: true }).click();
  const filters = page.getByRole('dialog', { name: '更多任务筛选', exact: true });
  await filters.getByRole('combobox', { name: '筛选任务状态', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(filters).toBeVisible();
  await selectValue(filters.getByRole('combobox', { name: '筛选任务状态', exact: true }), 'doing');
  await expect(filters).toBeVisible();
  await expect(page).toHaveURL(/taskStatus=doing/);
  await page.keyboard.press('Escape');
  await expect(filters).toHaveCount(0);
});

test('mobile custom range previews a calendar interval and commits only when applied', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  await page.goto('/tasks?project=project&view=list&scope=week');
  const before = page.url();
  await selectValue(period(page), 'custom');
  const range = page.getByRole('dialog', { name: '选择日期区间', exact: true });
  await range.getByRole('button', { name: '2026年11月10日', exact: true }).click();
  await range.getByRole('button', { name: '2026年11月13日', exact: true }).click();
  await expect(range.getByText('共 4 天', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(before);
  await page.screenshot({ path: testInfo.outputPath('mobile-range-picker.png') });
  await range.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page).toHaveURL(before);
  await expect(period(page)).toBeFocused();
  await selectValue(period(page), 'custom');
  await range.getByRole('button', { name: '2026年11月10日', exact: true }).click();
  await range.getByRole('button', { name: '2026年11月13日', exact: true }).click();
  await range.getByRole('button', { name: '应用日期', exact: true }).click();
  await expect(page).toHaveURL(/from=2026-11-10&to=2026-11-13/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
