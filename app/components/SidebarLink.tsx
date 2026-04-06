'use client';

import { Link } from 'react-flight-router/client';

export function SidebarLink({
  to,
  end,
  children,
}: {
  to: string;
  end?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      end={end}
      className={({ isActive }: { isActive: boolean }) =>
        `block text-sm px-2 py-1 rounded-md transition-colors ${isActive ? 'text-text bg-bg-hover font-medium' : 'text-text-secondary hover:text-text hover:bg-bg-hover'}`
      }
    >
      {children}
    </Link>
  );
}
