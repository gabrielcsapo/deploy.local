'use client';

import type { ReactNode } from 'react';
import { formatBytes } from '../../utils';

export interface FleetTotals {
  apps: number;
  running: number;
  unhealthy: number;
  totalRps: number;
  totalCpuPercent: number;
  totalMemUsageBytes: number;
  totalMemLimitBytes: number;
  errorRatePct: number;
  requestsLastMin: number;
}

/**
 * Fleet-wide pulse strip. One row, four signals, monospace numerals.
 * State color (warning / danger) is applied ONLY to the sub-label so the
 * numerals stay white and don't compete with the Needs-Attention banner
 * for the operator's eye.
 *
 * "Capacity" is labelled as fleet (summed-app) CPU + memory — distinct
 * from the host eyebrow above which shows physical host totals.
 */
export function FleetStrip({ totals }: { totals: FleetTotals | null }) {
  if (!totals) {
    return <div className="h-[60px] mb-4" aria-hidden />;
  }

  const memPct =
    totals.totalMemLimitBytes > 0
      ? (totals.totalMemUsageBytes / totals.totalMemLimitBytes) * 100
      : 0;

  return (
    <div className="card-hero mb-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-white/[0.04] relative">
        <FleetMetric
          label="Apps"
          primary={`${totals.running}/${totals.apps}`}
          secondary={totals.unhealthy > 0 ? `${totals.unhealthy} need attention` : 'all healthy'}
          subTone={totals.unhealthy > 0 ? 'warning' : 'default'}
        />
        <FleetMetric
          label="Requests/sec"
          primary={totals.totalRps < 1 ? totals.totalRps.toFixed(2) : totals.totalRps.toFixed(1)}
          secondary={`${totals.requestsLastMin.toLocaleString()} in last min`}
        />
        <FleetMetric
          label="Error rate · 60s"
          primary={`${totals.errorRatePct.toFixed(1)}%`}
          secondary="5xx in last minute"
          subTone={
            totals.errorRatePct > 5
              ? 'danger'
              : totals.errorRatePct > 1
                ? 'warning'
                : 'default'
          }
        />
        <FleetMetric
          label="Capacity"
          primary={`${totals.totalCpuPercent.toFixed(0)}%`}
          secondary={`cpu · ${formatBytes(totals.totalMemUsageBytes)} mem (${memPct.toFixed(0)}%)`}
          subTone={
            totals.totalCpuPercent > 95 || memPct > 95
              ? 'danger'
              : totals.totalCpuPercent > 80 || memPct > 80
                ? 'warning'
                : 'default'
          }
        />
      </div>
    </div>
  );
}

const subToneClass: Record<string, string> = {
  default: 'text-text-tertiary',
  warning: 'text-warning',
  danger: 'text-danger',
};

// Stripe/Vercel-style stat block. Value stays neutral white at all times;
// state lives in the sublabel where the eye looks for it anyway.
function FleetMetric({
  label,
  primary,
  secondary,
  subTone = 'default',
}: {
  label: string;
  primary: ReactNode;
  secondary: ReactNode;
  subTone?: 'default' | 'warning' | 'danger';
}) {
  return (
    <div className="relative p-4 sm:p-5 min-w-0">
      <p className="eyebrow mb-1.5">{label}</p>
      <p className="font-mono text-2xl sm:text-3xl font-semibold leading-none tabular-nums truncate text-text">
        {primary}
      </p>
      <p
        className={`text-xs mt-2 truncate ${subToneClass[subTone]} ${
          subTone !== 'default' ? 'font-medium' : ''
        }`}
      >
        {secondary}
      </p>
    </div>
  );
}
