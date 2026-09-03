'use client';

import { useState, useEffect, useCallback, useMemo, Suspense } from 'react';
import { useParams, Outlet, useLocation, Link } from 'react-flight-router/client';
import {
  fetchDeployment as serverFetchDeployment,
  fetchContainerInspect as serverFetchInspect,
} from '../../../actions/deployments';
import { DetailProvider, getAuth, StatusBadge, appUrl } from './shared';
import type { Deployment, ContainerInfo } from './shared';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { LoadingState } from '../../../components/LoadingState';
import { TabStrip, type TabDef } from '../../../components/dashboard/TabStrip';
import { LiveStatusStrip } from '../../../components/dashboard/LiveStatusStrip';
import { formatBytes } from '../../../utils';
import {
  OverviewIcon,
  BuildIcon,
  LogsIcon,
  TerminalIcon,
  RequestsIcon,
  BackupsIcon,
  HistoryIcon,
  SettingsIcon,
  ExternalLinkIcon,
  ArrowLeftIcon,
} from '../../../components/dashboard/icons';

type TabKey =
  | 'overview'
  | 'logs'
  | 'traffic'
  | 'data'
  | 'activity'
  | 'releases'
  | 'terminal'
  | 'settings';

const TABS_META: Array<{
  key: TabKey;
  label: string;
  path: string;
  icon: React.ReactNode;
  primary?: boolean;
}> = [
  { key: 'overview', label: 'Overview', path: '', icon: <OverviewIcon /> },
  { key: 'releases', label: 'Releases', path: 'releases', icon: <BuildIcon /> },
  { key: 'logs', label: 'Logs', path: 'logs', icon: <LogsIcon /> },
  {
    key: 'terminal',
    label: 'Terminal',
    path: 'terminal',
    icon: <TerminalIcon />,
    primary: false,
  },
  { key: 'traffic', label: 'Traffic', path: 'traffic', icon: <RequestsIcon /> },
  { key: 'data', label: 'Data', path: 'data', icon: <BackupsIcon /> },
  {
    key: 'activity',
    label: 'Activity',
    path: 'activity',
    icon: <HistoryIcon />,
    primary: false,
  },
  // Settings holds the structural config (env, volumes, ports, GPU,
  // resource limits) so the Overview tab can stay metrics-first.
  { key: 'settings', label: 'Settings', path: 'settings', icon: <SettingsIcon /> },
];

function getActiveTab(pathname: string, name: string): TabKey {
  const base = `/dashboard/${name}`;
  const suffix = pathname.slice(base.length).replace(/^\//, '');
  const legacyAliases: Record<string, TabKey> = {
    build: 'releases',
    requests: 'traffic',
    resources: 'data',
    history: 'activity',
  };
  const match = TABS_META.find((t) => t.path === suffix);
  if (legacyAliases[suffix]) return legacyAliases[suffix];
  return match?.key ?? 'overview';
}

export default function Component() {
  const { name } = useParams();
  const location = useLocation();
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [inspect, setInspect] = useState<ContainerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [migrationProgress, setMigrationProgress] = useState<{
    phase: string;
    stage: string;
    processedBytes: number;
    totalBytes: number;
  } | null>(null);

  const activeTab = getActiveTab(location.pathname, name!);

  const fetchDeployment = useCallback(async () => {
    try {
      const auth = getAuth();
      if (!auth) return;
      const data = await serverFetchDeployment(auth.username, auth.token, name!);
      setDeployment(data as Deployment);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [name]);

  const fetchInspect = useCallback(async () => {
    try {
      const auth = getAuth();
      if (!auth) return;
      const data = await serverFetchInspect(auth.username, auth.token, name!);
      setInspect(data as ContainerInfo);
    } catch {
      // container may not exist
    }
  }, [name]);

  // Initial fetch
  useEffect(() => {
    fetchDeployment();
    fetchInspect();
  }, [fetchDeployment, fetchInspect]);

  // WebSocket events are hints, not the source of truth. Agent-side builds can
  // finish while this browser briefly misses the terminal status event.
  useEffect(() => {
    const timer = window.setInterval(() => void fetchDeployment(), 5_000);
    return () => window.clearInterval(timer);
  }, [fetchDeployment]);

  useEffect(() => {
    if (!deployment?.name) return;
    let cancelled = false;
    const refreshProgress = async () => {
      const auth = getAuth();
      if (!auth) return;
      try {
        const response = await fetch(
          `/api/deployments/${encodeURIComponent(deployment.name)}/migration-progress`,
          {
            headers: {
              'x-deploy-username': auth.username,
              'x-deploy-token': auth.token,
            },
          },
        );
        const body = await response.json();
        if (!response.ok || cancelled) return;
        if (!body.active) {
          if (deployment.status === 'backing-up' || deployment.status === 'restoring') {
            setMigrationProgress(null);
            await fetchDeployment();
          }
          return;
        }
        if (!body.progress) return;
        setMigrationProgress(body.progress);
        setDeployment((current) =>
          current ? { ...current, status: String(body.progress.phase) } : current,
        );
      } catch {
        // WebSocket updates remain the primary live path.
      }
    };
    void refreshProgress();
    const timer = window.setInterval(refreshProgress, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [deployment?.name, deployment?.status, fetchDeployment]);

  // WebSocket for real-time status updates
  const channels = useMemo(() => [`deployment:${name}`], [name]);
  const handleWsEvent = useCallback(
    (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'deployment:status') {
        setDeployment((prev) => (prev ? { ...prev, status: event.data.status as string } : prev));
        if (event.data.status !== 'backing-up' && event.data.status !== 'restoring') {
          setMigrationProgress(null);
        }
        // Refetch inspect when status changes to running
        if (event.data.status === 'running') {
          fetchInspect();
        }
      } else if (event.type === 'deployment:migration-progress') {
        setMigrationProgress({
          phase: String(event.data.phase || ''),
          stage: String(event.data.stage || ''),
          processedBytes: Number(event.data.processedBytes || 0),
          totalBytes: Number(event.data.totalBytes || 0),
        });
      }
    },
    [fetchInspect],
  );
  useWebSocket(channels, handleWsEvent);

  // Pages that want every vertical pixel — drop the live strip + reduce chrome.
  const isFullBleed = activeTab === 'terminal' || activeTab === 'logs';

  const tabs: TabDef[] = TABS_META.filter((t) => t.primary !== false).map((t) => {
    let dot: TabDef['dot'];
    // Only surface dots for transitional / actionable states. The previous
    // implementation marked Logs and Terminal as "live" any time the
    // container was up — visually nice but not informative (the dot was
    // always on, so it carried no signal). Build still gets a dot during
    // an active build because that IS a real "click in here, something is
    // happening" cue.
    if (
      t.key === 'releases' &&
      ['uploading', 'backing-up', 'restoring', 'building', 'starting'].includes(
        deployment?.status || '',
      )
    )
      dot = 'warning';
    return {
      key: t.key,
      label: t.label,
      path: `/dashboard/${name}${t.path ? `/${t.path}` : ''}`,
      icon: t.icon,
      dot,
    };
  });

  // Render chrome (title, tabs) IMMEDIATELY from the URL. Only the per-tab
  // body and the LiveStatusStrip suspend on the data fetch — because the rest
  // is already in the URL, blanking the page on every navigate is a
  // polish-killer. (Vercel/Heroku both do this.)
  const hasError = error || (!loading && !deployment);
  const isGraphApplication = deployment?.type === 'application-graph';
  const migrationActive = deployment?.status === 'backing-up' || deployment?.status === 'restoring';
  const exactTransfer =
    migrationProgress?.stage === 'transferring' && migrationProgress.totalBytes > 0;
  const transferPercent = exactTransfer
    ? Math.min(
        100,
        Math.round((migrationProgress.processedBytes / migrationProgress.totalBytes) * 100),
      )
    : null;

  return (
    <div className={isFullBleed ? 'flex h-[calc(100vh-7rem)] flex-col' : ''}>
      {!isGraphApplication ? (
        <div className="sticky top-[52px] z-20 -mx-4 border-b border-border bg-bg/94 px-4 backdrop-blur-xl sm:-mx-7 sm:px-7 xl:-mx-10 xl:px-10">
          <div className="flex min-h-[58px] items-center gap-3">
            <Link
              to="/dashboard"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-surface hover:text-text"
              aria-label="Back to command center"
            >
              ←
            </Link>
            <div className="flex min-w-0 shrink-0 items-center gap-2 border-r border-border pr-3">
              <h1 className="truncate text-sm font-semibold text-text">
                {deployment?.name ?? name}
              </h1>
              {deployment && <StatusBadge status={deployment.status} />}
            </div>
            <TabStrip tabs={tabs} active={activeTab} className="min-w-0 flex-1 self-end" />
            <a
              href={appUrl(deployment?.name ?? name!)}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-sm inline-flex items-center gap-1.5"
              title="Open in new tab"
            >
              <span className="hidden sm:inline">Open</span>
              <ExternalLinkIcon />
            </a>
          </div>
        </div>
      ) : null}

      {migrationActive && (
        <div className="mt-3 rounded-lg border border-warning/30 bg-warning/8 px-4 py-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-warning">
                {deployment.status === 'backing-up'
                  ? 'Moving application data: backing up'
                  : 'Moving application data: restoring'}
              </p>
              <p className="text-xs text-text-secondary mt-1">
                {migrationProgress?.stage === 'compressing'
                  ? `${formatBytes(migrationProgress.processedBytes)} archive written from ${formatBytes(
                      migrationProgress.totalBytes,
                    )} of source data`
                  : migrationProgress?.stage === 'transferring'
                    ? `${formatBytes(migrationProgress.processedBytes)} of ${formatBytes(
                        migrationProgress.totalBytes,
                      )} transferred`
                    : migrationProgress?.stage === 'extracting'
                      ? 'Extracting the managed-volume archive on the destination'
                      : 'Preparing migration data…'}
              </p>
            </div>
            <a
              href={`/dashboard/${encodeURIComponent(deployment.name)}/build`}
              className="text-xs text-warning hover:text-text shrink-0"
            >
              View details
            </a>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-active">
            <div
              className={`h-full rounded-full bg-warning transition-[width] duration-300 ${
                transferPercent == null ? 'w-1/3 animate-pulse motion-reduce:animate-none' : ''
              }`}
              style={transferPercent == null ? undefined : { width: `${transferPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* Metrics readout sits below the sticky chrome and scrolls with the
          page. Always rendered so the operator gets one at-a-glance row
          before diving into the tab content. */}
      {deployment && !isGraphApplication && (
        <div className="mt-3 mb-3 sm:mb-4">
          <LiveStatusStrip name={deployment.name} />
        </div>
      )}

      {hasError ? (
        <div className="card p-6 text-center text-sm text-danger">
          {error || 'Deployment not found'}
        </div>
      ) : loading || !deployment ? (
        <LoadingState />
      ) : (
        <DetailProvider value={{ deployment, inspect, fetchDeployment, fetchInspect }}>
          <Suspense fallback={<LoadingState />}>
            {isGraphApplication ? (
              <GraphApplicationFrame deployment={deployment} activeTab={activeTab}>
                <Outlet />
              </GraphApplicationFrame>
            ) : isFullBleed ? (
              <div className="flex-1 min-h-0 flex flex-col">
                <Outlet />
              </div>
            ) : (
              <Outlet />
            )}
          </Suspense>
        </DetailProvider>
      )}
    </div>
  );
}

function GraphApplicationFrame({
  deployment,
  activeTab,
  children,
}: {
  deployment: Deployment;
  activeTab: TabKey;
  children: React.ReactNode;
}) {
  const items = [
    { key: 'overview', label: 'Architecture', path: '', icon: <OverviewIcon /> },
    { key: 'releases', label: 'Builds', path: 'releases', icon: <BuildIcon /> },
    { key: 'traffic', label: 'Observability', path: 'traffic', icon: <RequestsIcon /> },
    { key: 'logs', label: 'Logs', path: 'logs', icon: <LogsIcon /> },
    { key: 'settings', label: 'Settings', path: 'settings', icon: <SettingsIcon /> },
  ];
  return (
    <section className="graph-application-frame">
      <header className="graph-application-topbar">
        <Link to="/dashboard" className="graph-application-back" aria-label="Back to applications">
          <ArrowLeftIcon />
        </Link>
        <strong>{deployment.name}</strong>
        <StatusBadge status={deployment.status} />
        <span />
        <a href={appUrl(deployment.name)} target="_blank" rel="noopener noreferrer">
          Open <ExternalLinkIcon />
        </a>
      </header>
      <div className="graph-application-body">
        <nav className="graph-application-rail" aria-label="Application sections">
          {items.map((item) => (
            <Link
              key={item.key}
              to={`/dashboard/${deployment.name}${item.path ? `/${item.path}` : ''}`}
              className={activeTab === item.key ? 'is-active' : ''}
              aria-label={item.label}
              title={item.label}
            >
              {item.icon}
            </Link>
          ))}
        </nav>
        <div
          className={`graph-application-content ${activeTab === 'overview' ? 'is-canvas' : 'is-subview'}`}
        >
          {children}
        </div>
      </div>
    </section>
  );
}
