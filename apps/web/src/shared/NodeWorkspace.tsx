import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  LoaderCircle,
  Plus,
  RefreshCw,
  Send,
  Terminal,
} from 'lucide-react';
import { Button, Dialog, DialogContent, SelectField } from '@nexus/ui';
import {
  resolveWorkspace,
  workspaceChoices,
  newUuid,
  validateWorkspaceConfig,
  type WorkspaceEnvironment,
  type WorkspaceInstruction,
  type WorkspacePane,
} from '@nexus/core';
import { api, currentStore, useNexus, useNexusData } from '@nexus/crdt';
import { useAuth } from '@/app/auth';
import { AgentConversation } from './AgentConversation';
import {WorkspaceBindings} from './WorkspaceBindings';
import { WorkspaceConfiguration } from './WorkspaceConfiguration';
import { WorkspaceAgentCreate } from './WorkspaceAgentCreate';
import { agentWorkspaceApi, type WorkspaceAgentView, type WorkspaceProfileView } from './agentWorkspaceApi';

const WorkspaceTerminal = lazy(() => import('./WorkspaceTerminal'));

const environmentLabels: Record<WorkspaceEnvironment['state'], string> = {
  queued: '排队中',
  preparing: '准备中',
  ready: '可用',
  failed: '准备失败',
  unknown: '需要核对',
  stopped: '已销毁 / 解除关联',
  paused: '已停止 · 数据保留',
};
const instructionLabels: Record<WorkspaceInstruction['state'], string> = {
  queued: '排队中',
  sending: '正在投递',
  delivered: '已投递',
  failed: '投递失败',
  unknown: '投递结果待核对',
};
const runtimeLabels = {
  ssh: 'SSH',
  'linux-user': '独立 Linux 用户',
  docker: 'Docker',
  kubernetes: 'Kubernetes Pod',
};
export function NodeWorkspace({
  taskId,
  beforeAction,
}: {
  taskId: string;
  beforeAction: () => Promise<void>;
}) {
  const store = useNexus(),
    data = useNexusData(),
    { user } = useAuth();
  const resolved = resolveWorkspace(data, taskId);
  const task = data.tasks.find((value) => value.id === taskId);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTemplateOpen, setCreateTemplateOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<WorkspaceProfileView | null>(null);
  const [profiles, setProfiles] = useState<WorkspaceProfileView[]>(() => (data.workspaceProfiles ?? []).filter(profile => !profile.deletedAt));
  const templateChoices = workspaceChoices(data, taskId, profiles, []);
  const [createdAgent, setCreatedAgent] = useState<WorkspaceAgentView | null>(null);
  const [hasAgents, setHasAgents] = useState(false), [terminalToolsOpen, setTerminalToolsOpen] = useState(false);
  const [environments, setEnvironments] = useState<WorkspaceEnvironment[]>([]);
  const [instructions, setInstructions] = useState<WorkspaceInstruction[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [panes, setPanes] = useState<WorkspacePane[]>([]),
    [paneId, setPaneId] = useState('');
  const [resources, setResources] = useState<
      { id: string; name: string; image?: string }[] | null
    >(null),
    [resourceId, setResourceId] = useState('');
  const [prompt, setPrompt] = useState(''),
    [includeNode, setIncludeNode] = useState(false),
    [submit, setSubmit] = useState(true),
    [terminalInput, setTerminalInput] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [outputOpen, setOutputOpen] = useState(false),
    [output, setOutput] = useState('');
  const [ending, setEnding] = useState<WorkspaceEnvironment | null>(null);
  const live = useRef(true);
  const environmentRequest = useRef<{ body: string; id: string }>();
  const instructionRequest = useRef<{ body: string; id: string }>();
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const active = () => live.current && currentStore() === store;
  useEffect(() => {
    if (!user || createTemplateOpen || editingTemplate) return;
    let cancelled = false;
    void agentWorkspaceApi.profiles().then(values => { if (!cancelled && active()) setProfiles(values); }).catch(reason => {
      if (!cancelled && active()) setError(reason instanceof Error ? reason.message : 'Workspace 模板读取失败');
    });
    return () => { cancelled = true; };
  }, [store, taskId, user?.id, createTemplateOpen, editingTemplate]);
  const [explicitBindings,setExplicitBindings]=useState<{environmentId:string}[]>([]);
  const refreshBindings=()=>void agentWorkspaceApi.bindings(taskId).then(rows=>{if(active())setExplicitBindings(rows);}).catch(()=>{});
  useEffect(()=>{refreshBindings();},[taskId,store]);
  const associated = new Set(data.workspaces.filter(binding => resolved.path.includes(binding.id)).map(binding => binding.environmentId));
  for(const binding of explicitBindings)associated.add(binding.environmentId);
  const relatedEnvironments = (values: WorkspaceEnvironment[]) => values.filter(value => !value.archivedAt && value.state !== 'stopped' && (resolved.path.includes(value.taskId) || associated.has(value.id)))
    .sort((a, b) => resolved.path.indexOf(b.taskId) - resolved.path.indexOf(a.taskId));
  const availableEnvironments = relatedEnvironments(environments);
  const environment = environments.find((value) => value.id === selectedId);
  const dataUnavailable = !!(environment?.dataClearedAt || environment?.dataDeletedAt);
  const pane = panes.find((value) => value.id === paneId);
  const config = resolved.config;
  const resolutionKey = JSON.stringify({
    config,
    disabled: resolved.disabled,
    workspaceId: resolved.workspaceId,
    environmentId: resolved.environmentId,
    environmentSource: resolved.environmentSource,
  });
  const resolutionRef = useRef(resolutionKey);
  resolutionRef.current = resolutionKey;
  let configError = '';
  try {
    validateWorkspaceConfig(config);
  } catch (reason) {
    configError =
      reason instanceof Error ? reason.message : '请完成 Workspace 配置';
  }
  const canAccess =
    !!user &&
    !resolved.disabled &&
    !!task &&
    task?.deletedAt == null &&
    task?.status !== 'archived';
  const canExecute = canAccess && !configError;
  const legacy = data.links.filter(
    (link) =>
      link.type === 'tmux' &&
      link.serverId &&
      link.session &&
      !link.deletedAt &&
      resolved.path.includes(link.taskId),
  );

  const refresh = async () => {
    if (!user) return;
    const [response, allEnvironments] = await Promise.all([
      api.workspace(taskId), agentWorkspaceApi.environments(),
    ]);
    if (!active() || resolutionRef.current !== resolutionKey) return;
    const values = [...new Map([...allEnvironments, ...response.data.environments].map(value => [value.id, value])).values()];
    if (
      resolved.environmentId &&
      !values.some((value) => value.id === resolved.environmentId)
    ) {
      try {
        const bound = await api.workspaceEnvironment(resolved.environmentId);
        if (!active() || resolutionRef.current !== resolutionKey) return;
        values.unshift(bound.data);
      } catch {
        /* A removed environment is shown as an unbound selection. */
      }
    }
    if (!active() || resolutionRef.current !== resolutionKey) return;
    setEnvironments(values);
    setInstructions(response.data.instructions);
    setSelectedId(previous => values.some(value => value.id === previous && value.state !== 'stopped' && !value.archivedAt)
      ? previous : relatedEnvironments(values)[0]?.id ?? '');
  };
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const update = () => {
      if (!cancelled)
        void refresh().catch((reason) => {
          if (!cancelled && active() && resolutionRef.current === resolutionKey)
            setError(reason instanceof Error ? reason.message : 'Workspace 读取失败');
        });
    };
    update();
    const timer = setInterval(update, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    user?.id,
    taskId,
    resolved.environmentId,
    resolved.environmentSource,
    resolutionKey,
  ]);

  const refreshPanes = async (id = selectedId) => {
    if (!id) return;
    const response = await api.workspacePanes(id);
    if (
      !active() ||
      selectedRef.current !== id ||
      resolutionRef.current !== resolutionKey
    )
      return;
    setPanes(response.data);
    setPaneId((previous) =>
      response.data.some((value) => value.id === previous)
        ? previous
        : (response.data.find(
            (value) =>
              !value.dead &&
              !['bash', 'zsh', 'sh', 'fish', 'dash', 'ash'].includes(
                value.command,
              ),
          )?.id ??
          response.data.find((value) => !value.dead)?.id ??
          ''),
    );
  };
  useEffect(() => {
    setPanes([]);
    setPaneId('');
    setOutput('');
    if (!environment || environment.state !== 'ready') return;
    void refreshPanes(environment.id).catch((reason) => {
      if (active() && selectedRef.current === environment.id)
        setError(reason instanceof Error ? reason.message : '会话读取失败');
    });
  }, [selectedId, environment?.state]);
  useEffect(() => {
    if (!outputOpen || !paneId || !selectedId || environment?.state !== 'ready')
      return;
    let cancelled = false;
    const update = async () => {
      try {
        const response = await api.workspaceOutput(selectedId, paneId);
        if (!cancelled && active()) setOutput(response.data);
      } catch (reason) {
        if (!cancelled && active())
          setError(reason instanceof Error ? reason.message : '输出读取失败');
      }
    };
    void update();
    const timer = setInterval(() => void update(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [outputOpen, selectedId, paneId, environment?.state]);

  const act = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await beforeAction();
      if (active() && resolutionRef.current === resolutionKey)
        await operation();
    } catch (reason) {
      if (active())
        setError(
          reason instanceof Error ? reason.message : 'Workspace 操作失败',
        );
    } finally {
      if (active()) setBusy(false);
    }
  };
  const choose = (id: string) => {
    setSelectedId(id === '__inherit__' ? '' : id);
    store.setWorkspace(taskId, {
      environmentId: id === '__inherit__' ? undefined : id || null,
    });
    void store.flushPersistence().catch(() => {
      if (active()) setError('Workspace 选择已应用，本地保存失败，请保持页面打开');
    });
  };
  const create = async (existing?: string, selectedConfig = config) => {
    const body = JSON.stringify({ config: selectedConfig, existing });
    if (environmentRequest.current?.body !== body)
      environmentRequest.current = { body, id: newUuid() };
    const response = await api.createWorkspaceEnvironment(
      taskId,
      selectedConfig,
      environmentRequest.current.id,
      existing,
    );
    if (!active() || resolutionRef.current !== resolutionKey) return;
    environmentRequest.current = undefined;
    setEnvironments((previous) => [
      response.data,
      ...previous.filter((value) => value.id !== response.data.id),
    ]);
    choose(response.data.id);
    setResources(null);
    setMessage(existing ? '已关联现有 Workspace' : 'Workspace 正在准备，可以继续编辑节点');
  };
  const discover = () =>
    act(async () => {
      const response = await api.workspaceResources(taskId, config);
      if (active() && resolutionRef.current === resolutionKey) {
        setResources(response.data);
        setResourceId(response.data[0]?.id ?? '');
      }
    });
  const send = () =>
    act(async () => {
      if (!pane || !environment) return;
      const draft = prompt,
        currentTask = store
          .getData()
          .tasks.find((value) => value.id === taskId);
      const text = includeNode
        ? `${draft}\n\n当前节点\n${currentTask?.title ?? ''}\n${currentTask?.notes ?? ''}`
        : draft;
      const value = {
        environmentId: environment.id,
        pane,
        text,
        submit,
        terminalInput,
      };
      const body = JSON.stringify(value);
      if (instructionRequest.current?.body !== body)
        instructionRequest.current = { body, id: newUuid() };
      const response = await api.sendWorkspaceInstruction(taskId, {
        ...value,
        requestId: instructionRequest.current.id,
      });
      if (!active()) return;
      instructionRequest.current = undefined;
      setInstructions((previous) => [
        response.data,
        ...previous.filter((item) => item.id !== response.data.id),
      ]);
      setPrompt((previous) => (previous === draft ? '' : previous));
      setMessage('指令已进入投递队列');
    });
  const stop = (value: WorkspaceEnvironment) =>
    act(async () => {
      const destroyed = await agentWorkspaceApi.destroyEnvironment(value.id);
      const response = { data: destroyed };
      if (!active()) return;
      setEnvironments((previous) =>
        previous.map((item) => (item.id === value.id ? response.data : item)),
      );
      if (selectedRef.current === value.id) choose('');
      setEnding(null);
      if (!value.managed) setMessage('已解除当前节点的 Workspace 关联');
    });

  return (
    <section
      aria-label="执行 Workspace"
      data-node-workspace
      className="mb-5 space-y-3 border-t border-[var(--border)] pt-4 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 font-medium">
          <Terminal size={14} />
          <span>Workspace</span>
          {resolved.disabled && <span className="text-[10px] font-normal text-muted">此分支已停用</span>}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!user || busy} onClick={() => setCreateTemplateOpen(true)}><Plus size={12} />创建 Workspace 模板</Button>
        <Button type="button" size="sm" variant="outline" disabled={!user || busy || resolved.disabled} onClick={() => setCreateOpen(true)}><Plus size={12} />创建 Workspace</Button>
      </div>
      <details className="rounded-lg border border-[var(--border)] px-3 py-2" aria-label="可用 Workspace 模板">
        <summary className="cursor-pointer text-[11px] text-muted">可用 Workspace 模板 · {templateChoices.profiles.filter(item => item.sourceId).length}</summary>
        <div className="mt-2 space-y-1">
          {templateChoices.profiles.filter(item => item.sourceId).map(({ value, sourceId }) => <button key={value.id} type="button" disabled={busy} onClick={() => setEditingTemplate(value)} className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left hover:bg-[var(--surface)]">
            <span className="min-w-0"><span className="block truncate">{value.name}</span><span className="block truncate text-[10px] text-muted">{templateChoices.source(sourceId)} · {runtimeLabels[value.config.runtime]}</span></span><span className="shrink-0 text-[11px] text-muted">编辑</span>
          </button>)}
          {!templateChoices.profiles.some(item => item.sourceId) && <p className="py-1 text-[11px] text-muted">暂无可用模板</p>}
        </div>
      </details>
      <section aria-label="已创建 Workspace" className="space-y-2">
        {availableEnvironments.length > 0 && <h3 className="text-[11px] text-muted">已创建 Workspace</h3>}
        {availableEnvironments.map(value => <button key={value.id} type="button" aria-pressed={selectedId === value.id}
          disabled={busy} onClick={() => { setSelectedId(value.id); setError(''); setMessage(''); }}
          className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left ${selectedId === value.id ? 'border-[var(--border-strong)] bg-[var(--surface)]' : 'border-[var(--border)] hover:bg-[var(--surface)]'}`}>
          <span className="min-w-0"><span className="block truncate">{value.name || value.session || value.id.slice(0, 8)}</span>
            {value.taskId !== taskId && <span className="block truncate text-[10px] text-muted">{data.tasks.find(task => task.id === value.taskId)?.title ?? '关联节点'}</span>}
          </span><span className="shrink-0 text-[10px] text-muted">{environmentLabels[value.state]}</span>
        </button>)}
        {!availableEnvironments.length && <p className="py-1 text-[11px] text-muted">暂无 Workspace</p>}
      </section>
      {!resolved.configured && legacy.length > 0 && (
        <div className="space-y-1">
          {legacy.map((link) => (
            <button
              key={link.id}
              type="button"
              disabled={busy}
              onClick={() => {
                store.setWorkspace(taskId, {
                  mode: 'override',
                  runtime: 'ssh',
                  serverId: link.serverId,
                  session: link.session,
                });
                setMessage('已从关联会话建立配置，可使用已有 Workspace');
              }}
              className="block text-left text-[11px] text-[var(--accent-solid)]"
            >
              使用已关联的 tmux 配置 · {link.session}
            </button>
          ))}
        </div>
      )}
      {resolved.configured && !resolved.disabled && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canExecute || busy}
              onClick={() => void discover()}
            >
              使用已有 Workspace
            </Button>

          </div>
          {!user && (
            <p className="text-[10px] text-muted">
              登录后可连接控制主机并使用 Workspace。
            </p>
          )}
          {configError && (
            <p className="text-[10px] text-muted">{configError}</p>
          )}
        </>
      )}
      {resources && (
        <div className="space-y-2 rounded-lg border border-[var(--border)] p-2.5">
          <SelectField
            aria-label="选择已有 Workspace"
            value={resourceId}
            onValueChange={setResourceId}
            options={
              resources.length
                ? resources.map((value) => ({
                    value: value.id,
                    label: `${value.name}${value.image ? ` · ${value.image}` : ''}`,
                  }))
                : [{ value: '', label: '没有找到可用 Workspace' }]
            }
            className="w-full"
          />
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setResources(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canExecute || !resourceId || busy}
              onClick={() => void act(() => create(resourceId))}
            >
              关联此 Workspace
            </Button>
          </div>
        </div>
      )}
      {environment && (
        <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              {['queued', 'preparing'].includes(environment.state) && (
                <LoaderCircle size={12} className="animate-spin" />
              )}
              {environmentLabels[environment.state]} ·{' '}
              {runtimeLabels[environment.config.runtime]}
            </span>
            <div className="flex flex-wrap gap-2">
              {environment.managed && !dataUnavailable && ['ready', 'paused'].includes(environment.state) && <button type="button" disabled={busy} onClick={() => void act(async () => { const value = await agentWorkspaceApi.environmentAction(environment.id, environment.state === 'paused' ? 'resume' : 'stop'); if (active()) setEnvironments((previous) => previous.map((item) => item.id === value.id ? value : item)); })} className="text-muted hover:text-foreground">{environment.state === 'paused' ? '恢复' : '停止'}</button>}
              {!dataUnavailable && ['unknown', 'failed'].includes(environment.state) && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const value = await api.workspaceEnvironmentAction(
                          environment.id,
                          'check',
                        );
                        if (active())
                          setEnvironments((previous) =>
                            previous.map((item) =>
                              item.id === value.data.id ? value.data : item,
                            ),
                          );
                      })
                    }
                    className="text-muted hover:text-foreground"
                  >
                    检查
                  </button>
                  {environment.managed && !dataUnavailable && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api.workspaceEnvironmentAction(
                            environment.id,
                            'retry',
                          );
                          await refresh();
                        })
                      }
                      className="text-muted hover:text-foreground"
                    >
                      重新准备
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                disabled={busy || dataUnavailable || environment.state === 'preparing'}
                onClick={() =>
                  environment.managed
                    ? setEnding(environment)
                    : void stop(environment)
                }
                className="text-muted hover:text-[var(--danger)]"
              >
                {environment.managed ? '销毁实例' : '解除关联'}
              </button>
            </div>
          </div>
          {dataUnavailable && <p className="text-[11px] leading-5 text-[var(--danger)]">此 Workspace 的数据已移除，不能恢复或新建 Agent。请在 Workspace 管理中完成资源清理，或选择其他 Workspace。</p>}
          {environment.directory && (
            <p className="break-all text-[10px] text-muted">
              {environment.directory}
            </p>
          )}
          {environment.error && (
            <p
              role="alert"
              className="break-words text-[11px] text-[var(--danger)]"
            >
              {environment.error}
            </p>
          )}
          {environment.log && environment.state !== 'ready' && (
            <details>
              <summary className="cursor-pointer text-muted">准备日志</summary>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-[10px]">
                {environment.log}
              </pre>
            </details>
          )}
          {!dataUnavailable && environment.state === 'ready' && hasAgents && <button type="button" onClick={() => setTerminalToolsOpen((value) => !value)} className="flex min-h-7 items-center gap-1 text-[11px] text-muted"><Terminal size={12} />{terminalToolsOpen ? '收起终端工具' : '终端工具'}</button>}
          {!dataUnavailable && environment.state === 'ready' && (!hasAgents || terminalToolsOpen) && (
            <>
              <div className="flex items-center gap-1">
                <SelectField
                  aria-label="目标 Agent 或 tmux pane"
                  value={paneId}
                  onValueChange={setPaneId}
                  options={
                    panes.length
                      ? panes.map((value) => ({
                          value: value.id,
                          label: `${value.session} / ${value.window} / ${value.id} · ${value.command}${value.dead ? '（已退出）' : ''}`,
                          disabled: value.dead,
                        }))
                      : [{ value: '', label: '暂无可用 pane' }]
                  }
                  className="min-w-0 flex-1"
                />
                <button
                  type="button"
                  aria-label="刷新 tmux panes"
                  disabled={busy}
                  onClick={() => void act(() => refreshPanes())}
                  className="grid h-9 w-8 shrink-0 place-items-center text-muted"
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              {pane && <button type="button" onClick={() => setTerminalOpen(true)} className="flex min-h-7 items-center gap-1 text-[11px] text-muted"><Terminal size={12} />打开完整终端</button>}
              {pane && (
                <p className="break-all text-[10px] text-muted">
                  {pane.command} · {pane.directory}
                </p>
              )}
            </>
          )}
        </div>
      )}

      <WorkspaceBindings key={`${store.userId}:${taskId}`} taskId={taskId} onChange={refreshBindings}/>
      <AgentConversation allowCreate={!resolved.disabled && !dataUnavailable} taskId={taskId} workspaceId={resolved.workspaceId} config={config} environment={environment} beforeAction={beforeAction} createdAgent={createdAgent} onAgentsCount={(count) => setHasAgents(count > 0)} onEnvironmentCreated={(value) => { setEnvironments((previous) => [value, ...previous.filter((item) => item.id !== value.id)]); }} />
      {!dataUnavailable && environment?.state === 'ready' && (!hasAgents || terminalToolsOpen) && (
        <div className="space-y-2">
          <textarea
            aria-label="发送给 Agent 的指令"
            rows={4}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="输入要发布给所选 Agent／pane 的指令…"
            className="w-full resize-y rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-2 text-xs leading-5 outline-none focus:border-[var(--accent-solid)]"
          />
          <div className="flex flex-wrap gap-x-3 gap-y-2 text-[10px] text-muted">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={includeNode}
                onChange={(event) => setIncludeNode(event.target.checked)}
              />
              附带当前节点内容
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={submit}
                onChange={(event) => setSubmit(event.target.checked)}
              />
              按 Enter 提交
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={terminalInput}
                onChange={(event) => {
                  setTerminalInput(event.target.checked);
                  if (event.target.checked) setSubmit(false);
                }}
              />
              终端输入模式
            </label>
          </div>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={!pane}
              onClick={() => setOutputOpen((value) => !value)}
              className="flex min-h-8 items-center gap-1 text-[11px] text-muted"
            >
              <ChevronDown size={12} />
              {outputOpen ? '收起输出' : '查看输出'}
            </button>
            <Button
              type="button"
              size="sm"
              disabled={!canAccess || dataUnavailable || busy || !pane || !prompt.trim()}
              onClick={() => void send()}
            >
              <Send size={12} />
              发送{terminalInput ? '终端输入' : '给 Agent'}
            </Button>
          </div>
          {outputOpen && (
            <pre
              aria-label="目标 pane 输出"
              className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--surface)] p-3 font-mono text-[10px] leading-4"
            >
              {output || '等待目标输出…'}
            </pre>
          )}
        </div>
      )}
      {busy && (
        <p role="status" className="text-[10px] text-muted">
          正在处理…
        </p>
      )}
      {message && (
        <p
          role="status"
          className="flex items-center gap-1 text-[10px] text-muted"
        >
          <Check size={11} />
          {message}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="break-words text-[11px] text-[var(--danger)]"
        >
          {error}
        </p>
      )}
      {instructions.length > 0 && (
        <details>
          <summary className="flex cursor-pointer items-center gap-1 text-[11px] text-muted">
            <Bot size={12} />
            指令记录 · {instructions.length}
          </summary>
          <ul aria-label="Workspace 指令记录" className="mt-2 space-y-2">
            {instructions.slice(0, 20).map((value) => (
              <li
                key={value.id}
                className="space-y-1 rounded-lg border border-[var(--border)] p-2.5"
              >
                <div className="flex items-center justify-between gap-2 text-[10px]">
                  <span>
                    {instructionLabels[value.state]} · {value.pane.id}
                  </span>
                  <time className="text-muted">
                    {new Date(value.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                <p className="line-clamp-3 whitespace-pre-wrap break-words text-[11px]">
                  {value.text}
                </p>
                {value.error && (
                  <p className="text-[10px] text-[var(--danger)]">
                    {value.error}
                  </p>
                )}
                {['failed', 'unknown'].includes(value.state) && (
                  <button
                    type="button"
                    onClick={() => {
                      setPrompt(value.text);
                      setIncludeNode(false);
                    }}
                    className="text-[10px] text-muted underline"
                  >
                    填回指令编辑器
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {editingTemplate && <WorkspaceConfiguration taskId={taskId} manageProfile={editingTemplate} onClose={() => setEditingTemplate(null)} />}
      {createTemplateOpen && <WorkspaceConfiguration taskId={taskId} manageProfile="new" onClose={() => setCreateTemplateOpen(false)} />}
      {createOpen && <WorkspaceAgentCreate intent="workspace" taskId={taskId} workspaceId={resolved.workspaceId} config={config} beforeAction={beforeAction}
        onClose={() => setCreateOpen(false)} onCreated={(value, agent) => {
          setEnvironments((previous) => [value, ...previous.filter((item) => item.id !== value.id)]);
          setSelectedId(value.id);
          if (agent) setCreatedAgent(agent);
          setMessage(agent ? 'Workspace 与 Agent 已进入准备队列' : 'Workspace 正在准备');
        }} />}
      {terminalOpen && environment && pane && <Suspense fallback={<p role="status" className="text-xs text-muted">正在打开终端…</p>}><WorkspaceTerminal environmentId={environment.id} pane={pane} onClose={() => setTerminalOpen(false)} /></Suspense>}
      <Dialog
        open={!!ending}
        onOpenChange={(open) => {
          if (!open && !busy) setEnding(null);
        }}
      >
        <DialogContent
          title="销毁 Workspace"
          className="z-[70]"
          overlayClassName="z-[60]"
          aria-describedby="workspace-stop-description"
          data-task-detail-portal
        >
          <p id="workspace-stop-description" className="text-sm leading-6">
            销毁实例后，使用该 Workspace 的 Agent 将失去运行目标。{ending?.config.storage === 'ephemeral' ? '此 Workspace 使用临时存储，实例内数据将一并移除。' : '持久化目录与存储会保留，可在 Workspace 管理中另行删除。'}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setEnding(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={busy || !ending}
              onClick={() => {
                if (ending) void stop(ending);
              }}
            >
              确认销毁
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
