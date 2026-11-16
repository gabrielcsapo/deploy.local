import { workerBuild, type WorkerBuild } from '../../workspace/worker-build.ts';
export { workerBuild, type WorkerBuild } from '../../workspace/worker-build.ts';
import { coordinationTools } from '../../workspace/coordination-tools.ts';

export type WorkerUpdate = {
  state: 'current' | 'outdated' | 'unknown';
  reason: string;
  missingTools: string[];
};

export const agentTools = coordinationTools.map(({ name }) => name);

/** Informational inventory only; never use a worker's self-report for authorization. */
export function workerBuildReport(body: any): { build?: WorkerBuild; agentTools?: string[] } {
  const build = body?.build;
  return {
    ...(typeof build?.version === 'string' && build.version.length <= 100
      ? {
          build: {
            version: build.version,
            ...(typeof build.commit === 'string' && /^[a-f0-9]{7,64}$/i.test(build.commit)
              ? { commit: build.commit }
              : {}),
          },
        }
      : {}),
    ...(Array.isArray(body?.agentTools)
      ? {
          agentTools: [
            ...new Set<string>(
              body.agentTools.filter(
                (name: unknown) =>
                  typeof name === 'string' && /^deploy_[a-z0-9_]{1,100}$/.test(name),
              ),
            ),
          ].slice(0, 256),
        }
      : {}),
  };
}

// Semver precedence: compare numeric components, then prerelease identifiers;
// build metadata (including commit hashes) cannot establish which build is older.
function compareVersions(a: string, b: string): number | undefined {
  const parse = (value: string) =>
    value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  const left = parse(a),
    right = parse(b);
  if (!left || !right) return undefined;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(left[i]) - Number(right[i]);
    if (difference) return difference;
  }
  if (!left[4] || !right[4]) return left[4] ? -1 : right[4] ? 1 : 0;
  const l = left[4].split('.'),
    r = right[4].split('.');
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if (l[i] === r[i]) continue;
    if (l[i] === undefined) return -1;
    if (r[i] === undefined) return 1;
    const ln = /^\d+$/.test(l[i]),
      rn = /^\d+$/.test(r[i]);
    if (ln && rn) return Number(l[i]) - Number(r[i]);
    if (ln !== rn) return ln ? -1 : 1;
    return l[i] < r[i] ? -1 : 1;
  }
  return 0;
}

export function workerUpdate(
  worker: { id: string; build?: WorkerBuild; agentTools?: string[] },
  coordinatorVersion = workerBuild.version,
  tools: string[] = agentTools,
): WorkerUpdate {
  if (worker.id === 'local' || worker.id.startsWith('managed-'))
    return { state: 'current', reason: 'This worker runs with the coordinator.', missingTools: [] };
  const missingTools = worker.agentTools
    ? tools.filter((tool) => !worker.agentTools!.includes(tool))
    : [];
  const comparison = worker.build
    ? compareVersions(worker.build.version, coordinatorVersion)
    : undefined;
  if (missingTools.length || (comparison !== undefined && comparison < 0))
    return {
      state: 'outdated',
      reason: [
        'This computer runs an older deploy.local worker.',
        ...(comparison !== undefined && comparison < 0
          ? [`Worker ${worker.build!.version}; coordinator ${coordinatorVersion}.`]
          : []),
        ...(missingTools.length ? [`Agents here can't use: ${missingTools.join(', ')}.`] : []),
        ...(!worker.agentTools ? ["Agents here can't use newer agent tools."] : []),
      ].join(' '),
      missingTools,
    };
  if (!worker.agentTools || comparison === undefined)
    return {
      state: 'unknown',
      reason:
        "This computer runs an older deploy.local worker. Agents here can't use newer agent tools. Its build or tool report is unavailable.",
      missingTools,
    };
  return {
    state: 'current',
    reason: 'This worker supports the current agent tools.',
    missingTools: [],
  };
}
