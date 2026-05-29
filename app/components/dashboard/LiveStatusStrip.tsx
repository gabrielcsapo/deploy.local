'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-flight-router/client';
import { fetchHealth } from '../../actions/deployments';
import { getAuth } from '../../routes/dashboard/detail/shared';
import { useWebSocket } from '../../hooks/useWebSocket';
import { formatBytes } from '../../utils';
import { MiniSparkline } from './Sparkline';
import { ClockIcon, ResourcesIcon, RequestsIcon, AlertTriangleIcon, BuildIcon } from './icons';

interface Health {
  status: string;
  uptimeMs: number | null;
  cpu: number | null;
  memPct: number | null;
  memUsageBytes: number | null;
  memLimitBytes: number | null;
  rps: number | null;
  errPct: number | null;
  p95Ms: number | null;
  lastDeploy: {
    at: string;
    status: 'success' | 'failed' | 'unknown';
    durationMs: number | null;
  } | null;
  build: { status: string | null; at: string | null } | null;
}

function formatUptime(ms: number | null): string {
  if (ms == null || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h`;
}

function formatAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

const HISTORY_LEN = 30; // ~60s of CPU/mem ticks for inline sparkline

export function LiveStatusStrip({ name }: { name: string }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [memHistory, setMemHistory] = useState<number[]>([]);
  const [tick, setTick] = useState(0); // bumps on each metric/request event — keyed onto value for flash micro-animation

  const refresh = useCallback(async () => {
    try {
      const auth = getAuth();
      if (!auth) return;
      const data = (await fetchHealth(auth.username, auth.token, name)) as Health;
      setHealth(data);
      if (data.cpu != null) {
        setCpuHistory((h) => [...h, data.cpu!].slice(-HISTORY_LEN));
      }
      if (data.memPct != null) {
        setMemHistory((h) => [...h, data.memPct!].slice(-HISTORY_LEN));
      }
    } catch {
      // ignore — strip is non-critical
    }
  }, [name]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const channels = useMemo(() => [`deployment:${name}`], [name]);
  const handleEvent = useCallback(
    (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'metrics:update') {
        const point = event.data as unknown as {
          cpuPercent: number;
          memPercent: number;
          memUsageBytes: number;
          memLimitBytes: number;
        };
        setHealth((prev) =>
          prev
            ? {
                ...prev,
                cpu: point.cpuPercent,
                memPct: point.memPercent,
                memUsageBytes: point.memUsageBytes,
                memLimitBytes: point.memLimitBytes,
              }
            : prev,
        );
        setCpuHistory((h) => [...h, point.cpuPercent].slice(-HISTORY_LEN));
        setMemHistory((h) => [...h, point.memPercent].slice(-HISTORY_LEN));
        setTick((t) => t + 1);
      } else if (event.type === 'request:logged') {
        setTick((t) => t + 1);
      } else if (
        event.type === 'deployment:status' ||
        event.type === 'build:complete' ||
        event.type === 'deployment:created'
      ) {
        refresh();
      }
    },
    [refresh],
  );
  useWebSocket(channels, handleEvent);

  if (!health) return null;

  const cpuTone =
    health.cpu == null
      ? 'default'
      : health.cpu >= 90
        ? 'danger'
        : health.cpu >= 70
          ? 'warning'
          : 'success';
  const memTone =
    health.memPct == null
      ? 'default'
      : health.memPct >= 90
        ? 'danger'
        : health.memPct >= 70
          ? 'warning'
          : 'success';
  const errTone = !health.errPct
    ? 'default'
    : health.errPct >= 5
      ? 'danger'
      : health.errPct >= 1
        ? 'warning'
        : 'success';
  const p95Tone =
    health.p95Ms == null
      ? 'default'
      : health.p95Ms >= 5000
        ? 'danger'
        : health.p95Ms >= 1000
          ? 'warning'
          : 'success';
  const lastDeployTone =
    health.lastDeploy?.status === 'success'
      ? 'success'
      : health.lastDeploy?.status === 'failed'
        ? 'danger'
        : 'default';

  return (
    <div
      className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 snap-x snap-mandatory sm:snap-none scrollbar-thin"
      role="status"
      aria-label="Live deployment health"
    >
      <Pill
        icon={<ClockIcon />}
        label="Uptime"
        value={formatUptime(health.uptimeMs)}
        tone="default"
        to={`/dashboard/${name}/history`}
      />
      <Pill
        icon={<ResourcesIcon />}
        label="CPU"
        value={health.cpu != null ? `${health.cpu.toFixed(1)}%` : '—'}
        tone={cpuTone}
        sparkData={cpuHistory.length >= 2 ? cpuHistory : undefined}
        to={`/dashboard/${name}/resources?metric=cpu`}
      />
      <Pill
        icon={<ResourcesIcon />}
        label="Mem"
        value={
          health.memUsageBytes != null
            ? `${formatBytes(health.memUsageBytes)}${health.memPct != null ? ` · ${health.memPct.toFixed(0)}%` : ''}`
            : '—'
        }
        tone={memTone}
        sparkData={memHistory.length >= 2 ? memHistory : undefined}
        to={`/dashboard/${name}/resources?metric=memory`}
      />
      <Pill
        icon={<RequestsIcon />}
        label="Req/s"
        value={health.rps != null ? health.rps.toFixed(2) : '—'}
        tone="default"
        flash={tick}
        to={`/dashboard/${name}/requests`}
      />
      <Pill
        icon={<ClockIcon />}
        label="p95"
        value={health.p95Ms != null && health.p95Ms > 0 ? `${Math.round(health.p95Ms)}ms` : '—'}
        tone={p95Tone}
        to={`/dashboard/${name}/requests`}
      />
      <Pill
        icon={<AlertTriangleIcon />}
        label="Err"
        value={health.errPct != null ? `${health.errPct.toFixed(1)}%` : '—'}
        tone={errTone}
        to={`/dashboard/${name}/requests?status=5xx`}
      />
      <Pill
        icon={<BuildIcon />}
        label="Last deploy"
        value={health.lastDeploy ? formatAgo(health.lastDeploy.at) : '—'}
        tone={lastDeployTone}
        to={`/dashboard/${name}/history`}
      />
    </div>
  );
}

function Pill({
  icon,
  label,
  value,
  tone,
  sparkData,
  flash,
  to,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: 'default' | 'success' | 'warning' | 'danger';
  sparkData?: number[];
  flash?: number;
  /** When set, the pill becomes a link to the tab that holds this stat's
      full chart — e.g. CPU → Resources, p95 → Requests. */
  to?: string;
}) {
  // Full-pill tinting (not just a border) — the live status actually reads as alive.
  const toneClass: Record<typeof tone, string> = {
    default: 'border-border bg-bg-surface',
    success: 'border-success/30 bg-success/8',
    warning: 'border-warning/35 bg-warning/10',
    danger: 'border-danger/40 bg-danger/12',
  };
  const dotClass: Record<typeof tone, string> = {
    default: 'bg-text-tertiary',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
  };
  const sparkColor: Record<typeof tone, string> = {
    default: 'var(--color-text-tertiary)',
    success: 'var(--color-success)',
    warning: 'var(--color-warning)',
    danger: 'var(--color-danger)',
  };

  // Flash micro-animation when the `flash` counter changes (rendered via key).
  const flashKey = flash != null ? `f-${flash}` : undefined;

  const base = `shrink-0 snap-start inline-flex flex-col gap-1 px-3 py-2 rounded-lg border ${toneClass[tone]} min-w-[120px] transition-colors`;
  const interactiveCls = to
    ? 'hover:border-border-hover hover:bg-bg-hover cursor-pointer focus-visible:border-accent'
    : '';

  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-text-tertiary">
          <span aria-hidden>{icon}</span>
          <span className="text-[10px] font-mono uppercase tracking-wider">{label}</span>
        </span>
        {tone !== 'default' && (
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotClass[tone]}`} aria-hidden />
        )}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span key={flashKey} className="text-sm font-mono font-semibold text-text tabular-nums">
          {value}
        </span>
        {sparkData && sparkData.length >= 2 && (
          <span className="w-14 -mb-0.5">
            <MiniSparkline data={sparkData} color={sparkColor[tone]} height={18} width={56} />
          </span>
        )}
      </div>
    </>
  );

  if (to) {
    return (
      <Link
        to={to}
        className={`${base} ${interactiveCls}`}
        aria-label={`${label}: ${value} — open details`}
      >
        {inner}
      </Link>
    );
  }

  return <div className={base}>{inner}</div>;
}
