'use client';

import { useRef, useState } from 'react';
import { type ChartEvent, colorForEvent, eventsNear, formatRelative } from './chart-events';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  label: string;
  current: string;
  secondaryData?: number[];
  secondaryColor?: string;
  secondaryLabel?: string;
  timestamps?: number[];
  formatter?: (value: number) => string;
  thresholdValue?: number;
  thresholdLabel?: string;
  thresholdColor?: string;
}

export function Sparkline({
  data,
  width = 300,
  height = 64,
  color = 'var(--color-accent)',
  label,
  current,
  secondaryData,
  secondaryColor,
  secondaryLabel,
  timestamps,
  formatter,
  thresholdValue,
  thresholdLabel,
  thresholdColor = 'var(--color-danger)',
}: SparklineProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (data.length < 2) {
    return (
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="eyebrow">{label}</p>
          <p className="text-base font-mono font-semibold tabular-nums">{current}</p>
        </div>
        <div className="h-[64px] flex items-center justify-center text-xs text-text-tertiary">
          Collecting data...
        </div>
      </div>
    );
  }

  const allValues = secondaryData ? [...data, ...secondaryData] : data;
  const rawMax = Math.max(...allValues, thresholdValue ?? 0);
  const rawMin = Math.min(...allValues);
  // For positive-only data (latency, %, counts), don't anchor baseline at 0 —
  // gives p50 variation real visual range instead of squashing it.
  const baseline = rawMin >= 0 ? Math.max(0, rawMin * 0.9) : rawMin;
  const max = Math.max(rawMax, baseline + 0.001);
  const range = max - baseline || 1;
  const pad = 3;

  function toPoints(values: number[]) {
    return values
      .map((v, i) => {
        const x = pad + (i / (values.length - 1)) * (width - pad * 2);
        const y = pad + (1 - (v - baseline) / range) * (height - pad * 2);
        return `${x},${y}`;
      })
      .join(' ');
  }

  const points = toPoints(data);
  const secondaryPoints = secondaryData ? toPoints(secondaryData) : null;

  const timeLabels =
    timestamps && timestamps.length >= 2
      ? [formatTime(timestamps[0]), formatTime(timestamps[timestamps.length - 1])]
      : null;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const relativeX = x / rect.width;
    const index = Math.round(relativeX * (data.length - 1));
    setHoverIndex(Math.max(0, Math.min(index, data.length - 1)));
  };

  const handleMouseLeave = () => {
    setHoverIndex(null);
  };

  const hoverData =
    hoverIndex !== null
      ? {
          primary: formatter ? formatter(data[hoverIndex]) : data[hoverIndex].toFixed(2),
          secondary:
            secondaryData && formatter
              ? formatter(secondaryData[hoverIndex])
              : secondaryData?.[hoverIndex].toFixed(2),
          time: timestamps?.[hoverIndex]
            ? new Date(timestamps[hoverIndex]).toLocaleTimeString()
            : null,
          x: pad + (hoverIndex / (data.length - 1)) * (width - pad * 2),
          y: pad + (1 - (data[hoverIndex] - baseline) / range) * (height - pad * 2),
        }
      : null;

  return (
    <div className="card p-4 relative">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <p className="eyebrow">{label}</p>
          {secondaryLabel && (
            <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
              <span
                className="inline-block w-2 h-2 rounded-sm"
                style={{ backgroundColor: color }}
              />
              <span>{label.split(' ')[0]}</span>
              <span
                className="inline-block w-2 h-2 rounded-sm ml-1"
                style={{ backgroundColor: secondaryColor }}
              />
              <span>{secondaryLabel}</span>
            </div>
          )}
        </div>
        <p className="text-base font-mono font-semibold tabular-nums">
          {hoverData ? hoverData.primary : current}
        </p>
      </div>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          className="w-full cursor-crosshair"
          style={{ height: `${height}px` }}
          preserveAspectRatio="none"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          role="img"
          aria-label={`${label} chart: current value ${current}`}
        >
          {/* Light area under primary line — only when no secondary series. */}
          {!secondaryPoints && (
            <polygon
              points={`${pad},${height - pad} ${points} ${width - pad},${height - pad}`}
              fill={color}
              fillOpacity={0.1}
            />
          )}
          <polyline
            points={points}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {secondaryPoints && (
            <polyline
              points={secondaryPoints}
              fill="none"
              stroke={secondaryColor}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeDasharray="3,2"
            />
          )}
          {thresholdValue !== undefined &&
            (() => {
              const ty = pad + (1 - (thresholdValue - baseline) / range) * (height - pad * 2);
              return (
                <>
                  <line
                    x1={pad}
                    y1={ty}
                    x2={width - pad}
                    y2={ty}
                    stroke={thresholdColor}
                    strokeWidth="1"
                    strokeDasharray="4,3"
                    opacity="0.55"
                  />
                  {thresholdLabel && (
                    <text
                      x={width - pad - 2}
                      y={ty - 3}
                      textAnchor="end"
                      fontSize="10"
                      fontFamily="var(--font-mono)"
                      fill={thresholdColor}
                      opacity="0.8"
                    >
                      {thresholdLabel}
                    </text>
                  )}
                </>
              );
            })()}
          {hoverData && (
            <>
              <line
                x1={hoverData.x}
                y1={pad}
                x2={hoverData.x}
                y2={height - pad}
                stroke="var(--color-text-tertiary)"
                strokeWidth="1"
                strokeDasharray="2,2"
                opacity="0.7"
              />
              <circle
                cx={hoverData.x}
                cy={hoverData.y}
                r="4"
                fill="var(--color-bg)"
                stroke={color}
                strokeWidth="2"
              />
            </>
          )}
        </svg>
        {hoverData && hoverData.time && (
          <div className="absolute bottom-0 left-0 right-0 text-center text-[10px] font-mono text-text-tertiary bg-bg/90 py-0.5 tabular-nums">
            {hoverData.time}
            {hoverData.secondary && ` • ${secondaryLabel}: ${hoverData.secondary}`}
          </div>
        )}
      </div>
      {timeLabels && !hoverData && (
        <div className="flex justify-between text-[10px] font-mono text-text-tertiary mt-1 tabular-nums">
          <span>{timeLabels[0]}</span>
          <span>{timeLabels[1]}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Minimal sparkline — no axes, no tooltip, just the polyline.
 * Used inside StatCard, FleetActivityPanel, LiveStatusStrip, AppTable.
 * Pass `gradient` to swap the flat stroke/fill for the Railway-style
 * violet → pink brand gradient.
 *
 * When `timestamps` is provided (one per data point), the sparkline
 * becomes hoverable: the user gets a vertical crosshair, a value
 * tooltip with optional formatter, and any `events` whose timestamp
 * falls inside the same bucket are merged into the tooltip.
 */
export function MiniSparkline({
  data,
  color = 'var(--color-accent)',
  height = 30,
  width = 120,
  gradient = false,
  timestamps,
  events,
  label,
  formatter,
}: {
  data: number[];
  color?: string;
  height?: number;
  width?: number;
  gradient?: boolean;
  /** Wall-clock timestamps for each data point. Required to enable hover. */
  timestamps?: number[];
  /** Activity events to mark on the time axis. Renders short ticks at
      the top of the sparkline and merges nearby events into the tooltip. */
  events?: ChartEvent[];
  /** Optional series label, rendered inside the tooltip. */
  label?: string;
  /** Optional value formatter, e.g. (v) => `${v.toFixed(1)} req/s`. */
  formatter?: (value: number) => string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // SVG defs need to be unique per render so multiple sparklines on the
  // same page don't collide. Cheap stable id seeded by the first sample.
  const idSeed = data.length > 0 ? `${data[0]}-${data.length}` : 'empty';
  const strokeId = `spark-s-${idSeed}`;
  const fillId = `spark-f-${idSeed}`;

  if (data.length < 2) {
    return <div style={{ height: `${height}px` }} aria-hidden />;
  }
  const rawMax = Math.max(...data);
  const rawMin = Math.min(...data);
  const baseline = rawMin >= 0 ? Math.max(0, rawMin * 0.9) : rawMin;
  const max = Math.max(rawMax, baseline + 0.001);
  const range = max - baseline || 1;
  const xs = data.map((_v, i) => (i / (data.length - 1)) * width);
  const ys = data.map((v) => (1 - (v - baseline) / range) * height);
  const points = data.map((_v, i) => `${xs[i]},${ys[i]}`).join(' ');
  const areaPoints = `0,${height} ${points} ${width},${height}`;
  const strokeRef = gradient ? `url(#${strokeId})` : color;
  const fillRef = gradient ? `url(#${fillId})` : color;

  const hoverable = !!timestamps && timestamps.length === data.length;
  const bucketMs = timestamps && timestamps.length >= 2 ? timestamps[1] - timestamps[0] : 60_000;

  function tsToX(ts: number): number {
    if (!timestamps || timestamps.length < 2) return 0;
    const first = timestamps[0];
    const last = timestamps[timestamps.length - 1];
    const span = last - first;
    if (span <= 0) return 0;
    return ((ts - first) / span) * width;
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!hoverable || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.round((x / rect.width) * (data.length - 1));
    setHoverIdx(Math.max(0, Math.min(idx, data.length - 1)));
  };

  const hoveredTs = hoverIdx !== null && timestamps ? timestamps[hoverIdx] : null;
  const hoveredVal = hoverIdx !== null ? data[hoverIdx] : null;
  const hoveredEvents = hoveredTs != null ? eventsNear(events, hoveredTs, bucketMs) : [];
  const tooltipX = hoverIdx !== null ? xs[hoverIdx] : 0;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={`w-full ${hoverable ? 'cursor-crosshair' : ''}`}
        style={{ height: `${height}px` }}
        aria-hidden={!hoverable}
        onMouseMove={hoverable ? onMove : undefined}
        onMouseLeave={hoverable ? () => setHoverIdx(null) : undefined}
      >
        {gradient && (
          <defs>
            <linearGradient id={strokeId} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="hsl(266 90% 66%)" />
              <stop offset="100%" stopColor="hsl(320 88% 66%)" />
            </linearGradient>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(266 90% 66% / 0.4)" />
              <stop offset="100%" stopColor="hsl(266 90% 66% / 0)" />
            </linearGradient>
          </defs>
        )}
        <polygon points={areaPoints} fill={fillRef} fillOpacity={gradient ? 1 : 0.16} />
        <polyline
          points={points}
          fill="none"
          stroke={strokeRef}
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Event ticks — drawn as 4px lines at the top of the chart so
            they don't fight with the polyline visually. Sparklines are
            tiny; full-height lines would dominate. */}
        {hoverable &&
          events &&
          timestamps &&
          events
            .filter((e) => e.ts >= timestamps[0] && e.ts <= timestamps[timestamps.length - 1])
            .map((e, i) => {
              const x = tsToX(e.ts);
              return (
                <line
                  key={`evt-${e.ts}-${i}`}
                  x1={x}
                  x2={x}
                  y1={0}
                  y2={Math.min(5, height / 4)}
                  stroke={colorForEvent(e)}
                  strokeWidth="1.5"
                  opacity="0.85"
                />
              );
            })}
        {hoverIdx !== null && (
          <>
            <line
              x1={xs[hoverIdx]}
              x2={xs[hoverIdx]}
              y1={0}
              y2={height}
              stroke="var(--color-text)"
              strokeWidth="0.8"
              strokeDasharray="2,2"
              opacity="0.6"
            />
            <circle cx={xs[hoverIdx]} cy={ys[hoverIdx]} r="2" fill="var(--color-text)" />
          </>
        )}
      </svg>
      {hoverIdx !== null && hoveredTs != null && hoveredVal != null && (
        <div
          className="absolute z-10 -translate-x-1/2 -top-1 -translate-y-full bg-bg/95 backdrop-blur-sm border border-border rounded-md px-2 py-1 text-[10px] font-mono text-text-secondary pointer-events-none tabular-nums shadow-lg whitespace-nowrap"
          style={{ left: `calc(${(tooltipX / width) * 100}%)` }}
        >
          <p className="text-text">
            {new Date(hoveredTs).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
          <p>
            {label && <span className="text-text-tertiary">{label} </span>}
            <span className="text-text">
              {formatter ? formatter(hoveredVal) : hoveredVal.toFixed(2)}
            </span>
          </p>
          {hoveredEvents.length > 0 && (
            <div className="mt-1 pt-1 border-t border-border/60 space-y-0.5">
              {hoveredEvents.map((e, i) => (
                <p
                  key={`${e.ts}-${i}`}
                  className="flex items-center gap-1.5"
                  style={{ color: colorForEvent(e) }}
                >
                  <span
                    className="inline-block w-1 h-1 rounded-full"
                    style={{ background: colorForEvent(e) }}
                  />
                  <span className="uppercase tracking-wider text-[9px]">{e.label}</span>
                  {e.detail && <span className="text-text-secondary">{e.detail}</span>}
                  <span className="text-text-tertiary ml-auto">{formatRelative(e.ts)}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
