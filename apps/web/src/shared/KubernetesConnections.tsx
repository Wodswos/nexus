import React, { useEffect, useRef, useState } from 'react';
import { Button, SelectField } from '@nexus/ui';
import { currentStore, useNexus } from '@nexus/crdt';
import { agentWorkspaceApi, type KubernetesConnectionView } from './agentWorkspaceApi';

export function KubernetesConnections({ value = '', onChange, manage = false }: { value?: string; onChange?: (id: string, connection?: KubernetesConnectionView) => void; manage?: boolean }) {
  const store = useNexus();
  const [connections, setConnections] = useState<KubernetesConnectionView[]>([]);
  const [editing, setEditing] = useState<string | null>(null), [name, setName] = useState(''), [server, setServer] = useState('');
  const [namespace, setNamespace] = useState('default'), [ca, setCa] = useState(''), [token, setToken] = useState('');
  const [cert, setCert] = useState(''), [key, setKey] = useState(''), [method, setMethod] = useState<'token' | 'certificate'>('token');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [deleting, setDeleting] = useState(false);
  const mounted = useRef(true);
  const active = () => mounted.current && currentStore() === store;
  const selected = connections.find((row) => row.id === value);
  useEffect(() => {
    mounted.current = true;
    void agentWorkspaceApi.connections().then((values) => { if (active()) setConnections(values); }).catch((reason) => { if (active()) setError(reason instanceof Error ? reason.message : '连接读取失败'); });
    return () => { mounted.current = false; };
  }, [store]);
  const edit = (connection?: KubernetesConnectionView) => {
    setEditing(connection?.id ?? ''); setName(connection?.name ?? ''); setServer(connection?.server ?? '');
    setNamespace(connection?.namespace ?? 'default'); setCa(connection?.ca ?? ''); setToken(''); setCert(''); setKey('');
    setMethod(connection?.certificateSet && !connection.tokenSet ? 'certificate' : 'token'); setError(''); setDeleting(false);
  };
  const close = () => { setEditing(null); setToken(''); setCert(''); setKey(''); setDeleting(false); };
  const save = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const previous = connections.find((row) => row.id === editing);
      if (method === 'token' && !token && !previous?.tokenSet) throw new Error('请填写访问 Token');
      if (method === 'certificate' && ((!cert || !key) && !previous?.certificateSet)) throw new Error('请填写客户端证书与私钥');
      if (method === 'certificate' && (!!cert !== !!key)) throw new Error('更新客户端证书时，需要同时填写证书与私钥');
      const result = await agentWorkspaceApi.saveConnection({
        name: name.trim(), server: server.trim(), namespace: namespace.trim() || 'default', ca,
        ...(method === 'token' ? { ...(token ? { token } : {}), cert: null, key: null } : { token: null, ...(cert && key ? { cert, key } : {}) }),
      }, editing || undefined);
      if (!active()) return;
      setConnections((values) => [...values.filter((row) => row.id !== result.id), result]); onChange?.(result.id, result); close();
    } catch (reason) { if (active()) setError(reason instanceof Error ? reason.message : '连接保存失败'); }
    finally { if (active()) setBusy(false); }
  };
  const remove = async () => {
    if (!editing || busy) return;
    setBusy(true); setError('');
    try {
      await agentWorkspaceApi.deleteConnection(editing);
      if (!active()) return;
      setConnections((values) => values.filter((row) => row.id !== editing)); if (value === editing) onChange?.(''); close();
    } catch (reason) { if (active()) setError(reason instanceof Error ? reason.message : '连接删除失败'); }
    finally { if (active()) setBusy(false); }
  };
  const field = 'w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-xs outline-none focus:border-[var(--accent-solid)]';
  return <div className="space-y-2">
    {manage ? <div className="space-y-2">
      {connections.map(connection => <div key={connection.id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2">
        <div className="min-w-0"><p className="truncate text-xs font-medium">{connection.name}</p><p className="break-all text-[11px] text-muted">{connection.server} · {connection.namespace}</p></div>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => edit(connection)}>编辑<span className="sr-only"> {connection.name}</span></Button>
      </div>)}
      {!connections.length && <p className="text-xs text-muted">暂无 Kubernetes 集群</p>}
    </div> : <><SelectField aria-label="Kubernetes API 连接" value={value} onValueChange={(id) => { if (id) onChange?.(id, connections.find(row => row.id === id)); }} className="w-full" options={[
      { value: '', label: '选择 Kubernetes 连接', disabled: true }, ...connections.map((row) => ({ value: row.id, label: row.name })),
    ]} />
    {selected && <p className="break-all text-[10px] text-muted">{selected.server} · {selected.namespace}</p>}</> }
    <div className="flex gap-3 text-[11px] text-muted">
      <button type="button" className="min-h-7 underline underline-offset-2" disabled={busy} onClick={() => edit()}>{manage ? '添加 Kubernetes 集群' : '添加连接'}</button>
      {!manage && selected && <button type="button" className="min-h-7 underline underline-offset-2" onClick={() => edit(selected)}>编辑连接</button>}
    </div>
    {editing !== null && <div className="space-y-3 rounded-lg border border-[var(--border)] p-3">
      <p className="text-xs font-medium">{editing ? '编辑 Kubernetes 连接' : '添加 Kubernetes 连接'}</p>
      <label className="block space-y-1 text-xs"><span>连接名称</span><input aria-label="Kubernetes 连接名称" value={name} onChange={(event) => setName(event.target.value)} className={field} disabled={busy} /></label>
      <label className="block space-y-1 text-xs"><span>API Server</span><input aria-label="Kubernetes API Server" value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://cluster.example.com:6443" className={field} disabled={busy} /></label>
      <label className="block space-y-1 text-xs"><span>默认 Namespace</span><input aria-label="Kubernetes 默认 Namespace" value={namespace} onChange={(event) => setNamespace(event.target.value)} className={field} disabled={busy} /></label>
      <label className="block space-y-1 text-xs"><span>CA 证书</span><textarea aria-label="Kubernetes CA 证书" value={ca} onChange={(event) => setCa(event.target.value)} rows={3} placeholder="PEM 格式，使用系统信任证书时可留空" className={`${field} font-mono`} disabled={busy} /></label>
      <fieldset className="flex gap-4 text-xs" disabled={busy}><legend className="mb-2">认证方式</legend>
        <label className="flex items-center gap-1.5"><input type="radio" checked={method === 'token'} onChange={() => setMethod('token')} />Token</label>
        <label className="flex items-center gap-1.5"><input type="radio" checked={method === 'certificate'} onChange={() => setMethod('certificate')} />客户端证书</label>
      </fieldset>
      {method === 'token' ? <label className="block space-y-1 text-xs"><span>访问 Token</span><input type="password" autoComplete="new-password" aria-label="Kubernetes 访问 Token" value={token} onChange={(event) => setToken(event.target.value)} placeholder={editing ? '留空保留已保存的 Token' : 'ServiceAccount Token'} className={field} disabled={busy} /></label> : <>
        <label className="block space-y-1 text-xs"><span>客户端证书</span><textarea aria-label="Kubernetes 客户端证书" value={cert} onChange={(event) => setCert(event.target.value)} rows={3} placeholder={editing ? '留空保留已保存的证书' : 'PEM 格式'} className={`${field} font-mono`} disabled={busy} /></label>
        <label className="block space-y-1 text-xs"><span>客户端私钥</span><textarea aria-label="Kubernetes 客户端私钥" value={key} onChange={(event) => setKey(event.target.value)} rows={3} placeholder={editing ? '留空保留已保存的私钥' : 'PEM 格式'} className={`${field} font-mono`} disabled={busy} spellCheck={false} /></label>
      </>}
      <p className="text-[10px] leading-5 text-muted">凭据加密保存在服务端，仅当前账号可使用。需要目标 Namespace 的 Pod 查询、创建、删除与 exec 权限。</p>
      {deleting && <p className="text-xs leading-5 text-[var(--danger)]">删除后，引用此连接的环境将无法继续连接。确认删除此连接？</p>}
      <div className="flex justify-between gap-2">
        {editing ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => deleting ? void remove() : setDeleting(true)}>{deleting ? '确认删除连接' : '删除连接'}</Button> : <span />}
        <div className="flex gap-1"><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={close}>取消</Button><Button type="button" size="sm" disabled={busy || !name.trim() || !server.trim()} onClick={() => void save()}>保存连接</Button></div>
      </div>
    </div>}
    {error && <p role="alert" className="text-xs leading-5 text-[var(--danger)]">{error}</p>}
  </div>;
}
