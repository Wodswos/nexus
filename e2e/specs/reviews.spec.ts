import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const date = '2026-10-25';
const fixedNow = new Date(`${date}T22:00:00+08:00`);
const facts = { capturedAt: fixedNow.getTime(), completed: [], pending: [], focusMin: 0, projects: [] };
const prior = (kind: 'daily' | 'weekly', start: string, end: string) => ({
  id: `${kind}_${start}`, kind, periodStart: start, periodEnd: end, highlights: 'Earlier reflection', friction: '', nextSteps: '', facts,
  completedAt: fixedNow.getTime(), createdAt: 1, updatedAt: 1, ownerId: 'fixture',
});
async function seed(page: Page, data: unknown) {
  await page.goto('/settings');
  await page.locator('input[type=file]').setInputFiles({ name: 'reviews.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  (page as any).__reviewErrors = errors;
});
test.afterEach(async ({ page }) => { expect((page as any).__reviewErrors).toEqual([]); });

test('daily reviews preserve IME drafts across immediate navigation, finalize facts and export Markdown', async ({ page, browserName }) => {
  await page.clock.install({ time: fixedNow });
  const doneAt = new Date(`${date}T18:00:00+08:00`).getTime();
  await seed(page, { tasks: [{ id: 'report_done', title: 'Ship prototype', status: 'done', parentId: null, order: 0, tags: [], ownerId: 'fixture', createdAt: 1, updatedAt: 1, completedAt: doneAt }],
    sessions: [{ id: 'report_focus', taskId: 'report_done', startedAt: doneAt - 1800000, endedAt: doneAt, plannedMin: 30, actualMin: 25, mode: 'focus', completed: true, ownerId: 'fixture' }] });
  await page.goto(`/reviews?kind=daily&date=${date}`);
  const highlight = page.getByRole('textbox', { name: '今天真正推进了什么？', exact: true });
  await expect(page.getByTestId('review-completed-count')).toHaveText('1项');
  await expect(page.getByTestId('review-focus-duration')).toHaveText('25m');
  if (browserName === 'chromium') {
    await highlight.focus();
    const cdp = await page.context().newCDPSession(page);
    for (const text of ['w', 'wan', 'wancheng']) {
      await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
      await expect(highlight).toBeFocused(); await expect(highlight).toHaveValue(text);
    }
    await cdp.send('Input.insertText', { text: '完成原型，确认关键交互' }); await cdp.detach();
  } else await highlight.fill('完成原型，确认关键交互');
  await page.getByRole('textbox', { name: '今天需要推进什么？', exact: true }).fill('先收敛原型范围，再约评审');
  await page.getByRole('textbox', { name: '哪里卡住了，为什么？', exact: true }).fill('反馈太晚，明天先沟通');
  await page.getByRole('textbox', { name: '如何解决？', exact: true }).fill('先对齐需求，再约固定评审时间');
  await page.getByRole('textbox', { name: '明天最重要的一步是什么？', exact: true }).fill('约一次原型评审');
  await page.getByRole('navigation', { name: '工作导航' }).getByRole('link', { name: '当前工作', exact: true }).click();
  await page.getByRole('navigation', { name: '工具' }).getByRole('link', { name: '复盘', exact: true }).click();
  await expect(highlight).toHaveValue('完成原型，确认关键交互');
  await expect(page.getByRole('textbox', { name: '明天最重要的一步是什么？', exact: true })).toHaveValue('约一次原型评审');
  await expect(page.getByRole('textbox', { name: '如何解决？', exact: true })).toHaveValue('先对齐需求，再约固定评审时间');
  await page.reload(); await expect(highlight).toHaveValue('完成原型，确认关键交互');
  await expect(page.getByRole('textbox', { name: '今天需要推进什么？', exact: true })).toHaveValue('先收敛原型范围，再约评审');
  await expect(page.getByRole('textbox', { name: '如何解决？', exact: true })).toHaveValue('先对齐需求，再约固定评审时间');
  await page.getByRole('button', { name: '完成复盘', exact: true }).click();
  await expect(page.getByRole('button', { name: '继续编辑', exact: true })).toBeVisible();
  await expect(highlight).toHaveAttribute('readonly', '');
  await expect(page.getByRole('textbox', { name: '如何解决？', exact: true })).toHaveAttribute('readonly', '');
  await page.getByRole('list', { name: '实际推进的任务', exact: true }).getByRole('button', { name: /Ship prototype/ }).click();
  await page.getByRole('textbox', { name: '任务标题', exact: true }).fill('Renamed after review');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('list', { name: '实际推进的任务', exact: true }).getByRole('button', { name: /Ship prototype/ })).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出复盘 Markdown', exact: true }).click();
  const file = await (await downloading).path();
  const markdown = await readFile(file!, 'utf8');
  expect(markdown).toContain('完成原型，确认关键交互'); expect(markdown).toContain('Ship prototype'); expect(markdown).toContain('25 分钟');
  expect(markdown).toContain('## 今天需要推进什么？'); expect(markdown).toContain('先收敛原型范围，再约评审');
  expect(markdown).toContain('### 如何解决？\n先对齐需求，再约固定评审时间');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(highlight).not.toHaveAttribute('readonly', '');
  await expect(page.getByRole('list', { name: '实际推进的任务', exact: true }).getByRole('button', { name: /Renamed after review/ })).toBeVisible();
});

test('daily task lists fill automatically and completing carried work moves it into actual progress immediately', async ({ page }) => {
  await page.clock.install({ time: fixedNow });
  await page.clock.setFixedTime(fixedNow);
  const due = (day: string, time = '20:00') => new Date(`${day}T${time}:00+08:00`).getTime();
  const task = (id: string, title: string, patch: object = {}) => ({
    id, title, status: 'todo', parentId: null, order: 0, tags: [], ownerId: 'fixture', createdAt: 1, updatedAt: 1, ...patch,
  });
  await seed(page, { tasks: [
    task('review_old', '昨天遗留的任务', { dueAt: due('2026-10-24') }),
    task('review_today', '今天晚些时候要推进', { dueAt: due(date, '23:30'), priority: 'P1' }),
    task('review_start', '今天开始的任务', { startAt: due(date, '09:00') }),
    task('review_done', '今天已交付', { status: 'done', dueAt: due(date), completedAt: due(date, '18:00') }),
    task('review_tomorrow', '明天再推进', { dueAt: due('2026-10-26') }),
    task('review_undated', '未排期的任务'),
    task('review_text', '文本节点', { kind: 'node', dueAt: due(date) }),
  ] });
  await page.goto(`/reviews?kind=daily&date=${date}`);
  const actual = page.getByRole('list', { name: '实际推进的任务', exact: true });
  const planned = page.getByRole('list', { name: '计划推进的任务', exact: true });
  const pending = page.getByRole('list', { name: '待检查的未完成任务', exact: true });
  await expect(actual.getByRole('listitem')).toHaveCount(1);
  await expect(planned.getByRole('listitem')).toHaveCount(3);
  await expect(planned.getByRole('listitem').first()).toContainText('今天晚些时候要推进');
  await expect(pending.getByRole('listitem')).toHaveCount(3);
  await expect(pending).not.toContainText('明天再推进');
  await expect(pending).not.toContainText('未排期的任务');
  await expect(pending).not.toContainText('文本节点');
  await expect(page.getByRole('navigation', { name: '历史复盘' }).getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '完成复盘', exact: true })).toBeEnabled();
  const actualTop = await page.getByRole('region', { name: '今天真正推进了什么？', exact: true }).boundingBox();
  const plannedTop = await page.getByRole('region', { name: '今天需要推进什么？', exact: true }).boundingBox();
  expect(actualTop!.y).toBeLessThan(plannedTop!.y);
  await page.screenshot({ path: '../.preview.local/review-task-lists-desktop.png' });
  await pending.getByRole('checkbox', { name: '完成 昨天遗留的任务', exact: true }).click();
  await expect(actual.getByRole('listitem')).toHaveCount(2);
  await expect(actual.getByRole('button', { name: /昨天遗留的任务/ })).toBeVisible();
  await expect(pending.getByRole('listitem')).toHaveCount(2);
  await expect(pending).not.toContainText('昨天遗留的任务');
  await page.getByRole('button', { name: '撤销 (⌘Z)', exact: true }).click();
  await expect(actual.getByRole('listitem')).toHaveCount(1);
  await expect(pending.getByRole('checkbox', { name: '完成 昨天遗留的任务', exact: true })).toBeVisible();
  await planned.getByRole('checkbox', { name: '完成 今天晚些时候要推进', exact: true }).click();
  await expect(actual.getByRole('listitem')).toHaveCount(2);
  await expect(planned.getByRole('checkbox', { name: '标记未完成 今天晚些时候要推进', exact: true })).toBeChecked();
  await expect(pending).not.toContainText('今天晚些时候要推进');
  await page.getByRole('button', { name: '完成复盘', exact: true }).click();
  await expect(page.getByRole('button', { name: '继续编辑', exact: true })).toBeVisible();
  await expect(actual.getByRole('checkbox').first()).toBeDisabled();
  await planned.getByRole('button', { name: /今天晚些时候要推进/ }).click();
  await page.getByRole('textbox', { name: '任务标题', exact: true }).fill('完成复盘之后的新标题');
  await page.keyboard.press('Escape');
  await expect(planned).toContainText('今天晚些时候要推进');
  await expect(actual).not.toContainText('完成复盘之后的新标题');
  await page.reload();
  await expect(planned).toContainText('今天晚些时候要推进');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出复盘 Markdown', exact: true }).click();
  const markdown = await readFile((await (await downloading).path())!, 'utf8');
  expect(markdown).toContain('- [x] 今天晚些时候要推进');
  expect(markdown).toContain('- [ ] 昨天遗留的任务');
  expect(markdown).not.toContain('完成复盘之后的新标题');
  await page.getByRole('tab', { name: '时间线', exact: true }).click();
  await expect(page.getByRole('region', { name: '复盘时间线', exact: true })).toContainText('今天晚些时候要推进');
  await expect(page.getByText('尚未填写内容，点击日期继续编辑。', { exact: true })).toHaveCount(0);
});

test('an ongoing weekly review separates upcoming plans from unfinished work through today on mobile', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-18T10:00:00+08:00') });
  const task = (id: string, dueAt: string) => ({ id, title: id, dueAt: Date.parse(dueAt), status: 'todo', parentId: null, order: 0, tags: [], ownerId: 'fixture', createdAt: 1, updatedAt: 1 });
  await seed(page, { tasks: [
    task('上周遗留', '2026-11-15T20:00:00+08:00'),
    task('今天推进', '2026-11-18T23:30:00+08:00'),
    task('周五计划', '2026-11-20T18:00:00+08:00'),
    task('下周计划', '2026-11-23T18:00:00+08:00'),
  ].map((task, index) => ({ ...task, id: `weekly_review_${index}` })) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/reviews?kind=weekly&date=2026-11-16');
  const planned = page.getByRole('list', { name: '计划推进的任务', exact: true });
  const pending = page.getByRole('list', { name: '待检查的未完成任务', exact: true });
  await expect(planned.getByRole('listitem')).toHaveCount(2);
  await expect(planned).toContainText('周五计划');
  await expect(planned).not.toContainText('下周计划');
  await expect(pending.getByRole('listitem')).toHaveCount(2);
  await expect(pending).toContainText('上周遗留');
  await expect(pending).not.toContainText('周五计划');
  await pending.getByRole('checkbox', { name: '完成 上周遗留', exact: true }).click();
  await expect(page.getByRole('list', { name: '实际推进的任务', exact: true })).toContainText('上周遗留');
  await expect(pending).not.toContainText('上周遗留');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByTestId('review-page').evaluate(element => element.scrollTo(0, 0));
  await page.screenshot({ path: '../.preview.local/review-task-lists-mobile.png', fullPage: true });
});

test('timeline browses all reports across months, filters and searches solutions, and returns from details on mobile', async ({ page }) => {
  await page.clock.install({ time: fixedNow });
  const entries = [
    { ...prior('daily', date, '2026-10-26'), highlights: 'Latest progress', resolution: 'Prealign feedback before implementation' },
    { ...prior('daily', '2026-10-23', '2026-10-24'), highlights: '', completedAt: null, facts: null, resolution: 'A solution-only draft' },
    { ...prior('weekly', '2026-10-19', '2026-10-26'), highlights: 'Weekly progress', resolution: 'Prealign feedback every Monday' },
    ...Array.from({ length: 7 }, (_, index) => prior('daily', `2026-10-${10 + index}`, `2026-10-${11 + index}`)),
    { ...prior('daily', '2026-09-30', '2026-10-01'), highlights: 'September reflection' },
    { ...prior('weekly', '2025-12-29', '2026-01-05'), highlights: 'Last year reflection' },
  ];
  await seed(page, { reviews: entries });
  await page.goto('/reviews');
  await page.getByRole('tab', { name: '时间线', exact: true }).click();
  await expect(page.getByRole('tablist', { name: '复盘类型', exact: true }).getByRole('tab', { name: '时间线', exact: true })).toHaveAttribute('data-state', 'active');
  const timeline = page.getByRole('region', { name: '复盘时间线', exact: true });
  const cards = timeline.getByRole('article');
  await expect(cards).toHaveCount(entries.length);
  await expect(cards.first()).toHaveAccessibleName('日报 2026-10-25');
  await expect(cards.nth(1)).toHaveAccessibleName('日报 2026-10-23');
  await expect(cards.nth(1).getByText('草稿', { exact: true })).toBeVisible();
  await expect(cards.nth(1).getByText('A solution-only draft', { exact: true })).toBeVisible();
  await expect(cards.last()).toHaveAccessibleName('周报 2025-12-29');
  await expect(timeline.getByRole('heading', { name: /2026 年 9 月/ })).toBeVisible();
  await expect(timeline.getByRole('link', { name: '查看周报 2025-12-29', exact: true })).toContainText('2025-12-29 ～ 2026-01-04');
  const filters = timeline.getByRole('tablist', { name: '时间线类型', exact: true });
  await filters.getByRole('tab', { name: '日报', exact: true }).click();
  await expect(cards).toHaveCount(10);
  await filters.getByRole('tab', { name: '周报', exact: true }).click();
  await expect(cards).toHaveCount(2);
  await timeline.getByRole('searchbox', { name: '搜索时间线', exact: true }).fill('  prealign  ');
  await expect(cards).toHaveCount(1);
  await page.reload();
  await expect(cards).toHaveCount(1);
  await expect(filters.getByRole('tab', { name: '周报', exact: true })).toHaveAttribute('data-state', 'active');
  await timeline.getByRole('link', { name: '查看周报 2026-10-19', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '如何解决？', exact: true })).toHaveValue('Prealign feedback every Monday');
  await page.getByRole('link', { name: '返回时间线', exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(timeline.getByRole('searchbox', { name: '搜索时间线', exact: true })).toHaveValue('  prealign  ');
  await timeline.getByRole('searchbox', { name: '搜索时间线', exact: true }).fill('no matching content');
  await expect(cards).toHaveCount(0);
  await expect(timeline.getByText('没有匹配的复盘', { exact: true })).toBeVisible();
  await timeline.getByRole('button', { name: '查看全部复盘', exact: true }).click();
  await expect(cards).toHaveCount(entries.length);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await timeline.getByRole('link', { name: '查看周报 2025-12-29', exact: true }).click();
  await expect(page.getByRole('heading', { name: '2025-12-29 ～ 2026-01-04', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '如何解决？', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '继续编辑', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '返回时间线', exact: true }).click();
  await expect(cards).toHaveCount(entries.length);
  await expect(page.getByRole('tablist', { name: '复盘类型', exact: true }).getByRole('tab', { name: '时间线', exact: true })).toHaveAttribute('data-state', 'active');
  await page.screenshot({ path: '../.preview.local/review-timeline-mobile.png' });
});

test('opening periods creates no empty history; weekly review includes daily entries and remains usable on mobile', async ({ page }) => {
  await page.clock.install({ time: fixedNow });
  await page.goto('/reviews');
  await expect(page.getByRole('navigation', { name: '历史复盘' }).getByRole('link')).toHaveCount(0);
  await page.getByRole('tab', { name: '时间线', exact: true }).click();
  await expect(page.getByRole('region', { name: '复盘时间线', exact: true }).getByRole('article')).toHaveCount(0);
  await expect(page.getByText('时间线从第一篇复盘开始', { exact: true })).toBeVisible();
  await page.getByRole('tablist', { name: '复盘类型', exact: true }).getByRole('tab', { name: '日报', exact: true }).click();
  await page.getByRole('button', { name: '上一期复盘', exact: true }).click();
  await expect(page.getByLabel('复盘日期', { exact: true })).toHaveValue('2026-10-24');
  await page.getByRole('button', { name: '下一期复盘', exact: true }).click();
  await expect(page.getByLabel('复盘日期', { exact: true })).toHaveValue(date);
  await expect(page.getByRole('navigation', { name: '历史复盘' }).getByRole('link')).toHaveCount(0);
  await page.getByRole('textbox', { name: '今天真正推进了什么？', exact: true }).fill('Important daily insight');
  await page.getByRole('button', { name: '完成复盘', exact: true }).click();
  await page.getByRole('tab', { name: '周报', exact: true }).click();
  await expect(page.getByRole('heading', { name: '2026-10-19 ～ 2026-10-25', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '本周日报' }).getByText('Important daily insight', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '本周真正推进了什么？', exact: true }).fill('Focus on the right project');
  await page.getByRole('button', { name: '完成复盘', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '历史复盘' }).getByRole('link')).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '继续编辑', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '继续编辑', exact: true })).toBeInViewport();
  await page.getByText('复盘提醒', { exact: true }).click();
  await expect(page.getByLabel('日报提醒时间', { exact: true })).toHaveValue('21:30');
  await expect(page.getByLabel('周报提醒时间', { exact: true })).toHaveValue('20:00');
  await expect(page.getByRole('combobox', { name: '周报提醒星期', exact: true })).toHaveValue('0');
});

test('due reminders appear at Sunday 20:00 and daily 21:30, snooze and stop after completion', async ({ page }) => {
  await page.clock.install({ time: new Date(`${date}T19:59:00+08:00`) });
  await seed(page, { reviews: [prior('weekly', '2026-10-12', '2026-10-19'), prior('daily', '2026-10-24', '2026-10-25')] });
  await page.goto('/tasks');
  const reminder = page.getByRole('complementary', { name: '复盘提醒', exact: true });
  await expect(reminder).toHaveCount(0);
  await page.clock.fastForward(60000);
  await expect(reminder.getByRole('link', { name: '开始复盘', exact: true })).toHaveAttribute('title', '2026-10-19 · 周报待复盘');
  await reminder.getByRole('button', { name: '一小时后再提醒复盘', exact: true }).click();
  await expect(reminder).toHaveCount(0);
  await page.clock.fastForward(3600000);
  await expect(reminder).toBeVisible();
  await reminder.getByRole('link', { name: '开始复盘', exact: true }).click();
  await page.getByRole('textbox', { name: '本周真正推进了什么？', exact: true }).fill('A quieter week, with a clearer direction');
  await page.getByRole('button', { name: '完成复盘', exact: true }).click();
  await page.getByRole('navigation', { name: '工作导航' }).getByRole('link', { name: '当前工作', exact: true }).click();
  await expect(reminder).toHaveCount(0);
  await page.clock.fastForward(1800000);
  await expect(reminder.getByRole('link', { name: '开始复盘', exact: true })).toHaveAttribute('title', '2026-10-25 · 日报待复盘');
});

async function register(context: BrowserContext, label: string) {
  const invite = await context.request.post('/api/invites', { headers: { Cookie: process.env.E2E_ADMIN_COOKIE! }, data: {} });
  expect(invite.ok()).toBe(true);
  const { code } = await invite.json();
  const username = `review_${label}_${Date.now()}`;
  const response = await context.request.post('/api/auth/register', { data: { username, password: 'fixture-password', inviteCode: code } });
  expect(response.ok()).toBe(true); return username;
}

test('reviews sync between devices and are isolated between accounts', async ({ page, context, browser, baseURL }) => {
  const username = await register(context, 'owner');
  await page.goto(`/reviews?kind=daily&date=${date}`);
  await page.getByRole('textbox', { name: '今天真正推进了什么？', exact: true }).fill('Private account reflection');
  await page.getByRole('textbox', { name: '今天需要推进什么？', exact: true }).fill('Private account plan');
  await page.getByRole('textbox', { name: '如何解决？', exact: true }).fill('Private solution synced between devices');
  await page.getByRole('heading', { name: '复盘', exact: true }).click();
  await expect(page.getByRole('status', { name: '复盘保存状态' })).toHaveText('已保存');
  const otherDevice = await browser.newContext({ baseURL });
  const otherAccount = await browser.newContext({ baseURL });
  try {
    const login = await otherDevice.request.post('/api/auth/login', { data: { username, password: 'fixture-password' } });
    expect(login.ok()).toBe(true);
    const devicePage = await otherDevice.newPage();
    await devicePage.goto(`/reviews?kind=daily&date=${date}`);
    await expect(devicePage.getByRole('textbox', { name: '今天真正推进了什么？', exact: true })).toHaveValue('Private account reflection');
    await expect(devicePage.getByRole('textbox', { name: '今天需要推进什么？', exact: true })).toHaveValue('Private account plan');
    await expect(devicePage.getByRole('textbox', { name: '如何解决？', exact: true })).toHaveValue('Private solution synced between devices');
    await register(otherAccount, 'other');
    const isolatedPage = await otherAccount.newPage();
    await isolatedPage.goto(`/reviews?kind=daily&date=${date}`);
    await expect(isolatedPage.getByRole('textbox', { name: '今天真正推进了什么？', exact: true })).toHaveValue('');
    await expect(isolatedPage.getByRole('textbox', { name: '今天需要推进什么？', exact: true })).toHaveValue('');
    await expect(isolatedPage.getByRole('textbox', { name: '如何解决？', exact: true })).toHaveValue('');
    await expect(isolatedPage.getByRole('navigation', { name: '历史复盘' }).getByRole('link')).toHaveCount(0);
  } finally { await otherDevice.close(); await otherAccount.close(); }
});
