import { ApplicationGraphExecutor } from './application-graph-executor.ts';
import { applicationWriterSiteId } from './application-authority.ts';
import { resolveApplicationGraphRuntime } from './application-runtime.ts';
import { acquireDeploySlot } from './deploy-admission.ts';
import { resolveLocalSiteId } from './multisite.ts';
import {
  addDeployEvent,
  getAllDeployments,
  getApplicationSpecRevision,
  getDeployment,
  saveDeployment,
  updateDeploymentStatus,
} from './store.ts';

const DEFAULT_INTERVAL_MS = 10_000;
const RECONCILABLE_STATUSES = new Set(['running', 'degraded', 'unhealthy', 'failed']);

export interface SupervisedGraphDeployment {
  name: string;
  status?: string | null;
  activeSpecDigest?: string | null;
  activeNodeId?: string | null;
  desiredNodeId?: string | null;
}

export interface ApplicationGraphSupervisorDependencies {
  listDeployments(): readonly SupervisedGraphDeployment[];
  isGraph(deployment: SupervisedGraphDeployment): boolean;
  isLocal(deployment: SupervisedGraphDeployment): boolean;
  reconcile(deployment: SupervisedGraphDeployment): Promise<void>;
  onError(deployment: SupervisedGraphDeployment, error: unknown): void;
}

/** One failure must not prevent unrelated local application graphs from healing. */
export async function reconcileLocalApplicationGraphs(
  dependencies: ApplicationGraphSupervisorDependencies = productionDependencies(),
): Promise<void> {
  for (const deployment of dependencies.listDeployments()) {
    if (!RECONCILABLE_STATUSES.has(deployment.status || '')) continue;
    if (!deployment.activeSpecDigest || !dependencies.isGraph(deployment)) continue;
    if (!dependencies.isLocal(deployment)) continue;
    try {
      await dependencies.reconcile(deployment);
    } catch (error) {
      dependencies.onError(deployment, error);
    }
  }
}

export function startApplicationGraphSupervisor(
  options: {
    intervalMs?: number;
    dependencies?: ApplicationGraphSupervisorDependencies;
  } = {},
): { stop(): void; runNow(): Promise<void> } {
  const dependencies = options.dependencies ?? productionDependencies();
  let running = false;
  const runNow = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileLocalApplicationGraphs(dependencies);
    } finally {
      running = false;
    }
  };
  const interval = setInterval(
    () => void runNow(),
    Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS),
  );
  interval.unref();
  return { stop: () => clearInterval(interval), runNow };
}

function productionDependencies(): ApplicationGraphSupervisorDependencies {
  const lastError = new Map<string, { message: string; reportedAt: number }>();
  return {
    listDeployments: getAllDeployments,
    isGraph(deployment) {
      const revision = deployment.activeSpecDigest
        ? getApplicationSpecRevision(deployment.name, deployment.activeSpecDigest)
        : null;
      return revision?.manifestFormat === 'deploy.yaml';
    },
    isLocal(deployment) {
      const selected = deployment.activeNodeId || deployment.desiredNodeId || 'coordinator';
      const local = process.env.DEPLOY_SUITCASE === '1' ? resolveLocalSiteId() : 'coordinator';
      return selected === local;
    },
    async reconcile(summary) {
      const lease = await acquireDeploySlot(summary.name, 'graph-supervisor');
      try {
        const deployment = getDeployment(summary.name);
        if (!deployment || !RECONCILABLE_STATUSES.has(deployment.status || '')) return;
        const selected = deployment.activeNodeId || deployment.desiredNodeId || 'coordinator';
        const local = process.env.DEPLOY_SUITCASE === '1' ? resolveLocalSiteId() : 'coordinator';
        if (selected !== local || !deployment.directory) return;
        const revision = deployment.activeSpecDigest
          ? getApplicationSpecRevision(deployment.name, deployment.activeSpecDigest)
          : null;
        if (revision?.manifestFormat !== 'deploy.yaml') return;
        const runtime = resolveApplicationGraphRuntime(deployment);
        if (!runtime.ready) return;
        const result = await new ApplicationGraphExecutor().converge({
          deploymentName: deployment.name,
          applicationId: deployment.appId || deployment.name,
          siteId: local,
          nodeId: local,
          projectDirectory: deployment.directory,
          runtime,
          writerSiteId: applicationWriterSiteId(deployment.appId || deployment.name),
          memoryLimit: deployment.memoryLimit || '4g',
          cpuLimit: deployment.cpuLimit || undefined,
        });
        saveDeployment({
          name: deployment.name,
          type: deployment.type || undefined,
          username: deployment.username,
          port: result.primaryPort ?? undefined,
          containerId: result.primaryContainerId ?? undefined,
          containerName: result.primaryContainerName ?? undefined,
          directory: deployment.directory,
          desiredNodeId: deployment.desiredNodeId,
          activeNodeId: deployment.activeNodeId,
          createdAt: deployment.createdAt || undefined,
        });
        if (deployment.status !== 'running') {
          addDeployEvent(deployment.name, {
            action: 'graph:recovered',
            username: 'system',
            source: 'auto',
          });
        }
        updateDeploymentStatus(deployment.name, 'running');
        lastError.delete(deployment.name);
      } finally {
        lease.release();
      }
    },
    onError(deployment, error) {
      const message = error instanceof Error ? error.message : String(error);
      const previous = lastError.get(deployment.name);
      const now = Date.now();
      if (!previous || previous.message !== message || now - previous.reportedAt >= 5 * 60_000) {
        console.error(`Application graph reconciliation failed for ${deployment.name}: ${message}`);
        lastError.set(deployment.name, { message, reportedAt: now });
      }
      updateDeploymentStatus(deployment.name, 'degraded');
    },
  };
}
