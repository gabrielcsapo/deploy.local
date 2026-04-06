'use client';

import { useState, useEffect } from 'react';
import { fetchDeployHistory as serverFetchHistory } from '../../../actions/deployments';
import { getAuth, useDetailContext } from './shared';
import { LoadingState } from '../../../components/LoadingState';

interface HistoryEvent {
  action: string;
  username: string;
  timestamp: string;
  type?: string;
  port?: number;
}

export default function Component() {
  const { deployment } = useDetailContext();
  const name = deployment.name;
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const auth = getAuth();
    if (!auth) return;
    serverFetchHistory(auth.username, auth.token, name)
      .then((data) => setEvents(data as HistoryEvent[]))
      .finally(() => setLoading(false));
  }, [name]);

  if (loading) {
    return <LoadingState />;
  }

  if (events.length === 0) {
    return (
      <div className="card p-6 text-center text-sm text-text-secondary">
        No history recorded yet. History tracking starts from this version.
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="divide-y divide-border">
        {[...events].reverse().map((e, i) => (
          <div key={i} className="px-4 py-3 flex items-center gap-4">
            <div
              className={`w-2 h-2 rounded-full shrink-0 ${
                e.action === 'deploy'
                  ? 'bg-success'
                  : e.action === 'restart' || e.action === 'recreate'
                    ? 'bg-warning'
                    : 'bg-danger'
              }`}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium capitalize">{e.action}</p>
              <p className="text-xs text-text-secondary">
                by {e.username}
                {e.type && ` · ${e.type}`}
                {e.port && ` · port ${e.port}`}
              </p>
            </div>
            <time className="text-xs text-text-tertiary shrink-0">
              {new Date(e.timestamp).toLocaleString()}
            </time>
          </div>
        ))}
      </div>
    </div>
  );
}
