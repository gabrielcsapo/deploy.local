'use client';

import { useMemo, useRef, useState } from 'react';
import { EmptyState } from './EmptyState';
import { RequestsIcon } from './icons';
import {
  type ChartEvent,
  colorForEvent,
  eventsInRange,
  eventsNear,
  formatRelative,
} from './chart-events';

export interface RpsPoint {
  bucket: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  count: number;
}

const COLORS = {
  s2xx: 'var(--color-success)',
  s3xx: 'var(--color-accent)',
  s4xx: 'var(--color-warning)',
  s5xx: 'var(--color-danger)',
} as const;

const LABELS = { s2xx: '2xx', s3xx: '3xx', s4xx: '4xx', s5xx: '5xx' } as const;

export function RpsOverTime({
  series,
  bucketMs,
  events,
}: {
  series: RpsPoint[];
  bucketMs: number;
  /** Activity events (deploys/restarts) to mark on the time axis. Each
      becomes a vertical line; events that fall in the same bucket as
      the hover crosshair are pulled into the tooltip. */
  events?: ChartEvent[];
}) {
  const total = useMemo(() => series.reduce((a, p) => a + p.count, 0), [series]);
  const hasData = total > 0;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (!hasData) {
    return (
      <div className="card p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="eyebrow">Requests per second by status</p>
        </div>
        <EmptyState
          icon={<RequestsIcon />}
          title="No requests yet"
          description="Once traffic hits this app you'll see a stacked timeline here."
        />
      </div>
    );
  }

  const bucketSec = bucketMs / 1000;
  const data = series.map((p) => ({
    bucket: p.bucket,
    s2xx: p.s2xx / bucketSec,
    s3xx: p.s3xx / bucketSec,
    s4xx: p.s4xx / bucketSec,
    s5xx: p.s5xx / bucketSec,
    total: (p.s2xx + p.s3xx + p.s4xx + p.s5xx) / bucketSec,
  }));

  const max = Math.max(...data.map((d) => d.total), 0.001);
  const W = 600;
  const H = 160;
  const pad = 4;

  function stackY(stack: number): number {
    return H - pad - (stack / max) * (H - pad * 2);
  }

  const stacks: Array<keyof typeof COLORS> = ['s2xx', 's3xx', 's4xx', 's5xx'];
  const polygons: Array<{ key: string; color: string; points: string }> = [];
  const cumulative = new Array(data.length).fill(0);

  for (const key of stacks) {
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = 0; i < data.length; i++) {
      const x = pad + (i / Math.max(data.length - 1, 1)) * (W - pad * 2);
      const yBottom = stackY(cumulative[i]);
      cumulative[i] += data[i][key];
      const yTop = stackY(cumulative[i]);
      top.push(`${x},${yTop}`);
      bottom.push(`${x},${yBottom}`);
    }
    polygons.push({
      key,
      color: COLORS[key],
      points: [...top, ...bottom.reverse()].join(' '),
    });
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.round((x / rect.width) * (data.length - 1));
    setHoverIndex(Math.max(0, Math.min(idx, data.length - 1)));
  };

  const hover = hoverIndex !== null ? data[hoverIndex] : null;
  const hoverX =
    hoverIndex !== null
      ? pad + (hoverIndex / Math.max(data.length - 1, 1)) * (W - pad * 2)
      : null;

  // Events filtered into the chart's window, ready to render as
  // vertical markers + merged into the hover tooltip when nearby.
  const firstBucket = data[0]?.bucket ?? 0;
  const lastBucket = data[data.length - 1]?.bucket ?? 0;
  const rangeEvents = useMemo(
    () => eventsInRange(events, firstBucket - bucketMs / 2, lastBucket + bucketMs / 2),
    [events, firstBucket, lastBucket, bucketMs],
  );
  const hoveredEvents =
    hover != null ? eventsNear(rangeEvents, hover.bucket, bucketMs) : [];

  function tsToX(ts: number): number {
    const span = lastBucket - firstBucket;
    if (span <= 0) return pad;
    return pad + ((ts - firstBucket) / span) * (W - pad * 2);
  }

  // 3 horizontal guidelines at 25/50/75% of max for visual scale.
  const guidelineFractions = [0.25, 0.5, 0.75];

  return (
    <div className="card p-3 sm:p-4">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <p className="eyebrow">Requests per second by status</p>
        <div className="flex items-center gap-2 flex-wrap text-[11px] font-mono text-text-tertiary">
          {stacks.map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <span
                className="inline-block w-2 h-2 rounded-sm"
                style={{ backgroundColor: COLORS[s] }}
              />
              {LABELS[s]}
            </span>
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
          aria-label="Requests per second over time, stacked by status class"
        >
          {/* Guidelines first (under everything) */}
          {guidelineFractions.map((frac) => {
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
          {polygons.map((p) => (
            <polygon
              key={p.key}
              points={p.points}
              fill={p.color}
              fillOpacity={0.55}
              stroke={p.color}
              strokeWidth="0.6"
            />
          ))}
          {/* Event marker lines — drawn under the hover crosshair so the
              crosshair always wins visually but events stay visible. */}
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
        {/* Right-edge value scale */}
        <div className="absolute right-1 top-1 bottom-4 flex flex-col justify-between pointer-events-none text-[9px] font-mono text-text-tertiary tabular-nums">
          <span>{max.toFixed(1)}</span>
          <span>{(max * 0.5).toFixed(1)}</span>
          <span>0</span>
        </div>
        {/* Cursor-anchored tooltip */}
        {hover && hoverX !== null && (
          <div
            className="absolute -translate-x-1/2 -top-1 bg-bg/95 backdrop-blur-sm border border-border rounded-md px-2.5 py-1.5 text-[11px] font-mono text-text-secondary pointer-events-none tabular-nums shadow-lg min-w-[120px]"
            style={{ left: `calc(${(hoverX / W) * 100}% )` }}
          >
            <p className="text-text">{formatTime(hover.bucket)}</p>
            <div className="border-t border-border/60 my-1" />
            {(['s2xx', 's3xx', 's4xx', 's5xx'] as const).map((k) => {
              const v = hover[k];
              if (v === 0) return null;
              return (
                <p key={k} className="flex items-center gap-2 justify-between">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-sm"
                      style={{ backgroundColor: COLORS[k] }}
                    />
                    {LABELS[k]}
                  </span>
                  <span className="text-text">{v.toFixed(2)}</span>
                </p>
              );
            })}
            <div className="border-t border-border/60 my-1" />
            <p className="flex items-center justify-between gap-2">
              <span className="text-text-tertiary uppercase tracking-wider text-[9px]">
                Total
              </span>
              <span className="text-text">{hover.total.toFixed(2)} req/s</span>
            </p>
            {hoveredEvents.length > 0 && (
              <>
                <div className="border-t border-border/60 my-1" />
                {hoveredEvents.map((e, i) => (
                  <p
                    key={`${e.ts}-${i}`}
                    className="flex items-center gap-1.5"
                    style={{ color: colorForEvent(e) }}
                  >
                    <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: colorForEvent(e) }} />
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
        <span>{formatTime(data[0].bucket)}</span>
        <span>{formatTime(data[data.length - 1].bucket)}</span>
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
