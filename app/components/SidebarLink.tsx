'use client';

import { Link } from 'react-flight-router/client';
import type { ReactNode } from 'react';

export function SidebarLink({
  to,
  end,
  icon,
  children,
  trailing,
  hint,
}: {
  to: string;
  end?: boolean;
  icon?: ReactNode;
  children: React.ReactNode;
  /** Slot for an indicator pill, badge, or dot rendered at the right edge. */
  trailing?: ReactNode;
  /** Tooltip text — useful for nav items whose label needs a one-line
      clarifier (e.g. Activity vs Logs). */
  hint?: string;
}) {
  return (
    <Link
      to={to}
      end={end}
      title={hint}
      className={({ isActive }: { isActive: boolean }) =>
        `group relative flex min-h-[38px] items-center gap-2.5 rounded-[7px] py-2 pl-3 pr-2 text-[13px] transition-all duration-150 ${
          isActive
            ? 'bg-accent/10 font-medium text-text ring-1 ring-inset ring-accent/20 before:absolute before:-left-[17px] before:top-1/2 before:h-2 before:w-2 before:-translate-y-1/2 before:rounded-full before:bg-accent before:shadow-[0_0_0_4px_rgb(124_156_255_/_0.08)] after:absolute after:-left-[13px] after:top-1/2 after:h-px after:w-3 after:bg-accent/70'
            : 'text-text-secondary hover:bg-bg-hover/70 hover:text-text'
        }`
      }
    >
      {icon && (
        <span className="shrink-0 text-text-tertiary transition-colors group-hover:text-text-secondary">
          {icon}
        </span>
      )}
      <span className="truncate">{children}</span>
      {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
    </Link>
  );
}
