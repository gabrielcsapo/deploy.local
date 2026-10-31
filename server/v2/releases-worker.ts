import { execFile } from 'node:child_process';
import { uncopyableResources } from './release-shared-data.ts';
import { copyAppData } from './release-copy.ts';
import { promisify } from 'node:util';
import { inspectUploadArchive } from '../upload-archive.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { decryptSecret, encryptSecret, loadOrCreateSecretKey } from '../secrets.ts';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  executeAgentApplicationGraph,
  type AgentApplicationGraphPayload,
  type AgentGraphDocker,
  type AgentGraphExecutionResult,
  type AgentGraphExecutionInput,
} from '../agent-graph-runtime.ts';

export type ReleaseNodePhase =
  | 'prepare'
  | 'verify'
  | 'quiesce'
  | 'activate'
  | 'migrate'
  | 'abort'
  | 'status'
  | 'watch'
  | 'backup'
  | 'restore'
  | 'reverse'
  | 'recover';
export type ReleaseNodePayload = {
  version: 1;
  releaseId: string;
  phase: ReleaseNodePhase;
  graph?: AgentApplicationGraphPayload;
  skipMigrations?: boolean;
  reverse?: Record<string, string[]>;
  data?: 'keep' | 'new';
  backupId?: string;
  backupReleaseId?: string;
  images?: Record<string, string>;
};
type NodeReceipt = {
  phase: 'prepared' | 'verified' | 'quiesced' | 'activating' | 'activated' | 'aborted';
  previous: string[];
  graph: AgentApplicationGraphPayload;
  verified?: AgentGraphExecutionResult;
  active?: AgentGraphExecutionResult;
  port?: number | null;
  jobs: string[][];
  completed: number;
  running?: number;
  reversed?: string[];
  reversing?: string;
};
export type ReleaseNodeResult = {
  phase: NodeReceipt['phase'];
  verified: boolean;
  result?: AgentGraphExecutionResult;
  port?: number | null;
  backupId?: string;
  images?: Record<string, string>;
};

/** Node-local durable barrier. A Verify job never changes the live app's relay or data. */
export async function executeReleaseNodeJob(input: {
  root: string;
  application: string;
  payload: ReleaseNodePayload;
  docker: AgentGraphDocker;
  sourceDirectory?: string;
  relay?: (name: string, port: number, container: string) => Promise<number>;
  workerProbeMs?: number;
  probePort?: AgentGraphExecutionInput['probePort'];
}): Promise<ReleaseNodeResult> {
  const { payload, docker, application } = input;
  if (
    payload.version !== 1 ||
    !/^[a-zA-Z0-9_-]+$/.test(payload.releaseId) ||
    !/^[a-zA-Z0-9_-]+$/.test(application)
  )
    throw new Error('Invalid project release job');
  const key = createHash('sha256')
    .update(`${payload.releaseId}:${application}`)
    .digest('hex')
    .slice(0, 20);
  const directory = join(input.root, 'project-releases', key);
  const path = join(directory, 'receipt.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let receipt: NodeReceipt | undefined;
  try {
    receipt = JSON.parse(
      decryptSecret(
        await readFile(path, 'utf8'),
        loadOrCreateSecretKey(input.root),
        `release:${key}`,
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  async function persist() {
    await writeFile(
      `${path}.tmp`,
      encryptSecret(JSON.stringify(receipt), loadOrCreateSecretKey(input.root), `release:${key}`),
      { mode: 0o600, flush: true },
    );
    await rename(`${path}.tmp`, path);
  }
  async function command(args: string[]) {
    const result = await docker.run(args);
    if (result.exitCode !== 0)
      throw new Error(`Release computer operation failed: ${result.stderr || args[0]}`);
    return result;
  }
  const volumes = join(input.root, 'volumes', application);
  const copy = join(directory, 'data');
  const source = join(directory, 'source');
  const temporaryName = `verify-${key}`;
  async function containers(name: string) {
    const result = await command([
      'ps',
      '-a',
      '--filter',
      `label=deploy-sh.app=${name}`,
      '--format',
      '{{.Names}}',
    ]);
    return result.stdout.trim().split('\n').filter(Boolean);
  }
  async function removeCopy() {
    for (const name of await containers(temporaryName)) await command(['rm', '-f', name]);
  }
  if (payload.phase === 'prepare') {
    if (!receipt) {
      if (!payload.graph || !input.sourceDirectory)
        throw new Error('Release source and admitted graph required');
      for (const component of Object.values(payload.graph.spec.components)) {
        if (
          component.runtime.networkMode === 'host' ||
          component.runtime.privileged ||
          component.runtime.privilegedDocker ||
          component.runtime.devices.length ||
          component.runtime.networks.length
        )
          throw new Error('Verify requires an isolated graph');
      }
      if (
        payload.graph.runtimeVolumeMounts?.length ||
        uncopyableResources(payload.graph.spec).length
      )
        throw new Error('Verify cannot copy external data');
      await cp(input.sourceDirectory, source, { recursive: true });
      receipt = { phase: 'prepared', previous: [], graph: payload.graph, jobs: [], completed: 0 };
      for (const [name, image] of Object.entries(payload.images || {}))
        receipt.graph.execution.components[name].source = { kind: 'image', reference: image };
      await persist();
    }
    if (receipt.phase === 'aborted') throw new Error('This release was aborted');
  } else if (!receipt) {
    if (payload.phase === 'abort') return { phase: 'aborted', verified: false };
    throw new Error('Prepare this project release first');
  }
  const record = receipt!;
  if (payload.phase === 'verify' && record.phase === 'prepared') {
    await removeCopy();
    await rm(copy, { recursive: true, force: true });
    await mkdir(volumes, { recursive: true });
    if (payload.backupId && payload.backupReleaseId) {
      const backupKey = createHash('sha256')
        .update(`${payload.backupReleaseId}:${application}`)
        .digest('hex')
        .slice(0, 20);
      await copyAppData(
        join(input.root, 'project-releases', backupKey, `backup-${payload.backupId}`),
        copy,
      );
    } else await copyAppData(volumes, copy);
    const graph = structuredClone(record.graph);
    graph.applicationId = temporaryName;
    if (payload.skipMigrations && !payload.backupId) graph.spec.jobs = {};
    // The copy runs on an internal network with no route out, and its lifecycle jobs run only
    // against copied data.
    const result = await executeAgentApplicationGraph(
      {
        deploymentName: temporaryName,
        jobId: `${key}-verify`,
        sourceDirectory: source,
        volumeDirectory: copy,
        statePath: join(directory, 'verify-jobs.json'),
        artifactSpecDigest: graph.specDigest,
        artifactSpec: graph.spec,
        graph,
        probePort: input.probePort,
        internalNetwork: true,
      },
      docker,
    );
    for (const instance of result.instances) {
      const component = graph.execution.components[instance.component];
      if (component.role === 'worker') {
        await delay(input.workerProbeMs ?? 5000);
        const state = await command([
          'inspect',
          '--format',
          '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
          instance.containerName,
        ]);
        if (
          !state.stdout.startsWith('true') ||
          (!component.health && !state.stdout.includes('healthy'))
        )
          throw new Error(`${application} needs a sustained healthy worker`);
      }
      const inspection = await command(['image', 'inspect', '--format', '{{.Id}}', instance.image]);
      const image = inspection.stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(image))
        throw new Error('Prepared image digest unavailable');
      record.graph.execution.components[instance.component].source = {
        kind: 'image',
        reference: image,
      };
    }
    record.verified = result;
    record.phase = 'verified';
    await persist();
    await removeCopy();
  }
  if (payload.phase === 'quiesce' && record.phase === 'verified') {
    record.previous = await containers(application);
    // Persist before stopping anything; a replay continues from the same original processes.
    record.phase = 'quiesced';
    await persist();
  }
  if (payload.phase === 'quiesce' && record.phase === 'quiesced') {
    for (const name of record.previous) await command(['stop', name]);
  }
  if (payload.phase === 'activate') {
    if (!['quiesced', 'activating', 'activated'].includes(record.phase))
      throw new Error('Every app must verify and reach the activation barrier first');
    if (record.phase === 'activating')
      throw new Error('Activation was interrupted; recover this release before retrying');
    if (record.phase === 'quiesced') {
      record.phase = 'activating';
      await persist();
      record.active = await executeAgentApplicationGraph(
        {
          deploymentName: application,
          jobId: key,
          sourceDirectory: source,
          volumeDirectory: volumes,
          statePath: join(directory, 'active-jobs.json'),
          graph: record.graph,
          artifactSpecDigest: record.graph.specDigest,
          artifactSpec: record.graph.spec,
          probePort: input.probePort,
        },
        {
          run: async (args, options) => {
            if (args[0] === 'rm' && record.previous.includes(args.at(-1)!))
              return { exitCode: 0, stdout: '', stderr: '' };
            if (args[0] === 'run' && args.some((arg) => arg.startsWith('deploy-sh.job='))) {
              if (!payload.skipMigrations) {
                record.jobs.push([...args]);
                await persist();
              }
              return { exitCode: 0, stdout: 'Waiting for project activation', stderr: '' };
            }
            return docker.run(args, options);
          },
        },
      );
      record.port = record.active.primaryDockerPort;
      if (record.port && input.relay)
        record.port = await input.relay(
          `release-${key}`,
          record.port,
          record.active.primaryContainerName!,
        );
      record.phase = 'activated';
      await persist();
    }
  }
  if (payload.phase === 'migrate') {
    if (record.phase !== 'activated') throw new Error('Project activation is not complete');
    while (record.completed < record.jobs.length) {
      if (record.running === record.completed)
        throw new Error('Migration outcome is uncertain; restore the pre-release backup');
      record.running = record.completed;
      await persist();
      await command(record.jobs[record.completed]);
      record.completed++;
      delete record.running;
      await persist();
    }
  }
  if (payload.phase === 'backup') {
    const backupId = payload.backupId;
    if (!backupId || !/^[a-zA-Z0-9_-]+$/.test(backupId)) throw new Error('Backup id required');
    await copyAppData(volumes, join(directory, `backup-${backupId}`));
  }
  if (payload.phase === 'restore') {
    const backupId = payload.backupId;
    if (!backupId || !/^[a-zA-Z0-9_-]+$/.test(backupId)) throw new Error('Backup id required');
    for (const name of await containers(application)) await command(['stop', name]);
    const backupKey = createHash('sha256')
      .update(`${payload.backupReleaseId || payload.releaseId}:${application}`)
      .digest('hex')
      .slice(0, 20);
    const restore = join(directory, 'restored-data');
    await rm(restore, { recursive: true, force: true });
    await copyAppData(
      join(input.root, 'project-releases', backupKey, `backup-${backupId}`),
      restore,
    );
    await rm(volumes, { recursive: true, force: true });
    await rename(restore, volumes);
  }
  if (payload.phase === 'reverse') {
    for (const [name, reverse] of Object.entries(payload.reverse || {})) {
      if (record.reversed?.includes(name)) continue;
      if (record.reversing === name) throw new Error('Reverse migration outcome is uncertain');
      const args = record.jobs.find((job) => job.includes(`deploy-sh.job=${name}`));
      if (!args || !record.graph.spec.jobs[name] || !reverse.length)
        throw new Error('Reverse migration receipt unavailable');
      record.reversing = name;
      await persist();
      await command([...args.slice(0, -record.graph.spec.jobs[name].command.length), ...reverse]);
      record.reversed = [...(record.reversed || []), name];
      delete record.reversing;
      await persist();
    }
  }
  if (payload.phase === 'recover' && record.phase === 'activating') {
    for (const name of await containers(application))
      if (!record.previous.includes(name)) await command(['rm', '-f', name]);
    record.phase = 'quiesced';
    await persist();
  }
  if (payload.phase === 'abort') {
    const previous = new Set(record.previous);
    if (['quiesced', 'activating', 'activated'].includes(record.phase)) {
      for (const name of await containers(application))
        if (!previous.has(name)) await command(['rm', '-f', name]);
      for (const name of record.previous) await command(['start', name]);
    }
    await removeCopy();
    record.phase = 'aborted';
    await persist();
  }
  if (payload.phase === 'watch') {
    if (!record.active || record.phase !== 'activated') throw new Error('Release is not active');
    for (const instance of record.active.instances) {
      const state = await command([
        'inspect',
        '--format',
        '{{.State.Running}}',
        instance.containerName,
      ]);
      if (state.stdout.trim() !== 'true') throw new Error(`${application} stopped during Watch`);
    }
  }
  return {
    phase: record.phase,
    verified: !!record.verified,
    result: record.active,
    port: record.port,
    images: Object.fromEntries(
      Object.entries(record.graph.execution.components)
        .filter(([, component]) => component.source.kind === 'image')
        .map(([name, component]) => [
          name,
          component.source.kind === 'image' ? component.source.reference : '',
        ]),
    ),
    ...(payload.phase === 'backup' ? { backupId: payload.backupId } : {}),
  };
}

/** Thin adapter for the installed worker's existing authenticated artifact and Docker transports. */
export async function executeReleaseAgentJob(input: {
  root: string;
  job: { deploymentName: string; payload: ReleaseNodePayload; artifactUrl?: string | null };
  download: (path: string) => Promise<unknown>;
  docker: AgentGraphDocker;
  relay: NonNullable<Parameters<typeof executeReleaseNodeJob>[0]['relay']>;
  probePort?: AgentGraphExecutionInput['probePort'];
  workerProbeMs?: number;
}) {
  let directory: string | undefined;
  try {
    if (input.job.artifactUrl) {
      await mkdir(join(input.root, 'project-releases'), { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(input.root, 'project-releases', 'download-'));
      const archive = join(directory, 'source.tar.gz');
      await input.download(archive);
      await inspectUploadArchive(archive);
      await mkdir(join(directory, 'source'));
      await promisify(execFile)('tar', ['-xzf', archive, '-C', join(directory, 'source')]);
    }
    return await executeReleaseNodeJob({
      ...input,
      application: input.job.deploymentName,
      payload: input.job.payload,
      sourceDirectory: directory ? join(directory, 'source') : undefined,
    });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
