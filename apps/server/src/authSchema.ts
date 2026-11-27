const user = { type: 'object', required: ['id', 'username', 'isAdmin'], properties: { id: { type: 'string' }, username: { type: 'string' }, isAdmin: { type: 'boolean' } } };
const ok = { type: 'object', properties: { ok: { type: 'boolean' } } };
const operation = (summary: string, schema: object, security: object[], body?: object) => ({
  tags: ['账号'], summary, security,
  description: '同源浏览器接口；不接受 Agent Bearer Token。Cookie 由浏览器管理，遵循 Origin 校验。切换后同一浏览器标签页共享当前账号。',
  parameters: [{ in: 'header', name: 'X-Cortex-User', schema: { type: 'string' }, description: '原当前账号 ID；过期页面会收到 409。' }],
  ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
  responses: { 200: { description: '成功', content: { 'application/json': { schema } } }, 400: { description: '输入无效或已达 10 个账号上限' }, 401: { description: '登录无效或未保存该账号' }, 403: { description: '来源不受信任或邀请码无效' }, 409: { description: '账号已切换或用户名已存在' }, 429: { description: '登录尝试过多' } },
});
const saved = [{ browserAccounts: [] }];
const either = [{ browserSession: [] }, ...saved];
const credentials = { type: 'object', required: ['username', 'password'], properties: { username: { type: 'string' }, password: { type: 'string', format: 'password' } } };
export const authPaths = {
  '/api/auth/me': { get: operation('读取当前登录身份', user, [{ browserSession: [] }]) },
  '/api/auth/login': { post: operation('登录并添加到本浏览器账号列表', user, [], credentials) },
  '/api/auth/register': { post: operation('注册并登录（首位用户之后需要邀请码）', user, [], { ...credentials, properties: { ...credentials.properties, inviteCode: { type: 'string' } } }) },
  '/api/auth/accounts': { get: operation('列出本浏览器已保存登录；未登录返回空列表', { type: 'object', properties: { accounts: { type: 'array', items: user } } }, []) },
  '/api/auth/switch': { post: operation('切换到本浏览器已验证过的账号', user, saved, { type: 'object', required: ['userId'], properties: { userId: { type: 'string' } } }) },
  '/api/auth/accounts/{id}': { delete: { ...operation('退出本浏览器中的非当前账号，保留数据', ok, saved), parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'X-Cortex-User', in: 'header', schema: { type: 'string' } }] } },
  '/api/auth/logout': { post: operation('退出当前账号并移除免密切换资格', ok, either) },
  '/api/auth/logout-all': { post: operation('退出本浏览器所有账号；不影响其他设备', ok, either) },
};
