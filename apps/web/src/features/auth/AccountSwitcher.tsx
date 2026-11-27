import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Check, LogOut, Plus, UserRound, X } from 'lucide-react';
import { Badge, Button } from '@nexus/ui';
import { useAuth } from '@/app/auth';

export function AccountSwitcher() {
  const auth = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void auth.refreshAccounts().catch(() => setError('无法读取已登录账号，请连接服务器后重试')); }, []);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await operation(); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  return <section aria-label="账号切换" className="space-y-3">
    {(error || auth.error) && <p role="alert" className="text-sm text-[var(--danger)]">{error || auth.error}</p>}
    <div className="overflow-hidden rounded-xl border border-[var(--border)]">
      {auth.accounts.length === 0 && <p className="p-4 text-sm text-muted">暂无已登录账号</p>}
      {auth.accounts.map(account => {
        const active = account.id === auth.user?.id;
        return <div key={account.id} className="flex min-w-0 items-center gap-1 border-b border-[var(--border)] p-1 last:border-b-0" data-testid="saved-account">
          <button aria-label={active ? `当前账号 ${account.username}` : `切换到 ${account.username}`} disabled={busy || active}
            onClick={() => void run(() => auth.selectAccount(account.id))}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-[var(--surface)] disabled:cursor-default">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--surface)] text-muted"><UserRound size={15} /></span>
            <span title={account.username} className="min-w-0 flex-1 truncate text-sm">{account.username}</span>
            {account.isAdmin && <Badge variant="accent">管理员</Badge>}
            {active && <span className="flex shrink-0 items-center gap-1 text-xs text-muted"><Check size={14} />当前</span>}
          </button>
          <button aria-label={`退出账号 ${account.username}`} title="仅退出此浏览器的登录，保留账号与数据" disabled={busy}
            className="rounded-lg p-2 text-muted hover:bg-[var(--surface)] hover:text-foreground"
            onClick={() => void run(() => active ? auth.logout() : auth.forgetAccount(account.id))}><X size={16} /></button>
        </div>;
      })}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Link to="/login?add=1" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-xs hover:bg-[var(--surface)]"><Plus size={15} />添加账号</Link>
      {auth.accounts.length > 0 && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => auth.logout(true))}><LogOut size={14} />退出本浏览器所有账号</Button>}
    </div>
    {auth.accounts.length > 0 && <p className="text-xs leading-relaxed text-muted">切换会同步到其他标签页；各账号数据独立保留。</p>}
  </section>;
}
