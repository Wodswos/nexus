import React, { forwardRef, memo } from 'react';
import { parseTaskTitle, taskTitleText } from '@nexus/core';

export const TaskTitle = memo(function TaskTitle({ title }: { title: string }) {
  return <>{parseTaskTitle(title || '未命名任务').map((part, index) => part.href
    ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" draggable={false}
        className="nodrag nopan cursor-pointer underline decoration-current/40 underline-offset-[3px] hover:decoration-current"
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{part.text}</a>
    : <React.Fragment key={index}>{part.text}</React.Fragment>)}</>;
});

/** Linked titles use a focusable group, avoiding invalid anchors nested inside buttons. */
export const TaskTitleButton = forwardRef<HTMLElement, React.ButtonHTMLAttributes<HTMLElement> & { taskTitle: string }>(function TaskTitleButton({ taskTitle, children, onKeyDown, ...props }, ref) {
  const linked = parseTaskTitle(taskTitle).some(part => part.href);
  return React.createElement(linked ? 'div' : 'button', {
    ...props, ref, ...(linked ? { role: 'group', tabIndex: props.tabIndex ?? 0, 'aria-label': props['aria-label'] ?? taskTitleText(taskTitle) } : {}),
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      onKeyDown?.(event);
      if (linked && !event.defaultPrevented && event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.currentTarget.click(); }
    },
  }, children ?? <TaskTitle title={taskTitle} />);
});
