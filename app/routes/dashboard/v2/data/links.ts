'use client';
import { useEffect } from 'react';
import { adoptSession } from './adopt-session.ts';
import { prefetchRSC, clearPrefetchCache, useRouter } from 'react-flight-router/client';

type Click = Pick<
  MouseEvent,
  'defaultPrevented' | 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'
>;
type Anchor = Pick<HTMLAnchorElement, 'href' | 'target' | 'hasAttribute' | 'getAttribute'>;

/**
 * Where a click on a link should go inside the dashboard without loading the page again, or null
 * when the browser should follow it: another site, an API download, a new tab, or a link the page
 * handles itself.
 */
export function inAppPath(anchor: Anchor, event: Click, origin: string) {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return null;
  if (anchor.getAttribute('data-reload') !== null) return null;
  const url = new URL(anchor.href, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/dashboard')) return null;
  return url.pathname + url.search + url.hash;
}

/**
 * The dashboard's links are plain anchors; this sends a click on one through the router, so moving
 * between pages and tabs keeps the sidebar and what is already loaded instead of reloading it all.
 */
export function useInAppLinks() {
  const { navigate } = useRouter();
  useEffect(() => {
    void adoptSession();
    const identityChanged = (event: StorageEvent) => {
      if (event.key === 'deploy-sh-auth' || event.key === null) {
        clearPrefetchCache();
        void adoptSession();
      }
    };
    window.addEventListener('storage', identityChanged);
    const click = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const to = inAppPath(anchor, event, window.location.origin);
      if (!to) return;
      const here = window.location.pathname + window.location.search;
      // A jump within this page is the browser's to make.
      if (to.startsWith(here + '#')) return;
      event.preventDefault();
      if (to !== here)
        void adoptSession().then(() =>
          navigate(
            to,
            /^\/dashboard\/projects(?:\/|\?|$)/.test(to) ? { retainContent: true } : undefined,
          ),
        );
    };
    // After the page's own handlers, so a link that handles its click itself keeps doing so.
    let timer: ReturnType<typeof setTimeout>;
    const intent = (event: Event) => {
      const anchor = (event.target as Element | null)?.closest?.(
        '.v2-project-page a.dl-item[href]',
      );
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/dashboard/projects/'))
        return;
      clearTimeout(timer);
      const prefetch = () => void adoptSession().then(() => prefetchRSC(url.pathname + url.search));
      if (event.type === 'focusin') prefetch();
      else timer = setTimeout(prefetch, 80);
    };
    const cancel = () => clearTimeout(timer);
    document.addEventListener('click', click);
    document.addEventListener('pointerover', intent);
    document.addEventListener('pointerout', cancel);
    document.addEventListener('focusin', intent);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('storage', identityChanged);
      document.removeEventListener('click', click);
      document.removeEventListener('pointerover', intent);
      document.removeEventListener('pointerout', cancel);
      document.removeEventListener('focusin', intent);
    };
  }, [navigate]);
}
