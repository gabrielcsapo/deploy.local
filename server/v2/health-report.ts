import type { WorkerReport } from './health.ts';

/** Report disjoint 10–60 second windows. jobs includes failures; never send cumulative counts. */
export async function reportHealth(
  coordinator: string,
  token: string,
  report: WorkerReport,
  signal?: AbortSignal,
) {
  const response = await fetch(new URL('/api/v2/health/report', coordinator), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Health report rejected (${response.status})`);
  return response.json();
}
