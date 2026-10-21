'use client';
import { IconButton } from '@/components/ui';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-flight-router/client';
import { Toggle } from '@/components/ui';
import { fetchRecentFleetActivity } from '../../actions/deployments';
import { getAuth } from './detail/shared';
import { LoadingState, ErrorBanner } from '../../components/LoadingState';
import { EmptyState } from '../../components/dashboard/EmptyState';
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
  deploy: 'Deploy',
  'graph:recovered': 'Recovered',
  'restart:web': 'Restart web',
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
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return;
    try {
      const data = (await fetchRecentFleetActivity(
        auth.username,
        auth.token,
        100,
      )) as ActivityRow[];
      setActivity(data);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Activity could not be loaded.');
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
  const liveDeploymentNames = useMemo(
    () => new Set(deployments.map((deployment) => deployment.name)),
    [deployments],
  );

  if (error && !activity)
    return (
      <ErrorBanner
        message={error}
        action={<IconButton icon="refresh" label="Retry activity" onClick={() => void load()} />}
      />
    );

  return (
    <div className="ds-activity">
      <div className="ds-pane-toolbar flex-wrap">
        <div>
          <p className="text-xs text-text-tertiary mt-0.5 tabular-nums">
            {activity ? `${activity.length} events · live` : 'loading…'}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="ds-activity-group">
            <Toggle label="Group repeats" enabled={grouped} onChange={() => setGrouped(!grouped)} />
            <span>Group repeats</span>
          </div>
          {actions.length > 0 && (
            <div className="flex items-center gap-1 p-0.5 rounded-lg bg-bg/40 border border-white/[0.04]">
              <button
                type="button"
                onClick={() => setFilter('all')}
                aria-pressed={filter === 'all'}
                className={`px-2.5 py-1 text-caption font-mono rounded-md transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg ${
                  filter === 'all'
                    ? 'text-on-action'
                    : 'text-text-tertiary hover:text-text-secondary'
                }`}
                style={
                  filter === 'all'
                    ? { background: 'var(--ds-action)', color: 'var(--ds-onAction)' }
                    : undefined
                }
              >
                all
              </button>
              {actions.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setFilter(a)}
                  aria-pressed={filter === a}
                  className={`px-2.5 py-1 text-caption font-mono rounded-md transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg ${
                    filter === a ? 'text-on-action' : 'text-text-tertiary hover:text-text-secondary'
                  }`}
                  style={
                    filter === a
                      ? { background: 'var(--ds-action)', color: 'var(--ds-onAction)' }
                      : undefined
                  }
                >
                  {ACTION_LABEL[a] ?? a.replaceAll(':', ' ').replaceAll('-', ' ')}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && (
        <ErrorBanner
          message={error}
          action={<IconButton icon="refresh" label="Retry activity" onClick={() => void load()} />}
        />
      )}
      {!activity && !error ? (
        <LoadingState />
      ) : deployments.length === 0 ? (
        <EmptyState
          title="No application activity yet"
          description="Deployment events appear here as applications change."
        />
      ) : filtered.length === 0 ? (
        <div className="ds-feedback">
          No <span className="text-text">{ACTION_LABEL[filter] ?? filter}</span> events in the
          current window.{' '}
          {filter !== 'all' && (
            <button
              type="button"
              onClick={() => setFilter('all')}
              aria-pressed={filter === 'all'}
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
                  const label =
                    ACTION_LABEL[e.action] ?? e.action.replaceAll(':', ' ').replaceAll('-', ' ');
                  const tone = ACTION_TONE[e.action] ?? 'text-text-secondary';
                  const content = (
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <span title={e.action} className={`ds-activity-action ${tone}`}>
                          {label}
                        </span>
                        <span className="font-mono text-sm text-text truncate">
                          {e.deploymentName}
                        </span>
                        {e.count > 1 && (
                          <span className="badge badge-accent text-caption px-1.5 py-0 tabular-nums">
                            ×{e.count}
                          </span>
                        )}
                        {e.source && (
                          <span className="ds-activity-source text-caption font-mono text-text-tertiary truncate">
                            via {e.source}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 shrink-0 text-caption font-mono tabular-nums">
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
                        <span className="ds-activity-absolute hidden sm:inline text-text-tertiary/60">
                          {formatAbsolute(e.timestamp)}
                        </span>
                      </div>
                    </div>
                  );
                  return (
                    <li key={e.id}>
                      {liveDeploymentNames.has(e.deploymentName) ? (
                        <Link
                          to={`/dashboard/${encodeURIComponent(e.deploymentName)}${e.action === 'deploy' ? '/releases' : ''}`}
                          className="block px-4 py-3 hover:bg-bg-hover/40 transition-colors"
                        >
                          {content}
                        </Link>
                      ) : (
                        <div
                          className="px-4 py-3 opacity-75"
                          title="This app has been deleted; its historical event is retained."
                        >
                          {content}
                        </div>
                      )}
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
