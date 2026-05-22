'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-flight-router/client';
import { fetchRecentFleetActivity } from '../../actions/deployments';
import { getAuth } from './detail/shared';
import { LoadingState } from '../../components/LoadingState';
import { useDashboardData } from './data.client';

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

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

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

/**
 * Collapse runs of same-app + same-action rows into a single row carrying
 * the count. Sequence-only — does not look across day boundaries (those
 * are inserted later by groupByDay). Same shape as ActivityRow so the
 * downstream renderer doesn't need to branch.
 */
interface CollapsedRow extends ActivityRow {
  count: number;
  collapsedIds?: number[];
}

function collapseRepeats(rows: ActivityRow[]): CollapsedRow[] {
  const out: CollapsedRow[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.deploymentName === row.deploymentName && last.action === row.action) {
      last.count++;
      last.collapsedIds = last.collapsedIds ?? [last.id];
      last.collapsedIds.push(row.id);
    } else {
      out.push({ ...row, count: 1 });
    }
  }
  return out;
}

function groupByDay<T extends ActivityRow>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const row of rows) {
    const date = new Date(row.timestamp);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    let key: string;
    if (date.toDateString() === today.toDateString()) {
      key = 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
      key = 'Yesterday';
    } else {
      key = date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    }
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(row as T);
  }
  return m;
}

/**
 * Activity — full deployment timeline across the fleet. Same data as the
 * compact card on the Overview, but with day-grouping, longer-tail history,
 * and per-action filtering.
 */
export default function ActivityClient() {
  // Pull deployments from the shell so the page can validate auth state in
  // the same way the other fleet routes do.
  const { deployments } = useDashboardData();
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [grouped, setGrouped] = useState(true);

  const load = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return;
    try {
      const data = (await fetchRecentFleetActivity(auth.username, auth.token, 100)) as ActivityRow[];
      setActivity(data);
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const actions = useMemo(() => {
    if (!activity) return [];
    const set = new Set(activity.map((a) => a.action));
    return Array.from(set).sort();
  }, [activity]);

  const filtered = useMemo<CollapsedRow[]>(() => {
    if (!activity) return [];
    const matched = filter === 'all' ? activity : activity.filter((a) => a.action === filter);
    return grouped ? collapseRepeats(matched) : matched.map((r) => ({ ...r, count: 1 }));
  }, [activity, filter, grouped]);

  const byDay = useMemo(() => groupByDay(filtered), [filtered]);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="prompt-h1">Activity</h1>
          <p className="text-xs text-text-tertiary mt-0.5 tabular-nums">
            {activity ? `${activity.length} events · live` : 'loading…'}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider cursor-pointer select-none">
            <input
              type="checkbox"
              checked={grouped}
              onChange={(e) => setGrouped(e.target.checked)}
              className="sr-only"
            />
            <span
              aria-hidden
              className="relative inline-flex items-center w-7 h-4 rounded-full transition-colors"
              style={
                grouped
                  ? { background: 'var(--gradient-nav)' }
                  : { background: 'var(--color-bg-hover)' }
              }
            >
              <span
                className={`absolute top-0.5 w-3 h-3 rounded-full bg-text transition-transform ${
                  grouped ? 'translate-x-3.5' : 'translate-x-0.5'
                }`}
              />
            </span>
            <span className={grouped ? 'text-text-secondary' : 'text-text-tertiary'}>
              Group repeats
            </span>
          </label>
          {actions.length > 0 && (
            <div className="flex items-center gap-1 p-0.5 rounded-lg bg-bg/40 border border-white/[0.04]">
              <button
                type="button"
                onClick={() => setFilter('all')}
                className={`px-2.5 py-1 text-[11px] font-mono rounded-md transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg ${
                  filter === 'all'
                    ? 'text-white shadow-[0_0_0_1px_hsl(266_90%_66%/0.35),0_4px_14px_-4px_hsl(266_90%_50%/0.5)]'
                    : 'text-text-tertiary hover:text-text-secondary'
                }`}
                style={filter === 'all' ? { background: 'var(--gradient-nav)' } : undefined}
              >
                all
              </button>
              {actions.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setFilter(a)}
                  className={`px-2.5 py-1 text-[11px] font-mono rounded-md transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg ${
                    filter === a
                      ? 'text-white shadow-[0_0_0_1px_hsl(266_90%_66%/0.35),0_4px_14px_-4px_hsl(266_90%_50%/0.5)]'
                      : 'text-text-tertiary hover:text-text-secondary'
                  }`}
                  style={filter === a ? { background: 'var(--gradient-nav)' } : undefined}
                >
                  {ACTION_LABEL[a] ?? a}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {!activity ? (
        <LoadingState />
      ) : deployments.length === 0 ? (
        <div className="card flex flex-col items-center text-center py-16 px-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl border border-white/[0.06] bg-bg/60 text-accent mb-4">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="size-5">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
              <path d="M12 7v5l3 2" />
            </svg>
          </div>
          <h2 className="text-base font-semibold tracking-tight mb-1.5">Nothing has happened yet</h2>
          <p className="text-sm text-text-secondary max-w-[44ch] leading-relaxed">
            Deploys, restarts, and config changes will show up here as soon as you ship something.
            Run <code className="font-mono text-text bg-bg-hover px-1.5 py-0.5 rounded">deploy</code>{' '}
            from any project directory to start.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-8 text-center text-sm text-text-tertiary">
          No <span className="text-text">{ACTION_LABEL[filter] ?? filter}</span> events in the
          current window.{' '}
          {filter !== 'all' && (
            <button
              type="button"
              onClick={() => setFilter('all')}
              className="text-accent hover:text-accent-hover transition-colors"
            >
              Show all
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {Array.from(byDay.entries()).map(([day, rows]) => (
            <section key={day}>
              <p className="eyebrow mb-2.5">{day}</p>
              <ul className="card divide-y divide-border/60 overflow-hidden">
                {rows.map((e) => {
                  const label = ACTION_LABEL[e.action] ?? e.action;
                  const tone = ACTION_TONE[e.action] ?? 'text-text-secondary';
                  return (
                    <li key={e.id}>
                      <Link
                        to={`/dashboard/${e.deploymentName}/history`}
                        className="block px-4 py-3 hover:bg-bg-hover/40 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <span
                              className={`text-[10px] font-mono uppercase tracking-wider w-16 shrink-0 ${tone}`}
                            >
                              {label}
                            </span>
                            <span className="font-mono text-sm text-text truncate">
                              {e.deploymentName}
                            </span>
                            {e.count > 1 && (
                              <span className="badge badge-accent text-[9px] px-1.5 py-0 tabular-nums">
                                ×{e.count}
                              </span>
                            )}
                            {e.source && (
                              <span className="text-[10px] font-mono text-text-tertiary truncate">
                                via {e.source}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 shrink-0 text-[11px] font-mono tabular-nums">
                            {e.count === 1 && e.durationMs != null && (
                              <span className="text-text-tertiary">
                                {(e.durationMs / 1000).toFixed(1)}s
                              </span>
                            )}
                            <span
                              className="text-text-tertiary"
                              title={new Date(e.timestamp).toLocaleString()}
                            >
                              {formatAgo(e.timestamp)}
                            </span>
                            <span className="hidden sm:inline text-text-tertiary/60">
                              {formatAbsolute(e.timestamp)}
                            </span>
                          </div>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
