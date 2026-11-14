import type { MergePermissionSource } from '../contracts/merge-permission.ts';

let provider: MergePermissionSource | undefined;

export function registerMergePermissionSource(value: MergePermissionSource) {
  provider = value;
}

export function requireMergePermissionSource(processName: string): MergePermissionSource {
  if (!provider) throw new Error(`MergePermissionSource is not wired in ${processName}`);
  return provider;
}
