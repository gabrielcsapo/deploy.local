import {
  getAllDeployments,
  getDashboardAggregate,
  logMetrics,
  updateDeploymentStatus,
} from './store.ts';
import {
  getAllContainerStats,
  getAllContainerStatuses,
  getAllContainerRestartCounts,
  type RawContainerStats,
} from './docker.ts';
import { emit } from './events.ts';
import { setRestartCount, isCrashLooping } from './crash-tracker.ts';

let interval: ReturnType<typeof setInterval> | null = null;
let aggregateInterval: ReturnType<typeof setInterval> | null = null;

export function startMetricsCollector() {
  if (interval) return;
  collectAll();
  interval = setInterval(collectAll, 30_000);

  // Aggregate roll-up broadcast on a faster cadence than the docker stats
  // poll. CPU/memory don't change fast enough to need <30s, but request rate
  // and error rate do — humans watching the dashboard expect "live" feedback
  // within a few seconds of traffic.
  broadcastAggregate();
  aggregateInterval = setInterval(broadcastAggregate, 5_000);
}

export function stopMetricsCollector() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  if (aggregateInterval) {
    clearInterval(aggregateInterval);
    aggregateInterval = null;
  }
}

function broadcastAggregate() {
  try {
    const agg = getDashboardAggregate();
    // No deploymentName — this is a fleet-wide event, scoped to the
    // 'deployments' channel only. Subscribers to a single deployment's
    // channel don't receive it.
    emit({ type: 'dashboard:aggregate', deploymentName: '*', data: agg });
  } catch {
    // dashboard aggregate is best-effort; DB hiccups shouldn't crash the loop
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
    // restartCounts is uncached but cheap (one bulk inspect) and only runs
    // on the 30s collector tick.
    const [allStats, statusMap, restartCounts] = await Promise.all([
      getAllContainerStats(),
      getAllContainerStatuses(),
      getAllContainerRestartCounts(),
    ]);
    const statsMap = new Map(allStats.map((s) => [s.containerName, s]));

    for (const d of deployments) {
      const restartCount = restartCounts.get(d.name.toLowerCase());
      if (restartCount != null) {
        setRestartCount(d.name, restartCount);
        if (isCrashLooping(d.name)) {
          emit({
            type: 'deployment:crashloop',
            deploymentName: d.name,
            data: { restartCount },
          });
        }
      }

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
