import type { NodeStatus } from '../../../server/features/computers/node-status.ts';
import { nodePermissions } from '../../../server/features/computers/node-permissions.ts';

export type CoordinatorStatus = {
  present: boolean;
  connected: boolean;
  status?: { children: { name: string; state: string }[] };
  fleet?: {
    dockerReachable: boolean;
    running: number;
    total: number;
    cpuCores: number;
    cpuPercent: number;
    memUsageBytes: number;
  };
  fleetAt?: number;
};
export type TrayAction =
  | 'setup'
  | 'screen'
  | 'input'
  | 'unlocked'
  | 'browser'
  | 'pause'
  | 'open'
  | 'quit'
  | 'start'
  | 'stop'
  | 'restart'
  | 'logs';
export type TrayItem = {
  label?: string;
  enabled?: boolean;
  type?: 'separator' | 'checkbox';
  checked?: boolean;
  action?: TrayAction;
  submenu?: TrayItem[];
};
export function coordinatorHealth(coordinator: CoordinatorStatus, now = Date.now()) {
  const fleet =
    coordinator.fleetAt && now - coordinator.fleetAt < 90000 ? coordinator.fleet : undefined;
  if (!coordinator.connected)
    return { color: 'red', label: 'supervisor not running', fleet: undefined } as const;
  if (!coordinator.status) return { color: 'orange', label: 'connecting…', fleet } as const;
  const down = coordinator.status.children.filter((child) => child.state !== 'running');
  return {
    color: down.length || fleet?.dockerReachable === false ? 'orange' : 'green',
    label: down.length
      ? `restarting: ${down.map((child) => child.name).join(', ')}`
      : fleet?.dockerReachable === false
        ? 'docker unreachable'
        : 'all systems go',
    fleet,
  } as const;
}
export function trayModel(
  status: NodeStatus,
  coordinator: CoordinatorStatus,
  now = Date.now(),
): { color: 'green' | 'orange' | 'red'; items: TrayItem[] } {
  const health = coordinatorHealth(coordinator, now);
  // The coordinator runs its own managed worker, so it is never an unenrolled node.
  const worker = !status.enrolled
    ? coordinator.present
      ? 'Coordinator'
      : 'Not enrolled'
    : !status.online
      ? 'Offline'
      : `Online as a worker${status.runningTaskCount === null ? '' : ` · running ${status.runningTaskCount} task${status.runningTaskCount === 1 ? '' : 's'}`}`;
  const permissions = nodePermissions({
    worker: {
      id: status.workerId || '',
      name: status.workerName,
      platform: 'linux',
      status: status.online ? 'online' : 'offline',
    },
    targets: [],
    fresh: true,
    managed: false,
    browserProjects: [],
    nodeCapabilities: status.capabilities,
  });
  const permissionItems = (['screen', 'input', 'unlocked'] as const).map((id): TrayItem => {
    const permission = permissions.find((p) => p.id === id)!;
    return { label: `${permission.state === 'on' ? '✓' : '⚠'} ${permission.label}`, action: id };
  });
  const coordinatorItems: TrayItem[] = !coordinator.present
    ? []
    : [
        { label: `Coordinator — ${health.label}`, enabled: false },
        ...(health.fleet?.dockerReachable
          ? [
              {
                label: `${health.fleet.running} of ${health.fleet.total} containers · ${Math.round(health.fleet.cpuPercent / (health.fleet.cpuCores || 1))}% CPU · ${(health.fleet.memUsageBytes / 1073741824).toFixed(1)}G`,
                enabled: false,
              },
            ]
          : []),
        // Offer only what makes sense for the server's current state.
        { label: 'Start server', action: 'start', enabled: !coordinator.connected },
        { label: 'Stop server…', action: 'stop', enabled: coordinator.connected },
        { label: 'Restart server…', action: 'restart', enabled: coordinator.connected },
        { label: 'Open logs', action: 'logs' },
        { type: 'separator' },
      ];
  return {
    color: coordinator.present
      ? health.color
      : !status.enrolled || !status.online
        ? 'red'
        : Object.values(status.capabilities).some((capability) => capability.state !== 'ok')
          ? 'orange'
          : 'green',
    items: [
      { label: `${status.workerName} — ${worker}`, enabled: false },
      { type: 'separator' },
      ...coordinatorItems,
      { label: 'Permissions', submenu: permissionItems },
      {
        label: 'Pause agent control',
        type: 'checkbox',
        checked: status.capabilities.controlPaused.state !== 'ok',
        action: 'pause',
      },
      { type: 'separator' },
      { label: 'Open deploy.local', action: 'open' },
      { label: 'Open setup…', action: 'setup' },
      { label: 'Quit', action: 'quit' },
    ],
  };
}
