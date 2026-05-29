'use client';

import { useMemo, useRef, useState } from 'react';
import { EmptyState } from './EmptyState';
import { ClockIcon } from './icons';
import {
  type ChartEvent,
  colorForEvent,
  eventsInRange,
  eventsNear,
  formatRelative,
} from './chart-events';

export interface LatencyPoint {
  bucket: number;
  p50: number;
  p95: number;
  p99: number;
  count: number;
}

const SERIES: Array<{ key: 'p50' | 'p95' | 'p99'; label: string; color: string; width: number }> = [
  { key: 'p50', label: 'p50', color: 'var(--color-accent)', width: 2.5 },
  { key: 'p95', label: 'p95', color: 'var(--color-warning)', width: 1.75 },
  { key: 'p99', label: 'p99', color: 'var(--color-danger)', width: 1.5 },
];

export function LatencyOverTime({
  series,
  events,
}: {
  series: LatencyPoint[];
  /** Activity events to mark on the time axis. See RpsOverTime for the
      contract — same pattern, same tooltip merging behaviour. */
  events?: ChartEvent[];
}) {
  const hasData = useMemo(() => series.some((p) => p.count > 0), [series]);
  const [enabled, setEnabled] = useState<Record<'p50' | 'p95' | 'p99', boolean>>({
    p50: true,
    p95: true,
    p99: true,
  });
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Hooks must run unconditionally — same order every render. Derive event
  // markers from the raw series BEFORE the empty-state early return. A
  // useMemo placed after `if (!hasData)` makes the hook count differ between
  // the "no data" and "has data" renders → React error #310.
  const bucketMs = series.length >= 2 ? series[1].bucket - series[0].bucket : 60_000;
  const firstBucket = series[0]?.bucket ?? 0;
  const lastBucket = series[series.length - 1]?.bucket ?? 0;
  const rangeEvents = useMemo(
    () => eventsInRange(events, firstBucket - bucketMs / 2, lastBucket + bucketMs / 2),
    [events, firstBucket, lastBucket, bucketMs],
  );

  if (!hasData) {
    return (
      <div className="card p-4">
        <p className="eyebrow mb-2">Latency over time</p>
        <EmptyState
          icon={<ClockIcon />}
          title="No latency data"
          description="Latency percentiles will appear once requests are recorded."
        />
      </div>
    );
  }

  const sanitized = series.map((p) => ({
    bucket: p.bucket,
    p50: p.count > 0 ? p.p50 : null,
    p95: p.count > 0 ? p.p95 : null,
    p99: p.count > 0 ? p.p99 : null,
    count: p.count,
  }));

  const all = sanitized.flatMap((p) => [p.p50, p.p95, p.p99]).filter((v): v is number => v != null);
  const max = Math.max(...all, 1);
  // Nice tick value (round up to 100/250/500/1000/2500ms etc.)
  const niceMax = (() => {
    const candidates = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000];
    return candidates.find((c) => c >= max) ?? max * 1.1;
  })();

  const W = 600;
  const H = 160;
  const pad = 4;

  function polylineFor(key: 'p50' | 'p95' | 'p99'): string {
    const parts: string[] = [];
    let buf: string[] = [];
    sanitized.forEach((p, i) => {
      const x = pad + (i / Math.max(sanitized.length - 1, 1)) * (W - pad * 2);
      const v = p[key];
      if (v == null) {
        if (buf.length >= 2) parts.push(buf.join(' '));
        buf = [];
      } else {
        const y = H - pad - (v / niceMax) * (H - pad * 2);
        buf.push(`${x},${y}`);
      }
    });
    if (buf.length >= 2) parts.push(buf.join(' '));
    return parts.join('  ');
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.round((x / rect.width) * (sanitized.length - 1));
    setHoverIndex(Math.max(0, Math.min(idx, sanitized.length - 1)));
  };

  const hover = hoverIndex !== null ? sanitized[hoverIndex] : null;
  const hoverX =
    hoverIndex !== null
      ? pad + (hoverIndex / Math.max(sanitized.length - 1, 1)) * (W - pad * 2)
      : null;

  // bucketMs/firstBucket/lastBucket/rangeEvents are computed above the early
  // return for hook-order safety. hoveredEvents is a plain derivation.
  const hoveredEvents = hover != null ? eventsNear(rangeEvents, hover.bucket, bucketMs) : [];

  function tsToX(ts: number): number {
    const span = lastBucket - firstBucket;
    if (span <= 0) return pad;
    return pad + ((ts - firstBucket) / span) * (W - pad * 2);
  }

  return (
    <div className="card p-3 sm:p-4">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <p className="eyebrow">Latency over time</p>
        <div className="flex gap-2 text-[11px] font-mono text-text-tertiary">
          {SERIES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setEnabled((e) => ({ ...e, [s.key]: !e[s.key] }))}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded transition-opacity ${
                enabled[s.key] ? '' : 'opacity-40'
              }`}
            >
              <span
                className="inline-block w-2 h-2 rounded-sm"
                style={{ backgroundColor: s.color }}
              />
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="w-full cursor-crosshair"
          style={{ height: '160px' }}
          onMouseMove={onMove}
          onMouseLeave={() => setHoverIndex(null)}
          role="img"
          aria-label="Latency percentiles over time"
        >
          {[0.25, 0.5, 0.75].map((frac) => {
            const y = H - pad - frac * (H - pad * 2);
            return (
              <line
                key={frac}
                x1={pad}
                x2={W - pad}
                y1={y}
                y2={y}
                stroke="var(--color-border)"
                strokeWidth="0.5"
                strokeDasharray="3,4"
                opacity="0.6"
              />
            );
          })}
          {SERIES.filter((s) => enabled[s.key]).map((s) => {
            const segs = polylineFor(s.key).split('  ').filter(Boolean);
            return segs.map((points, i) => (
              <polyline
                key={`${s.key}-${i}`}
                points={points}
                fill="none"
                stroke={s.color}
                strokeWidth={s.width}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ));
          })}
          {/* Event markers — drawn before the crosshair so the crosshair
              still reads clearly over them. */}
          {rangeEvents.map((e, i) => {
            const x = tsToX(e.ts);
            const color = colorForEvent(e);
            return (
              <g key={`${e.ts}-${i}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={pad}
                  y2={H - pad}
                  stroke={color}
                  strokeWidth="1"
                  opacity="0.45"
                />
                <circle cx={x} cy={pad + 2} r="2.2" fill={color} opacity="0.9" />
              </g>
            );
          })}
          {hoverX !== null && (
            <line
              x1={hoverX}
              x2={hoverX}
              y1={pad}
              y2={H - pad}
              stroke="var(--color-text)"
              strokeWidth="1"
              strokeDasharray="2,2"
              opacity="0.7"
            />
          )}
        </svg>
        {/* Right-edge tick scale (mono, tabular). */}
        <div className="absolute right-1 top-1 bottom-4 flex flex-col justify-between pointer-events-none text-[9px] font-mono text-text-tertiary tabular-nums">
          <span>
            {niceMax >= 1000 ? `${(niceMax / 1000).toFixed(1)}s` : `${Math.round(niceMax)}ms`}
          </span>
          <span>
            {niceMax >= 1000 ? `${(niceMax / 2000).toFixed(1)}s` : `${Math.round(niceMax / 2)}ms`}
          </span>
          <span>0</span>
        </div>
        {hover && hoverX !== null && (
          <div
            className="absolute -translate-x-1/2 -top-1 bg-bg/95 backdrop-blur-sm border border-border rounded-md px-2.5 py-1.5 text-[11px] font-mono text-text-secondary pointer-events-none space-y-0.5 tabular-nums shadow-lg min-w-[120px]"
            style={{ left: `calc(${(hoverX / W) * 100}% )` }}
          >
            <p className="text-text">{formatTime(hover.bucket)}</p>
            <div className="border-t border-border/60 my-1" />
            {SERIES.map((s) =>
              enabled[s.key] && hover[s.key] != null ? (
                <p key={s.key} className="flex items-center gap-2 justify-between">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-sm"
                      style={{ backgroundColor: s.color }}
                    />
                    {s.label}
                  </span>
                  <span className="text-text">{Math.round(hover[s.key] as number)}ms</span>
                </p>
              ) : null,
            )}
            {hoveredEvents.length > 0 && (
              <>
                <div className="border-t border-border/60 my-1" />
                {hoveredEvents.map((e, i) => (
                  <p
                    key={`${e.ts}-${i}`}
                    className="flex items-center gap-1.5"
                    style={{ color: colorForEvent(e) }}
                  >
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full"
                      style={{ background: colorForEvent(e) }}
                    />
                    <span className="uppercase tracking-wider text-[9px]">{e.label}</span>
                    {e.detail && <span className="text-text-secondary">{e.detail}</span>}
                    <span className="text-text-tertiary ml-auto">{formatRelative(e.ts)}</span>
                  </p>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex justify-between text-[10px] font-mono text-text-tertiary mt-1 tabular-nums">
        <span>{formatTime(sanitized[0].bucket)}</span>
        <span>{formatTime(sanitized[sanitized.length - 1].bucket)}</span>
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  if (now - ts > 24 * 60 * 60 * 1000) {
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
