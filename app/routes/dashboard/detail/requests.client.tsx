'use client';

import { Fragment, useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-flight-router/client';
import {
  fetchRequestData as serverFetchRequests,
  fetchEndpointDetail as serverFetchEndpointDetail,
  fetchRequestSeries,
  fetchTopErrorPaths,
  fetchRequestCapture,
} from '../../../actions/deployments';
import { appUrl, getAuth, useDetailContext } from './shared';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { formatBytes } from '../../../utils';
import { LoadingState } from '../../../components/LoadingState';
import { Pagination } from '../../../components/Pagination';
import { EndpointDetailModal } from './EndpointDetailModal';
import { DataTransferModal } from './DataTransferModal';
import { StatCard } from '../../../components/dashboard/StatCard';
import {
  TimeRange,
  resolvePreset,
  type TimeRangeValue,
} from '../../../components/dashboard/TimeRange';
import { StatusCodeDonut } from '../../../components/dashboard/StatusCodeDonut';
import { MethodBadge } from '../../../components/dashboard/MethodBadge';
import { RpsOverTime } from '../../../components/dashboard/RpsOverTime';
import { LatencyOverTime } from '../../../components/dashboard/LatencyOverTime';
import { TopErrorPaths } from '../../../components/dashboard/TopErrorPaths';
import { EmptyState } from '../../../components/dashboard/EmptyState';
import { RequestsIcon, ClockIcon } from '../../../components/dashboard/icons';

import type { EndpointDetailResult } from './EndpointDetailModal';
import type { DataTransferStats } from './DataTransferModal';

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
  captureId?: string | null;
}

interface CaptureSide {
  headers: Record<string, string | string[] | undefined>;
  body: string | null;
  bodyBytes: number;
  bodyTruncated: boolean;
}

interface CaptureRecord {
  id: string;
  status: number;
  durationMs: number;
  failureReason?: string;
  request: CaptureSide;
  response: CaptureSide | null;
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

interface PathStats {
  path: string;
  count: number;
  avgDuration: number;
  errorRate: number;
}

interface SeriesPoint {
  bucket: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  p50: number;
  p95: number;
  p99: number;
  count: number;
}

interface ErrorPathRow {
  path: string;
  total: number;
  errors: number;
  errorRate: number;
}

type Preset = '1h' | '6h' | '24h' | '7d' | '30d';

function presetFromParam(s: string | null): Preset {
  if (s === '1h' || s === '6h' || s === '24h' || s === '7d' || s === '30d') return s;
  return '24h';
}

const statusToneClass: Record<string, string> = {
  '2xx': '',
  '3xx': 'bg-accent/5',
  '4xx': 'bg-warning/5',
  '5xx': 'bg-danger/5',
};

function statusClassOf(status: number): '2xx' | '3xx' | '4xx' | '5xx' {
  if (status < 300) return '2xx';
  if (status < 400) return '3xx';
  if (status < 500) return '4xx';
  return '5xx';
}

function statusBadgeClass(status: number): string {
  if (status < 300) return 'bg-success/10 text-success';
  if (status < 400) return 'bg-accent/10 text-accent';
  if (status < 500) return 'bg-warning/10 text-warning';
  return 'bg-danger/10 text-danger';
}

function CaptureHeaders({ headers }: { headers: CaptureSide['headers'] }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-text-tertiary hover:text-text text-[11px]">
        Headers ({Object.keys(headers).length})
      </summary>
      <pre className="mt-1 p-2 rounded bg-bg text-text-secondary font-mono text-[11px] overflow-auto max-h-48 whitespace-pre-wrap break-all">
        {Object.entries(headers)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\n')}
      </pre>
    </details>
  );
}

function CaptureBody({ side }: { side: CaptureSide }) {
  if (side.body === null) {
    return <p className="text-text-tertiary italic mt-1">No body</p>;
  }
  return (
    <>
      <pre className="mt-1 p-2 rounded bg-bg text-text-secondary font-mono text-[11px] overflow-auto max-h-64 whitespace-pre-wrap break-all">
        {side.body}
      </pre>
      {side.bodyTruncated && (
        <p className="text-[11px] text-warning mt-1">
          Truncated — showing first part of {formatBytes(side.bodyBytes)}
        </p>
      )}
    </>
  );
}

/**
 * Lazily fetches and renders the request/response body capture written by
 * the proxy when this request returned 5xx.
 */
function ErrorCapture({ name, captureId }: { name: string; captureId: string }) {
  const [capture, setCapture] = useState<CaptureRecord | null>(null);
  const [state, setState] = useState<'loading' | 'missing' | 'loaded'>('loading');

  useEffect(() => {
    const auth = getAuth();
    if (!auth) return;
    fetchRequestCapture(auth.username, auth.token, name, captureId)
      .then((data) => {
        if (data) {
          setCapture(data as CaptureRecord);
          setState('loaded');
        } else {
          setState('missing');
        }
      })
      .catch(() => setState('missing'));
  }, [name, captureId]);

  if (state === 'loading') {
    return <p className="text-xs text-text-tertiary mt-3">Loading capture…</p>;
  }
  if (state === 'missing' || !capture) {
    return (
      <p className="text-xs text-text-tertiary mt-3">
        Capture no longer available (pruned after 14 days).
      </p>
    );
  }

  return (
    <div className="mt-4 pt-3 border-t border-border text-xs">
      <p className="text-text-tertiary mb-2 font-semibold flex items-center gap-2">
        <span className="text-danger">●</span> Error Capture
        {capture.failureReason && (
          <span className="font-normal normal-case text-danger">
            backend {capture.failureReason} — the app never responded
          </span>
        )}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="min-w-0">
          <p className="text-text-tertiary font-semibold mb-1">Request</p>
          <CaptureHeaders headers={capture.request.headers} />
          <CaptureBody side={capture.request} />
        </div>
        <div className="min-w-0">
          <p className="text-text-tertiary font-semibold mb-1">
            Response{capture.response ? ` (${capture.status})` : ''}
          </p>
          {capture.response ? (
            <>
              <CaptureHeaders headers={capture.response.headers} />
              <CaptureBody side={capture.response} />
            </>
          ) : (
            <p className="text-text-tertiary italic mt-1">
              None — the 502 was generated by the proxy ({capture.failureReason || 'error'}).
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Component() {
  const { deployment } = useDetailContext();
  const name = deployment.name;
  const [searchParams, setSearchParams] = useSearchParams();

  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [summary, setSummary] = useState<RequestSummary | null>(null);
  const [pathAnalytics, setPathAnalytics] = useState<PathStats[]>([]);
  const [seriesData, setSeriesData] = useState<{ bucketMs: number; series: SeriesPoint[] } | null>(
    null,
  );
  const [topErrors, setTopErrors] = useState<ErrorPathRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(Number(searchParams.get('page')) || 1);
  const [totalPages, setTotalPages] = useState(1);
  const [pathFilter, setPathFilter] = useState(searchParams.get('path') || '');
  const [filterInput, setFilterInput] = useState(searchParams.get('path') || '');
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [pathPage, setPathPage] = useState(1);
  const pathsPerPage = 8;
  const [statusFilter, setStatusFilter] = useState<string | null>(searchParams.get('status'));
  const [showDataModal, setShowDataModal] = useState(false);

  // New unified time range
  const [timeRange, setTimeRange] = useState<TimeRangeValue>(() => {
    return resolvePreset(presetFromParam(searchParams.get('range')));
  });

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

  const fetchRequests = useCallback(
    async (currentPage: number, filter: string, status?: string | null) => {
      try {
        const auth = getAuth();
        if (!auth) return;
        const data = await serverFetchRequests(auth.username, auth.token, name, {
          page: currentPage,
          limit: 30,
          pathFilter: filter || undefined,
          statusFilter: status || undefined,
          fromTimestamp: timeRange.fromMs,
          toTimestamp: timeRange.toMs,
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
    [name, timeRange],
  );

  const fetchCharts = useCallback(async () => {
    try {
      const auth = getAuth();
      if (!auth) return;
      const [series, errors] = await Promise.all([
        fetchRequestSeries(auth.username, auth.token, name, timeRange.fromMs, timeRange.toMs),
        fetchTopErrorPaths(auth.username, auth.token, name, timeRange.fromMs, 10),
      ]);
      setSeriesData(series as { bucketMs: number; series: SeriesPoint[] });
      setTopErrors(errors as ErrorPathRow[]);
    } catch {
      // ignore
    }
  }, [name, timeRange]);

  // Initial + dependency fetch
  useEffect(() => {
    fetchRequests(page, pathFilter, statusFilter);
  }, [fetchRequests, page, pathFilter, statusFilter]);

  useEffect(() => {
    fetchCharts();
  }, [fetchCharts]);

  // WebSocket for real-time request updates
  const channels = useMemo(() => [`deployment:${name}`], [name]);
  const handleWsEvent = useCallback(
    (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'request:logged') {
        const entry = event.data as unknown as RequestLog;
        if (page === 1 && !pathFilter) {
          setLogs((prev) => [entry, ...prev].slice(0, 30));
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
      }
    },
    [page, pathFilter],
  );
  useWebSocket(channels, handleWsEvent);

  // Fetch endpoint detail when modal opens
  useEffect(() => {
    if (!endpointModalPath) return;
    setEndpointLoading(true);
    const auth = getAuth();
    if (!auth) return;
    serverFetchEndpointDetail(auth.username, auth.token, name, endpointModalPath, {
      page: endpointPage,
      limit: 20,
      fromTimestamp: timeRange.fromMs,
      toTimestamp: timeRange.toMs,
    })
      .then((data) => setEndpointDetail(data as EndpointDetailResult))
      .catch(() => {})
      .finally(() => setEndpointLoading(false));
  }, [endpointModalPath, endpointPage, name, timeRange]);

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

  const handleTimeRangeChange = (next: TimeRangeValue) => {
    setTimeRange(next);
    updateQueryParams({ range: next.preset === 'custom' ? null : next.preset, page: 1 });
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

  const dataTransfer = useMemo(() => {
    const totalRequestBytes = logs.reduce((sum, log) => sum + (log.requestSize || 0), 0);
    const totalResponseBytes = logs.reduce((sum, log) => sum + (log.responseSize || 0), 0);
    return { totalRequestBytes, totalResponseBytes };
  }, [logs]);

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

  const handleStatusFilterPill = (code: '2xx' | '3xx' | '4xx' | '5xx') => {
    const newFilter = statusFilter === code ? null : code;
    setStatusFilter(newFilter);
    updateQueryParams({ status: newFilter, page: 1 });
    setPage(1);
  };

  if (loading && !summary) {
    return <LoadingState />;
  }

  const donutCounts = {
    s2xx: summary?.statusCodes['2xx'] ?? 0,
    s3xx: summary?.statusCodes['3xx'] ?? 0,
    s4xx: summary?.statusCodes['4xx'] ?? 0,
    s5xx: summary?.statusCodes['5xx'] ?? 0,
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="card p-3 sm:p-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-text-tertiary mb-1">
              App URL:{' '}
              <a
                href={appUrl(name)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:text-accent-hover font-mono break-all"
              >
                {name}.local
              </a>
            </p>
            <p className="text-xs text-text-secondary">
              All traffic to this subdomain is tracked automatically.
            </p>
          </div>
          <TimeRange value={timeRange} onChange={handleTimeRangeChange} />
        </div>
      </div>

      {summary && summary.total > 0 ? (
        <>
          {/* KPI Stat Row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
            <StatCard label="Total Requests" value={summary.total.toLocaleString()} />
            <StatCard
              label="Avg Response"
              value={`${summary.avgDuration}ms`}
              icon={<ClockIcon />}
            />
            <StatCard label="Requests / min" value={String(summary.recentRpm)} />
            <StatCard
              label="Data Transfer"
              value={formatBytes(dataTransfer.totalResponseBytes)}
              sub={`↑ ${formatBytes(dataTransfer.totalRequestBytes)} sent`}
              onClick={() => setShowDataModal(true)}
            />
          </div>

          <div className="grid grid-cols-3 gap-3 sm:gap-4">
            <StatCard label="p50 (median)" value={`${summary.p50}ms`} sub="50th percentile" />
            <StatCard label="p95" value={`${summary.p95}ms`} sub="95th percentile" />
            <StatCard
              label="p99"
              value={`${summary.p99}ms`}
              sub="99th percentile"
              tone={summary.p99 > 1000 ? 'warning' : 'default'}
            />
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              {seriesData && (
                <RpsOverTime series={seriesData.series} bucketMs={seriesData.bucketMs} />
              )}
            </div>
            <div className="lg:col-span-1">
              <StatusCodeDonut
                counts={donutCounts}
                activeFilter={statusFilter as '2xx' | '3xx' | '4xx' | '5xx' | null}
                onClickClass={handleStatusFilterPill}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
            <div className="lg:col-span-2">
              {seriesData && <LatencyOverTime series={seriesData.series} />}
            </div>
            <div className="lg:col-span-1">
              <TopErrorPaths rows={topErrors} />
            </div>
          </div>

          {pathAnalytics.length > 0 && (
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between px-3 sm:px-4 py-3 border-b border-border">
                <h3 className="eyebrow font-semibold">Top Paths by Request Count</h3>
                {totalPathPages > 1 && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPathPage((p) => Math.max(1, p - 1))}
                      disabled={pathPage === 1}
                      className="btn btn-sm text-xs"
                      aria-label="Previous page"
                    >
                      ‹
                    </button>
                    <span className="text-xs text-text-tertiary tabular-nums">
                      {pathPage} / {totalPathPages}
                    </span>
                    <button
                      onClick={() => setPathPage((p) => Math.min(totalPathPages, p + 1))}
                      disabled={pathPage === totalPathPages}
                      className="btn btn-sm text-xs"
                      aria-label="Next page"
                    >
                      ›
                    </button>
                  </div>
                )}
              </div>
              <ul className="divide-y divide-border">
                {paginatedPathAnalytics.map((stat) => (
                  <li
                    key={stat.path}
                    className="px-3 sm:px-4 py-2.5 hover:bg-bg-hover transition-colors"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => openEndpointModal(stat.path)}
                        className="font-mono text-xs text-accent hover:underline truncate flex-1 min-w-0 text-left"
                      >
                        {stat.path}
                      </button>
                      <div className="flex items-baseline gap-3 shrink-0 text-xs font-mono tabular-nums">
                        <span className="text-text">{stat.count.toLocaleString()}</span>
                        <span className="hidden sm:inline text-text-tertiary">
                          {stat.avgDuration}ms
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded ${
                            stat.errorRate === 0
                              ? 'bg-success/10 text-success'
                              : stat.errorRate < 10
                                ? 'bg-warning/10 text-warning'
                                : 'bg-danger/10 text-danger'
                          }`}
                        >
                          {stat.errorRate}%
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2 mt-1.5">
                      <button
                        onClick={() => openEndpointModal(stat.path)}
                        className="text-[11px] text-text-tertiary hover:text-text"
                      >
                        Details
                      </button>
                      <span className="text-text-tertiary text-[11px]">·</span>
                      <button
                        onClick={() => {
                          setFilterInput(stat.path);
                          setPathFilter(stat.path);
                          handlePageChange(1);
                          updateQueryParams({ path: stat.path, page: 1 });
                        }}
                        className="text-[11px] text-text-tertiary hover:text-text"
                      >
                        Filter to this
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Filter + status pills */}
          <div className="card p-3 sm:p-4 space-y-3">
            <form onSubmit={handleFilterSubmit} className="flex gap-2">
              <input
                type="text"
                value={filterInput}
                onChange={(e) => setFilterInput(e.target.value)}
                placeholder="Filter by path (e.g. /api/%)"
                className="input flex-1 min-h-[40px]"
              />
              <button type="submit" className="btn btn-primary min-h-[40px]">
                Filter
              </button>
              {(pathFilter || statusFilter) && (
                <button type="button" onClick={clearFilter} className="btn min-h-[40px]">
                  Clear
                </button>
              )}
            </form>
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[11px] text-text-tertiary uppercase tracking-wider">
                Status
              </span>
              {(['2xx', '3xx', '4xx', '5xx'] as const).map((code) => (
                <button
                  key={code}
                  onClick={() => handleStatusFilterPill(code)}
                  className={`text-xs font-mono px-2 py-1 rounded min-h-[28px] transition-colors ${
                    statusFilter === code
                      ? code === '2xx'
                        ? 'bg-success/20 text-success ring-1 ring-success/40'
                        : code === '3xx'
                          ? 'bg-accent/20 text-accent ring-1 ring-accent/40'
                          : code === '4xx'
                            ? 'bg-warning/20 text-warning ring-1 ring-warning/40'
                            : 'bg-danger/20 text-danger ring-1 ring-danger/40'
                      : 'bg-bg-hover text-text-tertiary hover:text-text'
                  }`}
                >
                  {code}
                </button>
              ))}
              {(pathFilter || statusFilter) && (
                <span className="ml-auto text-[11px] text-text-secondary">
                  {pathFilter && (
                    <span>
                      Path: <span className="font-mono">{pathFilter}</span>
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>

          {/* Recent Requests — table on desktop, card list on mobile */}
          <div className="card overflow-hidden">
            <h3 className="eyebrow font-semibold px-3 sm:px-4 py-3 border-b border-border flex items-center gap-2">
              <span>Recent Requests</span>
              {statusFilter && (
                <span className="text-xs font-normal text-text-secondary normal-case tracking-normal">
                  (filtered by {statusFilter})
                </span>
              )}
            </h3>

            {/* Mobile: card list */}
            <ul className="sm:hidden divide-y divide-border">
              {logs.map((log, i) => {
                const sc = statusClassOf(log.status);
                return (
                  <li
                    key={i}
                    className={`px-3 py-2.5 ${statusToneClass[sc]} cursor-pointer`}
                    onClick={() => setExpandedRow(expandedRow === i ? null : i)}
                  >
                    <div className="flex items-center gap-2">
                      <MethodBadge method={log.method} />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEndpointModal(log.path);
                        }}
                        className="font-mono text-xs text-accent hover:underline truncate flex-1 min-w-0 text-left"
                      >
                        {log.path}
                      </button>
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${statusBadgeClass(
                          log.status,
                        )}`}
                      >
                        {log.status}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[11px] text-text-tertiary font-mono">
                      <span>{log.duration}ms</span>
                      <span>{formatBytes(log.responseSize)}</span>
                      <span className="ml-auto">
                        {new Date(log.timestamp).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Desktop: table */}
            <div className="hidden sm:block overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-tertiary">
                    <th className="px-3 py-2 font-medium">Method</th>
                    <th className="px-3 py-2 font-medium">Path</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Duration</th>
                    <th className="px-3 py-2 font-medium">Req</th>
                    <th className="px-3 py-2 font-medium">Res</th>
                    <th className="px-3 py-2 font-medium">IP</th>
                    <th className="px-3 py-2 font-medium">User</th>
                    <th className="px-3 py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {logs.map((log, i) => {
                    const sc = statusClassOf(log.status);
                    return (
                      <Fragment key={i}>
                        <tr
                          onClick={() => setExpandedRow(expandedRow === i ? null : i)}
                          className={`hover:bg-bg-hover transition-colors cursor-pointer ${statusToneClass[sc]}`}
                        >
                          <td className="px-3 py-2">
                            <MethodBadge method={log.method} />
                          </td>
                          <td
                            className="px-3 py-2 font-mono text-xs text-accent hover:underline truncate max-w-[260px]"
                            title={`${log.path}${log.queryParams || ''} — Click for endpoint details`}
                            onClick={(e) => {
                              e.stopPropagation();
                              openEndpointModal(log.path);
                            }}
                          >
                            {log.path}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={`text-xs font-mono px-1.5 py-0.5 rounded ${statusBadgeClass(
                                log.status,
                              )}`}
                            >
                              {log.status}
                            </span>
                            {log.captureId && (
                              <span
                                className="ml-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-danger/10 text-danger"
                                title="Request/response body captured — expand row to view"
                              >
                                body
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-text-secondary tabular-nums">
                            {log.duration}ms
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-text-secondary">
                            {formatBytes(log.requestSize)}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-text-secondary">
                            {formatBytes(log.responseSize)}
                          </td>
                          <td
                            className="px-3 py-2 font-mono text-xs text-text-secondary truncate max-w-[140px]"
                            title={log.ip || undefined}
                          >
                            {log.ip || '–'}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-text-secondary">
                            {log.username || '–'}
                          </td>
                          <td className="px-3 py-2 text-xs text-text-tertiary whitespace-nowrap">
                            {new Date(log.timestamp).toLocaleString([], {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })}
                          </td>
                        </tr>
                        {expandedRow === i && (
                          <tr>
                            <td
                              colSpan={9}
                              className="px-4 py-3 bg-bg-hover border-t border-border"
                            >
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                                <div>
                                  <p className="text-text-tertiary mb-1 font-semibold">
                                    Request Details
                                  </p>
                                  <div className="space-y-1">
                                    <p>
                                      <span className="text-text-tertiary">Full Path:</span>{' '}
                                      <span className="font-mono text-text-secondary break-all">
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
                              {log.captureId && (
                                <ErrorCapture name={name} captureId={log.captureId} />
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <Pagination page={page} totalPages={totalPages} onPageChange={handlePageChange} />
          </div>
        </>
      ) : (
        <div className="card">
          <EmptyState
            icon={<RequestsIcon />}
            title="No requests recorded yet"
            description="Send traffic to the app URL above and analytics will appear here."
          />
        </div>
      )}

      {/* Endpoint Detail Modal */}
      {endpointModalPath && (
        <EndpointDetailModal
          endpointPath={endpointModalPath}
          endpointDetail={endpointDetail}
          endpointLoading={endpointLoading}
          onClose={() => setEndpointModalPath(null)}
          onPageChange={setEndpointPage}
        />
      )}

      {/* Data Transfer Modal */}
      {showDataModal && (
        <DataTransferModal
          dataTransfer={dataTransfer}
          dataTransferByPath={dataTransferByPath}
          onClose={() => setShowDataModal(false)}
        />
      )}
    </div>
  );
}
