'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams, Link } from 'react-flight-router/client';
import {
  fetchRequestSeries,
  fetchDeployHistory,
  restartDeployment as serverRestart,
  recreateDeployment as serverRecreate,
  stopDeployment as serverStop,
  startDeployment as serverStart,
} from '../../../actions/deployments';
import { fetchMetricsHistory } from '../../../actions/metrics';
import { getAuth, useDetailContext } from './shared';
import { useToast } from '../../../components/Toaster';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { ErrorBanner } from '../../../components/LoadingState';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import type { ChartEvent } from '../../../components/dashboard/chart-events';
import { RpsOverTime, type RpsPoint } from '../../../components/dashboard/RpsOverTime';
import { LatencyOverTime, type LatencyPoint } from '../../../components/dashboard/LatencyOverTime';
import { StatusCodeDonut } from '../../../components/dashboard/StatusCodeDonut';
import { MiniSparkline } from '../../../components/dashboard/Sparkline';
import {
  TimeRange,
  resolvePreset,
  type TimeRangeValue,
  type TimeRangePreset,
} from '../../../components/dashboard/TimeRange';
import { ResourcesIcon } from '../../../components/dashboard/icons';
import { formatBytes } from '../../../utils';

// ── URL ↔ preset mapping (shared with Requests/Resources tabs) ──────────────

function presetFromParam(p: string | null): Exclude<TimeRangePreset, 'custom'> {
  switch (p) {
    case '6h':
      return '6h';
    case '24h':
      return '24h';
    case '7d':
      return '7d';
    case '30d':
      return '30d';
    default:
      return '1h';
  }
}

function rangeToMinutes(r: TimeRangeValue): number {
  return Math.max(1, Math.round((r.toMs - r.fromMs) / 60_000));
}

// ── Combined RPS + latency series row ───────────────────────────────────────
// getRequestSeries returns one bucket array containing both status counts
// (RpsPoint shape) and p50/p95/p99 (LatencyPoint shape) per row.
type SeriesRow = RpsPoint & LatencyPoint;

interface DeployEventRow {
  id: number;
  action: string;
  timestamp: string;
  durationMs: number | null;
  source: string | null;
  buildLogId: number | null;
}

interface MetricSample {
  cpuPercent: number;
  memPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  timestamp: number;
}

// Pretty "5m ago" / "2h ago" labels for the activity timeline.
function formatAgo(iso: string): string {
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

const ACTION_LABELS: Record<string, string> = {
  deploy: 'Deployed',
  restart: 'Restarted',
  recreate: 'Recreated',
  stop: 'Stopped',
  start: 'Started',
  delete: 'Deleted',
  backup: 'Backup',
  restore: 'Restored',
  'env-update': 'Env update',
  'volumes-update': 'Volumes update',
  'ports-update': 'Ports update',
  'memory-update': 'Memory update',
  'gpu-update': 'GPU update',
  'privileged-docker-update': 'Privileged update',
};

const ACTION_TONE: Record<string, string> = {
  deploy: 'text-accent',
  restart: 'text-warning',
  recreate: 'text-warning',
  stop: 'text-danger',
  start: 'text-accent',
  delete: 'text-danger',
  restore: 'text-warning',
};

// ── Page component ──────────────────────────────────────────────────────────

export default function Component() {
  const { deployment, fetchDeployment, fetchInspect } = useDetailContext();
  const name = deployment.name;
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();

  const [timeRange, setTimeRange] = useState<TimeRangeValue>(() =>
    resolvePreset(presetFromParam(searchParams.get('range'))),
  );

  function handleRangeChange(next: TimeRangeValue) {
    setTimeRange(next);
    const p = new URLSearchParams(searchParams);
    if (next.preset === 'custom' || next.preset === '1h') p.delete('range');
    else p.set('range', next.preset);
    setSearchParams(p);
  }

  const [series, setSeries] = useState<{ bucketMs: number; series: SeriesRow[] } | null>(null);
  const [metrics, setMetrics] = useState<MetricSample[]>([]);
  const [history, setHistory] = useState<DeployEventRow[]>([]);
  const [actionError, setActionError] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [recreating, setRecreating] = useState(false);
  const [togglingPower, setTogglingPower] = useState(false);
  const [confirmingRecreate, setConfirmingRecreate] = useState(false);

  const fetchAll = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return;
    try {
      const minutes = rangeToMinutes(timeRange);
      const [seriesData, metricsData, historyData] = await Promise.all([
        fetchRequestSeries(auth.username, auth.token, name, timeRange.fromMs, timeRange.toMs),
        fetchMetricsHistory(name, minutes),
        fetchDeployHistory(auth.username, auth.token, name),
      ]);
      setSeries(seriesData as { bucketMs: number; series: SeriesRow[] });
      setMetrics(metricsData as MetricSample[]);
      // History rows come back in insertion order; flip to newest-first and
      // cap at 8 for the inline timeline. The full list is on the Activity tab.
      const sorted = (historyData as DeployEventRow[])
        .slice()
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setHistory(sorted.slice(0, 8));
    } catch {
      // best-effort — empty states render gracefully
    }
  }, [name, timeRange]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Refresh on a 30s timer so the charts stay roughly live without us having
  // to hand-merge each WS event into the series buckets.
  useEffect(() => {
    const t = setInterval(fetchAll, 30_000);
    return () => clearInterval(t);
  }, [fetchAll]);

  // React to discrete state changes immediately rather than waiting for the
  // poll. metrics:update and request:logged fire often — we use them as
  // hints and re-fetch the rolled-up series instead of mutating it in-place.
  const channels = useMemo(() => [`deployment:${name}`], [name]);
  const handleEvent = useCallback(
    (event: { type: string }) => {
      if (event.type === 'deployment:status' || event.type === 'build:complete') {
        fetchAll();
        fetchDeployment();
      }
    },
    [fetchAll, fetchDeployment],
  );
  useWebSocket(channels, handleEvent);

  async function handleRestart() {
    const auth = getAuth();
    if (!auth) return;
    setActionError('');
    setRestarting(true);
    try {
      await serverRestart(auth.username, auth.token, name);
      toast('restart', { type: 'success', title: 'Container restarted' });
      fetchDeployment();
      fetchInspect();
      fetchAll();
    } catch (e) {
      setActionError((e as Error).message);
      toast('restart', {
        type: 'error',
        title: 'Restart failed',
        description: (e as Error).message,
      });
    } finally {
      setRestarting(false);
    }
  }

  async function handleStop() {
    const auth = getAuth();
    if (!auth) return;
    setActionError('');
    setTogglingPower(true);
    try {
      await serverStop(auth.username, auth.token, name);
      toast('power', { type: 'success', title: 'Container stopped' });
      fetchDeployment();
      fetchInspect();
      fetchAll();
    } catch (e) {
      setActionError((e as Error).message);
      toast('power', {
        type: 'error',
        title: 'Stop failed',
        description: (e as Error).message,
      });
    } finally {
      setTogglingPower(false);
    }
  }

  async function handleStart() {
    const auth = getAuth();
    if (!auth) return;
    setActionError('');
    setTogglingPower(true);
    try {
      await serverStart(auth.username, auth.token, name);
      toast('power', { type: 'success', title: 'Container started' });
      fetchDeployment();
      fetchInspect();
      fetchAll();
    } catch (e) {
      setActionError((e as Error).message);
      toast('power', {
        type: 'error',
        title: 'Start failed',
        description: (e as Error).message,
      });
    } finally {
      setTogglingPower(false);
    }
  }

  async function handleRecreate() {
    const auth = getAuth();
    if (!auth) return;
    setActionError('');
    setRecreating(true);
    toast('recreate', {
      type: 'loading',
      title: 'Recreating container...',
      description: 'Applying latest settings',
    });
    try {
      await serverRecreate(auth.username, auth.token, name);
      toast('recreate', {
        type: 'success',
        title: 'Container recreated',
        description: 'All settings applied',
      });
      fetchDeployment();
      fetchInspect();
      fetchAll();
    } catch (e) {
      setActionError((e as Error).message);
      toast('recreate', {
        type: 'error',
        title: 'Recreate failed',
        description: (e as Error).message,
      });
    } finally {
      setRecreating(false);
    }
  }

  // Materialize deploy history into ChartEvents for the time-axis charts.
  // Each chart filters into its own bucket window — we just provide the
  // full list. Memoized so we don't allocate on every render.
  const chartEvents = useMemo<ChartEvent[]>(
    () =>
      history.map((e) => ({
        ts: new Date(e.timestamp).getTime(),
        kind: e.action,
        label: (ACTION_LABELS[e.action] ?? e.action).toUpperCase(),
        detail: e.source ? `via ${e.source}` : undefined,
      })),
    [history],
  );

  // Sum status counts across the visible window for the donut.
  const statusCounts = useMemo(() => {
    if (!series) return { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 };
    return series.series.reduce(
      (acc, p) => ({
        s2xx: acc.s2xx + p.s2xx,
        s3xx: acc.s3xx + p.s3xx,
        s4xx: acc.s4xx + p.s4xx,
        s5xx: acc.s5xx + p.s5xx,
      }),
      { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 },
    );
  }, [series]);

  const emptySeries: SeriesRow[] = [];

  // Power toggle: show Stop when running, Start when stopped/exited. Hidden
  // during transitional states (building/uploading/starting) where neither
  // applies cleanly.
  const isRunning = deployment.status === 'running';
  const isStopped = ['exited', 'stopped', 'created'].includes(deployment.status);
  const busy = restarting || recreating || togglingPower;

  return (
    <div className="space-y-4">
      {actionError && <ErrorBanner message={actionError} />}

      {/* Header row: shared time-range + inline ops actions */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <TimeRange value={timeRange} onChange={handleRangeChange} />
        <div className="flex items-center gap-2">
          {isStopped && (
            <button
              type="button"
              onClick={handleStart}
              disabled={busy}
              className="btn btn-sm text-xs"
            >
              {togglingPower ? 'Starting…' : 'Start'}
            </button>
          )}
          {isRunning && (
            <button
              type="button"
              onClick={handleStop}
              disabled={busy}
              className="btn btn-sm text-xs"
            >
              {togglingPower ? 'Stopping…' : 'Stop'}
            </button>
          )}
          <button
            type="button"
            onClick={handleRestart}
            disabled={busy || isStopped}
            className="btn btn-sm text-xs"
          >
            {restarting ? 'Restarting…' : 'Restart'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmingRecreate(true)}
            disabled={busy}
            className="btn btn-sm btn-danger text-xs"
          >
            {recreating ? 'Recreating…' : 'Recreate'}
          </button>
        </div>
      </div>

      {/* Derive ChartEvents from deploy history so the time-axis charts
          below can mark when each operation happened. Filter to the
          chart's visible window upstream — the chart components do their
          own bucket-aware filtering, but limiting here saves us iterating
          the full history on every render. */}
      {(() => null)()}
      {/* 2×2 chart grid — the operational core of the page */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <RpsOverTime
          series={series?.series ?? emptySeries}
          bucketMs={series?.bucketMs ?? 60_000}
          events={chartEvents}
        />
        <LatencyOverTime series={series?.series ?? emptySeries} events={chartEvents} />
        <StatusCodeDonut counts={statusCounts} />
        <ResourcePanel metrics={metrics} name={name} />
      </div>

      {/* Recent activity */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="eyebrow font-semibold">Recent activity</h3>
          <Link
            to={`/dashboard/${name}/history`}
            className="text-xs font-mono text-text-tertiary hover:text-accent"
          >
            view all →
          </Link>
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-text-tertiary">No activity yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {history.map((e) => {
              const label = ACTION_LABELS[e.action] ?? e.action;
              const tone = ACTION_TONE[e.action] ?? 'text-text-secondary';
              return (
                <li key={e.id} className="py-2 flex items-center justify-between gap-3">
                  <span className="flex items-center gap-3 min-w-0">
                    <span className={`text-xs font-mono uppercase tracking-wider ${tone}`}>
                      {label}
                    </span>
                    {e.source && (
                      <span className="text-[10px] font-mono text-text-tertiary uppercase">
                        via {e.source}
                      </span>
                    )}
                    {e.durationMs != null && (
                      <span className="text-text-tertiary font-mono text-[10px] tabular-nums">
                        {(e.durationMs / 1000).toFixed(1)}s
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] font-mono text-text-tertiary tabular-nums shrink-0">
                    {formatAgo(e.timestamp)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmingRecreate}
        title={`Recreate ${name}?`}
        message="Stops the container and rebuilds it with the latest settings. Any in-memory state is lost. Persisted volumes survive."
        confirmLabel="Recreate"
        danger
        requireTypedConfirmation={name}
        onConfirm={() => {
          setConfirmingRecreate(false);
          handleRecreate();
        }}
        onCancel={() => setConfirmingRecreate(false)}
      />
    </div>
  );
}

// ── Resource panel ──────────────────────────────────────────────────────────
// CPU + memory in one card with mini sparklines. Full versions of these
// charts live on the Resources tab; this is the at-a-glance read.

function ResourcePanel({ metrics, name }: { metrics: MetricSample[]; name: string }) {
  const cpuData = metrics.map((m) => m.cpuPercent);
  const memData = metrics.map((m) => m.memUsageBytes);
  const latest = metrics.length ? metrics[metrics.length - 1] : null;
  const cpuLabel = latest ? `${latest.cpuPercent.toFixed(1)}%` : '—';
  const memLabel = latest ? formatBytes(latest.memUsageBytes) : '—';
  const memSub =
    latest && latest.memLimitBytes > 0
      ? `${latest.memPercent.toFixed(0)}% of ${formatBytes(latest.memLimitBytes)}`
      : null;

  const cpuTone =
    latest && latest.cpuPercent >= 90
      ? 'var(--color-danger)'
      : latest && latest.cpuPercent >= 70
        ? 'var(--color-warning)'
        : 'var(--color-accent)';
  const memTone =
    latest && latest.memPercent >= 90
      ? 'var(--color-danger)'
      : latest && latest.memPercent >= 70
        ? 'var(--color-warning)'
        : 'var(--color-success)';

  return (
    <div className="card p-3 sm:p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="eyebrow">Resource use</p>
        <Link
          to={`/dashboard/${name}/resources`}
          className="text-xs font-mono text-text-tertiary hover:text-accent inline-flex items-center gap-1"
        >
          <span aria-hidden>
            <ResourcesIcon />
          </span>
          View →
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">
              CPU
            </span>
            <span className="text-base font-mono font-semibold tabular-nums">{cpuLabel}</span>
          </div>
          {cpuData.length > 1 ? (
            <MiniSparkline data={cpuData} color={cpuTone} height={56} />
          ) : (
            <div className="h-[56px] flex items-center justify-center text-[10px] font-mono text-text-tertiary">
              collecting…
            </div>
          )}
        </div>
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">
              Memory
            </span>
            <span className="text-base font-mono font-semibold tabular-nums">{memLabel}</span>
          </div>
          {memData.length > 1 ? (
            <MiniSparkline data={memData} color={memTone} height={56} />
          ) : (
            <div className="h-[56px] flex items-center justify-center text-[10px] font-mono text-text-tertiary">
              collecting…
            </div>
          )}
          {memSub && <p className="text-[10px] font-mono text-text-tertiary mt-1">{memSub}</p>}
        </div>
      </div>
    </div>
  );
}
