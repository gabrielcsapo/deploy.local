import type { LiveApp } from '../../../../../shared/v2/contracts';
import type { AppMeasurements } from '../../../../../server/v2/measurements';

type Metric = { value: string | number; note?: string };
export function trafficMetrics(app: LiveApp): { rate: Metric; latency: Metric } {
  const traffic = (app as LiveApp & Partial<AppMeasurements>).traffic;
  if (traffic?.state === 'measured')
    return {
      rate: {
        value: traffic.reqPerMin,
        note: traffic.requests === 0 ? 'No requests in the last hour' : undefined,
      },
      latency:
        traffic.p95ms === null
          ? {
              value: '—',
              note:
                traffic.requests === 0
                  ? 'No requests to time'
                  : 'No requests in the last minute to time',
            }
          : { value: `${Math.round(traffic.p95ms)} ms` },
    };
  // Older servers can supply complete HTTP measurements but cannot establish an empty window.
  if (!traffic && app.http)
    return {
      rate: { value: app.http.reqPerMin },
      latency: { value: `${Math.round(app.http.p95ms)} ms` },
    };
  const missing = {
    value: 'Not measured',
    note:
      traffic?.state === 'not-measured' ? traffic.reason : 'Traffic measurements were not reported',
  };
  return { rate: missing, latency: missing };
}
export function memoryMetric(app: LiveApp): Metric {
  const bytes = (app as LiveApp & Partial<AppMeasurements>).memoryBytes;
  return bytes == null
    ? { value: 'Not measured', note: 'Memory usage was not reported' }
    : { value: `${Math.round(bytes / 1024 / 1024)} MB` };
}
