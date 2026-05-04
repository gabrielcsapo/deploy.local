"use client";

import { Link, useLocation } from "react-flight-router/client";

const tabs = [
  { to: "/tabs", label: "Overview", end: true },
  { to: "/tabs/settings", label: "Settings", end: true },
  { to: "/tabs/activity", label: "Activity", end: true },
];

export function TabsNav() {
  const location = useLocation();

  return (
    <nav className="my-4" data-testid="tabs-nav">
      <div className="flex gap-4 border-b border-gray-200 pb-2">
        {tabs.map(({ to, label }) => {
          return (
            <Link
              key={to}
              to={to}
              className={({ isActive: linkActive, isPending }) =>
                linkActive
                  ? "text-blue-600 font-semibold border-b-2 border-blue-600 pb-2 -mb-[10px]"
                  : isPending
                    ? "text-blue-400 animate-pulse pb-2 -mb-[10px]"
                    : "text-gray-600 hover:text-blue-500 pb-2 -mb-[10px]"
              }
            >
              {label}
            </Link>
          );
        })}
      </div>
      <p className="text-xs text-gray-400 mt-2" data-testid="tabs-location">
        Current path: {location.pathname}
      </p>
    </nav>
  );
}
