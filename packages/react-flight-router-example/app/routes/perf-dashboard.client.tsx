"use client";

import { useState, useEffect, useCallback } from "react";

interface TimingEntry {
  label: string;
  durationMs?: number;
  depth: number;
}

interface RequestTimingEvent {
  type: "SSR" | "RSC" | "ACTION";
  pathname: string;
  status: number;
  totalMs: number;
  timings: TimingEntry[];
  timestamp: string;
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
  const avgMs = events.length ? events.reduce((s, e) => s + e.totalMs, 0) / events.length : 0;
  const sorted = [...events].sort((a, b) => a.totalMs - b.totalMs);
  const p95Ms = sorted.length ? (sorted[Math.floor(sorted.length * 0.95)]?.totalMs ?? 0) : 0;

  return (
    <div>
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
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
        className="border-b border-gray-100 cursor-pointer hover:bg-gray-50"
      >
        <td className="px-4 py-2">
          <span
            className={`px-2 py-0.5 rounded text-xs font-medium ${TYPE_STYLES[event.type] ?? ""}`}
          >
            {event.type}
          </span>
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
            <div className="space-y-1">
              {event.timings.map((t, ti) => (
                <div
                  key={ti}
                  className="flex items-center gap-2"
                  style={{ paddingLeft: `${t.depth * 16}px` }}
                >
                  <span className="text-xs text-gray-600 w-44 truncate shrink-0">{t.label}</span>
                  <div className="flex-1 bg-gray-200 rounded h-3 relative overflow-hidden">
                    <div
                      className={`${BAR_COLORS[event.type] ?? "bg-blue-400"} rounded h-3`}
                      style={{
                        width: `${Math.max(2, ((t.durationMs ?? 0) / event.totalMs) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="text-xs font-mono text-gray-500 w-20 text-right shrink-0">
                    {formatDuration(t.durationMs ?? 0)}
                  </span>
                </div>
              ))}
              {event.timings.length === 0 && (
                <div className="text-xs text-gray-400">No timing breakdown available.</div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
