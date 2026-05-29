'use client';

import { Link } from 'react-flight-router/client';
import { MiniSparkline } from './Sparkline';
import { formatBytes } from '../../utils';
import { appUrl } from '../../routes/dashboard/detail/shared';

export type Severity = 'healthy' | 'degraded' | 'down' | 'idle' | 'building';

export interface AppCardData {
  name: string;
  status: string;
  severity: Severity;
  crashLooping: boolean;
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
  rps: number;
  errPct: number;
  p95: number;
  requestsLastMin: number;
  /** Rolling RPS samples for the sparkline; oldest → newest. */
  rpsHistory: number[];
}

const severityRing: Record<Severity, string> = {
  healthy: 'ring-1 ring-success/30',
  degraded: 'ring-1 ring-warning/45 bg-warning/[0.04]',
  down: 'ring-1 ring-danger/50 bg-danger/[0.04]',
  idle: 'ring-1 ring-border/60',
  building: 'ring-1 ring-warning/35',
};

const severityDot: Record<Severity, string> = {
  healthy: 'bg-success',
  degraded: 'bg-warning',
  down: 'bg-danger',
  idle: 'bg-text-tertiary',
  building: 'bg-warning animate-pulse',
};

const severityLabel: Record<Severity, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  down: 'Down',
  idle: 'Idle',
  building: 'Building',
};

/**
 * Per-app card on the dashboard grid. One card = one line in the old table,
 * but rendered like a Heroku tile: status dot, name, live RPS sparkline,
 * CPU + memory bars, p95, and error rate — all visible at a glance.
 *
 * The whole card is a Link to /dashboard/<name>. The app-URL chip inside
 * has stopPropagation so opening the app doesn't navigate to the detail view.
 */
export function AppCard({ data }: { data: AppCardData }) {
  const sparkColor =
    data.severity === 'down'
      ? 'var(--color-danger)'
      : data.severity === 'degraded'
        ? 'var(--color-warning)'
        : 'var(--color-accent)';

  const cpuTone =
    data.cpuPercent > 90 ? 'bg-danger' : data.cpuPercent > 70 ? 'bg-warning' : 'bg-accent';
  const memTone =
    data.memPercent > 90 ? 'bg-danger' : data.memPercent > 70 ? 'bg-warning' : 'bg-accent';

  return (
    <Link
      to={`/dashboard/${data.name}`}
      className={`card p-4 flex flex-col gap-3 hover:border-border-hover transition-colors group ${severityRing[data.severity]}`}
    >
      {/* Header: status + name + open-app chip */}
      <div className="flex items-center gap-2">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${severityDot[data.severity]}`}
          aria-label={severityLabel[data.severity]}
        />
        <span className="text-sm font-semibold truncate flex-1">{data.name}</span>
        {data.crashLooping && (
          <span
            className="badge badge-warning text-[9.5px] px-1.5 py-0 leading-tight"
            title="Container has restarted 3+ times in the last 5 minutes"
          >
            restart loop
          </span>
        )}
        <a
          href={appUrl(data.name)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-[11px] font-mono text-text-tertiary hover:text-accent transition-colors shrink-0"
        >
          {data.name}.local ↗
        </a>
      </div>

      {/* Top-line numbers: rps · p95 · err */}
      <div className="grid grid-cols-3 gap-2 -mx-1">
        <NumberCell
          label="req/s"
          value={data.rps < 1 ? data.rps.toFixed(2) : data.rps.toFixed(1)}
        />
        <NumberCell
          label="p95"
          value={data.p95 > 0 ? `${Math.round(data.p95)}ms` : '—'}
          tone={data.p95 > 5000 ? 'danger' : data.p95 > 1000 ? 'warning' : 'default'}
        />
        <NumberCell
          label="err"
          value={`${data.errPct.toFixed(1)}%`}
          tone={data.errPct > 5 ? 'danger' : data.errPct > 1 ? 'warning' : 'default'}
        />
      </div>

      {/* RPS sparkline */}
      <div className="-mx-1">
        {data.rpsHistory.length > 1 ? (
          <MiniSparkline data={data.rpsHistory} color={sparkColor} height={28} />
        ) : (
          <div
            className="h-[28px] flex items-center justify-center text-[10px] font-mono text-text-tertiary"
            aria-hidden
          >
            {data.severity === 'idle' ? 'no traffic' : 'collecting…'}
          </div>
        )}
      </div>

      {/* CPU + memory bars */}
      <div className="space-y-2">
        <ResourceBar
          label="cpu"
          fraction={Math.min(1, data.cpuPercent / 100)}
          right={`${data.cpuPercent.toFixed(1)}%`}
          barClass={cpuTone}
        />
        <ResourceBar
          label="mem"
          fraction={Math.min(1, data.memPercent / 100)}
          right={
            data.memLimitBytes > 0
              ? `${formatBytes(data.memUsageBytes)} / ${formatBytes(data.memLimitBytes)}`
              : formatBytes(data.memUsageBytes)
          }
          barClass={memTone}
        />
      </div>
    </Link>
  );
}

function NumberCell({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warning' | 'danger';
}) {
  const color =
    tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-text';
  return (
    <div className="px-1">
      <p className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider">{label}</p>
      <p className={`font-mono text-base font-semibold tabular-nums leading-tight ${color}`}>
        {value}
      </p>
    </div>
  );
}

function ResourceBar({
  label,
  fraction,
  right,
  barClass,
}: {
  label: string;
  fraction: number;
  right: string;
  barClass: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-[10.5px] font-mono text-text-tertiary mb-0.5 tabular-nums">
        <span className="uppercase tracking-wider">{label}</span>
        <span className="text-text-secondary">{right}</span>
      </div>
      <div className="h-1.5 bg-bg-hover rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barClass}`}
          style={{ width: `${Math.max(2, fraction * 100)}%` }}
        />
      </div>
    </div>
  );
}
