import { getRequestsSqlite } from '../../requests-db.ts';
import {
  getCurrentHealth,
  getSqlite,
  type CurrentHealth,
  type getDeployment,
} from '../../store.ts';

/** Traffic comes from the HTTP edge log, independently of health-check success. */
export type AppMeasurements = {
  traffic:
    | { state: 'measured'; requests: number; reqPerMin: number; p95ms: number | null }
    | { state: 'not-measured'; reason: string };
  memoryBytes: number | null;
};
export function appMeasurements(
  deployment: NonNullable<ReturnType<typeof getDeployment>>,
  now = Date.now(),
  metrics: CurrentHealth = getCurrentHealth(deployment.name),
): AppMeasurements {
  // Match the edge's hostname route: a legacy HTTP port or a published, admitted endpoint.
  // Deployment `type` is not a protocol indicator; private services can have no HTTP route.
  const recorded =
    !!deployment.port ||
    !!(
      deployment.appId &&
      getSqlite()!
        .prepare(`
    SELECT 1 FROM component_services cs JOIN service_endpoints se
      ON se.service_id=cs.id AND se.admitted_generation=cs.membership_generation
    WHERE cs.app_id=? AND cs.published=1 AND se.readiness='ready' LIMIT 1
  `)
        .get(deployment.appId)
    );
  if (!recorded)
    return {
      traffic: { state: 'not-measured', reason: 'Traffic is not recorded for this app' },
      memoryBytes: metrics.memUsageBytes,
    };
  const { requests } = getRequestsSqlite()
    .prepare(
      'SELECT COUNT(*) AS requests FROM request_logs WHERE deployment_name=? AND timestamp BETWEEN ? AND ?',
    )
    .get(deployment.name, now - 3600_000, now) as { requests: number };
  return {
    traffic: {
      state: 'measured',
      requests,
      reqPerMin: Math.round((metrics.rps ?? 0) * 60),
      p95ms: metrics.p95Ms,
    },
    memoryBytes: metrics.memUsageBytes,
  };
}
