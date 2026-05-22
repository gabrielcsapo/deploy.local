'use client';

import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-flight-router/client';
import {
  fetchFleetSeries,
  fetchRecentFleetActivity,
} from '../../actions/deployments';
import { getAuth } from '../../routes/dashboard/detail/shared';
import { MiniSparkline } from './Sparkline';
import type { ChartEvent } from './chart-events';

interface FleetSeriesPoint {
  bucket: number;
  total: number;
  errors: number;
}

interface ActivityRow {
  id: number;
  deploymentName: string;
  action: string;
  source: string | null;
  durationMs: number | null;
  timestamp: string;
}

const ACTION_LABEL: Record<string, string> = {
  deploy: 'deploy',
  restart: 'restart',
  recreate: 'recreate',
  delete: 'delete',
  backup: 'backup',
  restore: 'restore',
  'env-update': 'env',
  'volumes-update': 'volumes',
  'ports-update': 'ports',
  'memory-update': 'memory',
  'gpu-update': 'gpu',
  'privileged-docker-update': 'privileged',
};

const ACTION_TONE: Record<string, string> = {
  deploy: 'text-accent',
  restart: 'text-warning',
  recreate: 'text-warning',
  delete: 'text-danger',
  restore: 'text-warning',
};

/**
 * Collapse consecutive same-app + same-action events into one row with a
 * count badge. Keeps the most recent timestamp of the group. Without this
 * the activity feed reads as log spam during noisy deploy days
 * ("DEPLOY medius" × 8 in a row).
 */
interface ActivityGroup {
  firstId: number;
  deploymentName: string;
  action: string;
  count: number;
  latestTimestamp: string;
}

function collapseRepeats(rows: ActivityRow[]): ActivityGroup[] {
  const out: ActivityGroup[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.deploymentName === row.deploymentName && last.action === row.action) {
      last.count++;
      // Rows arrive newest-first, so the first row in a streak already has
      // the latest timestamp; nothing else to update.
    } else {
      out.push({
        firstId: row.id,
        deploymentName: row.deploymentName,
        action: row.action,
        count: 1,
        latestTimestamp: row.timestamp,
      });
    }
  }
  return out;
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

type RangeKey = '1h' | '6h' | '24h';
const RANGE_MS: Record<RangeKey, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

/**
 * Fleet-wide "command center" panel below the FleetStrip:
 *  - Two sparklines: total RPS and total errors over a time range
 *  - Recent activity feed across all apps (deploys, restarts, etc.)
 *
 * Polls every 30s. The fleet aggregate (`dashboard:aggregate` WS event)
 * already keeps the FleetStrip's "current value" reading live; this panel
 * is for the trailing view.
 */
export function FleetActivityPanel() {
  const [range, setRange] = useState<RangeKey>('6h');
  const [series, setSeries] = useState<FleetSeriesPoint[] | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [actionFilter, setActionFilter] = useState<string>('all');

  const load = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return;
    const now = Date.now();
    try {
      const [seriesData, actData] = await Promise.all([
        fetchFleetSeries(auth.username, auth.token, now - RANGE_MS[range], now),
        // Fetch a generous slice so we can collapse repeats and still show a
        // meaningful row count. The dedicated /dashboard/activity page picks
        // up where this preview stops.
        fetchRecentFleetActivity(auth.username, auth.token, 25),
      ]);
      setSeries((seriesData as { series: FleetSeriesPoint[] }).series);
      setActivity(actData as ActivityRow[]);
    } catch {
      // best-effort
    }
  }, [range]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const rpsData = series ? series.map((p) => p.total) : [];
  const errorData = series ? series.map((p) => p.errors) : [];
  const sparkTimestamps = series ? series.map((p) => p.bucket) : [];
  const totalReq = series ? series.reduce((s, p) => s + p.total, 0) : 0;
  const totalErr = series ? series.reduce((s, p) => s + p.errors, 0) : 0;
  const peakRps = series && series.length > 0 ? Math.max(...rpsData) : 0;
  const errRate = totalReq > 0 ? (totalErr / totalReq) * 100 : 0;

  // Materialize the activity feed into ChartEvents so the fleet traffic
  // and 5xx sparklines can correlate spikes with deploys/restarts.
  const sparkEvents: ChartEvent[] = activity.map((a) => ({
    ts: new Date(a.timestamp).getTime(),
    kind: a.action,
    label: (ACTION_LABEL[a.action] ?? a.action).toUpperCase(),
    detail: a.deploymentName,
  }));

  // Series-bucket duration → request count, for converting peak count to "rps"
  const bucketSec =
    series && series.length >= 2 ? (series[1].bucket - series[0].bucket) / 1000 : 60;
  const peakRate = bucketSec > 0 ? peakRps / bucketSec : 0;

  return (
    <div className="card-hero mb-4 sm:mb-5 overflow-hidden">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(0,360px)] divide-y lg:divide-y-0 lg:divide-x divide-white/[0.04] relative">
        {/* Left: sparklines */}
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="eyebrow">Fleet traffic</p>
            <div className="flex gap-1 p-0.5 rounded-lg bg-bg/40 border border-white/[0.04]">
              {(Object.keys(RANGE_MS) as RangeKey[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={`relative px-2 py-0.5 text-[10px] font-mono rounded-md transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg ${
                    range === r
                      ? 'text-white shadow-[0_0_0_1px_hsl(266_90%_66%/0.35),0_4px_14px_-4px_hsl(266_90%_50%/0.5)]'
                      : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/60'
                  }`}
                  style={range === r ? { background: 'var(--gradient-nav)' } : undefined}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <SparkRow
              label="Total req"
              current={totalReq.toLocaleString()}
              sub={`peak ${peakRate.toFixed(1)}/s`}
              data={rpsData}
              color="var(--color-accent)"
              timestamps={sparkTimestamps}
              events={sparkEvents}
              valueLabel="req"
            />
            <SparkRow
              label="5xx errors"
              current={totalErr.toLocaleString()}
              sub={errRate > 0 ? `${errRate.toFixed(2)}% of traffic` : 'none in window'}
              data={errorData}
              color={totalErr > 0 ? 'var(--color-danger)' : 'var(--color-text-tertiary)'}
              timestamps={sparkTimestamps}
              events={sparkEvents}
              valueLabel="errors"
            />
          </div>
        </div>

        {/* Right: recent activity feed */}
        <div className="p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <p className="eyebrow">Recent activity</p>
            <div className="flex items-center gap-2">
              <select
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
                className="text-[10px] font-mono uppercase tracking-wider bg-bg/40 border border-white/[0.04] rounded-md px-1.5 py-0.5 text-text-tertiary hover:text-text-secondary cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label="Filter activity by action"
              >
                <option value="all">all</option>
                {Array.from(new Set(activity.map((a) => a.action)))
                  .sort()
                  .map((a) => (
                    <option key={a} value={a}>
                      {ACTION_LABEL[a] ?? a}
                    </option>
                  ))}
              </select>
              <Link
                to="/dashboard/activity"
                className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary hover:text-accent transition-colors"
              >
                view all →
              </Link>
            </div>
          </div>
          {activity.length === 0 ? (
            <p className="text-xs text-text-tertiary">No activity yet.</p>
          ) : (() => {
            const filtered =
              actionFilter === 'all'
                ? activity
                : activity.filter((a) => a.action === actionFilter);
            const grouped = collapseRepeats(filtered).slice(0, 6);
            if (grouped.length === 0) {
              return (
                <p className="text-xs text-text-tertiary py-1">
                  No <span className="text-text">{ACTION_LABEL[actionFilter] ?? actionFilter}</span>{' '}
                  events in this window.
                </p>
              );
            }
            return (
            // Cap the preview at 6 grouped rows so the card height stays
            // close to the Fleet Traffic column. Anything older flows
            // through "view all →".
            <ul className="divide-y divide-border/60">
              {grouped.map((g) => {
                const label = ACTION_LABEL[g.action] ?? g.action;
                const tone = ACTION_TONE[g.action] ?? 'text-text-secondary';
                return (
                  <li
                    key={g.firstId}
                    className="py-1.5 flex items-center justify-between gap-2"
                  >
                    <Link
                      to={`/dashboard/${g.deploymentName}/history`}
                      className="flex items-center gap-2 min-w-0 hover:text-accent transition-colors"
                    >
                      <span className={`text-[10px] font-mono uppercase tracking-wider ${tone}`}>
                        {label}
                      </span>
                      <span className="font-mono text-xs truncate">{g.deploymentName}</span>
                      {g.count > 1 && (
                        <span className="badge badge-accent text-[9px] px-1.5 py-0 tabular-nums">
                          ×{g.count}
                        </span>
                      )}
                    </Link>
                    <span className="text-[10px] font-mono text-text-tertiary tabular-nums shrink-0">
                      {formatAgo(g.latestTimestamp)}
                    </span>
                  </li>
                );
              })}
            </ul>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

function SparkRow({
  label,
  current,
  sub,
  data,
  color,
  timestamps,
  events,
  valueLabel,
}: {
  label: string;
  current: string;
  sub: string;
  data: number[];
  color: string;
  timestamps?: number[];
  events?: ChartEvent[];
  valueLabel?: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,140px)_1fr] items-center gap-3">
      <div>
        <p className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">{label}</p>
        <p className="text-lg font-mono font-semibold tabular-nums leading-tight">{current}</p>
        <p className="text-[10px] font-mono text-text-tertiary tabular-nums">{sub}</p>
      </div>
      <div className="-mb-1">
        {data.length > 1 ? (
          <MiniSparkline
            data={data}
            color={color}
            height={42}
            gradient={color === 'var(--color-accent)'}
            timestamps={timestamps}
            events={events}
            label={valueLabel}
            formatter={(v) => v.toFixed(0)}
          />
        ) : (
          <div
            className="h-[42px] flex items-center justify-center text-[10px] font-mono text-text-tertiary"
            aria-hidden
          >
            collecting…
          </div>
        )}
      </div>
    </div>
  );
}
