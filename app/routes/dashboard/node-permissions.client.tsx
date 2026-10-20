'use client';

import { useState } from 'react';
import { Link } from 'react-flight-router/client';
import { StatusBadge } from '../../components/ui';
import { CopyIcon } from '../../components/dashboard/icons';
import { permissionBadge, type NodePermission } from './node-permissions';

/**
 * A computer's permissions with the one next step for each. Steps on the computer are shown as
 * commands to run there; nothing here can grant desktop access remotely.
 */
export function NodePermissions({
  computer,
  permissions,
  onRevoke,
}: {
  computer: string;
  permissions: NodePermission[];
  onRevoke: () => void;
}) {
  const [copied, setCopied] = useState('');
  async function copy(command: string) {
    await navigator.clipboard.writeText(command);
    setCopied(command);
    window.setTimeout(() => setCopied(''), 1600);
  }
  return (
    <ul className="ds-permissions" aria-label={`Permissions on ${computer}`}>
      {permissions.map((permission) => {
        const badge = permissionBadge(permission.state);
        const step = permission.step;
        return (
          <li key={permission.id} className="ds-permission">
            <div className="ds-permission-head">
              <strong>{permission.label}</strong>
              <StatusBadge tone={badge.tone} label={badge.label} />
            </div>
            <p className="ds-permission-summary">{permission.summary}</p>
            {step?.where === 'computer' && (
              <div className="ds-permission-step">
                <span className="ds-permission-where">
                  {step.label} · on {computer}
                </span>
                {step.command && (
                  <span className="ds-permission-command">
                    <code>{step.command}</code>
                    <button
                      type="button"
                      aria-label={`Copy ${step.command}`}
                      onClick={() => void copy(step.command!)}
                    >
                      <CopyIcon className="h-4 w-4" />
                    </button>
                    {copied === step.command && <span role="status">Copied</span>}
                  </span>
                )}
                {step.instruction && <span>{step.instruction}</span>}
              </div>
            )}
            {step?.where === 'here' && (
              <div className="ds-permission-step">
                {step.action === 'revoke-worker' ? (
                  <button type="button" className="btn btn-sm btn-danger" onClick={onRevoke}>
                    {step.label}
                  </button>
                ) : (
                  <Link className="btn btn-sm" to="/dashboard/repositories">
                    {step.label}
                  </Link>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
