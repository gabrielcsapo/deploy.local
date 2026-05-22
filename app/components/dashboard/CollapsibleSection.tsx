'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDownIcon } from './icons';

export function CollapsibleSection({
  title,
  description,
  defaultOpen = true,
  children,
  actions,
  className = '',
}: {
  title: ReactNode;
  description?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`card ${className}`}>
      <header className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex-1 flex items-center gap-2 text-left min-h-[40px]"
        >
          <ChevronDownIcon
            className={`transition-transform ${open ? '' : '-rotate-90'} text-text-tertiary`}
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{title}</p>
            {description && (
              <p className="text-xs text-text-tertiary mt-0.5 line-clamp-2">{description}</p>
            )}
          </div>
        </button>
        {actions && <div className="shrink-0">{actions}</div>}
      </header>
      {open && <div className="p-4">{children}</div>}
    </section>
  );
}
