'use client';

import { createContext, useContext } from 'react';

export function appUrl(name: string) {
  if (typeof window === 'undefined') return `https://${name}.local`;
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
  window.dispatchEvent(new StorageEvent('storage', { key: 'deploy-sh-auth' }));
}

export function clearAuth() {
  localStorage.removeItem('deploy-sh-auth');
  window.dispatchEvent(new StorageEvent('storage', { key: 'deploy-sh-auth' }));
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
  gpuEnabled: boolean;
  privilegedDocker: boolean;
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

const DetailCtx = createContext<DetailContext | null>(null);

export function DetailProvider({
  value,
  children,
}: {
  value: DetailContext;
  children: React.ReactNode;
}) {
  return <DetailCtx.Provider value={value}>{children}</DetailCtx.Provider>;
}

export function useDetailContext(): DetailContext {
  const ctx = useContext(DetailCtx);
  if (!ctx) throw new Error('useDetailContext must be used within DetailProvider');
  return ctx;
}

export function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'running'
      ? 'badge-success'
      : status === 'exited' || status === 'failed' || status === 'stopped'
        ? 'badge-danger'
        : status === 'starting' || status === 'building' || status === 'uploading'
          ? 'badge-warning animate-pulse motion-reduce:animate-none'
          : 'badge-warning';

  const label =
    status === 'starting' || status === 'building' ? (
      <span className="flex items-center gap-1.5">
        <svg
          className="animate-spin motion-reduce:animate-none h-3 w-3"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
            fill="none"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
        {status}
      </span>
    ) : (
      status
    );

  return <span className={`badge ${cls}`}>{label}</span>;
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
