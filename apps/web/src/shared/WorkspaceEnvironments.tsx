import React, { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogContent } from '@nexus/ui';
import type { WorkspaceEnvironment } from '@nexus/core';
import { currentStore, useNexus } from '@nexus/crdt';
import { agentWorkspaceApi } from './agentWorkspaceApi';

const labels: Record<WorkspaceEnvironment['state'], string> = { queued:'排队中',preparing:'准备中',ready:'运行中',paused:'已停止 · 数据保留',failed:'失败',unknown:'待核对',stopped:'已销毁 / 已解除关联' };
export function WorkspaceEnvironments() {
  const store = useNexus(), live = useRef(true);
  const [values, setValues] = useState<WorkspaceEnvironment[]>([]), [error, setError] = useState('');
  const [archived, setArchived] = useState(false), [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ environment: WorkspaceEnvironment; action: 'destroy' | 'data' } | null>(null);
  const [plan,setPlan]=useState<Awaited<ReturnType<typeof agentWorkspaceApi.cleanupPlan>>>(),[planError,setPlanError]=useState('');
  useEffect(()=>{setPlan(undefined);setPlanError('');if(!confirm)return;let cancelled=false;void agentWorkspaceApi.cleanupPlan(confirm.environment.id).then(value=>{if(!cancelled&&currentStore()===store)setPlan(value);}).catch(e=>{if(!cancelled)setPlanError(e.message);});return()=>{cancelled=true;};},[confirm?.environment.id,confirm?.action,store]);
  const active = () => live.current && currentStore() === store;
  const refresh = async () => { const list = await agentWorkspaceApi.environments(); if (active()) setValues((previous) => list.map((value) => { const prior = previous.find((item) => item.id === value.id); return prior && prior.updatedAt > value.updatedAt ? prior : value; })); };
  useEffect(() => { live.current = true; let timer: ReturnType<typeof setTimeout>; const poll = async () => { try { await refresh(); } catch (reason) { if (active()) setError(String(reason)); } finally { if (active()) timer = setTimeout(() => void poll(), document.hidden ? 10000 : 3000); } }; void poll(); return () => { live.current = false; clearTimeout(timer); }; }, [store]);
  const act = async (operation: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(''); try { await operation(); if (!active()) return; await refresh(); setConfirm(null); } catch (reason) { if (active()) setError(reason instanceof Error ? reason.message : '操作失败'); } finally { if (active()) setBusy(false); } };
  return <section aria-label="Workspace" className="space-y-3">
    <div className="flex items-center justify-between"><h2 className="text-sm font-medium">Workspace</h2><label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />显示已归档</label></div>
    {values.filter((value) => archived || !value.archivedAt).map((value) => <article key={value.id} className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--border)] p-4">
      <div className="flex items-center justify-between gap-3"><p className="min-w-0 truncate text-sm font-medium">{value.name || value.session || value.id}</p><span className="shrink-0 text-micro text-muted">{labels[value.state]}</span></div>
      <p className="break-all text-xs text-muted">{value.config.runtime} · {value.directory || value.workRoot || '默认目录'}{value.branch ? ` · ${value.branch}` : ''}</p>
      {value.dataClearedAt && !value.dataDeletedAt && <p className="text-xs leading-6 text-[var(--danger)]">仓库数据已移除，仍有资源需要清理。此 Workspace 不能恢复或用于新建 Agent，请完成资源清理。</p>}
      <div className="flex flex-wrap gap-1">
        {value.managed && value.state === 'ready' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => agentWorkspaceApi.environmentAction(value.id, 'stop'))}>停止</Button>}
        {value.managed && value.state === 'paused' && !value.dataClearedAt && !value.dataDeletedAt && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => agentWorkspaceApi.environmentAction(value.id, 'resume'))}>恢复</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => agentWorkspaceApi.environmentAction(value.id, 'archive', { archived: !value.archivedAt }))}>{value.archivedAt ? '取消归档' : '归档'}</Button>
        {value.state !== 'stopped' && !value.dataClearedAt && <Button size="sm" variant="ghost" disabled={busy || value.state === 'preparing'} onClick={() => setConfirm({ environment: value, action: 'destroy' })}>{value.managed ? '销毁实例' : '解除关联'}</Button>}
        {value.managed && (value.state === 'stopped' || !!value.dataClearedAt) && !value.dataDeletedAt && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm({ environment: value, action: 'data' })}>{value.dataClearedAt ? '完成资源清理' : '删除保留数据'}</Button>}
      </div>
    </article>)}
    {!values.length && !error && <p className="text-xs leading-6 text-muted">从任务的新建 Agent 入口创建 Workspace，或关联已有 Workspace。</p>}
    {error && <p role="alert" className="text-xs leading-6 text-[var(--danger)]">{error}</p>}
    <Dialog open={!!confirm} onOpenChange={(open) => { if (!open && !busy) setConfirm(null); }}><DialogContent title={confirm?.action === 'data' ? confirm.environment.dataClearedAt ? '完成资源清理' : '删除 Workspace 数据' : confirm?.environment.managed ? '销毁 Workspace' : '解除 Workspace 关联'} aria-describedby="environment-confirm">
      <p id="environment-confirm" className="text-sm leading-7">{confirm?.action === 'data' ? confirm.environment.dataClearedAt ? '仓库数据已经移除。继续清理剩余存储资源与凭据；完成前此 Workspace 不能恢复或复用。' : '此操作永久删除保留的仓库与存储数据。存在未提交或未推送改动时，系统会阻止删除。' : confirm?.environment.managed ? confirm.environment.config.storage === 'ephemeral' ? '停止并销毁实例。此 Workspace 使用临时存储，实例中的数据会一并移除。' : '停止并销毁实例。持久化目录和存储会保留，可以另行删除。使用该环境的 Agent 会失去运行目标。' : '只移除 Nexus 中的关联，不停止远端会话或容器。'}</p>
      <section className="mt-3 space-y-2 rounded-[var(--radius-md)] bg-[var(--surface)] p-3 text-xs"><p>关联 Task：{plan?.taskIds.length??'读取中…'}</p>{(plan?.terminals?.length??0)>0&&<p>同时结束 {plan!.terminals!.length} 个人工终端</p>}{plan?.agents.map(agent=><p key={agent.id}>{agent.name} · {agent.state}</p>)}{plan?.git&&<p>{plan.git.dirty?'存在未提交修改':'没有未提交修改'} · {plan.git.unpushed?'存在未推送提交':'没有未推送提交'}</p>}{(planError||plan?.inspectionError)&&<p role="alert">{planError||plan?.inspectionError}</p>}</section>
      <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>取消</Button><Button variant="danger" disabled={busy||!plan} onClick={() => confirm && void act(() => confirm.action === 'data' ? agentWorkspaceApi.deleteEnvironmentData(confirm.environment.id) : agentWorkspaceApi.destroyEnvironment(confirm.environment.id))}>确认{confirm?.action === 'data' ? confirm.environment.dataClearedAt ? '清理资源' : '删除数据' : confirm?.environment.managed ? '销毁' : '解除关联'}</Button></div>
    </DialogContent></Dialog>
  </section>;
}
