'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useDialogFocus } from './useDialogFocus';

export function MobileSidebar({
  children,
  ariaLabel = 'Dashboard navigation',
  variant = 'dashboard',
}: {
  children: React.ReactNode;
  ariaLabel?: string;
  variant?: 'dashboard' | 'docs';
}) {
  const [open, setOpen] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDialogFocus(open, asideRef, close);

  // Close on route change (clicking a link)
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if ((e.target as HTMLElement).closest('a')) {
        setOpen(false);
      }
    }
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className={`fixed left-3 z-[60] rounded-[7px] border border-border bg-bg-elevated p-2 shadow-sm md:hidden ${
          variant === 'docs' ? 'top-[62px]' : 'top-2'
        }`}
        aria-label={open ? 'Close navigation' : 'Open navigation'}
        aria-expanded={open}
        aria-controls={`mobile-${variant}-navigation`}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {open ? (
            <>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </>
          ) : (
            <>
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </>
          )}
        </svg>
      </button>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setOpen(false)} />
      )}
      <aside
        id={`mobile-${variant}-navigation`}
        ref={asideRef}
        aria-label={ariaLabel}
        className={`${variant === 'docs' ? 'docs-navigation-rail' : 'dashboard-rail'} ${
          open ? 'translate-x-0' : '-translate-x-full'
        } fixed left-0 top-0 z-40 h-full w-64 shrink-0 overflow-y-auto border-r border-border px-4 py-5 transition-transform duration-200 ease-in-out md:sticky md:w-[248px] md:translate-x-0 ${
          variant === 'docs'
            ? 'md:top-[76px] md:h-[calc(100vh-96px)]'
            : 'md:top-[52px] md:h-[calc(100vh-52px)]'
        }`}
      >
        {children}
      </aside>
    </>
  );
}
