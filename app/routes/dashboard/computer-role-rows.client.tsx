'use client';

import { Button, StatusBadge, Toggle } from '../../components/ui';
import type { ComputerRole, ComputerRoleId } from '../../../server/computer-roles';
import type { BrowserInstallStatus, HelperAction } from '../../../packages/node-app/src/bridge';
import { permissionBadge, permissionLocalAction, type NodePermission } from './node-permissions';
import { PermissionActions } from './node-permissions.client';

export const roleLabels = {
  coordinator: 'Coordinator',
  deploy: 'Deploy apps',
  tasks: 'Coding tasks',
  computer: 'Screen access',
  browser: 'Task browser',
};
const states = { ready: 'Ready', 'needs-setup': 'Needs setup', paused: 'Paused', off: 'Off' };

export function RoleBadge({ role, label = '' }: { role: ComputerRole; label?: string }) {
  return (
    <StatusBadge
      tone={role.state === 'ready' ? 'healthy' : role.state === 'off' ? 'inactive' : 'attention'}
      label={`${label ? `${label} · ` : ''}${states[role.state]}`}
    />
  );
}

/** Roles and their permissions share a single inset group in setup and the dashboard. */
export function ComputerRoleRows({
  computer,
  roles,
  permissions,
  onToggle,
  copy,
  copied,
  localAction,
  browserInstall,
  busy,
  anchors = false,
}: {
  computer: string;
  roles: Record<string, ComputerRole | undefined>;
  permissions: NodePermission[];
  onToggle: (id: ComputerRoleId, enabled: boolean) => void;
  copy: (value: string) => void;
  copied?: string;
  localAction?: (action: HelperAction) => void;
  browserInstall?: BrowserInstallStatus;
  busy?: boolean;
  /** Embedded setup links target a permission on this computer. */
  anchors?: boolean;
}) {
  const permission = (id: string) =>
    permissions.find((p) => p.id === id && p.state === 'on') ||
    permissions.find((p) => p.id === id);
  return (
    <ul className="ds-permissions ds-role-group" aria-label={`Roles on ${computer}`}>
      {Object.entries(roles).map(([id, role]) => {
        if (!role || id === 'coordinator') return null;
        const p = permission(id === 'computer' ? 'screen' : id);
        const paused = permission('controlPaused');
        const off = role.state === 'off';
        const summary = off
          ? ''
          : role.state !== 'ready'
            ? role.reason
            : id === 'browser'
              ? role.reason.replace(/^A headless browser\.\s*/, '')
              : id === 'computer'
                ? 'Agents you allow in a conversation can capture the screen.'
                : '';
        const fixPermission = role.state === 'paused' ? paused : p;
        const step = fixPermission?.step;
        const hasPermissionFix = localAction
          ? fixPermission &&
            (permissionLocalAction(fixPermission) ||
              (step?.where === 'computer' && step.instruction))
          : step?.where === 'computer' && (step.command || step.instruction);
        const showFix = !off && role.fix && !hasPermissionFix;
        return (
          <li
            className="ds-permission"
            key={id}
            id={anchors ? `permission-${id === 'computer' ? 'screen' : id}` : undefined}
          >
            <div className="ds-role-row">
              <div className="ds-role-label">
                <strong>{roleLabels[id as ComputerRoleId]}</strong>
                {summary && <p className="ds-permission-summary">{summary}</p>}
              </div>
              <div className="ds-role-state">
                <RoleBadge role={role} />
                <Toggle
                  checkbox
                  label={`${roleLabels[id as ComputerRoleId]} on ${computer}`}
                  enabled={!off}
                  disabled={busy}
                  onChange={() => onToggle(id as ComputerRoleId, off)}
                />
              </div>
            </div>
            {showFix && (
              <div className="ds-permission-step">
                <span className="ds-permission-where">On {computer}</span>
                <span className="ds-permission-command">
                  <code>{role.fix}</code>
                  <Button
                    variant="link"
                    aria-label={`Copy ${role.fix}`}
                    onClick={() => copy(role.fix!)}
                  >
                    {copied === role.fix ? 'Copied' : 'Copy'}
                  </Button>
                </span>
              </div>
            )}
            {!off && p && (
              <PermissionActions
                computer={computer}
                permission={p}
                localAction={localAction}
                browserInstall={browserInstall}
                busy={busy}
              />
            )}
            {!off && role.state === 'paused' && paused?.step && (
              <PermissionActions
                computer={computer}
                permission={paused}
                localAction={localAction}
                busy={busy}
              />
            )}
            {id === 'computer' && !off && (
              <ul className="ds-role-subrows">
                {['input', 'unlocked'].map((key) => {
                  const sub = permission(key);
                  if (!sub) return null;
                  const badge = permissionBadge(sub.state, key);
                  return (
                    <li
                      className="ds-permission"
                      key={key}
                      id={anchors ? `permission-${key}` : undefined}
                    >
                      <div className="ds-role-row">
                        <div className="ds-role-label">
                          <span>{key === 'input' ? 'Allow click and type' : 'Screen lock'}</span>
                          {(sub.state !== 'on' || key === 'unlocked') && (
                            <p className="ds-permission-summary">{sub.summary}</p>
                          )}
                        </div>
                        <StatusBadge {...badge} />
                      </div>
                      <PermissionActions
                        computer={computer}
                        permission={sub}
                        localAction={localAction}
                        busy={busy}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
