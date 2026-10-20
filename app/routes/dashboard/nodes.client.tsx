'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, StatusBadge, TextField, Toggle } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorBanner, LoadingState } from '../../components/LoadingState';
import { getAuth } from './detail/shared';
import { NodePermissions } from './node-permissions.client';
import type { NodePermission } from './node-permissions';
import type { Computer, ComputerRoleId, WantedRoles } from '../../../server/computer-roles';

const roles: ComputerRoleId[] = ['deploy', 'tasks', 'computer', 'browser'];
const labels = {
  coordinator: 'Coordinator',
  deploy: 'Deploy apps',
  tasks: 'Coding tasks',
  computer: 'Screen access',
  browser: 'Task browser',
};
const states = { ready: 'Ready', 'needs-setup': 'Needs setup', paused: 'Paused', off: 'Off' };
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
  const [enrollment, setEnrollment] = useState<{
    name: string;
    code: string;
    expiresAt: number;
  } | null>(null);
  const [revoke, setRevoke] = useState<{ id: string; name: string; node: boolean } | null>(null);
  const [copied, setCopied] = useState('');
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
      setEnrollment(result);
      setName('');
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
    } catch {
      setError('Unable to copy. Select the text to copy it.');
    }
  }
  return (
    <div className="ds-computers">
      {error && <ErrorBanner message={error} />}
      <section id="computer-list" aria-label="Computers">
        <header className="ds-pane-toolbar">
          <strong>Computers</strong>
          <TextField
            label="Find a computer"
            appearance="plain"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a computer"
          />
          <a
            className="underline underline-offset-4 text-text-secondary"
            href="#computer-enrollment"
          >
            Connect a computer
          </a>
        </header>
        {computers === null ? (
          <LoadingState />
        ) : (
          <div className="ds-task-worker-list">
            {computers
              .filter((computer) =>
                `${computer.name} ${computer.platform}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              )
              .map((computer) => {
                const node = nodes.find((item) => item.id === computer.nodeId);
                return (
                  <details className="ds-task-worker" key={computer.id}>
                    <summary className="ds-task-worker-row flex-wrap">
                      <div>
                        <strong>{computer.name}</strong>
                        <p className="ds-context-hint">
                          {computer.platform} · {computer.online ? 'Online' : 'Offline'}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(computer.roles).map(([id, role]) => (
                          <StatusBadge
                            key={id}
                            tone={
                              role.state === 'ready'
                                ? 'healthy'
                                : role.state === 'needs-setup'
                                  ? 'attention'
                                  : 'inactive'
                            }
                            label={`${labels[id as keyof typeof labels]} · ${states[role.state]}`}
                          />
                        ))}
                      </div>
                    </summary>
                    <ul className="ds-permissions" aria-label={`Roles on ${computer.name}`}>
                      {Object.entries(computer.roles).map(([id, role]) => (
                        <li className="ds-permission" key={id}>
                          <div className="ds-permission-head">
                            <strong>{labels[id as keyof typeof labels]}</strong>
                            <StatusBadge
                              tone={
                                role.state === 'ready'
                                  ? 'healthy'
                                  : role.state === 'needs-setup'
                                    ? 'attention'
                                    : 'inactive'
                              }
                              label={states[role.state]}
                            />
                            {id !== 'coordinator' && (
                              <Toggle
                                label={`${labels[id as ComputerRoleId]} on ${computer.name}`}
                                enabled={role.state !== 'off'}
                                disabled={!!busy}
                                onChange={() =>
                                  void mutate(
                                    `/api/computers/${encodeURIComponent(computer.id)}/roles`,
                                    'PATCH',
                                    { [id]: role.state === 'off' },
                                  )
                                }
                              />
                            )}
                          </div>
                          <p className="ds-permission-summary">{role.reason}</p>
                          {role.fix && (
                            <div className="ds-permission-step">
                              <span>On {computer.name}</span>
                              <code>{role.fix}</code>
                              <Button variant="link" onClick={() => void copy(role.fix!)}>
                                {copied === role.fix ? 'Copied' : 'Copy'}
                              </Button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                    {computer.workerIds.map((id) => {
                      const worker = workers.find((item) => item.id === id);
                      return worker?.permissions ? (
                        <details key={id} className="px-4 py-2">
                          <summary>Permissions · {worker.name}</summary>
                          <NodePermissions
                            computer={computer.name}
                            permissions={worker.permissions}
                            onRevoke={() => setRevoke({ id, name: worker.name, node: false })}
                          />
                        </details>
                      ) : null;
                    })}
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
                          {node.kind !== 'coordinator' && (
                            <Button
                              variant="link"
                              onClick={() =>
                                setRevoke({ id: node.id, name: node.name, node: true })
                              }
                            >
                              Revoke execution agent
                            </Button>
                          )}
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
                  </details>
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
      <section id="computer-enrollment" className="ds-enrollment" aria-label="Connect a computer">
        <h2>Connect a computer</h2>
        <form className="space-y-4 max-w-lg mt-4" onSubmit={createEnrollment}>
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
                setEnrollmentRoles({ deploy: true, tasks: false, computer: false, browser: false })
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
        {enrollment && (
          <div className="mt-4 space-y-3">
            <p>
              Enrollment for {enrollment.name} · Expires{' '}
              {new Date(enrollment.expiresAt).toLocaleTimeString()}
            </p>
            <p>Run on that computer, or enter the code in deploy.local Node setup.</p>
            {[
              'deploy agent join https://deploy.local',
              'sudo deploy agent join https://deploy.local',
              enrollment.code,
            ].map((value) => (
              <div className="flex flex-wrap gap-3" key={value}>
                <code>{value}</code>
                <Button variant="link" onClick={() => void copy(value)}>
                  {copied === value ? 'Copied' : 'Copy'}
                </Button>
              </div>
            ))}
            <p className="ds-context-hint">
              Use sudo on Linux. Run as the desktop user on macOS. Coding tasks and screen access
              need the Node app or a task worker as well.
            </p>
          </div>
        )}
      </section>
      <ConfirmDialog
        open={!!revoke}
        title={`Revoke ${revoke?.name || 'computer'}?`}
        message="Its credential will stop working. Task history, applications and backups stay."
        confirmLabel="Revoke access"
        danger
        requireTypedConfirmation={revoke?.name}
        onCancel={() => setRevoke(null)}
        onConfirm={() => {
          if (!revoke) return;
          const target = revoke;
          setRevoke(null);
          void mutate(
            target.node
              ? `/api/nodes/${encodeURIComponent(target.id)}`
              : `/api/workspace/computers/${encodeURIComponent(target.id)}/revoke`,
            target.node ? 'DELETE' : 'POST',
            target.node ? undefined : { operationId: crypto.randomUUID() },
          );
        }}
      />
    </div>
  );
}
