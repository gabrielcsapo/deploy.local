'use client';

import { useState, useEffect } from 'react';
import {
  updateDeploymentSettings as serverUpdateSettings,
  applyMemoryLimit as serverApplyMemoryLimit,
} from '../../../actions/deployments';
import { getAuth, parseExtraPorts, useDetailContext } from './shared';
import type { DetailContext } from './shared';
import { Toggle } from '../../../components/Toggle';
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

// ── Resource limits (memory + CPU) ──────────────────────────────────────────

const MEMORY_PRESETS = ['128m', '256m', '512m', '1g', '2g', '4g', '8g'];
const CPU_PRESETS = ['0.5', '1', '2', '4'];

function ResourceLimitsEditor({
  deployment,
  fetchDeployment,
  fetchInspect,
}: {
  deployment: DetailContext['deployment'];
  fetchDeployment: () => void;
  fetchInspect: () => void;
}) {
  const initialMem = deployment.memoryLimit || '4g';
  const initialCpu = deployment.cpuLimit || '2';
  const [memoryLimit, setMemoryLimit] = useState(initialMem);
  const [cpuLimit, setCpuLimit] = useState(initialCpu);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setMemoryLimit(deployment.memoryLimit || '4g');
    setCpuLimit(deployment.cpuLimit || '2');
  }, [deployment.memoryLimit, deployment.cpuLimit]);

  const dirty = memoryLimit !== initialMem || cpuLimit !== initialCpu;

  async function handleSaveAndRestart() {
    const auth = getAuth();
    if (!auth) return;
    setSaving(true);
    setErr('');
    try {
      await serverUpdateSettings(auth.username, auth.token, deployment.name, {
        memoryLimit,
        cpuLimit,
      });
      await serverApplyMemoryLimit(auth.username, auth.token, deployment.name);
      fetchDeployment();
      fetchInspect();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="eyebrow font-semibold">Resource Limits</h3>
        {dirty && (
          <button
            onClick={handleSaveAndRestart}
            disabled={saving}
            className="btn btn-primary btn-sm text-xs"
          >
            {saving ? 'Saving...' : 'Save & Recreate'}
          </button>
        )}
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
          Saving will recreate the container to apply the new limits.
        </p>
      )}
    </div>
  );
}

// ── Env vars ────────────────────────────────────────────────────────────────

function EnvVarEditor({
  deployment,
  fetchDeployment,
  fetchInspect,
}: {
  deployment: DetailContext['deployment'];
  fetchDeployment: () => void;
  fetchInspect: () => void;
}) {
  const [rows, setRows] = useState<Array<{ key: string; value: string }>>(parseEnvVars(deployment));
  const [saving, setSaving] = useState(false);
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

  async function handleSave() {
    const auth = getAuth();
    if (!auth) return;
    const envVars: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (key) envVars[key] = row.value;
    }
    setSaving(true);
    try {
      await serverUpdateSettings(auth.username, auth.token, deployment.name, { envVars });
      fetchDeployment();
      fetchInspect();
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }

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
          {dirty && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn btn-primary btn-sm text-xs"
            >
              {saving ? 'Saving...' : 'Save & Recreate'}
            </button>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-text-tertiary">No environment variables configured.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input
                type="text"
                value={row.key}
                onChange={(e) => updateRow(i, 'key', e.target.value)}
                placeholder="KEY"
                className="input input-sm font-mono text-xs flex-1 max-w-[200px]"
              />
              <span className="text-text-tertiary text-xs">=</span>
              <input
                type={masked ? 'password' : 'text'}
                value={row.value}
                onChange={(e) => updateRow(i, 'value', e.target.value)}
                placeholder="value"
                className="input input-sm font-mono text-xs flex-[2]"
              />
              <RemoveButton onClick={() => removeRow(i)} ariaLabel="Remove variable" />
            </div>
          ))}
        </div>
      )}

      {dirty && (
        <p className="text-xs text-text-tertiary mt-2">
          Saving will recreate the container to apply changes.
        </p>
      )}
    </div>
  );
}

// ── Extra ports ─────────────────────────────────────────────────────────────

function ExtraPortEditor({
  deployment,
  fetchDeployment,
  fetchInspect,
}: {
  deployment: DetailContext['deployment'];
  fetchDeployment: () => void;
  fetchInspect: () => void;
}) {
  const currentPorts = parseExtraPorts(deployment);
  const [rows, setRows] = useState<Array<{ container: string; protocol: string }>>(
    currentPorts.map((p) => ({ container: String(p.container), protocol: p.protocol || 'tcp' })),
  );
  const [saving, setSaving] = useState(false);
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

  async function handleSave() {
    const auth = getAuth();
    if (!auth) return;
    const extraPorts: Array<{ container: number; protocol?: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const port = parseInt(r.container, 10);
      if (!r.container.trim()) continue;
      if (isNaN(port) || port < 1 || port > 65535) {
        setErr(`Port ${i + 1}: container port must be between 1 and 65535`);
        return;
      }
      extraPorts.push({
        container: port,
        ...(r.protocol !== 'tcp' ? { protocol: r.protocol } : {}),
      });
    }
    setSaving(true);
    setErr('');
    try {
      await serverUpdateSettings(auth.username, auth.token, deployment.name, { extraPorts });
      fetchDeployment();
      fetchInspect();
      setDirty(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="eyebrow font-semibold">Extra Ports</h3>
        <div className="flex gap-2">
          <button onClick={addRow} className="btn btn-sm text-xs">
            Add Port
          </button>
          {dirty && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn btn-primary btn-sm text-xs"
            >
              {saving ? 'Saving...' : 'Save & Recreate'}
            </button>
          )}
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
                type="text"
                value={row.container}
                onChange={(e) => updateRow(i, 'container', e.target.value)}
                placeholder="2222"
                className="input input-sm font-mono text-xs flex-1"
              />
              <select
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
              <RemoveButton onClick={() => removeRow(i)} ariaLabel="Remove" />
            </div>
          ))}
        </div>
      )}

      {err && <p className="text-xs text-danger mt-2">{err}</p>}
      {dirty && (
        <p className="text-xs text-text-tertiary mt-2">
          Saving will recreate the container to apply port changes. Host ports are auto-assigned.
        </p>
      )}
    </div>
  );
}

// ── Volume mounts ───────────────────────────────────────────────────────────

function VolumeMountEditor({
  deployment,
  fetchDeployment,
  fetchInspect,
}: {
  deployment: DetailContext['deployment'];
  fetchDeployment: () => void;
  fetchInspect: () => void;
}) {
  const [rows, setRows] = useState<
    Array<{ hostPath: string; containerPath: string; readOnly: boolean }>
  >(parseVolumeMounts(deployment));
  const [saving, setSaving] = useState(false);
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

  async function handleSave() {
    const auth = getAuth();
    if (!auth) return;
    const volumes = rows.filter((r) => r.hostPath.trim() || r.containerPath.trim());
    for (let i = 0; i < volumes.length; i++) {
      const v = volumes[i];
      if (!v.hostPath.startsWith('/')) {
        setErr(`Volume ${i + 1}: host path must be absolute`);
        return;
      }
      if (!v.containerPath.startsWith('/')) {
        setErr(`Volume ${i + 1}: container path must be absolute`);
        return;
      }
      if (v.hostPath.includes('..') || v.containerPath.includes('..')) {
        setErr(`Volume ${i + 1}: paths must not contain ".."`);
        return;
      }
    }
    setSaving(true);
    setErr('');
    try {
      await serverUpdateSettings(auth.username, auth.token, deployment.name, { volumes });
      fetchDeployment();
      fetchInspect();
      setDirty(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="eyebrow font-semibold">Volume Mounts</h3>
        <div className="flex gap-2">
          <button onClick={addRow} className="btn btn-sm text-xs">
            Add Volume
          </button>
          {dirty && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn btn-primary btn-sm text-xs"
            >
              {saving ? 'Saving...' : 'Save & Recreate'}
            </button>
          )}
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
                type="text"
                value={row.hostPath}
                onChange={(e) => updateRow(i, 'hostPath', e.target.value)}
                placeholder="/path/on/host"
                className="input input-sm font-mono text-xs flex-1"
              />
              <span className="text-text-tertiary text-xs">&rarr;</span>
              <input
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
              <RemoveButton onClick={() => removeRow(i)} ariaLabel="Remove" />
            </div>
          ))}
        </div>
      )}

      {err && <p className="text-xs text-danger mt-2">{err}</p>}
      {dirty && (
        <p className="text-xs text-text-tertiary mt-2">
          Saving will recreate the container to apply changes.
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

// ── Page component ──────────────────────────────────────────────────────────

export default function Component() {
  const { deployment, inspect, fetchDeployment, fetchInspect } = useDetailContext();
  const [actionError, setActionError] = useState('');

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
  async function handleToggleGpu() {
    const auth = getAuth();
    if (!auth) return;
    setActionError('');
    try {
      await serverUpdateSettings(auth.username, auth.token, deployment.name, {
        gpuEnabled: !deployment.gpuEnabled,
      });
      fetchDeployment();
      fetchInspect();
    } catch (e) {
      setActionError((e as Error).message);
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
  async function handleTogglePrivilegedDocker() {
    const auth = getAuth();
    if (!auth) return;
    setActionError('');
    if (!deployment.privilegedDocker) {
      const confirmed = window.confirm(
        'Enabling privileged Docker access mounts /var/run/docker.sock into this container. ' +
          'This gives the container ROOT-EQUIVALENT ACCESS to the host. ' +
          'Only enable for trusted CI/CD or build apps you control. Continue?',
      );
      if (!confirmed) return;
    }
    try {
      await serverUpdateSettings(auth.username, auth.token, deployment.name, {
        privilegedDocker: !deployment.privilegedDocker,
      });
      fetchDeployment();
      fetchInspect();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {actionError && <ErrorBanner message={actionError} />}

      <ResourceLimitsEditor
        deployment={deployment}
        fetchDeployment={fetchDeployment}
        fetchInspect={fetchInspect}
      />
      <EnvVarEditor
        deployment={deployment}
        fetchDeployment={fetchDeployment}
        fetchInspect={fetchInspect}
      />
      <ExtraPortEditor
        deployment={deployment}
        fetchDeployment={fetchDeployment}
        fetchInspect={fetchInspect}
      />
      <VolumeMountEditor
        deployment={deployment}
        fetchDeployment={fetchDeployment}
        fetchInspect={fetchInspect}
      />

      <div className="card p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex-1">
            <p className="text-sm font-semibold mb-1">GPU Passthrough</p>
            <p className="text-xs text-text-secondary">
              Expose host GPUs to this container (requires NVIDIA Container Toolkit)
            </p>
          </div>
          <Toggle
            enabled={!!deployment.gpuEnabled}
            onChange={handleToggleGpu}
            label="GPU Passthrough"
          />
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <p className="text-sm font-semibold">Privileged Docker Access</p>
              {deployment.privilegedDocker && (
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
            enabled={!!deployment.privilegedDocker}
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
    </div>
  );
}
