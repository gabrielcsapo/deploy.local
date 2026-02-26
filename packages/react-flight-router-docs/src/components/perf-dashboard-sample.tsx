import { useState } from "react";

interface TimingEntry {
  label: string;
  durationMs: number;
  depth: number;
}

interface SampleEvent {
  type: "SSR" | "RSC" | "ACTION";
  pathname: string;
  status: number;
  totalMs: number;
  timings: TimingEntry[];
  time: string;
}

const SAMPLE_EVENTS: SampleEvent[] = [
  {
    type: "SSR",
    pathname: "/about",
    status: 200,
    totalMs: 4.0,
    timings: [
      { label: "matchRoutes", durationMs: 0.021, depth: 0 },
      { label: "buildSegmentMap", durationMs: 0.703, depth: 0 },
      { label: "load root", durationMs: 0.072, depth: 1 },
      { label: "load about", durationMs: 0.567, depth: 1 },
      { label: "rsc:serialize", durationMs: 0.087, depth: 0 },
      { label: "rsc:buffer", durationMs: 0.119, depth: 0 },
      { label: "ssr:deserializeRSC", durationMs: 0.927, depth: 0 },
      { label: "ssr:renderToHTML", durationMs: 1.6, depth: 0 },
    ],
    time: "14:22:03",
  },
  {
    type: "RSC",
    pathname: "/about",
    status: 200,
    totalMs: 3.7,
    timings: [
      { label: "matchRoutes", durationMs: 0.032, depth: 0 },
      { label: "buildSegmentMap", durationMs: 0.14, depth: 0 },
      { label: "load about", durationMs: 0.093, depth: 1 },
      { label: "rsc:serialize", durationMs: 0.065, depth: 0 },
    ],
    time: "14:22:05",
  },
  {
    type: "ACTION",
    pathname: "/",
    status: 200,
    totalMs: 5.4,
    timings: [
      { label: "action:decodeArgs", durationMs: 4.4, depth: 0 },
      { label: "action:loadModule(actions)", durationMs: 0.029, depth: 0 },
      { label: "action:execute(addMessage)", durationMs: 0.027, depth: 0 },
      { label: "action:serialize", durationMs: 0.055, depth: 0 },
    ],
    time: "14:22:08",
  },
  {
    type: "SSR",
    pathname: "/posts/****",
    status: 200,
    totalMs: 14.2,
    timings: [
      { label: "matchRoutes", durationMs: 0.086, depth: 0 },
      { label: "buildSegmentMap", durationMs: 1.4, depth: 0 },
      { label: "load root", durationMs: 0.035, depth: 1 },
      { label: "load post-detail", durationMs: 1.3, depth: 1 },
      { label: "rsc:serialize", durationMs: 0.038, depth: 0 },
      { label: "rsc:buffer", durationMs: 0.21, depth: 0 },
      { label: "ssr:deserializeRSC", durationMs: 1.8, depth: 0 },
      { label: "ssr:renderToHTML", durationMs: 9.4, depth: 0 },
    ],
    time: "14:22:12",
  },
  {
    type: "RSC",
    pathname: "/slow",
    status: 200,
    totalMs: 3006.8,
    timings: [
      { label: "matchRoutes", durationMs: 0.031, depth: 0 },
      { label: "buildSegmentMap", durationMs: 0.486, depth: 0 },
      { label: "load root", durationMs: 0.045, depth: 1 },
      { label: "load slow", durationMs: 0.39, depth: 1 },
      { label: "rsc:serialize", durationMs: 0.04, depth: 0 },
      { label: "rsc:stream", durationMs: 2998.3, depth: 0 },
    ],
    time: "14:22:15",
  },
];

const TYPE_STYLES: Record<string, string> = {
  SSR: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300",
  RSC: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300",
  ACTION: "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300",
};

const BAR_COLORS: Record<string, string> = {
  SSR: "bg-green-400 dark:bg-green-500",
  RSC: "bg-blue-400 dark:bg-blue-500",
  ACTION: "bg-purple-400 dark:bg-purple-500",
};

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function PerfDashboardSample() {
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]));

  const toggleExpand = (idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const avgMs = SAMPLE_EVENTS.reduce((s, e) => s + e.totalMs, 0) / SAMPLE_EVENTS.length;
  const sorted = [...SAMPLE_EVENTS].sort((a, b) => a.totalMs - b.totalMs);
  const p95Ms = sorted[Math.floor(sorted.length * 0.95)]?.totalMs ?? 0;

  return (
    <div className="my-6 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Live
          </span>
        </div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 !mt-0 !mb-0">
          Performance Dashboard
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 !mt-1 !mb-0">
          Request timing data from{" "}
          <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">
            onRequestComplete
          </code>
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 px-5 pb-4">
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
          <div className="text-xs text-gray-500 dark:text-gray-400">Requests</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {SAMPLE_EVENTS.length}
          </div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
          <div className="text-xs text-gray-500 dark:text-gray-400">Avg Duration</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatDuration(avgMs)}
          </div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
          <div className="text-xs text-gray-500 dark:text-gray-400">p95 Duration</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatDuration(p95Ms)}
          </div>
        </div>
      </div>

      {/* Controls bar */}
      <div className="flex justify-between items-center px-5 py-2 bg-gray-50 dark:bg-gray-800 border-y border-gray-200 dark:border-gray-700">
        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <input type="checkbox" checked readOnly className="rounded w-3.5 h-3.5" />
          Auto-refresh (2s)
        </label>
        <div className="flex gap-1.5">
          <button className="px-2.5 py-1 text-xs bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded border border-gray-200 dark:border-gray-600 cursor-default">
            Refresh
          </button>
          <button className="px-2.5 py-1 text-xs bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 rounded border border-red-200 dark:border-red-800 cursor-default">
            Clear
          </button>
        </div>
      </div>

      {/* Events table */}
      <table className="w-full text-sm !my-0">
        <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <tr>
            <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-gray-400 text-xs !border-0 w-20">
              Type
            </th>
            <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-gray-400 text-xs !border-0">
              Path
            </th>
            <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400 text-xs !border-0 w-16">
              Status
            </th>
            <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400 text-xs !border-0 w-24">
              Duration
            </th>
            <th className="px-4 py-2 text-right font-medium text-gray-500 dark:text-gray-400 text-xs !border-0 w-20">
              Time
            </th>
          </tr>
        </thead>
        <tbody>
          {SAMPLE_EVENTS.map((event, idx) => (
            <SampleRow
              key={idx}
              event={event}
              isExpanded={expanded.has(idx)}
              onToggle={() => toggleExpand(idx)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SampleRow({
  event,
  isExpanded,
  onToggle,
}: {
  event: SampleEvent;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="border-b border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
      >
        <td className="px-4 py-2 !border-0">
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${TYPE_STYLES[event.type]}`}
          >
            {event.type}
          </span>
        </td>
        <td className="px-4 py-2 font-mono text-gray-800 dark:text-gray-200 text-xs !border-0">
          {event.pathname}
        </td>
        <td className="px-4 py-2 text-right text-xs !border-0">
          <span className="text-green-600 dark:text-green-400">{event.status}</span>
        </td>
        <td
          className={`px-4 py-2 text-right font-mono text-xs !border-0 ${
            event.totalMs > 10
              ? "text-amber-600 dark:text-amber-400 font-semibold"
              : "text-gray-700 dark:text-gray-300"
          }`}
        >
          {formatDuration(event.totalMs)}
        </td>
        <td className="px-4 py-2 text-right text-gray-400 text-[10px] !border-0">{event.time}</td>
      </tr>
      {isExpanded && (
        <tr className="border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30">
          <td colSpan={5} className="px-4 py-3 !border-0">
            <div className="space-y-1.5">
              {event.timings.map((t, ti) => (
                <div
                  key={ti}
                  className="flex items-center gap-2"
                  style={{ paddingLeft: `${t.depth * 16}px` }}
                >
                  <span className="text-[11px] text-gray-600 dark:text-gray-400 w-40 truncate shrink-0 font-mono">
                    {t.label}
                  </span>
                  <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded h-2.5 relative overflow-hidden">
                    <div
                      className={`${BAR_COLORS[event.type]} rounded h-2.5 transition-all`}
                      style={{
                        width: `${Math.max(3, (t.durationMs / event.totalMs) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="text-[11px] font-mono text-gray-500 dark:text-gray-400 w-16 text-right shrink-0">
                    {formatDuration(t.durationMs)}
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
