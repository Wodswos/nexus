import { createHash } from 'node:crypto';
export const workspaceLaunchOperationId = (taskId: string, requestId: string) =>
  createHash('sha256').update(JSON.stringify([taskId, requestId])).digest('hex');
export function workspaceEnvironmentId(userId: string, taskId: string, requestId: string): string {
  const hex = createHash('sha256').update(JSON.stringify(['nexus-workspace', userId, taskId, requestId])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
