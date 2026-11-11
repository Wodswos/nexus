import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useNexusData } from '@nexus/crdt';
import type { Task } from '@nexus/core';
import { taskViewHref, type TaskDestination } from '@/features/tasks/taskNavigation';
import { TASK_VIEWS } from '@/features/tasks/viewOptions';

const destinations = TASK_VIEWS.map(({ key: view, label: text }) => ({
  view,
  label: `在${text}中定位`,
  text,
}));

export function TaskViewLinks({
  task,
  beforeNavigate,
  onNavigate,
}: {
  task: Task;
  beforeNavigate: () => Promise<void>;
  onNavigate: () => void;
}) {
  const data = useNexusData();
  const navigate = useNavigate();
  const latest = useRef(task.id);
  latest.current = task.id;
  useEffect(
    () => () => {
      latest.current = '';
    },
    [],
  );
  const links = useMemo(
    () =>
      destinations.map((destination) => ({
        ...destination,
        href: taskViewHref(data, task.id, destination.view),
      })),
    [data, task.id],
  );
  const [busy, setBusy] = useState<TaskDestination | null>(null);
  return (
    <nav
      aria-label="任务定位"
      className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-[var(--border)] px-3 py-1.5"
    >
      <span className="mr-1 text-[11px] text-muted">跳转到</span>
      {links.map(({ view, label, text, href }) => {
        if (!href) return null;
        return (
          <Link
            key={view}
            to={href}
            aria-label={label}
            title={label}
            aria-disabled={busy != null}
            className="inline-flex h-7 items-center rounded-md px-1.5 text-xs text-muted hover:bg-[var(--surface)] hover:text-foreground"
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              if (busy) return;
              const id = task.id;
              setBusy(view);
              void beforeNavigate()
                .then(
                  () => {
                    if (latest.current !== id) return;
                    onNavigate();
                    navigate(href);
                  },
                  () => {},
                )
                .finally(() => setBusy(null));
            }}
          >
            {text}
          </Link>
        );
      })}
    </nav>
  );
}
