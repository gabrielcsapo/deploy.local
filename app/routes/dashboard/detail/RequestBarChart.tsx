'use client';

import { useState, useRef } from 'react';

export interface TimeSeriesEntry {
  bucket: number;
  count: number;
  avgDuration: number;
  errorCount: number;
}

function formatBucketLabel(ts: number, intervalMs: number): string {
  const d = new Date(ts);
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (intervalMs < HOUR) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (intervalMs < DAY)
    return d.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function RequestBarChart({
  data,
  bucketIntervalMs,
}: {
  data: TimeSeriesEntry[];
  bucketIntervalMs: number;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (data.length === 0) {
    return (
      <div className="card p-4">
        <div className="h-[120px] flex items-center justify-center text-xs text-text-tertiary">
          No data for chart
        </div>
      </div>
    );
  }

  const width = 600;
  const height = 120;
  const padX = 2;
  const padY = 4;
  const maxCount = Math.max(...data.map((d) => d.count), 1);
  const barGap = 1;
  const barWidth = Math.max(1, (width - padX * 2 - barGap * (data.length - 1)) / data.length);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const relativeX = (x / rect.width) * width;
    const idx = Math.floor((relativeX - padX) / (barWidth + barGap));
    setHoverIndex(Math.max(0, Math.min(idx, data.length - 1)));
  };

  const hovered = hoverIndex !== null ? data[hoverIndex] : null;

  // X-axis labels: show ~5 labels evenly spaced
  const labelCount = Math.min(5, data.length);
  const labelIndices: number[] = [];
  if (data.length <= labelCount) {
    for (let i = 0; i < data.length; i++) labelIndices.push(i);
  } else {
    for (let i = 0; i < labelCount; i++) {
      labelIndices.push(Math.round((i / (labelCount - 1)) * (data.length - 1)));
    }
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-text-tertiary">Requests Over Time</p>
        {hovered && (
          <div className="text-xs text-text-secondary font-mono">
            {hovered.count} req &middot; {hovered.avgDuration}ms avg
            {hovered.errorCount > 0 && (
              <span className="text-danger ml-1">&middot; {hovered.errorCount} errors</span>
            )}
          </div>
        )}
      </div>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          className="w-full cursor-crosshair"
          style={{ height: `${height}px` }}
          preserveAspectRatio="none"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIndex(null)}
          role="img"
          aria-label="Request volume over time"
        >
          {data.map((d, i) => {
            const x = padX + i * (barWidth + barGap);
            const totalH = (d.count / maxCount) * (height - padY * 2);
            const errorH = d.count > 0 ? (d.errorCount / d.count) * totalH : 0;
            const successH = totalH - errorH;
            const y = height - padY - totalH;
            const isHovered = hoverIndex === i;
            return (
              <g key={i}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={successH}
                  fill="var(--color-accent)"
                  opacity={isHovered ? 1 : 0.7}
                />
                {errorH > 0 && (
                  <rect
                    x={x}
                    y={y + successH}
                    width={barWidth}
                    height={errorH}
                    fill="var(--color-danger)"
                    opacity={isHovered ? 1 : 0.7}
                  />
                )}
              </g>
            );
          })}
          {hoverIndex !== null && (
            <line
              x1={padX + hoverIndex * (barWidth + barGap) + barWidth / 2}
              y1={padY}
              x2={padX + hoverIndex * (barWidth + barGap) + barWidth / 2}
              y2={height - padY}
              stroke="var(--color-text-tertiary)"
              strokeWidth="1"
              strokeDasharray="2,2"
            />
          )}
        </svg>
        {hovered && (
          <div className="absolute bottom-0 left-0 right-0 text-center text-[10px] text-text-tertiary bg-bg/90 py-0.5">
            {formatBucketLabel(hovered.bucket, bucketIntervalMs)}
          </div>
        )}
      </div>
      {!hovered && data.length > 1 && (
        <div className="flex justify-between text-[10px] text-text-tertiary mt-1">
          {labelIndices.map((idx) => (
            <span key={idx}>{formatBucketLabel(data[idx].bucket, bucketIntervalMs)}</span>
          ))}
        </div>
      )}
    </div>
  );
}
