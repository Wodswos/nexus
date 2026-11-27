const text = { type: 'string' };
const revision = { type: 'object', properties: {
  id: text, taskId: text, title: text, notes: text, createdAt: { type: 'number' }, author: text,
  source: { type: 'string', enum: ['initial', 'user', 'api', 'agent', 'restore'] }, agentId: text, roundId: text, restoredFrom: text,
} };
export const taskRevisionSchemas = { TaskRevision: revision };
export const taskRevisionPaths: Record<string, Record<string, unknown>> = {};
for (const collection of ['tasks', 'projects']) {
  const base = `/api/v1/${collection}/{taskId}`;
  for (const [suffix, method, summary, body, output] of [
    ['/description', 'get', '读取任务正文及当前版本', undefined, revision],
    ['/description', 'patch', '按版本更新正文，冲突时返回409', { type: 'object', required: ['expectedRevisionId', 'notes'], properties: { expectedRevisionId: text, notes: { type: 'string', maxLength: 100000 } } }, revision],
    ['/revisions', 'get', '分页查看标题与正文历史版本', undefined, { type: 'object', properties: { revisions: { type: 'array', items: revision }, total: { type: 'integer' }, currentRevisionId: text } }],
    ['/revisions/{revisionId}', 'get', '读取历史版本完整正文', undefined, revision],
    ['/revisions/{revisionId}/restore', 'post', '恢复历史标题与正文，保留后续版本', { type: 'object', required: ['expectedRevisionId'], properties: { expectedRevisionId: text } }, revision],
  ] as const) {
    const path = base + suffix;
    (taskRevisionPaths[path] ??= {})[method] = { tags: ['任务'], summary, operationId: `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`,
      parameters: [{ name: 'taskId', in: 'path', required: true, schema: text }, ...(path.includes('{revisionId}') ? [{ name: 'revisionId', in: 'path', required: true, schema: text }] : []), ...(suffix === '/revisions' ? [{ name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } }] : [])],
      ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
      responses: { 200: { description: '成功', content: { 'application/json': { schema: { type: 'object', properties: { data: output } } } } }, 409: { description: '正文已变化，请重新读取合并后提交' }, 404: { description: '此账号下不存在任务或版本' } },
    };
  }
}
