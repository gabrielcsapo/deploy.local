import { timeReleasePart, type WorkerReleasePart } from './release-progress.ts';
import { execFile } from 'node:child_process';
import { uncopyableResources } from './release-shared-data.ts';
import { copyAppData } from './release-copy.ts';
import { missesToFail } from '../../v2/health.ts';
import { promisify } from 'node:util';
import { inspectUploadArchive } from '../../upload-archive.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { decryptSecret, encryptSecret, loadOrCreateSecretKey } from '../../secrets.ts';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  executeAgentApplicationGraph,
  graphResourceDirectory,
  type AgentApplicationGraphPayload,
  type AgentGraphDocker,
  type AgentGraphExecutionResult,
  type AgentGraphExecutionInput,
} from '../../agent-graph-runtime.ts';

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
  verifyEmptyResources?: string[];
  active?: AgentGraphExecutionResult;
  port?: number | null;
  jobs: string[][];
  completed: number;
  running?: number;
  reversed?: string[];
  reversing?: string;
  watchMisses?: Record<string, number>;
  watchMissingSince?: Record<string, number>;
};
export type ReleaseNodeResult = {
  parts?: WorkerReleasePart[];
  verifyEmptyResources?: string[];
  phase: NodeReceipt['phase'];
  verified: boolean;
  result?: AgentGraphExecutionResult;
  port?: number | null;
  backupId?: string;
  images?: Record<string, string>;
};

/** Node-local durable barrier. A Verify job never changes the live app's relay or data. */
type ReleaseNodeInput = {
  root: string;
  application: string;
  payload: ReleaseNodePayload;
  docker: AgentGraphDocker;
  sourceDirectory?: string;
  relay?: (name: string, port: number, container: string) => Promise<number>;
  workerProbeMs?: number;
  /** How long an app must have been silent before Watch reports it (default one minute). */
  watchSilenceMs?: number;
  probePort?: AgentGraphExecutionInput['probePort'];
  /** Image pull and build output, as Docker prints it. */
  onBuildOutput?: AgentGraphExecutionInput['onBuildOutput'];
  onProgress?: (parts: WorkerReleasePart[]) => void | Promise<void>;
};

/** One heartbeat covers downloads, long copies, Docker operations and cleanup. */
async function withReleaseProgress(
  input: Pick<ReleaseNodeInput, 'onProgress'>,
  run: (
    onPart: (name: WorkerReleasePart['name'], state: 'start' | 'end') => void,
  ) => Promise<ReleaseNodeResult>,
): Promise<ReleaseNodeResult> {
  const parts: WorkerReleasePart[] = [];
  let pending = Promise.resolve();
  const report = () => {
    const snapshot = structuredClone(parts);
    // A lost progress request must not abort work that can still leave a durable receipt.
    pending = pending
      .then(() => input.onProgress?.(snapshot))
      .then(
        () => {},
        () => {},
      );
  };
  const onPart = (name: WorkerReleasePart['name'], state: 'start' | 'end') => {
    if (state === 'start') parts.push({ name, startedAt: new Date().toISOString() });
    else {
      const part = parts.findLast((candidate) => candidate.name === name && !candidate.endedAt);
      if (part) part.endedAt = new Date().toISOString();
    }
    report();
  };
  report();
  const timer = setInterval(report, 30_000);
  timer.unref();
  try {
    const result = await run(onPart);
    return { ...result, parts };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { parts });
  } finally {
    clearInterval(timer);
    report();
    await pending;
  }
}

export function executeReleaseNodeJob(input: ReleaseNodeInput): Promise<ReleaseNodeResult> {
  return withReleaseProgress(input, (onPart) => executeReleaseNode(input, onPart));
}

async function executeReleaseNode(
  input: ReleaseNodeInput,
  onPart: (name: WorkerReleasePart['name'], state: 'start' | 'end') => void,
): Promise<ReleaseNodeResult> {
  const { payload, docker, application } = input;
  const copyData = (source: string, target: string) =>
    timeReleasePart(onPart, 'copy data', () => copyAppData(source, target));
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
  // The copied data goes with the containers that ran on it. Nothing reads it after Verify, and
  // a kept copy pins every block the live app has since rewritten, once per release.
  async function removeCopy() {
    for (const name of await containers(temporaryName)) await command(['rm', '-f', name]);
    await rm(copy, { recursive: true, force: true });
    // Every release verifies under a new name, so a network left behind is never reused and
    // Docker runs out of address pools after enough releases.
    const networks = await command([
      'network',
      'ls',
      '--filter',
      `label=deploy-sh.app=${temporaryName}`,
      '--format',
      '{{.Name}}',
    ]);
    for (const name of networks.stdout.trim().split('\n').filter(Boolean))
      await command(['network', 'rm', name]);
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
    await mkdir(volumes, { recursive: true });
    record.verifyEmptyResources = [];
    if (payload.backupId && payload.backupReleaseId) {
      const backupKey = createHash('sha256')
        .update(`${payload.backupReleaseId}:${application}`)
        .digest('hex')
        .slice(0, 20);
      await copyData(
        join(input.root, 'project-releases', backupKey, `backup-${payload.backupId}`),
        copy,
      );
    } else {
      record.verifyEmptyResources = Object.entries(record.graph.spec.resources)
        .filter(([, resource]) => resource.verify === 'empty')
        .map(([name]) => name);
      const empty = new Set(
        record.verifyEmptyResources.map((name) => graphResourceDirectory(volumes, name)),
      );
      const copies: string[] = [];
      // Only descend into ancestors of omitted resources (normally graph/). Unknown entries
      // and whole copied resources retain copyAppData's cloning and symlink behavior.
      const collect = async (dataDirectory: string) => {
        await mkdir(join(copy, relative(volumes, dataDirectory)), { recursive: true });
        for (const entry of await readdir(dataDirectory, { withFileTypes: true })) {
          const dataSource = join(dataDirectory, entry.name);
          if (empty.has(dataSource)) continue;
          if (
            entry.isDirectory() &&
            [...empty].some((emptyPath) => emptyPath.startsWith(dataSource + sep))
          )
            await collect(dataSource);
          else copies.push(dataSource);
        }
      };
      await collect(volumes);
      for (const name of record.verifyEmptyResources)
        await mkdir(graphResourceDirectory(copy, name), { recursive: true, mode: 0o700 });
      // Keep one timing for the complete copy, and none when all data is intentionally empty.
      if (copies.length || !empty.size)
        await timeReleasePart(onPart, 'copy data', async () => {
          for (const dataSource of copies)
            await copyAppData(dataSource, join(copy, relative(volumes, dataSource)));
        });
    }
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
        onBuildOutput: input.onBuildOutput,
        onPart,
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
          onBuildOutput: input.onBuildOutput,
          onPart,
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
    await copyData(volumes, join(directory, `backup-${backupId}`));
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
    await copyData(join(input.root, 'project-releases', backupKey, `backup-${backupId}`), restore);
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
    let unhealthy = false;
    for (const instance of record.active.instances) {
      const state = await command([
        'inspect',
        '--format',
        '{{.State.Running}}',
        instance.containerName,
      ]);
      if (state.stdout.trim() !== 'true') throw new Error(`${application} stopped during Watch`);
      const component = record.graph.execution.components[instance.component];
      // Use the same endpoint and target-local port as waitForGraphHealth. Non-HTTP
      // checks keep Watch's container-only behavior, including profiled services.
      const endpoint = component.health
        ? component.interfaces[component.health.interface]
        : Object.values(component.interfaces)[0];
      if (!endpoint || (endpoint.protocol !== 'http' && endpoint.protocol !== 'https')) continue;
      const port =
        component.runtime.networkMode === 'host'
          ? endpoint.port
          : instance.hostPorts[endpoint.port];
      const healthy =
        !!port &&
        (await probeWatchHttp(port, endpoint.protocol, component.health?.path, input.probePort));
      const misses = (record.watchMisses ??= {});
      const since = (record.watchMissingSince ??= {});
      misses[instance.id] = healthy ? 0 : Math.min((misses[instance.id] ?? 0) + 1, missesToFail);
      if (healthy) delete since[instance.id];
      else since[instance.id] ??= Date.now();
      // The coordinator asks every five seconds, so three misses alone is fifteen seconds: an
      // app busy with one long query would be rolled back. It must also have been silent a minute.
      unhealthy ||=
        misses[instance.id] >= missesToFail &&
        Date.now() - since[instance.id] >= (input.watchSilenceMs ?? 60_000);
    }
    // Persist even the failing sample, so retries and worker restarts keep the streak.
    await persist();
    if (unhealthy) throw new Error(`${application} did not answer its health check`);
  }
  return {
    phase: record.phase,
    verified: !!record.verified,
    ...(payload.phase === 'verify'
      ? { verifyEmptyResources: record.verifyEmptyResources ?? [] }
      : {}),
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

/** One bounded sample, rather than the graph gate's startup retry loop. */
async function probeWatchHttp(
  port: number,
  protocol: string,
  declaredPath: string | undefined,
  probePort: AgentGraphExecutionInput['probePort'],
): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
          controller.abort();
        }, 3000);
      }),
      (async () => {
        if (probePort) return probePort(port, protocol, declaredPath ?? '/');
        const response = await fetch(`${protocol}://127.0.0.1:${port}${declaredPath ?? '/'}`, {
          redirect: 'manual',
          signal: controller.signal,
        });
        return response.status >= 200 && response.status < (declaredPath ? 300 : 500);
      })(),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
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
  /** How long an app must have been silent before Watch reports it (default one minute). */
  watchSilenceMs?: number;
  onBuildOutput?: AgentGraphExecutionInput['onBuildOutput'];
  onProgress?: ReleaseNodeInput['onProgress'];
}) {
  return withReleaseProgress(input, async (onPart) => {
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
      return await executeReleaseNode(
        {
          ...input,
          application: input.job.deploymentName,
          payload: input.job.payload,
          sourceDirectory: directory ? join(directory, 'source') : undefined,
        },
        onPart,
      );
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });
}
