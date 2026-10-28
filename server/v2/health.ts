import type { AppHealth } from '../../shared/v2/contracts.ts';

export type WorkerReport = {
  appId: string;
  jobs: number;
  failures: number;
  intervalSec: number;
  queueDepth: number;
  oldestJobAgeSec: number;
};
export type WorkerSample = WorkerReport & { at: number };
export type WorkerState = {
  samples: WorkerSample[];
  baselineJobs: number;
  baselineFailures: number;
  baselineSeconds: number;
  failingSince?: number;
};
export const freshMs = 90_000;

export function validateReport(body: any): WorkerReport {
  if (!body || typeof body.appId !== 'string' || !body.appId || body.appId.length > 200)
    throw new Error('appId is required');
  for (const field of ['jobs', 'failures', 'queueDepth', 'oldestJobAgeSec', 'intervalSec']) {
    if (!Number.isSafeInteger(body[field]) || body[field] < 0)
      throw new Error(`${field} must be a non-negative safe integer`);
  }
  if (body.failures > body.jobs) throw new Error('failures cannot exceed jobs');
  if (body.intervalSec < 10 || body.intervalSec > 60)
    throw new Error('intervalSec must be between 10 and 60');
  return Object.fromEntries(
    ['appId', 'jobs', 'failures', 'intervalSec', 'queueDepth', 'oldestJobAgeSec'].map((key) => [
      key,
      body[key],
    ]),
  ) as WorkerReport;
}

/** Counts are deltas, including failures in jobs. A gap breaks the continuous breach. */
export function recordWorker(
  previous: WorkerState | undefined,
  report: WorkerReport,
  at: number,
): WorkerState {
  const state: WorkerState = previous
    ? structuredClone(previous)
    : {
        samples: [],
        baselineJobs: 0,
        baselineFailures: 0,
        baselineSeconds: 0,
      };
  const last = state.samples.at(-1);
  if (last && at - last.at < report.intervalSec * 1000 - 1000)
    throw new Error('Report overlaps the previous interval');
  if (!last || at - last.at > freshMs) state.failingSince = undefined;
  const rate = report.jobs ? report.failures / report.jobs : 0;
  const baseline = state.baselineJobs ? state.baselineFailures / state.baselineJobs : 0;
  const ready = state.baselineSeconds >= 120 && state.baselineJobs > 0;
  const breach = report.jobs > 0 && rate > 0.1 && rate > 5 * baseline;
  if (ready && breach) state.failingSince ??= at;
  else state.failingSince = undefined;
  // Learn only non-incident windows; freeze the baseline through an incident.
  if (!breach) {
    state.baselineJobs += report.jobs;
    state.baselineFailures += report.failures;
    state.baselineSeconds += report.intervalSec;
    if (state.baselineSeconds > 86400) {
      state.baselineJobs *= 0.5;
      state.baselineFailures *= 0.5;
      state.baselineSeconds *= 0.5;
    }
  }
  state.samples = [...state.samples.filter((s) => at - s.at <= 3600_000), { ...report, at }].slice(
    -360,
  );
  return state;
}

export function workerHealth(
  appId: string,
  state: WorkerState | undefined,
  now: number,
): AppHealth {
  const sample = state?.samples.at(-1);
  const result: AppHealth = {
    appId,
    kind: 'worker',
    state: 'warning',
    summary: 'Health checks unavailable',
  };
  if (!sample || !state) return result;
  result.heartbeatAt = new Date(sample.at).toISOString();
  result.queue = { depth: sample.queueDepth, oldestSec: sample.oldestJobAgeSec };
  if (now - sample.at > freshMs) return { ...result, summary: 'Worker health report is overdue' };
  const rate = sample.jobs ? sample.failures / sample.jobs : 0;
  const baseline = state.baselineJobs ? state.baselineFailures / state.baselineJobs : 0;
  result.jobs = {
    perMin: (sample.jobs * 60) / sample.intervalSec,
    failRate: rate,
    baselineFailRate: baseline,
  };
  const failing = state.failingSince !== undefined && sample.at - state.failingSince >= 120_000;
  if (failing)
    return {
      ...result,
      state: 'failing',
      summary: `${Math.round(rate * 100)}% of jobs error since ${new Date(state.failingSince!).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
    };
  if (rate > 0.1)
    return {
      ...result,
      summary: `${Math.round(rate * 100)}% of jobs error · ${state.baselineSeconds < 120 ? 'learning the baseline' : 'watching for 2 minutes'}`,
    };
  if (state.baselineSeconds < 120 || !state.baselineJobs)
    return { ...result, summary: 'Learning the job failure baseline' };
  if (sample.oldestJobAgeSec > 60)
    return {
      ...result,
      summary: `${sample.queueDepth.toLocaleString('en-US')} jobs waiting · oldest ${Math.ceil(sample.oldestJobAgeSec / 60)} min`,
    };
  return {
    ...result,
    state: 'healthy',
    summary: `Heartbeat ${Math.max(0, Math.floor((now - sample.at) / 1000))} s ago`,
  };
}

export type WebEvidence = {
  appId: string;
  status: string;
  online: boolean;
  heartbeatAt?: string;
  check?: { path: string; status: number; at: number; durationMs: number };
  metrics?: {
    rps: number | null;
    errPct: number | null;
    p95Ms: number | null;
    memPct: number | null;
  };
  restarts?: { count: number; windowSec: number };
};
export function webHealth(input: WebEvidence, now: number): AppHealth {
  const { appId, heartbeatAt, restarts, metrics, check } = input;
  const result: AppHealth = {
    appId,
    kind: 'web',
    state: 'warning',
    summary: 'Health checks unavailable',
    ...(heartbeatAt ? { heartbeatAt } : {}),
    ...(restarts ? { restarts } : {}),
  };
  if (['stopped', 'exited'].includes(input.status))
    return { ...result, state: 'stopped', summary: 'Not running' };
  if (!input.online) return { ...result, state: 'failing', summary: 'Computer is offline' };
  if (restarts && restarts.count >= 3)
    return {
      ...result,
      state: 'failing',
      summary: `Restarted ${restarts.count} times in ${restarts.windowSec / 60} min`,
    };
  if (check && now - check.at <= freshMs) {
    result.http = {
      path: check.path,
      status: check.status,
      p95ms: metrics?.p95Ms ?? check.durationMs,
      reqPerMin: Math.round((metrics?.rps ?? 0) * 60),
    };
    if (check.status === 0 || check.status >= 400)
      return {
        ...result,
        state: 'failing',
        summary: check.status
          ? `GET ${check.path} returned ${check.status}`
          : `GET ${check.path} did not respond`,
      };
    result.state = 'healthy';
    result.summary = `GET ${check.path} ${check.status}`;
  }
  if ((metrics?.errPct ?? 0) > 10 && (metrics?.rps ?? 0) > 0)
    return {
      ...result,
      state: 'failing',
      summary: `${Math.round(metrics!.errPct!)}% of requests error in the last minute`,
    };
  if ((metrics?.memPct ?? 0) > 90)
    return {
      ...result,
      state: 'warning',
      summary: `${Math.round(metrics!.memPct!)}% of memory in use`,
    };
  return result;
}
