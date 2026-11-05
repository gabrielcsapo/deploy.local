"use client";

import { useState, useEffect, useCallback } from "react";

interface TimingEntry {
  label: string;
  durationMs?: number;
  depth: number;
  /** Offset from request start in ms (present for parallel entries) */
  offsetMs?: number;
  /** True when this entry ran concurrently with siblings */
  parallel?: boolean;
}

interface RequestTimingEvent {
  type: "SSR" | "RSC" | "ACTION";
  pathname: string;
  status: number;
  totalMs: number;
  timings: TimingEntry[];
  timestamp: string;
  cancelled?: boolean;
}

const TYPE_STYLES: Record<string, string> = {
  SSR: "bg-green-100 text-green-800",
  RSC: "bg-blue-100 text-blue-800",
  ACTION: "bg-purple-100 text-purple-800",
};

const BAR_COLORS: Record<string, string> = {
  SSR: "bg-green-400",
  RSC: "bg-blue-400",
  ACTION: "bg-purple-400",
};

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function PerfDashboard() {
  const [events, setEvents] = useState<RequestTimingEvent[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch("/api/perf/events?limit=50");
      if (res.ok) setEvents(await res.json());
    } catch {
      /* ignore network errors */
    }
  }, []);

  useEffect(() => {
    fetchEvents();
    if (!autoRefresh) return;
    const id = setInterval(fetchEvents, 2000);
    return () => clearInterval(id);
  }, [fetchEvents, autoRefresh]);

  const clearEvents = async () => {
    await fetch("/api/perf/events", { method: "DELETE" });
    setEvents([]);
    setExpanded(new Set());
  };

  const toggleExpand = (idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  // Summary stats
  const cancelledCount = events.filter((e) => e.cancelled).length;
  const avgMs = events.length ? events.reduce((s, e) => s + e.totalMs, 0) / events.length : 0;
  const sorted = [...events].sort((a, b) => a.totalMs - b.totalMs);
  const p95Ms = sorted.length ? (sorted[Math.floor(sorted.length * 0.95)]?.totalMs ?? 0) : 0;

  return (
    <div>
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">Requests</div>
          <div className="text-2xl font-bold">{events.length}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">Avg Duration</div>
          <div className="text-2xl font-bold">{formatDuration(avgMs)}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">p95 Duration</div>
          <div className="text-2xl font-bold">{formatDuration(p95Ms)}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-sm text-gray-500">Cancelled</div>
          <div className={`text-2xl font-bold ${cancelledCount > 0 ? "text-amber-600" : ""}`}>
            {cancelledCount}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex justify-between items-center mb-4">
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="rounded"
          />
          Auto-refresh (2s)
        </label>
        <div className="flex gap-2">
          <button
            onClick={fetchEvents}
            className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
          >
            Refresh
          </button>
          <button
            onClick={clearEvents}
            className="px-3 py-1.5 text-sm bg-red-50 text-red-700 rounded hover:bg-red-100"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Events table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-600 w-20">Type</th>
              <th className="px-4 py-2 text-left font-medium text-gray-600">Path</th>
              <th className="px-4 py-2 text-right font-medium text-gray-600 w-20">Status</th>
              <th className="px-4 py-2 text-right font-medium text-gray-600 w-28">Duration</th>
              <th className="px-4 py-2 text-right font-medium text-gray-600 w-24">Time</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event, idx) => (
              <EventRow
                key={`${event.timestamp}-${idx}`}
                event={event}
                idx={idx}
                isExpanded={expanded.has(idx)}
                onToggle={toggleExpand}
              />
            ))}
          </tbody>
        </table>
        {events.length === 0 && (
          <div className="px-4 py-12 text-center text-gray-400">
            No requests recorded yet. Navigate around the app to see performance data.
          </div>
        )}
      </div>
    </div>
  );
}

function EventRow({
  event,
  idx,
  isExpanded,
  onToggle,
}: {
  event: RequestTimingEvent;
  idx: number;
  isExpanded: boolean;
  onToggle: (idx: number) => void;
}) {
  return (
    <>
      <tr
        onClick={() => onToggle(idx)}
        className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${event.cancelled ? "bg-amber-50/50" : ""}`}
      >
        <td className="px-4 py-2">
          <span
            className={`px-2 py-0.5 rounded text-xs font-medium ${TYPE_STYLES[event.type] ?? ""}`}
          >
            {event.type}
          </span>
          {event.cancelled && (
            <span className="ml-1 px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
              CANCELLED
            </span>
          )}
        </td>
        <td className="px-4 py-2 font-mono text-gray-800">{event.pathname}</td>
        <td className="px-4 py-2 text-right">
          <span className={event.status >= 400 ? "text-red-600" : ""}>{event.status}</span>
        </td>
        <td
          className={`px-4 py-2 text-right font-mono ${event.totalMs > 100 ? "text-amber-600 font-semibold" : ""}`}
        >
          {formatDuration(event.totalMs)}
        </td>
        <td className="px-4 py-2 text-right text-gray-400 text-xs">
          {new Date(event.timestamp).toLocaleTimeString()}
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b border-gray-100 bg-gray-50">
          <td colSpan={5} className="px-4 py-3">
            <TimingBreakdown timings={event.timings} totalMs={event.totalMs} type={event.type} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Renders timing entries as a waterfall breakdown.
 * Top-level entries are positioned on the total request timeline.
 * Child entries are positioned relative to their parent's time range,
 * so parallel loads clearly show overlap within their parent.
 */
function TimingBreakdown({
  timings,
  totalMs,
  type,
}: {
  timings: TimingEntry[];
  totalMs: number;
  type: string;
}) {
  if (timings.length === 0) {
    return <div className="text-xs text-gray-400">No timing breakdown available.</div>;
  }

  // Build a lookup for the most recent parent at each depth.
  // As we iterate, we track the last non-parallel entry at each depth
  // so children can compute positions relative to their parent.
  const parentAtDepth: (TimingEntry | undefined)[] = [];
  const barColor = BAR_COLORS[type] ?? "bg-blue-400";

  return (
    <div className="space-y-1">
      {timings.map((t, ti) => {
        const dur = t.durationMs ?? 0;
        const offset = t.offsetMs ?? 0;

        // Track parents for child lookups
        if (!t.parallel) {
          parentAtDepth[t.depth] = t;
        }

        // Determine the reference range for this entry
        let refOffset = 0;
        let refDuration = totalMs;

        if (t.depth > 0) {
          const parent = parentAtDepth[t.depth - 1];
          if (parent && parent.durationMs && parent.durationMs > 0) {
            refOffset = parent.offsetMs ?? 0;
            refDuration = parent.durationMs;
          }
        }

        const leftPct = refDuration > 0 ? ((offset - refOffset) / refDuration) * 100 : 0;
        const widthPct = refDuration > 0 ? Math.max(2, (dur / refDuration) * 100) : 2;

        return (
          <div
            key={ti}
            className="flex items-center gap-2"
            style={{ paddingLeft: `${t.depth * 16}px` }}
          >
            <span className="text-xs text-gray-600 w-44 truncate shrink-0">{t.label}</span>
            <div className="flex-1 bg-gray-200 rounded h-3 relative overflow-hidden">
              <div
                className={`${barColor} rounded h-3 absolute top-0`}
                style={{
                  left: `${Math.max(0, leftPct)}%`,
                  width: `${Math.min(widthPct, 100 - Math.max(0, leftPct))}%`,
                }}
              />
            </div>
            <span className="text-xs font-mono text-gray-500 w-20 text-right shrink-0">
              {formatDuration(dur)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
