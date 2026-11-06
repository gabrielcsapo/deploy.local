// This folder also ships inside the CLI and the worker, which must never load the server's
// database. Only the server fills these in (server/packages/hooks.ts), so elsewhere they do nothing.
export type PackageHooks = {
  installConfig(owner: string, computerId: string, projectId?: string): Promise<any> | any;
  revokeComputer(owner: string, computerId: string): void;
  finishJob(jobId: string): void;
};
let hooks: PackageHooks | undefined;
export function setPackageHooks(value: PackageHooks) {
  hooks = value;
}
export const packageHooks: PackageHooks = {
  installConfig: (owner, computerId, projectId) =>
    hooks?.installConfig(owner, computerId, projectId) ?? null,
  revokeComputer: (owner, computerId) => hooks?.revokeComputer(owner, computerId),
  finishJob: (jobId) => hooks?.finishJob(jobId),
};
