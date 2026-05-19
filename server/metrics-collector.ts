import { getAllDeployments, logMetrics, updateDeploymentStatus } from './store.ts';
import { getAllContainerStats, getAllContainerStatuses, type RawContainerStats } from './docker.ts';
import { emit } from './events.ts';

let interval: ReturnType<typeof setInterval> | null = null;

export function startMetricsCollector() {
  if (interval) return;
  collectAll();
  interval = setInterval(collectAll, 30_000);
}

export function stopMetricsCollector() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

async function collectAll() {
  try {
    const deployments = getAllDeployments();
    if (deployments.length === 0) return;

    // Both calls are cached + single-flighted via TtlCache in docker.ts —
    // concurrent HTTP handlers and this collector share the same `docker stats`
    // and `docker ps` invocations. Fired in parallel so the slower one
    // (stats, ~1s CPU sample) dominates rather than serializing.
    const [allStats, statusMap] = await Promise.all([
      getAllContainerStats(),
      getAllContainerStatuses(),
    ]);
    const statsMap = new Map(allStats.map((s) => [s.containerName, s]));

    for (const d of deployments) {
      const containerName = `deploy-sh-${d.name.toLowerCase()}`;
      const stats = statsMap.get(containerName);

      if (stats) {
        const rawStats: RawContainerStats = {
          cpuPercent: stats.cpuPercent,
          memUsageBytes: stats.memUsageBytes,
          memLimitBytes: stats.memLimitBytes,
          memPercent: stats.memPercent,
          netRxBytes: stats.netRxBytes,
          netTxBytes: stats.netTxBytes,
          blockReadBytes: stats.blockReadBytes,
          blockWriteBytes: stats.blockWriteBytes,
          pids: stats.pids,
          timestamp: Date.now(),
        };
        logMetrics(d.name, rawStats);
        emit({ type: 'metrics:update', deploymentName: d.name, data: rawStats });
      }

      // Sync deployment status from Docker
      const dockerStatus = statusMap.get(d.name.toLowerCase()) || 'stopped';
      const dbStatus = d.status || 'stopped';
      // Only sync if status diverged and not in a transitional state
      if (
        dockerStatus !== dbStatus &&
        dbStatus !== 'uploading' &&
        dbStatus !== 'building' &&
        dbStatus !== 'starting'
      ) {
        updateDeploymentStatus(d.name, dockerStatus);
        emit({
          type: 'deployment:status',
          deploymentName: d.name,
          data: { status: dockerStatus },
        });
      }
    }
  } catch {
    // silently ignore — docker may not be available
  }
}
