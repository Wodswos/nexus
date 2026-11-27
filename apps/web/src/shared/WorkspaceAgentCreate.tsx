import React, { useEffect, useRef, useState } from 'react';
import { Bot, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button, Dialog, DialogContent, SelectField, Segmented, SegmentedList, SegmentedTrigger, SegmentedContent } from '@nexus/ui';
import { newUuid, DEFAULT_AGENT_PROMPT, AGENT_PRODUCT_PRESETS, validateWorkspaceConfig, renderAgentPrompt, workspaceChoices, workspaceUniqueName, type WorkspaceConfig, type WorkspaceEnvironment, type WorkspacePane } from '@nexus/core';
import { api, apiUrl, currentStore, useNexus, useNexusData } from '@nexus/crdt';
import { WorkspaceConfiguration } from './WorkspaceConfiguration';
import { agentWorkspaceApi, type WorkspaceProfileView, type WorkspaceAgentView } from './agentWorkspaceApi';

const fieldClass = 'w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs outline-none focus:border-[var(--accent-solid)]';
const sectionClass = 'space-y-3 rounded-xl border border-[var(--border)] p-4';

export function WorkspaceAgentCreate({ taskId, workspaceId, config: inheritedConfig, environment: inheritedEnvironment, intent = 'agent', initialProfileId, beforeAction, onCreated, onClose }: {
  taskId: string; workspaceId?: string | null; config: WorkspaceConfig; environment?: WorkspaceEnvironment;
  intent?: 'agent' | 'workspace'; initialProfileId?: string;
  beforeAction: () => Promise<void>; onCreated: (environment: WorkspaceEnvironment, agent?: WorkspaceAgentView) => void; onClose: () => void;
}) {
  const store = useNexus(), data = useNexusData();
  const task = data.tasks.find(row => row.id === taskId);
  const unique = (prefix: string) => workspaceUniqueName(prefix, task?.title ?? '', newUuid());
  const [profiles, setProfiles] = useState<WorkspaceProfileView[]>(() => (data.workspaceProfiles ?? []).filter(profile => !profile.deletedAt));
  const [profileId, setProfileId] = useState(initialProfileId ?? '__inherit__');
  const [environments, setEnvironments] = useState<WorkspaceEnvironment[]>(inheritedEnvironment ? [inheritedEnvironment] : []);
  const usable = (value?: WorkspaceEnvironment) => value && !value.archivedAt && !value.dataClearedAt && !value.dataDeletedAt && ['ready', 'queued', 'preparing'].includes(value.state);
  const [workspaceMode, setWorkspaceMode] = useState<'new' | 'existing'>(intent === 'agent' && usable(inheritedEnvironment) ? 'existing' : 'new');
  const [environmentId, setEnvironmentId] = useState(usable(inheritedEnvironment) ? inheritedEnvironment!.id : '');
  const [boundEnvironments,setBoundEnvironments]=useState<string[]>([]);
  useEffect(()=>{let cancelled=false;void agentWorkspaceApi.bindings(taskId).then(rows=>{if(!cancelled&&currentStore()===store)setBoundEnvironments(rows.map(row=>row.environmentId));}).catch(()=>{});return()=>{cancelled=true;};},[taskId,store]);
  const [showOthers, setShowOthers] = useState(false);
  const choices = workspaceChoices(data, taskId, profiles, environments);
  const chosenProfile = profiles.find(profile => profile.id === profileId);
  const config = chosenProfile?.config ?? inheritedConfig;
  const selectedProfileId = chosenProfile?.id ?? (profileId === '__inherit__' ? workspaceId ?? undefined : undefined);
  const existingEnvironment = workspaceMode === 'new' ? undefined : environments.find(environment => environment.id === environmentId);
  const [workspaceName, setWorkspaceName] = useState(() => unique('workspace'));
  const [workspaceBranch, setWorkspaceBranch] = useState(() => `nexus-agent/${workspaceName}`);
  const hasRepository = !!(config.repository || config.localRepository);
  const [newTemplate, setNewTemplate] = useState(false);
  const [createAgent, setCreateAgent] = useState(true);
  const [name, setName] = useState(() => `Agent · ${(task?.title ?? '任务').slice(0, 24)}`);
  const [productId, setProductId] = useState('codex-native');
  const [mode, setMode] = useState<WorkspaceAgentView['mode']>('codex');
  const [usePane, setUsePane] = useState(false);
  const [command, setCommand] = useState('codex app-server');
  const [directoryMode, setDirectoryMode] = useState<'worktree' | 'custom' | 'isolated'>((inheritedEnvironment?.config.repository||inheritedEnvironment?.config.localRepository||hasRepository)?'worktree':'isolated');
  const [directory, setDirectory] = useState(inheritedEnvironment?.directory||config.directory);
  const [model,setModel]=useState(''),[providerId,setProviderId]=useState(''),[providers,setProviders]=useState<import('@nexus/core').ProviderInstance[]>([]),[createTerminal,setCreateTerminal]=useState(false);
  useEffect(()=>{void agentWorkspaceApi.providers().then(setProviders).catch(()=>{});},[]);
  const [worktreeName, setWorktreeName] = useState(() => unique('task'));
  const [panes, setPanes] = useState<WorkspacePane[]>([]), [paneId, setPaneId] = useState('');
  const [checkMessage, setCheckMessage] = useState(''), [checking, setChecking] = useState(false);
  const renderPrompt = () => renderAgentPrompt(DEFAULT_AGENT_PROMPT, { taskTitle: task?.title ?? '', taskUrl: new URL(apiUrl(`/tasks?focusTask=${encodeURIComponent(taskId)}`), window.location.href).toString(), contextUrl: '{{task_context_url}}' });
  const [prompt, setPrompt] = useState(renderPrompt);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [stage, setStage] = useState('');
  const request = useRef<{ body: string; id: string }>();
  const promptEdited = useRef(false), selectionEdited = useRef(false), initialized = useRef(false), mounted = useRef(true);
  const active = () => mounted.current && currentStore() === store;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!inheritedEnvironment) return;
    setEnvironments(values => [inheritedEnvironment, ...values.filter(value => value.id !== inheritedEnvironment.id)]);
  }, [inheritedEnvironment]);
  useEffect(() => {
    let cancelled = false;
    void agentWorkspaceApi.prompt(taskId).then(result => {
      if (!cancelled && active() && !promptEdited.current) setPrompt(result.prompt);
    }).catch(reason => { if (!cancelled && active()) setError(reason instanceof Error ? reason.message : '默认 Prompt 读取失败'); });
    return () => { cancelled = true; };
  }, [taskId, store]);
  useEffect(() => {
    let cancelled = false;
    setPanes([]); setPaneId('');
    if (usable(existingEnvironment) && existingEnvironment?.state === 'ready') void api.workspacePanes(existingEnvironment.id).then(({ data: values }) => {
      if (cancelled || !active()) return;
      setPanes(values.filter(pane => !pane.dead)); setPaneId(values.find(pane => !pane.dead)?.id ?? '');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [existingEnvironment?.id, existingEnvironment?.state]);
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([agentWorkspaceApi.profiles(), agentWorkspaceApi.environments(),agentWorkspaceApi.bindings(taskId)]).then(([profileResult, environmentResult,bindingResult]) => {
      if (cancelled || !active()) return;
      const availableProfiles = profileResult.status === 'fulfilled' ? profileResult.value : profiles;
      const availableEnvironments = environmentResult.status === 'fulfilled' ? environmentResult.value : environments;
      if (profileResult.status === 'fulfilled') setProfiles(availableProfiles);
      if (environmentResult.status === 'fulfilled') setEnvironments(availableEnvironments);
      if (!initialized.current && !selectionEdited.current) {
        initialized.current = true;
        const candidates = workspaceChoices(data, taskId, availableProfiles, availableEnvironments);
        const preferred = availableEnvironments.find(value => value.id === inheritedEnvironment?.id && usable(value)) ?? (bindingResult.status==='fulfilled'?bindingResult.value.find(value=>usable(value.environment))?.environment:undefined) ?? candidates.environments.find(value => value.sourceId)?.value;
        if (intent === 'agent' && preferred) {
          setEnvironmentId(preferred.id); setWorkspaceMode('existing');
          setDirectoryMode(preferred.config.repository||preferred.config.localRepository?'worktree':'isolated');

        }
        if (!initialProfileId && !data.workspaces.some(binding => binding.id === taskId && (binding.workspaceId !== undefined || binding.mode === 'override'))) {
          const nearest = candidates.profiles.find(value => value.sourceId)?.value;
          if (nearest && nearest.id !== workspaceId) { setProfileId(nearest.id);  }
        }
      }
    });
    return () => { cancelled = true; };
  }, [store, newTemplate]);

  let configError = '';
  if (workspaceMode === 'existing' && !usable(existingEnvironment)) configError = '所选 Workspace 当前不可用，请重新选择';
  if (workspaceMode === 'new') try { validateWorkspaceConfig({ ...config, branch: hasRepository ? workspaceBranch : '', session: '' }); } catch (reason) { configError = reason instanceof Error ? reason.message : '请选择 Workspace 模板'; }
  const chooseProfile = (id: string) => {
    if (id !== '__inherit__' && !profiles.some(profile => profile.id === id)) return;
    selectionEdited.current = true; setProfileId(id); setCheckMessage('');
    const selected = profiles.find(profile => profile.id === id);
    const selectedConfig = selected?.config ?? inheritedConfig;
    if (directoryMode !== 'custom') setDirectoryMode(selectedConfig.repository || selectedConfig.localRepository ? 'worktree' : 'isolated');
    if (productId === 'generic-acp' || productId === 'custom-terminal') setCommand(selected?.config.agentCommand || inheritedConfig.agentCommand);
  };
  const chooseEnvironment = (id: string) => {
    if (!environments.some(environment => environment.id === id)) return;
    selectionEdited.current = true; setEnvironmentId(id); setUsePane(false); setCheckMessage('');
    const selected = environments.find(environment => environment.id === id);
    if(selected)setDirectoryMode(selected.config.repository||selected.config.localRepository?'worktree':'isolated');
    if (productId === 'generic-acp' || productId === 'custom-terminal') setCommand(selected ? profiles.find(profile => profile.id === selected.workspaceId)?.config.agentCommand || selected.config.agentCommand || inheritedConfig.agentCommand : config.agentCommand);
  };
  const check = async () => {
    if (!existingEnvironment || checking) return;
    setChecking(true); setCheckMessage('');
    try { const result = await agentWorkspaceApi.check({ taskId, environmentId: existingEnvironment.id, mode, command, productId, ...(usePane ? { pane: panes.find(pane => pane.id === paneId) } : {}) }); if (active()) setCheckMessage(String(result.message ?? '检测完成')); }
    catch (reason) { if (active()) setCheckMessage(reason instanceof Error ? reason.message : '检测失败'); }
    finally { if (active()) setChecking(false); }
  };
  const worktree = directoryMode === 'worktree',isolated=directoryMode==='isolated';
  const repositoryAvailable = workspaceMode === 'existing' ? !!(existingEnvironment?.config.repository || existingEnvironment?.config.localRepository) : hasRepository;
  const validDirectory = usePane || (worktree || isolated ? (!worktree || repositoryAvailable) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(worktreeName) : !directory || directory.startsWith('/') && !/[\0\r\n]/.test(directory));
  const valid = !configError && (existingEnvironment || (workspaceName.trim() && (!hasRepository || workspaceBranch.trim()))) && (!createAgent || (validDirectory && name.trim() && prompt.trim() && (usePane ? paneId : command.trim())));
  const agentInput = {
    workspaceId: existingEnvironment?.workspaceId ?? selectedProfileId, productId, name: name.trim(), mode,
    command: usePane ? '' : command.trim(), prompt, model:model.trim()||undefined,providerId:providerId||undefined,terminalPolicy:createTerminal?'create' as const:'on-demand' as const,
    worktree: !usePane && worktree, isolatedDirectory:!usePane&&isolated,
    ...(!usePane ? worktree||isolated ? { worktreeName } : { ...(directory.trim()?{ directory: directory.trim() }:{}) } : { pane: panes.find(pane => pane.id === paneId) }),
  };
  const launchInput = { name: workspaceName.trim(), workspaceId: selectedProfileId, config: { ...config, terminalPolicy:'on-demand' as const, branch: hasRepository ? workspaceBranch.trim() : '', session: '', agentCommand: '' }, ...(createAgent ? { agent: agentInput } : {}) };
  const existingInput = { ...agentInput, environmentId };
  const body = JSON.stringify(workspaceMode === 'new' ? launchInput : existingInput);
  if (request.current?.body !== body) request.current = { body, id: newUuid() };
  const requestId = request.current.id;
  const previewInput = JSON.stringify(workspaceMode === 'existing'
    ? { environmentId, worktreeName } : { requestId, config: launchInput.config, worktreeName });
  const [preview, setPreview] = useState<{ key: string; directory?: string; error?: string }>();
  useEffect(() => {
    if (!createAgent || usePane || (!worktree&&!isolated) || configError || !validDirectory) return;
    if (existingEnvironment?.workRoot) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void agentWorkspaceApi.preview(taskId, JSON.parse(previewInput)).then(value => {
        if (!cancelled && active()) setPreview({ key: previewInput, directory: value.directory });
      }).catch(reason => { if (!cancelled && active()) setPreview({ key: previewInput, error: reason instanceof Error ? reason.message : '路径读取失败' }); });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [taskId, store, previewInput, existingEnvironment?.workRoot, createAgent, usePane, worktree, isolated, configError, validDirectory]);
  const create = async () => {
    if (busy || !valid) return;
    setBusy(true); setError('');
    try {
      setStage('保存任务内容'); await beforeAction(); if (!active()) return;
      let environment = existingEnvironment, agent: WorkspaceAgentView | undefined;
      if (!environment) {
        setStage(createAgent ? '创建 Workspace 并启动 Agent' : '创建 Workspace');
        const launched = await agentWorkspaceApi.launch(taskId, { ...launchInput, requestId });
        environment = launched.environment; agent = launched.agent;
      } else {
        setStage(usePane ? '连接 Agent 并发送指令' : '启动 Agent');
        agent = await agentWorkspaceApi.create(taskId, { ...existingInput, requestId });
      }
      if (!active()) return;
      onCreated(environment, agent); onClose();
    } catch (reason) { if (active()) setError(reason instanceof Error ? reason.message : '创建失败'); }
    finally { if (active()) { setBusy(false); setStage(''); } }
  };
  const environmentOptions = choices.environments.filter(item => showOthers || item.sourceId || boundEnvironments.includes(item.value.id) || item.value.id === environmentId);
  const directoryPreview = existingEnvironment?.workRoot ? `${existingEnvironment.workRoot.replace(/\/$/, '')}/nexus-agent/${worktreeName}` : preview?.key === previewInput ? preview.directory : undefined;
  return <><Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent title={intent === 'workspace' ? '创建 Workspace' : '创建 Agent'}
      className="top-[3dvh] z-[70] flex max-h-[94dvh] w-[min(96vw,680px)] flex-col overflow-hidden p-0 [&>div:first-child]:mb-0 [&>div:first-child]:border-b [&>div:first-child]:border-[var(--border)] [&>div:first-child]:px-5 [&>div:first-child]:py-4"
      overlayClassName="z-[60]" aria-describedby={undefined} data-task-detail-portal
      onInteractOutside={event => { if (busy) event.preventDefault(); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={event => { event.preventDefault(); void create(); }}>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <p className="truncate text-xs text-muted">{task?.title}</p>
          <section aria-label="选择 Workspace" className={sectionClass}>
            <h3 className="text-xs font-medium">Workspace</h3>
            <Segmented value={workspaceMode} onValueChange={value => { if (value !== 'new' && value !== 'existing') return; selectionEdited.current = true; setWorkspaceMode(value); setUsePane(false); setCheckMessage(''); }}>
              {intent === 'agent' && <SegmentedList aria-label="Workspace 来源" className="mb-3 grid w-full grid-cols-2">
                <SegmentedTrigger value="new" disabled={busy} className="px-1 text-xs">从模板创建新 Workspace</SegmentedTrigger>
                <SegmentedTrigger value="existing" disabled={busy} className="px-1 text-xs">使用已有 Workspace</SegmentedTrigger>
              </SegmentedList>}
              <SegmentedContent value="existing" className="space-y-3">
                {environmentOptions.length ? <SelectField aria-label="Agent Workspace" value={environmentId} onValueChange={chooseEnvironment} disabled={busy} options={[
                  { value: '', label: '选择已有 Workspace', disabled: true },
                  ...environmentOptions.map(({ value, sourceId }) => ({ value: value.id, label: value.name || value.session || value.id, description: `${choices.source(sourceId ?? value.taskId)} · ${value.state === 'ready' ? '可用' : '准备中'}` })),
                ]} className="w-full" /> : <p className="py-2 text-xs text-muted">暂无可用 Workspace</p>}
                {choices.environments.some(item => !item.sourceId) && <label className="flex items-center gap-2 text-[11px] text-muted"><input type="checkbox" checked={showOthers} onChange={event => setShowOthers(event.target.checked)} />显示其他节点的 Workspace</label>}
              </SegmentedContent>
              <SegmentedContent value="new" className="space-y-3">
              <div className="flex items-center justify-between gap-2 text-xs"><span>Workspace 模板</span><button type="button" disabled={busy} onClick={() => setNewTemplate(true)} className="text-muted hover:text-foreground">+ 创建模板</button></div>
              <SelectField aria-label="Agent Workspace 模板" value={profileId} onValueChange={chooseProfile} disabled={busy} options={[
                { value: '__inherit__', label: '使用任务 / 项目默认配置', description: profiles.find(profile => profile.id === workspaceId)?.name },
                ...choices.profiles.map(({ value, sourceId }) => ({ value: value.id, label: value.name, description: choices.source(sourceId ?? value.taskId) })),
              ]} className="w-full" />
              <label className="block space-y-1.5 text-xs"><span>Workspace 名称</span><input aria-label="Workspace 名称" value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} required maxLength={120} disabled={busy} className={fieldClass} /></label>
              {hasRepository && <label className="block space-y-1.5 text-xs"><span>Workspace 工作分支</span><input aria-label="Workspace 工作分支" value={workspaceBranch} onChange={event => setWorkspaceBranch(event.target.value)} required maxLength={200} disabled={busy} className={`${fieldClass} font-mono`} /></label>}
              </SegmentedContent>
            </Segmented>
            {configError && <p role="alert" className="text-xs text-[var(--danger)]">{configError}</p>}
          </section>
          {intent === 'workspace' && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={createAgent} disabled={busy} onChange={event => setCreateAgent(event.target.checked)} /><Bot size={14} />同时创建并启动 Agent</label>}
          {createAgent && <>
            <fieldset className={sectionClass} aria-label="Agent 工作目录配置">
              <legend className="px-1 text-xs font-medium">工作目录</legend>
              {usePane ? <p className="text-xs text-muted">沿用所选 pane 的工作目录：{panes.find(pane => pane.id === paneId)?.directory || '选择 pane 后显示'}</p> : <>
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
                  <label className="flex items-center gap-2"><input type="radio" name="agent-directory-mode" checked={worktree} disabled={busy||!repositoryAvailable} onChange={() => setDirectoryMode('worktree')} />自动创建 Git worktree</label>
                  <label className="flex items-center gap-2"><input type="radio" name="agent-directory-mode" checked={isolated} disabled={busy} onChange={()=>setDirectoryMode('isolated')}/>创建空目录（不含仓库）</label>
                  <label className="flex items-center gap-2"><input type="radio" name="agent-directory-mode" checked={directoryMode==='custom'} disabled={busy} onChange={() => { setDirectoryMode('custom'); if (!directory) setDirectory(existingEnvironment?.directory || config.directory); }} />使用自定义工作目录</label>
                </div>
                <p className="text-xs leading-5 text-muted">{worktree ? '检出 Workspace 仓库的代码并创建独立分支，共享 Git 历史；适合开发和提交 PR。' : isolated ? '只创建此 Agent 的空目录，不复制仓库、不创建分支；适合资料整理、实验或从零开始。' : '直接使用指定目录中的现有内容；多个 Agent 使用同一路径时会共享文件修改。'}</p>
                {worktree||isolated ? <>
                  <label className="block space-y-1.5 text-xs"><span>{isolated?"目录名称":"Worktree 名称"}</span><div className="flex gap-2"><input aria-label={isolated ? "目录名称" : "Worktree 名称"} value={worktreeName} onChange={event => setWorktreeName(event.target.value)} required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}" maxLength={80} disabled={busy} className={`${fieldClass} min-w-0 flex-1 font-mono`} /><button type="button" aria-label="重新生成 工作目录名称" disabled={busy} onClick={() => setWorktreeName(unique('task'))} className="rounded-md px-2 text-muted hover:bg-[var(--surface)]"><RefreshCw size={14} /></button></div></label>
                  <p className="break-all text-[11px] leading-5 text-muted">路径：{directoryPreview ?? (configError ? '请选择可用 Workspace 或模板' : preview?.key === previewInput && preview.error ? preview.error : '正在读取完整路径…')}<br />{worktree&&<>分支：nexus-agent/{worktreeName}</>}</p>
                </> : <label className="block space-y-1.5 text-xs"><span>自定义工作目录</span><input aria-label="Agent 工作目录" value={directory} onChange={event => setDirectory(event.target.value)} placeholder="默认沿用 Workspace 工作目录" disabled={busy} className={`${fieldClass} font-mono`} /></label>}
              </>}
            </fieldset>
            <section aria-label="Agent 启动配置" className={sectionClass}>
              <h3 className="text-xs font-medium">Agent</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1.5 text-xs"><span>名称</span><input aria-label="Agent 名称" value={name} onChange={event => setName(event.target.value)} maxLength={80} required className={fieldClass} disabled={busy} /></label>
                <div className="space-y-1.5 text-xs"><span>产品</span><SelectField aria-label="Agent 产品" value={productId} disabled={busy} onValueChange={id => { const product = AGENT_PRODUCT_PRESETS.find(value => value.id === id); if (!product) return; setProductId(id); setMode(product.mode); setProviderId(''); setUsePane(false); setCommand(product.command || config.agentCommand); setCheckMessage(''); }} options={AGENT_PRODUCT_PRESETS.filter(product=>!product.legacy).map(product => ({ value: product.id, label: product.name }))} className="w-full" /></div>
              </div>
              {usePane ? <SelectField aria-label="关联 Agent pane" value={paneId} onValueChange={setPaneId} disabled={busy} options={[{ value: '', label: '选择正在运行 Agent 的 pane' }, ...panes.map(pane => ({ value: pane.id, label: `${pane.session} / ${pane.window} / ${pane.id} · ${pane.command}` }))]} className="w-full" /> : <label className="block space-y-1.5 text-xs"><span>{mode === 'acp' ? 'Agent 启动命令（ACP）' : 'Agent 启动命令'}</span><input aria-label={mode === 'acp' ? 'Agent 启动命令（ACP）' : 'Agent 启动命令'} value={command} onChange={event => setCommand(event.target.value)} required maxLength={4096} disabled={busy} className={`${fieldClass} font-mono`} placeholder={mode === 'acp' ? '目标环境中支持 ACP 的命令' : '目标环境中已安装的 Agent CLI'} /></label>}
              <div className="grid gap-3 sm:grid-cols-2"><SelectField aria-label="Provider 配置" value={providerId} onValueChange={setProviderId} options={[{value:'',label:'使用执行用户的产品配置'},...providers.filter(p=>p.harness===mode).map(p=>({value:p.id,label:p.name}))]}/><input aria-label="模型" placeholder="模型（产品默认）" value={model} onChange={e=>setModel(e.target.value)} className={fieldClass}/></div>
              <details><summary className="text-xs text-muted">高级设置</summary><label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" checked={createTerminal} onChange={e=>setCreateTerminal(e.target.checked)}/>同时创建人工终端</label></details>
              {existingEnvironment?.state === 'ready' && <button type="button" disabled={busy || checking || (!usePane && !command.trim())} onClick={() => void check()} className="text-[11px] text-muted underline underline-offset-2">{checking ? '正在检测…' : '检测实际连接能力'}</button>}
              {checkMessage && <p role="status" className="text-xs text-muted">{checkMessage}</p>}
            </section>
            <section className={sectionClass}>
              <details><summary className="cursor-pointer text-xs text-muted">初始 Prompt</summary><textarea aria-label="初始 Prompt" value={prompt} onChange={event => { promptEdited.current = true; setPrompt(event.target.value); }} rows={8} maxLength={24000} disabled={busy} className={`${fieldClass} mt-3 resize-y leading-6`} /></details>
            </section>
          </>}
          {error && <p role="alert" className="text-xs leading-5 text-[var(--danger)]">{error}</p>}
        </div>
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--border)] px-5 py-3">
          <span role="status" className="flex items-center gap-1.5 text-[11px] text-muted">{busy && <><LoaderCircle size={12} className="animate-spin" />{stage}…</>}</span>
          <div className="flex gap-2"><Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={busy}>取消</Button><Button type="submit" size="sm" variant="primary" disabled={busy || !valid}>{!createAgent ? '创建 Workspace' : usePane ? '连接并发送指令' : existingEnvironment ? '创建并启动' : '创建 Workspace 与 Agent'}</Button></div>
        </footer>
      </form>
    </DialogContent>
  </Dialog>{newTemplate && <WorkspaceConfiguration taskId={taskId} manageProfile="new" onSaved={profile => {
    selectionEdited.current = true; setProfiles(values => [profile, ...values.filter(value => value.id !== profile.id)]); setProfileId(profile.id); setWorkspaceMode('new'); setUsePane(false); setMode('codex'); setProductId('codex-native'); setCommand('codex app-server');
  }} onClose={() => setNewTemplate(false)} />}</>;
}
