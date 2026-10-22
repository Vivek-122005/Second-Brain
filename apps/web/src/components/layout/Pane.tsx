import { ChevronLeft, PanelLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useUi } from '../../lib/ui-context';
import { IconButton } from '../ui/Button';
import { RouterAnchor } from '../ui/RouterAnchor';

/**
 * List + detail columns. On phones only one is visible: the list until something is selected,
 * then the detail (with a back button in its header).
 */
export function SplitView({
  list,
  detail,
  hasSelection,
  listLabel,
}: {
  list: ReactNode;
  detail: ReactNode;
  hasSelection: boolean;
  listLabel: string;
}) {
  return (
    <div className="flex min-w-0 flex-1">
      <section
        aria-label={listLabel}
        className={cn(
          'hairline-r w-full flex-col bg-canvas md:flex md:w-[300px] md:shrink-0 xl:w-[340px]',
          hasSelection ? 'hidden' : 'flex',
        )}
      >
        {list}
      </section>
      <section
        aria-label="Detail"
        className={cn(
          'min-w-0 flex-1 flex-col bg-canvas md:flex',
          hasSelection ? 'flex' : 'hidden',
        )}
      >
        {detail}
      </section>
    </div>
  );
}

/** Toolbar row at the top of a column. */
export function PaneHeader({
  title,
  subtitle,
  actions,
  backHref,
  showSidebarToggle,
  className,
  titleId,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Shows a back button on phones (the list is hidden there while a detail is open). */
  backHref?: string;
  /** Shows the sidebar button below the desktop breakpoint. */
  showSidebarToggle?: boolean;
  className?: string;
  titleId?: string;
}) {
  const { openSidebar } = useUi();
  return (
    <header
      className={cn(
        'material hairline-b sticky top-0 z-10 flex min-h-[52px] shrink-0 items-center gap-1.5 px-3 py-2',
        className,
      )}
    >
      {showSidebarToggle ? (
        <IconButton label="Show sidebar" onClick={openSidebar} className="lg:hidden">
          <PanelLeft className="size-[18px]" strokeWidth={1.75} aria-hidden />
        </IconButton>
      ) : null}
      {backHref ? (
        <RouterAnchor
          href={backHref}
          className="inline-flex h-8 items-center rounded-control pr-2 text-[15px] text-accent-text hover:bg-hover md:hidden"
        >
          <ChevronLeft className="size-5" strokeWidth={2} aria-hidden />
          Back
        </RouterAnchor>
      ) : null}
      <div className="min-w-0 flex-1 px-1">
        {title ? (
          <h1 id={titleId} className="truncate text-[15px] font-semibold text-label">
            {title}
          </h1>
        ) : null}
        {subtitle ? <p className="truncate text-[12px] text-label-secondary">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
    </header>
  );
}

/** A full-width page (no list column) with a large title, like iOS Settings. */
export function Page({
  title,
  subtitle,
  actions,
  children,
  width = 'md',
  grouped = true,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  width?: 'md' | 'lg';
  /** Grouped background (for inset grouped lists). */
  grouped?: boolean;
}) {
  return (
    <div className={cn('flex min-w-0 flex-1 flex-col', grouped ? 'bg-grouped' : 'bg-canvas')}>
      <PaneHeader
        showSidebarToggle
        actions={actions}
        className={actions ? undefined : 'lg:hidden'}
      />
      <div className="flex-1 overflow-y-auto">
        <div
          className={cn(
            'mx-auto px-4 pt-6 pb-16 sm:px-8',
            width === 'md' ? 'max-w-[760px]' : 'max-w-[1040px]',
          )}
        >
          <div className="mb-6 px-1">
            <h1 className="text-[28px] leading-tight font-bold tracking-tight text-label sm:text-[32px]">
              {title}
            </h1>
            {subtitle ? <p className="mt-1 text-[15px] text-label-secondary">{subtitle}</p> : null}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
