'use client';

import { Select, IconButton, CopyButton } from '@/components/ui';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getAuth, useDetailContext } from './shared';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { fetchContainerLogs as serverFetchLogs } from '../../../actions/deployments';
import {
  VirtualLogViewer,
  TIMESTAMP_RE,
  parseLogLines,
  type LogLine,
} from '../../../components/VirtualLogViewer';

import { Button, TextField } from '../../../components/ui';
import { EmptyState } from '../../../components/dashboard/EmptyState';
import { LogsIcon } from '../../../components/dashboard/icons';
import {
  ApplicationInstanceSelector,
  type ApplicationInstanceSelection,
} from './ApplicationInstanceSelector';

const MAX_LINES = 10_000;

export default function Component() {
  const { deployment } = useDetailContext();
  const name = deployment.name;
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [historyRetry, setHistoryRetry] = useState(0);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [following, setFollowing] = useState(true);
  const [search, setSearch] = useState('');
  const [fontSize, setFontSize] = useState(12);
  const [levelFilter, setLevelFilter] = useState<'all' | 'error' | 'warn' | 'info'>('all');
  const [target, setTarget] = useState<ApplicationInstanceSelection>({
    siteId: deployment.activeNodeId || deployment.desiredNodeId || 'coordinator',
  });

  const pendingRef = useRef<string[]>([]);
  const rafRef = useRef<number | null>(null);

  const channels = useMemo(() => {
    const query = new URLSearchParams();
    if (target.siteId) query.set('siteId', target.siteId);
    if (target.component) query.set('component', target.component);
    if (target.instanceId) query.set('instanceId', target.instanceId);
    const suffix = query.size ? `?${query}` : '';
    return [`deployment:${encodeURIComponent(name)}:logs${suffix}`];
  }, [name, target.component, target.instanceId, target.siteId]);

  const flushPending = useCallback(() => {
    rafRef.current = null;
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];

    const newParsed: LogLine[] = [];
    for (const raw of pending) {
      for (const part of raw.split('\n')) {
        if (!part) continue;
        const match = part.match(TIMESTAMP_RE);
        newParsed.push(
          match
            ? { timestamp: match[1], content: part.slice(match[0].length) }
            : { timestamp: null, content: part },
        );
      }
    }

    setLines((prev) => {
      const combined = prev.concat(newParsed);
      return combined.length > MAX_LINES ? combined.slice(combined.length - MAX_LINES) : combined;
    });
  }, []);

  const handleWsEvent = useCallback(
    (event: { type: string; deploymentName?: string; data: Record<string, unknown> }) => {
      if (event.type === 'container:logs' && event.deploymentName === name) {
        if (target.siteId && event.data.siteId && event.data.siteId !== target.siteId) return;
        if (target.component && event.data.component && event.data.component !== target.component)
          return;
        if (target.instanceId && event.data.instanceId !== target.instanceId) return;
        pendingRef.current.push(event.data.line as string);
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(flushPending);
        }
      }
    },
    [flushPending, name, target.component, target.instanceId, target.siteId],
  );

  const { connected } = useWebSocket(channels, handleWsEvent);

  const fetchHistory = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return '';
    // Remote log reads are agent jobs. Going through the ordinary authenticated
    // endpoint avoids losing the completed job payload at the server-action
    // serialization boundary. Coordinator reads remain on the direct server
    // action because the HTTP endpoint is intentionally a long-lived stream.
    if (target.siteId && target.siteId !== 'coordinator') {
      const query = new URLSearchParams({ tail: '1000', siteId: target.siteId });
      if (target.component) query.set('component', target.component);
      if (target.instanceId) query.set('instanceId', target.instanceId);
      const response = await fetch(`/api/deployments/${encodeURIComponent(name)}/logs?${query}`, {
        headers: {
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Unable to read logs (${response.status})`);
      }
      return response.text();
    }
    return serverFetchLogs(auth.username, auth.token, name, 1000, target);
  }, [name, target]);

  // Fetch historical logs on mount
  useEffect(() => {
    let cancelled = false;
    setLines([]);
    setLoadingHistory(true);
    pendingRef.current = [];
    setHistoryError('');
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (!getAuth()) {
      setLoadingHistory(false);
      return;
    }
    fetchHistory()
      .then((data) => {
        if (!cancelled && data) {
          const parsed = parseLogLines(data as string);
          setLines(parsed.length > MAX_LINES ? parsed.slice(parsed.length - MAX_LINES) : parsed);
        }
      })
      .catch((loadError) => {
        if (!cancelled)
          setHistoryError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchHistory, historyRetry]);

  useEffect(() => {
    if (!target.siteId || target.siteId === 'coordinator') return;
    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      if (!getAuth()) {
        refreshing = false;
        return;
      }
      try {
        const data = await fetchHistory();
        if (cancelled || !data) return;
        const parsed = parseLogLines(data as string);
        setLines(parsed.length > MAX_LINES ? parsed.slice(parsed.length - MAX_LINES) : parsed);
        setHistoryError('');
      } catch (loadError) {
        if (!cancelled) {
          setHistoryError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(refresh, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [fetchHistory, target.siteId]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Filter lines by search + level (client-side)
  const filteredLines = useMemo(() => {
    let filtered = lines;
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
  }, [lines, search, levelFilter]);

  const copyText = filteredLines
    .map((l) => (showTimestamps && l.timestamp ? `${l.timestamp}${l.content}` : l.content))
    .join('\n');

  const downloadAll = () => {
    const text = filteredLines
      .map((l) => (l.timestamp ? `${l.timestamp}${l.content}` : l.content))
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <section className="ds-log-workbench flex flex-col flex-1 min-h-0 card overflow-hidden">
      {/* Toolbar */}
      <div className="ds-log-toolbar">
        {deployment.appId && deployment.activeSpecDigest && (
          <details className="ds-log-target">
            <summary>{target.component || 'Runtime target'}</summary>
            <ApplicationInstanceSelector
              deployment={deployment}
              value={target}
              onChange={setTarget}
            />
          </details>
        )}
        <TextField
          className="ds-log-search"
          label="Filter logs"
          appearance="plain"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter logs…"
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
          <ToolbarButton
            onClick={() => setFontSize((s) => Math.max(10, s - 1))}
            aria-label="Decrease font size"
            title="Decrease font size"
          >
            <span className="text-caption">A−</span>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => setFontSize((s) => Math.min(16, s + 1))}
            aria-label="Increase font size"
            title="Increase font size"
          >
            <span className="text-caption">A+</span>
          </ToolbarButton>
          <CopyButton label="Copy logs" text={copyText} />
          <IconButton icon="download" label="Download logs" onClick={downloadAll} />
          <IconButton icon="reset" label="Clear visible logs" onClick={() => setLines([])} />
          {connected && (
            <span className="flex items-center gap-1.5 text-caption text-success ml-1">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              Live
            </span>
          )}
        </div>
      </div>

      {/* Log viewport */}
      <div
        className="flex-1 min-h-0 relative"
        style={{ fontSize: `calc(var(--ds-type-code) * ${fontSize / 12})` }}
      >
        {loadingHistory ? (
          <div className="flex items-center justify-center h-full text-xs text-text-tertiary">
            Loading logs…
          </div>
        ) : historyError && filteredLines.length === 0 ? (
          <EmptyState
            icon={<LogsIcon />}
            title="Logs unavailable"
            description={historyError}
            action={
              <IconButton
                icon="refresh"
                label="Retry logs"
                onClick={() => setHistoryRetry((value) => value + 1)}
              />
            }
          />
        ) : filteredLines.length === 0 ? (
          <EmptyState
            icon={<LogsIcon />}
            title={search || levelFilter !== 'all' ? 'No matching log lines' : 'Waiting for logs'}
            description={
              search || levelFilter !== 'all'
                ? 'Adjust your search or level filter to see more.'
                : connected
                  ? 'Logs will stream here as your container emits them.'
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
      <div className="px-3 py-1.5 border-t border-border text-caption text-text-tertiary flex items-center gap-3">
        <span>{filteredLines.length.toLocaleString()} lines</span>
        {filteredLines.length !== lines.length && <span>· of {lines.length.toLocaleString()}</span>}
        {lines.length >= MAX_LINES && <span>· buffer cap {MAX_LINES.toLocaleString()}</span>}
        {!following && <span className="text-warning">· auto-scroll paused</span>}
      </div>
    </section>
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
