'use client';

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
import {
  SearchIcon,
  PauseIcon,
  PlayIcon,
  CopyIcon,
  DownloadIcon,
  RotateIcon,
} from '../../../components/dashboard/icons';
import { EmptyState } from '../../../components/dashboard/EmptyState';
import { LogsIcon } from '../../../components/dashboard/icons';

const MAX_LINES = 10_000;

export default function Component() {
  const { deployment } = useDetailContext();
  const name = deployment.name;
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [following, setFollowing] = useState(true);
  const [search, setSearch] = useState('');
  const [fontSize, setFontSize] = useState(12);
  const [levelFilter, setLevelFilter] = useState<'all' | 'error' | 'warn' | 'info'>('all');

  const pendingRef = useRef<string[]>([]);
  const rafRef = useRef<number | null>(null);

  const channels = useMemo(() => [`deployment:${name}:logs`], [name]);

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
    (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'container:logs') {
        pendingRef.current.push(event.data.line as string);
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(flushPending);
        }
      }
    },
    [flushPending],
  );

  const { connected } = useWebSocket(channels, handleWsEvent);

  // Fetch historical logs on mount
  useEffect(() => {
    setLines([]);
    setLoadingHistory(true);
    pendingRef.current = [];
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const auth = getAuth();
    if (!auth) {
      setLoadingHistory(false);
      return;
    }
    serverFetchLogs(auth.username, auth.token, name, 1000)
      .then((data) => {
        if (data) {
          const parsed = parseLogLines(data as string);
          setLines(parsed.length > MAX_LINES ? parsed.slice(parsed.length - MAX_LINES) : parsed);
        }
      })
      .catch(() => {
        // Container may not be running
      })
      .finally(() => setLoadingHistory(false));
  }, [name]);

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

  const copyAll = () => {
    const text = filteredLines
      .map((l) => (showTimestamps && l.timestamp ? `${l.timestamp}${l.content}` : l.content))
      .join('\n');
    navigator.clipboard?.writeText(text).catch(() => {});
  };

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
    <section className="flex flex-col flex-1 min-h-0 card overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-wrap">
        <div className="flex items-center gap-1.5 flex-1 min-w-[140px]">
          <SearchIcon className="text-text-tertiary shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search logs…"
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
          onClick={() => setFontSize((s) => Math.max(10, s - 1))}
          aria-label="Decrease font size"
          title="Smaller text"
        >
          <span className="text-[10px]">A−</span>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => setFontSize((s) => Math.min(16, s + 1))}
          aria-label="Increase font size"
          title="Larger text"
        >
          <span className="text-[10px]">A+</span>
        </ToolbarButton>
        <ToolbarButton onClick={copyAll} aria-label="Copy logs" title="Copy filtered logs">
          <CopyIcon />
        </ToolbarButton>
        <ToolbarButton onClick={downloadAll} aria-label="Download logs" title="Download as .txt">
          <DownloadIcon />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => setLines([])}
          aria-label="Clear visible logs"
          title="Clear visible logs"
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

      {/* Log viewport */}
      <div className="flex-1 min-h-0 relative" style={{ fontSize: `${fontSize}px` }}>
        {loadingHistory ? (
          <div className="flex items-center justify-center h-full text-xs text-text-tertiary">
            Loading logs…
          </div>
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
              className="h-full"
              emptyMessage={connected ? 'Waiting for logs…' : 'Connecting…'}
            />
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="px-3 py-1.5 border-t border-border text-[11px] text-text-tertiary flex items-center gap-3">
        <span>{filteredLines.length.toLocaleString()} lines</span>
        {filteredLines.length !== lines.length && (
          <span>· of {lines.length.toLocaleString()}</span>
        )}
        {lines.length >= MAX_LINES && (
          <span>· buffer cap {MAX_LINES.toLocaleString()}</span>
        )}
        {!following && (
          <span className="text-warning">· auto-scroll paused</span>
        )}
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
