'use client';
import { Select, IconButton } from '@/components/ui';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket, type WsEvent } from '../../hooks/useWebSocket';
import { VirtualLogViewer, TIMESTAMP_RE, type LogLine } from '../../components/VirtualLogViewer';
import { Button, SearchField } from '../../components/ui';
import { EmptyState } from '../../components/dashboard/EmptyState';
import { LogsIcon } from '../../components/dashboard/icons';
import { useDashboardData } from './data.client';

const MAX_LINES = 5_000;

// Stable source identities use the shared categorical chart palette.
const APP_PALETTE = [
  'var(--ds-chartPrimary)',
  'var(--ds-chartSecondary)',
  'var(--ds-chartTertiary)',
  'var(--ds-chartReference)',
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
      return combined.length > MAX_LINES ? combined.slice(combined.length - MAX_LINES) : combined;
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
    <div className="ds-fleet-logs">
      {/* App filter chips */}
      {deployments.length > 0 && (
        <div className="ds-pane-toolbar ds-log-app-filter ui-scroll-strip flex-wrap max-sm:flex-nowrap">
          <span className="shrink-0 text-caption font-mono uppercase tracking-wider text-text-tertiary mr-1">
            Apps:
          </span>
          <button
            type="button"
            onClick={clearAppFilter}
            className={`shrink-0 whitespace-nowrap px-2 py-0.5 text-caption font-mono rounded-md transition-colors duration-motion-fast ease-motion-standard focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg ${
              appFilter.size === 0
                ? 'text-on-action'
                : 'text-text-tertiary hover:text-text-secondary bg-bg-surface'
            }`}
            style={
              appFilter.size === 0
                ? { background: 'var(--ds-action)', color: 'var(--ds-onAction)' }
                : undefined
            }
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
                className="shrink-0 whitespace-nowrap px-2 py-0.5 text-caption font-mono rounded-md transition-colors duration-motion-fast ease-motion-standard focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg"
                style={
                  selected
                    ? {
                        background: `color-mix(in srgb, ${color} 12%, transparent)`,
                        color: color,
                        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 50%, transparent)`,
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

      <section className="ds-log-workbench flex flex-col flex-1 min-h-0 card overflow-hidden">
        {/* Toolbar */}
        <div className="ds-log-toolbar">
          <SearchField
            className="ds-log-search"
            label="Filter logs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="ds-log-actions">
            <Select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value as typeof levelFilter)}
              className="text-xs bg-bg-surface border border-border rounded-md px-2 py-1 min-h-[32px]"
              aria-label="Filter by log level"
            >
              <option value="all">All levels</option>
              <option value="error">Errors</option>
              <option value="warn">Warnings</option>
              <option value="info">Info</option>
            </Select>
            <IconButton
              icon="pin"
              label="Follow logs"
              pressed={following}
              onClick={() => setFollowing((v) => !v)}
            />
            <ToolbarButton
              onClick={() => setShowTimestamps((v) => !v)}
              active={showTimestamps}
              aria-label="Toggle timestamps"
              title="Toggle timestamps"
            >
              <span className="text-caption font-mono">TS</span>
            </ToolbarButton>
            <IconButton icon="reset" label="Clear visible logs" onClick={() => setLines([])} />
            {connected && (
              <span className="flex items-center gap-1.5 text-caption text-success ml-1">
                <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                Live
              </span>
            )}
          </div>
        </div>

        {/* Viewport */}
        <div className="flex-1 min-h-0 relative" style={{ fontSize: 'var(--ds-type-code)' }}>
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
                newestFirst
                className="h-full"
                emptyMessage={connected ? 'Waiting for logs…' : 'Connecting…'}
              />
            </div>
          )}
        </div>

        {/* Status bar */}
        <div className="px-3 py-1.5 border-t border-border text-caption text-text-tertiary flex items-center gap-3 flex-wrap">
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
    <Button
      variant="quiet"
      aria-pressed={active}
      {...rest}
      className={`inline-flex items-center justify-center min-w-[32px] min-h-[32px] rounded-md text-text-tertiary hover:text-text hover:bg-bg-hover transition-colors ${
        active ? 'bg-bg-hover text-text' : ''
      }`}
    >
      {children}
    </Button>
  );
}
