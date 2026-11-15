export type JobRequirements = {
  os: 'linux' | 'macos' | 'windows';
  architecture?: string;
  capabilities: string[];
};
export function jobRequirements(value: unknown): JobRequirements | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid job requirements');
  const input = value as Record<string, any>;
  if (Object.keys(input).some((key) => !['os', 'architecture', 'capabilities'].includes(key)))
    throw new Error('Unknown job requirement');
  if (!['linux', 'macos', 'windows'].includes(input.os))
    throw new Error('Job OS must be linux, macos, or windows');
  if (
    input.architecture !== undefined &&
    (typeof input.architecture !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(input.architecture))
  )
    throw new Error('Invalid job architecture');
  const capabilities = input.capabilities ?? [];
  if (
    !Array.isArray(capabilities) ||
    capabilities.length > 32 ||
    capabilities.some((c) => typeof c !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(c))
  )
    throw new Error('Invalid job capabilities');
  return {
    os: input.os,
    ...(input.architecture ? { architecture: input.architecture } : {}),
    capabilities: [...new Set(capabilities)],
  };
}
export function eligibleForJob(worker: any, requirements: JobRequirements | null) {
  if (worker.roles?.tasks?.state === 'off') return false;
  if (worker.status !== 'online' || !worker.capabilities.includes('checkpoint-jobs')) return false;
  if (!requirements) return true;
  return (
    worker.platform === { linux: 'linux', macos: 'darwin', windows: 'win32' }[requirements.os] &&
    (!requirements.architecture || worker.architecture === requirements.architecture) &&
    requirements.capabilities.every((c) => worker.capabilities.includes(c))
  );
}
