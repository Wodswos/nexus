import React, { useState } from 'react';
import { useNavigate } from 'react-router';
import { useNexus, useNexusData } from '@nexus/crdt';
import {
  activeTasks,
  dayKeyOf,
  isProject,
  newId,
  savedViewHref,
  sortSiblings,
  validateSavedViews,
  TASK_FILTER_PRIORITIES,
  TASK_FILTER_STATUSES,
  type SavedTaskView,
} from '@nexus/core';
import { Button, Dialog, DialogContent, Input, SelectField } from '@nexus/ui';
import { TASK_VIEWS } from '../viewOptions';
import { isComposing } from '@/shared/ime';
import { CalendarDateField } from '@/shared/CalendarPicker';

export function SaveViewDialog({
  initial,
  editing = false,
  onClose,
  restoreFocus,
}: {
  initial: SavedTaskView;
  editing?: boolean;
  onClose: () => void;
  restoreFocus?: () => void;
}) {
  const store = useNexus();
  const data = useNexusData();
  const navigate = useNavigate();
  const [value, setValue] = useState<SavedTaskView>(() => ({
    ...initial,
    id: editing ? initial.id : newId(),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const projects = activeTasks(data.tasks).filter(isProject).sort(sortSiblings);
  const change = (patch: Partial<SavedTaskView>) =>
    setValue((previous) => ({ ...previous, ...patch }));
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const item: SavedTaskView = {
      id: value.id,
      name: value.name.trim(),
      view: value.view,
      scope: value.scope,
      projectId: value.projectId || null,
      work: value.work ?? 'all',
      taskStatus: value.taskStatus ?? 'all',
      taskPriority: value.taskPriority ?? 'all',
      ...(value.taskTag ? { taskTag: value.taskTag } : {}),
      ...(value.scope === 'custom' ? { from: value.from, to: value.to } : {}),
    };
    try {
      const previous = store.getData().settings.savedViews;
      const next = previous.some((view) => view.id === item.id)
        ? previous.map((view) => (view.id === item.id ? item : view))
        : [...previous, item];
      validateSavedViews(next);
      if (item.projectId && !projects.some((project) => project.id === item.projectId))
        throw new Error('所属项目已被删除，请重新选择范围');
      setBusy(true);
      setError('');
      store.stopUndoCapture();
      store.updateSettings({ savedViews: next });
      store.stopUndoCapture();
      await store.flushPersistence();
      navigate(savedViewHref(item));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        title={editing ? '编辑快捷视图' : '保存快捷视图'}
        className="top-[10%] max-h-[80dvh] w-[min(92vw,440px)] overflow-y-auto"
        onCloseAutoFocus={
          restoreFocus
            ? (event) => {
                event.preventDefault();
                restoreFocus();
              }
            : undefined
        }
      >
        <form onSubmit={(event) => void save(event)} className="space-y-4">
          <label className="block space-y-1.5 text-sm">
            <span>视图名称</span>
            <Input
              autoFocus
              required
              maxLength={60}
              value={value.name}
              disabled={busy}
              onChange={(event) => change({ name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && isComposing(event)) event.preventDefault();
              }}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block min-w-0 space-y-1.5 text-sm">
              <span>展示方式</span>
              <SelectField
                aria-label="展示方式"
                className="w-full"
                disabled={busy}
                value={value.view}
                onValueChange={(view) => change({ view: view as SavedTaskView['view'] })}
                options={TASK_VIEWS.map((view) => ({ value: view.key, label: view.label }))}
              />
            </label>
            <label className="block min-w-0 space-y-1.5 text-sm">
              <span>默认时间范围</span>
              <SelectField
                aria-label="默认时间范围"
                className="w-full"
                disabled={busy}
                value={value.scope}
                onValueChange={(scope) =>
                  change({
                    scope: scope as SavedTaskView['scope'],
                    from: value.from ?? dayKeyOf(new Date()),
                    to: value.to ?? dayKeyOf(new Date()),
                  })
                }
                options={[
                  { value: 'today', label: '今天' },
                  { value: 'week', label: '本周' },
                  { value: 'month', label: '本月' },
                  { value: 'custom', label: '固定日期区间' },
                  { value: 'all', label: '全部时间' },
                  { value: 'undated', label: '未排期' },
                ]}
              />
            </label>
          </div>
          <label className="block min-w-0 space-y-1.5 text-sm">
            <span>项目范围</span>
            <SelectField
              aria-label="项目范围"
              className="w-full"
              disabled={busy}
              value={value.projectId ?? ''}
              onValueChange={(projectId) => change({ projectId: projectId || null })}
              options={[
                { value: '', label: '全部项目与独立任务' },
                ...projects.map((project) => ({ value: project.id, label: project.title })),
              ]}
            />
          </label>
          {value.scope === 'custom' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block min-w-0 space-y-1.5 text-sm">
                <span>起始日期</span>
                <CalendarDateField
                  aria-label="起始日期"
                  required
                  className="w-full"
                  disabled={busy}
                  value={value.from ?? ''}
                  onChange={(from) => change({ from })}
                />
              </label>
              <label className="block min-w-0 space-y-1.5 text-sm">
                <span>截止日期</span>
                <CalendarDateField
                  aria-label="截止日期"
                  required
                  min={value.from}
                  className="w-full"
                  disabled={busy}
                  value={value.to ?? ''}
                  onChange={(to) => change({ to })}
                />
              </label>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block min-w-0 space-y-1.5 text-sm">
              <span>工作范围</span>
              <SelectField
                aria-label="快捷视图工作范围"
                className="w-full"
                disabled={busy}
                value={value.work ?? 'all'}
                onValueChange={(work) => change({ work: work as SavedTaskView['work'] })}
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'current', label: '当前工作 · 进行中或逾期' },
                  { value: 'overdue', label: '逾期' },
                  { value: 'doing', label: '仅进行中' },
                  { value: 'week', label: '本周安排' },
                  { value: 'unscheduled', label: '重要未排期' },
                ]}
              />
            </label>
            <label className="block min-w-0 space-y-1.5 text-sm">
              <span>状态</span>
              <SelectField
                aria-label="快捷视图任务状态"
                className="w-full"
                disabled={busy}
                value={value.taskStatus ?? 'all'}
                onValueChange={(taskStatus) =>
                  change({ taskStatus: taskStatus as SavedTaskView['taskStatus'] })
                }
                options={TASK_FILTER_STATUSES.map((status) => ({
                  value: status,
                  label: {
                    all: '全部状态',
                    unfinished: '未完成',
                    todo: '待办',
                    doing: '进行中',
                    done: '已完成',
                  }[status],
                }))}
              />
            </label>
            <label className="block min-w-0 space-y-1.5 text-sm">
              <span>优先级</span>
              <SelectField
                aria-label="快捷视图任务优先级"
                className="w-full"
                disabled={busy}
                value={value.taskPriority ?? 'all'}
                onValueChange={(taskPriority) =>
                  change({ taskPriority: taskPriority as SavedTaskView['taskPriority'] })
                }
                options={TASK_FILTER_PRIORITIES.map((priority) => ({
                  value: priority,
                  label:
                    priority === 'all'
                      ? '全部优先级'
                      : priority === 'high'
                        ? '高优先级 · P0 / P1'
                        : priority,
                  ...(/^P[0-3]$/.test(priority)
                    ? { color: `var(--${priority.toLowerCase()})` }
                    : {}),
                }))}
              />
            </label>
            <label className="block min-w-0 space-y-1.5 text-sm">
              <span>标签</span>
              <SelectField
                aria-label="快捷视图任务标签"
                className="w-full"
                disabled={busy}
                value={value.taskTag ?? ''}
                onValueChange={(taskTag) => change({ taskTag: taskTag || undefined })}
                options={[
                  { value: '', label: '全部标签' },
                  ...data.tags
                    .filter((tag) => !tag.deletedAt)
                    .map((tag) => ({ value: tag.id, label: tag.name, color: tag.color })),
                  ...(value.taskTag &&
                  !data.tags.some((tag) => tag.id === value.taskTag && !tag.deletedAt)
                    ? [{ value: value.taskTag, label: '已移除的标签' }]
                    : []),
                ]}
              />
            </label>
          </div>
          <p className="text-xs leading-relaxed text-muted">
            今天、本周、本月会随日期自动更新。侧栏入口始终按这里保存的默认配置打开。
          </p>
          {error && (
            <p role="alert" className="text-xs text-[var(--danger)]">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy || !value.name.trim()}>
              {busy ? '正在保存…' : editing ? '保存修改' : '保存快捷视图'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
