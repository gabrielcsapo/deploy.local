'use client';

import { EmptyState } from './EmptyState';
import { AlertTriangleIcon } from './icons';

export interface ErrorPathRow {
  path: string;
  total: number;
  errors: number;
  errorRate: number;
}

export function TopErrorPaths({ rows }: { rows: ErrorPathRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="card p-4">
        <p className="text-xs text-text-tertiary mb-2">Top error paths</p>
        <EmptyState
          icon={<AlertTriangleIcon />}
          title="No errors recorded"
          description="When 4xx/5xx responses happen they'll be ranked here."
        />
      </div>
    );
  }
  const maxErrors = Math.max(...rows.map((r) => r.errors), 1);
  return (
    <div className="card p-3 sm:p-4">
      <p className="text-xs text-text-tertiary mb-3">Top error paths</p>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.path} className="text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono truncate" title={r.path}>
                {r.path}
              </span>
              <span className="font-mono shrink-0 text-text-secondary tabular-nums">
                {r.errors.toLocaleString()}{' '}
                <span className="text-text-tertiary">({r.errorRate}%)</span>
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-bg-hover overflow-hidden">
              <div
                className="h-full bg-danger"
                style={{ width: `${(r.errors / maxErrors) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
