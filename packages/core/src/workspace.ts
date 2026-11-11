import type { LinkType, TaskLink } from './types';

export type WorkspaceLinkKind = 'url' | 'github-pr' | 'dsh' | 'agent' | 'note';

function parsedUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function githubPullRequest(target: string) {
  const url = parsedUrl(target);
  if (!url || !['http:', 'https:'].includes(url.protocol)) return null;
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/.*)?$/.exec(url.pathname);
  if (!match || !Number.isSafeInteger(Number(match[3]))) return null;
  return { host: url.host, owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

/** Validate new associations; old imported targets remain readable and are checked at open time. */
export function workspaceLinkTarget(
  kind: WorkspaceLinkKind,
  input: string,
): { type: LinkType; target: string } {
  const target = input.trim();
  if (target.length > 8192) throw new Error('链接过长');
  const url = parsedUrl(target);
  if (!url) throw new Error('请输入完整链接');
  if (url.username || url.password) throw new Error('请使用不包含用户名或密码的链接');
  const protocols =
    kind === 'note'
      ? ['http:', 'https:', 'obsidian:']
      : kind === 'agent'
        ? ['http:', 'https:', 'agent:']
        : kind === 'dsh'
          ? ['http:', 'https:', 'dsh:']
          : ['http:', 'https:'];
  if (!protocols.includes(url.protocol)) throw new Error('此资源不支持该链接类型');
  const pr = githubPullRequest(target);
  if (kind === 'github-pr' && !pr)
    throw new Error('请输入 PR 链接，例如 https://github.com/owner/repo/pull/123');
  const type: LinkType =
    kind === 'note'
      ? url.protocol === 'obsidian:'
        ? 'obsidian'
        : /(^|\.)yuque\.com$/i.test(url.hostname)
          ? 'yuque'
          : 'url'
      : kind === 'url' && pr && /(^|\.)github\.com$/i.test(url.hostname)
        ? 'github-pr'
        : kind;
  return { type, target: url.href };
}

/** Only known, non-executable URL schemes may become clickable, including in old backups. */
export function workspaceLinkHref(link: TaskLink): string | undefined {
  if (link.type === 'tmux') return undefined;
  const url = parsedUrl(link.target);
  if (!url || url.username || url.password) return undefined;
  const protocols =
    link.type === 'obsidian'
      ? ['http:', 'https:', 'obsidian:']
      : link.type === 'agent'
        ? ['http:', 'https:', 'agent:']
        : link.type === 'dsh'
          ? ['http:', 'https:', 'dsh:']
          : link.type === 'url'
            ? ['http:', 'https:', 'agent:']
            : ['http:', 'https:'];
  return protocols.includes(url.protocol) ? link.target : undefined;
}

export function workspaceLinkLabel(link: TaskLink): string {
  if (link.title?.trim()) return link.title.trim();
  if (link.type === 'tmux') return link.session || 'tmux 会话';
  const pr = githubPullRequest(link.target);
  if (link.type === 'github-pr' && pr) return `${pr.owner}/${pr.repo} #${pr.number}`;
  const url = parsedUrl(link.target);
  if (url?.protocol === 'obsidian:') return url.searchParams.get('file') || 'Obsidian 笔记';
  return url
    ? `${url.host}${url.pathname === '/' ? '' : url.pathname}` || link.target
    : link.target || '未命名资源';
}

export function workspaceLinkKey(
  link: Pick<TaskLink, 'type' | 'target' | 'serverId' | 'session'>,
): string {
  if (link.type === 'tmux') return JSON.stringify(['tmux', link.serverId, link.session]);
  const pr = githubPullRequest(link.target);
  if (pr && (link.type === 'github-pr' || link.type === 'url'))
    return JSON.stringify([
      'github-pr',
      pr.host.toLowerCase(),
      pr.owner.toLowerCase(),
      pr.repo.toLowerCase(),
      pr.number,
    ]);
  return JSON.stringify([link.type, parsedUrl(link.target)?.href ?? link.target]);
}

export const workspaceLinkOrder = (link: TaskLink): number => link.order ?? link.createdAt;

export function sortedWorkspaceLinks(links: readonly TaskLink[], taskId: string): TaskLink[] {
  return links
    .filter((link) => link.taskId === taskId && !link.deletedAt)
    .sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) ||
        workspaceLinkOrder(a) - workspaceLinkOrder(b) ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    );
}
