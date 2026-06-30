import { createConnection, type Socket } from 'node:net';
import { resolve } from 'node:path';
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
  pingDocker,
  type RawContainerStats,
  type AllContainerStatsEntry,
} from './docker.ts';
import { emit } from './events.ts';
import { setRestartCount, isCrashLooping } from './crash-tracker.ts';

let interval: ReturnType<typeof setInterval> | null = null;
let aggregateInterval: ReturnType<typeof setInterval> | null = null;

// null = not yet probed. Updated on every 30s collector tick; transitions are
// logged + emitted so the dashboard can show a "Docker unreachable" banner
// instead of silently displaying stale data.
let dockerReachable: boolean | null = null;

// ── Fleet status publishing ──────────────────────────────────────────────────
// Container count + resource consumption for external observers (the macOS
// menu bar app), published as a `{type:'fleet'}` NDJSON line into the
// supervisor's status socket on every 30s collector tick; the supervisor
// relays it to subscribers. No disk involved. cpuPercent uses the docker CLI
// convention (100 = one core); cpuCores is the Docker VM's capacity so
// readers can show consumption as a share of what containers can actually
// use. In single-process mode there is no supervisor socket — the dial fails
// silently and we retry on the next tick.

function supervisorSockPath(): string {
  const dataDir = process.env.DEPLOY_DATA_DIR || resolve(process.cwd(), '.deploy-data');
  return resolve(dataDir, 'supervisor.sock');
}

// Lazy, latest-wins publisher: keep one connection, redial on the next tick
// after a failure. Dropping a sample is fine — another follows in 30s.
let fleetSock: Socket | null = null;
let fleetSockDialing = false;

function publishFleetStatus(line: string) {
  if (fleetSock && !fleetSock.destroyed) {
    fleetSock.write(line);
    return;
  }
  if (fleetSockDialing) return;
  fleetSockDialing = true;
  const sock = createConnection(supervisorSockPath());
  // Never hold the process open just for status publishing.
  sock.unref();
  sock.on('connect', () => {
    fleetSockDialing = false;
    fleetSock = sock;
    sock.write(line);
  });
  sock.on('error', () => {
    fleetSockDialing = false;
    if (fleetSock === sock) fleetSock = null;
    sock.destroy();
  });
  sock.on('close', () => {
    fleetSockDialing = false;
    if (fleetSock === sock) fleetSock = null;
  });
}

function reportFleetStatus(
  reachable: boolean,
  deployments: Array<{ name: string }>,
  statusMap: Map<string, string>,
  allStats: AllContainerStatsEntry[],
) {
  try {
    const statsByContainer = new Map(allStats.map((s) => [s.containerName, s]));
    let cpuPercent = 0;
    let memUsageBytes = 0;
    let cpuCores = 0;
    let memTotalBytes = 0;
    let running = 0;
    const containers: Array<{
      name: string;
      status: string;
      cpuPercent: number;
      memUsageBytes: number;
    }> = [];

    for (const d of deployments) {
      const status = statusMap.get(d.name.toLowerCase()) || 'stopped';
      if (status === 'running') running++;
      const stats = statsByContainer.get(`deploy-sh-${d.name.toLowerCase()}`);
      if (stats) {
        cpuPercent += stats.cpuPercent;
        memUsageBytes += stats.memUsageBytes;
        cpuCores = Math.max(cpuCores, stats.onlineCpus);
        // Unlimited containers report the VM's total memory as their limit.
        memTotalBytes = Math.max(memTotalBytes, stats.memLimitBytes);
      }
      containers.push({
        name: d.name,
        status,
        cpuPercent: stats?.cpuPercent ?? 0,
        memUsageBytes: stats?.memUsageBytes ?? 0,
      });
    }
    containers.sort((a, b) => b.cpuPercent - a.cpuPercent);

    const payload = {
      type: 'fleet',
      updatedAt: Date.now(),
      dockerReachable: reachable,
      running,
      total: deployments.length,
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      cpuCores,
      memUsageBytes,
      memTotalBytes,
      containers,
    };
    publishFleetStatus(JSON.stringify(payload) + '\n');
  } catch {
    // best-effort — the menu bar going stale must never hurt collection
  }
}

async function updateDockerReachability(): Promise<boolean> {
  const reachable = await pingDocker();
  if (dockerReachable !== reachable) {
    if (!reachable) {
      console.error('[Metrics] Docker daemon unreachable — container data will be stale');
    } else if (dockerReachable === false) {
      // Only announce recovery after an actual outage, not on the first probe.
      console.log('[Metrics] Docker daemon reachable again');
    }
    dockerReachable = reachable;
    emit({ type: 'system:docker', deploymentName: '*', data: { reachable } });
  }
  return reachable;
}

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
    // dockerReachable rides on the aggregate so the dashboard banner state
    // arrives within one 5s tick of page load; `!== false` treats the
    // not-yet-probed startup window as reachable.
    emit({
      type: 'dashboard:aggregate',
      deploymentName: '*',
      data: { ...agg, dockerReachable: dockerReachable !== false },
    });
  } catch {
    // dashboard aggregate is best-effort; DB hiccups shouldn't crash the loop
  }
}

async function collectAll() {
  try {
    const reachable = await updateDockerReachability();
    if (!reachable) {
      reportFleetStatus(false, [], new Map(), []);
      return;
    }

    const deployments = getAllDeployments();
    if (deployments.length === 0) {
      reportFleetStatus(true, [], new Map(), []);
      return;
    }

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

    reportFleetStatus(true, deployments, statusMap, allStats);
  } catch {
    // silently ignore — docker may not be available
  }
}
