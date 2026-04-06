'use client';

import { useState, useEffect, useCallback } from 'react';
import { fetchDiscoverableApps } from '../../actions/deployments';
import { StatusBadge, appUrl } from './detail/shared';
import { LoadingState, ErrorBanner } from '../../components/LoadingState';

interface DiscoverApp {
  name: string;
  type: string | null;
  status: string;
}

function AppCard({ app }: { app: DiscoverApp }) {
  const initial = app.name.charAt(0).toUpperCase();

  return (
    <div className="card group hover:border-border-hover transition-all duration-200">
      <div className="p-5">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-accent/10 text-accent flex items-center justify-center text-sm font-semibold shrink-0">
              {initial}
            </div>
            <div>
              <h3 className="text-sm font-semibold">{app.name}</h3>
              <p className="text-xs font-mono text-text-tertiary">{app.type || 'unknown'}</p>
            </div>
          </div>
          <StatusBadge status={app.status} />
        </div>
        <a
          href={appUrl(app.name)}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-primary w-full text-center"
        >
          Open
        </a>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-12">
      <p className="text-text-secondary mb-2">No discoverable apps</p>
      <p className="text-xs text-text-tertiary max-w-sm mx-auto">
        Apps marked as discoverable will appear here. Enable discovery in an app&apos;s overview
        settings.
      </p>
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
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold">Discover</h1>
        {apps.length > 0 && (
          <div className="flex items-center gap-3 text-xs text-text-secondary">
            <span>
              {apps.length} app{apps.length !== 1 ? 's' : ''}
            </span>
            <span className="text-success">{running} running</span>
          </div>
        )}
      </div>

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <LoadingState />
      ) : apps.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {apps.map((app) => (
            <AppCard key={app.name} app={app} />
          ))}
        </div>
      )}
    </div>
  );
}
