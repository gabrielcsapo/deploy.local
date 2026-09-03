import { createHash } from 'node:crypto';
import type { ApplicationExecutionPlan } from './application-execution.ts';
import type { ApplicationSpec } from './application-spec.ts';
import type { ActualComponentInstance } from './application-reconciler.ts';
import type { RuntimeAdmissionFinding } from './component-profiles.ts';

export type JobExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface JobExecutionRecord {
  key: string;
  status: JobExecutionStatus;
  attempts: number;
}

export interface PlannedJobExecution {
  key: string;
  job: string;
  component: string;
  command: readonly string[];
  scope: ApplicationSpec['jobs'][string]['execution'];
  siteId: string;
  instanceId?: string;
  environment: ApplicationSpec['jobs'][string]['environment'];
  beforeTraffic: boolean;
  attempt: number;
}

export interface ApplicationJobPlan {
  executions: readonly PlannedJobExecution[];
  trafficGates: Readonly<Record<string, boolean>>;
  findings: readonly RuntimeAdmissionFinding[];
  blocked: boolean;
}

export interface ApplicationJobOptions {
  siteId: string;
  writerSiteId?: string | null;
  configurationDigest: string;
  records?: readonly JobExecutionRecord[];
  /** Failed executions are retried with the same idempotency key and an incremented attempt. */
  retryFailed?: boolean;
}

/** Plan scoped one-shot work without claiming fleet-wide exactly-once while sites are disconnected. */
export function planApplicationJobs(
  execution: ApplicationExecutionPlan,
  spec: ApplicationSpec,
  instances: readonly ActualComponentInstance[],
  options: ApplicationJobOptions,
): ApplicationJobPlan {
  const findings: RuntimeAdmissionFinding[] = [];
  const records = new Map((options.records ?? []).map((record) => [record.key, record]));
  const planned: PlannedJobExecution[] = [];
  const trafficGates: Record<string, boolean> = {};
  for (const componentName of execution.componentOrder) trafficGates[componentName] = true;

  const orderedJobs = Object.entries(spec.jobs).sort(([leftName, left], [rightName, right]) => {
    const componentOrder =
      execution.componentOrder.indexOf(left.component) -
      execution.componentOrder.indexOf(right.component);
    return componentOrder || leftName.localeCompare(rightName);
  });

  for (const [jobName, job] of orderedJobs) {
    const targets = jobTargets(job.execution, job.component, instances, options, findings, jobName);
    let jobComplete = true;
    for (const target of targets) {
      const key = jobExecutionKey({
        applicationId: execution.applicationId,
        releaseDigest: execution.specDigest,
        configurationDigest: options.configurationDigest,
        jobName,
        siteId: options.siteId,
        instanceId: target.instanceId,
      });
      const record = records.get(key);
      if (record?.status === 'succeeded') continue;
      jobComplete = false;
      if (record?.status === 'running' || (record?.status === 'failed' && !options.retryFailed)) {
        continue;
      }
      planned.push({
        key,
        job: jobName,
        component: job.component,
        command: job.command,
        scope: job.execution,
        siteId: options.siteId,
        instanceId: target.instanceId,
        environment: job.environment,
        beforeTraffic: job.beforeTraffic,
        attempt: (record?.attempts ?? 0) + 1,
      });
    }
    if (job.beforeTraffic && !jobComplete) trafficGates[job.component] = false;
  }

  return {
    executions: planned,
    trafficGates,
    findings,
    blocked: findings.some((item) => item.severity === 'error'),
  };
}

export function jobExecutionKey(input: {
  applicationId: string;
  releaseDigest: string;
  configurationDigest: string;
  jobName: string;
  siteId: string;
  instanceId?: string;
}): string {
  const canonical = JSON.stringify([
    input.applicationId,
    input.releaseDigest,
    input.configurationDigest,
    input.jobName,
    input.siteId,
    input.instanceId ?? null,
  ]);
  return `job:${createHash('sha256').update(canonical).digest('hex')}`;
}

function jobTargets(
  scope: ApplicationSpec['jobs'][string]['execution'],
  component: string,
  instances: readonly ActualComponentInstance[],
  options: ApplicationJobOptions,
  findings: RuntimeAdmissionFinding[],
  jobName: string,
): Array<{ instanceId?: string }> {
  if (scope === 'perSite') return [{}];
  if (scope === 'writerSite') {
    if (!options.writerSiteId) {
      findings.push({
        code: 'WRITER_SITE_UNRESOLVED',
        severity: 'error',
        path: `/jobs/${jobName}/execution`,
        message: 'writerSite job cannot be scheduled until the application writer site is known',
      });
      return [];
    }
    return options.writerSiteId === options.siteId ? [{}] : [];
  }
  return instances
    .filter((instance) => component === instance.component && instance.status !== 'stopped')
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((instance) => ({ instanceId: instance.id }));
}
