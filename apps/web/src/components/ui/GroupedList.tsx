import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { RouterAnchor } from './RouterAnchor';

interface GroupedSectionProps {
  title?: ReactNode;
  /** Right-aligned control in the header row (e.g. a "See all" link). */
  action?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Accessible label when the title is not plain text. */
  'aria-label'?: string;
}

/** iOS Settings style inset grouped list: a rounded card of rows with hairline separators. */
export function GroupedSection({
  title,
  action,
  footer,
  children,
  className,
  ...rest
}: GroupedSectionProps) {
  return (
    <section className={cn('mb-8', className)} aria-label={rest['aria-label']}>
      {title || action ? (
        <div className="mb-1.5 flex items-end justify-between gap-3 px-4">
          {title ? (
            <h2 className="text-[13px] font-medium tracking-wide text-label-secondary uppercase">
              {title}
            </h2>
          ) : (
            <span />
          )}
          {action}
        </div>
      ) : null}
      <ul className="overflow-hidden rounded-card bg-cell shadow-soft ring-1 ring-separator">
        {children}
      </ul>
      {footer ? (
        <div className="mt-1.5 px-4 text-[13px] leading-snug text-label-secondary">{footer}</div>
      ) : null}
    </section>
  );
}

interface RowProps {
  children: ReactNode;
  /** Leading icon or badge. */
  leading?: ReactNode;
  /** Trailing detail (value, badge, button). */
  trailing?: ReactNode;
  /** Makes the whole row an in-app link with a disclosure chevron. */
  href?: string;
  onClick?: () => void;
  className?: string;
}

const rowBase =
  'group relative flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left after:absolute after:right-0 after:bottom-0 after:left-4 after:h-px after:bg-separator last:after:hidden';

/** A single row in a GroupedSection. */
export function Row({ children, leading, trailing, href, onClick, className }: RowProps) {
  const content = (
    <>
      {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
      <span className="min-w-0 flex-1">{children}</span>
      {trailing ? (
        <span className="flex shrink-0 items-center gap-2 text-[14px] text-label-secondary">
          {trailing}
        </span>
      ) : null}
      {href || onClick ? (
        <ChevronRight aria-hidden className="size-4 shrink-0 text-label-tertiary" strokeWidth={2} />
      ) : null}
    </>
  );
  if (href) {
    return (
      <li className="relative last:[&>*]:after:hidden">
        <RouterAnchor
          href={href}
          className={cn(rowBase, 'transition-colors hover:bg-hover focus-visible:z-10', className)}
        >
          {content}
        </RouterAnchor>
      </li>
    );
  }
  if (onClick) {
    return (
      <li className="relative last:[&>*]:after:hidden">
        <button
          type="button"
          onClick={onClick}
          className={cn(rowBase, 'transition-colors hover:bg-hover focus-visible:z-10', className)}
        >
          {content}
        </button>
      </li>
    );
  }
  return <li className={cn(rowBase, className)}>{content}</li>;
}

/** Two-line row text: title + secondary line. */
export function RowText({
  title,
  subtitle,
  meta,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <span className="block min-w-0">
      <span className="block truncate text-[15px] text-label">{title}</span>
      {subtitle ? (
        <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-label-secondary">
          {subtitle}
        </span>
      ) : null}
      {meta ? <span className="mt-0.5 block text-[12px] text-label-secondary">{meta}</span> : null}
    </span>
  );
}
