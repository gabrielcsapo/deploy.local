'use client';

import { StatusBadge as SharedStatusBadge, applicationStatusTone } from '@/components/ui';

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

export { getAuth, setAuth, clearAuth } from '../../../auth.ts';

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
  appId: string | null;
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
  cpuLimit: string | null;
  volumes: string | null;
  extraPorts: string | null;
  currentBuildLogId: number | null;
  desiredNodeId: string | null;
  activeNodeId: string | null;
  desiredSpecDigest: string | null;
  activeSpecDigest: string | null;
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
  started: number | null;
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
  return (
    <SharedStatusBadge
      tone={applicationStatusTone(status)}
      label={status === 'configuration-required' ? 'Needs configuration' : status}
    />
  );
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
