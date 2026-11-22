'use client';
import { useEffect } from 'react';
import { useData } from './data';
import { TraceWaterfall } from './trace-waterfall.client';
import type { TraceDetail } from './trace-model';
export function RequestTrace({ app, id, at }: { app: string; id: string; at: number }) {
  const detail = useData<TraceDetail>('/api/apps/' + encodeURIComponent(app) + '/traces/' + id, {
    immutable: true,
  });
  const refresh = detail.refresh;
  useEffect(() => {
    if (Date.now() - at > 30000) return;
    // Client and backend batches may arrive just after the edge writes its request.
    const first = setTimeout(refresh, 1000),
      last = setTimeout(refresh, 3500);
    return () => {
      clearTimeout(first);
      clearTimeout(last);
    };
  }, [id, at, refresh]);
  if (detail.error)
    return (
      <section className="dl-section">
        <h2 className="dl-section-title">Trace waterfall</h2>
        <button className="dl-btn secondary" onClick={detail.refresh}>
          Retry trace
        </button>
      </section>
    );
  return detail.data ? <TraceWaterfall data={detail.data} /> : null;
}
