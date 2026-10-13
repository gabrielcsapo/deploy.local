import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join, resolve, sep } from 'node:path';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dockerRequest,
  apiRenameContainer,
  apiStartContainer,
  apiStopContainer,
  apiRemoveContainer,
} from './docker-api.ts';
import { deployDataPath } from './data-directory.ts';
import {
  assertLegacyUpdateEligible,
  runLegacyPreservingUpdate,
  type LegacySnapshot,
  type LegacyUpdateRuntime,
} from './legacy-preserving-update.ts';

const exec = promisify(execFile);
interface Inspection {
  Id: string;
  Image: string;
  Name: string;
  State: { Running: boolean };
  Config: { Image: string; Env: string[]; Labels?: Record<string, string>; [key: string]: unknown };
  HostConfig: {
    AutoRemove?: boolean;
    NetworkMode: string;
    Binds?: string[];
    [key: string]: unknown;
  };
  Mounts: Array<{ Source: string; Destination: string; RW: boolean; Type: string }>;
  NetworkSettings: {
    Ports: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    Networks: Record<string, { IPAMConfig?: unknown; Aliases?: string[]; [key: string]: unknown }>;
  };
}
type Phase =
  | 'prepared'
  | 'stopped'
  | 'snapshot'
  | 'starting'
  | 'ready'
  | 'committed'
  | 'rolling-back'
  | 'rolled-back';
export interface LegacyJournal {
  version: 1;
  id: string;
  phase: Phase;
  containerName: string;
  oldName: string;
  old: Inspection;
  runtime: LegacyUpdateRuntime;
  newImage: string;
  candidateId?: string;
  snapshot?: LegacySnapshot;
  rollbackSafetySnapshot?: LegacySnapshot;
  metadata: Record<string, unknown>;
  sourceDigest: string;
  sshFingerprint?: string;
}

export function legacyRecoveryRoot(name: string) {
  return deployDataPath('legacy-updates', name);
}
export function legacyUpdateProtected(name: string) {
  name = name.toLowerCase();
  return (
    name === 'groffee' &&
    (existsSync(join(legacyRecoveryRoot(name), 'journal.json')) ||
      existsSync(join(legacyRecoveryRoot(name), 'legacy-update.lock')))
  );
}
export function legacyUpdateLocked(name: string) {
  return existsSync(join(legacyRecoveryRoot(name), 'legacy-update.lock'));
}

export function assertLegacyMutationAllowed(name: string) {
  if (legacyUpdateProtected(name))
    throw Object.assign(
      new Error(
        'Groffee legacy state is protected; use authenticated legacy update/recover/rollback',
      ),
      { status: 409 },
    );
}

function stable(value: unknown): string {
  const canonical = (item: any): any =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, canonical(item[key])]),
          )
        : item;
  return JSON.stringify(canonical(value));
}
function settings(info: Inspection) {
  const { Image: _image, ...config } = info.Config;
  return createHash('sha256')
    .update(
      stable({
        config,
        host: info.HostConfig,
        networks: Object.keys(info.NetworkSettings.Networks).sort(),
      }),
    )
    .digest('hex');
}
async function inspect(name: string): Promise<Inspection> {
  return dockerRequest({ method: 'GET', path: `/containers/${encodeURIComponent(name)}/json` });
}
async function maybeInspect(name: string) {
  try {
    return await inspect(name);
  } catch (error: any) {
    if (error.status === 404) return null;
    throw error;
  }
}
function durableWrite(path: string, value: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const directory = openSync(resolve(path, '..'), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
async function stopped(id: string) {
  await apiStopContainer(id);
  if ((await inspect(id)).State.Running) throw new Error('Writer stop not confirmed');
}
async function fingerprint(port: string | number) {
  const result = await exec(
    'ssh-keyscan',
    ['-T', '2', '-p', String(port), '-t', 'ed25519,rsa,ecdsa', '127.0.0.1'],
    { timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  const keys = [
    ...new Set(
      result.stdout
        .split('\n')
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => line.trim().split(/\s+/).slice(1).join(' ')),
    ),
  ].sort();
  if (!keys.length) throw new Error('SSH host identity unavailable');
  return createHash('sha256').update(keys.join('\n')).digest('hex');
}

export interface LegacyDockerOptions {
  containerName: string;
  volumeDirectory: string;
  recoveryRoot: string;
  httpPort: number;
  publicSshPort: number;
  administrator: boolean;
  owner: boolean;
  nodeId: string;
  activeGraphDigest: string | null;
  metadata: Record<string, unknown>;
  sourceDigest: string;
  sshFingerprint?: string;
  guard?(): void;
  build(): Promise<string>;
  commit(containerId: string, snapshot: LegacySnapshot): Promise<void>;
  restoreMetadata(metadata: Record<string, unknown>, containerId: string): Promise<void>;
}

/** Exact-runtime cloning, single writer, durable journal. No mount/network or
 * security configuration from the uploaded graph is applied. */
const activeRoots = new Set<string>();
export class LegacyDockerUpdate {
  readonly options: LegacyDockerOptions;
  constructor(options: LegacyDockerOptions) {
    this.options = options;
  }
  private get journalPath() {
    return join(this.options.recoveryRoot, 'journal.json');
  }
  readJournal(): LegacyJournal | null {
    return existsSync(this.journalPath) ? JSON.parse(readFileSync(this.journalPath, 'utf8')) : null;
  }
  private write(journal: LegacyJournal) {
    durableWrite(this.journalPath, journal);
  }
  status() {
    const journal = this.readJournal();
    return {
      supported: true,
      locked: existsSync(join(this.options.recoveryRoot, 'legacy-update.lock')),
      phase: journal?.phase ?? null,
      releaseId: journal?.id ?? null,
      imageId: journal?.phase === 'rolled-back' ? journal.old.Image : (journal?.newImage ?? null),
      snapshot: journal?.snapshot
        ? {
            id: basename(journal.snapshot.directory),
            archiveDigest: journal.snapshot.archiveDigest,
            contentsDigest: journal.snapshot.contentsDigest,
          }
        : null,
      rollbackImageId: journal?.old.Image ?? null,
    };
  }
  private helper(action: 'validate', image: string): Promise<string>;
  private helper(action: 'snapshot', image: string): Promise<LegacySnapshot>;
  private helper(
    action: 'verify' | 'restore',
    image: string,
    snapshot: LegacySnapshot,
  ): Promise<undefined>;
  private async helper(
    action: 'validate' | 'snapshot' | 'verify' | 'restore',
    image: string,
    snapshot?: LegacySnapshot,
  ): Promise<LegacySnapshot | string | undefined> {
    if (action === 'snapshot' || action === 'restore') await this.assertNoOtherWriters();
    mkdirSync(this.options.recoveryRoot, { recursive: true, mode: 0o700 });
    const script = join(this.options.recoveryRoot, `helper-${randomUUID()}.mjs`);
    const helperSource = readFileSync(new URL('./legacy-snapshot.mjs', import.meta.url), 'utf8');
    const mapped = snapshot
      ? { ...snapshot, directory: `/recovery/${basename(snapshot.directory)}` }
      : undefined;
    const runner = `\nimport {chownSync} from 'node:fs';\nconst action=${JSON.stringify(action)}; const snap=${JSON.stringify(mapped) || 'null'};\nlet result; if(action==='validate'){assertExistingLegacyData('/source');console.log(JSON.stringify({identityDigest:legacyHostIdentityDigest('/source')}));} if(action==='snapshot')result=snapshotStoppedLegacyData('/source','/recovery'); if(action==='verify')verifyLegacySnapshot(snap); if(action==='restore')restoreStoppedLegacyData('/source',snap);\nif(result){for(const p of [result.directory,result.directory+'/data.tar',result.directory+'/snapshot.json'])chownSync(p,${process.getuid?.() ?? 0},${process.getgid?.() ?? 0}); console.log(JSON.stringify(result));}\n`;
    writeFileSync(script, helperSource + runner, { mode: 0o600, flag: 'wx' });
    const helperName = `deploy-legacy-helper-${randomUUID()}`;
    const helperRecord = join(this.options.recoveryRoot, `${helperName}.json`);
    durableWrite(helperRecord, { name: helperName, action, image, script });
    let outputSnapshot: LegacySnapshot | string | undefined;
    let failure: unknown;
    try {
      const result = await exec(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          helperName,
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--cap-add',
          'DAC_OVERRIDE',
          '--cap-add',
          'CHOWN',
          '--cap-add',
          'FOWNER',
          '--security-opt',
          'no-new-privileges',
          '--label',
          'deploy.local.legacy-helper=true',
          '--mount',
          `type=bind,source=${this.options.volumeDirectory},target=/source${action === 'restore' ? '' : ',readonly'}`,
          '--mount',
          `type=bind,source=${this.options.recoveryRoot},target=/recovery`,
          '--mount',
          `type=bind,source=${script},target=/helper.mjs,readonly`,
          '-e',
          'NODE_OPTIONS=',
          '-e',
          'NODE_PATH=',
          '--entrypoint',
          'node',
          image,
          '/helper.mjs',
        ],
        { timeout: 15 * 60_000, maxBuffer: 1024 * 1024 },
      );
      if (action === 'validate') {
        const value = JSON.parse(result.stdout.trim());
        if (!/^[a-f0-9]{64}$/.test(value.identityDigest))
          throw new Error('Invalid stored SSH identity digest');
        outputSnapshot = value.identityDigest;
      }
      if (action === 'snapshot') {
        const value = JSON.parse(result.stdout.trim());
        outputSnapshot = {
          ...value,
          directory: join(this.options.recoveryRoot, basename(value.directory)),
        };
      }
    } catch (error) {
      failure = error;
    }
    try {
      // --rm is not sufficient when the CLI loses connection or times out.
      await exec('docker', ['rm', '-f', helperName], { timeout: 10_000 }).catch(() => {});
      rmSync(script, { force: true });
      const remaining = await maybeInspect(helperName);
      if (remaining?.State.Running)
        throw new Error('Helper stop unconfirmed; recovery marker retained');
      rmSync(helperRecord, { force: true });
    } catch (cleanupFailure) {
      const error = new AggregateError(
        [failure, cleanupFailure].filter((value) => value !== undefined),
        'Backup helper cleanup failed; recovery required',
        { cause: failure ?? cleanupFailure },
      );
      throw error;
    }
    if (failure) throw failure;
    return outputSnapshot;
  }
  private async fenceHelpers() {
    if (!existsSync(this.options.recoveryRoot)) return;
    for (const entry of readdirSync(this.options.recoveryRoot).filter((name) =>
      /^deploy-legacy-helper-[a-f0-9-]+\.json$/.test(name),
    )) {
      const path = join(this.options.recoveryRoot, entry);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      if (
        record.name + '.json' !== entry ||
        resolve(record.script, '..') !== resolve(this.options.recoveryRoot) ||
        !basename(record.script).startsWith('helper-')
      )
        throw new Error('Invalid private helper recovery record');
      rmSync(record.script, { force: true });
      const helper = await maybeInspect(record.name);
      if (helper) {
        if (
          helper.Image !== record.image ||
          helper.Config.Labels?.['deploy.local.legacy-helper'] !== 'true'
        )
          throw new Error('Unexpected helper identity; refusing recovery');
        await apiRemoveContainer(helper.Id);
      }
      if (await maybeInspect(record.name)) throw new Error('Helper removal unconfirmed');
      rmSync(path, { force: true });
    }
  }
  private async assertNoOtherWriters(allowedIds: string[] = []) {
    const roots = ['data', 'uploads', '.ssh-host-keys'].map((name) =>
      join(this.options.volumeDirectory, name),
    );
    const physicalRoots = roots.map((path) => {
      try {
        return realpathSync(path);
      } catch {
        return resolve(path);
      }
    });
    const containers = await dockerRequest<
      Array<{ Id: string; Mounts: Array<{ Type: string; Source: string; RW: boolean }> }>
    >({ method: 'GET', path: '/containers/json?all=false' });
    for (const container of containers) {
      if (allowedIds.includes(container.Id)) continue;
      for (const mount of container.Mounts || []) {
        if (!mount.RW || !mount.Source) continue;
        let source = resolve(mount.Source);
        try {
          source = realpathSync(source);
        } catch {
          /* unrelated private providers need not be opened */
        }
        const contains = (parent: string, child: string) =>
          parent === child || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
        const overlaps = (left: string, right: string) =>
          contains(left, right) || contains(right, left);
        if (
          physicalRoots.some((root) => overlaps(root, source)) ||
          roots.some((root) => overlaps(resolve(root), resolve(mount.Source)))
        )
          throw new Error(
            'Another running container can write legacy data; quiesce application jobs before maintenance',
          );
      }
    }
  }
  private runtime(info: Inspection): LegacyUpdateRuntime {
    if (
      info.HostConfig.AutoRemove ||
      info.HostConfig.NetworkMode.startsWith('container:') ||
      info.Mounts.some((mount) => mount.Type !== 'bind')
    )
      throw new Error('Unsupported legacy container topology');
    return {
      imageId: info.Image,
      containerId: info.Id,
      mounts: info.Mounts.map((mount) => ({
        source: mount.Source,
        destination: mount.Destination,
        readOnly: !mount.RW,
      })),
      ports: Object.fromEntries(
        Object.entries(
          Object.keys(info.NetworkSettings.Ports || {}).length
            ? info.NetworkSettings.Ports
            : (info.HostConfig.PortBindings as Inspection['NetworkSettings']['Ports']),
        )
          .filter(([, ports]) => ports)
          .map(([key, ports]) => [
            key,
            ports.map((port) => ({ hostIp: port.HostIp, hostPort: port.HostPort })),
          ]),
      ),
      environment: info.Config.Env,
      settingsDigest: settings(info),
    };
  }
  async preflight() {
    if (!this.options.owner || !this.options.administrator)
      throw Object.assign(new Error('Owner and administrator required'), { status: 403 });
    this.options.guard?.();
    const info = await inspect(this.options.containerName);
    if (!info.State.Running) throw new Error('Existing legacy writer must be running');
    const runtime = this.runtime(info);
    await this.assertNoOtherWriters([info.Id]);
    assertLegacyUpdateEligible({ ...this.options, runtime });
    if (!runtime.ports['3000/tcp']?.some((port) => Number(port.hostPort) === this.options.httpPort))
      throw new Error('Stored HTTP route does not match existing container');
    const mappings = this.options.metadata.extraPorts;
    if (
      typeof mappings === 'string' &&
      !JSON.parse(mappings).some(
        (mapping: any) =>
          mapping.container === 2223 &&
          runtime.ports['2223/tcp'].some((port) => Number(port.hostPort) === mapping.host),
      )
    )
      throw new Error('Stored public SSH route does not match existing container');
    const persistedIdentity = await this.helper('validate', info.Image);
    await this.healthy(info, persistedIdentity);
    return { info, runtime };
  }
  private async healthy(info: Inspection, expectedFingerprint?: string) {
    const deadline = Date.now() + 30_000;
    let failure: unknown;
    do {
      try {
        if (!(await inspect(info.Id)).State.Running) throw new Error('Writer not running');
        const response = await fetch(`http://127.0.0.1:${this.options.httpPort}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) throw new Error('Application HTTP health failed');
        await response.body?.cancel();
        const backend = this.runtime(info).ports['2223/tcp'][0].hostPort;
        const identities = await Promise.all([
          fingerprint(backend),
          fingerprint(this.options.publicSshPort),
        ]);
        if (
          identities[0] !== identities[1] ||
          (expectedFingerprint && identities[0] !== expectedFingerprint)
        )
          throw new Error('SSH host identity or public route changed');
        return identities[0];
      } catch (error) {
        failure = error;
      }
      await new Promise((done) => setTimeout(done, 250));
    } while (Date.now() < deadline);
    throw new Error('Legacy HTTP/SSH health verification failed', { cause: failure });
  }
  private async verifyCandidate(journal: LegacyJournal, requireHealth = true) {
    const info = await inspect(this.options.containerName);
    if (info.Image !== journal.newImage || (journal.candidateId && info.Id !== journal.candidateId))
      throw new Error('Candidate identity mismatch');
    const runtime = this.runtime(info);
    if (
      stable({ ...runtime, containerId: '', imageId: '' }) !==
      stable({ ...journal.runtime, containerId: '', imageId: '' })
    )
      throw new Error('Candidate runtime settings, mounts or port bindings changed');
    if (requireHealth) await this.healthy(info, journal.sshFingerprint);
    return info;
  }
  private async restoreOld(journal: LegacyJournal) {
    const canonical = await maybeInspect(this.options.containerName);
    if (canonical && canonical.Id !== journal.old.Id) {
      if (
        canonical.Image !== journal.newImage ||
        (journal.candidateId && canonical.Id !== journal.candidateId)
      )
        throw new Error('Unrecognized candidate; refusing recovery');
      await stopped(canonical.Id);
      await apiRemoveContainer(canonical.Id);
    }
    const old = await inspect(journal.old.Id);
    await stopped(old.Id);
    if (
      journal.snapshot &&
      ['starting', 'ready', 'committed', 'rolling-back'].includes(journal.phase)
    )
      await this.helper('restore', old.Image, journal.snapshot);
    if (old.Name !== `/${this.options.containerName}`)
      await apiRenameContainer(old.Id, this.options.containerName);
    await apiStartContainer(old.Id);
    await this.healthy(await inspect(old.Id), journal.sshFingerprint);
    await this.options.restoreMetadata(journal.metadata, old.Id);
    journal.phase = 'rolled-back';
    this.write(journal);
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = resolve(this.options.recoveryRoot);
    if (activeRoots.has(key))
      throw Object.assign(new Error('Legacy operation already active'), { status: 409 });
    activeRoots.add(key);
    try {
      return await operation();
    } finally {
      activeRoots.delete(key);
    }
  }
  async update() {
    return this.exclusive(() => this.executeUpdate());
  }
  private async executeUpdate() {
    if (this.status().locked)
      throw Object.assign(new Error('Legacy recovery required before update'), { status: 409 });
    const previousJournal = this.readJournal();
    if (
      previousJournal?.phase === 'committed' &&
      previousJournal.sourceDigest === this.options.sourceDigest
    ) {
      await this.preflight();
      await this.verifyCandidate(previousJournal);
      return { unchanged: true, releaseId: previousJournal.id };
    }
    const { info, runtime } = await this.preflight();
    const sshFingerprint = await this.healthy(info);
    let journal: LegacyJournal | undefined;
    let newImage = '';
    const recoverySnapshot = await runLegacyPreservingUpdate({
      ...this.options,
      operations: {
        inspect: async () => {
          this.options.guard?.();
          const current = await inspect(info.Id);
          if (stable(this.runtime(current)) !== stable(runtime))
            throw new Error('Legacy runtime drifted after preflight');
          if (!current.State.Running) throw new Error('Previous writer stopped unexpectedly');
          const persistedIdentity = await this.helper('validate', current.Image);
          if (persistedIdentity !== sshFingerprint)
            throw new Error('Persisted SSH host identity changed before maintenance');
          await this.healthy(current, sshFingerprint);
          return this.runtime(current);
        },
        validateData: async () => {
          const persistedIdentity = await this.helper('validate', info.Image);
          await this.healthy(info, persistedIdentity);
        },
        build: async () => {
          newImage = await this.options.build();
          return newImage;
        },
        checkpoint: async (phase, _runtime, snapshot) => {
          journal ??= {
            version: 1,
            id: randomUUID(),
            phase,
            containerName: this.options.containerName,
            oldName: `${this.options.containerName}-legacy-${randomUUID()}`,
            old: info,
            runtime,
            newImage,
            metadata: this.options.metadata,
            sourceDigest: this.options.sourceDigest,
          };
          Object.assign(journal, { phase, sshFingerprint, ...(snapshot ? { snapshot } : {}) });
          this.write(journal);
        },
        stopPrevious: async () => {
          await stopped(info.Id);
        },
        snapshot: async () => (await this.helper('snapshot', info.Image))!,
        restore: async (snapshot) => {
          await this.helper('restore', info.Image, snapshot);
        },
        startCandidate: async (imageId) => {
          journal!.phase = 'starting';
          this.write(journal!);
          await apiRenameContainer(info.Id, journal!.oldName);
          const endpoints = Object.fromEntries(
            Object.entries(info.NetworkSettings.Networks).map(([name, endpoint]) => [
              name,
              {
                IPAMConfig: endpoint.IPAMConfig,
                Aliases: endpoint.Aliases?.filter(
                  (alias) => alias !== info.Id && alias !== info.Id.slice(0, 12),
                ),
              },
            ]),
          );
          const result = await dockerRequest<{ Id: string }>({
            method: 'POST',
            path: `/containers/create?name=${encodeURIComponent(this.options.containerName)}`,
            body: {
              ...info.Config,
              Image: imageId,
              HostConfig: info.HostConfig,
              NetworkingConfig: { EndpointsConfig: endpoints },
            },
          });
          journal!.candidateId = result.Id;
          this.write(journal!);
          await apiStartContainer(result.Id);
        },
        stopCandidate: async () => {
          const candidate = await maybeInspect(this.options.containerName);
          if (candidate && candidate.Id !== info.Id) {
            if (candidate.Image !== newImage) throw new Error('Unrecognized candidate');
            await stopped(candidate.Id);
            await apiRemoveContainer(candidate.Id);
          }
        },
        verifyCandidate: async () => {
          await this.verifyCandidate(journal!);
          journal!.phase = 'ready';
          this.write(journal!);
        },
        commit: async (snapshot) => {
          await this.options.commit(journal!.candidateId!, snapshot);
          journal!.phase = 'committed';
          this.write(journal!);
        },
        startPrevious: async () => {
          const old = await inspect(info.Id);
          if (old.Name !== `/${this.options.containerName}`)
            await apiRenameContainer(info.Id, this.options.containerName);
          await apiStartContainer(info.Id);
        },
        verifyPrevious: async () => {
          await this.healthy(await inspect(info.Id), sshFingerprint);
          await this.options.restoreMetadata(this.options.metadata, info.Id);
          if (journal) {
            journal.phase = 'rolled-back';
            this.write(journal);
          }
        },
      },
    });
    return {
      unchanged: false,
      releaseId: journal!.id,
      snapshot: basename(recoverySnapshot.directory),
      imageId: newImage,
    };
  }
  async recover(rollback = false) {
    return this.exclusive(() => this.executeRecovery(rollback));
  }
  private async executeRecovery(rollback = false) {
    if (!this.options.owner || !this.options.administrator)
      throw Object.assign(new Error('Owner and administrator required'), { status: 403 });
    await this.fenceHelpers();
    const journal = this.readJournal();
    if (!journal) {
      if (rollback) throw new Error('No legacy release to roll back');
      const { info } = await this.preflight();
      if (this.options.metadata.containerId !== info.Id)
        throw new Error('Unjournaled runtime identity changed; manual investigation required');
      await this.healthy(info);
      rmSync(join(this.options.recoveryRoot, 'legacy-update.lock'), { force: true });
      return { recovered: true, unchanged: true };
    }
    if (journal.phase === 'rolled-back' && !this.status().locked) {
      await this.healthy(await inspect(journal.old.Id), journal.sshFingerprint);
      return { recovered: true, rolledBack: true, unchanged: true };
    }
    if (rollback && (journal.phase !== 'committed' || !journal.snapshot))
      throw new Error('No committed legacy release to roll back');
    const lock = join(this.options.recoveryRoot, 'legacy-update.lock');
    if (rollback && existsSync(lock))
      throw new Error('Recover interrupted operation before rollback');
    if (!existsSync(lock)) {
      const fd = openSync(lock, 'wx', 0o600);
      closeSync(fd);
    }
    try {
      if (rollback) {
        if (journal.phase !== 'committed' || !journal.snapshot)
          throw new Error('No committed legacy release to roll back');
        const current = await this.verifyCandidate(journal, false);
        await this.helper('verify', journal.old.Image, journal.snapshot);
        journal.phase = 'rolling-back';
        this.write(journal);
        await stopped(current.Id);
        journal.rollbackSafetySnapshot = await this.helper('snapshot', journal.old.Image);
        this.write(journal);
      } else if (journal.phase === 'committed') {
        await this.verifyCandidate(journal);
        rmSync(lock, { force: true });
        return { recovered: true, committed: true };
      }
      await this.restoreOld(journal);
      rmSync(lock, { force: true });
      return { recovered: true, rolledBack: true, releaseId: journal.id };
    } catch (error) {
      throw new Error(
        'Legacy recovery incomplete; lock retained and automatic startup suppressed',
        { cause: error },
      );
    }
  }
  /** Boot uses exact existing container settings, never reconstructs from YAML. */
  async resumeCommitted() {
    const journal = this.readJournal();
    if (!journal || this.status().locked) return;
    const id =
      journal.phase === 'committed'
        ? journal.candidateId
        : journal.phase === 'rolled-back'
          ? journal.old.Id
          : null;
    if (!id) throw new Error('Interrupted legacy update requires explicit recovery');
    const info = await inspect(id);
    if (info.Name !== `/${this.options.containerName}`)
      throw new Error('Legacy boot container identity mismatch');
    if (!info.State.Running) await apiStartContainer(id);
    await this.healthy(await inspect(id), journal.sshFingerprint);
  }
}
