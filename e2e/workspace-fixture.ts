import { expect, type Page, type BrowserContext, type Locator } from '@playwright/test';


export const config = { runtime: 'ssh', serverId: 'agent-host', kubeConnectionId: '', image: '', repository: '', ref: '', directory: '/work', session: '', agentCommand: 'fixture-agent --acp', context: '', namespace: 'default', secretRef: '', imagePullSecret: '' };
export const tasks = [
  { id: 'agent-project', title: 'Agent 项目', kind: 'node', project: true, parentId: null },
  { id: 'agent-task', title: '实现任务集成', kind: 'todo', project: false, parentId: 'agent-project', notes: '保留用户说明' },
].map((task) => ({ status: 'todo', order: 0, ownerId: 'fixture', important: false, urgent: false, tags: [], createdAt: 1, updatedAt: 1, ...task }));
export const workspace = (page: Page) => page.getByRole('region', { name: '执行 Workspace', exact: true });
export async function choose(page: Page, scope: Page | Locator, label: string, option: string) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
export async function account(context: BrowserContext) {
  const invite = await context.request.post('/api/invites', { headers: { Cookie: process.env.E2E_ADMIN_COOKIE! }, data: {} }).then((response) => response.json());
  expect((await context.request.post('/api/auth/register', { data: { username: `agent_ui_${Date.now()}`, password: 'fixture-password', inviteCode: invite.code } })).ok()).toBe(true);
}
export function environment() { return { id: 'env-1', taskId: 'agent-task', config: { ...config, agentCommand: '' }, connectionHost: 'fixture@host.invalid', state: 'ready', managed: true, resourceId: '', session: 'nexus-fixture', directory: '/work', createdAt: 1, updatedAt: 1 }; }
export async function environmentRoutes(page: Page, values: any[]) {
  await page.route('**/api/workspace-environments', (route) => route.fulfill({ json: { data: values } }));
  await page.route('**/api/workspace-profiles', (route) => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/workspaces/**', (route) => route.fulfill({ json: { data: { environments: values, instructions: [] } } }));
  await page.route('**/api/workspace-environments/**', (route) => route.fulfill({ json: { data: new URL(route.request().url()).pathname.endsWith('/cleanup-plan') ? {taskIds:values[0]?[values[0].taskId]:[],agents:[],git:{dirty:false,unpushed:false}} : new URL(route.request().url()).pathname.endsWith('/panes') ? [] : values[0] } }));
  await page.route('**/api/tasks/*/agent-prompt', (route) => route.fulfill({ json: { data: { prompt: '处理「实现任务集成」。通过 {{task_context_url}} 获取消息，完成后写回 Task 描述。任务 /tasks?focusTask=agent-task', contextUrlTemplate: '/api/agent-context/{agentId}?taskId=agent-task', taskUrl: '/tasks?focusTask=agent-task' } } }));
}
