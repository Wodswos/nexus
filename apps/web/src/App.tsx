import React, { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { AuthProvider, useAuth } from './app/auth';
import { Layout } from './app/Layout';
const DashboardPage = lazy(() => import('./features/dashboard/page'));
const CalendarPage = lazy(() => import('./features/calendar/page'));
const AgentWorkbenchPage = lazy(() => import('./features/work/AgentWorkbenchPage'));
const WorkspaceTemplatesPage = lazy(() => import('./features/work/WorkspaceTemplatesPage'));
const TasksPage = lazy(() => import('./features/tasks/TasksPage'));
const InboxPage = lazy(() => import('./features/inbox/page'));
const FocusPage = lazy(() => import('./features/focus/page'));
const HabitsPage = lazy(() => import('./features/habits/page'));
const SettingsPage = lazy(() => import('./features/settings/page'));
const LoginPage = lazy(() => import('./features/auth/page'));
const GalleryPage = lazy(() => import('./features/gallery/GalleryPage'));
const ReviewsPage = lazy(() => import('./features/reviews/page'));
const TrashPage = lazy(() => import('./features/trash/page'));
const TmuxPage = lazy(() => import('./shared/TmuxViewer').then((module) => ({ default: module.TmuxPage })));
function page(Component: LazyExoticComponent<ComponentType>) {
  return (
    <Suspense
      fallback={
        <div role="status" className="p-6 text-sm text-muted">
          正在载入…
        </div>
      }
    >
      <Component />
    </Suspense>
  );
}
function PrivateTmuxPage() {
  const { phase, user } = useAuth();
  if (phase === 'loading') return <div role="status" className="p-6 text-sm text-muted">正在切换账号…</div>;
  return <React.Fragment key={user?.id ?? 'local'}>{page(TmuxPage)}</React.Fragment>;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/work" replace />} />
          <Route path="/overview" element={page(DashboardPage)} />
          <Route path="/work" element={page(AgentWorkbenchPage)} />
          <Route path="/work/agents/:id" element={page(AgentWorkbenchPage)} />
          <Route path="/workspaces" element={page(WorkspaceTemplatesPage)} />
          <Route path="/tasks" element={page(TasksPage)} />
          <Route path="/calendar" element={page(CalendarPage)} />
          <Route path="/inbox" element={page(InboxPage)} />
          <Route path="/focus" element={page(FocusPage)} />
          <Route path="/habits" element={page(HabitsPage)} />
          <Route path="/reviews" element={page(ReviewsPage)} />
          <Route path="/trash" element={page(TrashPage)} />
          <Route path="/settings" element={page(SettingsPage)} />
          <Route path="/accounts" element={<Navigate to="/settings#accounts" replace />} />
          <Route path="/gallery" element={page(GalleryPage)} />
        </Route>
        <Route path="/login" element={page(LoginPage)} />
        <Route path="/tmux" element={<PrivateTmuxPage />} />
      </Routes>
    </AuthProvider>
  );
}
