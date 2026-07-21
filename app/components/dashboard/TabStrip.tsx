'use client';

import { useEffect, useRef } from 'react';
import { Link } from 'react-flight-router/client';
import type { ReactNode } from 'react';

export type TabDot = 'live' | 'success' | 'warning' | 'danger';

export interface TabDef {
  key: string;
  label: string;
  path: string;
  icon?: ReactNode;
  badge?: string | number;
  dot?: TabDot;
}

const dotClass: Record<TabDot, string> = {
  live: 'bg-success animate-pulse motion-reduce:animate-none',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export function TabStrip({
  tabs,
  active,
  className = '',
}: {
  tabs: TabDef[];
  active: string;
  className?: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollerRef.current) return;
    const el = scrollerRef.current.querySelector<HTMLElement>(`[data-tab-key="${active}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [active]);

  return (
    <div className={`relative ${className}`}>
      <div
        ref={scrollerRef}
        className="overflow-x-auto -mx-1 px-1 scrollbar-thin snap-x snap-mandatory sm:snap-none"
        style={{ scrollbarWidth: 'thin' }}
      >
        <div className="flex gap-1 min-w-max">
          {tabs.map((t) => {
            const isActive = active === t.key;
            return (
              <Link
                key={t.key}
                to={t.path}
                data-tab-key={t.key}
                className={`relative inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap snap-start min-h-[40px] transition-colors ${
                  isActive
                    ? 'text-text'
                    : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-surface'
                }`}
              >
                {t.icon && <span className="shrink-0">{t.icon}</span>}
                <span>{t.label}</span>
                {t.badge !== undefined && (
                  <span className="text-[10px] font-mono text-text-tertiary bg-bg-surface px-1.5 py-0.5 rounded tabular-nums">
                    {t.badge}
                  </span>
                )}
                {t.dot && (
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full ${dotClass[t.dot]}`}
                    aria-hidden
                  />
                )}
                {isActive && (
                  <span
                    className="absolute -bottom-px left-2 right-2 h-[2px] rounded-full vt-name"
                    style={{
                      ['--vt-name' as string]: 'tab-underline',
                      background: 'var(--gradient-nav)',
                      boxShadow: '0 0 12px -2px hsl(266 90% 60% / 0.5)',
                    }}
                    aria-hidden
                  />
                )}
              </Link>
            );
          })}
        </div>
      </div>
      {/* Edge fade — visible on every breakpoint so overflow is signaled on desktop too. */}
      <div
        className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-bg to-transparent"
        aria-hidden
      >
        <span className="absolute right-0.5 top-1/2 -translate-y-1/2 text-text-tertiary text-xs sm:hidden">
          ›
        </span>
      </div>
      <span className="sr-only">Tab list scrolls horizontally on smaller screens.</span>
    </div>
  );
}
