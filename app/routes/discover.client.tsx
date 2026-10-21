'use client';
import { IconButton } from '@/components/ui';

import { useState, useEffect, useCallback } from 'react';
import { fetchDiscoverableApps } from '../actions/deployments';
import { StatusBadge, appUrl } from './dashboard/detail/shared';
import { LoadingState, ErrorBanner, EmptyState } from '../components/ui';

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
          className="btn w-full text-center"
        >
          Open
        </a>
      </div>
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

  return (
    <main className="max-w-7xl mx-auto px-6">
      <section className="py-6 max-w-xl">
        <h1 className="text-xl font-semibold">Shared applications</h1>
      </section>

      {error && (
        <ErrorBanner
          message={error}
          action={
            <IconButton icon="refresh" label="Retry applications" onClick={() => void load()} />
          }
        />
      )}

      {loading ? (
        <LoadingState />
      ) : apps.length === 0 ? (
        <EmptyState
          title="Nothing shared yet"
          description="No applications are currently published for guest access."
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-16">
          {apps.map((app) => (
            <AppCard key={app.name} app={app} />
          ))}
        </div>
      )}
    </main>
  );
}
