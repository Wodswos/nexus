const text = { type: 'string' };
const profile = { type: 'object', properties: {
  id: text, taskId: { ...text, description: '模板所属 Task；子任务创建 Workspace 时可选择，省略为账号共享模板' }, name: { type: 'string', maxLength: 120 }, config: { $ref: '#/components/schemas/WorkspaceConfig', description: '配置整体替换。PATCH 提交 config 时应包含要保留的字段，省略的字段恢复默认值。' },
  promptTemplate: { type: 'string', maxLength: 24000, deprecated: true, description: '保留历史字段；不再决定新 Agent 的默认 Prompt，请在创建 Agent 时传入 prompt。' }, createdAt: { type: 'number' }, updatedAt: { type: 'number' },
} };
export const workspaceProfileSchemas = { WorkspaceProfile: profile };
export const workspaceProfilePaths: Record<string, Record<string, unknown>> = {};
for (const [path, method, summary] of [
  ['/api/workspace-profiles', 'get', '列出可复用 Workspace 配置'],
  ['/api/workspace-profiles', 'post', '创建可复用 Workspace 配置'],
  ['/api/workspace-profiles/{id}', 'get', '读取 Workspace 配置'],
  ['/api/workspace-profiles/{id}', 'patch', '更新 Workspace 配置'],
  ['/api/workspace-profiles/{id}', 'delete', '删除未被节点引用的 Workspace 配置'],
]) {
  (workspaceProfilePaths[path!] ??= {})[method!] = {
    tags: ['Workspace'], summary, operationId: `${method}_${path!.replace(/[^a-z0-9]/gi, '_')}`,
    security: [{ browserSession: [] }],
    parameters: path!.includes('{id}') ? [{ name: 'id', in: 'path', required: true, schema: text }] : [],
    ...(['post', 'patch'].includes(method!) ? { requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', additionalProperties: false,
      ...(method === 'post' ? { required: ['requestId', 'name', 'config'] } : {}),
      properties: { name: profile.properties.name, config: profile.properties.config, promptTemplate: profile.properties.promptTemplate,
        ...(method === 'post' ? { requestId: text, taskId: profile.properties.taskId } : { expectedUpdatedAt: { type: 'number', description: '读取时的 updatedAt，冲突返回 409' } }),
      },
    } } } } } : {}),
    responses: { 200: { description: '成功', content: { 'application/json': { schema: { type: 'object', properties: {
      data: method === 'get' && !path!.includes('{id}') ? { type: 'array', items: profile }
        : method === 'delete' ? { type: 'object', properties: { id: text, deleted: { type: 'boolean' } } } : profile,
    } } } } }, 400: { description: '参数无效或 Workspace 仍被节点引用' }, 401: { description: '需要浏览器登录' }, 404: { description: '不存在于当前账号' }, 409: { description: '并发更新或幂等冲突' } },
  };
}
