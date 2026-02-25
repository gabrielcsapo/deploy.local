'use client';

export function appUrl(name: string) {
  if (typeof window === 'undefined') return `http://${name}.local`;
  const hostname = window.location.hostname;
  if (
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
    hostname === 'localhost' ||
    hostname.endsWith('.local')
  ) {
    const port = window.location.port;
    const portSuffix = port && port !== '80' && port !== '443' ? `:${port}` : '';
    return `${window.location.protocol}//${name}.local${portSuffix}`;
  }
  return `${window.location.protocol}//${name}.${window.location.host}`;
}

export function getAuth() {
  try {
    const raw = localStorage.getItem('deploy-sh-auth');
    if (!raw) return null;
    return JSON.parse(raw) as { username: string; token: string };
  } catch {
    return null;
  }
}

export function setAuth(username: string, token: string) {
  localStorage.setItem('deploy-sh-auth', JSON.stringify({ username, token }));
}

export function clearAuth() {
  localStorage.removeItem('deploy-sh-auth');
}

export interface ExtraPort {
  container: number;
  host: number;
  protocol: string;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface Deployment {
  name: string;
  type: string;
  port: number;
  status: string;
  containerId: string;
  autoBackup: boolean;
  discoverable: boolean;
  envVars: string | null;
  memoryLimit: string | null;
  volumes: string | null;
  extraPorts: string | null;
  currentBuildLogId: number | null;
  createdAt: string;
}

export function parseVolumes(deployment: Deployment): VolumeMount[] {
  if (!deployment.volumes) return [];
  try {
    return JSON.parse(deployment.volumes);
  } catch {
    return [];
  }
}

export function parseExtraPorts(deployment: Deployment): ExtraPort[] {
  if (!deployment.extraPorts) return [];
  try {
    return JSON.parse(deployment.extraPorts);
  } catch {
    return [];
  }
}

export interface ContainerInfo {
  id: string;
  image: string;
  created: string;
  started: string;
  finished: string;
  status: string;
  restartCount: number;
  env: string[];
}

export interface DetailContext {
  deployment: Deployment;
  inspect: ContainerInfo | null;
  fetchDeployment: () => void;
  fetchInspect: () => void;
}

export function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'running'
      ? 'badge-success'
      : status === 'exited' || status === 'failed' || status === 'stopped'
        ? 'badge-danger'
        : 'badge-warning';
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-text-tertiary mb-1">{label}</p>
      <p className="text-lg font-semibold font-mono">{value}</p>
      {sub && <p className="text-xs text-text-secondary mt-0.5">{sub}</p>}
    </div>
  );
}
