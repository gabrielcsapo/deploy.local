'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-flight-router/client';
import { Button, StatusBadge, Toggle } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { getAuth } from './detail/shared';
import type {
  NodeSetupStatus,
  HelperAction,
  BrowserInstallStatus,
} from '../../../packages/node-app/src/bridge';
import { LoginForm } from './data.client';
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
  const scrolledStep = useRef('');
  const [computers, setComputers] = useState<Computer[] | null>(null);
  const [error, setError] = useState('');
  const [signedOut, setSignedOut] = useState(false);
  const [local, setLocal] = useState<NodeSetupStatus | null>(null);
  const [helperBusy, setHelperBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [browserInstall, setBrowserInstall] = useState<BrowserInstallStatus>({
    busy: false,
    message: '',
  });
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
    let active = true;
    const bridge = window.deployNode;
    const updateLocal = () => {
      if (bridge)
        void bridge
          .status()
          .then((value) => {
            if (active) {
              setLocal(value);
              setBrowserInstall(value.browserInstall);
            }
          })
          .catch(() => {
            if (active) setError('Local setup status is unavailable.');
          });
    };
    updateLocal();
    const unsubscribe = bridge?.onBrowserInstall(setBrowserInstall);
    void load();
    const timer = window.setInterval(() => {
      void load();
      updateLocal();
    }, 4000);
    return () => {
      active = false;
      window.clearInterval(timer);
      unsubscribe?.();
    };
  }, [load]);

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash && scrolledStep.current !== hash) {
      const target = document.getElementById(hash);
      if (target) {
        target.scrollIntoView({ block: 'start' });
        scrolledStep.current = hash;
      }
    }
  }, [computers]);

  async function localHelper(action: HelperAction) {
    if (helperBusy || browserInstall.busy) return;
    setHelperBusy(true);
    setError('');
    try {
      await window.deployNode?.helper(action);
      await load();
    } catch {
      setError('Unable to change this permission. Check the helper on this computer and retry.');
    } finally {
      setHelperBusy(false);
    }
  }
  async function loginToggle() {
    setLoginBusy(true);
    try {
      await window.deployNode?.autostart(!local?.autostart);
      setLocal(await window.deployNode!.status());
    } catch {
      setError('Unable to change login startup.');
    } finally {
      setLoginBusy(false);
    }
  }
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
        <LoginForm onLogin={() => void load()} />
      ) : (
        <>
          {error && (
            <p className="ds-context-hint" role="alert">
              {error}
            </p>
          )}
          {computers === null && !error && <p className="ds-context-hint">Loading…</p>}
          {computers?.length === 0 && <p className="ds-context-hint">No task computers yet.</p>}
          {computers?.map((computer) => {
            const isLocal = local?.node.workerId === computer.id;
            return (
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
                  permissions={
                    isLocal
                      ? computer.permissions.filter((p) => p.id !== 'tasks')
                      : computer.permissions
                  }
                  browserInstall={isLocal ? browserInstall : undefined}
                  busy={helperBusy}
                  onRevoke={() => setRevoke(computer)}
                  localAction={
                    local?.node.workerId === computer.id
                      ? (action) => void localHelper(action)
                      : undefined
                  }
                />
                {isLocal && (
                  <section className="ds-setup-computer" aria-labelledby="this-computer-heading">
                    <h2 id="this-computer-heading">This computer</h2>
                    <ul className="ds-permissions">
                      <li className="ds-permission ds-setup-login">
                        <span>Start at login</span>
                        <Toggle
                          checkbox
                          enabled={local.autostart}
                          disabled={loginBusy}
                          onChange={() => void loginToggle()}
                          label="Start at login"
                        />
                      </li>
                      {computer.permissions.some(
                        (p) => p.step?.where === 'here' && p.step.action === 'revoke-worker',
                      ) && (
                        <li className="ds-permission ds-setup-revoke">
                          <Button variant="link" onClick={() => setRevoke(computer)}>
                            Revoke task access…
                          </Button>
                        </li>
                      )}
                    </ul>
                  </section>
                )}
              </section>
            );
          })}
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
