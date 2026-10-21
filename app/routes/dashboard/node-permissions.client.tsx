'use client';

import { useState } from 'react';
import { Link } from 'react-flight-router/client';
import { Button, StatusBadge } from '../../components/ui';
import { permissionBadge, permissionLocalAction, type NodePermission } from './node-permissions';
import type { BrowserInstallStatus, HelperAction } from '../../../packages/node-app/src/bridge';

/** Local setup acts through the app; other computers keep copyable instructions. */
export function NodePermissions({
  computer,
  permissions,
  onRevoke,
  localAction,
  browserInstall,
  busy,
}: {
  computer: string;
  permissions: NodePermission[];
  onRevoke: () => void;
  localAction?: (action: HelperAction) => void;
  browserInstall?: BrowserInstallStatus;
  busy?: boolean;
}) {
  const actionable = localAction
    ? permissions.filter((p) => p.state !== 'on' && permissionLocalAction(p))
    : [];
  const primary =
    (browserInstall?.busy ? permissions.find((p) => p.id === 'browser') : undefined) ||
    actionable.find((p) => permissionLocalAction(p)?.action === 'browser') ||
    actionable[0];

  return (
    <ul
      className="ds-permissions"
      data-local={localAction ? true : undefined}
      aria-label={`Permissions on ${computer}`}
    >
      {permissions.map((permission) => {
        const badge = permissionBadge(permission.state, permission.id);
        const installing = permission.id === 'browser' && Boolean(browserInstall?.busy);
        const summary = localAction
          ? permission.id === 'unlocked' && permission.state === 'on'
            ? 'Anyone at this computer can use it.'
            : permission.state !== 'on'
              ? permission.summary
              : ''
          : permission.summary;
        return (
          <li
            key={permission.id}
            id={`permission-${permission.id}`}
            className="ds-permission"
            aria-labelledby={`permission-label-${permission.id}`}
          >
            <div className="ds-permission-head">
              <strong id={`permission-label-${permission.id}`}>{permission.label}</strong>
              <StatusBadge
                tone={installing ? 'active' : badge.tone}
                label={installing ? 'Installing…' : badge.label}
              />
            </div>
            <PermissionActions
              computer={computer}
              permission={permission}
              summary={summary}
              localAction={localAction}
              browserInstall={browserInstall}
              busy={busy}
              primary={primary?.id === permission.id}
              onRevoke={onRevoke}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** Shared local helper actions and remote, copyable repair/reversal instructions. */
export function PermissionActions({
  computer,
  permission,
  summary,
  localAction,
  browserInstall,
  busy,
  primary = false,
  onRevoke,
}: {
  computer: string;
  permission: NodePermission;
  summary?: string;
  localAction?: (action: HelperAction) => void;
  browserInstall?: BrowserInstallStatus;
  busy?: boolean;
  primary?: boolean;
  onRevoke?: () => void;
}) {
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState('');
  const step = permission.step;
  const browser = permission.id === 'browser';
  const installing = browser && Boolean(browserInstall?.busy);
  const action =
    localAction &&
    (installing
      ? { action: 'browser' as const, label: 'Installing Chromium…' }
      : permissionLocalAction(permission));
  const progress = browser && (installing || permission.state !== 'on') && browserInstall;
  async function copy(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopyError('');
      setCopied(command);
      window.setTimeout(() => setCopied(''), 1600);
    } catch {
      setCopyError('Unable to copy. Select the command to copy it.');
    }
  }
  return (
    <>
      <div className="ds-permission-detail">
        {summary && <p className="ds-permission-summary">{summary}</p>}
        {action && (
          <Button
            variant={primary ? 'primary' : 'link'}
            disabled={busy || Boolean(browserInstall?.busy)}
            aria-busy={browser && Boolean(browserInstall?.busy)}
            onClick={() => localAction?.(action.action)}
          >
            {browserInstall?.busy && browser ? 'Installing Chromium…' : action.label}
          </Button>
        )}
      </div>
      {progress && (progress.error || progress.message) && (
        <p className="ds-permission-summary" role={progress.error ? 'alert' : 'status'}>
          {progress.error || progress.message}
        </p>
      )}
      {step?.where === 'computer' && !localAction && (
        <div
          className="ds-permission-step"
          data-quiet={permission.state === 'on' ? true : undefined}
        >
          <span className="ds-permission-where">
            {step.label} · on {computer}
          </span>
          {step.command && (
            <span className="ds-permission-command">
              <code>{step.command}</code>
              <Button
                variant="link"
                aria-label={`Copy ${step.command}`}
                onClick={() => void copy(step.command!)}
              >
                {copied === step.command ? 'Copied' : 'Copy'}
              </Button>
            </span>
          )}
          {step.instruction && <span>{step.instruction}</span>}
          {copied === step.command && (
            <span role="status" className="sr-only">
              Command copied
            </span>
          )}
          {copyError && <span role="alert">{copyError}</span>}
        </div>
      )}
      {localAction && !action && step?.where === 'computer' && step.instruction && (
        <p className="ds-permission-summary">{step.instruction}</p>
      )}
      {step?.where === 'here' && !localAction && (step.action !== 'revoke-worker' || onRevoke) && (
        <div className="ds-permission-step">
          {step.action === 'revoke-worker' ? (
            <Button variant="link" onClick={onRevoke}>
              {step.label}
            </Button>
          ) : (
            <Link
              className="underline underline-offset-4 text-text-secondary"
              to="/dashboard/repositories"
            >
              {step.label}
            </Link>
          )}
        </div>
      )}
    </>
  );
}
