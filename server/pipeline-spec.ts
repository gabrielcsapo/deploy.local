export type PipelineJob = {
  run: string;
  runsOn: { os: 'linux' | 'macos'; architecture?: string; capabilities: string[] };
  needs: string[];
  timeoutSeconds: number;
  container?: string;
};
export type PipelineSpec = {
  on: ('manual' | 'push' | 'pull_request')[];
  branches: string[];
  jobs: Record<string, PipelineJob>;
  deploy?: { application: string; path?: string };
};
const namePattern = /^[a-z][a-z0-9-]{0,62}$/;
function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be a mapping`);
  return value as Record<string, any>;
}
function keys(value: Record<string, any>, allowed: string[], label: string) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`);
}
function strings(value: unknown, label: string, maximum = 32): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((item) => typeof item !== 'string' || !item || item.length > 200)
  )
    throw new Error(`${label} must be a list of at most ${maximum} nonempty strings`);
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
  return [...value].sort();
}
export function compilePipeline(value: unknown): PipelineSpec {
  const input = object(value, 'pipeline');
  keys(input, ['on', 'branches', 'jobs', 'deploy'], 'pipeline');
  const on = strings(input.on ?? ['manual'], 'pipeline.on');
  if (!on.length || on.some((event) => !['manual', 'push', 'pull_request'].includes(event)))
    throw new Error('pipeline.on supports manual, push and pull_request');
  const branches = strings(input.branches ?? [], 'pipeline.branches');
  if (
    branches.some(
      (branch) => branch.startsWith('-') || /[\s~^:?*[\\]/.test(branch) || branch.includes('..'),
    )
  )
    throw new Error('pipeline.branches requires exact branch names');
  const rawJobs = object(input.jobs, 'pipeline.jobs');
  if (!Object.keys(rawJobs).length || Object.keys(rawJobs).length > 32)
    throw new Error('pipeline.jobs requires 1–32 jobs');
  const jobs: PipelineSpec['jobs'] = {};
  for (const name of Object.keys(rawJobs).sort()) {
    if (!namePattern.test(name) || ['constructor', 'prototype'].includes(name))
      throw new Error(`Invalid pipeline job name: ${name}`);
    const job = object(rawJobs[name], `pipeline.jobs.${name}`);
    keys(job, ['run', 'runsOn', 'needs', 'timeoutSeconds', 'container'], `pipeline.jobs.${name}`);
    if (typeof job.run !== 'string' || !job.run.trim() || job.run.length > 16000)
      throw new Error(`Job ${name} requires a command of at most 16000 characters`);
    const runsOn = object(job.runsOn, `${name}.runsOn`);
    keys(runsOn, ['os', 'architecture', 'capabilities'], `${name}.runsOn`);
    if (!['linux', 'macos'].includes(runsOn.os))
      throw new Error(`${name}.runsOn.os must be linux or macos; Windows execution is deferred`);
    if (runsOn.architecture !== undefined && !['arm64', 'x64'].includes(runsOn.architecture))
      throw new Error(`${name}: architecture must be arm64 or x64`);
    const capabilities = strings(runsOn.capabilities ?? [], `${name}.capabilities`);
    if (capabilities.some((c) => !/^[a-z0-9_-]{1,64}$/.test(c)))
      throw new Error(`${name}: invalid capability`);
    if (job.container !== undefined) {
      if (
        runsOn.os !== 'linux' ||
        typeof job.container !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]{0,255}$/.test(job.container)
      )
        throw new Error(`${name}: container requires Linux and a valid image name`);
      if (!capabilities.includes('docker')) capabilities.push('docker');
    }
    const timeoutSeconds = job.timeoutSeconds ?? 900;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600)
      throw new Error(`${name}: timeoutSeconds must be 1–3600`);
    jobs[name] = {
      run: job.run,
      runsOn: {
        os: runsOn.os,
        ...(runsOn.architecture ? { architecture: runsOn.architecture } : {}),
        capabilities: capabilities.sort(),
      },
      needs: strings(job.needs ?? [], `${name}.needs`),
      timeoutSeconds,
      ...(job.container ? { container: job.container } : {}),
    };
  }
  const visited = new Set<string>(),
    visiting = new Set<string>();
  const visit = (name: string) => {
    if (!Object.hasOwn(jobs, name)) throw new Error(`Unknown pipeline dependency ${name}`);
    if (visiting.has(name)) throw new Error(`Pipeline dependency cycle at ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    jobs[name].needs.forEach(visit);
    visiting.delete(name);
    visited.add(name);
  };
  Object.keys(jobs).forEach(visit);
  let deploy: PipelineSpec['deploy'];
  if (input.deploy !== undefined) {
    const target = object(input.deploy, 'pipeline.deploy');
    keys(target, ['application', 'path'], 'pipeline.deploy');
    if (typeof target.application !== 'string' || !namePattern.test(target.application))
      throw new Error('pipeline.deploy.application must name an application');
    if (
      target.path !== undefined &&
      (typeof target.path !== 'string' ||
        !target.path ||
        target.path.startsWith('/') ||
        target.path.includes('\\') ||
        target.path.includes('\0') ||
        target.path.split('/').includes('..'))
    )
      throw new Error('pipeline.deploy.path must be a repository subdirectory');
    deploy = {
      application: target.application,
      ...(target.path !== undefined ? { path: target.path } : {}),
    };
  }
  return { on: on as PipelineSpec['on'], branches, jobs, ...(deploy ? { deploy } : {}) };
}
