'use client';

import { useState, useEffect } from 'react';
import {
  restartDeployment as serverRestart,
  updateDeploymentSettings as serverUpdateSettings,
  applyMemoryLimit as serverApplyMemoryLimit,
} from '../../../actions/deployments';
import { appUrl, getAuth, StatusBadge, parseExtraPorts, useDetailContext } from './shared';
import type { DetailContext } from './shared';
import { Toggle } from '../../../components/Toggle';

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-text-secondary">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

function formatUptime(ms: number) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

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

// System env vars injected by the runtime (shown read-only)
const SYSTEM_ENV_PREFIXES = ['PORT=', 'PATH=', 'NODE_VERSION=', 'YARN_', 'HOSTNAME=', 'HOME='];

function isSystemEnv(envStr: string): boolean {
  return SYSTEM_ENV_PREFIXES.some((p) => envStr.startsWith(p));
}

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

  useEffect(() => {
    setRows(parseEnvVars(deployment));
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- we intentionally sync only when envVars changes, not the full deployment object
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

    // Build the env vars object, filtering out empty keys
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
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
          Environment Variables
        </h3>
        <div className="flex gap-2">
          <button onClick={addRow} className="btn btn-sm text-xs">
            Add Variable
          </button>
          {dirty && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn btn-primary btn-sm text-xs"
            >
              {saving ? 'Saving...' : 'Save & Restart'}
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
                type="text"
                value={row.value}
                onChange={(e) => updateRow(i, 'value', e.target.value)}
                placeholder="value"
                className="input input-sm font-mono text-xs flex-[2]"
              />
              <button
                onClick={() => removeRow(i)}
                className="text-text-tertiary hover:text-danger text-xs px-1"
                title="Remove"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      {dirty && (
        <p className="text-xs text-text-tertiary mt-2">
          Saving will restart the container to apply changes.
        </p>
      )}
    </div>
  );
}

const MEMORY_PRESETS = ['128m', '256m', '512m', '1g', '2g', '4g', '8g'];

function MemoryLimitEditor({
  deployment,
  fetchDeployment,
  fetchInspect,
}: {
  deployment: DetailContext['deployment'];
  fetchDeployment: () => void;
  fetchInspect: () => void;
}) {
  const current = deployment.memoryLimit || '4g';
  const [memoryLimit, setMemoryLimit] = useState(current);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setMemoryLimit(deployment.memoryLimit || '4g');
    setDirty(false);
  }, [deployment.memoryLimit]);

  function handleChange(value: string) {
    setMemoryLimit(value);
    setDirty(value !== current);
    setErr('');
  }

  async function handleSave() {
    const auth = getAuth();
    if (!auth) return;

    setSaving(true);
    setErr('');
    try {
      await serverUpdateSettings(auth.username, auth.token, deployment.name, { memoryLimit });
      fetchDeployment();
      setDirty(false);
      if (deployment.status === 'running') {
        setPendingRestart(true);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleApply() {
    const auth = getAuth();
    if (!auth) return;

    setApplying(true);
    setErr('');
    try {
      await serverApplyMemoryLimit(auth.username, auth.token, deployment.name);
      fetchDeployment();
      fetchInspect();
      setPendingRestart(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
          Memory Limit
        </h3>
        <div className="flex gap-2">
          {pendingRestart && !dirty && (
            <button
              onClick={handleApply}
              disabled={applying}
              className="btn btn-sm text-xs bg-warning/10 text-warning hover:bg-warning/20"
            >
              {applying ? 'Applying...' : 'Apply & Restart'}
            </button>
          )}
          {dirty && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn btn-primary btn-sm text-xs"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      </div>
      <div className="flex gap-2 items-center flex-wrap">
        {MEMORY_PRESETS.map((preset) => (
          <button
            key={preset}
            onClick={() => handleChange(preset)}
            className={`px-3 py-1.5 text-xs font-mono rounded transition-colors ${
              memoryLimit === preset
                ? 'bg-accent text-white'
                : 'bg-bg-secondary text-text-secondary hover:bg-bg-tertiary'
            }`}
          >
            {preset}
          </button>
        ))}
        <input
          type="text"
          value={memoryLimit}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="e.g. 4g"
          className="input input-sm font-mono text-xs w-24"
        />
      </div>
      {err && <p className="text-xs text-danger mt-2">{err}</p>}
      {dirty && (
        <p className="text-xs text-text-tertiary mt-2">
          Save to update the limit. Container will need a restart to apply.
        </p>
      )}
      {pendingRestart && !dirty && (
        <p className="text-xs text-warning mt-2">
          Memory limit saved. Click "Apply & Restart" to recreate the container with the new limit.
        </p>
      )}
    </div>
  );
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
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
          Extra Ports
        </h3>
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
              {saving ? 'Saving...' : 'Save & Restart'}
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
              <button
                onClick={() => removeRow(i)}
                className="text-text-tertiary hover:text-danger text-xs px-1"
                title="Remove"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      {err && <p className="text-xs text-danger mt-2">{err}</p>}
      {dirty && (
        <p className="text-xs text-text-tertiary mt-2">
          Saving will restart the container to apply changes. Host ports are auto-assigned.
        </p>
      )}
    </div>
  );
}

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- we intentionally sync only when volumes changes, not the full deployment object
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
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
          Volume Mounts
        </h3>
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
              {saving ? 'Saving...' : 'Save & Restart'}
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
              <button
                onClick={() => removeRow(i)}
                className="text-text-tertiary hover:text-danger text-xs px-1"
                title="Remove"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      {err && <p className="text-xs text-danger mt-2">{err}</p>}
      {dirty && (
        <p className="text-xs text-text-tertiary mt-2">
          Saving will restart the container to apply changes.
        </p>
      )}
    </div>
  );
}

export default function Component() {
  const { deployment, inspect, fetchDeployment, fetchInspect } = useDetailContext();

  const started = inspect?.started ? new Date(inspect.started) : null;
  const uptime = started ? formatUptime(Date.now() - started.getTime()) : 'N/A';

  // System env vars from the running container (read-only)
  const systemEnvVars = (inspect?.env || []).filter(isSystemEnv);

  async function handleRestart() {
    const auth = getAuth();
    if (!auth) return;
    await serverRestart(auth.username, auth.token, deployment.name);
    fetchDeployment();
    fetchInspect();
  }

  async function handleToggleDiscoverable() {
    const auth = getAuth();
    if (!auth) return;
    await serverUpdateSettings(auth.username, auth.token, deployment.name, {
      discoverable: !deployment.discoverable,
    });
    fetchDeployment();
  }

  async function handleToggleGpu() {
    const auth = getAuth();
    if (!auth) return;
    await serverUpdateSettings(auth.username, auth.token, deployment.name, {
      gpuEnabled: !deployment.gpuEnabled,
    });
    fetchDeployment();
    fetchInspect();
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-4 space-y-3">
          <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
            Container
          </h3>
          <InfoRow label="Status">
            <StatusBadge status={deployment.status} />
          </InfoRow>
          <InfoRow label="Uptime">{uptime}</InfoRow>
          <InfoRow label="Restarts">{inspect?.restartCount ?? 'N/A'}</InfoRow>
          <InfoRow label="Image">
            <span className="font-mono text-xs">{inspect?.image ?? 'N/A'}</span>
          </InfoRow>
          <InfoRow label="Container ID">
            <span className="font-mono text-xs">{deployment.containerId?.slice(0, 12)}</span>
          </InfoRow>
        </div>

        <div className="card p-4 space-y-3">
          <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
            Deployment
          </h3>
          <InfoRow label="Name">{deployment.name}</InfoRow>
          <InfoRow label="Type">
            <span className="badge bg-accent/10 text-accent">{deployment.type}</span>
          </InfoRow>
          <InfoRow label="URL">
            <a
              href={appUrl(deployment.name)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:text-accent-hover font-mono text-xs"
            >
              {deployment.name}.local
            </a>
          </InfoRow>
          <InfoRow label="Created">{new Date(deployment.createdAt).toLocaleString()}</InfoRow>
        </div>
      </div>

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

      <MemoryLimitEditor
        deployment={deployment}
        fetchDeployment={fetchDeployment}
        fetchInspect={fetchInspect}
      />

      <VolumeMountEditor
        deployment={deployment}
        fetchDeployment={fetchDeployment}
        fetchInspect={fetchInspect}
      />

      {/* GPU Passthrough Setting */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div>
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

      {systemEnvVars.length > 0 && (
        <div className="card p-4">
          <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
            System Variables
          </h3>
          <div className="space-y-1">
            {systemEnvVars.map((e, i) => {
              const [key, ...rest] = e.split('=');
              return (
                <div key={i} className="flex gap-2 text-xs font-mono">
                  <span className="text-text-tertiary">{key}</span>
                  <span className="text-text-tertiary">=</span>
                  <span className="text-text-tertiary">{rest.join('=')}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Discoverable Setting */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div>
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

      <div className="flex gap-2">
        <a
          href={appUrl(deployment.name)}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-primary btn-sm"
        >
          Open App
        </a>
        <button type="button" className="btn btn-sm" onClick={handleRestart}>
          Restart
        </button>
      </div>
    </div>
  );
}
