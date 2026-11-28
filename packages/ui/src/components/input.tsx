import * as React from 'react';
import { cn } from '../utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg-canvas)] px-3 text-sm text-foreground placeholder:text-[var(--text-disabled)] transition-colors',
        'hover:border-[var(--border-strong)] focus-visible:border-[var(--accent-primary)]',
        'disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full resize-none rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg-canvas)] px-3 py-2 text-sm text-foreground placeholder:text-[var(--text-disabled)] transition-colors',
        'hover:border-[var(--border-strong)] focus-visible:border-[var(--accent-primary)]',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
