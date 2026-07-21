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
import { Sparkline as DashboardSparkline } from '../../../components/dashboard/Sparkline';
import { StatCard } from '../../../components/dashboard/StatCard';
import {
  TimeRange as TimeRangeComponent,
  resolvePreset,
  type TimeRangeValue,
} from '../../../components/dashboard/TimeRange';

type TimeRange = '1hour' | '6hours' | '24hours' | '1week';

// URL ↔ internal label mapping. The URL form (`1h`/`6h`/`24h`/`7d`) is
// shared with the Requests tab so a user who picks "6h" on Requests sees
// the same range on Resources too. Internal label is kept for backward-
// compat with the fetch action signature.
function rangeFromUrl(param: string | null): TimeRange {
  switch (param) {
    case '1h':
      return '1hour';
    case '6h':
      return '6hours';
    case '24h':
      return '24hours';
    case '7d':
    case '30d':
      return '1week';
    default:
      return '1hour';
  }
}
function rangeToUrl(range: TimeRange): string {
  return range === '1hour' ? '1h' : range === '6hours' ? '6h' : range === '24hours' ? '24h' : '7d';
}

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

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Punchcard({ data }: { data: { day: number; hour: number; count: number }[] }) {
  const [activeCell, setActiveCell] = useState<{ day: number; hour: number; count: number } | null>(
    null,
  );
  const maxCount = Math.max(...data.map((d) => d.count), 1);

  const cellSize = 16;
  const labelWidth = 36;
  const headerHeight = 20;
  const gap = 2;
  const svgWidth = labelWidth + 24 * (cellSize + gap);
  const svgHeight = headerHeight + 7 * (cellSize + gap);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-text-tertiary">Request Activity (7 days)</p>
        {activeCell && (
          <p className="text-xs text-text-secondary font-mono">
            {DAY_LABELS[activeCell.day]} {activeCell.hour}:00 — {activeCell.count.toLocaleString()} req
          </p>
        )}
      </div>
      <svg
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        className="w-full"
        tabIndex={0}
        onFocus={() => setActiveCell((current) => current ?? data[0] ?? null)}
        onBlur={() => setActiveCell(null)}
        onMouseLeave={() => setActiveCell(null)}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const current = activeCell ?? data[0] ?? { day: 0, hour: 0, count: 0 };
          const dayDelta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
          const hourDelta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
          const day = (current.day + dayDelta + 7) % 7;
          const hour = (current.hour + hourDelta + 24) % 24;
          setActiveCell(data.find((cell) => cell.day === day && cell.hour === hour) ?? { day, hour, count: 0 });
        }}
        role="img"
        aria-label={
          activeCell
            ? `Request activity: ${DAY_LABELS[activeCell.day]} at ${activeCell.hour}:00, ${activeCell.count} requests. Use arrow keys to explore.`
            : 'Request activity by day and hour. Focus and use arrow keys to explore.'
        }
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
        {/* Heatmap rectangles */}
        {data.map(({ day, hour, count }) => {
          const x = labelWidth + hour * (cellSize + gap);
          const y = headerHeight + day * (cellSize + gap);
          const ratio = count / maxCount;
          // Non-linear ramp so low values are still visible; baseline floor of 0.08 for empties.
          const opacity = count === 0 ? 0.08 : 0.2 + 0.8 * Math.sqrt(ratio);
          const isHovered = activeCell && activeCell.day === day && activeCell.hour === hour;
          return (
            <rect
              key={`${day}-${hour}`}
              x={x}
              y={y}
              width={cellSize}
              height={cellSize}
              rx={2}
              fill="var(--color-accent)"
              opacity={isHovered ? 1 : opacity}
              stroke={isHovered ? 'var(--color-accent)' : 'none'}
              strokeWidth="1"
              className="cursor-pointer transition-all duration-75"
              onMouseEnter={() => setActiveCell({ day, hour, count })}
            />
          );
        })}
      </svg>
      <p className="mt-2 text-[10px] text-text-tertiary">Focus the chart and use arrow keys to inspect each hour.</p>
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
  const [timeRange, setTimeRange] = useState<TimeRange>(rangeFromUrl(searchParams.get('range')));

  // Deep-link target: ?metric=cpu|memory scrolls the relevant chart into
  // view and flashes a highlight ring — Datadog-style "click the stat,
  // land on the graph." Fires once after the first stats load.
  const targetMetric = searchParams.get('metric');
  const [flashMetric, setFlashMetric] = useState<string | null>(null);
  const scrolledRef = useRef(false);

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

  // Scroll-to + flash the deep-linked metric once stats have loaded.
  useEffect(() => {
    if (!targetMetric || !stats || scrolledRef.current) return;
    const el = document.getElementById(`metric-${targetMetric}`);
    if (!el) return;
    scrolledRef.current = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashMetric(targetMetric);
    const t = setTimeout(() => setFlashMetric(null), 2200);
    return () => clearTimeout(t);
  }, [targetMetric, stats]);

  const handleTimeRangeChange = (range: TimeRange) => {
    setTimeRange(range);
    const params = new URLSearchParams(searchParams);
    const urlValue = rangeToUrl(range);
    if (urlValue === '1h') {
      params.delete('range');
    } else {
      params.set('range', urlValue);
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

  return (
    <div className="space-y-6">
      {/* Timeline Selector */}
      <div className="card p-3 sm:p-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <p className="text-xs text-text-tertiary uppercase tracking-wider">Time Range</p>
          <TimeRangeComponent
            value={resolvePreset(
              timeRange === '1hour'
                ? '1h'
                : timeRange === '6hours'
                  ? '6h'
                  : timeRange === '24hours'
                    ? '24h'
                    : '7d',
            )}
            onChange={(next: TimeRangeValue) => {
              if (next.preset === '1h') handleTimeRangeChange('1hour');
              else if (next.preset === '6h') handleTimeRangeChange('6hours');
              else if (next.preset === '24h') handleTimeRangeChange('24hours');
              else if (next.preset === '7d' || next.preset === '30d')
                handleTimeRangeChange('1week');
            }}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard
          label="CPU"
          value={stats.cpu}
          sub={
            derivedStats
              ? `Avg ${derivedStats.cpuAvg.toFixed(1)}% · Peak ${derivedStats.cpuPeak.toFixed(1)}%`
              : undefined
          }
          tone={
            parseFloat(stats.cpu) >= 90
              ? 'danger'
              : parseFloat(stats.cpu) >= 70
                ? 'warning'
                : 'success'
          }
          sparkline={
            metrics.length > 1
              ? { data: metrics.map((m) => m.cpuPercent), color: 'var(--color-accent)' }
              : undefined
          }
        />
        <StatCard
          label="Memory"
          value={stats.mem}
          sub={`${stats.memPerc}${derivedStats ? ` · Peak ${formatBytes(derivedStats.memUsagePeak)}` : ''}`}
          tone={
            parseFloat(stats.memPerc) >= 90
              ? 'danger'
              : parseFloat(stats.memPerc) >= 70
                ? 'warning'
                : 'success'
          }
          sparkline={
            metrics.length > 1
              ? { data: metrics.map((m) => m.memUsageBytes), color: 'var(--color-success)' }
              : undefined
          }
        />
        <StatCard label="PIDs" value={stats.pids} />
        <StatCard
          label="Requests / s"
          value={currentReqPerSec}
          sub={
            requestRate.length > 0
              ? `${requestRate.reduce((a, b) => a + b.count, 0).toLocaleString()} total in range`
              : undefined
          }
          sparkline={
            requestRate.length > 1
              ? { data: requestRate.map((r) => r.count), color: 'var(--color-accent)' }
              : undefined
          }
        />
        {deployment.gpuEnabled && (
          <StatCard label="GPU" value="Enabled" sub="--gpus all" tone="accent" />
        )}
        {deployment.privilegedDocker && (
          <StatCard
            label="Privileged Docker"
            value="Enabled"
            sub="-v /var/run/docker.sock"
            tone="warning"
          />
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
        <div
          id="metric-cpu"
          className={`rounded-xl transition-shadow scroll-mt-24 ${
            flashMetric === 'cpu' ? 'ring-2 ring-accent' : ''
          }`}
        >
          <DashboardSparkline
            data={cpuData}
            color="var(--color-accent)"
            label="CPU %"
            current={stats.cpu}
            timestamps={timestamps}
            formatter={(v) => `${v.toFixed(2)}%`}
          />
        </div>
        <div
          id="metric-memory"
          className={`rounded-xl transition-shadow scroll-mt-24 ${
            flashMetric === 'memory' ? 'ring-2 ring-accent' : ''
          }`}
        >
          <DashboardSparkline
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
        </div>
        <DashboardSparkline
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
        <DashboardSparkline
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
        <DashboardSparkline
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
