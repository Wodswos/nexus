import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Bot,
  ExternalLink,
  FileText,
  GitPullRequest,
  Globe,
  Link2,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Power,
  RefreshCw,
  Terminal,
  Unlink,
  X,
} from 'lucide-react';
import {
  Button,
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
  Input,
  cn,
} from '@nexus/ui';
import { api, useNexus, useNexusData } from '@nexus/crdt';
import {
  sortedWorkspaceLinks,
  workspaceLinkHref,
  workspaceLinkLabel,
  workspaceLinkTarget,
  type TaskLink,
  type WorkspaceLinkKind,
} from '@nexus/core';
import { useUI } from '@/state/ui';
import { isComposing } from './ime';

const kinds = {
  url: {
    label: '网页',
    icon: Globe,
    placeholder: 'https://…',
    hint: '保存网址，点击后在新标签页打开。',
  },
  'github-pr': {
    label: 'GitHub PR',
    icon: GitPullRequest,
    placeholder: 'https://github.com/owner/repo/pull/123',
    hint: '支持 GitHub 和 GitHub Enterprise 的 PR 链接。',
  },
  tmux: { label: 'tmux 会话', icon: Terminal },
  dsh: {
    label: 'dsh 会话',
    icon: Terminal,
    placeholder: 'https://… 或 dsh://…',
    hint: '粘贴可打开指定会话的链接；dsh:// 需要设备安装对应工具。',
  },
  agent: {
    label: 'Agent 会话',
    icon: Bot,
    placeholder: 'https://… 或 agent://…',
    hint: '保存 Agent 会话的分享链接或应用链接。',
  },
  note: {
    label: '笔记／文档',
    icon: FileText,
    placeholder: 'https://… 或 obsidian://…',
    hint: '支持网页文档、语雀和 Obsidian 链接。',
  },
} as const;
type ResourceKind = keyof typeof kinds;
const kindOf = (link: TaskLink): ResourceKind =>
  link.type === 'obsidian' || link.type === 'yuque'
    ? 'note'
    : Object.hasOwn(kinds, link.type)
      ? (link.type as ResourceKind)
      : 'url';
const isolated = (store: ReturnType<typeof useNexus>, change: () => void) => {
  store.stopUndoCapture();
  try {
    change();
  } finally {
    store.stopUndoCapture();
  }
};

/** Persistent resource references live in the existing links document; connection state stays local. */
export function TaskWorkspace({ taskId }: { taskId: string }) {
  const data = useNexusData();
  const links = sortedWorkspaceLinks(data.links, taskId);
  const [adding, setAdding] = useState<ResourceKind | null>(null);
  return (
    <section
      id={`task-workspace-${taskId}`}
      aria-label="任务工作区"
      tabIndex={-1}
      data-task-resources
      data-task-workspace
      className="mt-5 space-y-3 border-t border-[var(--border)] pt-4 outline-none"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs font-medium">
          <Link2 size={14} />
          工作区<span className="text-muted">· {links.length}</span>
        </h3>
        <Dropdown>
          <DropdownTrigger asChild>
            <button
              aria-label="添加工作资源"
              className="inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs text-muted hover:bg-[var(--surface)] hover:text-foreground"
            >
              <Plus size={14} />
              添加
            </button>
          </DropdownTrigger>
          <DropdownContent
            data-task-detail-portal
            align="end"
            collisionPadding={12}
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.stopPropagation();
            }}
          >
            {(Object.entries(kinds) as [ResourceKind, (typeof kinds)[ResourceKind]][]).map(
              ([kind, { label, icon: Icon }]) => (
                <DropdownItem key={kind} onSelect={() => setAdding(kind)}>
                  <Icon size={14} />
                  {label}
                </DropdownItem>
              ),
            )}
          </DropdownContent>
        </Dropdown>
      </div>
      {links.length > 0 && (
        <ul aria-label="工作区资源" className="space-y-1">
          {links.map((link) => {
            const group = links.filter((item) => !!item.pinned === !!link.pinned);
            const index = group.findIndex((item) => item.id === link.id);
            return (
              <WorkspaceRow
                key={link.id}
                link={link}
                first={index === 0}
                last={index === group.length - 1}
              />
            );
          })}
        </ul>
      )}
      {!links.length && !adding && (
        <p className="text-xs leading-5 text-muted">
          关联终端、网页、PR 或会话，随时回到这项任务的工作现场。
        </p>
      )}
      {adding && (
        <div
          data-task-resource-editor
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !isComposing(event)) {
              event.preventDefault();
              event.stopPropagation();
              setAdding(null);
            }
          }}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-xs font-medium">添加{kinds[adding].label}</span>
            <button
              aria-label="取消添加资源"
              onClick={() => setAdding(null)}
              className="grid h-8 w-8 place-items-center rounded text-muted hover:text-foreground"
            >
              <X size={14} />
            </button>
          </div>
          {adding === 'tmux' ? (
            <TmuxResourceForm taskId={taskId} onDone={() => setAdding(null)} />
          ) : (
            <LinkResourceForm
              key={adding}
              taskId={taskId}
              kind={adding}
              onDone={() => setAdding(null)}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** Pinned resources remain immediately reachable above the task's editable details. */
export function TaskWorkspaceShortcuts({ taskId }: { taskId: string }) {
  const data = useNexusData();
  const links = sortedWorkspaceLinks(data.links, taskId),
    pinned = links.filter((link) => link.pinned);
  if (!links.length) return null;
  const jump = () => {
    const section = document.getElementById(`task-workspace-${taskId}`);
    section?.scrollIntoView({ block: 'nearest' });
    section?.focus({ preventScroll: true });
  };
  return (
    <nav
      aria-label="工作区快捷入口"
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border)] px-3 py-1.5"
    >
      <button
        onClick={jump}
        className="min-h-8 rounded-md px-1.5 text-[11px] text-muted hover:bg-[var(--surface)] hover:text-foreground"
      >
        工作区 · {links.length}
      </button>
      {pinned.slice(0, 3).map((link) => (
        <WorkspaceOpener key={link.id} link={link} compact />
      ))}
      {pinned.length > 3 && (
        <button
          aria-label="查看全部置顶资源"
          className="min-h-8 px-1.5 text-xs text-muted"
          onClick={jump}
        >
          +{pinned.length - 3}
        </button>
      )}
    </nav>
  );
}

function WorkspaceOpener({ link, compact = false }: { link: TaskLink; compact?: boolean }) {
  const data = useNexusData();
  const openTerminal = useUI((state) => state.openTmuxView);
  const kind = kinds[kindOf(link)],
    Icon = kind.icon,
    label = workspaceLinkLabel(link);
  const server = data.settings.servers.find((item) => item.id === link.serverId);
  const href = workspaceLinkHref(link);
  const available = link.type === 'tmux' ? !!server && !!link.session : !!href;
  const subtitle =
    link.type === 'tmux'
      ? `${link.session || '会话未指定'} · ${server?.name ?? '连接已移除'}`
      : available
        ? kind.label
        : '链接不可用';
  const content = (
    <>
      <Icon size={compact ? 12 : 15} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {!compact && (
          <span className="mt-0.5 block truncate text-[10px] font-normal text-muted">
            {subtitle}
          </span>
        )}
      </span>
      {!compact && href && <ExternalLink size={12} className="shrink-0 text-muted" />}
    </>
  );
  const className = cn(
    'flex min-w-0 items-center gap-2 rounded-md text-left text-xs outline-offset-2 hover:bg-[var(--surface)] hover:text-[var(--accent-solid)]',
    compact ? 'min-h-8 max-w-36 bg-[var(--surface)] px-2' : 'min-h-11 flex-1 px-1.5 py-2',
    !available && 'opacity-50',
  );
  const ariaLabel = `打开${compact ? '置顶' : ''}资源 ${label}`;
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={ariaLabel}
      title={link.target}
      className={className}
    >
      {content}
    </a>
  ) : (
    <button
      disabled={!available}
      aria-label={ariaLabel}
      title={subtitle}
      className={className}
      onClick={() => openTerminal(link.serverId!, link.session!)}
    >
      {content}
    </button>
  );
}

function WorkspaceRow({ link, first, last }: { link: TaskLink; first: boolean; last: boolean }) {
  const store = useNexus();
  const label = workspaceLinkLabel(link);
  const [editing, setEditing] = useState(false),
    [title, setTitle] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const endSession = async () => {
    if (busy || !link.serverId || !link.session) return;
    setBusy(true);
    setError('');
    try {
      await api.tmux('kill-session', link.serverId, link.session);
      if (active.current) {
        setConfirmEnd(false);
        setError('远程会话已结束，关联已保留。');
      }
    } catch (failure) {
      if (active.current) setError((failure as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return (
    <li
      data-workspace-resource={link.id}
      data-resource-type={link.type}
      data-pinned={!!link.pinned}
      className="rounded-md border border-transparent focus-within:border-[var(--border)] hover:bg-[var(--surface)]/50"
    >
      <div className="flex min-w-0 items-center gap-0.5">
        <WorkspaceOpener link={link} />
        <button
          aria-label={`${link.pinned ? '取消置顶' : '置顶'}资源 ${label}`}
          aria-pressed={!!link.pinned}
          title={link.pinned ? '取消置顶' : '置顶到任务快捷入口'}
          onClick={() => isolated(store, () => store.updateLink(link.id, { pinned: !link.pinned }))}
          className={cn(
            'grid h-9 w-8 shrink-0 place-items-center rounded-md hover:bg-[var(--surface)]',
            link.pinned ? 'text-[var(--accent-solid)]' : 'text-muted',
          )}
        >
          <Pin size={13} fill={link.pinned ? 'currentColor' : 'none'} />
        </button>
        <Dropdown>
          <DropdownTrigger asChild>
            <button
              aria-label={`资源 ${label} 菜单`}
              className="grid h-9 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-[var(--surface)] hover:text-foreground"
            >
              <MoreHorizontal size={15} />
            </button>
          </DropdownTrigger>
          <DropdownContent
            data-task-detail-portal
            align="end"
            collisionPadding={12}
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.stopPropagation();
            }}
          >
            <DropdownItem
              onSelect={() => {
                setTitle(link.title ?? '');
                setEditing(true);
              }}
            >
              <Pencil size={14} />
              重命名
            </DropdownItem>
            <DropdownItem
              disabled={first}
              onSelect={() => isolated(store, () => store.moveLink(link.id, -1))}
            >
              <ArrowUp size={14} />
              上移
            </DropdownItem>
            <DropdownItem
              disabled={last}
              onSelect={() => isolated(store, () => store.moveLink(link.id, 1))}
            >
              <ArrowDown size={14} />
              下移
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem onSelect={() => isolated(store, () => store.removeLink(link.id))}>
              <Unlink size={14} />
              解除关联
            </DropdownItem>
            {link.type === 'tmux' && (
              <>
                <DropdownSeparator />
                <DropdownItem
                  danger
                  disabled={!link.serverId || !link.session}
                  onSelect={() => {
                    setConfirmEnd(true);
                    setError('');
                  }}
                >
                  <Power size={14} />
                  结束远程会话
                </DropdownItem>
              </>
            )}
          </DropdownContent>
        </Dropdown>
      </div>
      {editing && (
        <form
          data-task-resource-editor
          aria-label="重命名资源"
          onSubmit={(event) => {
            event.preventDefault();
            isolated(store, () => store.updateLink(link.id, { title: title.trim() }));
            setEditing(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && isComposing(event)) event.preventDefault();
            if (event.key === 'Escape' && !isComposing(event)) {
              event.preventDefault();
              event.stopPropagation();
              setEditing(false);
            }
          }}
          className="space-y-2 px-2 pb-3"
        >
          <Input
            autoFocus
            aria-label="资源名称"
            maxLength={200}
            placeholder={workspaceLinkLabel({ ...link, title: '' })}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="h-9 text-xs"
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              保存名称
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              取消
            </Button>
          </div>
        </form>
      )}
      {confirmEnd && (
        <div className="space-y-2 px-2 pb-3 text-xs">
          <p className="leading-5 text-[var(--danger)]">
            结束会话将关闭其中的全部窗口和进程。解除关联不会结束会话。
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void endSession()}>
              确认结束
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmEnd(false)}>
              取消
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="status" className="px-2 pb-2 text-xs text-muted">
          {error}
        </p>
      )}
    </li>
  );
}

function LinkResourceForm({
  taskId,
  kind,
  onDone,
}: {
  taskId: string;
  kind: WorkspaceLinkKind;
  onDone: () => void;
}) {
  const store = useNexus();
  const [value, setValue] = useState(''),
    [title, setTitle] = useState(''),
    [error, setError] = useState('');
  const spec = kinds[kind];
  return (
    <form
      aria-label={`添加${spec.label}`}
      className="space-y-3"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && isComposing(event)) event.preventDefault();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const { type, target } = workspaceLinkTarget(kind, value);
          isolated(store, () => store.addLink(taskId, type, target, title.trim() || undefined));
          onDone();
        } catch (failure) {
          setError((failure as Error).message);
        }
      }}
    >
      <label className="block space-y-1.5 text-xs">
        <span className="text-muted">链接</span>
        <Input
          autoFocus
          aria-label="资源链接"
          value={value}
          maxLength={8192}
          placeholder={spec.placeholder}
          onChange={(event) => setValue(event.target.value)}
          className="h-9 text-xs"
        />
      </label>
      <label className="block space-y-1.5 text-xs">
        <span className="text-muted">名称（可选）</span>
        <Input
          aria-label="资源名称"
          maxLength={200}
          value={title}
          placeholder="使用链接标题"
          onChange={(event) => setTitle(event.target.value)}
          className="h-9 text-xs"
        />
      </label>
      <p className="text-[11px] leading-5 text-muted">{spec.hint}</p>
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!value.trim()}>
          添加资源
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          取消
        </Button>
      </div>
    </form>
  );
}

function TmuxResourceForm({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const data = useNexusData(),
    store = useNexus();
  const selectTask = useUI((state) => state.selectTask);
  const [serverId, setServerId] = useState(''),
    [session, setSession] = useState(''),
    [title, setTitle] = useState('');
  const [sessions, setSessions] = useState<string[]>([]),
    [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState(''),
    [creating, setCreating] = useState(false),
    [sessionName, setSessionName] = useState(''),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
    };
  }, []);
  const load = async (id: string) => {
    const request = ++generation.current;
    setSessions([]);
    setSession('');
    setError('');
    if (!id) {
      setStatus('idle');
      return;
    }
    setStatus('loading');
    try {
      const body = await api.tmux<{ sessions: string[] }>('sessions', id);
      if (!active.current || request !== generation.current) return;
      setSessions(body.sessions);
      setStatus('ready');
    } catch (failure) {
      if (active.current && request === generation.current) {
        setError((failure as Error).message);
        setStatus('error');
      }
    }
  };
  const attach = (id: string, name: string) => {
    const server = data.settings.servers.find((item) => item.id === id);
    if (!server || !name) return;
    isolated(store, () =>
      store.addLink(
        taskId,
        'tmux',
        `tmux://${encodeURIComponent(server.name)}/${encodeURIComponent(name)}`,
        title.trim() || undefined,
        { serverId: id, session: name },
      ),
    );
    onDone();
  };
  const create = async () => {
    const name = sessionName.trim(),
      id = serverId;
    if (busy || !id || !/^[\w.:@$=-]{1,128}$/.test(name)) return;
    setBusy(true);
    setError('');
    try {
      await api.tmux('new-session', id, name);
      if (active.current) attach(id, name);
    } catch (failure) {
      if (active.current) setError((failure as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  };
  if (!data.settings.servers.length)
    return (
      <a
        href="/settings"
        onClick={() => selectTask(null)}
        className="text-xs text-[var(--accent-solid)]"
      >
        先配置 SSH 连接
      </a>
    );
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1">
        <select
          aria-label="tmux 服务器"
          disabled={busy}
          value={serverId}
          onChange={(event) => {
            setServerId(event.target.value);
            setCreating(false);
            void load(event.target.value);
          }}
          className="h-9 min-w-0 flex-1 rounded-md border border-[var(--border-strong)] bg-transparent px-2 text-xs"
        >
          <option value="">选择服务器</option>
          {data.settings.servers.map((server) => (
            <option key={server.id} value={server.id}>
              {server.name}
            </option>
          ))}
        </select>
        <button
          aria-label="刷新 tmux 会话"
          disabled={!serverId || status === 'loading' || busy}
          onClick={() => void load(serverId)}
          className="grid h-9 w-8 place-items-center text-muted disabled:opacity-40"
        >
          <RefreshCw size={14} className={status === 'loading' ? 'animate-spin' : ''} />
        </button>
      </div>
      {serverId && (
        <>
          <Input
            aria-label="资源名称"
            value={title}
            maxLength={200}
            placeholder="名称（可选）"
            onChange={(event) => setTitle(event.target.value)}
            className="h-9 text-xs"
          />
          <div className="flex gap-2">
            <select
              aria-label="tmux 会话"
              value={session}
              disabled={status !== 'ready' || busy}
              onChange={(event) => setSession(event.target.value)}
              className="h-9 min-w-0 flex-1 rounded-md border border-[var(--border-strong)] bg-transparent px-2 text-xs"
            >
              <option value="">
                {status === 'loading'
                  ? '正在查询会话…'
                  : status === 'error'
                    ? '连接失败'
                    : sessions.length
                      ? '选择已有会话'
                      : '连接成功，暂无会话'}
              </option>
              {sessions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              disabled={!session || status !== 'ready' || busy}
              onClick={() => attach(serverId, session)}
            >
              关联
            </Button>
          </div>
          {creating ? (
            <div className="space-y-2">
              <Input
                autoFocus
                aria-label="新 tmux 会话名"
                maxLength={128}
                placeholder="新会话名称"
                value={sessionName}
                onChange={(event) => setSessionName(event.target.value)}
                onKeyDown={(event) => {
                  if (!isComposing(event) && event.key === 'Enter') void create();
                }}
                className="h-9 text-xs"
              />
              <p className="text-[11px] text-muted">会话名支持字母、数字及 _ . : @ $ = -</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || !/^[\w.:@$=-]{1,128}$/.test(sessionName.trim())}
                  onClick={() => void create()}
                >
                  创建并关联
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setCreating(false)}
                >
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <button
              disabled={status !== 'ready'}
              className="flex min-h-8 items-center gap-1 text-xs text-muted hover:text-foreground disabled:opacity-40"
              onClick={() => setCreating(true)}
            >
              <Plus size={12} />
              新建远程会话
            </button>
          )}
        </>
      )}
      {error && (
        <div role="alert" className="space-y-1 text-xs text-[var(--danger)]">
          <p>{error}</p>
          <a href="/settings" onClick={() => selectTask(null)} className="underline">
            检查连接配置
          </a>
        </div>
      )}
    </div>
  );
}
