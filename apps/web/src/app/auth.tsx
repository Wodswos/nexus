import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api, ApiError, setApiUserId, type AuthUser, attachPersistence, type PersistenceHandle, NexusStore, currentStore, setNexusStore, SyncClient, type SyncStatus, DOC_IDS } from '@nexus/crdt';
import { bindTimer, unbindTimer } from '@/focus/timer';
import { useUI } from '@/state/ui';

const PROFILE_KEY = 'cortex-active-user';
const ACCOUNTS_EVENT = 'nexus-accounts-changed';
function remembered(): AuthUser | null {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null');
    return value && typeof value.id === 'string' && typeof value.username === 'string' ? { id: value.id, username: value.username, isAdmin: value.isAdmin === true } : null;
  } catch { return null; }
}
type AuthPhase = 'loading' | 'local' | 'authed';
interface AuthCtx {
  phase: AuthPhase; user: AuthUser | null; serverReachable: boolean; syncStatus: SyncStatus;
  initialized: boolean | null; error: string | null;
  login(u: string, p: string): Promise<void>;
  register(u: string, p: string, invite?: string): Promise<void>;
  accounts: AuthUser[]; refreshAccounts(): Promise<void>;
  selectAccount(id: string): Promise<void>; forgetAccount(id: string): Promise<void>;
  logout(all?: boolean): Promise<void>; refreshStatus(): Promise<void>;
}
const Ctx = createContext<AuthCtx | null>(null);
export function useAuth(): AuthCtx { const ctx = useContext(Ctx); if (!ctx) throw new Error('AuthProvider missing'); return ctx; }

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<AuthPhase>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [serverReachable, setServerReachable] = useState(true);
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('offline');
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AuthUser[]>([]);
  const changing = useRef(false);
  const client = useRef<SyncClient | null>(null);
  const persistence = useRef<PersistenceHandle | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const authEpoch = useRef(0);
  const stopSync = () => { client.current?.destroy(); client.current = null; setSyncStatus('offline'); };

  const switchUser = (nextUser: AuthUser | null, absorb = false): Promise<void> => {
    const epoch = authEpoch.current;
    stopSync();
    setPhase('loading');
    setError(null);
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (!mounted.current || epoch !== authEpoch.current) return;
      stopSync();
      unbindTimer();
      setApiUserId(nextUser?.id ?? null);
      const previous = currentStore();
      if (previous?.userId !== (nextUser?.id ?? 'local')) {
        useUI.setState({ selectedTaskId: null, taskMenu: null, taskBatch: null, taskDeletion: null, tmuxView: null, quickCaptureOpen: false, commandOpen: false, collapsed: {}, filter: { kind: 'all' } });
      }
      if (absorb && previous?.userId === 'local' && !persistence.current) persistence.current = await attachPersistence(previous);
      const id = nextUser?.id ?? 'local';
      const store = previous?.userId === id ? previous : new NexusStore(id);
      const handle = store === previous && persistence.current ? persistence.current : await attachPersistence(store);
      if (!mounted.current || epoch !== authEpoch.current) { if (handle !== persistence.current) await handle.destroy(); return; }
      if (absorb && previous?.userId === 'local' && nextUser) {
        store.absorbLocal(previous);
        await handle.flush();
        previous.consumeLocal(nextUser.id);
        await persistence.current?.flush();
      }
      if (!mounted.current || epoch !== authEpoch.current) { if (handle !== persistence.current) await handle.destroy(); return; }
      if (handle !== persistence.current) { await persistence.current?.flush(); await persistence.current?.destroy(); }
      if (!mounted.current || epoch !== authEpoch.current) { if (handle !== persistence.current) await handle.destroy(); persistence.current = null; return; }
      persistence.current = handle;
      setNexusStore(store);
      bindTimer(store);
      setUser(nextUser);
      setPhase(nextUser ? 'authed' : 'local');
      try {
        if (nextUser) localStorage.setItem(PROFILE_KEY, JSON.stringify(nextUser));
        else localStorage.removeItem(PROFILE_KEY);
      } catch { /* the active in-memory account is still valid */ }
      if (nextUser) {
        const sync = new SyncClient(async () => {
          const active = () => mounted.current && epoch === authEpoch.current && client.current === sync;
          try {
            if (!active()) return null;
            const registered = await api.servers();
            if (!active()) return null;
            // Move legacy credentials into this account's vault before publishing root updates.
            const legacy = store.getData().settings.servers;
            for (const server of legacy) if (server.registered === undefined && !registered.some((item) => item.id === server.id)) {
              if (!active()) return null;
              registered.push(await api.saveServer(server.id, { name: server.name, host: server.host, password: server.password }));
              if (!active()) return null;
            }
            const metadata = [...registered, ...legacy.filter((server) => !registered.some((item) => item.id === server.id)).map(({ password: _password, ...server }) => ({ ...server, registered: false }))];
            if (JSON.stringify(legacy) !== JSON.stringify(metadata)) store.updateSettings({ servers: metadata });
            return await api.ticket(nextUser.id);
          }
          catch (failure) {
            if (active() && failure instanceof ApiError && (failure.status === 409 || failure.status === 401)) {
              sync.destroy();
              void reconcile();
            }
            return null;
          }
        });
        sync.onStatus(setSyncStatus);
        for (const docId of DOC_IDS) sync.register(docId, store.docs[docId]);
        client.current = sync;
        sync.start();
      }
    }).catch((failure) => { if (mounted.current) setError((failure as Error).message); throw failure; });
    return queue.current;
  };

  const refreshStatus = async () => {
    try { const status = await api.status(); setInitialized(status.initialized); setServerReachable(true); }
    catch { setServerReachable(false); }
  };
  const refreshAccounts = async () => {
    const epoch = authEpoch.current;
    const result = await api.accounts();
    if (mounted.current && epoch === authEpoch.current) setAccounts(result.accounts);
  };
  const reconcile = async () => {
    const epoch = ++authEpoch.current;
    stopSync(); setPhase('loading');
    let me: AuthUser | null;
    try {
      me = await api.me();
      if (!mounted.current || epoch !== authEpoch.current) return;
      setServerReachable(true);
    } catch (failure) {
      if (!mounted.current || epoch !== authEpoch.current) return;
      setServerReachable(false);
      if (failure instanceof ApiError) throw failure;
      me = remembered();
    }
    await switchUser(me);
    if (epoch === authEpoch.current) await refreshAccounts().catch(() => {});
  };
  useEffect(() => {
    mounted.current = true;
    void refreshStatus();
    void reconcile().catch((failure) => setError((failure as Error).message));
    const storage = (event: StorageEvent) => {
      if (event.key !== PROFILE_KEY && event.key !== ACCOUNTS_EVENT) return;
      stopSync(); // stop before awaiting the server or local persistence
      void reconcile().catch((failure) => setError((failure as Error).message));
    };
    window.addEventListener('storage', storage);
    return () => {
      mounted.current = false;
      window.removeEventListener('storage', storage);
      stopSync(); unbindTimer();
      void persistence.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const notifyAccounts = () => {
    try { localStorage.setItem(ACCOUNTS_EVENT, `${Date.now()}:${Math.random()}`); } catch { /* private storage may be unavailable */ }
  };
  const changeAccount = async (request: () => Promise<AuthUser | null>, absorb = false) => {
    if (changing.current) throw new Error('正在切换账号，请稍候');
    changing.current = true;
    const epoch = ++authEpoch.current;
    stopSync(); setPhase('loading');
    try {
      await persistence.current?.flush();
      const me = await request();
      notifyAccounts();
      // Cookie identity is authoritative, including simultaneous changes in another tab.
      if (epoch === authEpoch.current) await switchUser(me, absorb);
      else await reconcile();
      await refreshAccounts();
    } catch (failure) {
      // A rejected password or failed request must not leave the original account disconnected.
      await reconcile().catch(() => {});
      setError((failure as Error).message);
      throw failure;
    } finally { changing.current = false; }
  };
  const login = (username: string, password: string) => changeAccount(() => api.login(username, password), true);
  const register = (username: string, password: string, invite?: string) => changeAccount(() => api.register(username, password, invite), true);
  const selectAccount = (id: string) => changeAccount(() => api.switchAccount(id));
  const forgetAccount = async (id: string) => { await api.forgetAccount(id); notifyAccounts(); await refreshAccounts(); };
  const logout = async (all = false) => { await changeAccount(async () => { await api.logout(all); return null; }); await refreshStatus(); };
  return <Ctx.Provider value={{ phase, user, serverReachable, syncStatus, initialized, error, accounts, refreshAccounts, selectAccount, forgetAccount, login, register, logout, refreshStatus }}>{children}</Ctx.Provider>;
}
export function useStore(): NexusStore { const store = currentStore(); if (!store) throw new Error('NexusStore not initialized'); return store; }
