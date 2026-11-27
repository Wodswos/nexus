const text = { type: 'string' };
const fields = {
  id: text, name: { ...text, maxLength: 120 },
  server: { ...text, format: 'uri', description: 'HTTPS Kubernetes API Server 根地址，必须验证 TLS' },
  namespace: { ...text, default: 'default' },
  ca: { ...text, description: 'PEM CA，可留空以使用系统信任链' },
};
export const kubernetesSchemas = {
  KubernetesConnection: { type: 'object', properties: { ...fields, tokenSet: { type: 'boolean' }, certificateSet: { type: 'boolean' }, createdAt: { type: 'number' }, updatedAt: { type: 'number' } } },
  KubernetesConnectionInput: { type: 'object', additionalProperties: false, properties: { ...fields, token: { ...text, nullable: true, writeOnly: true }, cert: { ...text, nullable: true, writeOnly: true, description: '客户端 PEM 证书，与 key 成对设置' }, key: { ...text, nullable: true, writeOnly: true } }, description: '创建时提供 name、server 和 token 或 cert/key。更新时省略凭据保留原值，null 清除。凭据加密保存于服务端。' },
};
const operation = (method: string, summary: string, withId = false) => ({
  tags: ['Workspace'], summary, operationId: `${method}_kubernetes_connection${withId ? '_id' : 's'}`,
  security: [{ browserSession: [] }],
  description: '仅允许浏览器账号会话。业务 API Token 和 Agent 执行凭据不能管理集群连接。需要 pods get/list/create/delete 与 pods/exec create/get 权限。流式 exec 需要 Kubernetes 1.29+ 的 v5 WebSocket 协议。',
  ...(withId ? { parameters: [{ name: 'id', in: 'path', required: true, schema: text }] } : {}),
  ...(['post', 'put'].includes(method) ? { requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/KubernetesConnectionInput' } } } } } : {}),
  responses: {
    200: { description: '成功', content: { 'application/json': { schema: { type: 'object', properties: { data: method === 'get' ? { type: 'array', items: { $ref: '#/components/schemas/KubernetesConnection' } } : method === 'delete' ? { type: 'object', properties: { deleted: { type: 'boolean' } } } : { $ref: '#/components/schemas/KubernetesConnection' } } } } } },
    ...Object.fromEntries([400, 401, 403, 404, 409, 429, 502].map((status) => [status, { description: '参数、认证、权限、归属或连接错误', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }])),
  },
});
export const kubernetesPaths = {
  '/api/kubernetes-connections': { get: operation('get', '读取当前账号的 Kubernetes 连接'), post: operation('post', '创建加密保存的 Kubernetes 连接') },
  '/api/kubernetes-connections/{id}': { put: operation('put', '更新 Kubernetes 连接或轮换凭据', true), delete: operation('delete', '删除 Kubernetes 连接配置', true) },
};
