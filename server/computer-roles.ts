import type { NodePermission, NodeCapabilities } from './workspace/node-permissions.ts';

export const switchableRoles = ['deploy', 'tasks', 'computer', 'browser'] as const;
export type ComputerRoleId = (typeof switchableRoles)[number];
export type WantedRoles = Partial<Record<ComputerRoleId, boolean>>;
export type ComputerRole = {
  state: 'off' | 'needs-setup' | 'ready' | 'paused';
  reason: string;
  fix?: string;
};
export type RoleWorker = {
  id: string;
  name: string;
  platform: string;
  status: string;
  managed?: boolean;
  controlKinds?: string[];
  capabilities?: string[];
  connections?: { available: boolean; enabled?: boolean }[];
  permissions?: NodePermission[];
  nodeCapabilities?: NodeCapabilities;
};
export type RoleNode = {
  id: string;
  name: string;
  platform: string | null;
  kind: string;
  online: boolean;
  capabilities: string | null;
  /** Set once an execution agent has reported in; a Node-app enrollment alone never sets it. */
  agentVersion?: string | null;
  revokedAt?: string | null;
};
export type Computer = {
  id: string;
  name: string;
  platform: string;
  online: boolean;
  workerIds: string[];
  nodeId?: string;
  roles: Record<ComputerRoleId, ComputerRole> & { coordinator?: ComputerRole };
};

export function parseWantedRoles(value: unknown): WantedRoles {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Roles must be an object of role switches');
  for (const [key, enabled] of Object.entries(value)) {
    if (!switchableRoles.includes(key as ComputerRoleId) || typeof enabled !== 'boolean')
      throw new Error(`Invalid role switch: ${key}`);
  }
  return value as WantedRoles;
}

/** Pure join and readiness projection. Missing preferences preserve previously offered work. */
export function computerRoles(
  nodes: RoleNode[],
  workers: RoleWorker[],
  wanted: Record<string, WantedRoles> = {},
): Computer[] {
  const active = nodes.filter((node) => !node.revokedAt);
  const assigned = new Set<string>();
  const groups: { node?: RoleNode; workers: RoleWorker[] }[] = active.map((node) => {
    const linked = workers.filter(
      (worker) =>
        worker.id === `node-worker-${node.id}` ||
        (node.kind === 'coordinator' && (worker.managed || worker.id === 'local')),
    );
    linked.forEach((worker) => assigned.add(worker.id));
    return { node, workers: linked };
  });
  groups.push(
    ...workers
      .filter((worker) => !assigned.has(worker.id))
      .map((worker) => ({
        node: undefined,
        workers: [worker],
      })),
  );
  return groups.map(({ node, workers: linked }) => {
    const id = node?.id || linked[0].id;
    const permission = (key: string) =>
      linked.flatMap((w) => w.permissions || []).find((p) => p.id === key && p.state === 'on') ||
      linked.flatMap((w) => w.permissions || []).find((p) => p.id === key);
    const defaults = {
      // Only machines that have run the execution agent (or the coordinator) are deploy targets
      // by default; a desktop enrolled through the Node app is not.
      deploy: !!node && (node.kind === 'coordinator' || !!node.agentVersion),
      tasks: linked.length > 0,
      computer: linked.some(
        (w) =>
          w.controlKinds?.includes('computer') ||
          !!w.nodeCapabilities ||
          w.permissions?.some(
            (p) => p.id === 'screen' && ['on', 'unavailable', 'needs-approval'].includes(p.state),
          ),
      ),
      browser: linked.some(
        (w) =>
          w.controlKinds?.includes('browser') ||
          w.permissions?.some(
            (p) => p.id === 'browser' && (p.state === 'on' || p.state === 'unavailable'),
          ),
      ),
    };
    const enabled = { ...defaults, ...wanted[id] };
    const online = !!node?.online || linked.some((w) => w.status === 'online');
    const state = (
      role: ComputerRoleId,
      ready: boolean,
      reason: string,
      fix?: string,
    ): ComputerRole =>
      !enabled[role]
        ? { state: 'off', reason: 'This role is turned off on this computer.' }
        : { state: ready ? 'ready' : 'needs-setup', reason, ...(ready || !fix ? {} : { fix }) };
    let docker: any = {};
    try {
      docker = JSON.parse(node?.capabilities || '{}') || {};
    } catch {
      /* An invalid probe is not readiness evidence. */
    }
    const taskReady = linked.some(
      (w) =>
        w.status === 'online' &&
        (w.connections?.length
          ? w.connections.some((c) => c.available && c.enabled !== false)
          : w.capabilities?.some((c) => ['codex', 'claude', 'compatible'].includes(c))),
    );
    const controlRole = (role: 'computer' | 'browser'): ComputerRole => {
      const p = permission(role === 'computer' ? 'screen' : 'browser');
      const paused =
        linked.some(
          (w) =>
            w.nodeCapabilities?.controlPaused.state !== undefined &&
            w.nodeCapabilities.controlPaused.state !== 'ok',
        ) || permission('controlPaused')?.state === 'off';
      if (enabled[role] && paused)
        return {
          state: 'paused',
          reason: 'Agent control is paused on this computer.',
          fix: 'Resume agent control from the deploy.local Node tray.',
        };
      const ready = linked.some((w) => w.status === 'online') && p?.state === 'on';
      const step = p?.step;
      return state(
        role,
        ready,
        !linked.some((w) => w.status === 'online')
          ? 'The task worker is offline.'
          : p?.summary || 'The task worker has not reported this capability.',
        step?.where === 'computer'
          ? [step.command, step.instruction].filter(Boolean).join(' · ')
          : role === 'browser'
            ? 'deploy browser install'
            : 'deploy desktop-helper setup',
      );
    };
    return {
      id,
      name: node?.name || linked[0].name,
      platform: node?.platform || linked[0]?.platform || 'unknown',
      online,
      ...(node ? { nodeId: node.id } : {}),
      workerIds: linked.map((w) => w.id),
      roles: {
        ...(node?.kind === 'coordinator'
          ? { coordinator: { state: 'ready' as const, reason: 'Runs deploy.local.' } }
          : {}),
        deploy: state(
          'deploy',
          !!node?.online && docker.docker === true,
          !node
            ? 'Enroll an execution agent to deploy apps here.'
            : !node.online
              ? 'The execution agent is offline.'
              : docker.docker === true
                ? 'Docker is reachable.'
                : docker.dockerError || 'Docker is not reachable.',
          !node
            ? 'deploy agent join https://deploy.local'
            : !node.online
              ? 'deploy agent join https://deploy.local'
              : 'docker version',
        ),
        tasks: state(
          'tasks',
          taskReady,
          taskReady
            ? 'A task worker and provider connection are available.'
            : linked.some((w) => w.status === 'online')
              ? 'Sign in to a provider on this computer.'
              : 'The task worker is offline.',
          'Open deploy.local Node setup on this computer and connect a provider, or run pnpm workspace:worker.',
        ),
        computer: controlRole('computer'),
        browser: controlRole('browser'),
      },
    };
  });
}
