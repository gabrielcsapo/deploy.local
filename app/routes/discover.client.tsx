'use client';

import { useState, useEffect, useCallback } from 'react';
import { fetchDiscoverableApps } from '../actions/deployments';
import { StatusBadge, appUrl } from './dashboard/detail/shared';

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
    <div className="text-center py-20">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-bg-surface border border-border text-text-tertiary mb-4 text-xl">
        &#9776;
      </div>
      <h2 className="text-sm font-semibold mb-2">No apps discovered</h2>
      <p className="text-sm text-text-secondary max-w-sm mx-auto">
        Apps marked as discoverable will appear here. Enable discovery in an app&apos;s settings from
        the dashboard.
      </p>
    </div>
  );
}

export default function Component() {
  const [apps, setApps] = useState<DiscoverApp[]>([]);
  const [loading, setLoading] = useState(true);
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
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <main className="max-w-5xl mx-auto px-6">
      <section className="py-16 max-w-xl">
        <p className="text-sm font-medium text-accent mb-3">Network discovery</p>
        <h1 className="text-3xl font-bold tracking-tight mb-3">Discover</h1>
        <p className="text-text-secondary leading-relaxed">
          Apps available on your network. These are deployments that have been marked as
          discoverable by their owners.
        </p>
      </section>

      {error && (
        <div className="mb-6 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-text-tertiary py-20 text-center">Loading...</div>
      ) : apps.length === 0 ? (
        <EmptyState />
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
