import { useRouter } from '@tanstack/react-router';
import { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from 'react';

interface RouterAnchorProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
}

/**
 * A real `<a href>` (so open-in-new-tab, copy link and screen readers work) that navigates
 * client-side for plain left clicks on in-app URLs.
 */
export const RouterAnchor = forwardRef<HTMLAnchorElement, RouterAnchorProps>(function RouterAnchor(
  { href, onClick, ...props },
  ref,
) {
  const router = useRouter();
  const internal = href.startsWith('/') && !href.startsWith('//');
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || !internal) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void router.navigate({ href });
  };
  return (
    <a
      ref={ref}
      href={href}
      onClick={handleClick}
      {...(!internal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...props}
    />
  );
});
