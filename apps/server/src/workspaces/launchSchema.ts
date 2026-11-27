export const workspaceLaunchPaths = {
  '/api/tasks/{taskId}/workspace-launch': { post: {
    tags: ['Workspace'], operationId: 'post_task_workspace_launch', summary: '创建环境并同步创建 Agent，持久化分阶段恢复',
    security: [{ browserSession: [] }],
    parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
    description: '同一账号以 requestId 幂等。省略 agent 仅准备环境。提供 agent 时环境就绪后启动独立 Agent，初始 Prompt 的上下文 URL 绑定当前任务。失败时使用相同请求重试。服务器重启会继续未完成的创建流程。',
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', additionalProperties: false, required: ['requestId', 'config'], properties: {
        requestId: { type: 'string', maxLength: 128 }, name: { type: 'string', maxLength: 120 }, workspaceId: { type: 'string', description: '采用的 Workspace 模板 ID' }, config: { $ref: '#/components/schemas/WorkspaceConfig' },
        resourceId: { type: 'string', description: '可选，关联已有环境资源' },
        agent: { type: 'object', additionalProperties: false, required: ['name', 'mode', 'command'], properties: {
          workspaceId: { type: 'string', nullable: true }, name: { type: 'string' }, mode: { type: 'string', enum: ['acp', 'tmux'] },
          command: { type: 'string' }, prompt: { type: 'string' }, directory: { type: 'string' }, worktree: { type: 'boolean' }, worktreeName: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$' },
          productId: { type: 'string' }, round: { $ref: '#/components/schemas/AgentRoundInput' },
          pane: { $ref: '#/components/schemas/WorkspacePane' },
        } },
      },
    } } } },
    responses: { 200: { description: '环境记录与可选 Agent 记录已保存，异步准备会继续', content: { 'application/json': { schema: {
      type: 'object', properties: { data: { type: 'object', properties: { environment: { $ref: '#/components/schemas/WorkspaceEnvironment' }, agent: { $ref: '#/components/schemas/WorkspaceAgent' } } } },
    } } } }, 400: { description: '配置无效' }, 401: { description: '需要浏览器登录' }, 404: { description: '任务、配置或连接不存在于当前账号' }, 409: { description: '同一请求内容变化或状态冲突' }, 429: { description: '请求或队列超限' }, 502: { description: '环境关联失败，可使用同一请求重试' } },
  } },
};
