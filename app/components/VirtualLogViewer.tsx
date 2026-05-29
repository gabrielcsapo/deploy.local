'use client';

import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';

export interface LogLine {
  timestamp: string | null;
  content: string;
  /** Optional source app (only set on fleet-wide log views). Rendered as a
      colored chip ahead of the line content. */
  app?: string;
  /** Hex / CSS color for the app chip. If not provided the row falls back
      to a neutral chip. */
  appColor?: string;
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
      {line.timestamp && showTimestamps && (
        <span className="text-text-tertiary select-none shrink-0">
          {formatLogTime(line.timestamp)}
        </span>
      )}
      {line.app && (
        <span
          className="select-none shrink-0 px-1.5 rounded-sm text-[10px] font-medium tabular-nums leading-[18px]"
          style={{
            background: line.appColor ? `${line.appColor}22` : 'var(--color-bg-hover)',
            color: line.appColor ?? 'var(--color-text-secondary)',
            boxShadow: line.appColor ? `inset 0 0 0 1px ${line.appColor}55` : undefined,
          }}
        >
          {line.app}
        </span>
      )}
      <span>{line.content}</span>
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
  newestFirst = false,
  className = '',
  emptyMessage = 'No logs',
}: {
  lines: LogLine[];
  showTimestamps: boolean;
  autoScroll?: boolean;
  /** Render newest line at the top (and anchor auto-scroll to the top so new
      content appears at the top as it streams in). Defaults to chronological
      order with bottom-anchored auto-scroll. */
  newestFirst?: boolean;
  className?: string;
  emptyMessage?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  // Whether the viewport is parked at the "live edge" — the bottom in
  // chronological mode, the top in newest-first mode. New lines only
  // auto-scroll when the user is already at that edge.
  const atLiveEdgeRef = useRef(true);

  // Display order: reverse a shallow copy when newest-first so we keep the
  // source `lines` chronological (copy/download stay in order).
  const ordered = useMemo(
    () => (newestFirst ? lines.slice().reverse() : lines),
    [lines, newestFirst],
  );

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
  const totalHeight = ordered.length * LINE_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / LINE_HEIGHT) + 2 * OVERSCAN;
  const endIdx = Math.min(ordered.length, startIdx + visibleCount);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      setScrollTop(el.scrollTop);
      atLiveEdgeRef.current = newestFirst
        ? el.scrollTop < 50
        : el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    },
    [newestFirst],
  );

  // Auto-scroll to the live edge when new lines arrive (only if already there).
  const prevLengthRef = useRef(lines.length);
  useEffect(() => {
    const added = lines.length - prevLengthRef.current;
    if (added === 0) return;
    prevLengthRef.current = lines.length;
    const el = containerRef.current;
    if (!el) return;
    if (autoScroll && atLiveEdgeRef.current) {
      requestAnimationFrame(() => {
        const c = containerRef.current;
        if (c) c.scrollTop = newestFirst ? 0 : c.scrollHeight;
      });
    } else if (newestFirst && added > 0) {
      // Newest-first prepends rows at the top, shifting existing content down.
      // Compensate so the user reading older lines stays put instead of jumping.
      el.scrollTop += added * LINE_HEIGHT;
    }
  }, [lines.length, autoScroll, newestFirst]);

  const visibleLines = useMemo(() => ordered.slice(startIdx, endIdx), [ordered, startIdx, endIdx]);

  if (ordered.length === 0) {
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
