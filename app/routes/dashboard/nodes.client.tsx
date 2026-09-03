'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { LoadingState, ErrorBanner } from '../../components/LoadingState';
import { CopyIcon } from '../../components/dashboard/icons';
import { formatBytes } from '../../utils';
import { getAuth } from './detail/shared';

interface FleetNode {
  id: string;
  name: string;
  kind: 'coordinator' | 'agent';
  platform: string | null;
  architecture: string | null;
  agentVersion: string | null;
  address: string | null;
  capabilities: string | null;
  enrolledAt: string;
  lastSeenAt: number | null;
  revokedAt: string | null;
  online: boolean;
  apps: NodeRuntimeApp[];
  jobs?: NodeAgentJob[];
}

interface NodeRuntimeApp {
  id: string;
  name: string;
  containerName: string;
  status: string;
  detail: string;
}

interface NodeAgentJob {
  id: string;
  type: string;
  deploymentName: string;
  status: string;
  createdAt: number;
  claimedAt: number | null;
  completedAt: number | null;
  error: string | null;
  activity: {
    stage: string;
    processedBytes: number;
    totalBytes: number;
    updatedAt: number;
    logs: Array<{ timestamp: number; message: string }>;
  } | null;
}

interface FleetState {
  ready: boolean;
  defaultNodeId: string | null;
  nodes: FleetNode[];
}

interface NodeEnrollment {
  name: string;
  code: string;
  expiresAt: number;
}

function nodeCapabilities(node: FleetNode): {
  cpuCount?: number;
  memoryBytes?: number;
  docker?: boolean;
  dockerVersion?: string | null;
  dockerError?: string | null;
} {
  try {
    return JSON.parse(node.capabilities || '{}');
  } catch {
    return {};
  }
}

function authHeaders(): Record<string, string> {
  const auth = getAuth();
  return auth
    ? {
        'x-deploy-username': auth.username,
        'x-deploy-token': auth.token,
      }
    : {};
}

function relativeSeen(timestamp: number | null) {
  if (!timestamp) return 'Never';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 15) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

export default function NodesClient() {
  const [fleet, setFleet] = useState<FleetState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingDefault, setSavingDefault] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<FleetNode | null>(null);
  const [enrollmentName, setEnrollmentName] = useState('');
  const [enrollment, setEnrollment] = useState<NodeEnrollment | null>(null);
  const [creatingEnrollment, setCreatingEnrollment] = useState(false);
  const [copied, setCopied] = useState<'command' | 'linux-command' | 'code' | ''>('');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/nodes', { headers: authHeaders() });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load nodes');
      setFleet(body);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 2_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const macJoinCommand = 'deploy agent join https://deploy.local';
  const linuxJoinCommand = 'sudo deploy agent join https://deploy.local';
  const activeNodes = useMemo(() => fleet?.nodes.filter((node) => !node.revokedAt) || [], [fleet]);

  async function createEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = enrollmentName.trim();
    if (!name) return;
    setCreatingEnrollment(true);
    setEnrollment(null);
    setError('');
    try {
      const response = await fetch('/api/nodes/enrollment', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to create enrollment');
      setEnrollment(body);
      setEnrollmentName('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreatingEnrollment(false);
    }
  }

  async function copyEnrollment(value: string, kind: 'command' | 'linux-command' | 'code') {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(''), 1600);
  }

  async function setDefault(nodeId: string) {
    setSavingDefault(nodeId);
    setError('');
    try {
      const response = await fetch('/api/nodes/default', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to set default node');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingDefault('');
    }
  }

  async function revokeNode() {
    if (!revokeTarget) return;
    const target = revokeTarget;
    setRevokeTarget(null);
    setError('');
    try {
      const response = await fetch(`/api/nodes/${encodeURIComponent(target.id)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to revoke node');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (loading) return <LoadingState />;

  return (
    <div>
      <header className="page-heading">
        <div>
          <p className="eyebrow mb-2">Execution fleet</p>
          <h1 className="page-title">Machines</h1>
          <p className="page-description">
            Compute connected to the Home control plane. Applications remain pinned until you move
            them deliberately.
          </p>
        </div>
        <span className="rounded-[7px] border border-border bg-bg-surface px-3 py-2 font-mono text-[10px] uppercase tracking-[0.06em] text-text-tertiary">
          <span className="text-success">{activeNodes.filter((node) => node.online).length}</span> /{' '}
          {activeNodes.length} online
        </span>
      </header>

      {error && <ErrorBanner message={error} />}

      {fleet && !fleet.ready && (
        <section className="card-hero p-5 mb-6 border-warning/35">
          <div className="flex items-start gap-4">
            <div className="mt-1 h-3 w-3 rounded-full bg-warning shadow-[0_0_18px_var(--color-warning)]" />
            <div>
              <p className="text-sm font-semibold">Choose where new applications begin</p>
              <p className="text-sm text-text-secondary mt-1 max-w-2xl">
                Your first deploy will wait until a default node is selected. Existing applications
                stay pinned when this setting changes.
              </p>
            </div>
          </div>
        </section>
      )}

      <section className="card topology-seam overflow-hidden pl-px">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <p className="eyebrow">Execution fleet</p>
            <p className="text-xs text-text-tertiary mt-1">
              Connectivity refreshes every ten seconds.
            </p>
          </div>
          <div className="h-px flex-1 mx-6 bg-gradient-to-r from-border via-accent/40 to-border hidden sm:block" />
        </div>

        <div className="divide-y divide-border">
          {activeNodes.map((node) => {
            const capabilities = nodeCapabilities(node);
            const isDefault = fleet?.defaultNodeId === node.id;
            const runtimeApps = node.apps || [];
            const jobs = node.jobs || [];
            const activeJob =
              jobs.find((job) => job.status === 'running') ||
              jobs.find((job) => job.status === 'queued');
            const recentJobs = jobs.filter((job) => job !== activeJob).slice(0, 3);
            return (
              <article key={node.id} className="relative px-5 py-5">
                <div
                  className={`absolute left-0 top-0 bottom-0 w-0.5 ${
                    node.online ? 'bg-success' : 'bg-text-tertiary/30'
                  }`}
                  aria-hidden
                />
                <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                  <div className="flex items-start gap-3 min-w-0 lg:w-64">
                    <span
                      className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                        node.online
                          ? 'bg-success shadow-[0_0_12px_var(--color-success)]'
                          : 'bg-text-tertiary/40'
                      }`}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="text-sm font-semibold truncate">{node.name}</h2>
                        {isDefault && (
                          <span className="rounded-full bg-accent/12 text-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                            Default
                          </span>
                        )}
                        {node.kind === 'coordinator' && (
                          <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-text-tertiary uppercase tracking-wide">
                            Control plane
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-text-tertiary mt-1 font-mono">
                        {node.online ? 'Online' : `Last seen ${relativeSeen(node.lastSeenAt)}`}
                      </p>
                      {node.kind === 'agent' && node.agentVersion && (
                        <p className="text-[10px] text-text-tertiary mt-1 font-mono truncate">
                          Agent {node.agentVersion}
                        </p>
                      )}
                    </div>
                  </div>

                  <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 flex-1">
                    <div>
                      <dt className="eyebrow">System</dt>
                      <dd className="text-xs mt-1 font-mono">
                        {node.platform || 'unknown'} · {node.architecture || 'unknown'}
                      </dd>
                    </div>
                    <div>
                      <dt className="eyebrow">CPU</dt>
                      <dd className="text-xs mt-1 font-mono">
                        {capabilities.cpuCount ? `${capabilities.cpuCount} cores` : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="eyebrow">Memory</dt>
                      <dd className="text-xs mt-1 font-mono">
                        {capabilities.memoryBytes ? formatBytes(capabilities.memoryBytes) : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="eyebrow">Docker</dt>
                      <dd
                        className={`text-xs mt-1 font-mono ${
                          capabilities.docker === false ? 'text-danger' : ''
                        }`}
                      >
                        {capabilities.dockerVersion ||
                          (capabilities.docker === false ? 'Unavailable to agent' : 'Available')}
                      </dd>
                      {capabilities.docker === false && (
                        <p className="text-[10px] text-text-tertiary mt-1 max-w-48">
                          {node.online
                            ? capabilities.dockerError ||
                              'Start Docker and check agent permissions.'
                            : 'Agent is offline; reconnect it to refresh this capability.'}
                        </p>
                      )}
                    </div>
                  </dl>

                  <div className="flex items-center gap-2 lg:justify-end">
                    {!isDefault && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setDefault(node.id)}
                        disabled={savingDefault === node.id || !node.online}
                      >
                        {savingDefault === node.id ? 'Saving…' : 'Make default'}
                      </button>
                    )}
                    {node.kind !== 'coordinator' && (
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => setRevokeTarget(node)}
                      >
                        Revoke access
                      </button>
                    )}
                  </div>
                </div>

                {node.kind === 'agent' && (
                  <div className="mt-4 pt-4 border-t border-border/70">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <p className="eyebrow">Agent activity</p>
                      <span className="text-[10px] font-mono text-text-tertiary">
                        Refreshes every 2s
                      </span>
                    </div>
                    {activeJob ? (
                      <div className="rounded-md border border-warning/25 bg-warning/5 px-3 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="h-2 w-2 rounded-full bg-warning animate-pulse motion-reduce:animate-none" />
                            <span className="text-xs font-medium truncate">
                              {activeJob.type} · {activeJob.deploymentName}
                            </span>
                          </div>
                          <span className="text-[10px] font-mono text-warning">
                            {activeJob.activity?.stage || activeJob.status}
                          </span>
                        </div>
                        {activeJob.activity &&
                          activeJob.activity.totalBytes > 0 &&
                          activeJob.activity.processedBytes >= 0 && (
                            <>
                              <p className="text-[10px] font-mono text-text-tertiary mt-2">
                                {formatBytes(activeJob.activity.processedBytes)} of{' '}
                                {formatBytes(activeJob.activity.totalBytes)}
                              </p>
                              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg-active">
                                <div
                                  className="h-full rounded-full bg-warning transition-[width] duration-300"
                                  style={{
                                    width: `${Math.min(
                                      100,
                                      (activeJob.activity.processedBytes /
                                        activeJob.activity.totalBytes) *
                                        100,
                                    )}%`,
                                  }}
                                />
                              </div>
                            </>
                          )}
                        {activeJob.activity?.logs.length ? (
                          <div className="mt-3 space-y-1 font-mono text-[10px] text-text-tertiary">
                            {activeJob.activity.logs.slice(-4).map((entry) => (
                              <p key={`${entry.timestamp}-${entry.message}`} className="truncate">
                                {new Date(entry.timestamp).toLocaleTimeString()} · {entry.message}
                              </p>
                            ))}
                          </div>
                        ) : null}
                        <a
                          href={`/dashboard/${encodeURIComponent(activeJob.deploymentName)}/build`}
                          className="inline-block mt-3 text-[10px] text-accent hover:underline"
                        >
                          View application build
                        </a>
                      </div>
                    ) : (
                      <p className="text-xs text-text-tertiary">Agent is idle.</p>
                    )}
                    {recentJobs.length > 0 && (
                      <details className="mt-2">
                        <summary className="text-[10px] text-text-tertiary cursor-pointer">
                          Recent agent jobs
                        </summary>
                        <div className="mt-2 space-y-1">
                          {recentJobs.map((job) => (
                            <div key={job.id} className="text-[10px] font-mono">
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-text-tertiary">
                                  {job.type} · {job.deploymentName}
                                </span>
                                <span
                                  className={
                                    job.status === 'failed' ? 'text-danger' : 'text-success'
                                  }
                                >
                                  {job.status}
                                </span>
                              </div>
                              {job.error && (
                                <p className="mt-1 text-danger break-words">{job.error}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}

                <div className="mt-4 pt-4 border-t border-border/70">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <p className="eyebrow">Runtime applications</p>
                    <span className="text-[10px] font-mono text-text-tertiary">
                      {runtimeApps.length} container{runtimeApps.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  {runtimeApps.length === 0 ? (
                    <p className="text-xs text-text-tertiary">
                      {node.kind === 'agent' && node.online
                        ? 'No deploy.local containers reported. Update the agent if this looks stale.'
                        : 'No deploy.local containers found.'}
                    </p>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      {runtimeApps.map((app) => {
                        const retainedRelease = /-prev-\d+$/.test(app.containerName);
                        return (
                          <div
                            key={app.id || app.containerName}
                            className="rounded-md border border-border bg-bg/60 px-3 py-2"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={`h-2 w-2 shrink-0 rounded-full ${
                                  app.status === 'running'
                                    ? 'bg-success'
                                    : app.status === 'restarting'
                                      ? 'bg-warning animate-pulse motion-reduce:animate-none'
                                      : 'bg-text-tertiary/50'
                                }`}
                              />
                              <span className="text-xs font-medium truncate">{app.name}</span>
                              {retainedRelease && (
                                <span className="text-[9px] uppercase tracking-wide text-text-tertiary">
                                  retained
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-[10px] font-mono text-text-tertiary truncate">
                              {app.status} · {app.detail}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-dashed border-border-hover bg-bg-surface/40 p-5">
        <p className="eyebrow">Add another machine</p>
        <p className="text-sm text-text-secondary mt-2">
          Name the machine to create a one-use enrollment code. It expires after ten minutes.
        </p>

        <form className="mt-4 flex flex-col sm:flex-row gap-2 max-w-lg" onSubmit={createEnrollment}>
          <input
            className="input flex-1"
            value={enrollmentName}
            onChange={(event) => setEnrollmentName(event.target.value)}
            placeholder="e.g. Living Room iMac"
            aria-label="Node name"
            disabled={creatingEnrollment}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!enrollmentName.trim() || creatingEnrollment}
          >
            {creatingEnrollment ? 'Creating…' : 'Create enrollment'}
          </button>
        </form>

        {enrollment && (
          <div className="mt-5 max-w-2xl rounded-lg border border-accent/30 bg-accent/5 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold">Enrollment ready for {enrollment.name}</p>
                <p className="text-xs text-text-secondary mt-1">
                  On that machine, run the command and paste the code when prompted. Administrator
                  On macOS, run it from the normal desktop login so the agent can access Docker
                  Desktop and mounted storage. Linux installs a system service with sudo.
                </p>
              </div>
              <span className="text-[10px] font-mono uppercase tracking-wide text-warning shrink-0">
                Expires {new Date(enrollment.expiresAt).toLocaleTimeString()}
              </span>
            </div>

            <div className="mt-4 space-y-2">
              {[
                {
                  value: macJoinCommand,
                  kind: 'command' as const,
                  label: 'macOS join command',
                },
                {
                  value: linuxJoinCommand,
                  kind: 'linux-command' as const,
                  label: 'Linux join command',
                },
                { value: enrollment.code, kind: 'code' as const, label: 'enrollment code' },
              ].map((item) => (
                <div
                  key={item.kind}
                  className="flex items-center gap-2 rounded-md border border-border bg-bg px-3 py-2.5"
                >
                  <code className="font-mono text-xs text-text flex-1 overflow-x-auto">
                    {item.value}
                  </code>
                  <button
                    type="button"
                    className="text-text-tertiary hover:text-text transition-colors"
                    aria-label={`Copy ${item.label}`}
                    onClick={() => copyEnrollment(item.value, item.kind)}
                  >
                    <CopyIcon className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            {copied && (
              <p className="text-xs text-success mt-2">
                Copied{' '}
                {copied === 'command'
                  ? 'macOS join command'
                  : copied === 'linux-command'
                    ? 'Linux join command'
                    : 'enrollment code'}
                .
              </p>
            )}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title={`Revoke ${revokeTarget?.name || 'node'}?`}
        message="The agent will disconnect immediately and cannot reconnect with its current credential. Applications and backups are not deleted."
        confirmLabel="Revoke access"
        danger
        requireTypedConfirmation={revokeTarget?.name}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={revokeNode}
      />
    </div>
  );
}
