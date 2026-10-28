export function installWorkerBuild(input: {
  path: string;
  bytes: Buffer;
  sha256: string;
  size: number;
  version: string;
  platform?: string;
  probe?: (path: string, version: string) => void;
}): { version: string; previous: string | undefined };
export function downloadWorkerBuild(
  serverUrl: string,
  path: string,
  expectedVersion?: string,
): Promise<{ version: string; previous: string | undefined }>;
