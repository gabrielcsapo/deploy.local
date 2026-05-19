'use client';

import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';

export interface LogLine {
  timestamp: string | null;
  content: string;
}

const LINE_HEIGHT = 20; // px — matches text-xs (~12px) with comfortable spacing
const OVERSCAN = 30; // extra rows rendered above/below the viewport

// Matches [2024-01-01T12:00:00.000Z] or 2024-01-01T12:00:00.000000000Z
export const TIMESTAMP_RE = /^\[?(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]?\s/;

export function formatLogTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

export function parseLogLines(raw: string): LogLine[] {
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

const LogRow = memo(function LogRow({
  line,
  showTimestamps,
}: {
  line: LogLine;
  showTimestamps: boolean;
}) {
  return (
    <div style={{ height: LINE_HEIGHT }} className="flex gap-2 items-start whitespace-pre">
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
  );
});

/**
 * Virtualized log viewer that only renders rows visible in the viewport.
 * Uses fixed row height (20px) with whitespace:pre (no wrapping) for consistent heights.
 */
export function VirtualLogViewer({
  lines,
  showTimestamps,
  autoScroll = true,
  className = '',
  emptyMessage = 'No logs',
}: {
  lines: LogLine[];
  showTimestamps: boolean;
  autoScroll?: boolean;
  className?: string;
  emptyMessage?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const isAtBottomRef = useRef(true);

  // Track viewport size via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const ro = new ResizeObserver(([entry]) => {
      setViewportHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Calculate the visible window
  const totalHeight = lines.length * LINE_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / LINE_HEIGHT) + 2 * OVERSCAN;
  const endIdx = Math.min(lines.length, startIdx + visibleCount);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }, []);

  // Auto-scroll to bottom when new lines arrive (only if already at bottom)
  const prevLengthRef = useRef(lines.length);
  useEffect(() => {
    if (lines.length !== prevLengthRef.current) {
      prevLengthRef.current = lines.length;
      if (autoScroll && isAtBottomRef.current && containerRef.current) {
        requestAnimationFrame(() => {
          if (containerRef.current) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
          }
        });
      }
    }
  }, [lines.length, autoScroll]);

  const visibleLines = useMemo(() => lines.slice(startIdx, endIdx), [lines, startIdx, endIdx]);

  if (lines.length === 0) {
    return (
      <div className={`overflow-auto ${className}`}>
        <span className="text-text-tertiary">{emptyMessage}</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} onScroll={handleScroll} className={`overflow-auto ${className}`}>
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            top: startIdx * LINE_HEIGHT,
            left: 0,
            right: 0,
          }}
        >
          {visibleLines.map((line, i) => (
            <LogRow key={startIdx + i} line={line} showTimestamps={showTimestamps} />
          ))}
        </div>
      </div>
    </div>
  );
}
