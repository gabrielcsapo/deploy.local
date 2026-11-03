export function installWorkerBuild(input: {
  path: string;
  bytes: Buffer;
  sha256: string;
  size: number;
  version: string;
  previous?: string;
  platform?: string;
  probe?: (path: string, version: string) => void;
}): { version: string; previous: string | undefined };
export function downloadWorkerBuild(
  serverUrl: string,
  path: string,
  expectedVersion?: string,
  previous?: string,
): Promise<{ version: string; previous: string | undefined }>;
