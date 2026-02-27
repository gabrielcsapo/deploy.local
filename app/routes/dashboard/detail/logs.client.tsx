'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useDetailContext } from './shared';
import { useWebSocket } from '../../../hooks/useWebSocket';

// deploy.sh timestamp format: [2024-01-01T12:00:00.000Z] <content>
const TIMESTAMP_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]\s/;

function formatLogTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3 });
}

interface LogLine {
  timestamp: string | null;
  content: string;
}

function parseLogLines(raw: string): LogLine[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = line.match(TIMESTAMP_RE);
      if (match) {
        return { timestamp: match[1], content: line.slice(match[0].length) };
      }
      return { timestamp: null, content: line };
    });
}

export default function Component() {
  const { deployment } = useDetailContext();
  const name = deployment.name;
  const [logs, setLogs] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const [showTimestamps, setShowTimestamps] = useState(true);

  const channels = useMemo(() => [`deployment:${name}:logs`], [name]);

  const handleWsEvent = useCallback((event: { type: string; data: Record<string, unknown> }) => {
    if (event.type === 'container:logs') {
      setLogs((prev) => prev + (event.data.line as string));
    }
  }, []);

  const { connected } = useWebSocket(channels, handleWsEvent);

  // Reset logs when deployment name changes
  useEffect(() => {
    setLogs('');
  }, [name]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs]);

  const parsedLines = useMemo(() => parseLogLines(logs), [logs]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
          Container Logs
        </h3>
        <div className="flex items-center gap-2">
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
      <div
        ref={containerRef}
        className="card p-4 text-xs font-mono leading-relaxed text-text-secondary overflow-auto max-h-[500px] whitespace-pre-wrap"
      >
        {parsedLines.length > 0
          ? parsedLines.map((line, i) => (
              <div key={i} className="flex gap-2">
                {line.timestamp && showTimestamps ? (
                  <>
                    <span className="text-text-tertiary select-none shrink-0">
                      {formatLogTime(line.timestamp)}
                    </span>
                    <span>{line.content}</span>
                  </>
                ) : (
                  <span>{line.content}</span>
                )}
              </div>
            ))
          : connected
            ? 'Waiting for logs...'
            : 'Connecting...'}
      </div>
    </div>
  );
}
