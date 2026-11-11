import React, { useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Play, RotateCcw, Trash2, X } from 'lucide-react';
import { isProject, isStructural, type Task } from '@nexus/core';
import { useNexus, useNexusData } from '@nexus/crdt';
import { useUI } from '@/state/ui';
import { useTimer } from '@/focus/timer';
import { isComposing } from './ime';
import { KindToggle, TagChip } from './components';

/** Secondary fields shared by every task inspector. The parent keys this by task. */
export function TaskAdvancedSettings({
  task,
  beforeLeave,
  onClose,
}: {
  task: Task;
  beforeLeave: () => Promise<void>;
  onClose: () => void;
}) {
  const store = useNexus(),
    data = useNexusData(),
    navigate = useNavigate();
  const timerStart = useTimer((state) => state.start);
  const [tagInput, setTagInput] = useState('');
  const [error, setError] = useState('');
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const project = isProject(task),
    node = isStructural(task);
  const sessions = data.sessions.filter(
    (session) => session.taskId === task.id && session.mode === 'focus',
  );
  const leave = async (action: () => void) => {
    try {
      await beforeLeave();
      if (active.current) action();
    } catch {
      setError('本地保存失败，请保留页面并重试。');
    }
  };
  return (
    <div className="space-y-4 text-xs">
      <div className="space-y-2">
        <span className="text-muted">节点类型</span>
        {project ? (
          <p>项目根节点</p>
        ) : (
          <KindToggle
            value={node ? 'node' : 'todo'}
            onChange={(kind) => store.setTaskKind(task.id, kind)}
          />
        )}
      </div>
      <div>
        <span className="text-muted">标签</span>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {task.tags.map((id) => {
            const tag = data.tags.find((tag) => tag.id === id && !tag.deletedAt);
            return (
              tag && (
                <span key={id} className="inline-flex items-center">
                  <TagChip tag={tag} />
                  <button
                    aria-label={`移除标签 ${tag.name}`}
                    onClick={() =>
                      store.updateTask(task.id, { tags: task.tags.filter((value) => value !== id) })
                    }
                    className="p-1 text-muted hover:text-foreground"
                  >
                    <X size={12} />
                  </button>
                </span>
              )
            );
          })}
          <input
            aria-label="添加任务标签"
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={(event) => {
              if (isComposing(event) || event.key !== 'Enter' || !tagInput.trim()) return;
              const tag = store.ensureTag(tagInput.trim());
              if (!task.tags.includes(tag.id))
                store.updateTask(task.id, { tags: [...task.tags, tag.id] });
              setTagInput('');
            }}
            placeholder="+ 标签"
            className="w-24 rounded-md border border-dashed border-[var(--border)] bg-transparent px-2 py-1 outline-none"
          />
        </div>
      </div>
      {sessions.length > 0 && (
        <p className="text-muted">
          已专注 {sessions.length} 次 · 共{' '}
          {Math.round(sessions.reduce((sum, session) => sum + session.actualMin, 0))} 分钟
        </p>
      )}
      <div className="flex flex-wrap gap-3 border-t border-[var(--border)] pt-3">
        {!node && (
          <button
            className="flex items-center gap-1.5 text-muted hover:text-foreground"
            onClick={() =>
              void leave(() => {
                timerStart({ mode: 'focus', taskId: task.id });
                onClose();
                navigate('/focus');
              })
            }
          >
            <Play size={13} />
            开始专注
          </button>
        )}
        {task.deletedAt ? (
          <button className="flex items-center gap-1.5" onClick={() => store.restoreTask(task.id)}>
            <RotateCcw size={13} />
            恢复任务
          </button>
        ) : (
          <button
            className="flex items-center gap-1.5 text-[var(--danger)]"
            onClick={() =>
              void leave(() => {
                if (project) useUI.getState().requestTaskDeletion(store.userId, [task.id]);
                else {
                  store.softDeleteTask(task.id);
                  onClose();
                }
              })
            }
          >
            <Trash2 size={13} />
            {project ? '删除项目' : '删除任务'}
          </button>
        )}
      </div>
      <p className="text-[10px] text-muted">
        创建于 {new Date(task.createdAt).toLocaleString('zh-CN')}
      </p>
      {error && (
        <p role="alert" className="text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
