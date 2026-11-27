import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
test('linked titles work across all views without opening task details, dragging or changing status', async ({ page, context }) => {
  await context.route('https://links.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<p>链接目标</p>' }));
  await page.clock.setFixedTime(new Date('2026-11-24T12:00:00+08:00'));
  const task = { id: 'link-task', title: '阅读 [设计文档](https://links.example.test/design)', parentId: 'link-project', status: 'todo', kind: 'todo', order: 0, ownerId: 'fixture', important: false, urgent: false, tags: [], createdAt: 1, updatedAt: 1, startAt: new Date('2026-11-24T09:00:00+08:00').getTime(), dueAt: new Date('2026-11-24T18:00:00+08:00').getTime() };
  await page.goto('/settings');
  await page.locator('input[type=file]').setInputFiles({ name: 'links.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ tasks: [{ ...task, id: 'link-project', title: '链接项目', kind: 'node', project: true, parentId: null, startAt: null, dueAt: null }, task] })) });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
  for (const view of ['mindmap', 'list', 'matrix', 'gantt', 'timeline']) {
    await page.goto(`/tasks?project=link-project&view=${view}&scope=all`);
    const link = page.getByRole('link', { name: '设计文档', exact: true }).first();
    await expect(link).toBeVisible();
    expect(await link.evaluate(element => !!element.closest('button'))).toBe(false);
    const popup = page.waitForEvent('popup'); await link.click(); const opened = await popup;
    await expect(opened).toHaveURL('https://links.example.test/design'); await opened.close();
    await expect(page.getByRole('region', { name: '任务详情', exact: true })).toHaveCount(0);
  }
  await page.goto('/tasks?project=link-project&view=mindmap&scope=all');
  const node = page.locator('.react-flow__node[data-id="link-task"]');
  await node.getByRole('button', { name: /^查看任务详情/ }).click();
  const title = page.getByRole('textbox', { name: '任务标题', exact: true });
  await expect(title).toHaveValue(task.title);
  await title.fill('');
  await title.evaluate(element => {
    const data = new DataTransfer(); data.setData('text/plain', '复制的中文链接');
    data.setData('text/html', '<a href="https://links.example.test/copied">复制的中文链接</a><script>window.unsafePaste=true</script>');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect(title).toHaveValue('[复制的中文链接](<https://links.example.test/copied>)');
  expect(await page.evaluate(() => (window as any).unsafePaste)).toBeUndefined();
  await expect(page.getByLabel('标题链接预览').getByRole('link')).toHaveAttribute('href', 'https://links.example.test/copied');
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(page.getByRole('region', { name: '任务详情', exact: true })).toHaveCount(0);
  await expect(node.getByRole('link', { name: '复制的中文链接', exact: true })).toBeVisible();
  await page.reload();
  await expect(node.getByRole('link', { name: '复制的中文链接', exact: true })).toBeVisible();
  await node.getByRole('button', { name: /^查看任务详情/ }).click();
  await title.fill('https://links.example.test/plain');
  await expect(page.getByLabel('标题链接预览').getByRole('link')).toHaveAttribute('href', 'https://links.example.test/plain');
  await title.fill('[坏链接](javascript:alert(1))');
  await expect(page.getByLabel('标题链接预览')).toHaveCount(0);
});
