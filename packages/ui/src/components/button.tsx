import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-[var(--opacity-disabled)] select-none',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--accent-solid)] text-inverse shadow-xs hover:bg-[var(--accent-hover)] active:bg-[var(--accent-pressed)]',
        secondary: 'border border-[var(--border-default)] bg-[var(--bg-canvas)] text-foreground shadow-xs hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)]',
        ghost: 'text-muted hover:text-foreground hover:bg-[var(--surface)]',
        outline:
          'border border-[var(--border-default)] text-foreground hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)]',
        danger:
          'bg-[var(--danger)]/15 text-[var(--danger)] border border-[var(--danger)]/30 hover:bg-[var(--danger)]/25',
        link: 'text-[var(--accent-from)] underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-control',
        md: 'h-8 px-3 text-control',
        lg: 'h-11 px-6 text-base',
        icon: 'h-8 w-8',
        'icon-sm': 'h-7 w-7',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';

export { buttonVariants };
