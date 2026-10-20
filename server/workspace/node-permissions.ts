/**
 * What each task computer allows, and the one next step to change it. Grants always happen on
 * the computer itself (OS dialogs, local commands); the coordinator can only take access away.
 * See docs/node-permissions.md.
 */
export type PermissionState = 'on' | 'off' | 'needs-approval' | 'unavailable' | 'unknown';

export type PermissionStep =
  | { where: 'computer'; label: string; command?: string; instruction?: string }
  | { where: 'here'; label: string; action: 'revoke-worker' | 'project-settings' };

export type NodePermission = {
  id: 'tasks' | 'screen' | 'input' | 'unlocked' | 'browser' | 'controlPaused';
  label: string;
  state: PermissionState;
  summary: string;
  step?: PermissionStep;
};

export type PermissionInputs = {
  worker: { id: string; name: string; platform: string; status: string };
  /** The worker's managed process on the coordinator, turned on and off in Settings. */
  managed: boolean;
  /** The worker's desktop-related control targets, from its latest poll. */
  targets: any[];
  /** Whether the control inventory is recent enough to trust. */
  fresh: boolean;
  /** Names of projects that always allow the task browser. */
  browserProjects: string[];
  nodeCapabilities?: NodeCapabilities;
};

const setup = 'deploy desktop-helper setup';
const offline = 'Unknown until the computer’s task worker is online.';

function minutes(seconds: number) {
  const value = Math.round(seconds / 60);
  return `${value} minute${value === 1 ? '' : 's'}`;
}

function tasks({ worker, managed }: PermissionInputs): NodePermission {
  const online = worker.status === 'online';
  return {
    id: 'tasks',
    label: 'Run coding tasks',
    state: online ? 'on' : 'off',
    summary: online
      ? `${worker.name} runs tasks assigned to it.`
      : `Enrolled, but the task worker on ${worker.name} is not running.`,
    step:
      worker.id === 'local'
        ? undefined
        : managed
          ? {
              where: 'computer',
              label: 'Managed worker',
              instruction: 'Turn the coordinator’s task worker on or off in Settings › Providers.',
            }
          : { where: 'here', label: 'Revoke', action: 'revoke-worker' },
  };
}

function linux(desktop: any, inputs: PermissionInputs): NodePermission[] {
  const name = inputs.worker.name;
  const status = desktop?.desktopStatus;
  if (!status)
    return [
      {
        id: 'screen',
        label: 'See the screen',
        state: inputs.fresh ? 'off' : 'unknown',
        summary: inputs.fresh ? `The desktop helper isn’t installed on ${name}.` : offline,
        step: { where: 'computer', label: 'Set up', command: setup },
      },
    ];
  const screen: NodePermission = !inputs.fresh
    ? { id: 'screen', label: 'See the screen', state: 'unknown', summary: offline }
    : !status.available
      ? {
          id: 'screen',
          label: 'See the screen',
          state: 'unavailable',
          summary: status.reason,
          step: { where: 'computer', label: 'Set up', command: setup },
        }
      : status.sessionType === 'wayland' && status.grantStored !== true
        ? {
            id: 'screen',
            label: 'See the screen',
            state: 'needs-approval',
            summary: `Installed. Approve screen sharing on ${name}’s screen once.`,
            step: { where: 'computer', label: 'Approve', command: setup },
          }
        : {
            id: 'screen',
            label: 'See the screen',
            state: 'on',
            summary: 'Agents you allow in a conversation can capture the screen.',
            step: {
              where: 'computer',
              label: 'Turn off',
              command: 'deploy desktop-helper uninstall',
            },
          };
  // Helpers that predate opt-in input don't report inputAllowed; they can't accept it either.
  const input: NodePermission =
    typeof status.inputAllowed !== 'boolean'
      ? {
          id: 'input',
          label: 'Click and type',
          state: 'off',
          summary: `View-only. The desktop helper on ${name} doesn’t support clicking and typing yet.`,
        }
      : status.inputAllowed === true
        ? {
            id: 'input',
            label: 'Click and type',
            state: 'on',
            summary: 'Agents you allow in a conversation can click and type.',
            step: {
              where: 'computer',
              label: 'Make view-only',
              command: 'deploy desktop-helper install',
            },
          }
        : {
            id: 'input',
            label: 'Click and type',
            state: 'off',
            summary: 'View-only. Agents can see the screen but not click or type.',
            step: {
              where: 'computer',
              label: 'Allow',
              command: 'deploy desktop-helper install --allow-input',
              instruction: `Then approve the remote-desktop dialog on ${name}’s screen.`,
            },
          };
  const lock = status.screenLock;
  const unlocked: NodePermission =
    typeof lock?.locks !== 'boolean'
      ? {
          id: 'unlocked',
          label: 'Stay unlocked',
          state: 'unknown',
          summary: `Deploy can’t read ${status.desktop || 'this desktop'}’s screen lock settings.`,
        }
      : lock.locks
        ? {
            id: 'unlocked',
            label: 'Stay unlocked',
            state: 'off',
            summary: `Locks after ${lock.idleSeconds ? minutes(lock.idleSeconds) : 'a while'} idle; captures show nothing while locked.`,
            step: {
              where: 'computer',
              label: 'Keep unlocked',
              command: 'deploy desktop-helper screen-lock off',
              instruction: `Anyone at ${name} could then use it without a password.`,
            },
          }
        : {
            id: 'unlocked',
            label: 'Stay unlocked',
            state: 'on',
            summary: lock.changedByDeploy
              ? 'Deploy turned the automatic lock off. Anyone at the computer can use it.'
              : 'The automatic lock is off. Anyone at the computer can use it.',
            step: lock.changedByDeploy
              ? {
                  where: 'computer',
                  label: 'Restore lock',
                  command: 'deploy desktop-helper screen-lock restore',
                }
              : {
                  where: 'computer',
                  label: 'Restore lock',
                  instruction: 'Turn the lock back on in the desktop’s privacy settings.',
                },
          };
  return [screen, input, unlocked];
}

function mac(display: any, inputs: PermissionInputs): NodePermission[] {
  const allow = (pane: string) => ({
    where: 'computer' as const,
    label: 'Allow',
    instruction: `System Settings › Privacy & Security › ${pane} › Deploy.`,
  });
  const revoke = (pane: string) => ({
    where: 'computer' as const,
    label: 'Turn off',
    instruction: `System Settings › Privacy & Security › ${pane}.`,
  });
  const helperMissing = {
    where: 'computer' as const,
    label: 'Install',
    instruction: 'Install Deploy.app in /Applications, then restart the task worker.',
  };
  const p = display?.permissions;
  if (!display || !p)
    return [
      {
        id: 'screen',
        label: 'See the screen',
        state: display || !inputs.fresh ? 'unknown' : 'off',
        summary:
          display?.reason ||
          (inputs.fresh ? 'The signed control helper isn’t configured on this Mac.' : offline),
        step: helperMissing,
      },
    ];
  const state = (on: boolean): PermissionState => (!inputs.fresh ? 'unknown' : on ? 'on' : 'off');
  return [
    {
      id: 'screen',
      label: 'See the screen',
      state: state(p.screenRecording),
      summary: p.screenRecording
        ? 'Screen Recording is allowed for the control helper.'
        : 'Screen Recording isn’t allowed for the control helper.',
      step: p.screenRecording ? revoke('Screen Recording') : allow('Screen Recording'),
    },
    {
      id: 'input',
      label: 'Click and type',
      state: state(p.accessibility),
      summary: p.accessibility
        ? 'Accessibility is allowed: agents you allow can click and type in a window.'
        : 'Accessibility isn’t allowed for the control helper.',
      step: p.accessibility ? revoke('Accessibility') : allow('Accessibility'),
    },
    {
      id: 'unlocked',
      label: 'Stay unlocked',
      state: state(p.unlocked),
      summary: p.unlocked ? 'Unlocked now.' : 'Locked now; agents can’t see or control it.',
      step: {
        where: 'computer',
        label: 'Lock settings',
        instruction: 'System Settings › Lock Screen.',
      },
    },
  ];
}

function browser(target: any, inputs: PermissionInputs): NodePermission {
  const projects = inputs.browserProjects;
  const approval = projects.length
    ? `Always allowed in ${projects.join(', ')}; other projects ask each time.`
    : 'Each conversation asks you first.';
  if (!target)
    return {
      id: 'browser',
      label: 'Task browser',
      state: 'off',
      summary: 'This worker doesn’t offer a headless browser.',
      step: {
        where: 'computer',
        label: 'Turn on',
        instruction: 'Start the task worker with DEPLOY_BROWSER_CONTROL=1.',
      },
    };
  return {
    id: 'browser',
    label: 'Task browser',
    state: !inputs.fresh ? 'unknown' : target.available ? 'on' : 'unavailable',
    summary: target.available ? `A headless browser. ${approval}` : target.reason,
    step: { where: 'here', label: 'Project settings', action: 'project-settings' },
  };
}

export function nodePermissions(inputs: PermissionInputs): NodePermission[] {
  const { worker, targets } = inputs;
  const desktop =
    worker.platform === 'linux'
      ? linux(
          targets.find((t) => t.id === 'desktop'),
          inputs,
        )
      : worker.platform === 'darwin'
        ? mac(
            targets.find(
              (t) =>
                t.kind === 'computer' &&
                (t.id === 'desktop' || String(t.id).startsWith('display-')),
            ),
            inputs,
          )
        : [];
  const permissions = [
    tasks(inputs),
    ...desktop,
    browser(
      targets.find((t) => t.kind === 'browser'),
      inputs,
    ),
  ];
  if (!inputs.nodeCapabilities) return permissions;
  const ids = {
    capture: 'screen',
    input: 'input',
    browser: 'browser',
    screenLock: 'unlocked',
    controlPaused: 'controlPaused',
  } as const;
  const labels = {
    capture: 'Screen capture',
    input: 'Input (click and type)',
    browser: 'Task browser',
    screenLock: 'Screen lock',
    controlPaused: 'Agent control',
  };
  return [
    tasks(inputs),
    ...capabilityNames.map((key): NodePermission => {
      const capability = inputs.nodeCapabilities![key];
      return {
        id: ids[key],
        label: labels[key],
        state: !inputs.fresh
          ? 'unknown'
          : capability.state === 'ok'
            ? 'on'
            : capability.state === 'unavailable'
              ? 'unavailable'
              : 'off',
        summary: capability.reason,
        step: capability.fix
          ? { where: 'computer', label: 'Next step', instruction: capability.fix }
          : undefined,
      };
    }),
  ];
}

export const capabilityNames = [
  'capture',
  'input',
  'browser',
  'screenLock',
  'controlPaused',
] as const;
export type NodeCapability = {
  state: 'ok' | 'needs-action' | 'unavailable';
  reason: string;
  fix: string;
};
export type NodeCapabilities = Record<(typeof capabilityNames)[number], NodeCapability>;

/** The same permission decisions power the CLI, tray, worker heartbeat and Computers view. */
export function nodeCapabilities(inputs: PermissionInputs, paused = false): NodeCapabilities {
  const permissions = nodePermissions({ ...inputs, nodeCapabilities: undefined });
  const ids = { capture: 'screen', input: 'input', browser: 'browser', screenLock: 'unlocked' };
  const entries = Object.entries(ids).map(([key, id]) => {
    const permission = permissions.find((p) => p.id === id);
    const step = permission?.step;
    return [
      key,
      {
        state:
          permission?.state === 'on'
            ? 'ok'
            : permission?.state === 'unavailable'
              ? 'unavailable'
              : 'needs-action',
        reason: permission?.summary || 'Unknown: this worker has not reported this capability.',
        fix:
          step?.where === 'computer'
            ? [step.command, step.instruction].filter(Boolean).join(' · ')
            : '',
      },
    ];
  });
  return {
    ...Object.fromEntries(entries),
    controlPaused: {
      state: paused ? 'needs-action' : 'ok',
      reason: paused
        ? 'Agent control is paused on this computer.'
        : 'New control sessions are allowed, subject to conversation approval.',
      fix: paused ? 'Resume agent control from the deploy.local Node tray.' : '',
    },
  } as NodeCapabilities;
}

/** Worker payloads are untrusted; keep bounded explanatory text and known states only. */
export function parseNodeCapabilities(value: unknown): NodeCapabilities | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = capabilityNames.map((key) => {
    const capability = (value as NodeCapabilities)[key];
    if (!capability || !['ok', 'needs-action', 'unavailable'].includes(capability.state))
      return null;
    return [
      key,
      {
        state: capability.state,
        reason: String(capability.reason || '').slice(0, 1000),
        fix: String(capability.fix || '').slice(0, 1000),
      },
    ];
  });
  return entries.some((entry) => entry === null)
    ? undefined
    : (Object.fromEntries(entries as [string, NodeCapability][]) as NodeCapabilities);
}
