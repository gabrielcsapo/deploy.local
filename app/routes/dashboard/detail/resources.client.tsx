'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-flight-router/client';
import {
  fetchContainerStats,
  fetchMetricsHistory,
  fetchRequestRate,
  fetchRequestPunchcard,
} from '../../../actions/metrics';
import { useDetailContext } from './shared';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { formatBytes } from '../../../utils';
import { LoadingState } from '../../../components/LoadingState';

type TimeRange = '1hour' | '6hours' | '24hours' | '1week';

interface Stats {
  cpu: string;
  mem: string;
  memPerc: string;
  net: string;
  block: string;
  pids: string;
}

interface MetricPoint {
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
  timestamp: number;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function healthColor(percent: number): string {
  if (percent >= 90) return 'var(--color-danger)';
  if (percent >= 70) return 'var(--color-warning)';
  return 'var(--color-success)';
}

function Sparkline({
  data,
  width = 300,
  height = 60,
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
}: {
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
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (data.length < 2) {
    return (
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-text-tertiary">{label}</p>
          <p className="text-sm font-mono font-semibold">{current}</p>
        </div>
        <div className="h-[60px] flex items-center justify-center text-xs text-text-tertiary">
          Collecting data...
        </div>
      </div>
    );
  }

  const allValues = secondaryData ? [...data, ...secondaryData] : data;
  const max = Math.max(...allValues, thresholdValue ?? 0, 1);
  const min = Math.min(...allValues, 0);
  const range = max - min || 1;
  const pad = 2;

  function toPoints(values: number[]) {
    return values
      .map((v, i) => {
        const x = pad + (i / (values.length - 1)) * (width - pad * 2);
        const y = pad + (1 - (v - min) / range) * (height - pad * 2);
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
          y: pad + (1 - (data[hoverIndex] - min) / range) * (height - pad * 2),
        }
      : null;

  return (
    <div className="card p-4 relative">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <p className="text-xs text-text-tertiary">{label}</p>
          {secondaryLabel && (
            <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span>{label.split(' ')[0]}</span>
              <span
                className="inline-block w-2 h-2 rounded-full ml-1"
                style={{ backgroundColor: secondaryColor }}
              />
              <span>{secondaryLabel}</span>
            </div>
          )}
        </div>
        <p className="text-sm font-mono font-semibold">{hoverData ? hoverData.primary : current}</p>
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
          <polyline
            points={points}
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            strokeLinejoin="round"
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
              const ty = pad + (1 - (thresholdValue - min) / range) * (height - pad * 2);
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
                    opacity="0.6"
                  />
                  {thresholdLabel && (
                    <text
                      x={width - pad - 2}
                      y={ty - 3}
                      textAnchor="end"
                      fontSize="7"
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
              />
              <circle cx={hoverData.x} cy={hoverData.y} r="3" fill={color} />
            </>
          )}
        </svg>
        {hoverData && hoverData.time && (
          <div className="absolute bottom-0 left-0 right-0 text-center text-[10px] text-text-tertiary bg-bg/90 py-0.5">
            {hoverData.time}
            {hoverData.secondary && ` • ${secondaryLabel}: ${hoverData.secondary}`}
          </div>
        )}
      </div>
      {timeLabels && !hoverData && (
        <div className="flex justify-between text-[10px] text-text-tertiary mt-1">
          <span>{timeLabels[0]}</span>
          <span>{timeLabels[1]}</span>
        </div>
      )}
    </div>
  );
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Punchcard({ data }: { data: { day: number; hour: number; count: number }[] }) {
  const [hoverCell, setHoverCell] = useState<{ day: number; hour: number; count: number } | null>(
    null,
  );
  const maxCount = Math.max(...data.map((d) => d.count), 1);

  const cellSize = 16;
  const labelWidth = 36;
  const headerHeight = 20;
  const gap = 2;
  const svgWidth = labelWidth + 24 * (cellSize + gap);
  const svgHeight = headerHeight + 7 * (cellSize + gap);
  const maxRadius = cellSize / 2 - 1;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-text-tertiary">Request Activity (7 days)</p>
        {hoverCell && (
          <p className="text-xs text-text-secondary font-mono">
            {DAY_LABELS[hoverCell.day]} {hoverCell.hour}:00 — {hoverCell.count.toLocaleString()} req
          </p>
        )}
      </div>
      <svg
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        className="w-full"
        onMouseLeave={() => setHoverCell(null)}
        role="img"
        aria-label="Request activity punchcard: shows request volume by day of week and hour"
      >
        {/* Hour labels */}
        {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
          <text
            key={h}
            x={labelWidth + h * (cellSize + gap) + cellSize / 2}
            y={headerHeight - 6}
            textAnchor="middle"
            fontSize="7"
            fill="var(--color-text-tertiary)"
          >
            {h}
          </text>
        ))}
        {/* Day labels */}
        {DAY_LABELS.map((label, i) => (
          <text
            key={i}
            x={labelWidth - 4}
            y={headerHeight + i * (cellSize + gap) + cellSize / 2 + 3}
            textAnchor="end"
            fontSize="7"
            fill="var(--color-text-tertiary)"
          >
            {label}
          </text>
        ))}
        {/* Circles */}
        {data.map(({ day, hour, count }) => {
          const cx = labelWidth + hour * (cellSize + gap) + cellSize / 2;
          const cy = headerHeight + day * (cellSize + gap) + cellSize / 2;
          const ratio = count / maxCount;
          const radius = count === 0 ? 1.5 : 2 + ratio * (maxRadius - 2);
          const opacity = count === 0 ? 0.08 : 0.2 + 0.8 * ratio;
          const isHovered = hoverCell && hoverCell.day === day && hoverCell.hour === hour;
          return (
            <circle
              key={`${day}-${hour}`}
              cx={cx}
              cy={cy}
              r={isHovered ? radius + 1 : radius}
              fill="var(--color-accent)"
              opacity={isHovered ? 1 : opacity}
              className="cursor-pointer transition-all duration-75"
              onMouseEnter={() => setHoverCell({ day, hour, count })}
            />
          );
        })}
      </svg>
    </div>
  );
}

export default function Component() {
  const { deployment } = useDetailContext();
  const name = deployment.name;
  const [searchParams, setSearchParams] = useSearchParams();
  const [stats, setStats] = useState<Stats | null>(null);
  const [metrics, setMetrics] = useState<MetricPoint[]>([]);
  const [requestRate, setRequestRate] = useState<{ timestamp: number; count: number }[]>([]);
  const [punchcard, setPunchcard] = useState<{ day: number; hour: number; count: number }[]>([]);
  const [error, setError] = useState('');
  const [timeRange, setTimeRange] = useState<TimeRange>(
    (searchParams.get('range') as TimeRange) || '1hour',
  );

  const timeRangeMinutes = useMemo(() => {
    const ranges: Record<TimeRange, number> = {
      '1hour': 60,
      '6hours': 360,
      '24hours': 1440,
      '1week': 10080,
    };
    return ranges[timeRange];
  }, [timeRange]);

  const fetchStats = useCallback(async () => {
    try {
      const data = await fetchContainerStats(name);
      if (!data) {
        setError('not running');
        return;
      }
      setStats(data as Stats);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [name]);

  const fetchHistory = useCallback(async () => {
    try {
      const [metricsData, rateData] = await Promise.all([
        fetchMetricsHistory(name, timeRangeMinutes),
        fetchRequestRate(name, timeRangeMinutes),
      ]);
      setMetrics(metricsData as MetricPoint[]);
      setRequestRate(rateData);
    } catch {
      // may not have data yet
    }
  }, [name, timeRangeMinutes]);

  const fetchPunchcardData = useCallback(async () => {
    try {
      const data = await fetchRequestPunchcard(name);
      setPunchcard(data);
    } catch {
      // ignore
    }
  }, [name]);

  // Initial fetch of current stats, history, and punchcard
  useEffect(() => {
    fetchStats();
    fetchHistory();
    fetchPunchcardData();
  }, [fetchStats, fetchHistory, fetchPunchcardData]);

  // WebSocket for real-time metrics updates
  const channels = useMemo(() => [`deployment:${name}`], [name]);
  const handleWsEvent = useCallback(
    (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'metrics:update') {
        const point = event.data as unknown as MetricPoint;
        setMetrics((prev) => {
          const cutoff = Date.now() - timeRangeMinutes * 60_000;
          return [...prev.filter((m) => m.timestamp >= cutoff), point];
        });
        setStats({
          cpu: `${point.cpuPercent.toFixed(2)}%`,
          mem: formatBytes(point.memUsageBytes) + ' / ' + formatBytes(point.memLimitBytes),
          memPerc: `${point.memPercent.toFixed(1)}%`,
          net: formatBytes(point.netRxBytes) + ' / ' + formatBytes(point.netTxBytes),
          block: formatBytes(point.blockReadBytes) + ' / ' + formatBytes(point.blockWriteBytes),
          pids: String(point.pids),
        });
        setError('');
      }
      if (event.type === 'request:logged') {
        // Increment the latest request rate bucket
        setRequestRate((prev) => {
          if (prev.length === 0) return prev;
          const updated = [...prev];
          const last = updated[updated.length - 1];
          updated[updated.length - 1] = { ...last, count: last.count + 1 };
          return updated;
        });
        // Increment the matching punchcard cell
        const now = new Date();
        const day = now.getDay();
        const hour = now.getHours();
        setPunchcard((prev) => {
          if (prev.length === 0) return prev;
          return prev.map((cell) =>
            cell.day === day && cell.hour === hour ? { ...cell, count: cell.count + 1 } : cell,
          );
        });
      }
    },
    [timeRangeMinutes],
  );
  useWebSocket(channels, handleWsEvent);

  const handleTimeRangeChange = (range: TimeRange) => {
    setTimeRange(range);
    const params = new URLSearchParams(searchParams);
    if (range === '1hour') {
      params.delete('range');
    } else {
      params.set('range', range);
    }
    setSearchParams(params);
  };

  if (error) {
    return (
      <div className="card p-6 text-center text-sm text-text-secondary">
        Container is not running. Resources are unavailable.
      </div>
    );
  }

  if (!stats) {
    return <LoadingState message="Loading stats..." />;
  }

  const cpuData = metrics.map((m) => m.cpuPercent);
  const memData = metrics.map((m) => m.memUsageBytes);
  const netRxData = metrics.map((m) => m.netRxBytes);
  const netTxData = metrics.map((m) => m.netTxBytes);
  const blockReadData = metrics.map((m) => m.blockReadBytes);
  const blockWriteData = metrics.map((m) => m.blockWriteBytes);
  const timestamps = metrics.map((m) => m.timestamp);

  const derivedStats =
    metrics.length > 0
      ? (() => {
          const cpuValues = metrics.map((m) => m.cpuPercent);
          const memPercValues = metrics.map((m) => m.memPercent);
          const memUsageValues = metrics.map((m) => m.memUsageBytes);
          return {
            cpuAvg: cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length,
            cpuPeak: Math.max(...cpuValues),
            memPercAvg: memPercValues.reduce((a, b) => a + b, 0) / memPercValues.length,
            memPercPeak: Math.max(...memPercValues),
            memUsagePeak: Math.max(...memUsageValues),
          };
        })()
      : null;

  const reqRateData = requestRate.map((r) => r.count);
  const reqRateTimestamps = requestRate.map((r) => r.timestamp);
  const bucketSecs =
    requestRate.length >= 2 ? (requestRate[1].timestamp - requestRate[0].timestamp) / 1000 : 60;
  const currentReqPerSec =
    requestRate.length > 0
      ? (requestRate[requestRate.length - 1].count / bucketSecs).toFixed(1)
      : '0';

  const timeRangeOptions: { value: TimeRange; label: string }[] = [
    { value: '1hour', label: '1 Hour' },
    { value: '6hours', label: '6 Hours' },
    { value: '24hours', label: '24 Hours' },
    { value: '1week', label: '1 Week' },
  ];

  return (
    <div className="space-y-6">
      {/* Timeline Selector */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-text-secondary">Time Range</p>
          <div className="flex gap-2">
            {timeRangeOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => handleTimeRangeChange(option.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  timeRange === option.value
                    ? 'bg-accent text-white'
                    : 'bg-bg-secondary text-text-secondary hover:bg-bg-tertiary'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card p-4">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-text-tertiary">CPU</p>
            {derivedStats && (
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: healthColor(parseFloat(stats.cpu)) }}
              />
            )}
          </div>
          <p className="text-lg font-semibold font-mono">{stats.cpu}</p>
          {derivedStats && (
            <div className="flex gap-3 text-[11px] text-text-secondary mt-1">
              <span>Avg {derivedStats.cpuAvg.toFixed(1)}%</span>
              <span>Peak {derivedStats.cpuPeak.toFixed(1)}%</span>
            </div>
          )}
        </div>
        <div className="card p-4">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-text-tertiary">Memory</p>
            {derivedStats && (
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: healthColor(parseFloat(stats.memPerc)) }}
              />
            )}
          </div>
          <p className="text-lg font-semibold font-mono">{stats.mem}</p>
          <p className="text-xs text-text-secondary mt-0.5">{stats.memPerc}</p>
          {derivedStats && (
            <div className="flex gap-3 text-[11px] text-text-secondary mt-1">
              <span>Avg {derivedStats.memPercAvg.toFixed(1)}%</span>
              <span>Peak {formatBytes(derivedStats.memUsagePeak)}</span>
            </div>
          )}
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-tertiary mb-1">PIDs</p>
          <p className="text-lg font-semibold font-mono">{stats.pids}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-tertiary mb-1">Requests/s</p>
          <p className="text-lg font-semibold font-mono">{currentReqPerSec}</p>
          {requestRate.length > 0 &&
            (() => {
              const totalReqs = requestRate.reduce((a, b) => a + b.count, 0);
              return (
                <div className="text-[11px] text-text-secondary mt-1">
                  <span>{totalReqs.toLocaleString()} total in range</span>
                </div>
              );
            })()}
        </div>
        {deployment.gpuEnabled && (
          <div className="card p-4">
            <p className="text-xs text-text-tertiary mb-1">GPU</p>
            <p className="text-lg font-semibold font-mono">Enabled</p>
            <div className="text-[11px] text-text-secondary mt-1">
              <span>--gpus all</span>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Sparkline
          data={cpuData}
          color="var(--color-accent)"
          label="CPU %"
          current={stats.cpu}
          timestamps={timestamps}
          formatter={(v) => `${v.toFixed(2)}%`}
        />
        <Sparkline
          data={memData}
          color="var(--color-success)"
          label="Memory"
          current={stats.mem}
          timestamps={timestamps}
          formatter={formatBytes}
          thresholdValue={
            metrics.length > 0 ? metrics[metrics.length - 1].memLimitBytes : undefined
          }
          thresholdLabel="Limit"
          thresholdColor="var(--color-danger)"
        />
        <Sparkline
          data={netRxData}
          secondaryData={netTxData}
          color="var(--color-accent)"
          secondaryColor="var(--color-warning)"
          label="Network RX"
          secondaryLabel="TX"
          current={stats.net}
          timestamps={timestamps}
          formatter={formatBytes}
        />
        <Sparkline
          data={blockReadData}
          secondaryData={blockWriteData}
          color="var(--color-accent)"
          secondaryColor="var(--color-warning)"
          label="Disk Read"
          secondaryLabel="Write"
          current={stats.block}
          timestamps={timestamps}
          formatter={formatBytes}
        />
        <Sparkline
          data={reqRateData}
          color="var(--color-accent)"
          label="Requests"
          current={`${currentReqPerSec}/s`}
          timestamps={reqRateTimestamps}
          formatter={(v) => `${Math.round(v)} req`}
        />
      </div>

      {/* Punchcard */}
      {punchcard.length > 0 && <Punchcard data={punchcard} />}
    </div>
  );
}
