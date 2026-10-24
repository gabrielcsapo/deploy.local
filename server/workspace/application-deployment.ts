import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve as resolvePath, join, isAbsolute } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
import { listBundleFiles } from '../../bin/bundle-files.mjs';
import {
  compileDeployYaml,
  parseRepositoryBaseDigest,
  applicationSpecDigest,
} from '../application-spec.ts';
import { issueAgentUpload, assertAgentApplication, type AgentUpload } from '../agent-upload.ts';
import {
  readDeploymentRecord as getDeployment,
  getFleetPlacementState,
  buildLogFilePath,
  getBuildLogResult,
  getDeploymentEnvVars,
  getAllApplicationConfigurationValues,
} from '../store.ts';
import { decryptSecret, loadOrCreateSecretKey, secretAddress } from '../secrets.ts';
import { command, get, save, id, now, event } from './store.ts';
import { restoreSnapshot, type Snapshot } from './checkpoint.ts';
import type { AgentScope } from './coordination.ts';

export type ApplicationResult = {
  status: 'running' | 'failed';
  url: string;
  routes: { name: string; url: string; to: string }[];
  deploymentId: string | null;
  logTail?: string;
};
export async function checkpointBundle(snapshot: Snapshot, path = '.', name?: string) {
  if (
    typeof path !== 'string' ||
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '..') ||
    path.includes('\0')
  )
    throw new Error('path must be a checkpoint subdirectory');
  const temporary = mkdtempSync(join(tmpdir(), 'deploy-application-'));
  try {
    const root = join(temporary, 'source');
    restoreSnapshot(snapshot, root);
    return await directoryBundle(resolvePath(root, path), name);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function directoryBundle(directory: string, name?: string) {
  let source: string;
  try {
    source = readFileSync(join(directory, 'deploy.yaml'), 'utf8');
  } catch {
    throw new Error(`deploy.yaml is required at application root`);
  }
  const compiled = compileDeployYaml(source, 'deploy.yaml');
  const application = compiled.spec.metadata.name;
  if (!application) throw new Error('deploy.yaml metadata.name is required');
  if (name !== undefined && name !== application)
    throw new Error(`name "${name}" must match deploy.yaml metadata.name "${application}"`);
  const archive = pack();
  for (const file of listBundleFiles(directory)) {
    const absolute = join(directory, file);
    archive.entry(
      { name: file, mode: statSync(absolute).mode & 0o777, mtime: new Date(0) },
      readFileSync(absolute),
    );
  }
  archive.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(Buffer.from(chunk));
  return {
    body: gzipSync(Buffer.concat(chunks)),
    application,
    spec: compiled.spec,
    declaredBaseDigest: parseRepositoryBaseDigest(source),
  };
}

export function redactDeploymentLog(value: string, secrets: string[] = []) {
  let result = value;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length))
    result = result.split(secret).join('[redacted]');
  return result
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(
      /((?:password|secret|token|api[_-]?key|authorization)\s*[=:]\s*)(?:Bearer\s+)?[^\s,;]+/gi,
      '$1[redacted]',
    );
}
function logTail(buildLogId: number) {
  try {
    const file = openSync(buildLogFilePath(buildLogId), 'r');
    try {
      const size = statSync(buildLogFilePath(buildLogId)).size;
      const bytes = Buffer.alloc(Math.min(size, 64 * 1024));
      readSync(file, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      return bytes.toString('utf8').split('\n').slice(-60).join('\n');
    } finally {
      closeSync(file);
    }
  } catch {
    return '';
  }
}
function secretsFor(
  application: string,
  spec: Awaited<ReturnType<typeof checkpointBundle>>['spec'],
) {
  const values = Object.values(getDeploymentEnvVars(application));
  for (const component of Object.values(spec.components))
    for (const value of Object.values(component.environment))
      if (typeof value === 'string') values.push(value);
  for (const declaration of Object.values(spec.configuration))
    if (declaration.type === 'secret' && typeof declaration.default === 'string')
      values.push(declaration.default);
  const deployment = getDeployment(application);
  for (const digest of new Set([
    deployment?.desiredSpecDigest,
    deployment?.activeSpecDigest,
    applicationSpecDigest(spec),
  ])) {
    if (!digest) continue;
    for (const row of getAllApplicationConfigurationValues(application, digest)) {
      if (row.valueType === 'secret')
        values.push(
          decryptSecret(
            row.value,
            loadOrCreateSecretKey(),
            secretAddress(application, row.key, row.siteId, digest),
          ),
        );
    }
  }
  return values;
}

export function applicationFailureLog(
  application: string,
  buildLogId: number,
  spec: Awaited<ReturnType<typeof directoryBundle>>['spec'],
) {
  try {
    return redactDeploymentLog(logTail(buildLogId), secretsFor(application, spec));
  } catch {
    return '[Build output withheld: secret redaction unavailable]';
  }
}

export function agentDeploymentAdmission(application: string) {
  const placement = getFleetPlacementState();
  if (!placement.ready)
    throw new Error('Choose a default deployment computer in Computers before deploying.');
  if (['backing-up', 'restoring'].includes(getDeployment(application)?.status || ''))
    throw new Error(
      `Migration in progress for ${application}. Wait for it to finish before deploying again.`,
    );
}
export async function uploadApplication(
  scope: AgentUpload,
  bundle: Awaited<ReturnType<typeof checkpointBundle>>,
  timeoutMs: number,
) {
  const capability = issueAgentUpload(scope);
  try {
    const form = new FormData();
    form.set('name', bundle.application);
    form.set('detached', '1');
    if (bundle.declaredBaseDigest) form.set('expectedParentDigest', bundle.declaredBaseDigest);
    form.set('file', new Blob([new Uint8Array(bundle.body)]), 'source.tar.gz');
    // Fixed loopback destination: a capability must never follow a redirect or leave this computer.
    const port = Number(process.env.CONTROL_PORT || 7843);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Invalid control port');
    const response = await fetch(`http://127.0.0.1:${port}/api/upload`, {
      method: 'POST',
      headers: { 'x-deploy-internal-upload': capability.token },
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    const result = (await response.json()) as any;
    if (!response.ok)
      throw Object.assign(
        new Error(result.error || `Deployment upload rejected (${response.status})`),
        { buildLogId: result.buildLogId },
      );
    return result;
  } finally {
    capability.close();
  }
}
export async function waitForApplication(
  application: string,
  buildLogId: number,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    read?: () => { currentBuildLogId: number | null; status: string; buildStatus: string | null };
  } = {},
) {
  const deadline = Date.now() + (options.timeoutMs ?? 600000);
  do {
    const state = options.read
      ? options.read()
      : (() => {
          const deployment = getDeployment(application);
          const build = getBuildLogResult(application, buildLogId);
          return {
            currentBuildLogId: deployment?.currentBuildLogId ?? null,
            status: deployment?.status || 'missing',
            buildStatus: build?.status ?? null,
          };
        })();
    if (state.currentBuildLogId !== buildLogId)
      throw new Error('Deployment was superseded; inspect View logs before retrying.');
    if (state.status === 'running' && state.buildStatus === 'complete') return;
    if (
      state.buildStatus === 'failed' ||
      ['failed', 'configuration-required', 'missing', 'stopped'].includes(state.status)
    )
      throw new Error(
        `Deployment ${state.status}. Check configuration and build logs before retrying.`,
      );
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1000));
  } while (Date.now() < deadline);
  throw new Error(
    'Timed out waiting for build/start after 10 minutes; the deployment may still finish. Inspect View logs before retrying.',
  );
}
const active = new Map<string, Promise<ApplicationResult>>();
export async function deployApplication(
  scope: AgentScope,
  args: { operationId: string; checkpointId: string; path?: string; name?: string },
) {
  const { owner, taskId } = scope;
  const signature = createHash('sha256')
    .update(JSON.stringify({ taskId, tool: 'deploy_application', args }))
    .digest('hex');
  const reservation = command(
    owner,
    args.operationId,
    () => {
      const checkpoint = get('checkpoint', owner, args.checkpointId);
      if (checkpoint.taskId !== taskId) throw new Error('Checkpoint belongs to another task');
      return save('application-deployment', owner, {
        id: id(),
        taskId,
        runId: scope.runId,
        checkpointId: checkpoint.id,
        createdAt: now(),
      });
    },
    signature,
  );
  const key = `${owner}:${reservation.id}`;
  if (active.has(key)) return active.get(key)!;
  const record = get('application-deployment', owner, reservation.id);
  if (record.result) return record.result as ApplicationResult;
  const deadline = Date.now() + 600000;
  const execute = async (): Promise<ApplicationResult> => {
    let buildLogId = record.buildLogId,
      waiting = false;
    let routes: ApplicationResult['routes'] = record.routes || [],
      secrets: string[] = [];
    let spec: Awaited<ReturnType<typeof checkpointBundle>>['spec'] | undefined;
    try {
      const checkpoint = get('checkpoint', owner, record.checkpointId);
      const bundle = await checkpointBundle(checkpoint.snapshot, args.path, args.name);
      application = bundle.application;
      spec = bundle.spec;
      const url = `https://${application}.local`;
      routes = Object.entries(bundle.spec.routes).map(([name, route]) => ({
        name,
        to: route.to,
        url: `https://${route.hostname || `${application}.local`}${route.path || '/'}`,
      }));
      secrets = secretsFor(application, bundle.spec);
      if (!record.startedAt) {
        assertAgentApplication({ ...scope, application });
        agentDeploymentAdmission(application);
        save('application-deployment', owner, { ...record, application, routes, startedAt: now() });
        const receipt = await uploadApplication(
          {
            ...scope,
            taskTitle: get('task', owner, taskId).title,
            application,
            deploymentRecordId: record.id,
          },
          bundle,
          deadline - Date.now(),
        );
        buildLogId =
          receipt.buildLogId ||
          (receipt.unchanged ? getDeployment(application)?.currentBuildLogId : null);
        if (!Number.isSafeInteger(buildLogId) || buildLogId <= 0)
          throw new Error('Upload did not return a deployment identity');
        save('application-deployment', owner, {
          ...get('application-deployment', owner, record.id),
          buildLogId,
        });
      } else if (!buildLogId) {
        throw new Error(
          'Coordinator interrupted during upload. Inspect the application before using a new operationId; this operation will not upload twice.',
        );
      }
      waiting = true;
      await waitForApplication(application, buildLogId, {
        timeoutMs: Math.max(0, deadline - Date.now()),
      });
      return finish({ status: 'running', url, routes, deploymentId: String(buildLogId) });
    } catch (error: any) {
      // recordAgentUpload persists the identity even if the HTTP response was lost.
      buildLogId ||= get('application-deployment', owner, record.id).buildLogId;
      if (buildLogId && !waiting) {
        try {
          await waitForApplication(application, buildLogId, {
            timeoutMs: Math.max(0, deadline - Date.now()),
          });
          return finish({
            status: 'running',
            url: `https://${application}.local`,
            routes,
            deploymentId: String(buildLogId),
          });
        } catch {
          /* Return the original failure plus this build's bounded logs. */
        }
      }
      let output = buildLogId ? logTail(buildLogId) : '';
      if (spec && application) {
        try {
          secrets.push(...secretsFor(application, spec));
        } catch {
          output = '[Build output withheld: secret redaction unavailable]';
        }
      }
      return finish({
        status: 'failed',
        url: application ? `https://${application}.local` : '',
        routes,
        deploymentId: buildLogId ? String(buildLogId) : null,
        logTail: redactDeploymentLog(`${error.message}\n${output}`, secrets),
      });
    }
  };
  function finish(result: ApplicationResult) {
    const latest = get('application-deployment', owner, record.id);
    save('application-deployment', owner, { ...latest, application, result, completedAt: now() });
    const message = save('message', owner, {
      id: `deployment:${record.id}`,
      taskId,
      role: 'assistant',
      sourceRunId: scope.runId,
      createdAt: now(),
      // A compact Markdown attachment uses the existing transcript styles on all clients.
      content: `> **${application || 'Application deployment'}** · ${result.status}\n>\n> ${result.url ? `[${result.url}](${result.url}) · [View logs](https://deploy.local/dashboard/${application}/build)` : 'Deployment rejected; see deploy_application result.'}`,
      deployment: { application, ...result },
    });
    event(owner, taskId, scope.runId, 'message', message);
    event(owner, taskId, scope.runId, 'application.deployed', { application, ...result });
    return result;
  }
  // Keep reservations durable and concurrent identical retries on the same promise.
  let application = record.application || '';
  const pending = execute();
  active.set(key, pending);
  try {
    return await pending;
  } finally {
    active.delete(key);
  }
}

/** Stay below proxy idle timeouts while the durable detached attempt progresses. */
export async function applicationTool(
  scope: AgentScope,
  args: Parameters<typeof deployApplication>[1],
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deployApplication(scope, args),
      new Promise<{ pending: true }>((resolve) => {
        timer = setTimeout(() => resolve({ pending: true }), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
