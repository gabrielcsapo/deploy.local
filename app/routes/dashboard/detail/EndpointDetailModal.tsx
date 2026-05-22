'use client';

import { useEffect, useRef, useCallback } from 'react';
import { formatBytes } from '../../../utils';
import { StatCard } from './shared';
import { LoadingState } from '../../../components/LoadingState';
import { Pagination } from '../../../components/Pagination';
import { RequestBarChart } from './RequestBarChart';

import type { TimeSeriesEntry } from './RequestBarChart';

export interface RequestLog {
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

export interface EndpointDetailResult {
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
  timeSeries: TimeSeriesEntry[];
  recentRequests: {
    logs: RequestLog[];
    total: number;
    page: number;
    totalPages: number;
  };
  bucketIntervalMs: number;
}

interface EndpointDetailModalProps {
  endpointPath: string;
  endpointDetail: EndpointDetailResult | null;
  endpointLoading: boolean;
  onClose: () => void;
  onPageChange: (page: number) => void;
}

export function EndpointDetailModal({
  endpointPath,
  endpointDetail,
  endpointLoading,
  onClose,
  onPageChange,
}: EndpointDetailModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Focus trap
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="bg-bg card max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="endpoint-detail-title"
      >
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 id="endpoint-detail-title" className="text-lg font-semibold font-mono">
              {endpointPath}
            </h2>
            <p className="text-xs text-text-secondary mt-1">Endpoint Analytics</p>
          </div>
          <button
            onClick={onClose}
            className="text-text-tertiary hover:text-text text-2xl leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="overflow-auto flex-1 p-6 space-y-6">
          {endpointLoading ? (
            <LoadingState />
          ) : endpointDetail ? (
            <>
              {/* Summary Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard
                  label="Total Requests"
                  value={String(endpointDetail.summary.totalRequests)}
                />
                <StatCard label="Avg Duration" value={`${endpointDetail.summary.avgDuration}ms`} />
                <StatCard label="Error Rate" value={`${endpointDetail.summary.errorRate}%`} />
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
                <h3 className="eyebrow font-semibold px-4 py-3 border-b border-border">
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
                          <td className="px-4 py-2 font-mono text-xs font-medium">{log.method}</td>
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
                <Pagination
                  page={endpointDetail.recentRequests.page}
                  totalPages={endpointDetail.recentRequests.totalPages}
                  onPageChange={onPageChange}
                />
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
  );
}
