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
        `relative flex items-center gap-2 text-sm pl-3 pr-2 py-2 min-h-[36px] rounded-md transition-all duration-150 ${
          isActive
            ? 'text-text bg-bg-hover font-medium shadow-[inset_0_0_0_1px_hsl(266_90%_66%_/_0.18),0_4px_18px_-8px_hsl(266_90%_50%_/_0.55)] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-r before:bg-[image:var(--gradient-brand)]'
            : 'text-text-secondary hover:text-text hover:bg-bg-hover'
        }`
      }
    >
      {icon && <span className="text-text-tertiary shrink-0">{icon}</span>}
      <span className="truncate">{children}</span>
      {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
    </Link>
  );
}
