import React, { useEffect, useRef, useState } from 'react';
import { Pencil, RotateCcw } from 'lucide-react';
import { Button, Dialog, DialogContent, SelectField } from '@nexus/ui';
import {
  EMPTY_WORKSPACE,
  WORKSPACE_CONFIG_KEYS,
  resolveWorkspace,
  workspaceDefaultRoot,
  newUuid,
  type NodeWorkspace,
  type WorkspaceConfig,
} from '@nexus/core';
import { currentStore, useNexus, useNexusData } from '@nexus/crdt';
import { useAuth } from '@/app/auth';
import { agentWorkspaceApi, type WorkspaceProfileView } from './agentWorkspaceApi';
import { KubernetesConnections } from './KubernetesConnections';

const fieldNames: Record<keyof WorkspaceConfig, string> = {
  runtime: '运行方式',
  terminalPolicy:'人工终端',
  cpuLimit: 'CPU 上限（核）', memoryLimit: '内存上限', runUser: '运行用户 UID / GID', pidsLimit: '进程数上限',
  serverId: '控制主机',
  kubeConnectionId: 'Kubernetes API 连接',
  image: 'Image',
  repository: 'GitHub／Git 仓库',
  ref: '基准分支或版本',
  localRepository: '本地仓库路径', source: '仓库来源策略', branch: '新工作分支', prTarget: 'PR 目标分支', workRoot: '持久化工作根目录', storage: '存储方式', volumeName: '已有 Docker Volume / PVC', storageClass: 'Storage Class', storageSize: '存储容量',
  directory: '工作目录',
  session: 'tmux 会话（旧配置）',
  agentCommand: '默认 Agent 启动命令（ACP）',
  context: 'Kubernetes context',
  namespace: 'Namespace',
  secretRef: '环境凭据引用',
  imagePullSecret: 'Image Pull Secret',
};
export { fieldNames as workspaceFieldNames };

const fieldGroups: { title: string; fields: (keyof WorkspaceConfig)[]; advanced?: boolean }[] = [
  { title: '运行环境', fields: ['runtime', 'serverId', 'kubeConnectionId', 'image', 'context', 'namespace'] },
  { title: 'Git 仓库', fields: ['repository', 'localRepository', 'source', 'ref', 'prTarget'] },
  { title: '工作目录与存储', fields: ['workRoot', 'directory', 'storage', 'volumeName', 'storageClass', 'storageSize'] },
  { title: '启动命令、资源与凭据', fields: ['agentCommand', 'cpuLimit', 'memoryLimit', 'runUser', 'pidsLimit', 'secretRef', 'imagePullSecret'], advanced: true },
];
// An empty PR target follows ref at creation time, including future ref edits.
const editableConfig = (config: WorkspaceConfig): WorkspaceConfig => ({
  ...EMPTY_WORKSPACE, ...config, prTarget: config.prTarget === config.ref ? '' : config.prTarget ?? '',
});

export function WorkspaceConfiguration({
  taskId,
  onClose, manageProfile, onSaved,
}: {
  manageProfile?: WorkspaceProfileView | 'new';
  onSaved?: (profile: WorkspaceProfileView) => void;
  taskId: string;
  onClose: () => void;
}) {
  const store = useNexus(),
    data = useNexusData(), { user } = useAuth();
  const [baseline, setBaseline] = useState<NodeWorkspace>(
    () =>
      data.workspaces.find((value) => value.id === taskId) ?? {
        id: taskId,
        mode: 'inherit',
      },
  );
  const [initial] = useState(() =>
    resolveWorkspace(
      {
        tasks: data.tasks,
        workspaceProfiles: data.workspaceProfiles,
        workspaces: data.workspaces.map((binding) =>
          binding.id === taskId && binding.mode === 'disabled'
            ? { ...binding, mode: 'override' }
            : binding,
        ),
      },
      taskId,
    ),
  );
  const [values, setValues] = useState<WorkspaceConfig>(() => editableConfig(manageProfile && manageProfile !== 'new' ? manageProfile.config : manageProfile ? EMPTY_WORKSPACE : initial.config));
  const [profiles, setProfiles] = useState<WorkspaceProfileView[]>(() => [...(manageProfile && manageProfile !== 'new' ? [manageProfile] : []), ...(data.workspaceProfiles ?? []).filter((value) => value.deletedAt == null && (!manageProfile || manageProfile === 'new' || value.id !== manageProfile.id))]);
  const [profileChoice, setProfileChoice] = useState(manageProfile && manageProfile !== 'new' ? manageProfile.id : baseline.workspaceId === undefined ? '__inherit__' : baseline.workspaceId ?? '');
  const initialChoice = useRef(profileChoice);
  const [profileEditor, setProfileEditor] = useState<'new' | 'edit' | null>(manageProfile ? manageProfile === 'new' ? 'new' : 'edit' : null);
  const [profileName, setProfileName] = useState(manageProfile && manageProfile !== 'new' ? manageProfile.name : '');
  const [editingRoot, setEditingRoot] = useState(false);
  const [deleteProfile, setDeleteProfile] = useState(false);
  const profileRequest = useRef<{ body: string; id: string }>();
  const sharedDraft = useRef<{ values: WorkspaceConfig; mode: NodeWorkspace['mode']; inherit: Set<keyof WorkspaceConfig> }>();
  const mounted = useRef(true);
  const active = () => mounted.current && currentStore() === store;
  const selectedProfile = profiles.find((value) => value.id === profileChoice);
  useEffect(() => {
    mounted.current = true;
    if (user) void agentWorkspaceApi.profiles().then((values) => { if (active()) setProfiles(values); }).catch((reason) => { if (active()) setError(reason instanceof Error ? reason.message : 'Workspace 模板读取失败'); });
    return () => { mounted.current = false; };
  }, [store, user?.id]);
  const [mode, setMode] = useState<NodeWorkspace['mode']>(manageProfile ? 'override' : baseline.mode);
  const [inherit, setInherit] = useState(new Set<keyof WorkspaceConfig>());
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const task = data.tasks.find((value) => value.id === taskId);
  const parent = task?.parentId
    ? resolveWorkspace(data, task.parentId)
    : {
        config: EMPTY_WORKSPACE,
        sources: {} as Partial<Record<keyof WorkspaceConfig, string>>,
      };
  const inputClass =
    'h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs outline-none focus:border-[var(--accent-solid)]';
  const fields = WORKSPACE_CONFIG_KEYS.filter((key) => {
    if (['session', 'branch'].includes(key)) return false;
    if (['cpuLimit', 'memoryLimit', 'runUser'].includes(key)) return ['docker', 'kubernetes'].includes(values.runtime);
    if (key === 'pidsLimit') return ['docker', 'linux-user'].includes(values.runtime);
    if (key === 'directory') return !!values.directory;
    if (key === 'image') return ['docker', 'kubernetes'].includes(values.runtime);
    if (['storageClass', 'storageSize'].includes(key)) return values.runtime === 'kubernetes' && values.storage !== 'ephemeral';
    if (['storage', 'volumeName'].includes(key)) return ['docker', 'kubernetes'].includes(values.runtime);
    if (key === 'kubeConnectionId') return values.runtime === 'kubernetes' && !!values.kubeConnectionId;
    if (key === 'serverId') return !(values.runtime === 'kubernetes' && values.kubeConnectionId);
    if (key === 'context' && values.kubeConnectionId) return false;
    if (['context', 'namespace', 'imagePullSecret'].includes(key))
      return values.runtime === 'kubernetes';
    return true;
  });
  const update = (key: keyof WorkspaceConfig, value: string) => {
    setValues((previous) => {
      const next = { ...previous, [key]: value };
      if (key === 'runtime') {
        if (!['docker', 'kubernetes'].includes(value)) Object.assign(next, { image: '', cpuLimit: '', memoryLimit: '', runUser: '' });
        if (!['docker', 'linux-user'].includes(value)) next.pidsLimit = '';
        if (value !== 'kubernetes') Object.assign(next, { kubeConnectionId: '', storageClass: '', storageSize: '', imagePullSecret: '' });
      }
      return next;
    });
    setInherit((previous) => {
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
  };
  const editShared = (kind: 'new' | 'edit') => {
    sharedDraft.current ??= { values: { ...values }, mode, inherit: new Set(inherit) };
    setProfileEditor(kind); setDeleteProfile(false); setMode('override');
    setProfileName(kind === 'edit' && selectedProfile ? selectedProfile.name : task?.title ? `${task.title} Workspace 模板` : '新 Workspace 模板');
    if (kind === 'edit' && selectedProfile) { setValues(editableConfig(selectedProfile.config)); }
  };
  const cancelShared = () => {
    const draft = sharedDraft.current;
    if (draft) { setValues(draft.values); setMode(draft.mode); setInherit(draft.inherit); }
    sharedDraft.current = undefined; setProfileEditor(null); setDeleteProfile(false);
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (values.kubeConnectionId === '__new__' && mode === 'override') throw new Error('请选择或添加 Kubernetes API 连接');
      const patch: Partial<Omit<NodeWorkspace, 'id'>> = { mode };
      const selectionChanged = profileChoice !== initialChoice.current;
      if (selectionChanged) {
        patch.workspaceId = profileChoice === '__inherit__' ? undefined : profileChoice || null;
        for (const key of WORKSPACE_CONFIG_KEYS) Object.assign(patch, { [key]: undefined });
      }
      if (profileEditor) {
        if (!profileName.trim()) throw new Error('请填写 Workspace 模板名称');
        const value = { name: profileName.trim(), config: values };
        let profile: WorkspaceProfileView;
        if (profileEditor === 'edit' && selectedProfile) {
          profile = await agentWorkspaceApi.updateProfile(selectedProfile.id, { ...value, expectedUpdatedAt: selectedProfile.updatedAt });
        } else {
          const body = JSON.stringify(value);
          if (profileRequest.current?.body !== body) profileRequest.current = { body, id: newUuid() };
          profile = await agentWorkspaceApi.createProfile({ ...value, ...(task ? { taskId: task.id } : {}), requestId: profileRequest.current.id });
        }
        if (!active()) return;
        const cached = store.getData().workspaceProfiles?.find((value) => value.id === profile.id);
        if (!cached || cached.updatedAt < profile.updatedAt) store.saveWorkspaceProfile(profile);
        if (manageProfile) { await store.flushPersistence(); if (active()) { onSaved?.(profile); onClose(); } return; }
        patch.workspaceId = profile.id;
        patch.mode = 'inherit';
        for (const key of WORKSPACE_CONFIG_KEYS) Object.assign(patch, { [key]: undefined });
      } else {
        if (mode === 'inherit') for (const key of WORKSPACE_CONFIG_KEYS) Object.assign(patch, { [key]: undefined });
        if (mode === 'override') for (const key of WORKSPACE_CONFIG_KEYS) {
          const base = selectionChanged ? selectedProfile?.config ?? (profileChoice === '__inherit__' ? parent.config : EMPTY_WORKSPACE) : initial.config;
          if (inherit.has(key)) Object.assign(patch, { [key]: undefined });
          else if ((values[key] ?? '') !== (base[key] ?? '')) Object.assign(patch, { [key]: values[key] || null });
        }
      }
      if (selectedProfile && !store.getData().workspaceProfiles?.some((value) => value.id === selectedProfile.id)) store.saveWorkspaceProfile(selectedProfile);
      store.setWorkspace(taskId, patch, baseline);
      setBaseline(
        store.getData().workspaces.find((binding) => binding.id === taskId) ??
          baseline,
      );
      await store.flushPersistence();
      if (active()) onClose();
    } catch (reason) {
      if (active()) setError(reason instanceof Error ? reason.message : '配置保存失败');
    } finally {
      if (active()) setBusy(false);
    }
  };
  const renderField = (key: keyof WorkspaceConfig) => {
    const sourceId = inherit.has(key)
      ? selectedProfile ? taskId : parent.sources[key]
      : values[key] !== initial.config[key]
        ? taskId
        : initial.sources[key];
    const source =
      sourceId === taskId
        ? '本节点'
        : data.tasks.find((value) => value.id === sourceId)?.title;
    const own =
      baseline[key] !== undefined ||
      values[key] !== initial.config[key];
    return (
      <div key={key} className="block space-y-1.5 text-xs">
        <span className="flex items-center justify-between gap-2">
          <span>{fieldNames[key]}</span>
          <span className="flex items-center gap-2 text-[10px] text-muted">
            {!profileEditor && source && `来自 ${source}`}
            {!profileEditor && own && !inherit.has(key) && (
              <button
                type="button"
                onClick={() => {
                  setValues((previous) => ({
                    ...previous,
                    [key]: selectedProfile?.config[key] ?? parent.config[key] ?? '',
                  }));
                  setInherit((previous) =>
                    new Set(previous).add(key),
                  );
                }}
                className="underline underline-offset-2"
              >
                恢复继承
              </button>
            )}
          </span>
        </span>
        {key === 'kubeConnectionId' ? (
          <KubernetesConnections value={values.kubeConnectionId === '__new__' ? '' : values.kubeConnectionId ?? ''} onChange={(id, connection) => { update(key, id || '__new__'); if (connection) update('namespace', connection.namespace); }} />
        ) : key === 'runtime' ? (
          <SelectField
            aria-label={fieldNames[key]}
            value={values.runtime==='linux-user'?'ssh':values.runtime}
            onValueChange={(value) => update(key, value)}
            options={[
              { value: 'ssh', label: 'SSH 主机' },
              { value: 'docker', label: 'Docker 容器' },
              { value: 'kubernetes', label: 'Kubernetes Pod' },

            ]}
            className="w-full"
          />
        ) : key === 'source' || key === 'storage' ? (
          <SelectField aria-label={fieldNames[key]} value={values[key] ?? (key === 'source' ? 'auto' : 'persistent')} onValueChange={(value) => update(key, value)} options={key === 'source' ? [{value:'auto',label:'自动 · 优先本地仓库'}, {value:'local',label:'使用本地仓库'}, {value:'remote',label:'克隆远程仓库'}] : [{value:'persistent',label:'持久化 · 销毁 Workspace 后保留数据'}, {value:'ephemeral',label:'临时 · 销毁时数据随实例移除'}]} className="w-full" />
        ) : key === 'serverId' ? (
          <SelectField
            aria-label={fieldNames[key]}
            value={values.serverId}
            onValueChange={(value) => update(key, value)}
            options={[
              { value: '', label: '选择 SSH 连接' },
              ...data.settings.servers.map((server) => ({
                value: server.id,
                label: server.name,
              })),
            ]}
            className="w-full"
          />
        ) : key === 'workRoot' ? (
          <div className="flex items-center gap-2">
            {editingRoot ? <input aria-label={fieldNames[key]} autoFocus value={values.workRoot ?? ''} onChange={event => update(key, event.target.value)} placeholder={values.directory || workspaceDefaultRoot(values.runtime)} className={inputClass} />
              : <output aria-label={fieldNames[key]} className="min-w-0 flex-1 break-all rounded-lg bg-[var(--surface)] px-2.5 py-2 font-mono text-xs">{values.workRoot || values.directory || workspaceDefaultRoot(values.runtime)}</output>}
            <button type="button" aria-label={editingRoot ? '完成工作根目录编辑' : '编辑持久化工作根目录'} title={editingRoot ? '完成编辑' : '编辑'} disabled={busy} onClick={() => setEditingRoot(value => !value)} className="shrink-0 rounded-md p-2 text-muted hover:bg-[var(--surface)]">{editingRoot ? '完成' : <Pencil size={14} />}</button>
            {(editingRoot || values.workRoot) && <button type="button" aria-label="恢复默认工作根目录" title="恢复默认" disabled={busy} onClick={() => { update('workRoot', ''); setEditingRoot(false); }} className="shrink-0 rounded-md p-2 text-muted hover:bg-[var(--surface)]"><RotateCcw size={14} /></button>}
          </div>
        ) : key === 'prTarget' ? (
          <div className="space-y-1.5">
            <input aria-label={fieldNames[key]} value={values.prTarget || values.ref} onChange={event => update(key, event.target.value === values.ref ? '' : event.target.value)} placeholder="自动采用仓库默认分支" className={inputClass} />
            {values.prTarget && <button type="button" onClick={() => update('prTarget', '')} className="text-[10px] text-muted underline underline-offset-2">跟随基准分支</button>}
          </div>
        ) : key === 'agentCommand' ? (
          <textarea
            aria-label={fieldNames[key]}
            value={values[key] ?? ''}
            onChange={(event) => update(key, event.target.value)}
            rows={2}
            placeholder="已安装的 ACP Agent 命令，创建时可再次调整"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 font-mono text-xs outline-none"
          />
        ) : (
          <input
            aria-label={fieldNames[key]}
            value={values[key] ?? ''}
            onChange={(event) => update(key, event.target.value)}
            className={inputClass}
            placeholder={
              key === 'runUser' ? values.runtime === 'kubernetes' ? '1000' : '1000:1000'
                : key === 'cpuLimit' ? '2' : key === 'memoryLimit' ? '2Gi' : key === 'pidsLimit' ? '256'
                : key === 'repository'
                ? 'https://github.com/org/repo.git 或 git@github.com:org/repo.git'
                : key === 'directory'
                  ? '/workspace（留空使用环境默认目录）'
                  : key === 'secretRef'
                    ? values.runtime === 'kubernetes'
                      ? '已存在的 Kubernetes Secret 名称'
                      : '远端 .env 文件的绝对路径'
                    : undefined
            }
          />
        )}
        {key === 'runtime' && ['ssh','linux-user'].includes(values.runtime) && <details><summary className="text-xs text-muted">执行身份</summary><label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={values.runtime==='linux-user'} onChange={e=>update('runtime',e.target.checked?'linux-user':'ssh')}/>创建独立 Linux 用户</label></details>}
        {key === 'runtime' && values.runtime === 'kubernetes' && <SelectField aria-label="Kubernetes 连接方式" value={values.kubeConnectionId ? 'direct' : 'ssh'}
          onValueChange={(value) => update('kubeConnectionId', value === 'direct' ? '__new__' : '')}
          options={[{ value: 'direct', label: '直接连接 Kubernetes API' }, { value: 'ssh', label: '通过 SSH 主机上的 kubectl' }]} className="w-full" />}
        {key === 'serverId' && (
          <span className="block text-[10px] leading-4 text-muted">
            SSH 连接在应用设置中管理。Docker 或 kubectl 在所选主机上执行。
          </span>
        )}
        {key === 'secretRef' && (
          <span className="block text-[10px] leading-4 text-muted">
            环境通过引用读取 Git／Agent 凭据，例如
            GITHUB_TOKEN。配置中保存引用。
          </span>
        )}
      </div>
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        title={manageProfile ? manageProfile === 'new' ? '创建 Workspace 模板' : '编辑 Workspace 模板' : 'Workspace 配置'}
        aria-describedby="workspace-config-description"
        className="top-[3dvh] z-[70] flex max-h-[94dvh] w-[min(96vw,680px)] flex-col overflow-hidden p-0 [&>div:first-child]:mb-0 [&>div:first-child]:border-b [&>div:first-child]:border-[var(--border)] [&>div:first-child]:px-5 [&>div:first-child]:py-4"
        overlayClassName="z-[60]"
        data-task-detail-portal
      >
        <p
          id="workspace-config-description"
          className="shrink-0 px-5 pb-3 pt-4 text-xs leading-5 text-muted"
        >
          {manageProfile ? '保存主机、运行方式、仓库与存储配置，创建 Workspace 时应用。' : 'TODO 任务、文本叶子节点和中间层节点均可配置，后代默认继承。'}
        </p>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-4">
          <div hidden={!!manageProfile} className="space-y-2">
            <label className="block text-xs">Workspace 模板</label>
            <SelectField aria-label="Workspace 模板" value={profileChoice} disabled={busy || !!profileEditor} className="w-full"
              options={[
                { value: '__inherit__', label: '跟随父节点的 Workspace 模板' },
                { value: '', label: '仅此节点配置' },
                ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
              ]}
              onValueChange={(value) => {
                setProfileChoice(value); setDeleteProfile(false); setInherit(new Set());
                const selected = profiles.find((profile) => profile.id === value);
                setValues(editableConfig(selected?.config ?? (value === '__inherit__' ? parent.config : initial.config)));
                setEditingRoot(false);
                setMode(selected || value === '__inherit__' ? 'inherit' : 'override');
              }} />
            <div className="flex gap-3 text-[11px] text-muted">
              <button type="button" disabled={!user || busy} onClick={() => editShared('new')} className="min-h-7 underline underline-offset-2 disabled:opacity-40">创建 Workspace 模板</button>
              {selectedProfile && <button type="button" disabled={!user || busy} onClick={() => editShared('edit')} className="min-h-7 underline underline-offset-2">编辑此 Workspace 模板</button>}
            </div>
            {profileChoice === '__inherit__' && initial.workspaceId && <p className="text-[10px] text-muted">当前继承 {profiles.find((profile) => profile.id === initial.workspaceId)?.name ?? '父节点 Workspace 模板'}</p>}
          </div>
          {profileEditor && <div className="space-y-3 rounded-lg border border-[var(--border)] p-3">
            <label className="block space-y-1.5 text-xs"><span>Workspace 模板名称</span><input aria-label="Workspace 模板名称" value={profileName} onChange={(event) => setProfileName(event.target.value)} required maxLength={100} className={inputClass} /></label>
            <p className="text-[10px] leading-5 text-muted">{profileEditor === 'edit' ? '保存后，所有引用此 Workspace 模板的节点都会采用这组配置。已创建的环境保留原配置。' : '保存为独立配置，其他任务也可以选择这个 Workspace 模板。'}</p>
            {!manageProfile && <button type="button" className="text-[11px] text-muted underline" onClick={cancelShared}>取消编辑共享配置</button>}
          </div>}
          {!manageProfile && <SelectField
            aria-label="Workspace 继承方式"
            value={mode}
            disabled={!!profileEditor || busy}
            onValueChange={(value) => setMode(value as typeof mode)}
            options={[
              { value: 'inherit', label: '继承父节点' },
              { value: 'override', label: '本节点覆盖' },
              { value: 'disabled', label: '停用此分支 Workspace 配置' },
            ]}
            className="w-full"
          />}
          {mode === 'override' && fieldGroups.map(group => {
            const content = <div className="space-y-3">{group.fields.filter(key => fields.includes(key)).map(renderField)}</div>;
            return group.advanced ? <details key={group.title} className="rounded-xl border border-[var(--border)] p-4"><summary className="cursor-pointer text-xs font-medium">{group.title}</summary><div className="mt-3">{content}</div></details>
              : <fieldset key={group.title} className="rounded-xl border border-[var(--border)] p-4"><legend className="px-1 text-xs font-medium">{group.title}</legend>{content}</fieldset>;
          })}
          {profileEditor === 'edit' && selectedProfile && <div className="space-y-2">
            {deleteProfile && <p className="text-xs text-muted">确认删除此共享配置？正在被节点引用的 Workspace 模板需要先解除绑定。</p>}
            <button type="button" disabled={busy} className="min-h-7 text-[11px] text-[var(--danger)]" onClick={() => {
              if (!deleteProfile) { setDeleteProfile(true); return; }
              setBusy(true); setError('');
              void agentWorkspaceApi.deleteProfile(selectedProfile.id).then(() => {
                if (!active()) return;
                if (manageProfile) { onClose(); return; }
                setProfiles((values) => values.filter((profile) => profile.id !== selectedProfile.id));
                setProfileChoice('__inherit__'); setProfileEditor(null); setDeleteProfile(false);
              }).catch((reason) => { if (active()) setError(reason instanceof Error ? reason.message : '删除失败'); }).finally(() => { if (active()) setBusy(false); });
            }}>{deleteProfile ? '确认删除 Workspace 模板' : '删除此 Workspace 模板'}</button>
          </div>}
          {error && (
            <p role="alert" className="text-xs text-[var(--danger)]">
              {error}
            </p>
          )}
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? '正在保存…' : '保存配置'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
