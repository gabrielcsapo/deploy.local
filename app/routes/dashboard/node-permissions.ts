import type { StatusTone } from '../../components/ui/StatusBadge';

/** Mirrors server/workspace/node-permissions.ts; the server decides every state and step. */
export type PermissionState = 'on' | 'off' | 'needs-approval' | 'unavailable' | 'unknown';
export type PermissionStep =
  | { where: 'computer'; label: string; command?: string; instruction?: string }
  | { where: 'here'; label: string; action: 'revoke-worker' | 'project-settings' };
export type NodePermission = {
  id: string;
  label: string;
  state: PermissionState;
  summary: string;
  step?: PermissionStep;
};

export function permissionBadge(
  state: PermissionState,
  id?: string,
): { tone: StatusTone; label: string } {
  switch (state) {
    case 'on':
      return {
        tone: 'healthy',
        label:
          (
            {
              screen: 'On',
              input: 'Allowed',
              unlocked: 'Off (unattended)',
              controlPaused: 'Allowed',
              browser: 'Ready',
            } as Record<string, string>
          )[id || ''] || 'Allowed',
      };
    case 'needs-approval':
      return { tone: 'attention', label: 'Needs approval' };
    case 'unavailable':
      return { tone: 'failed', label: id === 'browser' ? 'Not installed' : 'Unavailable' };
    case 'unknown':
      return { tone: 'inactive', label: 'Unknown' };
    default:
      return {
        tone: 'inactive',
        label:
          (
            {
              input: 'View-only',
              unlocked: 'On',
              controlPaused: 'Paused',
              browser: 'Not installed',
            } as Record<string, string>
          )[id || ''] || 'Off',
      };
  }
}

/** One line for the computer's row: how much it allows, and whether anything waits on the owner. */
export function permissionsHeadline(permissions: NodePermission[] = []) {
  if (!permissions.length) return '';
  const allowed = permissions.filter((p) => p.state === 'on').length;
  const waiting = permissions.filter((p) => p.state === 'needs-approval').length;
  return `${allowed} of ${permissions.length} allowed${waiting ? ` · ${waiting} waiting for approval` : ''}`;
}

/** Available only for this app's own computer. Reverse actions have distinct IPC names. */
export function permissionLocalAction(permission: NodePermission) {
  if (permission.state === 'unknown') return undefined;
  const on = permission.state === 'on';
  switch (permission.id) {
    case 'screen':
      return {
        action: on ? ('capture-stop' as const) : ('capture' as const),
        label: on ? 'Stop screen capture…' : 'Allow screen capture…',
      };
    case 'input':
      return {
        action: on ? ('input-stop' as const) : ('input' as const),
        label: on ? 'Make view-only…' : 'Allow input…',
      };
    case 'unlocked':
      return {
        action: on ? ('lock-restore' as const) : ('lock-off' as const),
        label: on ? 'Restore lock…' : 'Keep unlocked…',
      };
    case 'browser':
      return !on && /chromium/i.test(permission.summary)
        ? { action: 'browser' as const, label: 'Install Chromium (about 650 MB)' }
        : undefined;
    default:
      return undefined;
  }
}
