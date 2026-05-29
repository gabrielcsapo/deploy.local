'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-flight-router/client';
import { fetchBuildLogs as serverFetchBuildLogs } from '../../../actions/deployments';
import { getAuth, useDetailContext } from './shared';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { LoadingState } from '../../../components/LoadingState';
import { Pagination } from '../../../components/Pagination';
import {
  VirtualLogViewer,
  TIMESTAMP_RE,
  parseLogLines,
  type LogLine,
} from '../../../components/VirtualLogViewer';
import { EmptyState } from '../../../components/dashboard/EmptyState';
import { BuildIcon } from '../../../components/dashboard/icons';

interface BuildLog {
  id: number;
  deploymentName: string;
  output: string;
  success: boolean | null;
  duration: number | null;
  status: string;
  runtimeLogs: string | null;
  timestamp: string;
}

interface BuildLogsResponse {
  logs: BuildLog[];
  total: number;
  page: number;
  pageSize: number;
  activeBuild: { output: string; timestamp: string } | null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function TimestampToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`px-2 py-1 text-xs rounded transition-colors ${
        enabled ? 'bg-bg-active text-text' : 'text-text-tertiary hover:text-text-secondary'
      }`}
      title={enabled ? 'Hide timestamps' : 'Show timestamps'}
    >
      Timestamps
    </button>
  );
}

type OutputTab = 'build' | 'runtime';

export default function Component() {
  const { name } = useParams();
  const [searchParams] = useSearchParams();
  const requestedSelectedId = searchParams.get('selected');
  const { deployment } = useDetailContext();
  const [logs, setLogs] = useState<BuildLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [selectedLog, setSelectedLog] = useState<BuildLog | null>(null);
  // Live build state — stored as parsed LogLine[] for virtualized rendering
  const [liveOutputLines, setLiveOutputLines] = useState<LogLine[]>([]);
  const [isBuilding, setIsBuilding] = useState(false);
  // Tab state
  const [activeTab, setActiveTab] = useState<OutputTab>('build');
  // Live runtime logs (for current build)
  const [liveRuntimeLines, setLiveRuntimeLines] = useState<LogLine[]>([]);
  // Timestamp toggle
  const [showTimestamps, setShowTimestamps] = useState(true);
  // Build start time for elapsed timer
  const [buildStartTime, setBuildStartTime] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Batching refs for WS updates
  const pendingBuildRef = useRef<string[]>([]);
  const pendingRuntimeRef = useRef<string[]>([]);
  const rafBuildRef = useRef<number | null>(null);
  const rafRuntimeRef = useRef<number | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Whether the selected log is the currently running build
  const isCurrentBuild = selectedLog && selectedLog.id === deployment.currentBuildLogId;

  // Parse selected log output into LogLine[] for VirtualLogViewer
  const selectedBuildLines = useMemo(
    () => (selectedLog?.output ? parseLogLines(selectedLog.output) : []),
    [selectedLog?.output],
  );
  const selectedRuntimeLines = useMemo(
    () => (selectedLog?.runtimeLogs ? parseLogLines(selectedLog.runtimeLogs) : []),
    [selectedLog?.runtimeLogs],
  );

  const flushBuildPending = useCallback(() => {
    rafBuildRef.current = null;
    const pending = pendingBuildRef.current;
    if (pending.length === 0) return;
    pendingBuildRef.current = [];

    const newLines: LogLine[] = [];
    for (const raw of pending) {
      for (const part of raw.split('\n')) {
        if (!part) continue;
        const match = part.match(TIMESTAMP_RE);
        newLines.push(
          match
            ? { timestamp: match[1], content: part.slice(match[0].length) }
            : { timestamp: null, content: part },
        );
      }
    }
    setLiveOutputLines((prev) => prev.concat(newLines));
  }, []);

  const flushRuntimePending = useCallback(() => {
    rafRuntimeRef.current = null;
    const pending = pendingRuntimeRef.current;
    if (pending.length === 0) return;
    pendingRuntimeRef.current = [];

    const newLines: LogLine[] = [];
    for (const raw of pending) {
      for (const part of raw.split('\n')) {
        if (!part) continue;
        const match = part.match(TIMESTAMP_RE);
        newLines.push(
          match
            ? { timestamp: match[1], content: part.slice(match[0].length) }
            : { timestamp: null, content: part },
        );
      }
    }
    setLiveRuntimeLines((prev) => prev.concat(newLines));
  }, []);

  const fetchPage = useCallback(
    (p: number, selectLatest = false) => {
      const auth = getAuth();
      if (!auth) return;

      serverFetchBuildLogs(auth.username, auth.token, name!, p).then((data: BuildLogsResponse) => {
        // Filter out in-progress builds from history (shown separately as live build)
        setLogs(data.logs.filter((l) => l.status !== 'building'));
        setTotal(data.total);
        setPage(data.page);
        setPageSize(data.pageSize);
        if (data.activeBuild) {
          setIsBuilding(true);
          setLiveOutputLines(parseLogLines(data.activeBuild.output));
          setBuildStartTime(data.activeBuild.timestamp);
          setSelectedLog(null);
        } else if (selectLatest && data.logs.length > 0) {
          // Logs are already sorted newest-first from the server
          setSelectedLog(data.logs[0]);
        }
      });
    },
    [name],
  );

  useEffect(() => {
    setLoading(true);
    const auth = getAuth();
    if (!auth) {
      setLoading(false);
      return;
    }
    serverFetchBuildLogs(auth.username, auth.token, name!, 1).then((data: BuildLogsResponse) => {
      setLogs(data.logs.filter((l) => l.status !== 'building'));
      setTotal(data.total);
      setPage(data.page);
      setPageSize(data.pageSize);
      if (data.activeBuild) {
        setIsBuilding(true);
        setLiveOutputLines(parseLogLines(data.activeBuild.output));
        setBuildStartTime(data.activeBuild.timestamp);
        setSelectedLog(null);
      } else if (data.logs.length > 0) {
        setSelectedLog(data.logs[0]);
      }
      setLoading(false);
    });
  }, [name]);

  // Cleanup rAFs on unmount
  useEffect(() => {
    return () => {
      if (rafBuildRef.current !== null) cancelAnimationFrame(rafBuildRef.current);
      if (rafRuntimeRef.current !== null) cancelAnimationFrame(rafRuntimeRef.current);
    };
  }, []);

  // WebSocket channels: always subscribe to deployment events,
  // and conditionally to container logs when viewing current build's runtime tab
  const channels = useMemo(() => {
    const chs = [`deployment:${name}`];
    if (isCurrentBuild && activeTab === 'runtime') {
      chs.push(`deployment:${name}:logs`);
    }
    return chs;
  }, [name, isCurrentBuild, activeTab]);

  const handleWsEvent = useCallback(
    (event: { type: string; deploymentName: string; data: Record<string, unknown> }) => {
      if (event.deploymentName !== name) return;

      if (event.type === 'deployment:status' && event.data.status === 'building') {
        setIsBuilding(true);
        setLiveOutputLines([]);
        setBuildStartTime(new Date().toISOString());
        setSelectedLog(null);
        setActiveTab('build');
      } else if (event.type === 'build:output') {
        const ts = (event.data.timestamp as string) || new Date().toISOString();
        pendingBuildRef.current.push(`[${ts}] ${event.data.line as string}`);
        if (rafBuildRef.current === null) {
          rafBuildRef.current = requestAnimationFrame(flushBuildPending);
        }
      } else if (event.type === 'build:complete') {
        setIsBuilding(false);
        // Go back to page 1 and select the newest build
        fetchPage(1, true);
      } else if (event.type === 'container:logs') {
        pendingRuntimeRef.current.push(event.data.line as string);
        if (rafRuntimeRef.current === null) {
          rafRuntimeRef.current = requestAnimationFrame(flushRuntimePending);
        }
      }
    },
    [name, fetchPage, flushBuildPending, flushRuntimePending],
  );
  useWebSocket(channels, handleWsEvent);

  // Reset live runtime logs when switching builds
  useEffect(() => {
    setLiveRuntimeLines([]);
  }, [selectedLog?.id]);

  // Honor ?selected= query (linked from History tab and elsewhere)
  useEffect(() => {
    if (!requestedSelectedId || logs.length === 0) return;
    const target = logs.find((l) => String(l.id) === requestedSelectedId);
    if (target && target.id !== selectedLog?.id) {
      setSelectedLog(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedSelectedId, logs]);

  // Live elapsed time counter for in-progress builds
  useEffect(() => {
    if (!isBuilding || !buildStartTime) {
      setElapsed(0);
      return;
    }
    const start = new Date(buildStartTime).getTime();
    setElapsed(Date.now() - start);
    const interval = setInterval(() => {
      setElapsed(Date.now() - start);
    }, 1000);
    return () => clearInterval(interval);
  }, [isBuilding, buildStartTime]);

  if (loading) {
    return <LoadingState />;
  }

  if (!isBuilding && total === 0) {
    return (
      <div className="card">
        <EmptyState
          icon={<BuildIcon />}
          title="No build logs yet"
          description="Build logs will appear here after the first deployment."
        />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:h-[calc(100vh-16rem)]">
      {/* Build history sidebar */}
      <div className="col-span-1 card overflow-hidden flex flex-col max-h-64 md:max-h-none">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="eyebrow font-semibold">Build History</h3>
          <p className="text-xs text-text-tertiary mt-1">
            {total} build{total !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isBuilding && (
            <button
              onClick={() => {
                setSelectedLog(null);
                setActiveTab('build');
              }}
              className={`w-full px-4 py-3 text-left border-b border-border transition-colors ${
                selectedLog === null ? 'bg-warning/10' : 'hover:bg-bg-active'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="flex items-center gap-1.5 text-xs font-medium text-warning">
                  <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse motion-reduce:animate-none" />
                  Building
                </span>
              </div>
              <time className="text-xs text-text-secondary">In progress</time>
            </button>
          )}
          {/* Logs arrive newest-first from the server */}
          {logs.map((log) => (
            <button
              key={log.id}
              onClick={() => setSelectedLog(log)}
              className={`w-full px-4 py-3 text-left border-b border-border transition-colors ${
                selectedLog?.id === log.id ? 'bg-bg-active' : 'hover:bg-bg-active'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span
                  className={`text-xs font-medium ${
                    log.id === deployment.currentBuildLogId
                      ? 'text-accent'
                      : log.success
                        ? 'text-success'
                        : 'text-danger'
                  }`}
                >
                  {log.id === deployment.currentBuildLogId
                    ? '● Current'
                    : log.success
                      ? '✓ Success'
                      : '✗ Failed'}
                </span>
                <span className="text-xs text-text-tertiary">
                  {log.duration != null ? formatDuration(log.duration) : '...'}
                </span>
              </div>
              <time className="text-xs text-text-secondary">
                {new Date(log.timestamp).toLocaleString()}
              </time>
            </button>
          ))}
        </div>
        <Pagination page={page} totalPages={totalPages} onPageChange={fetchPage} />
      </div>

      {/* Build output / Runtime logs */}
      <div className="col-span-1 md:col-span-2 card overflow-hidden flex flex-col min-h-64">
        {isBuilding && selectedLog === null ? (
          <>
            <div className="px-4 py-3 border-b border-border shrink-0">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Build Output</h3>
                <div className="flex items-center gap-3">
                  <TimestampToggle
                    enabled={showTimestamps}
                    onToggle={() => setShowTimestamps((v) => !v)}
                  />
                  {elapsed > 0 && (
                    <span className="text-xs font-mono text-text-tertiary tabular-nums">
                      {formatDuration(elapsed)}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex-1 min-h-0 p-4 bg-bg text-xs font-mono">
              <VirtualLogViewer
                lines={liveOutputLines}
                showTimestamps={showTimestamps}
                autoScroll
                newestFirst
                className="h-full"
                emptyMessage="Waiting for build output..."
              />
            </div>
          </>
        ) : selectedLog ? (
          <>
            <div className="px-4 py-3 border-b border-border shrink-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setActiveTab('build')}
                    className={`px-3 py-1 text-sm font-medium rounded transition-colors ${
                      activeTab === 'build'
                        ? 'bg-bg-active text-text'
                        : 'text-text-tertiary hover:text-text-secondary'
                    }`}
                  >
                    Build Output
                  </button>
                  <button
                    onClick={() => setActiveTab('runtime')}
                    className={`px-3 py-1 text-sm font-medium rounded transition-colors flex items-center gap-1.5 ${
                      activeTab === 'runtime'
                        ? 'bg-bg-active text-text'
                        : 'text-text-tertiary hover:text-text-secondary'
                    }`}
                  >
                    Runtime Logs
                    {isCurrentBuild && (
                      <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                    )}
                  </button>
                </div>
                <div className="flex items-center gap-3">
                  <TimestampToggle
                    enabled={showTimestamps}
                    onToggle={() => setShowTimestamps((v) => !v)}
                  />
                  <span className="text-xs text-text-tertiary">
                    {selectedLog.duration != null ? formatDuration(selectedLog.duration) : '...'}
                  </span>
                  <span
                    className={`badge ${selectedLog.success ? 'badge-success' : 'badge-danger'}`}
                  >
                    {selectedLog.success ? 'Success' : 'Failed'}
                  </span>
                </div>
              </div>
              <time className="text-xs text-text-secondary">
                {new Date(selectedLog.timestamp).toLocaleString()}
              </time>
            </div>
            {activeTab === 'build' ? (
              <div className="flex-1 min-h-0 p-4 bg-bg text-xs font-mono">
                <VirtualLogViewer
                  lines={selectedBuildLines}
                  showTimestamps={showTimestamps}
                  newestFirst
                  className="h-full"
                  emptyMessage="No output captured"
                />
              </div>
            ) : (
              <div className="flex-1 min-h-0 p-4 bg-bg text-xs font-mono">
                {isCurrentBuild ? (
                  <VirtualLogViewer
                    lines={liveRuntimeLines}
                    showTimestamps={showTimestamps}
                    autoScroll
                    newestFirst
                    className="h-full"
                    emptyMessage="Waiting for logs..."
                  />
                ) : (
                  <VirtualLogViewer
                    lines={selectedRuntimeLines}
                    showTimestamps={showTimestamps}
                    newestFirst
                    className="h-full"
                    emptyMessage="No runtime logs captured for this build"
                  />
                )}
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-text-tertiary">
            Select a build to view output
          </div>
        )}
      </div>
    </div>
  );
}
