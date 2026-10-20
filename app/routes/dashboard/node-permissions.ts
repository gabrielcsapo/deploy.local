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

export function permissionBadge(state: PermissionState): { tone: StatusTone; label: string } {
  switch (state) {
    case 'on':
      return { tone: 'healthy', label: 'Allowed' };
    case 'needs-approval':
      return { tone: 'attention', label: 'Needs approval' };
    case 'unavailable':
      return { tone: 'failed', label: 'Unavailable' };
    case 'unknown':
      return { tone: 'inactive', label: 'Unknown' };
    default:
      return { tone: 'inactive', label: 'Off' };
  }
}

/** One line for the computer's row: how much it allows, and whether anything waits on the owner. */
export function permissionsHeadline(permissions: NodePermission[] = []) {
  if (!permissions.length) return '';
  const allowed = permissions.filter((p) => p.state === 'on').length;
  const waiting = permissions.filter((p) => p.state === 'needs-approval').length;
  return `${allowed} of ${permissions.length} allowed${waiting ? ` · ${waiting} waiting for approval` : ''}`;
}
