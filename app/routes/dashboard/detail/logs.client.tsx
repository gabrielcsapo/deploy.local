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

const MAX_LINES = 10_000;

export default function Component() {
  const { deployment } = useDetailContext();
  const name = deployment.name;
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(true);

  // Batching: accumulate WS lines in a ref, flush once per animation frame
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

  // Cleanup rAF on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div className="flex flex-col h-[calc(100vh-16rem)]">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
          Container Logs
        </h3>
        <div className="flex items-center gap-2">
          {lines.length >= MAX_LINES && (
            <span className="text-xs text-text-tertiary">
              (showing last {MAX_LINES.toLocaleString()} lines)
            </span>
          )}
          <button
            onClick={() => setLines([])}
            className="px-2 py-1 text-xs rounded text-text-tertiary hover:text-text-secondary transition-colors"
          >
            Clear
          </button>
          <button
            onClick={() => setShowTimestamps((v) => !v)}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              showTimestamps
                ? 'bg-bg-active text-text'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
            title={showTimestamps ? 'Hide timestamps' : 'Show timestamps'}
          >
            Timestamps
          </button>
          {connected && (
            <span className="flex items-center gap-1.5 text-xs text-success">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              Live
            </span>
          )}
        </div>
      </div>
      <div className="card p-4 text-xs font-mono leading-relaxed text-text-secondary flex-1 min-h-0">
        {loadingHistory ? (
          <span className="text-text-tertiary">Loading logs...</span>
        ) : (
          <VirtualLogViewer
            lines={lines}
            showTimestamps={showTimestamps}
            autoScroll
            className="h-full"
            emptyMessage={connected ? 'Waiting for logs...' : 'Connecting...'}
          />
        )}
      </div>
    </div>
  );
}
