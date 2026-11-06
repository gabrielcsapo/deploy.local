import { wanderInventory } from './wander-data.mjs';
import { createHash } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { resolve, join, sep, basename, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WanderAdoption, newWanderJournal, type WanderAdoptionAdapter } from './wander-adoption.ts';
import {
  readWanderJournal,
  writeWanderJournal,
  wanderOwnerAlive,
  wanderJournalRoot,
  WANDER_MANAGED_DIGEST,
  type WanderJournal,
} from './wander-adoption-fence.ts';
import {
  getDeployment,
  refreshDeploymentInCache,
  getSqlite,
  isAdmin,
  saveDesiredApplicationSpec,
  activateDesiredApplicationSpec,
  saveDeployment,
  updateDeploymentArtifactDigests,
  updateDeploymentStatus,
  getApplicationGraphState,
} from './store.ts';
import { ciFingerprint, assertNoCiRelease } from './ci-releases.ts';
import { ciMutationActive } from './ci-fence.ts';
import {
  acquireDeploySlot,
  type DeployLease,
  getDeployAdmissionState,
} from './deploy-admission.ts';
import { deployDataPath } from './data-directory.ts';
import { compileDeployYaml } from './application-spec.ts';
import { buildApplicationGraphRuntime } from './application-runtime.ts';
import { DockerCliGraphAdapter, graphVolumeName } from './graph-docker-adapter.ts';
import { resolveApplicationConfiguration } from './application-configuration.ts';
import { applicationWriterSiteId } from './application-authority.ts';
import { ApplicationGraphExecutor } from './application-graph-executor.ts';
import {
  inspectContainer,
  apiStopContainer,
  apiStartContainer,
  apiRemoveContainer,
  dockerRequest,
  type ApiContainerInspect,
} from './docker-api.ts';
const exec = promisify(execFile);
const HELPER = 'node@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0';
function error(message: string, status = 409): never {
  throw Object.assign(new Error(message), { status });
}
const sourceRoot = () => deployDataPath('volumes', 'wander');
function current() {
  refreshDeploymentInCache('wander');
  const d = getDeployment('wander');
  if (!d) error('Wander not found', 404);
  return d;
}
function rootIdentity() {
  const root = sourceRoot();
  if (realpathSync(root) !== resolve(root)) error('Wander data root symlinks are unsupported');
  return JSON.stringify(
    ['data', 'uploads'].map((n) => {
      const p = join(root, n),
        s = lstatSync(p);
      if (!s.isDirectory() || s.isSymbolicLink()) error('Missing original Wander ' + n);
      return [n, s.dev, s.ino, s.uid, s.gid, s.mode & 0o7777];
    }),
  );
}
function validateMounts(info: ApiContainerInspect) {
  const mounts = info.Mounts || [];
  if (
    mounts.length !== 2 ||
    !['data', 'uploads'].every((n) =>
      mounts.some(
        (m) =>
          m.Type === 'bind' &&
          m.RW &&
          m.Source === join(sourceRoot(), n) &&
          m.Destination === '/app/' + n,
      ),
    )
  )
    error('Wander requires the exact original data and uploads binds');
  if (
    info.HostConfig?.Privileged ||
    info.HostConfig?.NetworkMode === 'host' ||
    (Array.isArray(info.HostConfig?.Devices) && info.HostConfig.Devices.length) ||
    (Array.isArray(info.HostConfig?.DeviceRequests) && info.HostConfig.DeviceRequests.length) ||
    (Array.isArray(info.HostConfig?.CapAdd) && info.HostConfig.CapAdd.length)
  )
    error('Unsupported Wander host capabilities');
}
export function wanderRuntimeSettingsDigest(info: ApiContainerInspect) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        Image: info.Image,
        Config: info.Config,
        HostConfig: info.HostConfig,
        Mounts: info.Mounts,
      }),
    )
    .digest('hex');
}
async function oldInspection() {
  const d = current();
  if (
    d.activeSpecDigest ||
    d.containerName !== 'deploy-sh-wander' ||
    !d.appId ||
    !d.containerId ||
    !d.sourceArtifactDigest ||
    !d.desiredSpecDigest ||
    (d.activeNodeId && d.activeNodeId !== 'coordinator') ||
    (d.desiredNodeId && d.desiredNodeId !== 'coordinator') ||
    d.gpuEnabled ||
    d.privilegedDocker ||
    (d.envVars && JSON.parse(d.envVars) && Object.keys(JSON.parse(d.envVars)).length) ||
    (d.volumes && JSON.parse(d.volumes).length)
  )
    error('Managed adoption supports only the existing coordinator Wander legacy runtime');
  const info = await inspectContainer(d.containerId);
  if (!info || info.Id !== d.containerId || !/^sha256:[a-f0-9]{64}$/.test(info.Image))
    error('Original Wander image/container unavailable');
  validateMounts(info);
  rootIdentity();
  if (
    !existsSync(join(sourceRoot(), 'data', 'wander.db')) ||
    !lstatSync(join(sourceRoot(), 'data', 'wander.db')).isFile() ||
    !lstatSync(join(sourceRoot(), 'data', 'wander.db')).size
  )
    error('Missing or empty original Wander database');
  return { d, info };
}
function contains(parent: string, child: string) {
  const r = relative(parent, child);
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
}
async function verifiedCandidate(j: WanderJournal, info: ApiContainerInspect) {
  return (
    info.Id === j.candidateContainer &&
    info.Image === j.image &&
    info.Config.Labels?.['deploy-sh.wander-adoption'] === j.id &&
    info.Mounts?.length === 2 &&
    ['data', 'uploads'].every((n) =>
      info.Mounts!.some(
        (m) =>
          m.Type === 'volume' &&
          m.Name === j.providers[n]?.name &&
          m.RW &&
          m.Destination === '/app/' + n,
      ),
    )
  );
}
async function noOtherWriters(j: WanderJournal, allowManaged = false) {
  const providerRoots: string[] = [];
  for (const v of Object.values(j.providers)) {
    if (!(await new DockerCliGraphAdapter().volumeExists(v.name))) continue;
    const volume = await dockerRequest<{ Mountpoint: string }>({
      method: 'GET',
      path: '/volumes/' + encodeURIComponent(v.name),
    });
    providerRoots.push(resolve(volume.Mountpoint));
  }
  const all = await dockerRequest<Array<{ Id: string }>>({
    method: 'GET',
    path: '/containers/json?all=1',
  });
  for (const c of all) {
    const info = await inspectContainer(c.Id);
    if (!info?.State.Running || info.Id === j.baselineContainer) continue;
    const candidate = allowManaged && (await verifiedCandidate(j, info));
    for (const m of info.Mounts || []) {
      if (!m.RW) continue;
      if (m.Type === 'bind') {
        const p = realpathSync(m.Source),
          root = realpathSync(sourceRoot());
        if (contains(p, root) || contains(root, p)) error('Competing original Wander writer');
        if (providerRoots.some((r) => contains(p, r) || contains(r, p)))
          error('Competing managed Wander bind writer');
      } else if (Object.values(j.providers).some((v) => v.name === m.Name) && !candidate)
        error('Competing managed Wander writer');
    }
  }
}

async function helper(j: WanderJournal, program: string, mounts: string[] = []) {
  const name = 'wander-adoption-helper-' + j.id;
  const script = resolve(fileURLToPath(new URL('./wander-data.mjs', import.meta.url)));
  const backup = join(wanderJournalRoot(), 'backups');
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  j.helper = name;
  writeWanderJournal(j);
  try {
    const result = await exec(
      'docker',
      [
        'run',
        '--name',
        name,
        '--label',
        'deploy-sh.wander-adoption=' + j.id,
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'CHOWN',
        '--cap-add',
        'DAC_OVERRIDE',
        '--cap-add',
        'FOWNER',
        '--security-opt',
        'no-new-privileges',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev',
        '--mount',
        'type=bind,src=' + script + ',dst=/helper/wander-data.mjs,readonly',
        '--mount',
        'type=bind,src=' + backup + ',dst=/backup',
        ...mounts.flatMap((m) => ['--mount', m]),
        '--entrypoint',
        'node',
        HELPER,
        '--input-type=module',
        '-e',
        program,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    return result.stdout.trim();
  } finally {
    const i = await inspectContainer(name);
    if (i && !i.State.Running) await apiRemoveContainer(i.Id);
    if (!i || !i.State.Running) {
      j.helper = null;
      writeWanderJournal(j);
    }
  }
}
const helperSnapshot = (j: WanderJournal) => ({
  ...j.snapshot,
  directory: '/backup/' + basename(j.snapshot!.directory),
});
function runtime(j: WanderJournal) {
  const graph = compileDeployYaml(readFileSync(join(j.sourceDirectory, 'deploy.yaml'), 'utf8'));
  if (graph.digest !== WANDER_MANAGED_DIGEST || graph.digest !== j.specDigest)
    error('Adoption source manifest changed');
  return {
    graph,
    runtime: buildApplicationGraphRuntime({
      applicationId: j.applicationId,
      specDigest: graph.digest,
      spec: graph.spec,
      siteId: 'coordinator',
      configuration: resolveApplicationConfiguration({
        deploymentName: 'wander',
        specDigest: graph.digest,
        declarations: graph.spec.configuration,
        siteId: 'coordinator',
      }),
    }),
  };
}
export async function wanderAdoptionPreflight(owner: string) {
  const target = current();
  if (target.username !== owner) error('Not found', 404);
  if (!isAdmin(owner)) error('Managed adoption requires owner administrator', 403);
  const { d, info } = await oldInspection();
  return {
    application: 'wander',
    applicationId: d.appId!,
    expectedContainer: d.containerId!,
    expectedImage: info.Image,
    expectedRuntimeSettings: wanderRuntimeSettingsDigest(info),
    expectedSource: d.sourceArtifactDigest!,
    expectedParent: d.desiredSpecDigest!,
    specDigest: WANDER_MANAGED_DIGEST,
  };
}
export function wanderAdoptionService(owner: string) {
  const d = current();
  if (d.username !== owner) error('Not found', 404);
  if (!isAdmin(owner)) error('Managed adoption requires owner administrator', 403);
  const docker = new DockerCliGraphAdapter();
  let lease: DeployLease | null = null;
  const adapter: WanderAdoptionAdapter = {
    async acquire(_j) {
      lease = await acquireDeploySlot('wander', owner);
    },
    claim(j) {
      return getSqlite()!
        .transaction(() => {
          const latest = readWanderJournal();
          if (!latest || latest.id !== j.id || latest.owner !== owner)
            error('Adoption reservation changed');
          if (wanderOwnerAlive(latest)) error('Live process owns adoption');
          latest.activePid = process.pid;
          latest.activeThread = threadId;
          writeWanderJournal(latest);
          return latest;
        })
        .immediate();
    },
    release(j) {
      lease?.release();
      lease = null;
      getSqlite()!
        .transaction(() => {
          const latest = readWanderJournal();
          if (
            !latest ||
            latest.id !== j.id ||
            latest.activePid !== process.pid ||
            latest.activeThread !== threadId
          )
            error('Adoption execution ownership changed');
          j.activePid = null;
          j.activeThread = null;
          j.updatedAt = Date.now();
          writeWanderJournal(j);
        })
        .immediate();
    },
    reserve(intent, username) {
      return getSqlite()!
        .transaction(() => {
          const row = current();
          if (row.username !== username || !isAdmin(username)) error('Not found', 404);
          if (readWanderJournal()) error('Adoption already reserved');
          if (ciMutationActive('wander') || ciMutationActive(intent.applicationId))
            error('Application mutation in progress');
          assertNoCiRelease('wander');
          const admission = getDeployAdmissionState();
          if (
            admission.activeDeployments.includes('wander') ||
            admission.queue.some((q) => q.name === 'wander')
          )
            error('Application already admitted');
          if (
            row.appId !== intent.applicationId ||
            row.containerId !== intent.expectedContainer ||
            row.sourceArtifactDigest !== intent.expectedSource ||
            row.desiredSpecDigest !== intent.expectedParent ||
            row.activeSpecDigest ||
            intent.specDigest !== WANDER_MANAGED_DIGEST ||
            !/^sha256:[a-f0-9]{64}$/.test(intent.expectedImage) ||
            !/^[a-f0-9]{64}$/.test(intent.expectedRuntimeSettings) ||
            !/^sha256:[a-f0-9]{64}$/.test(intent.sourceDigest) ||
            !/^sha256:[a-f0-9]{64}$/.test(intent.sourceArchiveDigest) ||
            !/^sha256:[a-f0-9]{64}$/.test(intent.expectedSource) ||
            !/^sha256:[a-f0-9]{64}$/.test(intent.expectedParent) ||
            !/^\w[\w:.-]{0,199}$/.test(intent.requestKey) ||
            !/^[a-f0-9]{40}$/.test(intent.sourceCommit)
          )
            error('Stale or invalid adoption intent');
          if (!resolve(intent.sourceDirectory).startsWith(deployDataPath('uploads') + sep))
            error('Invalid private source staging');
          const source = compileDeployYaml(
            readFileSync(join(intent.sourceDirectory, 'deploy.yaml'), 'utf8'),
          );
          if (source.digest !== WANDER_MANAGED_DIGEST)
            error('Managed Wander manifest does not match reviewed contract');
          const j = newWanderJournal(
            intent,
            username,
            row as unknown as Record<string, unknown>,
            ciFingerprint('wander'),
            rootIdentity(),
          );
          const release = join(wanderJournalRoot(), 'source', j.id);
          mkdirSync(join(wanderJournalRoot(), 'source'), { recursive: true, mode: 0o700 });
          renameSync(intent.sourceDirectory, release);
          j.sourceDirectory = release;
          writeWanderJournal(j, true);
          return j;
        })
        .immediate();
    },
    async checkBaseline(j, stopped) {
      const row = current();
      for (const [resource, v] of Object.entries(j.providers))
        if (v.seeded) {
          if (!(await docker.volumeExists(v.name)))
            error('Seeded provider disappeared; refusing empty replacement');
          const info = await dockerRequest<{ Labels: Record<string, string> }>({
            method: 'GET',
            path: '/volumes/' + encodeURIComponent(v.name),
          });
          if (
            info.Labels?.['deploy-sh.wander-adoption'] !== j.id ||
            info.Labels?.['deploy-sh.app-id'] !== j.applicationId ||
            info.Labels?.['deploy-sh.resource'] !== resource
          )
            error('Seeded provider ownership drift');
        }
      if (j.phase !== 'publishing' && row.activeSpecDigest && row.activeSpecDigest !== j.specDigest)
        error('Active graph drift');
      if (rootIdentity() !== j.rootIdentity) error('Original Wander data identity drift');
      const info = await inspectContainer(j.baselineContainer);
      if (!info || info.Image !== j.baselineImage) error('Original immutable image drift');
      validateMounts(info);
      if (wanderRuntimeSettingsDigest(info) !== j.baselineRuntimeSettings)
        error('Original runtime settings changed');
      if (stopped && j.snapshot && wanderInventory(sourceRoot()) !== j.snapshot.inventoryDigest)
        error('Original stopped data changed after backup');
      if (stopped && info.State.Running) error('Original writer is not stopped');
      if (
        !['starting', 'publishing', 'committed'].includes(j.phase) &&
        ciFingerprint('wander') !== j.baselineFingerprint
      )
        error('Controller baseline changed');
      await noOtherWriters(j, ['starting', 'publishing', 'committed'].includes(j.phase));
    },
    async build(j) {
      const { d: row, info } = await oldInspection();
      if (row.containerId !== j.baselineContainer || info.Image !== j.baselineImage)
        error('Original preflight changed');
      await adapter.checkBaseline(j, false);
      const { runtime: r } = runtime(j);
      const image = await docker.prepareImage({
        applicationId: j.applicationId,
        component: 'web',
        releaseDigest: j.sourceDigest,
        source: r.execution.components.web.source,
        projectDirectory: j.sourceDirectory,
        forceBuild: true,
      });
      const built = await dockerRequest<{ Id: string; Config: { Env?: string[]; User?: string } }>({
        method: 'GET',
        path: '/images/' + encodeURIComponent(image) + '/json',
      });
      const env = (values: readonly string[] | undefined) =>
        Object.fromEntries(
          (values || []).map((v) => {
            const at = v.indexOf('=');
            return [v.slice(0, at), v.slice(at + 1)];
          }),
        );
      const original = env(info.Config.Env),
        candidate = env(built.Config.Env);
      for (const key of ['TZ', 'NODE_ENV', 'NODE_OPTIONS'])
        if (original[key] !== candidate[key]) error('Candidate image changes preserved ' + key);
      if ((info.Config.User || '') !== (built.Config.User || ''))
        error('Candidate image changes application file owner');
      return built.Id;
    },
    async stopLegacy(j) {
      await adapter.checkBaseline(j, false);
      await apiStopContainer(j.baselineContainer);
      if ((await inspectContainer(j.baselineContainer))?.State.Running)
        error('Original writer stop unconfirmed');
    },
    async snapshot(j) {
      await adapter.checkBaseline(j, true);
      const output = await helper(
        j,
        `import fs from 'node:fs';import {snapshotWander} from '/helper/wander-data.mjs';const s=snapshotWander('/source','/backup');for(const p of [s.directory,...['full.tar','data.tar.gz','uploads.tar.gz','snapshot.json'].map(n=>s.directory+'/'+n)])fs.chownSync(p,${process.getuid?.() ?? 0},${process.getgid?.() ?? 0});console.log(JSON.stringify(s));`,
        ['type=bind,src=' + sourceRoot() + ',dst=/source,readonly'],
      );
      const snapshot = JSON.parse(output);
      snapshot.directory = join(wanderJournalRoot(), 'backups', basename(snapshot.directory));
      return snapshot;
    },
    async seed(j, resource) {
      if (['starting', 'publishing', 'committed'].includes(j.phase) || j.candidateContainer)
        error('Seeding after candidate startup is forbidden');
      await adapter.checkBaseline(j, true);
      const name = graphVolumeName(j.applicationId, resource);
      const prior = j.providers[resource];
      if (await docker.volumeExists(name)) {
        const info = await dockerRequest<{ Labels: Record<string, string> }>({
          method: 'GET',
          path: '/volumes/' + encodeURIComponent(name),
        });
        if (
          !prior ||
          !prior.created ||
          info.Labels?.['deploy-sh.wander-adoption'] !== j.id ||
          info.Labels?.['deploy-sh.app-id'] !== j.applicationId
        )
          error('Managed destination is unrelated or preexisting');
      } else {
        j.providers[resource] = { name, created: true, seeded: false };
        writeWanderJournal(j);
        await docker.ensureVolume(name, {
          'deploy-sh.app-id': j.applicationId,
          'deploy-sh.resource': resource,
          'deploy-sh.wander-adoption': j.id,
        });
      }
      const info = await dockerRequest<{ Labels: Record<string, string> }>({
        method: 'GET',
        path: '/volumes/' + encodeURIComponent(name),
      });
      if (info.Labels?.['deploy-sh.wander-adoption'] !== j.id)
        error('Managed destination ownership changed');
      const s = helperSnapshot(j);
      await helper(
        j,
        `import {seedWanderResource} from '/helper/wander-data.mjs';seedWanderResource(${JSON.stringify(s)},${JSON.stringify(resource)},'/destination',true);`,
        ['type=volume,src=' + name + ',dst=/destination'],
      );
    },
    async verifySeed(j) {
      await adapter.checkBaseline(j, true);
      for (const resource of ['data', 'uploads']) {
        const info = await dockerRequest<{ Labels: Record<string, string> }>({
          method: 'GET',
          path: '/volumes/' + encodeURIComponent(j.providers[resource].name),
        });
        if (info.Labels?.['deploy-sh.wander-adoption'] !== j.id)
          error('Managed provider ownership drift');
      }
      const s = helperSnapshot(j);
      await helper(
        j,
        `import {execFileSync} from 'node:child_process';import {verifyWanderSeed} from '/helper/wander-data.mjs';const s=${JSON.stringify(s)};for(const n of ['data','uploads'])execFileSync('tar',['--numeric-owner','-czpf','/backup/seed-'+n+'.tar.gz','-C','/source/'+n,'.'],{stdio:'pipe'});verifyWanderSeed(s,{data:'/backup/seed-data.tar.gz',uploads:'/backup/seed-uploads.tar.gz'});`,
        [
          'type=volume,src=' + j.providers.data.name + ',dst=/source/data,readonly',
          'type=volume,src=' + j.providers.uploads.name + ',dst=/source/uploads,readonly',
        ],
      );
    },
    async activate(j) {
      const { runtime: r } = runtime(j);
      const pinned = new DockerCliGraphAdapter();
      pinned.ensureVolume = async (name) => {
        const resource = Object.entries(j.providers).find(([, v]) => v.name === name);
        if (!resource || !resource[1].seeded || !(await pinned.volumeExists(name)))
          error('Seeded managed provider missing; empty replacement is forbidden');
        const info = await dockerRequest<{ Labels: Record<string, string> }>({
          method: 'GET',
          path: '/volumes/' + encodeURIComponent(name),
        });
        if (
          info.Labels?.['deploy-sh.wander-adoption'] !== j.id ||
          info.Labels?.['deploy-sh.app-id'] !== j.applicationId ||
          info.Labels?.['deploy-sh.resource'] !== resource[0]
        )
          error('Managed provider identity changed');
      };
      for (const v of Object.values(j.providers)) await pinned.ensureVolume(v.name, {});
      // No candidate could write before its durable name exists. A starting-phase
      // recovery with no candidate must prove both complete copies again.
      if (!j.candidateName) await adapter.verifySeed(j);
      pinned.prepareImage = async (input) => {
        if (input.applicationId !== j.applicationId || input.component !== 'web' || !j.image)
          error('Unexpected adoption build');
        return j.image;
      };
      const create = pinned.createContainer.bind(pinned);
      pinned.createContainer = async (request) => {
        if (request.image !== j.image || request.mounts.length !== 2)
          error('Unexpected candidate request');
        const name = j.candidateName || request.name;
        // Name is durable before create; recovery can find a container created
        // immediately before worker loss, without allocating a second writer.
        if (!j.candidateName) {
          j.candidateName = name;
          writeWanderJournal(j);
        }
        let info = await inspectContainer(name);
        if (info) {
          if (!j.candidateContainer) {
            j.candidateContainer = info.Id;
            writeWanderJournal(j);
          }
          if (!(await verifiedCandidate(j, info)))
            error('Candidate name belongs to unrelated runtime');
          return { id: info.Id, name };
        }
        if (j.candidateContainer)
          error('Pinned candidate disappeared; explicit owner investigation required');
        const result = await create({
          ...request,
          name,
          labels: { ...request.labels, 'deploy-sh.wander-adoption': j.id },
        });
        j.candidateContainer = result.id;
        writeWanderJournal(j);
        return result;
      };
      pinned.startContainer = async (name) => {
        // Covers recovery of a created candidate before start was recorded.
        const info = await inspectContainer(name);
        if (!info) error('Candidate missing');
        if (!j.candidateContainer && info.Config.Labels?.['deploy-sh.wander-adoption'] === j.id) {
          j.candidateContainer = info.Id;
          writeWanderJournal(j);
        }
        if (!(await verifiedCandidate(j, info))) error('Unrelated adoption candidate');
        await adapter.checkBaseline(j, true);
        await apiStartContainer(info.Id);
      };
      pinned.removeContainer = async (name) => {
        if (name === j.candidateName) error('Adoption candidate is retained for explicit recovery');
        error('Unexpected adoption container cleanup');
      };
      const result = await new ApplicationGraphExecutor({ docker: pinned }).converge({
        deploymentName: 'wander',
        applicationId: j.applicationId,
        siteId: 'coordinator',
        nodeId: 'coordinator',
        projectDirectory: j.sourceDirectory,
        runtime: r,
        writerSiteId: applicationWriterSiteId(j.applicationId),
      });
      if (!result.primaryContainerId) error('Candidate container unavailable');
      return result.primaryContainerId;
    },
    async verifyCandidate(j) {
      await adapter.checkBaseline(j, true);
      const rows = getApplicationGraphState(
        'wander',
        j.applicationId,
        'coordinator',
      ).instances.filter((i) => i.status === 'ready');
      if (rows.length !== 1) error('Expected one ready managed Wander instance');
      const info = await inspectContainer(rows[0].containerName);
      if (
        !info ||
        !info.State.Running ||
        !(await verifiedCandidate(j, info)) ||
        info.Image !== j.image ||
        (j.candidateContainer && info.Id !== j.candidateContainer)
      )
        error('Managed runtime identity drift');
      for (const resource of ['data', 'uploads'])
        if (
          !(info.Mounts || []).some(
            (m) =>
              m.Type === 'volume' &&
              m.Name === j.providers[resource].name &&
              m.Destination === '/app/' + resource &&
              m.RW,
          )
        )
          error('Managed runtime mount drift');
      const port = info.NetworkSettings.Ports?.['3000/tcp']?.[0]?.HostPort;
      if (!port) error('Managed health endpoint missing');
      const response = await fetch('http://127.0.0.1:' + port + '/api/health', {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      await response.body?.cancel();
      if (!response.ok) error('Managed Wander health failed');
    },
    async commit(j) {
      await adapter.verifyCandidate(j);
      const { graph, runtime: r } = runtime(j);
      const rows = getApplicationGraphState(
        'wander',
        j.applicationId,
        'coordinator',
      ).instances.filter((i) => i.status === 'ready');
      const info = await inspectContainer(rows[0].containerName);
      if (!info) error('Managed runtime disappeared');
      getSqlite()!
        .transaction(() => {
          saveDesiredApplicationSpec({
            deploymentName: 'wander',
            digest: graph.digest,
            parentDigest: j.baselineParent,
            apiVersion: graph.spec.apiVersion,
            source: 'repository',
            manifestFormat: 'deploy.yaml',
            normalizedSpec: graph.canonicalJson,
            originalSource: readFileSync(join(j.sourceDirectory, 'deploy.yaml'), 'utf8'),
            createdBy: owner,
          });
          updateDeploymentArtifactDigests('wander', { sourceArtifactDigest: j.sourceDigest });
          activateDesiredApplicationSpec('wander', graph.digest, r.configurationDigest);
          saveDeployment({
            name: 'wander',
            username: owner,
            type: 'application-graph',
            containerId: info.Id,
            containerName: rows[0].containerName,
            port: Number(info.NetworkSettings.Ports!['3000/tcp']![0].HostPort),
            directory: j.sourceDirectory,
            activeNodeId: 'coordinator',
            desiredNodeId: 'coordinator',
            createdAt:
              typeof j.baselineDeployment.createdAt === 'string'
                ? j.baselineDeployment.createdAt
                : undefined,
          });
          updateDeploymentStatus('wander', 'running');
        })
        .immediate();
    },
    async fenceHelpers(j) {
      if (j.candidateName && !j.candidateContainer) {
        const info = await inspectContainer(j.candidateName);
        if (info) {
          j.candidateContainer = info.Id;
          if (!(await verifiedCandidate(j, info))) error('Unexpected interrupted candidate');
          writeWanderJournal(j);
        }
      }
      if (!j.helper) return;
      const i = await inspectContainer(j.helper);
      if (i) {
        if (i.Config.Labels?.['deploy-sh.wander-adoption'] !== j.id)
          error('Unexpected recovery helper identity');
        if (i.State.Running) await apiStopContainer(i.Id);
        if ((await inspectContainer(i.Id))?.State.Running)
          error('Recovery helper stop unconfirmed');
        await apiRemoveContainer(i.Id);
      }
      j.helper = null;
      writeWanderJournal(j);
    },
    async resumeOriginal(j) {
      if (j.candidateContainer)
        error('Candidate rollback requires a separate explicit data-loss decision');
      await noOtherWriters(j);
      await apiStartContainer(j.baselineContainer);
      const response = await fetch(
        'http://127.0.0.1:' + j.baselineDeployment.port + '/api/health',
        { redirect: 'error', signal: AbortSignal.timeout(10000) },
      );
      await response.body?.cancel();
      if (!response.ok) error('Original Wander recovery health failed');
    },
  };
  return new WanderAdoption(owner, adapter);
}
