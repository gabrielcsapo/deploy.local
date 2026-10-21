'use client';
import { IconLink } from '@/components/ui';
import { IconButton } from '@/components/ui';

import { useState, useEffect, useCallback } from 'react';
import { fetchDiscoverableApps } from '../../actions/deployments';
import { StatusBadge, appUrl } from './detail/shared';
import { LoadingState, ErrorBanner } from '../../components/LoadingState';
import { EmptyState as ResourceEmptyState } from '../../components/dashboard/EmptyState';

interface DiscoverApp {
  name: string;
  type: string | null;
  status: string;
}

function AppCard({ app }: { app: DiscoverApp }) {
  const initial = app.name.charAt(0).toUpperCase();
  const typeLabel = app.type
    ? app.type === 'node'
      ? 'Node.js'
      : app.type.charAt(0).toUpperCase() + app.type.slice(1)
    : 'Custom app';

  return (
    <div className="ds-shared-app-row">
      <span className="ds-shared-app-icon" aria-hidden="true">
        {initial}
      </span>
      <div>
        <strong>{app.name}</strong>
        <small>{typeLabel}</small>
      </div>
      <StatusBadge status={app.status} />
      <IconLink
        icon="external"
        label="Open application in new window"
        href={appUrl(app.name)}
        target="_blank"
        rel="noopener noreferrer"
      />
    </div>
  );
}

export default function Component({ initialApps }: { initialApps?: DiscoverApp[] }) {
  const [apps, setApps] = useState<DiscoverApp[]>(initialApps ?? []);
  const [loading, setLoading] = useState(!initialApps);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await fetchDiscoverableApps();
      setApps(data);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialApps) load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load, initialApps]);

  const running = apps.filter((a) => a.status === 'running').length;

  return (
    <div>
      {apps.length > 0 && (
        <div className="ds-pane-toolbar">
          <span>{apps.length} apps</span>
          <span>{running} running</span>
        </div>
      )}

      {error && (
        <ErrorBanner
          message={error}
          action={<IconButton icon="refresh" label="Retry" onClick={() => void load()} />}
        />
      )}

      {loading ? (
        <LoadingState />
      ) : apps.length === 0 ? (
        <ResourceEmptyState
          title="Nothing shared yet"
          description="No applications are currently published for guest access."
        />
      ) : (
        <div className="ds-shared-app-list">
          {apps.map((app) => (
            <AppCard key={app.name} app={app} />
          ))}
        </div>
      )}
    </div>
  );
}
