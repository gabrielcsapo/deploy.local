'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket, type WsEvent } from '../../hooks/useWebSocket';
import {
  VirtualLogViewer,
  TIMESTAMP_RE,
  type LogLine,
} from '../../components/VirtualLogViewer';
import { EmptyState } from '../../components/dashboard/EmptyState';
import {
  LogsIcon,
  SearchIcon,
  PauseIcon,
  PlayIcon,
  RotateIcon,
} from '../../components/dashboard/icons';
import { useDashboardData } from './data.client';

const MAX_LINES = 5_000;

// 7-color palette for per-app chips. Picked to read clearly on the violet
// dashboard background; each is distinct in hue so adjacent rows from
// different apps don't blend.
const APP_PALETTE = [
  'hsl(266 90% 70%)', // violet
  'hsl(320 88% 68%)', // pink
  'hsl(190 92% 62%)', // cyan
  'hsl(160 72% 56%)', // teal
  'hsl(36 92% 62%)',  // amber
  'hsl(220 90% 68%)', // blue
  'hsl(140 70% 60%)', // green
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function colorForApp(name: string): string {
  return APP_PALETTE[hashStr(name) % APP_PALETTE.length];
}

interface FleetLogLine extends LogLine {
  /** Monotonic id so React can key on incoming rows without inspecting content. */
  id: number;
}

/**
 * Fleet-wide live log tail. Subscribes to deployment:<name>:logs for every
 * deployment in the dashboard shell; incoming `container:logs` events are
 * tagged with their source app, given an app-chip color, and pushed into a
 * single interleaved scroll-back buffer.
 *
 * Live-tail only — there's no historical fetch. Users who want deep
 * history go to the per-app /dashboard/<name>/logs page, which has a
 * full historical fetch + virtualized viewer.
 */
export default function LogsClient() {
  const { deployments } = useDashboardData();

  const [lines, setLines] = useState<FleetLogLine[]>([]);
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<'all' | 'error' | 'warn' | 'info'>('all');
  const [appFilter, setAppFilter] = useState<Set<string>>(new Set()); // empty = all
  const [following, setFollowing] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(true);

  const idRef = useRef(0);
  const pendingRef = useRef<FleetLogLine[]>([]);
  const rafRef = useRef<number | null>(null);

  // Subscribe to every app's log channel. The shared WS hook handles
  // refcounted subscribe/unsubscribe so multiple components subscribing to
  // the same channel only opens one server stream.
  const channels = useMemo(
    () => deployments.map((d) => `deployment:${d.name}:logs`),
    [deployments],
  );

  const flushPending = useCallback(() => {
    rafRef.current = null;
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];
    setLines((prev) => {
      const combined = prev.concat(pending);
      return combined.length > MAX_LINES
        ? combined.slice(combined.length - MAX_LINES)
        : combined;
    });
  }, []);

  const handleEvent = useCallback(
    (event: WsEvent) => {
      if (event.type !== 'container:logs') return;
      const app = event.deploymentName;
      if (!app) return;
      const raw = String(event.data.line ?? '');
      const color = colorForApp(app);
      for (const part of raw.split('\n')) {
        if (!part) continue;
        const match = part.match(TIMESTAMP_RE);
        pendingRef.current.push({
          id: ++idRef.current,
          timestamp: match ? match[1] : null,
          content: match ? part.slice(match[0].length) : part,
          app,
          appColor: color,
        });
      }
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushPending);
      }
    },
    [flushPending],
  );

  const { connected } = useWebSocket(channels, handleEvent);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const filteredLines = useMemo(() => {
    let filtered: FleetLogLine[] = lines;
    if (appFilter.size > 0) {
      filtered = filtered.filter((l) => l.app && appFilter.has(l.app));
    }
    if (levelFilter !== 'all') {
      const patterns: Record<Exclude<typeof levelFilter, 'all'>, RegExp> = {
        error: /\b(error|err|fatal|panic|fail)/i,
        warn: /\b(warn|warning)/i,
        info: /\b(info|debug|trace|notice)/i,
      };
      filtered = filtered.filter((l) => patterns[levelFilter].test(l.content));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter((l) => l.content.toLowerCase().includes(q));
    }
    return filtered;
  }, [lines, search, levelFilter, appFilter]);

  function toggleApp(name: string) {
    setAppFilter((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function clearAppFilter() {
    setAppFilter(new Set());
  }

  return (
    <div className="flex flex-col h-[calc(100vh-9rem)] min-h-[400px]">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="prompt-h1">Logs</h1>
          <p className="text-xs text-text-tertiary mt-0.5 tabular-nums">
            Live tail across {deployments.length}{' '}
            {deployments.length === 1 ? 'app' : 'apps'}
            {connected && (
              <>
                {' · '}
                <span className="text-success">streaming</span>
              </>
            )}
          </p>
        </div>
      </div>

      {/* App filter chips */}
      {deployments.length > 0 && (
        <div className="mb-3 flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary mr-1">
            Apps:
          </span>
          <button
            type="button"
            onClick={clearAppFilter}
            className={`px-2 py-0.5 text-[11px] font-mono rounded-md transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg ${
              appFilter.size === 0
                ? 'text-white shadow-[0_0_0_1px_hsl(266_90%_66%/0.35)]'
                : 'text-text-tertiary hover:text-text-secondary bg-bg-surface'
            }`}
            style={appFilter.size === 0 ? { background: 'var(--gradient-nav)' } : undefined}
          >
            all
          </button>
          {deployments.map((d) => {
            const color = colorForApp(d.name);
            const selected = appFilter.has(d.name);
            return (
              <button
                key={d.name}
                type="button"
                onClick={() => toggleApp(d.name)}
                className="px-2 py-0.5 text-[11px] font-mono rounded-md transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg"
                style={
                  selected
                    ? {
                        background: `${color}22`,
                        color: color,
                        boxShadow: `inset 0 0 0 1px ${color}88`,
                      }
                    : {
                        background: 'var(--color-bg-surface)',
                        color: 'var(--color-text-tertiary)',
                      }
                }
              >
                <span
                  aria-hidden
                  className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
                  style={{ background: color }}
                />
                {d.name}
              </button>
            );
          })}
        </div>
      )}

      <section className="flex flex-col flex-1 min-h-0 card overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-wrap">
          <div className="flex items-center gap-1.5 flex-1 min-w-[140px]">
            <SearchIcon className="text-text-tertiary shrink-0" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search lines…"
              className="flex-1 min-w-0 bg-transparent text-xs text-text placeholder:text-text-tertiary focus:outline-none min-h-[32px]"
            />
          </div>
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as typeof levelFilter)}
            className="text-xs bg-bg-surface border border-border rounded-md px-2 py-1 min-h-[32px]"
            aria-label="Filter by log level"
          >
            <option value="all">All levels</option>
            <option value="error">Errors</option>
            <option value="warn">Warnings</option>
            <option value="info">Info</option>
          </select>
          <ToolbarButton
            onClick={() => setFollowing((v) => !v)}
            aria-label={following ? 'Pause auto-scroll' : 'Resume auto-scroll'}
            title={following ? 'Pause auto-scroll' : 'Resume auto-scroll'}
          >
            {following ? <PauseIcon /> : <PlayIcon />}
          </ToolbarButton>
          <ToolbarButton
            onClick={() => setShowTimestamps((v) => !v)}
            active={showTimestamps}
            aria-label="Toggle timestamps"
            title="Toggle timestamps"
          >
            <span className="text-[10px] font-mono">TS</span>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => setLines([])}
            aria-label="Clear visible logs"
            title="Clear buffer"
          >
            <RotateIcon />
          </ToolbarButton>
          {connected && (
            <span className="flex items-center gap-1.5 text-[11px] text-success ml-1">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              Live
            </span>
          )}
        </div>

        {/* Viewport */}
        <div className="flex-1 min-h-0 relative" style={{ fontSize: '12px' }}>
          {deployments.length === 0 ? (
            <EmptyState
              icon={<LogsIcon />}
              title="Nothing to tail yet"
              description="Deploy your first app and its logs will appear here in real time."
            />
          ) : filteredLines.length === 0 ? (
            <EmptyState
              icon={<LogsIcon />}
              title={
                search || levelFilter !== 'all' || appFilter.size > 0
                  ? 'No matching log lines'
                  : 'Waiting for logs'
              }
              description={
                search || levelFilter !== 'all' || appFilter.size > 0
                  ? 'Adjust your filters to see more.'
                  : connected
                    ? 'Lines will stream here as your containers emit them.'
                    : 'Connecting to log stream…'
              }
            />
          ) : (
            <div className="absolute inset-0 p-3 font-mono leading-relaxed text-text-secondary">
              <VirtualLogViewer
                lines={filteredLines}
                showTimestamps={showTimestamps}
                autoScroll={following}
                className="h-full"
                emptyMessage={connected ? 'Waiting for logs…' : 'Connecting…'}
              />
            </div>
          )}
        </div>

        {/* Status bar */}
        <div className="px-3 py-1.5 border-t border-border text-[11px] text-text-tertiary flex items-center gap-3 flex-wrap">
          <span className="tabular-nums">{filteredLines.length.toLocaleString()} lines</span>
          {filteredLines.length !== lines.length && (
            <span className="tabular-nums">· of {lines.length.toLocaleString()}</span>
          )}
          {lines.length >= MAX_LINES && (
            <span className="tabular-nums">· buffer cap {MAX_LINES.toLocaleString()}</span>
          )}
          {appFilter.size > 0 && (
            <span>
              · {appFilter.size} app{appFilter.size === 1 ? '' : 's'} selected
            </span>
          )}
          {!following && <span className="text-warning">· auto-scroll paused</span>}
        </div>
      </section>
    </div>
  );
}

function ToolbarButton({
  active,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center min-w-[32px] min-h-[32px] rounded-md text-text-tertiary hover:text-text hover:bg-bg-hover transition-colors ${
        active ? 'bg-bg-hover text-text' : ''
      }`}
    >
      {children}
    </button>
  );
}
