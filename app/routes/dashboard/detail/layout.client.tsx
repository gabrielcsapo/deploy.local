'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, Link, Outlet, useLocation } from 'react-flight-router/client';
import {
  fetchDeployment as serverFetchDeployment,
  fetchContainerInspect as serverFetchInspect,
} from '../../../actions/deployments';
import { DetailProvider, getAuth, StatusBadge } from './shared';
import type { Deployment, ContainerInfo, DetailContext } from './shared';
import { useWebSocket } from '../../../hooks/useWebSocket';

type Tab =
  | 'overview'
  | 'logs'
  | 'requests'
  | 'resources'
  | 'history'
  | 'backups'
  | 'build'
  | 'terminal';

const tabs: { key: Tab; label: string; path: string }[] = [
  { key: 'overview', label: 'Overview', path: '' },
  { key: 'build', label: 'Build', path: 'build' },
  { key: 'logs', label: 'Logs', path: 'logs' },
  { key: 'terminal', label: 'Terminal', path: 'terminal' },
  { key: 'requests', label: 'Requests', path: 'requests' },
  { key: 'resources', label: 'Resources', path: 'resources' },
  { key: 'history', label: 'History', path: 'history' },
  { key: 'backups', label: 'Backups', path: 'backups' },
];

function getActiveTab(pathname: string, name: string): Tab {
  const base = `/dashboard/${name}`;
  const suffix = pathname.slice(base.length).replace(/^\//, '');
  const match = tabs.find((t) => t.path === suffix);
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

  if (loading) {
    return <div className="text-sm text-text-tertiary py-12 text-center">Loading...</div>;
  }

  if (error || !deployment) {
    return (
      <div>
        <Link to="/dashboard" className="text-sm text-accent hover:text-accent-hover mb-4 block">
          &larr; Back to deployments
        </Link>
        <div className="card p-6 text-center text-sm text-danger">
          {error || 'Deployment not found'}
        </div>
      </div>
    );
  }

  const context: DetailContext = { deployment, inspect, fetchDeployment, fetchInspect };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link to="/dashboard" className="text-text-tertiary hover:text-text-secondary text-sm">
          &larr;
        </Link>
        <h1 className="text-lg font-semibold">{deployment.name}</h1>
        <StatusBadge status={deployment.status} />
      </div>

      <div className="flex gap-1 border-b border-border mb-6">
        {tabs.map((t) => (
          <Link
            key={t.key}
            to={`/dashboard/${name}${t.path ? `/${t.path}` : ''}`}
            className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === t.key
                ? 'border-accent text-text'
                : 'border-transparent text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <DetailProvider value={context}>
        <Outlet />
      </DetailProvider>
    </div>
  );
}
