'use client';

import { useEffect, useState } from 'react';
import { getSystemCapacityOverview } from '../../actions/maintenance';
import { getAuth } from '../../routes/dashboard/detail/shared';
import { formatBytes } from '../../utils';

interface AppRow {
  name: string;
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
  allocatedLimit: string;
  status: string;
}

interface Capacity {
  system: {
    cpuCount: number;
    totalMemoryBytes: number;
    totalCpuPercent: number;
    totalMemUsageBytes: number;
  };
  apps: AppRow[];
}

/**
 * Quiet single-line strip at the top of /dashboard. Click to expand the
 * per-app capacity breakdown. Detailed view used to live in /dashboard/settings;
 * it's an observation surface, so it belongs with the rest of the dashboard.
 */
export function HostStatusStrip() {
  const [cap, setCap] = useState<Capacity | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const auth = getAuth();
        if (!auth) return;
        const data = (await getSystemCapacityOverview(auth.username, auth.token)) as Capacity;
        if (!cancelled) setCap(data);
      } catch {
        // strip is non-critical
      }
    }
    load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!cap) {
    // Skeleton — same height + layout as the loaded state so the page
    // doesn't shift when data arrives. The eyebrow stays visible the whole
    // time; values fade in from "—" placeholders.
    return (
      <div className="mb-5 flex items-center text-[11px] font-mono text-text-tertiary/60 tabular-nums">
        <span className="eyebrow mr-3 text-text-tertiary/60">Host</span>
        <span className="mr-3">cpu —</span>
        <span className="mx-2 text-text-tertiary/30">·</span>
        <span className="mr-3">mem —</span>
        <span className="mx-2 text-text-tertiary/30">·</span>
        <span>cores —</span>
        <span className="flex-1" />
        <span className="text-text-tertiary/50 text-[10px]">loading…</span>
      </div>
    );
  }

  const cpuPct = cap.system.totalCpuPercent / (cap.system.cpuCount * 100);
  const memPct = cap.system.totalMemUsageBytes / cap.system.totalMemoryBytes;
  const cpuTone = cpuPct >= 0.9 ? 'danger' : cpuPct >= 0.7 ? 'warning' : 'default';
  const memTone = memPct >= 0.9 ? 'danger' : memPct >= 0.7 ? 'warning' : 'default';
  const toneClass = (t: 'default' | 'warning' | 'danger') =>
    t === 'danger' ? 'text-danger' : t === 'warning' ? 'text-warning' : 'text-text';

  return (
    <div className="mb-5">
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center text-left text-[11px] font-mono text-text-tertiary tabular-nums hover:text-text-secondary transition-colors"
      >
        <span className="eyebrow mr-3">Host</span>
        <span className="mr-3">
          cpu <span className={toneClass(cpuTone)}>{cap.system.totalCpuPercent.toFixed(1)}%</span>
        </span>
        <span className="mx-2 text-text-tertiary/50">·</span>
        <span className="mr-3">
          mem{' '}
          <span className={toneClass(memTone)}>{formatBytes(cap.system.totalMemUsageBytes)}</span>
          <span className="text-text-tertiary"> / {formatBytes(cap.system.totalMemoryBytes)}</span>
        </span>
        <span className="mx-2 text-text-tertiary/50">·</span>
        <span>
          cores <span className="text-text">{cap.system.cpuCount}</span>
        </span>
        <span className="flex-1" />
        <span className="flex items-center gap-1 text-text-tertiary text-[10px]">
          {expanded ? 'hide breakdown' : `${cap.apps.length} apps · show breakdown`}
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
            aria-hidden
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>

      {expanded && cap.apps.length > 0 && (
        <div className="mt-2.5 card p-3 sm:p-4">
          {/* Top-line bars */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <CapacityBar
              label="CPU"
              valueLabel={`${cap.system.totalCpuPercent.toFixed(1)}% of ${cap.system.cpuCount} cores`}
              fraction={cpuPct}
            />
            <CapacityBar
              label="Memory"
              valueLabel={`${formatBytes(cap.system.totalMemUsageBytes)} of ${formatBytes(cap.system.totalMemoryBytes)}`}
              fraction={memPct}
            />
          </div>

          <p className="eyebrow mb-2">Per-app usage</p>
          <ul className="divide-y divide-border">
            {cap.apps.map((app) => (
              <li key={app.name} className="flex items-center justify-between py-1.5">
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      app.status === 'running' ? 'bg-success' : 'bg-bg-active'
                    }`}
                    aria-hidden
                  />
                  <span className="text-xs font-mono truncate">{app.name}</span>
                </span>
                <span className="flex items-center gap-4 shrink-0 text-[11px] font-mono text-text-secondary tabular-nums">
                  <span className="w-16 text-right">{app.cpuPercent.toFixed(1)}% cpu</span>
                  <span className="w-32 text-right">
                    {formatBytes(app.memUsageBytes)} / {app.allocatedLimit}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CapacityBar({
  label,
  valueLabel,
  fraction,
}: {
  label: string;
  valueLabel: string;
  fraction: number;
}) {
  const tone = fraction >= 0.9 ? 'bg-danger' : fraction >= 0.7 ? 'bg-warning' : 'bg-accent';
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">{label}</span>
        <span className="text-[11px] font-mono text-text-secondary tabular-nums">{valueLabel}</span>
      </div>
      <div className="w-full h-2 bg-bg-hover rounded-full overflow-hidden mt-1">
        <div
          className={`h-full rounded-full transition-all ${tone}`}
          style={{ width: `${Math.min(100, fraction * 100)}%` }}
        />
      </div>
    </div>
  );
}
