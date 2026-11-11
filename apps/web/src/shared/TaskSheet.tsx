import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet, SheetContent } from '@nexus/ui';
import { useNexusData } from '@nexus/crdt';
import { useUI } from '../state/ui';
import { TaskInspector, type TaskInspectorHandle } from './TaskInspector';
import { useTaskSheetPull } from './useTaskSheetPull';

/** Global host: same inspector as MindMap, with mobile dialog/pull semantics. */
export function TaskSheet() {
  const selectedId = useUI((state) => state.selectedTaskId);
  const confirmingDeletion = useUI((state) => state.taskDeletion !== null);
  const terminalOpen = useUI((state) => state.tmuxView !== null);
  const selectTask = useUI((state) => state.selectTask);
  const data = useNexusData();
  const task = data.tasks.find((task) => task.id === selectedId) ?? null;
  const inspector = useRef<TaskInspectorHandle>(null),
    sheet = useRef<HTMLDivElement | null>(null);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const dismiss = async () => {
    const id = selectedId;
    try {
      await inspector.current?.commit();
      if (useUI.getState().selectedTaskId === id) selectTask(null);
    } catch {
      /* Save errors stay visible in the inspector. */
    }
  };
  const pullRef = useTaskSheetPull(
    mobile && !!task && !confirmingDeletion && !terminalOpen,
    selectedId,
    async () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.matches('input,textarea,[contenteditable]'))
        focused.blur();
      await dismiss();
    },
  );
  const setRef = useCallback(
    (element: HTMLDivElement | null) => {
      sheet.current = element;
      pullRef(element);
    },
    [pullRef],
  );
  return (
    <Sheet
      open={!!task && !confirmingDeletion && !terminalOpen}
      onOpenChange={(open) => {
        if (!open) void dismiss();
      }}
      modal={mobile}
    >
      <SheetContent
        ref={setRef}
        bare
        data-task-sheet
        side={mobile ? 'bottom' : 'float'}
        aria-describedby={undefined}
        className={
          mobile
            ? 'flex h-[86dvh] max-h-[92dvh] flex-col overflow-hidden'
            : '!right-3 !top-3 flex h-[min(760px,calc(100dvh-112px))] !w-[min(360px,calc(100vw-24px))] flex-col overflow-hidden !rounded-lg shadow-lg'
        }
        style={
          mobile
            ? {
                transform: 'translate3d(0,var(--task-sheet-pull,0px),0)',
                transition: 'transform var(--task-sheet-pull-duration,180ms) ease-out',
              }
            : undefined
        }
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          sheet.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          if (useUI.getState().tmuxView) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          event.preventDefault();
          if (useUI.getState().taskDeletion || useUI.getState().tmuxView) return;
          const target = event.detail.originalEvent.target;
          if (target instanceof Element && target.closest('[data-task-detail-portal]')) return;
          if (
            target instanceof Element &&
            target.closest('[data-task-detail-trigger], [data-task-menu]')
          ) {
            void inspector.current?.commit().catch(() => {});
            return;
          }
          void dismiss();
        }}
        onEscapeKeyDown={(event) => {
          if (
            useUI.getState().taskDeletion ||
            (event.target as HTMLElement | null)?.closest?.('input[type="datetime-local"], [data-task-resource-editor], [data-task-detail-portal]')
          )
            event.preventDefault();
        }}
      >
        {mobile && (
          <div
            aria-hidden="true"
            className="mx-auto mt-2 mb-1 h-1 w-10 shrink-0 rounded-full bg-[var(--border-strong)]"
          />
        )}
        <TaskInspector
          ref={inspector}
          embedded
          task={task}
          onClose={() => {
            if (useUI.getState().selectedTaskId === selectedId) selectTask(null);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}
