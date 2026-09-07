'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'react-flight-router/client';
import {
  updateDeploymentSettings as serverUpdateSettings,
  applyMemoryLimit as serverApplyMemoryLimit,
} from '../../../actions/deployments';
import { getAuth, useDetailContext } from './shared';
import type { DetailContext } from './shared';
import { Toggle } from '../../../components/Toggle';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { ErrorBanner } from '../../../components/LoadingState';

// ── Shared helpers ──────────────────────────────────────────────────────────

function parseVolumeMounts(deployment: {
  volumes: string | null;
}): Array<{ hostPath: string; containerPath: string; readOnly: boolean }> {
  if (!deployment.volumes) return [];
  try {
    const arr = JSON.parse(deployment.volumes) as Array<{
      hostPath: string;
      containerPath: string;
      readOnly?: boolean;
    }>;
    return arr.map((v) => ({ ...v, readOnly: v.readOnly ?? false }));
  } catch {
    return [];
  }
}

type SettingsPatch = {
  envVars?: Record<string, string>;
  memoryLimit?: string;
  cpuLimit?: string;
  volumes?: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
  extraPorts?: Array<{ container: number; protocol?: string }>;
  gpuEnabled?: boolean;
  privilegedDocker?: boolean;
};

type PendingChange = {
  label: string;
  summary: string;
  patch: SettingsPatch;
  error?: string;
};

type ReportPending = (id: string, change: PendingChange | null) => void;

interface PlacementNode {
  id: string;
  name: string;
  online: boolean;
  revokedAt: string | null;
}

function PlacementEditor({
  deployment,
  onSaved,
}: {
  deployment: DetailContext['deployment'];
  onSaved: () => void;
}) {
  const [nodes, setNodes] = useState<PlacementNode[]>([]);
  const [selected, setSelected] = useState(deployment.desiredNodeId || '');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [moving, setMoving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const auth = getAuth();
    if (!auth) return;
    fetch('/api/nodes', {
      headers: {
        'x-deploy-username': auth.username,
        'x-deploy-token': auth.token,
      },
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to load nodes');
        setNodes(body.nodes.filter((node: PlacementNode) => !node.revokedAt));
        setSelected((current) => current || deployment.desiredNodeId || body.defaultNodeId || '');
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [deployment.desiredNodeId]);

  async function savePlacement() {
    const auth = getAuth();
    if (!auth || !selected) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/deployments/${encodeURIComponent(deployment.name)}/node`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
        body: JSON.stringify({ nodeId: selected }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to save deployment node');
      setMessage(body.message);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function moveNow() {
    const auth = getAuth();
    if (!auth || !selected) return;
    setMoving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/deployments/${encodeURIComponent(deployment.name)}/node`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
        body: JSON.stringify({ nodeId: selected }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to start application move');
      setMessage(`${body.message}. Follow its progress above or in Build.`);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMoving(false);
    }
  }

  const activeNodeId = deployment.activeNodeId || 'coordinator';
  const activeNode = nodes.find((node) => node.id === activeNodeId);
  const selectedNode = nodes.find((node) => node.id === selected);
  const movingOnNextDeploy = Boolean(selected) && selected !== activeNodeId;

  return (
    <div className="card p-4">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="flex-1 max-w-md">
          <p className="text-sm font-semibold mb-1">Deployment node</p>
          <p className="text-xs text-text-secondary mb-3">
            Future deploys stay pinned to this machine. Application traffic continues through the
            main deploy.local host.
          </p>
          <select
            className="input w-full"
            value={selected}
            disabled={loading || saving || moving}
            onChange={(event) => {
              setSelected(event.target.value);
              setMessage('');
            }}
          >
            <option value="" disabled>
              {loading ? 'Loading nodes…' : 'Choose a node'}
            </option>
            {nodes.map((node) => (
              <option key={node.id} value={node.id} disabled={!node.online}>
                {node.name} — {node.online ? 'online' : 'offline'}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-text-tertiary mt-2 font-mono">
            Running on {activeNode?.name || 'coordinator'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {movingOnNextDeploy && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={!selected || moving || saving}
              onClick={moveNow}
            >
              {moving ? 'Starting move…' : 'Move now'}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!selected || selected === deployment.desiredNodeId || saving || moving}
            onClick={savePlacement}
          >
            {saving ? 'Saving…' : 'Save node'}
          </button>
        </div>
      </div>
      {movingOnNextDeploy && selectedNode && (
        <p className="mt-3 rounded-md border border-warning/25 bg-warning/8 px-3 py-2 text-xs text-warning">
          The next deploy will build on {selectedNode.name} and switch traffic after it becomes
          healthy. Move now performs the same migration using the most recently retained source
          artifact.
        </p>
      )}
      {message && <p className="text-xs text-success mt-3">{message}</p>}
      {error && <p className="text-xs text-danger mt-3">{error}</p>}
    </div>
  );
}

// ── Volume mounts ───────────────────────────────────────────────────────────

function VolumeMountEditor({
  deployment,
  reportPending,
}: {
  deployment: DetailContext['deployment'];
  reportPending: ReportPending;
}) {
  const [rows, setRows] = useState<
    Array<{ hostPath: string; containerPath: string; readOnly: boolean }>
  >(parseVolumeMounts(deployment));
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setRows(parseVolumeMounts(deployment));
    setDirty(false);
    setErr('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployment.volumes]);

  function updateRow(
    index: number,
    field: 'hostPath' | 'containerPath' | 'readOnly',
    val: string | boolean,
  ) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: val } : r)));
    setDirty(true);
  }
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  }
  function addRow() {
    setRows((prev) => [...prev, { hostPath: '', containerPath: '', readOnly: false }]);
    setDirty(true);
  }

  useEffect(() => {
    const volumes = rows.filter((r) => r.hostPath.trim() || r.containerPath.trim());
    let validationError = '';
    for (let i = 0; i < volumes.length; i++) {
      const v = volumes[i];
      if (!v.hostPath.startsWith('/')) {
        validationError = `Volume ${i + 1}: host path must be absolute`;
        break;
      }
      if (!v.containerPath.startsWith('/')) {
        validationError = `Volume ${i + 1}: container path must be absolute`;
        break;
      }
      if (v.hostPath.includes('..') || v.containerPath.includes('..')) {
        validationError = `Volume ${i + 1}: paths must not contain ".."`;
        break;
      }
    }
    setErr(validationError);
    reportPending(
      'volumes',
      dirty
        ? {
            label: 'Volume mounts',
            summary: `${volumes.length} custom mount${volumes.length === 1 ? '' : 's'}`,
            patch: { volumes },
            error: validationError || undefined,
          }
        : null,
    );
  }, [dirty, reportPending, rows]);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="eyebrow font-semibold">Volume Mounts</h3>
        <div className="flex gap-2">
          <button onClick={addRow} className="btn btn-sm text-xs">
            Add Volume
          </button>
        </div>
      </div>

      <div className="mb-3">
        <p className="text-xs text-text-tertiary mb-1">Managed volumes (always mounted):</p>
        <div className="space-y-1">
          <div className="flex gap-2 text-xs font-mono text-text-tertiary">
            <span>.deploy-data/volumes/{deployment.name}/data</span>
            <span>&rarr;</span>
            <span>/app/data</span>
          </div>
          <div className="flex gap-2 text-xs font-mono text-text-tertiary">
            <span>.deploy-data/volumes/{deployment.name}/uploads</span>
            <span>&rarr;</span>
            <span>/app/uploads</span>
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-text-tertiary">No custom volume mounts configured.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2 items-center">
            <span className="text-xs text-text-tertiary flex-1">Host path (on this machine)</span>
            <span className="text-xs text-text-tertiary w-3" />
            <span className="text-xs text-text-tertiary flex-1">Container path (inside app)</span>
            <span className="w-[75px]" />
            <span className="w-5" />
          </div>
          {rows.map((row, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input
                aria-label={`Volume ${i + 1} host path`}
                type="text"
                value={row.hostPath}
                onChange={(e) => updateRow(i, 'hostPath', e.target.value)}
                placeholder="/path/on/host"
                className="input input-sm font-mono text-xs flex-1"
              />
              <span className="text-text-tertiary text-xs">&rarr;</span>
              <input
                aria-label={`Volume ${i + 1} container path`}
                type="text"
                value={row.containerPath}
                onChange={(e) => updateRow(i, 'containerPath', e.target.value)}
                placeholder="/movies"
                className="input input-sm font-mono text-xs flex-1"
              />
              <label
                className="flex items-center gap-1 text-xs text-text-secondary whitespace-nowrap"
                title="Read-only: container cannot write to this volume"
              >
                <input
                  type="checkbox"
                  checked={row.readOnly}
                  onChange={(e) => updateRow(i, 'readOnly', e.target.checked)}
                  className="w-3 h-3"
                />
                Read-only
              </label>
              <RemoveButton onClick={() => removeRow(i)} ariaLabel={`Remove volume ${i + 1}`} />
            </div>
          ))}
        </div>
      )}

      {err && <p className="text-xs text-danger mt-2">{err}</p>}
      {dirty && (
        <p className="text-xs text-text-tertiary mt-2">
          Pending review. Applying volume changes recreates the container.
        </p>
      )}
    </div>
  );
}

function RemoveButton({ onClick, ariaLabel }: { onClick: () => void; ariaLabel: string }) {
  return (
    <button
      onClick={onClick}
      className="text-text-tertiary hover:text-danger p-1 rounded hover:bg-danger/10"
      aria-label={ariaLabel}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  );
}

// ── Danger zone (delete) ────────────────────────────────────────────────────

function DangerZone({ deployment }: { deployment: DetailContext['deployment'] }) {
  const { navigate } = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState('');

  async function handleDelete() {
    const auth = getAuth();
    if (!auth) return;
    setDeleting(true);
    setErr('');
    try {
      const response = await fetch(`/api/deployments/${encodeURIComponent(deployment.name)}`, {
        method: 'DELETE',
        headers: {
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Unable to delete application');
      navigate('/dashboard/apps');
    } catch (e) {
      setErr((e as Error).message);
      setDeleting(false);
      setConfirming(false);
    }
  }

  return (
    <div className="card p-4 border-danger/30">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex-1">
          <p className="text-sm font-semibold mb-1 text-danger">Delete this app</p>
          <p className="text-xs text-text-secondary">
            Removes the application graph, its runtime components, and its declared managed
            resources. Selected suitcases must sync and acknowledge before deletion can proceed.
          </p>
        </div>
        <button
          onClick={() => {
            setConfirming(true);
          }}
          disabled={deleting}
          className="btn btn-danger btn-sm text-xs whitespace-nowrap"
        >
          {deleting ? 'Deleting…' : 'Delete App'}
        </button>
      </div>

      {err && (
        <div className="mt-3 rounded border border-danger/30 bg-danger/5 p-3" role="alert">
          <p className="eyebrow font-semibold text-danger mb-1">Fleet safety hold</p>
          <p className="text-xs leading-relaxed text-text-secondary whitespace-pre-line">{err}</p>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title={`Delete ${deployment.name}?`}
        message={
          `This removes the ${deployment.name} application graph, stops every component, and permanently deletes its managed volume resources. Runtime bind-mounted host data is not deleted. This cannot be undone.`
        }
        confirmLabel="Delete application and resources"
        danger
        requireTypedConfirmation={deployment.name}
        onConfirm={() => {
          setConfirming(false);
          handleDelete();
        }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

// ── Page component ──────────────────────────────────────────────────────────

export default function Component() {
  const { deployment, fetchDeployment, fetchInspect } = useDetailContext();
  const { navigate } = useRouter();
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState<Record<string, PendingChange>>({});
  const [reviewing, setReviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [blockedHref, setBlockedHref] = useState<string | null>(null);

  const reportPending = useCallback<ReportPending>((id, change) => {
    setPending((current) => {
      if (!change) {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      }
      return { ...current, [id]: change };
    });
  }, []);

  const pendingChanges = Object.values(pending);
  const hasPending = pendingChanges.length > 0;
  const hasValidationErrors = pendingChanges.some((change) => change.error);

  useEffect(() => {
    if (!hasPending) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasPending]);

  useEffect(() => {
    if (!hasPending) return;
    const blockInternalNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
      const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href]');
      if (!link || link.target === '_blank') return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname)
        return;
      event.preventDefault();
      event.stopPropagation();
      setBlockedHref(`${url.pathname}${url.search}${url.hash}`);
    };
    document.addEventListener('click', blockInternalNavigation, true);
    return () => document.removeEventListener('click', blockInternalNavigation, true);
  }, [hasPending]);

  async function applyPendingChanges() {
    const auth = getAuth();
    if (!auth || hasValidationErrors) return;
    setApplying(true);
    setActionError('');
    try {
      const patch = pendingChanges.reduce<SettingsPatch>(
        (merged, change) => ({ ...merged, ...change.patch }),
        {},
      );
      const updateResponse = await fetch(`/api/deployments/${encodeURIComponent(deployment.name)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
        body: JSON.stringify(patch),
      });
      const updateBody = (await updateResponse.json()) as { error?: string };
      if (!updateResponse.ok) {
        throw new Error(updateBody.error || 'Unable to save runtime settings');
      }
      if (patch.volumes !== undefined) {
        const recreateResponse = await fetch(
          `/api/deployments/${encodeURIComponent(deployment.name)}/recreate`,
          {
            method: 'POST',
            headers: {
              'x-deploy-username': auth.username,
              'x-deploy-token': auth.token,
            },
          },
        );
        const recreateBody = (await recreateResponse.json()) as { error?: string };
        if (!recreateResponse.ok) {
          throw new Error(recreateBody.error || 'Runtime settings saved, but recreate failed');
        }
      }
      const updateAlreadyRecreates =
        patch.envVars !== undefined ||
        patch.volumes !== undefined ||
        patch.extraPorts !== undefined ||
        patch.gpuEnabled !== undefined ||
        patch.privilegedDocker !== undefined;
      if (
        !updateAlreadyRecreates &&
        (patch.memoryLimit !== undefined || patch.cpuLimit !== undefined)
      ) {
        await serverApplyMemoryLimit(auth.username, auth.token, deployment.name);
      }
      setPending({});
      setReviewing(false);
      fetchDeployment();
      fetchInspect();
    } catch (e) {
      setActionError((e as Error).message);
      setReviewing(false);
    } finally {
      setApplying(false);
    }
  }

  async function handleToggleAutoBackup() {
    const auth = getAuth();
    if (!auth) return;
    setActionError('');
    try {
      await serverUpdateSettings(auth.username, auth.token, deployment.name, {
        autoBackup: !deployment.autoBackup,
      });
      fetchDeployment();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }
  return (
    <div className="space-y-4 sm:space-y-6">
      {actionError && <ErrorBanner message={actionError} />}

      <div className="card p-4">
        <p className="text-sm font-semibold mb-1">Runtime settings</p>
        <p className="text-xs leading-relaxed text-text-secondary">
          Component topology, environment variables, ports, and managed resources belong to{' '}
          <code className="font-mono">deploy.yaml</code>. These controls configure where the
          application runs and which host directories are attached at runtime.
        </p>
      </div>

      <PlacementEditor deployment={deployment} onSaved={fetchDeployment} />
      <VolumeMountEditor deployment={deployment} reportPending={reportPending} />

      <div className="card p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex-1">
            <p className="text-sm font-semibold mb-1">Managed volume backups</p>
            <p className="text-xs text-text-secondary">
              Back up before each deploy and during the coordinator&apos;s scheduled fleet backup.
            </p>
          </div>
          <Toggle
            enabled={!!deployment.autoBackup}
            onChange={handleToggleAutoBackup}
            label="Auto-Backup"
          />
        </div>
      </div>

      {hasPending && (
        <div className="sticky bottom-4 z-30 rounded-xl border border-accent/30 bg-bg-surface/95 p-3 shadow-xl backdrop-blur-md sm:p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold">
                {pendingChanges.length} pending {pendingChanges.length === 1 ? 'change' : 'changes'}
              </p>
              <p className="text-xs text-text-secondary">
                Review once, then recreate the container once. Expect a brief interruption.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setReviewing(true)}
              disabled={hasValidationErrors || applying}
              className="btn btn-primary btn-sm whitespace-nowrap"
            >
              {hasValidationErrors ? 'Fix errors to continue' : 'Review & apply'}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={reviewing}
        title={`Apply ${pendingChanges.length} ${pendingChanges.length === 1 ? 'change' : 'changes'}?`}
        message="deploy.local will save these settings and recreate the running container once. The app may be briefly unavailable."
        confirmLabel={applying ? 'Applying…' : 'Apply & recreate'}
        onConfirm={applyPendingChanges}
        onCancel={() => !applying && setReviewing(false)}
      >
        <ul className="space-y-2" aria-label="Pending settings changes">
          {pendingChanges.map((change) => (
            <li key={change.label} className="rounded-md bg-bg px-3 py-2 text-xs">
              <span className="font-medium text-text">{change.label}</span>
              <span className="ml-2 text-text-tertiary">{change.summary}</span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>

      <ConfirmDialog
        open={blockedHref !== null}
        title="Discard pending settings?"
        message="You have unapplied settings changes. Leaving this page will discard them."
        confirmLabel="Discard & leave"
        danger
        onConfirm={() => {
          const href = blockedHref;
          setBlockedHref(null);
          setPending({});
          if (href) navigate(href);
        }}
        onCancel={() => setBlockedHref(null)}
      />

      <DangerZone deployment={deployment} />
    </div>
  );
}
