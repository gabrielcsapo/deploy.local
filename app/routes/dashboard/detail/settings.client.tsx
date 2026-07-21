'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'react-flight-router/client';
import {
  updateDeploymentSettings as serverUpdateSettings,
  applyMemoryLimit as serverApplyMemoryLimit,
  deleteDeployment as serverDeleteDeployment,
} from '../../../actions/deployments';
import { getAuth, parseExtraPorts, useDetailContext } from './shared';
import type { DetailContext } from './shared';
import { Toggle } from '../../../components/Toggle';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { ErrorBanner } from '../../../components/LoadingState';

// ── Shared helpers ──────────────────────────────────────────────────────────

function parseEnvVars(deployment: {
  envVars: string | null;
}): Array<{ key: string; value: string }> {
  if (!deployment.envVars) return [];
  try {
    const obj = JSON.parse(deployment.envVars) as Record<string, string>;
    return Object.entries(obj).map(([key, value]) => ({ key, value }));
  } catch {
    return [];
  }
}

// System env vars injected by the runtime — shown read-only.
const SYSTEM_ENV_PREFIXES = ['PORT=', 'PATH=', 'NODE_VERSION=', 'YARN_', 'HOSTNAME=', 'HOME='];
function isSystemEnv(envStr: string): boolean {
  return SYSTEM_ENV_PREFIXES.some((p) => envStr.startsWith(p));
}

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

// ── Resource limits (memory + CPU) ──────────────────────────────────────────

const MEMORY_PRESETS = ['128m', '256m', '512m', '1g', '2g', '4g', '8g'];
const CPU_PRESETS = ['0.5', '1', '2', '4'];

function ResourceLimitsEditor({
  deployment,
  reportPending,
}: {
  deployment: DetailContext['deployment'];
  reportPending: ReportPending;
}) {
  const initialMem = deployment.memoryLimit || '4g';
  const initialCpu = deployment.cpuLimit || '2';
  const [memoryLimit, setMemoryLimit] = useState(initialMem);
  const [cpuLimit, setCpuLimit] = useState(initialCpu);
  const [err, setErr] = useState('');

  useEffect(() => {
    setMemoryLimit(deployment.memoryLimit || '4g');
    setCpuLimit(deployment.cpuLimit || '2');
  }, [deployment.memoryLimit, deployment.cpuLimit]);

  const dirty = memoryLimit !== initialMem || cpuLimit !== initialCpu;

  useEffect(() => {
    reportPending(
      'resources',
      dirty
        ? {
            label: 'Resource limits',
            summary: `${memoryLimit} memory · ${cpuLimit} CPU`,
            patch: { memoryLimit, cpuLimit },
          }
        : null,
    );
  }, [cpuLimit, dirty, memoryLimit, reportPending]);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="eyebrow font-semibold">Resource Limits</h3>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-[10.5px] font-mono uppercase tracking-wider text-text-tertiary mb-1.5">
            Memory
          </p>
          <div className="flex gap-2 items-center flex-wrap">
            {MEMORY_PRESETS.map((preset) => (
              <button
                key={preset}
                onClick={() => {
                  setMemoryLimit(preset);
                  setErr('');
                }}
                className={`px-3 py-1.5 text-xs font-mono rounded transition-colors ${
                  memoryLimit === preset
                    ? 'bg-accent text-bg'
                    : 'bg-bg-surface text-text-secondary hover:bg-bg-active'
                }`}
              >
                {preset}
              </button>
            ))}
            <input
              aria-label="Custom memory limit"
              type="text"
              value={memoryLimit}
              onChange={(e) => {
                setMemoryLimit(e.target.value);
                setErr('');
              }}
              placeholder="e.g. 4g"
              className="input input-sm font-mono text-xs w-24"
            />
          </div>
        </div>

        <div>
          <p className="text-[10.5px] font-mono uppercase tracking-wider text-text-tertiary mb-1.5">
            CPU (cores)
          </p>
          <div className="flex gap-2 items-center flex-wrap">
            {CPU_PRESETS.map((preset) => (
              <button
                key={preset}
                onClick={() => {
                  setCpuLimit(preset);
                  setErr('');
                }}
                className={`px-3 py-1.5 text-xs font-mono rounded transition-colors ${
                  cpuLimit === preset
                    ? 'bg-accent text-bg'
                    : 'bg-bg-surface text-text-secondary hover:bg-bg-active'
                }`}
              >
                {preset}
              </button>
            ))}
            <input
              aria-label="Custom CPU core limit"
              type="text"
              value={cpuLimit}
              onChange={(e) => {
                setCpuLimit(e.target.value);
                setErr('');
              }}
              placeholder="e.g. 2"
              className="input input-sm font-mono text-xs w-24"
            />
          </div>
        </div>
      </div>

      {err && <p className="text-xs text-danger mt-3">{err}</p>}
      {dirty && (
        <p className="text-xs text-text-tertiary mt-3">
          Pending review. Applying this change recreates the container.
        </p>
      )}
    </div>
  );
}

// ── Env vars ────────────────────────────────────────────────────────────────

function EnvVarEditor({
  deployment,
  reportPending,
}: {
  deployment: DetailContext['deployment'];
  reportPending: ReportPending;
}) {
  const [rows, setRows] = useState<Array<{ key: string; value: string }>>(parseEnvVars(deployment));
  const [dirty, setDirty] = useState(false);
  const [masked, setMasked] = useState(true);

  useEffect(() => {
    setRows(parseEnvVars(deployment));
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployment.envVars]);

  function updateRow(index: number, field: 'key' | 'value', val: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: val } : r)));
    setDirty(true);
  }
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  }
  function addRow() {
    setRows((prev) => [...prev, { key: '', value: '' }]);
    setDirty(true);
  }

  useEffect(() => {
    const envVars: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (key) envVars[key] = row.value;
    }
    reportPending(
      'environment',
      dirty
        ? {
            label: 'Environment variables',
            summary: `${Object.keys(envVars).length} variable${Object.keys(envVars).length === 1 ? '' : 's'}`,
            patch: { envVars },
          }
        : null,
    );
  }, [dirty, reportPending, rows]);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="eyebrow font-semibold">Environment Variables</h3>
        <div className="flex gap-2">
          {rows.length > 0 && (
            <button onClick={() => setMasked(!masked)} className="btn btn-sm text-xs">
              {masked ? 'Show values' : 'Hide values'}
            </button>
          )}
          <button onClick={addRow} className="btn btn-sm text-xs">
            Add Variable
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-text-tertiary">No environment variables configured.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input
                aria-label={`Environment variable ${i + 1} name`}
                type="text"
                value={row.key}
                onChange={(e) => updateRow(i, 'key', e.target.value)}
                placeholder="KEY"
                className="input input-sm font-mono text-xs flex-1 max-w-[200px]"
              />
              <span className="text-text-tertiary text-xs">=</span>
              <input
                aria-label={`Environment variable ${i + 1} value`}
                type={masked ? 'password' : 'text'}
                value={row.value}
                onChange={(e) => updateRow(i, 'value', e.target.value)}
                placeholder="value"
                className="input input-sm font-mono text-xs flex-[2]"
              />
              <RemoveButton onClick={() => removeRow(i)} ariaLabel={`Remove variable ${i + 1}`} />
            </div>
          ))}
        </div>
      )}

      {dirty && (
        <p className="text-xs text-text-tertiary mt-2">
          Pending review. Values stay local until you apply all changes.
        </p>
      )}
    </div>
  );
}

// ── Extra ports ─────────────────────────────────────────────────────────────

function ExtraPortEditor({
  deployment,
  reportPending,
}: {
  deployment: DetailContext['deployment'];
  reportPending: ReportPending;
}) {
  const currentPorts = parseExtraPorts(deployment);
  const [rows, setRows] = useState<Array<{ container: string; protocol: string }>>(
    currentPorts.map((p) => ({ container: String(p.container), protocol: p.protocol || 'tcp' })),
  );
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const ports = parseExtraPorts(deployment);
    setRows(ports.map((p) => ({ container: String(p.container), protocol: p.protocol || 'tcp' })));
    setDirty(false);
    setErr('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployment.extraPorts]);

  function updateRow(index: number, field: 'container' | 'protocol', val: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: val } : r)));
    setDirty(true);
  }
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  }
  function addRow() {
    setRows((prev) => [...prev, { container: '', protocol: 'tcp' }]);
    setDirty(true);
  }

  useEffect(() => {
    const extraPorts: Array<{ container: number; protocol?: string }> = [];
    let validationError = '';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const port = parseInt(r.container, 10);
      if (!r.container.trim()) continue;
      if (isNaN(port) || port < 1 || port > 65535) {
        validationError = `Port ${i + 1}: container port must be between 1 and 65535`;
        break;
      }
      extraPorts.push({
        container: port,
        ...(r.protocol !== 'tcp' ? { protocol: r.protocol } : {}),
      });
    }
    setErr(validationError);
    reportPending(
      'ports',
      dirty
        ? {
            label: 'Extra ports',
            summary: `${extraPorts.length} port${extraPorts.length === 1 ? '' : 's'}`,
            patch: { extraPorts },
            error: validationError || undefined,
          }
        : null,
    );
  }, [dirty, reportPending, rows]);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="eyebrow font-semibold">Extra Ports</h3>
        <div className="flex gap-2">
          <button onClick={addRow} className="btn btn-sm text-xs">
            Add Port
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-text-tertiary">No extra ports configured.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2 items-center">
            <span className="text-xs text-text-tertiary flex-1">Container Port</span>
            <span className="text-xs text-text-tertiary w-20">Protocol</span>
            {currentPorts.length > 0 && (
              <span className="text-xs text-text-tertiary w-24">Host Port</span>
            )}
            <span className="w-5" />
          </div>
          {rows.map((row, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input
                aria-label={`Extra port ${i + 1} container port`}
                type="text"
                value={row.container}
                onChange={(e) => updateRow(i, 'container', e.target.value)}
                placeholder="2222"
                className="input input-sm font-mono text-xs flex-1"
              />
              <select
                aria-label={`Extra port ${i + 1} protocol`}
                value={row.protocol}
                onChange={(e) => updateRow(i, 'protocol', e.target.value)}
                className="input input-sm text-xs w-20"
              >
                <option value="tcp">tcp</option>
                <option value="udp">udp</option>
              </select>
              {currentPorts.length > 0 && (
                <span className="font-mono text-xs text-text-tertiary w-24">
                  {currentPorts[i]?.host ? `→ ${currentPorts[i].host}` : '—'}
                </span>
              )}
              <RemoveButton onClick={() => removeRow(i)} ariaLabel={`Remove extra port ${i + 1}`} />
            </div>
          ))}
        </div>
      )}

      {err && <p className="text-xs text-danger mt-2">{err}</p>}
      {dirty && (
        <p className="text-xs text-text-tertiary mt-2">
          Pending review. Applying port changes recreates the container; host ports are
          auto-assigned.
        </p>
      )}
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
  const [wipeVolumes, setWipeVolumes] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState('');

  async function handleDelete() {
    const auth = getAuth();
    if (!auth) return;
    setDeleting(true);
    setErr('');
    try {
      await serverDeleteDeployment(auth.username, auth.token, deployment.name, {
        deleteVolumes: wipeVolumes,
      });
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
            Stops the container and removes its database row. By default, persisted volumes remain
            on disk.
          </p>
        </div>
        <button
          onClick={() => {
            setWipeVolumes(false);
            setConfirming(true);
          }}
          disabled={deleting}
          className="btn btn-danger btn-sm text-xs whitespace-nowrap"
        >
          {deleting ? 'Deleting…' : 'Delete App'}
        </button>
      </div>

      {err && <p className="text-xs text-danger mt-3">{err}</p>}

      <ConfirmDialog
        open={confirming}
        title={`Delete ${deployment.name}?`}
        message={
          wipeVolumes
            ? `This stops the container, removes its database row, AND permanently deletes its persisted volumes from disk. This cannot be undone.`
            : `This stops the container and removes its database row. Persisted volumes remain on disk. This cannot be undone.`
        }
        confirmLabel={wipeVolumes ? 'Delete app and volumes' : 'Delete'}
        danger
        requireTypedConfirmation={deployment.name}
        onConfirm={() => {
          setConfirming(false);
          handleDelete();
        }}
        onCancel={() => setConfirming(false)}
      >
        <label className="flex items-start gap-2 mt-1 text-xs text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={wipeVolumes}
            onChange={(e) => setWipeVolumes(e.target.checked)}
            className="w-3.5 h-3.5 mt-0.5"
          />
          <span>
            Also delete persisted volumes ({' '}
            <code className="font-mono">.deploy-data/volumes/{deployment.name}</code> ). This wipes
            all app data and uploads. Backups are kept.
          </span>
        </label>
      </ConfirmDialog>
    </div>
  );
}

// ── Page component ──────────────────────────────────────────────────────────

export default function Component() {
  const { deployment, inspect, fetchDeployment, fetchInspect } = useDetailContext();
  const { navigate } = useRouter();
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState<Record<string, PendingChange>>({});
  const [reviewing, setReviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [blockedHref, setBlockedHref] = useState<string | null>(null);
  const [gpuEnabled, setGpuEnabled] = useState(!!deployment.gpuEnabled);
  const [privilegedDocker, setPrivilegedDocker] = useState(!!deployment.privilegedDocker);

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

  useEffect(() => setGpuEnabled(!!deployment.gpuEnabled), [deployment.gpuEnabled]);
  useEffect(
    () => setPrivilegedDocker(!!deployment.privilegedDocker),
    [deployment.privilegedDocker],
  );

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
      await serverUpdateSettings(auth.username, auth.token, deployment.name, patch);
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

  const systemEnvVars = (inspect?.env || []).filter(isSystemEnv);

  async function handleToggleDiscoverable() {
    const auth = getAuth();
    if (!auth) return;
    setActionError('');
    try {
      await serverUpdateSettings(auth.username, auth.token, deployment.name, {
        discoverable: !deployment.discoverable,
      });
      fetchDeployment();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }
  function handleToggleGpu() {
    const next = !gpuEnabled;
    setGpuEnabled(next);
    reportPending(
      'gpu',
      next !== !!deployment.gpuEnabled
        ? {
            label: 'GPU passthrough',
            summary: next ? 'Enabled' : 'Disabled',
            patch: { gpuEnabled: next },
          }
        : null,
    );
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
  function handleTogglePrivilegedDocker() {
    const next = !privilegedDocker;
    if (next) {
      const confirmed = window.confirm(
        'Enabling privileged Docker access mounts /var/run/docker.sock into this container. ' +
          'This gives the container ROOT-EQUIVALENT ACCESS to the host. ' +
          'Only enable for trusted CI/CD or build apps you control. Continue?',
      );
      if (!confirmed) return;
    }
    setPrivilegedDocker(next);
    reportPending(
      'privileged-docker',
      next !== !!deployment.privilegedDocker
        ? {
            label: 'Privileged Docker access',
            summary: next ? 'Enabled — root-equivalent host access' : 'Disabled',
            patch: { privilegedDocker: next },
          }
        : null,
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {actionError && <ErrorBanner message={actionError} />}

      <ResourceLimitsEditor deployment={deployment} reportPending={reportPending} />
      <EnvVarEditor deployment={deployment} reportPending={reportPending} />
      <ExtraPortEditor deployment={deployment} reportPending={reportPending} />
      <VolumeMountEditor deployment={deployment} reportPending={reportPending} />

      <div className="card p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex-1">
            <p className="text-sm font-semibold mb-1">GPU Passthrough</p>
            <p className="text-xs text-text-secondary">
              Expose host GPUs to this container (requires NVIDIA Container Toolkit)
            </p>
          </div>
          <Toggle enabled={gpuEnabled} onChange={handleToggleGpu} label="GPU Passthrough" />
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <p className="text-sm font-semibold">Privileged Docker Access</p>
              {privilegedDocker && (
                <span className="badge bg-warning/10 text-warning text-[10px] uppercase">
                  Privileged
                </span>
              )}
            </div>
            <p className="text-xs text-text-secondary">
              Mounts <code className="font-mono">/var/run/docker.sock</code> so the container can
              spawn sibling containers (CI runners, build tools).{' '}
              <span className="text-warning font-medium">
                Gives root-equivalent access to the host — only enable for trusted apps.
              </span>
            </p>
          </div>
          <Toggle
            enabled={privilegedDocker}
            onChange={handleTogglePrivilegedDocker}
            label="Privileged Docker"
          />
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex-1">
            <p className="text-sm font-semibold mb-1">Auto-backup before deploy</p>
            <p className="text-xs text-text-secondary">
              Snapshot the volume to a tarball before each deployment.
            </p>
          </div>
          <Toggle
            enabled={!!deployment.autoBackup}
            onChange={handleToggleAutoBackup}
            label="Auto-Backup"
          />
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex-1">
            <p className="text-sm font-semibold mb-1">Discoverable</p>
            <p className="text-xs text-text-secondary">
              Show this app on the discover.local network directory
            </p>
          </div>
          <Toggle
            enabled={!!deployment.discoverable}
            onChange={handleToggleDiscoverable}
            label="Discoverable"
          />
        </div>
      </div>

      {systemEnvVars.length > 0 && (
        <div className="card p-4">
          <h3 className="eyebrow font-semibold mb-3">System Variables</h3>
          <div className="space-y-1">
            {systemEnvVars.map((e, i) => {
              const [key, ...rest] = e.split('=');
              return (
                <div key={i} className="flex flex-wrap gap-x-2 text-xs font-mono">
                  <span className="text-text-tertiary">{key}</span>
                  <span className="text-text-tertiary">=</span>
                  <span className="text-text-tertiary break-all">{rest.join('=')}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
