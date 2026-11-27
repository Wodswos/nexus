import type { NexusData } from './types';
import type { WorkspaceEnvironment } from './executionWorkspace';
import type { WorkspaceProfile } from './workspaceProfiles';

/** Creation choices follow the task ancestry, nearest first, without changing bindings. */
export function workspaceChoices(data: Pick<NexusData, 'tasks' | 'workspaces'>, taskId: string, profiles: readonly WorkspaceProfile[], environments: readonly WorkspaceEnvironment[]) {
  const byId = new Map(data.tasks.filter(task => !task.deletedAt && task.status !== 'archived').map(task => [task.id, task]));
  const path: string[] = [];
  let current = byId.get(taskId);
  while (current && !path.includes(current.id)) { path.push(current.id); current = current.parentId ? byId.get(current.parentId) : undefined; }
  const bindings = new Map(data.workspaces.map(binding => [binding.id, binding]));
  const source = (id: string | undefined) => id === taskId ? '当前 Task' : byId.get(id ?? '')?.title ?? '账号共享';
  const profileSource = (profile: WorkspaceProfile) => path.find(id => profile.taskId === id || bindings.get(id)?.workspaceId === profile.id);
  const environmentSource = (environment: WorkspaceEnvironment) => path.find(id => environment.taskId === id || bindings.get(id)?.environmentId === environment.id);
  const rank = (id: string | undefined) => id ? path.indexOf(id) : path.length;
  return {
    profiles: profiles.filter(profile => !profile.deletedAt).map(value => ({ value, sourceId: profileSource(value) })).sort((a, b) => rank(a.sourceId) - rank(b.sourceId)),
    environments: environments.filter(value => !value.archivedAt && !value.dataClearedAt && !value.dataDeletedAt && ['ready', 'queued', 'preparing'].includes(value.state)).map(value => ({ value, sourceId: environmentSource(value) })).sort((a, b) => rank(a.sourceId) - rank(b.sourceId)),
    source,
  };
}

/** Safe directory/branch component; suffix is supplied by the caller's UUID source. */
export function workspaceUniqueName(prefix: string, title: string, token: string): string {
  const slug = title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24).replace(/-$/g, '');
  return `${prefix}${slug ? `-${slug}` : ''}-${token.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 24)}`;
}
