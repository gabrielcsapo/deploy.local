export function installWorkerBuild(input: {
  path: string;
  bytes: Buffer;
  sha256: string;
  size: number;
  version: string;
  commit?: string;
  previous?: string;
  platform?: string;
  probe?: (path: string, version: string, commit?: string) => void | Promise<void>;
}): Promise<{ version: string; previous: string | undefined }>;
export function downloadWorkerBuild(
  serverUrl: string,
  path: string,
  expectedVersion?: string,
  previous?: string,
  options?: {
    manifest?: WorkerBuildManifest;
    platform?: string;
    arch?: string;
    install?: typeof installWorkerBuild;
  },
): Promise<{ version: string; previous: string | undefined }>;
export interface WorkerBuildManifest {
  version: string;
  commit?: string;
  targets: Record<string, { sha256: string; size: number }>;
}
export function workerBuildInfo(path: string): Promise<{ version: string; commit?: string }>;
export function workerBuildManifest(serverUrl: string): Promise<WorkerBuildManifest>;
