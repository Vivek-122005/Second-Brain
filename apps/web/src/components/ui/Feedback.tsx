import { AlertTriangle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { Button } from './Button';

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center', className)}>
      <svg viewBox="0 0 24 24" className="size-5 animate-spin text-label-secondary" aria-hidden>
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="2.5"
        />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Quiet placeholder blocks while data loads. */
export function Skeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="h-4 animate-pulse rounded-md bg-fill"
          style={{ width: `${90 - ((i * 17) % 40)}%` }}
        />
      ))}
    </div>
  );
}

export function LoadingPane({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <Spinner label={label} />
    </div>
  );
}

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, children, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-1 flex-col items-center justify-center px-8 py-14 text-center',
        className,
      )}
    >
      {Icon ? (
        <Icon aria-hidden className="mb-3 size-9 text-label-tertiary" strokeWidth={1.25} />
      ) : null}
      <p className="text-[17px] font-semibold text-label">{title}</p>
      {children ? (
        <div className="mt-1 max-w-sm text-[14px] leading-snug text-label-secondary">
          {children}
        </div>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { title, detail } = errorMessage(error);
  return (
    <EmptyState
      icon={AlertTriangle}
      title={title}
      action={
        onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    >
      <span role="alert">{detail}</span>
    </EmptyState>
  );
}

const PILL_TONES = {
  green: 'bg-green-tint text-green',
  orange: 'bg-orange-tint text-orange',
  gray: 'bg-gray-tint text-label-secondary',
  blue: 'bg-accent-tint text-accent-text',
  red: 'bg-red-tint text-red',
} as const;

export function Pill({
  tone = 'gray',
  children,
  className,
}: {
  tone?: keyof typeof PILL_TONES;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-full px-2 text-[12px] font-medium whitespace-nowrap',
        PILL_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone = status === 'active' ? 'green' : status === 'paused' ? 'orange' : 'gray';
  return <Pill tone={tone}>{status.charAt(0).toUpperCase() + status.slice(1)}</Pill>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] bg-fill px-1 font-sans text-[11px] font-medium text-label-secondary">
      {children}
    </kbd>
  );
}
