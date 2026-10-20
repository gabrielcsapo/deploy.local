'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-flight-router/client';
import { StatusBadge } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { getAuth } from './detail/shared';
import { NodePermissions } from './node-permissions.client';
import { permissionsHeadline, type NodePermission } from './node-permissions';

type Computer = {
  id: string;
  name: string;
  platform: string;
  status: string;
  permissions: NodePermission[];
};

function headers(): Record<string, string> {
  const auth = getAuth();
  return auth ? { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token } : {};
}

/**
 * Computer permissions without dashboard chrome, for a narrow embedded window such as a node's
 * own tray app. All state comes from GET /api/workspace/computers[/:id/permissions].
 */
export default function EmbedPermissionsClient() {
  const { workerId } = useParams() as { workerId?: string };
  const [computers, setComputers] = useState<Computer[] | null>(null);
  const [error, setError] = useState('');
  const [signedOut, setSignedOut] = useState(false);
  const [revoke, setRevoke] = useState<Computer | null>(null);

  const load = useCallback(async () => {
    if (!getAuth()) return setSignedOut(true);
    try {
      const path = workerId
        ? `/api/workspace/computers/${encodeURIComponent(workerId)}/permissions`
        : '/api/workspace/computers';
      const response = await fetch(path, { headers: headers() });
      if (response.status === 401) return setSignedOut(true);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Permissions are unavailable.');
      setComputers(workerId ? [body] : body.computers);
      setSignedOut(false);
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
    }
  }, [workerId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 4000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function confirmRevoke() {
    if (!revoke) return;
    const target = revoke;
    setRevoke(null);
    const response = await fetch(
      `/api/workspace/computers/${encodeURIComponent(target.id)}/revoke`,
      {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: crypto.randomUUID() }),
      },
    );
    if (!response.ok) setError((await response.json()).error || 'Unable to revoke');
    await load();
  }

  return (
    <main className="ds-embed-permissions">
      {signedOut ? (
        <p className="ds-context-hint">
          Sign in to deploy.local to see this computer’s permissions.{' '}
          <a href="/dashboard">Sign in</a>
        </p>
      ) : (
        <>
          {error && (
            <p className="ds-context-hint" role="alert">
              {error}
            </p>
          )}
          {computers === null && !error && <p className="ds-context-hint">Loading…</p>}
          {computers?.length === 0 && <p className="ds-context-hint">No task computers yet.</p>}
          {computers?.map((computer) => (
            <section key={computer.id} aria-label={computer.name}>
              <header className="ds-embed-permissions-head">
                <div>
                  <strong>{computer.name}</strong>
                  <p className="ds-context-hint">{permissionsHeadline(computer.permissions)}</p>
                </div>
                <StatusBadge
                  tone={computer.status === 'online' ? 'healthy' : 'inactive'}
                  label={computer.status === 'online' ? 'Online' : 'Offline'}
                />
              </header>
              <NodePermissions
                computer={computer.name}
                permissions={computer.permissions}
                onRevoke={() => setRevoke(computer)}
              />
            </section>
          ))}
          <p className="ds-context-hint">
            Desktop access is always approved on the computer itself.
          </p>
        </>
      )}
      <ConfirmDialog
        open={Boolean(revoke)}
        title={`Revoke ${revoke?.name || 'task worker'}?`}
        message="Its task worker disconnects and can’t run tasks or share its desktop until it is enrolled again on that computer. Its task history stays."
        confirmLabel="Revoke"
        danger
        requireTypedConfirmation={revoke?.name}
        onCancel={() => setRevoke(null)}
        onConfirm={confirmRevoke}
      />
    </main>
  );
}
