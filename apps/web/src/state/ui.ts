import { create } from 'zustand';
import { TaskFilter } from '@nexus/core';

interface UIState {
  quickCaptureOpen: boolean;
  commandOpen: boolean;
  selectedTaskId: string | null; // 详情抽屉(右滑/底部)
  collapsed: Record<string, boolean>; // 任务树折叠状态
  filter: TaskFilter;
  taskMenu: { taskId: string; ids: string[]; x: number; y: number } | null; // 任务右键菜单锚点(ids=批量操作对象)
  tmuxView: { serverId: string; session: string } | null; // tmux 会话直连终端
  taskDeletion: { userId: string; ids: string[] } | null;
  taskBatch: { userId: string; ids: string[]; section: 'time' | 'priority' } | null;
  openTaskBatch: (userId: string, ids: string[], section: 'time' | 'priority') => void;
  closeTaskBatch: () => void;
  setQuickCapture: (open: boolean) => void;
  setCommand: (open: boolean) => void;
  selectTask: (id: string | null) => void;
  toggleCollapsed: (id: string) => void;
  setFilter: (f: TaskFilter) => void;
  openTaskMenu: (taskId: string, x: number, y: number, ids?: string[]) => void;
  closeTaskMenu: () => void;
  requestTaskDeletion: (userId: string, ids: string[]) => void;
  cancelTaskDeletion: () => void;
  openTmuxView: (serverId: string, session: string) => void;
  closeTmuxView: () => void;
  // 整棵子树折叠/展开(下钻到全部后代)
  collapseSubtree: (rootId: string, children: Map<string | null, string[]>) => void;
  expandSubtree: (rootId: string, children: Map<string | null, string[]>) => void;
  setSubtreesCollapsed: (rootIds: readonly string[], children: Map<string | null, string[]>, collapsed: boolean) => void;
}

export const useUI = create<UIState>((set, get) => ({
  quickCaptureOpen: false,
  commandOpen: false,
  selectedTaskId: null,
  collapsed: {},
  filter: { kind: 'all' },
  taskMenu: null,
  tmuxView: null,
  taskDeletion: null,
  taskBatch: null,
  openTaskBatch: (userId, ids, section) => set({ taskBatch: { userId, ids: [...new Set(ids)], section }, taskMenu: null }),
  closeTaskBatch: () => set({ taskBatch: null }),
  setQuickCapture: (open) => set({ quickCaptureOpen: open }),
  setCommand: (open) => set({ commandOpen: open }),
  selectTask: (id) => set({ selectedTaskId: id }),
  toggleCollapsed: (id) => set({ collapsed: { ...get().collapsed, [id]: !get().collapsed[id] } }),
  setFilter: (filter) => set({ filter }),
  openTaskMenu: (taskId, x, y, ids) => set({ taskMenu: { taskId, ids: ids && ids.length > 0 ? ids : [taskId], x, y } }),
  closeTaskMenu: () => set({ taskMenu: null }),
  requestTaskDeletion: (userId, ids) => set({ taskDeletion: { userId, ids: [...new Set(ids)] }, taskMenu: null }),
  cancelTaskDeletion: () => set({ taskDeletion: null }),
  openTmuxView: (serverId, session) => set({ tmuxView: { serverId, session } }),
  closeTmuxView: () => set({ tmuxView: null }),
  collapseSubtree: (rootId, children) => get().setSubtreesCollapsed([rootId], children, true),
  expandSubtree: (rootId, children) => get().setSubtreesCollapsed([rootId], children, false),
  setSubtreesCollapsed: (rootIds, children, value) => {
    const ids = [...new Set(rootIds)];
    const seen = new Set(ids);
    let i = 0;
    while (i < ids.length) {
      const cur = ids[i++]!;
      for (const child of children.get(cur) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child); ids.push(child);
      }
    }
    const collapsed = { ...get().collapsed };
    for (const id of ids) collapsed[id] = value;
    set({ collapsed });
  },
}));
