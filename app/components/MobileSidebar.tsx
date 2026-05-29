'use client';

import { useState, useEffect } from 'react';

export function MobileSidebar({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

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
        className="md:hidden fixed top-3 left-3 z-50 p-2 rounded-md bg-bg-surface border border-border shadow-sm"
        aria-label="Toggle navigation"
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
        className={`${
          open ? 'translate-x-0' : '-translate-x-full'
        } md:translate-x-0 fixed md:sticky z-40 top-0 md:top-14 left-0 h-full md:h-[calc(100vh-3.5rem)] w-56 md:w-60 shrink-0 bg-bg-surface md:bg-bg/60 md:backdrop-blur-sm border-r border-border md:border-border/60 p-6 md:px-5 md:py-6 transition-transform duration-200 ease-in-out overflow-y-auto`}
      >
        {children}
      </aside>
    </>
  );
}
