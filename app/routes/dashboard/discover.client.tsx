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
          className="btn w-full text-center"
        >
          Open
        </a>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <DashboardEmpty
      icon={
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          className="size-5"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" strokeLinecap="round" />
        </svg>
      }
      title="Nothing shared yet"
      body="Apps marked as discoverable appear here for guests on your network. Toggle &lsquo;Discoverable&rsquo; in any app&rsquo;s settings to publish it."
    />
  );
}

function DashboardEmpty({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center text-center py-16 px-6">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl border border-white/[0.06] bg-bg/60 text-accent mb-4">
        {icon}
      </div>
      <h2 className="text-base font-semibold tracking-tight mb-1.5">{title}</h2>
      <p className="text-sm text-text-secondary max-w-[44ch] leading-relaxed">{body}</p>
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
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h1 className="prompt-h1">Shared apps</h1>
          {apps.length > 0 && (
            <p className="text-xs text-text-tertiary mt-0.5 tabular-nums">
              {apps.length} {apps.length === 1 ? 'app' : 'apps'}
              {' · '}
              <span className="text-success">{running} running</span>
            </p>
          )}
        </div>
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
