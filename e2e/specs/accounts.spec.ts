import { test, expect, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
const password = 'accounts-fixture-password';
async function seed(page: Page, title: string) {
  await page.goto('/settings');
  await page.locator('input[type=file]').setInputFiles({ name: 'accounts.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ tasks: [{ id: title.includes(' A ') ? 'account-a-task' : 'account-b-task', title, ownerId: 'fixture', parentId: null, status: 'todo', dueAt: Date.now(), order: 0, tags: [], important: false, urgent: false, createdAt: 1, updatedAt: 1 }] })) });
  await expect(page.getByText(/已合并备份/)).toBeVisible();
  await page.goto('/tasks?view=list&scope=all');
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await expect(page.getByText('已同步', { exact: true })).toBeVisible();
}
async function login(page: Page, username: string, value = password) {
  await page.getByPlaceholder('用户名', { exact: true }).fill(username);
  await page.getByPlaceholder('密码', { exact: true }).fill(value);
  await page.getByRole('button', { name: '登录', exact: true }).last().click();
}

test('switches saved users without passwords, isolates data, restores failed login and follows across tabs', async ({ page, context, browser, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const users: { id: string; username: string }[] = [];
  for (const suffix of ['a','b']) {
    const invite = await context.request.post('/api/invites', { headers: { Cookie: process.env.E2E_ADMIN_COOKIE! }, data: {} });
    expect(invite.ok()).toBe(true);
    const registration = await browser.newContext({ baseURL });
    try {
      const response = await registration.request.post('/api/auth/register', {data:{username:`switch_${suffix}_${Date.now()}`,password,inviteCode:(await invite.json()).code}});
      expect(response.ok()).toBe(true); users.push(await response.json());
    } finally { await registration.close(); }
  }
  const [a,b] = users as [{id:string;username:string},{id:string;username:string}];
  await page.goto('/login'); await login(page,a.username);
  await expect(page).not.toHaveURL(/\/login/);
  await seed(page,'账号 A 的私有任务');
  const second = await context.newPage();
  await second.goto('/tasks?view=list&scope=all');
  await expect(second.getByText('账号 A 的私有任务',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'设置与账号',exact:true}).click();
  await page.getByRole('link',{name:'添加账号',exact:true}).click();
  await login(page,b.username,'wrong-password');
  await expect(page.getByText('用户名或密码错误',{exact:true})).toBeVisible();
  expect((await context.request.get('/api/auth/me')).ok()).toBe(true);
  await page.goto('/tasks?view=list&scope=all');
  await expect(page.getByText('已同步',{exact:true})).toBeVisible();
  await expect(page.getByText('账号 A 的私有任务',{exact:true})).toBeVisible();
  await page.goto('/login?add=1'); await login(page,b.username);
  await expect(page).not.toHaveURL(/\/login/);
  await expect(second.getByRole('link',{name:'设置与账号'})).toContainText(b.username);
  await expect(second.getByText('账号 A 的私有任务',{exact:true})).toBeHidden();
  await seed(page,'账号 B 的私有任务');
  await expect(page.getByText('账号 A 的私有任务',{exact:true})).toBeHidden();
  await page.getByRole('link',{name:'设置与账号',exact:true}).click();
  await page.getByRole('button',{name:`切换到 ${a.username}`,exact:true}).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('button',{name:`当前账号 ${a.username}`,exact:true})).toBeVisible();
  await expect(second.getByRole('link',{name:'设置与账号'})).toContainText(a.username);
  await expect(second.getByText('账号 A 的私有任务',{exact:true})).toBeVisible();
  await expect(second.getByText('账号 B 的私有任务',{exact:true})).toBeHidden();
  await page.goto('/tasks?view=list&scope=all');
  await expect(page.getByText('账号 A 的私有任务',{exact:true})).toBeVisible();
  await expect(page.getByText('账号 B 的私有任务',{exact:true})).toBeHidden();
  await page.reload();
  await expect(page.getByRole('link',{name:'设置与账号'})).toContainText(a.username);
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storage).not.toContain(password);
  for(const cookie of await context.cookies()) if(['cortex_session','nexus_accounts'].includes(cookie.name)) {
    expect(cookie.httpOnly).toBe(true); expect(storage).not.toContain(cookie.value);
  }
  expect(await page.evaluate(()=>document.cookie)).not.toMatch(/cortex_session|nexus_accounts/);
  await page.goto('/accounts');
  await expect(page).toHaveURL(/\/settings#accounts$/);
  await expect(page.getByTestId('saved-account')).toHaveCount(2);
  await page.screenshot({ path: '../.preview.local/settings-accounts-20261126/accounts-desktop.png', fullPage: true });
  await page.getByRole('button',{name:`退出账号 ${b.username}`,exact:true}).click();
  await expect(page.getByRole('button',{name:`切换到 ${b.username}`,exact:true})).toBeHidden();
  expect((await context.request.post('/api/auth/switch',{data:{userId:b.id}})).status()).toBe(401);
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('#workspace-sidebar')).toBeHidden();
  await expect(page.getByRole('region',{name:'账号切换',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({ path: '../.preview.local/settings-accounts-20261126/accounts-mobile.png', fullPage:true });
  await page.getByRole('button',{name:'退出本浏览器所有账号',exact:true}).click();
  await expect(page.getByText('暂无已登录账号',{exact:true})).toBeVisible();
  await expect(second.getByRole('link',{name:'设置与账号'})).not.toContainText(a.username);
  expect((await context.request.get('/api/auth/me')).status()).toBe(401);
  expect(errors).toEqual([]);
  await second.close();
});
