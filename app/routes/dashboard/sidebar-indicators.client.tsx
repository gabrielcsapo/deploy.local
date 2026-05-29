'use client';

import { useDashboardData } from './data.client';

/**
 * Red pulsing dot rendered as the `trailing` slot on the Apps sidebar link
 * when any deployment is down or degraded. Lets operators see "something
 * is wrong" without having to navigate into the Apps view first.
 */
export function UnhealthyAppsDot() {
  const { problemApps } = useDashboardData();
  if (problemApps.length === 0) return null;
  const down = problemApps.some((a) => a.severity === 'down');
  return (
    <span
      className={`relative inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-mono tabular-nums font-semibold ${
        down
          ? 'bg-danger/20 text-danger ring-1 ring-danger/40'
          : 'bg-warning/20 text-warning ring-1 ring-warning/40'
      }`}
      title={`${problemApps.length} app${problemApps.length === 1 ? '' : 's'} need attention`}
    >
      {problemApps.length}
      <span
        aria-hidden
        className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${
          down ? 'bg-danger' : 'bg-warning'
        } animate-pulse`}
      />
    </span>
  );
}
