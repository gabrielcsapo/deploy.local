'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useOutletContext, useSearchParams } from 'react-router';
import {
  fetchRequestData as serverFetchRequests,
  fetchEndpointDetail as serverFetchEndpointDetail,
} from '../../../actions/deployments';
import { appUrl, getAuth, StatCard } from './shared';
import type { DetailContext } from './shared';
import { useWebSocket } from '../../../hooks/useWebSocket';

interface RequestLog {
  method: string;
  path: string;
  status: number;
  duration: number;
  timestamp: number;
  ip?: string | null;
  userAgent?: string | null;
  referrer?: string | null;
  requestSize?: number | null;
  responseSize?: number | null;
  queryParams?: string | null;
  username?: string | null;
}

interface RequestSummary {
  total: number;
  statusCodes: Record<string, number>;
  avgDuration: number;
  recentRpm: number;
  p50: number;
  p95: number;
  p99: number;
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface PathStats {
  path: string;
  count: number;
  avgDuration: number;
  errorRate: number;
}

interface DataTransferStats {
  path: string;
  requestBytes: number;
  responseBytes: number;
  count: number;
}

interface EndpointDetailResult {
  summary: {
    totalRequests: number;
    avgDuration: number;
    p50: number;
    p95: number;
    p99: number;
    errorRate: number;
    statusCodes: Record<string, number>;
    totalRequestBytes: number;
    totalResponseBytes: number;
  };
  timeSeries: Array<{
    bucket: number;
    count: number;
    avgDuration: number;
    errorCount: number;
  }>;
  recentRequests: {
    logs: RequestLog[];
    total: number;
    page: number;
    totalPages: number;
  };
  bucketIntervalMs: number;
}

function formatBucketLabel(ts: number, intervalMs: number): string {
  const d = new Date(ts);
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (intervalMs < HOUR) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (intervalMs < DAY)
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function RequestBarChart({
  data,
  bucketIntervalMs,
}: {
  data: EndpointDetailResult['timeSeries'];
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

type TimeRange = '1day' | '1week' | '1month' | '1year' | 'custom' | 'all';

export default function Component() {
  const { deployment } = useOutletContext<DetailContext>();
  const name = deployment.name;
  const [searchParams, setSearchParams] = useSearchParams();

  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [summary, setSummary] = useState<RequestSummary | null>(null);
  const [pathAnalytics, setPathAnalytics] = useState<PathStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(Number(searchParams.get('page')) || 1);
  const [totalPages, setTotalPages] = useState(1);
  const [pathFilter, setPathFilter] = useState(searchParams.get('path') || '');
  const [filterInput, setFilterInput] = useState(searchParams.get('path') || '');
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [pathPage, setPathPage] = useState(1);
  const pathsPerPage = 4;
  const [statusFilter, setStatusFilter] = useState<string | null>(searchParams.get('status'));
  const [showDataModal, setShowDataModal] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRange>(
    (searchParams.get('timeRange') as TimeRange) || 'all',
  );
  const [customFrom, setCustomFrom] = useState(searchParams.get('from') || '');
  const [customTo, setCustomTo] = useState(searchParams.get('to') || '');

  // Endpoint detail modal state
  const [endpointModalPath, setEndpointModalPath] = useState<string | null>(null);
  const [endpointDetail, setEndpointDetail] = useState<EndpointDetailResult | null>(null);
  const [endpointLoading, setEndpointLoading] = useState(false);
  const [endpointPage, setEndpointPage] = useState(1);

  // Update URL query params
  const updateQueryParams = useCallback(
    (updates: Record<string, string | number | null>) => {
      const params = new URLSearchParams(searchParams);
      Object.entries(updates).forEach(([key, value]) => {
        if (value === null || value === '' || value === 'all') {
          params.delete(key);
        } else {
          params.set(key, String(value));
        }
      });
      setSearchParams(params);
    },
    [searchParams, setSearchParams],
  );

  // Calculate timestamp range based on selected time range
  const getTimestampRange = useCallback((): { fromTimestamp?: number; toTimestamp?: number } => {
    if (timeRange === 'all') return {};
    if (timeRange === 'custom') {
      return {
        fromTimestamp: customFrom ? new Date(customFrom).getTime() : undefined,
        toTimestamp: customTo ? new Date(customTo).getTime() : undefined,
      };
    }

    const now = Date.now();
    const ranges: Record<Exclude<TimeRange, 'all' | 'custom'>, number> = {
      '1day': 24 * 60 * 60 * 1000,
      '1week': 7 * 24 * 60 * 60 * 1000,
      '1month': 30 * 24 * 60 * 60 * 1000,
      '1year': 365 * 24 * 60 * 60 * 1000,
    };

    return {
      fromTimestamp: now - ranges[timeRange as keyof typeof ranges],
      toTimestamp: now,
    };
  }, [timeRange, customFrom, customTo]);

  const fetchRequests = useCallback(
    async (currentPage: number, filter: string, status?: string | null) => {
      try {
        const auth = getAuth();
        if (!auth) return;
        const timestamps = getTimestampRange();
        const data = await serverFetchRequests(auth.username, auth.token, name, {
          page: currentPage,
          limit: 30,
          pathFilter: filter || undefined,
          statusFilter: status || undefined,
          ...timestamps,
        });
        setLogs(data.logs as RequestLog[]);
        setSummary(data.summary as RequestSummary);
        setPathAnalytics((data.pathAnalytics as PathStats[]) || []);
        setTotalPages(data.totalPages);
      } catch {
        // may not have data yet
      } finally {
        setLoading(false);
      }
    },
    [name, getTimestampRange],
  );

  // Initial fetch
  useEffect(() => {
    fetchRequests(page, pathFilter, statusFilter);
  }, [fetchRequests, page, pathFilter, statusFilter, timeRange, customFrom, customTo]);

  // WebSocket for real-time request updates
  const channels = useMemo(() => [`deployment:${name}`], [name]);
  const handleWsEvent = useCallback(
    (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'request:logged') {
        const entry = event.data as unknown as RequestLog;
        // Only add to current page if we're on page 1 and no filter
        if (page === 1 && !pathFilter) {
          setLogs((prev) => {
            const updated = [entry, ...prev];
            // Keep only the page limit (30)
            return updated.slice(0, 30);
          });
          // Update summary stats incrementally
          setSummary((prev) => {
            if (!prev) return prev;
            const statusGroup = `${Math.floor(entry.status / 100)}xx`;
            return {
              ...prev,
              total: prev.total + 1,
              statusCodes: {
                ...prev.statusCodes,
                [statusGroup]: (prev.statusCodes[statusGroup] || 0) + 1,
              },
            };
          });
        }
        // Refetch path analytics since they're based on all requests
        fetchRequests(page, pathFilter, statusFilter);
      }
    },
    [page, pathFilter, statusFilter, fetchRequests],
  );
  useWebSocket(channels, handleWsEvent);

  // Fetch endpoint detail when modal opens
  useEffect(() => {
    if (!endpointModalPath) return;
    setEndpointLoading(true);
    const auth = getAuth();
    if (!auth) return;
    const timestamps = getTimestampRange();
    serverFetchEndpointDetail(auth.username, auth.token, name, endpointModalPath, {
      page: endpointPage,
      limit: 20,
      ...timestamps,
    })
      .then((data) => setEndpointDetail(data as EndpointDetailResult))
      .catch(() => {})
      .finally(() => setEndpointLoading(false));
  }, [endpointModalPath, endpointPage, name, getTimestampRange]);

  const openEndpointModal = (path: string) => {
    setEndpointPage(1);
    setEndpointDetail(null);
    setEndpointModalPath(path);
  };

  const handleFilterSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPathFilter(filterInput);
    setPage(1);
    updateQueryParams({ path: filterInput, page: 1 });
  };

  const clearFilter = () => {
    setFilterInput('');
    setPathFilter('');
    setStatusFilter(null);
    setPage(1);
    updateQueryParams({ path: null, status: null, page: 1 });
  };

  const handleTimeRangeChange = (range: TimeRange) => {
    setTimeRange(range);
    updateQueryParams({ timeRange: range, page: 1 });
    setPage(1);
  };

  const handleCustomFromChange = (value: string) => {
    setCustomFrom(value);
    updateQueryParams({ from: value, page: 1 });
    setPage(1);
  };

  const handleCustomToChange = (value: string) => {
    setCustomTo(value);
    updateQueryParams({ to: value, page: 1 });
    setPage(1);
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    updateQueryParams({ page: newPage });
  };

  // Paginate path analytics
  const totalPathPages = Math.ceil(pathAnalytics.length / pathsPerPage);
  const paginatedPathAnalytics = useMemo(() => {
    const startIndex = (pathPage - 1) * pathsPerPage;
    return pathAnalytics.slice(startIndex, startIndex + pathsPerPage);
  }, [pathAnalytics, pathPage]);

  // No need for client-side filtering since server now handles it
  const filteredLogs = logs;

  // Calculate total data transfer
  const dataTransfer = useMemo(() => {
    const totalRequestBytes = logs.reduce((sum, log) => sum + (log.requestSize || 0), 0);
    const totalResponseBytes = logs.reduce((sum, log) => sum + (log.responseSize || 0), 0);
    return { totalRequestBytes, totalResponseBytes };
  }, [logs]);

  // Calculate data transfer by path
  const dataTransferByPath = useMemo<DataTransferStats[]>(() => {
    const pathMap = new Map<
      string,
      { requestBytes: number; responseBytes: number; count: number }
    >();

    logs.forEach((log) => {
      if (!pathMap.has(log.path)) {
        pathMap.set(log.path, { requestBytes: 0, responseBytes: 0, count: 0 });
      }
      const stats = pathMap.get(log.path)!;
      stats.requestBytes += log.requestSize || 0;
      stats.responseBytes += log.responseSize || 0;
      stats.count++;
    });

    return Array.from(pathMap.entries())
      .map(([path, stats]) => ({
        path,
        requestBytes: stats.requestBytes,
        responseBytes: stats.responseBytes,
        count: stats.count,
      }))
      .sort((a, b) => b.responseBytes + b.requestBytes - (a.responseBytes + a.requestBytes));
  }, [logs]);

  const handleStatusCodeClick = (statusCode: string) => {
    const newFilter = statusFilter === statusCode ? null : statusCode;
    setStatusFilter(newFilter);
    updateQueryParams({ status: newFilter, page: 1 });
    setPage(1);
  };

  const clearStatusFilter = () => {
    setStatusFilter(null);
    updateQueryParams({ status: null, page: 1 });
    setPage(1);
  };

  if (loading) {
    return <div className="text-sm text-text-tertiary text-center py-8">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="card p-4">
        <p className="text-xs text-text-tertiary mb-2">
          App URL:{' '}
          <a
            href={appUrl(name)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:text-accent-hover font-mono"
          >
            {name}.local
          </a>
        </p>
        <p className="text-xs text-text-secondary">
          All traffic to this subdomain is tracked automatically.
        </p>
      </div>

      {/* Time Range Filter */}
      <div className="card p-4">
        <p className="text-xs text-text-tertiary mb-2">Time Range</p>
        <div className="flex flex-wrap gap-2">
          {(['all', '1day', '1week', '1month', '1year', 'custom'] as TimeRange[]).map((range) => (
            <button
              key={range}
              onClick={() => handleTimeRangeChange(range)}
              className={`btn btn-sm ${timeRange === range ? 'btn-primary' : ''}`}
            >
              {range === 'all'
                ? 'All Time'
                : range === '1day'
                  ? 'Last 24h'
                  : range === '1week'
                    ? 'Last Week'
                    : range === '1month'
                      ? 'Last Month'
                      : range === '1year'
                        ? 'Last Year'
                        : 'Custom'}
            </button>
          ))}
        </div>
        {timeRange === 'custom' && (
          <div className="flex gap-2 mt-3">
            <div className="flex-1">
              <label className="text-xs text-text-tertiary block mb-1">From</label>
              <input
                type="datetime-local"
                value={customFrom}
                onChange={(e) => handleCustomFromChange(e.target.value)}
                className="input w-full text-sm"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-text-tertiary block mb-1">To</label>
              <input
                type="datetime-local"
                value={customTo}
                onChange={(e) => handleCustomToChange(e.target.value)}
                className="input w-full text-sm"
              />
            </div>
          </div>
        )}
      </div>

      {summary && summary.total > 0 ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatCard label="Total Requests" value={String(summary.total)} />
            <StatCard label="Avg Response" value={`${summary.avgDuration}ms`} />
            <StatCard label="Requests/min" value={String(summary.recentRpm)} />
            <div
              className="card p-4 cursor-pointer hover:bg-bg-hover transition-colors"
              onClick={() => setShowDataModal(true)}
              title="Click to view detailed data transfer by path"
            >
              <p className="text-xs text-text-tertiary mb-1">Data Transfer</p>
              <p className="text-lg font-semibold font-mono">
                {formatBytes(dataTransfer.totalResponseBytes)}
              </p>
              <p className="text-xs text-text-secondary mt-0.5">
                ↑ {formatBytes(dataTransfer.totalRequestBytes)} sent
              </p>
            </div>
            <div className="card p-4">
              <p className="text-xs text-text-tertiary mb-1">Status Codes</p>
              <div className="flex flex-wrap gap-2 mt-1">
                {Object.entries(summary.statusCodes).map(([code, count]) => (
                  <button
                    key={code}
                    onClick={() => handleStatusCodeClick(code)}
                    className={`text-xs font-mono px-1.5 py-0.5 rounded transition-all hover:scale-105 ${
                      statusFilter === code ? 'ring-2 ring-offset-1 ring-offset-bg' : ''
                    } ${
                      code === '2xx'
                        ? 'bg-success/10 text-success hover:bg-success/20 ring-success'
                        : code === '3xx'
                          ? 'bg-accent/10 text-accent hover:bg-accent/20 ring-accent'
                          : code === '4xx'
                            ? 'bg-warning/10 text-warning hover:bg-warning/20 ring-warning'
                            : 'bg-danger/10 text-danger hover:bg-danger/20 ring-danger'
                    }`}
                  >
                    {code}: {count}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <StatCard label="p50 (median)" value={`${summary.p50}ms`} sub="50th percentile" />
            <StatCard label="p95" value={`${summary.p95}ms`} sub="95th percentile" />
            <StatCard label="p99" value={`${summary.p99}ms`} sub="99th percentile" />
          </div>

          {pathAnalytics.length > 0 && (
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                  Top Paths by Request Count
                </h3>
                {totalPathPages > 1 && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setPathPage((p) => Math.max(1, p - 1))}
                      disabled={pathPage === 1}
                      className="btn btn-sm text-xs"
                    >
                      ‹
                    </button>
                    <span className="text-xs text-text-tertiary">
                      {pathPage} / {totalPathPages}
                    </span>
                    <button
                      onClick={() => setPathPage((p) => Math.min(totalPathPages, p + 1))}
                      disabled={pathPage === totalPathPages}
                      className="btn btn-sm text-xs"
                    >
                      ›
                    </button>
                  </div>
                )}
              </div>
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-text-tertiary">
                      <th className="px-4 py-2 font-medium">Path</th>
                      <th className="px-4 py-2 font-medium">Requests</th>
                      <th className="px-4 py-2 font-medium">Avg Duration</th>
                      <th className="px-4 py-2 font-medium">Error Rate</th>
                      <th className="px-4 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {paginatedPathAnalytics.map((stat) => (
                      <tr key={stat.path} className="hover:bg-bg-hover transition-colors">
                        <td className="px-4 py-2 font-mono text-xs text-text-secondary truncate max-w-[300px]">
                          {stat.path}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs font-medium">{stat.count}</td>
                        <td className="px-4 py-2 font-mono text-xs text-text-secondary">
                          {stat.avgDuration}ms
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                              stat.errorRate === 0
                                ? 'bg-success/10 text-success'
                                : stat.errorRate < 10
                                  ? 'bg-warning/10 text-warning'
                                  : 'bg-danger/10 text-danger'
                            }`}
                          >
                            {stat.errorRate}%
                          </span>
                        </td>
                        <td className="px-4 py-2 flex gap-1">
                          <button
                            onClick={() => openEndpointModal(stat.path)}
                            className="btn btn-sm btn-primary"
                          >
                            Details
                          </button>
                          <button
                            onClick={() => {
                              setFilterInput(stat.path);
                              setPathFilter(stat.path);
                              handlePageChange(1);
                              updateQueryParams({ path: stat.path, page: 1 });
                            }}
                            className="btn btn-sm"
                          >
                            Filter
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card p-4">
            <form onSubmit={handleFilterSubmit} className="flex gap-2">
              <input
                type="text"
                value={filterInput}
                onChange={(e) => setFilterInput(e.target.value)}
                placeholder="Filter by path (e.g., /api/%)"
                className="input flex-1"
              />
              <button type="submit" className="btn btn-primary">
                Filter
              </button>
              {(pathFilter || statusFilter) && (
                <button type="button" onClick={clearFilter} className="btn">
                  Clear All
                </button>
              )}
            </form>
            <div className="flex flex-wrap gap-2 mt-2">
              {pathFilter && (
                <p className="text-xs text-text-secondary">
                  Path: <span className="font-mono">{pathFilter}</span>
                </p>
              )}
              {statusFilter && (
                <p className="text-xs text-text-secondary">
                  Status:{' '}
                  <span className="font-mono">
                    {statusFilter}
                    <button
                      onClick={clearStatusFilter}
                      className="ml-1 text-text-tertiary hover:text-text-primary"
                    >
                      ✕
                    </button>
                  </span>
                </p>
              )}
            </div>
          </div>

          <div className="card overflow-hidden">
            <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider px-4 py-3 border-b border-border">
              Recent Requests
              {statusFilter && (
                <span className="ml-2 text-xs font-normal text-text-secondary">
                  (filtered by {statusFilter})
                </span>
              )}
            </h3>
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-tertiary">
                    <th className="px-4 py-2 font-medium">Method</th>
                    <th className="px-4 py-2 font-medium">Path</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Duration</th>
                    <th className="px-4 py-2 font-medium">Req Size</th>
                    <th className="px-4 py-2 font-medium">Res Size</th>
                    <th className="px-4 py-2 font-medium">IP</th>
                    <th className="px-4 py-2 font-medium">User</th>
                    <th className="px-4 py-2 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredLogs.map((log, i) => (
                    <>
                      <tr
                        key={i}
                        onClick={() => setExpandedRow(expandedRow === i ? null : i)}
                        className="hover:bg-bg-hover transition-colors cursor-pointer"
                      >
                        <td className="px-4 py-2 font-mono text-xs font-medium">{log.method}</td>
                        <td
                          className="px-4 py-2 font-mono text-xs text-accent hover:underline truncate max-w-[200px]"
                          title={`${log.path}${log.queryParams || ''} — Click for endpoint details`}
                          onClick={(e) => {
                            e.stopPropagation();
                            openEndpointModal(log.path);
                          }}
                        >
                          {log.path}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                              log.status < 300
                                ? 'bg-success/10 text-success'
                                : log.status < 400
                                  ? 'bg-accent/10 text-accent'
                                  : log.status < 500
                                    ? 'bg-warning/10 text-warning'
                                    : 'bg-danger/10 text-danger'
                            }`}
                          >
                            {log.status}
                          </span>
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-text-secondary">
                          {log.duration}ms
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-text-secondary">
                          {formatBytes(log.requestSize)}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-text-secondary">
                          {formatBytes(log.responseSize)}
                        </td>
                        <td
                          className="px-4 py-2 font-mono text-xs text-text-secondary truncate max-w-[100px]"
                          title={log.ip || undefined}
                        >
                          {log.ip || '-'}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-text-secondary">
                          {log.username || '-'}
                        </td>
                        <td className="px-4 py-2 text-xs text-text-tertiary">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </td>
                      </tr>
                      {expandedRow === i && (
                        <tr key={`${i}-expanded`}>
                          <td colSpan={9} className="px-4 py-3 bg-bg-hover border-t border-border">
                            <div className="grid grid-cols-2 gap-4 text-xs">
                              <div>
                                <p className="text-text-tertiary mb-1 font-semibold">
                                  Request Details
                                </p>
                                <div className="space-y-1">
                                  <p>
                                    <span className="text-text-tertiary">Full Path:</span>{' '}
                                    <span className="font-mono text-text-secondary">
                                      {log.path}
                                      {log.queryParams}
                                    </span>
                                  </p>
                                  {log.userAgent && (
                                    <p>
                                      <span className="text-text-tertiary">User Agent:</span>{' '}
                                      <span className="font-mono text-text-secondary break-all">
                                        {log.userAgent}
                                      </span>
                                    </p>
                                  )}
                                  {log.referrer && (
                                    <p>
                                      <span className="text-text-tertiary">Referrer:</span>{' '}
                                      <span className="font-mono text-text-secondary break-all">
                                        {log.referrer}
                                      </span>
                                    </p>
                                  )}
                                  <p>
                                    <span className="text-text-tertiary">IP Address:</span>{' '}
                                    <span className="font-mono text-text-secondary">
                                      {log.ip || 'N/A'}
                                    </span>
                                  </p>
                                  {log.username && (
                                    <p>
                                      <span className="text-text-tertiary">
                                        Authenticated User:
                                      </span>{' '}
                                      <span className="font-mono text-text-secondary">
                                        {log.username}
                                      </span>
                                    </p>
                                  )}
                                </div>
                              </div>
                              <div>
                                <p className="text-text-tertiary mb-1 font-semibold">
                                  Response Metrics
                                </p>
                                <div className="space-y-1">
                                  <p>
                                    <span className="text-text-tertiary">Status Code:</span>{' '}
                                    <span className="font-mono text-text-secondary">
                                      {log.status}
                                    </span>
                                  </p>
                                  <p>
                                    <span className="text-text-tertiary">Duration:</span>{' '}
                                    <span className="font-mono text-text-secondary">
                                      {log.duration}ms
                                    </span>
                                  </p>
                                  <p>
                                    <span className="text-text-tertiary">Request Size:</span>{' '}
                                    <span className="font-mono text-text-secondary">
                                      {formatBytes(log.requestSize)}
                                    </span>
                                  </p>
                                  <p>
                                    <span className="text-text-tertiary">Response Size:</span>{' '}
                                    <span className="font-mono text-text-secondary">
                                      {formatBytes(log.responseSize)}
                                    </span>
                                  </p>
                                  <p>
                                    <span className="text-text-tertiary">Timestamp:</span>{' '}
                                    <span className="font-mono text-text-secondary">
                                      {new Date(log.timestamp).toLocaleString()}
                                    </span>
                                  </p>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="border-t border-border px-4 py-3 flex items-center justify-between">
                <p className="text-xs text-text-tertiary">
                  Page {page} of {totalPages}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handlePageChange(Math.max(1, page - 1))}
                    disabled={page === 1}
                    className="btn btn-sm"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => handlePageChange(Math.min(totalPages, page + 1))}
                    disabled={page === totalPages}
                    className="btn btn-sm"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="card p-6 text-center text-sm text-text-secondary">
          No requests recorded yet. Send traffic to the app URL above to see analytics.
        </div>
      )}

      {/* Endpoint Detail Modal */}
      {endpointModalPath && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setEndpointModalPath(null)}
        >
          <div
            className="bg-bg card max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold font-mono">{endpointModalPath}</h2>
                <p className="text-xs text-text-secondary mt-1">Endpoint Analytics</p>
              </div>
              <button
                onClick={() => setEndpointModalPath(null)}
                className="text-text-tertiary hover:text-text-primary text-2xl leading-none"
              >
                ✕
              </button>
            </div>
            <div className="overflow-auto flex-1 p-6 space-y-6">
              {endpointLoading ? (
                <div className="text-sm text-text-tertiary text-center py-8">Loading...</div>
              ) : endpointDetail ? (
                <>
                  {/* Summary Stats */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <StatCard
                      label="Total Requests"
                      value={String(endpointDetail.summary.totalRequests)}
                    />
                    <StatCard
                      label="Avg Duration"
                      value={`${endpointDetail.summary.avgDuration}ms`}
                    />
                    <StatCard
                      label="Error Rate"
                      value={`${endpointDetail.summary.errorRate}%`}
                    />
                    <div className="card p-4">
                      <p className="text-xs text-text-tertiary mb-1">Data Transfer</p>
                      <p className="text-lg font-semibold font-mono">
                        {formatBytes(endpointDetail.summary.totalResponseBytes)}
                      </p>
                      <p className="text-xs text-text-secondary mt-0.5">
                        ↑ {formatBytes(endpointDetail.summary.totalRequestBytes)} sent
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <StatCard
                      label="p50 (median)"
                      value={`${endpointDetail.summary.p50}ms`}
                      sub="50th percentile"
                    />
                    <StatCard
                      label="p95"
                      value={`${endpointDetail.summary.p95}ms`}
                      sub="95th percentile"
                    />
                    <StatCard
                      label="p99"
                      value={`${endpointDetail.summary.p99}ms`}
                      sub="99th percentile"
                    />
                  </div>

                  {/* Status Codes */}
                  {Object.keys(endpointDetail.summary.statusCodes).length > 0 && (
                    <div className="card p-4">
                      <p className="text-xs text-text-tertiary mb-2">Status Code Breakdown</p>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(endpointDetail.summary.statusCodes).map(([code, count]) => (
                          <span
                            key={code}
                            className={`text-xs font-mono px-2 py-1 rounded ${
                              code === '2xx'
                                ? 'bg-success/10 text-success'
                                : code === '3xx'
                                  ? 'bg-accent/10 text-accent'
                                  : code === '4xx'
                                    ? 'bg-warning/10 text-warning'
                                    : 'bg-danger/10 text-danger'
                            }`}
                          >
                            {code}: {count}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Time Series Chart */}
                  <RequestBarChart
                    data={endpointDetail.timeSeries}
                    bucketIntervalMs={endpointDetail.bucketIntervalMs}
                  />

                  {/* Recent Requests */}
                  <div className="card overflow-hidden">
                    <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider px-4 py-3 border-b border-border">
                      Requests ({endpointDetail.recentRequests.total} total)
                    </h3>
                    <div className="overflow-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-xs text-text-tertiary">
                            <th className="px-4 py-2 font-medium">Method</th>
                            <th className="px-4 py-2 font-medium">Status</th>
                            <th className="px-4 py-2 font-medium">Duration</th>
                            <th className="px-4 py-2 font-medium">Req Size</th>
                            <th className="px-4 py-2 font-medium">Res Size</th>
                            <th className="px-4 py-2 font-medium">IP</th>
                            <th className="px-4 py-2 font-medium">Time</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {endpointDetail.recentRequests.logs.map((log, i) => (
                            <tr key={i} className="hover:bg-bg-hover transition-colors">
                              <td className="px-4 py-2 font-mono text-xs font-medium">
                                {log.method}
                              </td>
                              <td className="px-4 py-2">
                                <span
                                  className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                                    log.status < 300
                                      ? 'bg-success/10 text-success'
                                      : log.status < 400
                                        ? 'bg-accent/10 text-accent'
                                        : log.status < 500
                                          ? 'bg-warning/10 text-warning'
                                          : 'bg-danger/10 text-danger'
                                  }`}
                                >
                                  {log.status}
                                </span>
                              </td>
                              <td className="px-4 py-2 font-mono text-xs text-text-secondary">
                                {log.duration}ms
                              </td>
                              <td className="px-4 py-2 font-mono text-xs text-text-secondary">
                                {formatBytes(log.requestSize)}
                              </td>
                              <td className="px-4 py-2 font-mono text-xs text-text-secondary">
                                {formatBytes(log.responseSize)}
                              </td>
                              <td className="px-4 py-2 font-mono text-xs text-text-secondary truncate max-w-[100px]">
                                {log.ip || '-'}
                              </td>
                              <td className="px-4 py-2 text-xs text-text-tertiary">
                                {new Date(log.timestamp).toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {endpointDetail.recentRequests.totalPages > 1 && (
                      <div className="border-t border-border px-4 py-3 flex items-center justify-between">
                        <p className="text-xs text-text-tertiary">
                          Page {endpointDetail.recentRequests.page} of{' '}
                          {endpointDetail.recentRequests.totalPages}
                        </p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setEndpointPage((p) => Math.max(1, p - 1))}
                            disabled={endpointDetail.recentRequests.page === 1}
                            className="btn btn-sm"
                          >
                            Previous
                          </button>
                          <button
                            onClick={() =>
                              setEndpointPage((p) =>
                                Math.min(endpointDetail!.recentRequests.totalPages, p + 1),
                              )
                            }
                            disabled={
                              endpointDetail.recentRequests.page ===
                              endpointDetail.recentRequests.totalPages
                            }
                            className="btn btn-sm"
                          >
                            Next
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-sm text-text-tertiary text-center py-8">
                  No data available for this endpoint.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Data Transfer Modal */}
      {showDataModal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setShowDataModal(false)}
        >
          <div
            className="bg-bg card max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Data Transfer by Path</h2>
                <p className="text-xs text-text-secondary mt-1">
                  Total: ↓ {formatBytes(dataTransfer.totalResponseBytes)} received, ↑{' '}
                  {formatBytes(dataTransfer.totalRequestBytes)} sent
                </p>
              </div>
              <button
                onClick={() => setShowDataModal(false)}
                className="text-text-tertiary hover:text-text-primary text-2xl leading-none"
              >
                ✕
              </button>
            </div>
            <div className="overflow-auto flex-1">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-bg">
                  <tr className="border-b border-border text-left text-xs text-text-tertiary">
                    <th className="px-6 py-3 font-medium">Path</th>
                    <th className="px-6 py-3 font-medium text-right">Requests</th>
                    <th className="px-6 py-3 font-medium text-right">Data Sent</th>
                    <th className="px-6 py-3 font-medium text-right">Data Received</th>
                    <th className="px-6 py-3 font-medium text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {dataTransferByPath.map((stat) => (
                    <tr key={stat.path} className="hover:bg-bg-hover transition-colors">
                      <td className="px-6 py-3 font-mono text-xs text-text-secondary max-w-[300px] truncate">
                        {stat.path}
                      </td>
                      <td className="px-6 py-3 font-mono text-xs text-right">{stat.count}</td>
                      <td className="px-6 py-3 font-mono text-xs text-right text-accent">
                        ↑ {formatBytes(stat.requestBytes)}
                      </td>
                      <td className="px-6 py-3 font-mono text-xs text-right text-success">
                        ↓ {formatBytes(stat.responseBytes)}
                      </td>
                      <td className="px-6 py-3 font-mono text-xs text-right font-medium">
                        {formatBytes(stat.requestBytes + stat.responseBytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
