'use client';
import { CopyButton, ListPageHeader, ListRow, IconButton } from '@/components/ui';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Select, TextField, Toggle } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorBanner, LoadingState } from '../../components/LoadingState';
import { getAuth } from './detail/shared';
import { ComputerRoleRows, roleLabels as labels } from './computer-role-rows.client';
import { computerCredentials, removeComputer, enrollmentCommand } from './computer-actions';
import { useDialogFocus } from '../../components/useDialogFocus';
import type { NodePermission } from './node-permissions';
import type { Computer, ComputerRoleId, WantedRoles } from '../../../server/computer-roles';

import { WorkerUpdateNotice } from './worker-update.client';
import { computerRoleSummary } from './list-summaries';

const roles: ComputerRoleId[] = ['deploy', 'tasks', 'computer', 'browser'];
const desktopRoles: WantedRoles = { deploy: false, tasks: true, computer: true, browser: true };
function headers() {
  const auth = getAuth();
  return {
    'Content-Type': 'application/json',
    ...(auth ? { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token } : {}),
  };
}
type Node = {
  id: string;
  name: string;
  kind: string;
  apps: { id: string; name: string; status: string; detail: string }[];
  jobs?: { id: string; type: string; deploymentName: string; status: string; error?: string }[];
};
type Worker = { id: string; name: string; permissions?: NodePermission[]; managed?: boolean };

export default function NodesClient() {
  const [computers, setComputers] = useState<Computer[] | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [defaultNode, setDefaultNode] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState('');
  const [name, setName] = useState('');
  const [enrollmentRoles, setEnrollmentRoles] = useState(desktopRoles);
  const [enrollmentPlatform, setEnrollmentPlatform] = useState<'darwin' | 'linux'>('darwin');
  const [enrollment, setEnrollment] = useState<{
    name: string;
    code: string;
    expiresAt: number;
    command: string;
  } | null>(null);
  const [revoke, setRevoke] = useState<Computer | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  function closeEnrollment() {
    setConnecting(false);
    if (window.location.hash === '#computer-enrollment') {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  }
  useDialogFocus(connecting, dialogRef, closeEnrollment);
  useEffect(() => {
    const update = () => {
      setConnecting(window.location.hash === '#computer-enrollment');
      setSelectedId(
        window.location.hash.startsWith('#computer/')
          ? decodeURIComponent(window.location.hash.slice(10))
          : '',
      );
    };
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const load = useCallback(async () => {
    try {
      const results = await Promise.all(
        ['/api/computers', '/api/nodes', '/api/workspace/state'].map(async (url) => {
          const response = await fetch(url, { headers: headers() });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || 'Unable to load computers');
          return body;
        }),
      );
      setComputers(results[0].computers);
      setNodes(results[1].nodes);
      setDefaultNode(results[1].defaultNodeId);
      setWorkers(results[2].workers || []);
    } catch (failure) {
      setError((failure as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 4000);
    return () => window.clearInterval(timer);
  }, [load]);
  async function mutate(url: string, method: string, body?: unknown) {
    setBusy(url);
    setError('');
    try {
      const response = await fetch(url, {
        method,
        headers: headers(),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to update computer');
      await load();
      return result;
    } catch (failure) {
      setError((failure as Error).message);
      return null;
    } finally {
      setBusy('');
    }
  }
  async function createEnrollment(event: FormEvent) {
    event.preventDefault();
    const result = await mutate('/api/nodes/enrollment', 'POST', {
      name: name.trim(),
      roles: enrollmentRoles,
    });
    if (result) {
      setEnrollment({
        ...result,
        command: enrollmentCommand(enrollmentPlatform, enrollmentRoles, window.location.origin),
      });
      setName('');
    }
  }

  return (
    <div className="ds-computers">
      {error && <ErrorBanner message={error} />}
      <section id="computer-list" aria-label="Computers">
        <ListPageHeader>
          <Button variant="primary" onClick={() => (window.location.hash = '#computer-enrollment')}>
            Connect a computer
          </Button>
          <TextField
            label="Find a computer"
            appearance="plain"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a computer"
          />
        </ListPageHeader>
        {computers === null ? (
          <LoadingState />
        ) : (
          <div className="ds-task-worker-list">
            {computers
              .filter((computer) =>
                selectedId
                  ? computer.id === selectedId
                  : `${computer.name} ${computer.platform}`
                      .toLowerCase()
                      .includes(filter.toLowerCase()),
              )
              .map((computer) => {
                const node = nodes.find((item) => item.id === computer.nodeId);
                return (
                  <div key={computer.id}>
                    {selectedId ? (
                      <ListPageHeader>
                        <IconButton
                          icon="back"
                          label="All computers"
                          onClick={() => {
                            window.location.hash = 'computer-list';
                          }}
                        />
                        <strong>{computer.name}</strong>
                        <span className="ds-context-hint">
                          {computer.platform} · {computer.online ? 'Online' : 'Offline'}
                        </span>
                      </ListPageHeader>
                    ) : (
                      <ListRow
                        to={`/dashboard/computers#computer/${encodeURIComponent(computer.id)}`}
                        icon="computer"
                        title={computer.name}
                        secondary={`${computer.platform} · ${computer.online ? 'Online' : 'Offline'}${computer.update && computer.update.state !== 'current' ? ' · Update available' : ''}`}
                        badge={
                          computer.roles.coordinator ? (
                            <span className="ds-coordinator-chip">Coordinator</span>
                          ) : undefined
                        }
                        status={computerRoleSummary(computer)}
                        menu={
                          !computer.roles.coordinator &&
                          (computer.nodeId || computer.workerIds.length > 0) ? (
                            <Button
                              variant="link"
                              className="ds-danger-link"
                              data-dismiss-menu
                              disabled={!!busy}
                              onClick={() => setRevoke(computer)}
                            >
                              Remove computer
                            </Button>
                          ) : undefined
                        }
                      />
                    )}
                    {selectedId && (
                      <>
                        <WorkerUpdateNotice update={computer.update} platform={computer.platform} />
                        <ComputerRoleRows
                          computer={computer.name}
                          roles={computer.roles}
                          permissions={computer.workerIds.flatMap(
                            (id) => workers.find((worker) => worker.id === id)?.permissions || [],
                          )}
                          busy={!!busy}
                          onToggle={(id, enabled) =>
                            void mutate(
                              `/api/computers/${encodeURIComponent(computer.id)}/roles`,
                              'PATCH',
                              { [id]: enabled },
                            )
                          }
                        />
                        {node && (
                          <div className="px-4 py-3 space-y-3">
                            <div className="flex flex-wrap gap-3">
                              {computer.roles.deploy.state !== 'off' &&
                                (defaultNode === node.id ? (
                                  <span className="text-sm text-text-secondary">
                                    Default deployment computer
                                  </span>
                                ) : (
                                  <Button
                                    variant="link"
                                    disabled={!!busy}
                                    onClick={() =>
                                      void mutate('/api/nodes/default', 'PUT', { nodeId: node.id })
                                    }
                                  >
                                    Use as default
                                  </Button>
                                ))}
                            </div>
                            {!!node.apps.length && (
                              <details>
                                <summary>Runtime applications</summary>
                                {node.apps.map((app) => (
                                  <p className="ds-context-hint" key={app.id || app.name}>
                                    {app.name} · {app.status} · {app.detail}
                                  </p>
                                ))}
                              </details>
                            )}
                            {!!node.jobs?.length && (
                              <details>
                                <summary>Deployment jobs</summary>
                                {node.jobs.map((job) => (
                                  <p className="ds-context-hint" key={job.id}>
                                    {job.type} · {job.deploymentName} · {job.status}
                                    {job.error && ` · ${job.error}`}
                                  </p>
                                ))}
                              </details>
                            )}
                          </div>
                        )}
                        {!computer.roles.coordinator &&
                          (computer.nodeId || computer.workerIds.length > 0) && (
                            <div className="ds-computer-remove">
                              <Button
                                variant="link"
                                className="ds-danger-link"
                                disabled={!!busy}
                                onClick={() => setRevoke(computer)}
                              >
                                Remove {computer.name}…
                              </Button>
                            </div>
                          )}
                      </>
                    )}
                  </div>
                );
              })}
            {!computers.length && <p className="ds-feedback">No computers connected</p>}
            {!!computers.length &&
              !computers.some((c) =>
                `${c.name} ${c.platform}`.toLowerCase().includes(filter.toLowerCase()),
              ) && (
                <p className="ds-feedback">
                  No matching computers{' '}
                  <Button variant="link" onClick={() => setFilter('')}>
                    Clear search
                  </Button>
                </p>
              )}
          </div>
        )}
      </section>
      {selectedId && computers && !computers.some((computer) => computer.id === selectedId) && (
        <p className="ds-feedback">
          Computer unavailable.{' '}
          <Button
            variant="link"
            onClick={() => {
              window.location.hash = 'computer-list';
            }}
          >
            All computers
          </Button>
        </p>
      )}
      {connecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="ds-dialog-backdrop absolute inset-0 bg-black/50"
            onClick={closeEnrollment}
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="computer-enrollment-title"
            className="ds-dialog-surface ds-computer-enrollment relative bg-bg-surface rounded-lg border border-border shadow-xl w-full max-w-lg mx-4 p-6"
          >
            <h2 id="computer-enrollment-title">Connect a computer</h2>
            {error && <ErrorBanner message={error} />}

            {!enrollment && (
              <form className="space-y-4 max-w-lg mt-4" onSubmit={createEnrollment}>
                <label className="flex items-center justify-between gap-3">
                  Platform
                  <Select
                    value={enrollmentPlatform}
                    onChange={(event) =>
                      setEnrollmentPlatform(event.target.value as 'darwin' | 'linux')
                    }
                  >
                    <option value="darwin">macOS</option>
                    <option value="linux">Linux</option>
                  </Select>
                </label>
                <TextField
                  label="Computer name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
                <div className="flex gap-3">
                  <Button variant="link" onClick={() => setEnrollmentRoles(desktopRoles)}>
                    Desktop roles
                  </Button>
                  <Button
                    variant="link"
                    onClick={() =>
                      setEnrollmentRoles({
                        deploy: true,
                        tasks: false,
                        computer: false,
                        browser: false,
                      })
                    }
                  >
                    Server roles
                  </Button>
                </div>
                <fieldset className="space-y-2">
                  <legend>What is this computer for?</legend>
                  {roles.map((role) => (
                    <div className="flex items-center justify-between gap-3" key={role}>
                      {labels[role]}
                      <Toggle
                        checkbox
                        label={labels[role]}
                        enabled={enrollmentRoles[role] === true}
                        onChange={() =>
                          setEnrollmentRoles((value) => ({ ...value, [role]: !value[role] }))
                        }
                      />
                    </div>
                  ))}
                </fieldset>
                <Button variant="primary" type="submit" disabled={!!busy || !name.trim()}>
                  Create enrollment
                </Button>
              </form>
            )}
            {enrollment && (
              <div className="mt-4 space-y-3">
                <p>
                  Enrollment for {enrollment.name} · Expires{' '}
                  {new Date(enrollment.expiresAt).toLocaleTimeString()}
                </p>
                <p>Run on that computer, then enter the enrollment code when prompted.</p>
                {[enrollment.command, enrollment.code].map((value) => (
                  <div className="flex flex-wrap gap-3" key={value}>
                    <code className="break-all">{value}</code>
                    <CopyButton
                      label={
                        value === enrollment.command
                          ? 'Copy enrollment command'
                          : 'Copy enrollment code'
                      }
                      text={value}
                    />
                  </div>
                ))}
                <p className="ds-context-hint">
                  Join installs the services your roles need. Provider sign-in, Chromium, and screen
                  permissions are set up locally on that computer.
                </p>
                <Button variant="link" onClick={() => setEnrollment(null)}>
                  Create another enrollment
                </Button>
              </div>
            )}
            <Button variant="link" onClick={closeEnrollment}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={!!revoke}
        title={`Remove ${revoke?.name || 'computer'}?`}
        message={`Removes its ${revoke ? computerCredentials(revoke) : 'credentials'}. Removed credentials stop working. Task history, applications and backups stay.`}
        confirmLabel="Remove computer"
        danger
        requireTypedConfirmation={revoke?.name}
        onCancel={() => setRevoke(null)}
        onConfirm={() => {
          if (!revoke) return;
          const target = revoke;
          setRevoke(null);
          setBusy('remove');
          setError('');
          void removeComputer(target, async (url, method, body) => {
            const response = await fetch(url, {
              method,
              headers: headers(),
              ...(body ? { body: JSON.stringify(body) } : {}),
            });
            if (!response.ok)
              throw new Error((await response.json()).error || 'Unable to remove credential');
          })
            .catch((failure) => setError((failure as Error).message))
            .finally(async () => {
              await load();
              setBusy('');
            });
        }}
      />
    </div>
  );
}
