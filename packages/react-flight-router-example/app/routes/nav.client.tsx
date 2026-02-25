"use client";

import { Link } from "react-flight-router/client";

const links = [
  { to: "/", label: "Home", end: true },
  { to: "/about", label: "About", end: true },
  { to: "/dashboard", label: "Dashboard", end: false },
  { to: "/posts", label: "Blog", end: false },
  { to: "/slow", label: "Slow", end: true },
  { to: "/explore", label: "Explore", end: false },
];

export function MainNav() {
  return (
    <nav className="bg-gray-100 px-8 py-4 border-b border-gray-200">
      <ul className="flex gap-6 list-none">
        {links.map(({ to, label, end }) => (
          <li key={to}>
            <Link
              to={to}
              end={end}
              className={({ isActive, isPending }) =>
                isActive
                  ? "text-blue-600 font-semibold"
                  : isPending
                    ? "text-blue-400 animate-pulse"
                    : "text-gray-700 hover:text-blue-500"
              }
            >
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function DashboardNav() {
  return (
    <nav className="my-4">
      <div className="flex gap-4">
        <Link
          to="/dashboard"
          className={({ isActive, isPending }) =>
            isActive
              ? "text-blue-600 font-semibold"
              : isPending
                ? "text-blue-400 animate-pulse"
                : "text-gray-600 hover:text-blue-500"
          }
        >
          Overview
        </Link>
        <Link
          to="/dashboard/settings"
          className={({ isActive, isPending }) =>
            isActive
              ? "text-blue-600 font-semibold"
              : isPending
                ? "text-blue-400 animate-pulse"
                : "text-gray-600 hover:text-blue-500"
          }
        >
          Settings
        </Link>
      </div>
    </nav>
  );
}
