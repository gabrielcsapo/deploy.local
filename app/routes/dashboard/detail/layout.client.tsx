'use client';

import { useState, useEffect, useCallback, useMemo, Suspense } from 'react';
import { useParams, Outlet, useLocation } from 'react-flight-router/client';
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
import {
  OverviewIcon,
  BuildIcon,
  LogsIcon,
  TerminalIcon,
  RequestsIcon,
  ResourcesIcon,
  HistoryIcon,
  SettingsIcon,
  ExternalLinkIcon,
} from '../../../components/dashboard/icons';

type TabKey =
  | 'overview'
  | 'logs'
  | 'requests'
  | 'resources'
  | 'history'
  | 'build'
  | 'terminal'
  | 'settings';

const TABS_META: Array<{ key: TabKey; label: string; path: string; icon: React.ReactNode }> = [
  { key: 'overview', label: 'Overview', path: '', icon: <OverviewIcon /> },
  { key: 'build', label: 'Build', path: 'build', icon: <BuildIcon /> },
  { key: 'logs', label: 'Logs', path: 'logs', icon: <LogsIcon /> },
  { key: 'terminal', label: 'Terminal', path: 'terminal', icon: <TerminalIcon /> },
  { key: 'requests', label: 'Requests', path: 'requests', icon: <RequestsIcon /> },
  { key: 'resources', label: 'Resources', path: 'resources', icon: <ResourcesIcon /> },
  // Activity = deploys + restarts + config changes + backups. URL kept as
  // /history for bookmark stability; label says "Activity".
  { key: 'history', label: 'Activity', path: 'history', icon: <HistoryIcon /> },
  // Settings holds the structural config (env, volumes, ports, GPU,
  // resource limits) so the Overview tab can stay metrics-first.
  { key: 'settings', label: 'Settings', path: 'settings', icon: <SettingsIcon /> },
];

function getActiveTab(pathname: string, name: string): TabKey {
  const base = `/dashboard/${name}`;
  const suffix = pathname.slice(base.length).replace(/^\//, '');
  const match = TABS_META.find((t) => t.path === suffix);
  return match?.key ?? 'overview';
}

export default function Component() {
  const { name } = useParams();
  const location = useLocation();
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [inspect, setInspect] = useState<ContainerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  // WebSocket for real-time status updates
  const channels = useMemo(() => [`deployment:${name}`], [name]);
  const handleWsEvent = useCallback(
    (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'deployment:status') {
        setDeployment((prev) => (prev ? { ...prev, status: event.data.status as string } : prev));
        // Refetch inspect when status changes to running
        if (event.data.status === 'running') {
          fetchInspect();
        }
      }
    },
    [fetchInspect],
  );
  useWebSocket(channels, handleWsEvent);

  // Pages that want every vertical pixel — drop the live strip + reduce chrome.
  const isFullBleed = activeTab === 'terminal' || activeTab === 'logs';

  const tabs: TabDef[] = TABS_META.map((t) => {
    let dot: TabDef['dot'];
    // Only surface dots for transitional / actionable states. The previous
    // implementation marked Logs and Terminal as "live" any time the
    // container was up — visually nice but not informative (the dot was
    // always on, so it carried no signal). Build still gets a dot during
    // an active build because that IS a real "click in here, something is
    // happening" cue.
    if (t.key === 'build' && deployment?.status === 'building') dot = 'warning';
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

  return (
    <div className={isFullBleed ? 'flex flex-col h-[calc(100vh-6rem)]' : ''}>
      {/* Sticky context: title row + tabs stay pinned to the top of the
          content area as the page scrolls. Without this, the app name and
          tab navigation vanish offscreen and you lose your "where am I"
          anchor — that absence is one of the big "feels like a toy" tells. */}
      <div className="sticky top-0 z-20 -mx-4 sm:-mx-6 px-4 sm:px-6 bg-bg/90 backdrop-blur-sm">
        <div className="flex items-center gap-3 py-2 flex-wrap">
          <h1 className="prompt-h1 truncate">{deployment?.name ?? name}</h1>
          {deployment && <StatusBadge status={deployment.status} />}
          <div className="flex-1" />
          <a
            href={appUrl(deployment?.name ?? name!)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-sm inline-flex items-center gap-1.5"
            title="Open in new tab"
          >
            <span>Open</span>
            <ExternalLinkIcon />
          </a>
        </div>
        <TabStrip tabs={tabs} active={activeTab} className="border-b border-border" />
      </div>

      {/* Metrics readout sits below the sticky chrome and scrolls with the
          page. Always rendered so the operator gets one at-a-glance row
          before diving into the tab content. */}
      {deployment && (
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
            {isFullBleed ? (
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
