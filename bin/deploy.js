#!/usr/bin/env node
import { registryBuildDocker } from '../server/package-build.ts';
import * as contracts from './cli-contracts.mjs';
import { runPackages } from './packages.mjs';
import {
  agentConfigPath,
  userAgentConfigPath,
  readAgentConfig,
  joinAgent,
} from './agent-enrollment.mjs';
import { getDeployManifestName, getIgnorePatterns, listBundleFiles } from './bundle-files.mjs';
import { agentUser } from './agent-user.mjs';
import {
  servicePlan,
  agentHeartbeatCapabilities,
  assertAgentJobAllowed,
  isFile,
  workerExecutablePaths,
  supervisedExecutable,
  serviceProgramArguments,
  linkWorkerSupervisor,
  sealWorkerBundle,
  removeBareWorkers,
  moveClashingWorker,
  workerRoot,
  installWorkerService,
  installedServices,
  uninstallServices,
  systemdQuote,
  removeAgentDockerObjects,
} from './agent-services.mjs';
import { loadWorkerConfig, enableWorkerTlsTrust } from './worker-runtime.mjs';
import {
  publishedHostPort,
  relayRepairs,
  relayRemovals,
  relaysDueForRemoval,
  relayContainerRows,
  containerHasRelay,
  reportedApps,
  runtimeStartCommand,
} from './agent-relays.mjs';
import { readNodeStatus } from '../server/features/computers/node-status.ts';
import { runDesktopHelper } from './desktop-helper.mjs';
import { installChromium } from './browser-install.mjs';
import { captureRunningApp } from './design-capture.mjs';
import { superviseWorker, workerUpdateReceipt } from './worker-supervisor.mjs';
import { createRelayController } from './relay-client.mjs';
import { runRelayProcess } from './relay-process.mjs';
import { downloadWorkerBuild, installWorkerBuild } from './worker-update.mjs';
import { ensureWorkerBuild } from './agent-install.mjs';
import { acceptsLauncher } from './launcher-protocol.mjs';
import {
  scheduleSupervisorSwap,
  swapSupervisor,
  supervisorSwapReceipt,
  restartUpdatedServices,
} from './supervisor-swap.mjs';
import { runCiCli } from './ci-release.mjs';
import { printCertificateFingerprint } from './certificate-fingerprint.mjs';
import {
  HELP,
  browserLogin,
  cliError,
  suggestCommand,
  liveStatus,
  printLive,
  readInbox,
  runInbox,
  waitInbox,
  confirmChange,
  followDeploy,
  releaseReporter,
  releaseActivated,
  stepLine,
  elapsed,
  followRollback,
  releaseSteps,
  printRelease,
} from './cli-v2.mjs';
import { DESIGN_HELP, runDesign } from './cli-design.mjs';

import { parseArgs, format } from 'node:util';
import { basename, resolve, dirname } from 'node:path';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import {
  runBounded,
  settles,
  runChecked,
  dockerCommandTimeout,
  DATA_COMMAND_TIMEOUT_MS,
} from './bounded-command.mjs';
import { createInterface } from 'node:readline';
import { arch, cpus, homedir, hostname, networkInterfaces, platform, totalmem } from 'node:os';
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
  realpathSync,
  accessSync,
  constants as fsConstants,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import {
  buildImage as agentBuildImage,
  classifyProject as agentClassifyProject,
  ensureDockerfile as agentEnsureDockerfile,
  getAvailablePort as agentGetAvailablePort,
  healthCheckPort as agentHealthCheckPort,
  runContainer as agentRunContainer,
  validateVolumeMounts as agentValidateVolumeMounts,
  execContainer as agentExecContainer,
  execContainerByName as agentExecContainerByName,
} from '../server/docker.ts';
import { readDeployConfig as agentReadDeployConfig } from '../server/deploy-config.ts';
import { compileDeployYaml, parseRepositoryBaseDigest } from '../server/application-spec.ts';
import { planApplicationChange } from '../server/application-plan.ts';
import { inspectUploadArchive } from '../server/upload-archive.ts';
import { resolveAgentContainerName } from '../server/agent-container-target.ts';
import { executeReleaseAgentJob } from '../server/features/releases/releases-worker.ts';
import { executeAgentApplicationGraph } from '../server/agent-graph-runtime.ts';
import { startTelemetryRelay } from '../server/telemetry-relay.ts';
import { configureRemoteTelemetry } from '../server/telemetry-runtime.ts';
import deployV1Schema from '../deploy.v1.schema.json' with { type: 'json' };

const DEFAULT_URL = 'https://deploy.local';
const RC_PATH = resolve(homedir(), '.deployrc');

// ── Build identity ──────────────────────────────────────────────────────────

// scripts/build-cli.mjs bakes the build stamp in as a JSON string at bundle
// time. Run from source there is no stamp, so read the checkout instead.
const BUILD_INFO = await (async () => {
  if (typeof __DEPLOY_BUILD_INFO__ === 'string') {
    try {
      return JSON.parse(__DEPLOY_BUILD_INFO__);
    } catch {
      /* fall through to the source stamp */
    }
  }
  return sourceBuildInfo();
})();

async function sourceBuildInfo() {
  let commit = 'unknown';
  let dirty = false;
  try {
    const opts = { cwd: import.meta.dirname };
    commit = (await runChecked('git', ['rev-parse', 'HEAD'], opts)).trim() || 'unknown';
    dirty = (await runChecked('git', ['status', '--porcelain'], opts)).trim() !== '';
  } catch {
    /* not a git checkout */
  }
  const commitShort = commit === 'unknown' ? 'unknown' : commit.slice(0, 7);
  return {
    version: `source.${commitShort}${dirty ? '.dirty' : ''}`,
    commit,
    commitShort,
    dirty,
    buildTime: null,
    runtime: process.version,
    source: true,
  };
}

/** The build target this machine needs: linux-x64, darwin-arm64, … */
function platformTarget() {
  return `${process.platform}-${process.arch}`;
}

/** True when running as the packaged SEA binary rather than from source. */
async function isPackagedBinary() {
  try {
    const sea = await import('node:sea');
    if (typeof sea.isSea === 'function') return sea.isSea();
  } catch {
    /* node:sea unavailable — fall back to inspecting the executable */
  }
  return !/[/\\]node(\.exe)?$/.test(process.execPath);
}

// Preserve certificate validation and include independently installed OS roots.
function enableLocalTlsTrust(serverUrl) {
  const u = new URL(serverUrl);
  if (u.protocol === 'https:' && u.hostname.endsWith('.local'))
    setDefaultCACertificates([...getCACertificates('default'), ...getCACertificates('system')]);
}

function appUrl(serverUrl, name) {
  const u = new URL(serverUrl);
  const hostname = u.hostname;
  // If server is an IP address or localhost, use .local mDNS domain with https
  if (
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
    hostname === 'localhost' ||
    hostname.endsWith('.local')
  ) {
    return `https://${name}.local`;
  }
  return `https://${name}.${u.host}`;
}

// ── Config helpers ──────────────────────────────────────────────────────────

function loadConfig() {
  if (process.env.DEPLOY_AUTH_JSON || process.env.DEPLOY_AUTH_FILE) return {};
  try {
    return JSON.parse(readFileSync(RC_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  writeFileSync(RC_PATH, JSON.stringify(config, null, 2) + '\n');
}

// ── Prompt helper ───────────────────────────────────────────────────────────

function prompt(question, hidden = false) {
  const output = values?.json ? process.stderr : process.stdout;
  return new Promise((resolve) => {
    if (hidden) {
      const stdin = process.stdin;
      output.write(question);
      if (!stdin.isTTY) {
        const rl = createInterface({ input: stdin, output, terminal: false });
        rl.question('', (answer) => {
          rl.close();
          resolve(answer);
        });
        return;
      }
      const originalRawMode = stdin.isRaw;
      const wasPaused = stdin.isPaused();
      stdin.setRawMode(true);
      stdin.resume();
      let value = '';
      const onData = (c) => {
        const chunk = c.toString('utf8');
        for (const ch of chunk) {
          if (ch === '\n' || ch === '\r' || ch === '\u0004') {
            stdin.setRawMode(originalRawMode);
            if (wasPaused) stdin.pause();
            stdin.removeListener('data', onData);
            output.write('\n');
            resolve(value);
            return;
          } else if (ch === '\u0003') {
            stdin.setRawMode(originalRawMode);
            output.write('\n');
            process.exit(130);
          } else if (ch === '\u007f' || ch === '\b') {
            if (value.length > 0) {
              value = value.slice(0, -1);
              output.write('\b \b');
            }
          } else if (ch >= ' ') {
            value += ch;
            output.write('*');
          }
        }
      };
      stdin.on('data', onData);
    } else {
      const rl = createInterface({
        input: process.stdin,
        output,
      });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

// ── HTTP helper ─────────────────────────────────────────────────────────────

async function request(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = typeof body === 'object' ? body.message || body.error || text : text;
    const requestError = new Error(`${res.status}: ${msg}`);
    requestError.status = res.status;
    requestError.body = body;
    throw requestError;
  }
  return body;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Multipart upload streamed from disk: `prefix` and `suffix` are in-memory
 * multipart framing buffers, the file body is read from `filePath` chunk by
 * chunk. The tarball never sits fully in memory — uploads are bounded by the
 * 256KB read buffer regardless of project size.
 */
// If the server accepts no bytes for this long mid-upload, treat the
// connection as stalled rather than waiting forever. The hang we kept hitting
// was the kernel send buffer filling and the `drain` event never arriving
// because the far end (an overloaded Docker VM) stopped reading the socket —
// with no timeout the CLI sat on "Uploading... 8%" indefinitely.
const UPLOAD_STALL_TIMEOUT_MS = 30_000;
const UPLOAD_MAX_ATTEMPTS = 3;

async function uploadWithProgress(url, bodyParts, headers) {
  const { prefix, filePath, suffix } = bodyParts;
  const totalBytes = prefix.length + statSync(filePath).size + suffix.length;

  let lastErr;
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      return await uploadAttempt(url, bodyParts, headers, totalBytes, attempt);
    } catch (err) {
      lastErr = err;
      if (!err.retriable || attempt === UPLOAD_MAX_ATTEMPTS) break;
      const backoffMs = 1000 * attempt;
      process.stderr.write(
        `\nUpload ${err.reason || 'failed'} at ${formatBytes(err.uploadedBytes || 0)} / ${formatBytes(totalBytes)}` +
          ` — attempt ${attempt}/${UPLOAD_MAX_ATTEMPTS}, retrying in ${backoffMs / 1000}s...\n`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw new Error(formatUploadError(lastErr));
}

/**
 * One upload attempt. Multipart body streamed from disk: `prefix`/`suffix` are
 * in-memory framing buffers, the file body is read from `filePath` chunk by
 * chunk (bounded by the 256KB read buffer regardless of project size).
 *
 * A stall watchdog runs only while body bytes are in flight — once the body is
 * fully sent it's cleared, so legitimately slow server-side work (untar of a
 * large bundle, etc.) before the response isn't misread as a frozen socket.
 */
function uploadAttempt(url, { prefix, filePath, suffix }, headers, totalBytes, attempt) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const requestFn = isHttps ? httpsRequest : httpRequest;

    let uploadedBytes = 0;
    let lastProgressAt = Date.now();
    let bodySent = false;
    let settled = false;
    let watchdog = null;
    let fileStream = null;
    let drainReject = null;
    const startTime = Date.now();

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': totalBytes },
    };

    const cleanup = () => {
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = null;
      }
    };
    const fail = (reason, message, retriable) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (fileStream) {
        try {
          fileStream.destroy();
        } catch {
          /* ignore */
        }
      }
      if (drainReject) {
        const rej = drainReject;
        drainReject = null;
        rej(new Error('aborted'));
      }
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      const e = new Error(message);
      e.reason = reason;
      e.retriable = retriable;
      e.uploadedBytes = uploadedBytes;
      e.totalBytes = totalBytes;
      reject(e);
    };
    const succeed = (val) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(val);
    };

    const req = requestFn(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let responseBody;
        try {
          responseBody = JSON.parse(text);
        } catch {
          responseBody = text;
        }
        if (res.statusCode >= 300 && res.statusCode < 400) {
          fail(
            'redirected',
            `Server redirected to ${res.headers.location} — use the HTTPS URL directly`,
            false,
          );
        } else if (res.statusCode >= 400) {
          const msg =
            typeof responseBody === 'object'
              ? responseBody.message || responseBody.error || text
              : text;
          // 4xx are client errors (bad auth, missing name) — re-uploading won't
          // help. 5xx after a full upload usually means a server-side failure;
          // re-sending a large bundle blindly is wasteful, so surface it.
          fail('http_error', `${res.statusCode}: ${msg}`, false);
        } else {
          succeed(responseBody);
        }
      });
    });

    // Socket-level idle timeout: fires if the connection goes silent (e.g. the
    // server stopped reading and our writes are parked waiting for 'drain').
    req.setTimeout(UPLOAD_STALL_TIMEOUT_MS, () => {
      if (!bodySent) {
        fail('stalled', `no data accepted by server for ${UPLOAD_STALL_TIMEOUT_MS / 1000}s`, true);
      }
    });

    req.on('error', (err) => {
      const reason =
        err.code === 'ECONNRESET'
          ? 'connection reset'
          : err.code === 'ECONNREFUSED'
            ? 'connection refused'
            : err.code === 'EPIPE'
              ? 'broken pipe'
              : 'network error';
      // Refused = nothing listening (server down) — a quick retry won't help.
      fail(reason, err.message, err.code !== 'ECONNREFUSED');
    });

    // Progress-based watchdog: catches a frozen `drain` even if the socket
    // timeout doesn't fire. Disarmed once the whole body is sent.
    watchdog = setInterval(() => {
      if (!bodySent && Date.now() - lastProgressAt > UPLOAD_STALL_TIMEOUT_MS) {
        fail(
          'stalled',
          `server stopped accepting data for ${UPLOAD_STALL_TIMEOUT_MS / 1000}s`,
          true,
        );
      }
    }, 2000);
    if (watchdog.unref) watchdog.unref();

    const reportProgress = () => {
      if (values.json || !process.stdout.isTTY || process.env.NO_COLOR !== undefined) return;
      const elapsed = (Date.now() - startTime) / 1000 || 1;
      const speed = uploadedBytes / elapsed;
      const percentage = ((uploadedBytes / totalBytes) * 100).toFixed(1);
      const tag = attempt > 1 ? ` [retry ${attempt}/${UPLOAD_MAX_ATTEMPTS}]` : '';
      process.stdout.write(
        `\rUploading...${tag} ${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)} (${percentage}%) - ${formatBytes(speed)}/s`,
      );
    };

    const writeChunk = (chunk) =>
      new Promise((res, rej) => {
        if (settled) {
          rej(new Error('aborted'));
          return;
        }
        const canContinue = req.write(chunk);
        uploadedBytes += chunk.length;
        lastProgressAt = Date.now();
        reportProgress();
        if (canContinue) {
          res();
        } else {
          drainReject = rej;
          req.once('drain', () => {
            drainReject = null;
            lastProgressAt = Date.now();
            res();
          });
        }
      });

    (async () => {
      try {
        await writeChunk(prefix);
        // 256 KiB keeps memory bounded while reducing syscall/drain overhead
        // on fast LAN uploads compared with the old 64 KiB chunks.
        fileStream = createReadStream(filePath, { highWaterMark: 256 * 1024 });
        for await (const chunk of fileStream) {
          if (settled) return;
          await writeChunk(chunk);
        }
        await writeChunk(suffix);
        req.end();
        bodySent = true;
        // Body fully sent — stop the stall watchdog and the socket idle timeout
        // so slow server-side extraction/build before the response isn't
        // mistaken for a stall.
        cleanup();
        req.setTimeout(0);
        if (!values.json && process.stdout.isTTY && process.env.NO_COLOR === undefined)
          process.stdout.write('\n');
      } catch (err) {
        if (!settled) fail('write error', err.message, true);
      }
    })();
  });
}

/** Turn an upload failure into an actionable, human-readable message. */
function formatUploadError(err) {
  if (!err) return 'Upload failed';
  const transient =
    err.reason === 'stalled' ||
    err.reason === 'connection reset' ||
    err.reason === 'broken pipe' ||
    err.reason === 'network error';
  if (transient) {
    return [
      `Upload ${err.reason} — stopped at ${formatBytes(err.uploadedBytes || 0)} / ${formatBytes(err.totalBytes || 0)} after ${UPLOAD_MAX_ATTEMPTS} attempts.`,
      '',
      'The server stopped accepting data mid-transfer. Likely causes:',
      '  • The Docker VM on the server is overloaded (high CPU/IO) and froze the connection.',
      '  • Flaky link between this machine and the server — try a wired connection.',
      '  • Large bundles widen the exposure window; trim it with deploy.yaml build.ignore',
      '    (run `deploy files` to see what is being sent).',
    ].join('\n');
  }
  return err.message || `Upload ${err.reason || 'failed'}`;
}

function authHeaders(config) {
  return {
    'x-deploy-username': config.username || '',
    'x-deploy-token': config.token || '',
  };
}

// ── Bundle helpers ──────────────────────────────────────────────────────────

// ── Commands ────────────────────────────────────────────────────────────────

function cmdFiles() {
  const dir = process.cwd();
  const files = listBundleFiles(dir);
  const ignorePatterns = getIgnorePatterns(dir);

  let isGitRepo = false;
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe' });
    isGitRepo = true;
  } catch {}

  if (values.json)
    return outputJson({ files, ignorePatterns, strategy: isGitRepo ? 'git' : 'filesystem' });

  console.log(`\nBundle contents for ${basename(dir)}:`);
  console.log(`  Strategy: ${isGitRepo ? 'git (respects .gitignore)' : 'filesystem'}`);
  console.log(`  Always excluded: node_modules, .git`);
  if (ignorePatterns.length > 0) {
    console.log(`  Custom ignore: ${ignorePatterns.join(', ')}`);
  }
  console.log(`  Total files: ${files.length}\n`);

  for (const f of files) {
    console.log(`  ${f}`);
  }
  console.log('');
}

function readLocalApplicationDefinition(dir) {
  const manifestName = getDeployManifestName(dir);
  if (!manifestName) throw new Error('deploy.yaml is required');
  return {
    format: manifestName,
    compiled: compileDeployYaml(readFileSync(resolve(dir, manifestName), 'utf-8'), manifestName),
  };
}

function countLabel(count, singular) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function cmdValidate() {
  const { format, compiled } = readLocalApplicationDefinition(process.cwd());
  const { spec } = compiled;
  const componentEntries = Object.entries(spec.components);
  const instanceCount = componentEntries.reduce((total, [, component]) => {
    return total + component.instances;
  }, 0);
  const declarations = Object.values(spec.configuration);
  const requiredCount = declarations.filter((declaration) => declaration.required).length;
  const secretCount = declarations.filter((declaration) => declaration.type === 'secret').length;
  const siteScopedCount = declarations.filter((declaration) => declaration.scope === 'site').length;
  const sourceLabel = format;
  const componentSummary = componentEntries
    .map(
      ([name, component]) => `${name}${component.instances > 1 ? ` x${component.instances}` : ''}`,
    )
    .join(', ');

  if (values.json) return outputJson({ valid: true, ...compiled });

  console.log(`\u2713 ${sourceLabel} is valid`);
  console.log(`  API: ${spec.apiVersion}`);
  console.log(`  Digest: ${compiled.digest}`);
  console.log(
    `  Graph: ${countLabel(componentEntries.length, 'component')} / ${countLabel(instanceCount, 'instance')}, ` +
      `${countLabel(Object.keys(spec.routes).length, 'route')}, ` +
      `${countLabel(Object.keys(spec.resources).length, 'resource')}, ` +
      `${countLabel(Object.keys(spec.jobs).length, 'job')}`,
  );
  console.log(`  Components: ${componentSummary}`);
  console.log(
    `  Configuration: ${declarations.length} declared, ${requiredCount} required, ` +
      `${secretCount} secret, ${siteScopedCount} site-scoped`,
  );
}

async function cmdPlan(serverUrl, appName) {
  const config = loadConfig();
  if (!config.token) {
    throw new Error('Not logged in. Run: deploy register  or  deploy login');
  }

  const name = (appName || basename(process.cwd())).toLowerCase();
  const local = readLocalApplicationDefinition(process.cwd());
  const remote = await request(
    `${serverUrl}/api/deployments/${encodeURIComponent(name)}/application-spec`,
    { headers: authHeaders(config) },
  );
  if (!remote.desired || !remote.desiredDigest) {
    throw new Error(`${name} does not have a desired application specification to compare`);
  }

  const plan = planApplicationChange(remote.desired, local.compiled.spec, {
    source: 'repository',
  });
  if (values.json) return outputJson({ name, plan, remote, local: local.compiled });
  console.log(`Plan for ${name}`);
  console.log(`  Server configuration: ${remote.desiredDigest}`);
  console.log(`  Local configuration: ${local.compiled.digest} (${local.format})`);
  console.log(`  Uploaded source: ${remote.sourceArtifactDigest || 'not recorded'}`);
  const images = remote.runningImages || [];
  console.log(
    `  Running images: ${images.length ? images.map((item) => `${item.component}: ${item.imageId} (${item.image})`).join(', ') : remote.runningImagesAvailable === false ? 'unavailable on remote node' : 'not recorded'}`,
  );
  console.log(`  Active configuration: ${remote.activeDigest || 'not active'}`);
  console.log(
    remote.desiredDigest === local.compiled.digest
      ? '  Configuration unchanged; source changes not checked.'
      : '  Source changes not checked by this plan.',
  );
  console.log('');
  for (const action of plan.actions) {
    const marker = action.blocked ? '✗' : action.destructive ? '!' : '•';
    console.log(`  ${marker} ${action.classification}: ${action.reason}`);
  }
  console.log('');
  console.log(
    `  Approval: ${plan.requiresApproval ? 'required' : 'not required'}  ` +
      `Restart: ${plan.restartRequired ? 'required' : 'not required'}  ` +
      `Destructive: ${plan.destructive ? 'yes' : 'no'}  ` +
      `Blocked: ${plan.blocked ? 'yes' : 'no'}`,
  );
  console.log(
    `  Capacity: ${plan.impacts.capacity.currentInstances} → ${plan.impacts.capacity.desiredInstances} instances` +
      ` (peak ${plan.impacts.capacity.peakInstances})`,
  );
  console.log(
    `  Downtime: ${plan.impacts.downtime.expectation}  ` +
      `Backup: ${plan.impacts.backup.disposition}  ` +
      `Data: ${plan.impacts.data.effect}`,
  );
}

async function prepareRepositoryDeploy(serverUrl, name, config, dir, resolution) {
  const manifestPath = resolve(dir, 'deploy.yaml');
  if (!existsSync(manifestPath)) return { expectedParentDigest: null, resolution: null };
  const source = readFileSync(manifestPath, 'utf8');
  const local = compileDeployYaml(source, 'deploy.yaml');
  const declaredBaseDigest = parseRepositoryBaseDigest(source);
  const response = await fetch(
    `${serverUrl}/api/deployments/${encodeURIComponent(name)}/application-spec`,
    { headers: authHeaders(config) },
  );
  if (response.status === 404) {
    if (declaredBaseDigest) {
      throw new Error(
        'deploy.yaml declares a base revision, but this application does not exist on the target server.',
      );
    }
    return { expectedParentDigest: null, resolution: null };
  }
  if (!response.ok) {
    throw new Error(`Unable to inspect repository ancestry: ${await response.text()}`);
  }
  const remote = await response.json();
  const currentDigest = remote.desiredDigest || remote.activeDigest;
  if (!currentDigest) return { expectedParentDigest: null, resolution: null };

  if (local.digest === currentDigest) {
    return { expectedParentDigest: declaredBaseDigest, resolution: null };
  }
  if (declaredBaseDigest === currentDigest) {
    return { expectedParentDigest: currentDigest, resolution: null };
  }
  if (resolution === 'replace') {
    return { expectedParentDigest: declaredBaseDigest, resolution: 'replace' };
  }
  if (resolution === 'rebase') {
    if (!declaredBaseDigest) {
      throw new Error(
        'Cannot rebase because deploy.yaml has no deploy.local/base directive. Export the current manifest or use --replace explicitly.',
      );
    }
    const rebaseResponse = await fetch(
      `${serverUrl}/api/deployments/${encodeURIComponent(name)}/application-rebase`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest: source, baseDigest: declaredBaseDigest }),
      },
    );
    const rebase = await rebaseResponse.json();
    if (!rebaseResponse.ok) {
      throw new Error(rebase.error || 'Repository rebase failed');
    }
    if (!rebase.ready) {
      throw new Error(
        `Repository rebase has overlapping edits at ${rebase.conflicts.join(', ')}. Resolve them, use --replace explicitly, or cancel.`,
      );
    }
    writeFileSync(manifestPath, rebase.manifest);
    const rebased = compileDeployYaml(rebase.manifest, 'rebased deploy.yaml');
    if (rebased.digest !== rebase.rebasedDigest) {
      throw new Error('Rebased deploy.yaml did not reproduce the server plan digest');
    }
    console.log(`Rebased deploy.yaml onto ${currentDigest}. Review and commit the updated file.`);
    return { expectedParentDigest: currentDigest, resolution: null };
  }

  const baseLabel = declaredBaseDigest || 'no declared base';
  throw new Error(
    `Repository revision is stale (${baseLabel}); the server is at ${currentDigest}.\n\nRun deploy --rebase to merge independent edits, deploy --replace to explicitly replace the current graph, or make no change to cancel.`,
  );
}

async function cmdRegister(serverUrl) {
  console.log(
    `Open ${serverUrl}/setup and use the setup code from the installer to create the first account.\nIf an account already exists, ask an admin to create yours, then run deploy login.`,
  );
}

async function cmdLogin(serverUrl) {
  const username = await prompt('Username: ');
  const password = await prompt('Password: ', true);

  const res = await request(`${serverUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  saveConfig({ ...loadConfig(), username, token: res.token, url: serverUrl });
  console.log(`Logged in as ${username}`);
}

async function cmdLogout(serverUrl) {
  const config = loadConfig();
  await request(`${serverUrl}/api/logout`, {
    headers: authHeaders(config),
  });
  const { token: _, ...rest } = config;
  saveConfig(rest);
  console.log('Logged out');
}

async function cmdWhoami() {
  const config = loadConfig();
  if (config.username) {
    console.log(values.json ? JSON.stringify({ username: config.username }) : config.username);
  } else {
    throw cliError("You're signed out.", 'deploy login');
  }
}

async function cmdNodesEnroll(serverUrl, nodeName) {
  const roleIds = ['deploy', 'tasks', 'computer', 'browser'];
  const selected =
    values.roles !== undefined
      ? values.roles.split(',').filter(Boolean)
      : values.desktop
        ? ['tasks', 'computer', 'browser']
        : ['deploy'];
  if (selected.some((role) => !roleIds.includes(role)))
    throw new Error('Use --roles deploy,tasks,computer,browser (choose any combination)');
  const roles = Object.fromEntries(roleIds.map((role) => [role, selected.includes(role)]));
  if (values.roles === undefined && process.stdin.isTTY) {
    console.log('What is this computer for? Roles can be combined.');
    for (const role of roleIds) {
      const answer = (
        await prompt(`${roles[role] ? '[x]' : '[ ]'} ${role}? ${roles[role] ? '[Y/n]' : '[y/N]'}: `)
      )
        .trim()
        .toLowerCase();
      if (answer) roles[role] = answer === 'y' || answer === 'yes';
    }
  }
  if (!nodeName) {
    throw cliError('Choose a name for this computer.', 'deploy nodes enroll --name <name>', 2);
  }
  const config = loadConfig();
  if (!config.token) {
    throw cliError("You're signed out.", 'deploy login');
  }
  const enrollment = await request(`${serverUrl}/api/nodes/enrollment`, {
    method: 'POST',
    headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nodeName, roles }),
  });
  const nodesDashboard = new URL('/dashboard/nodes', serverUrl).toString();
  console.log(`\nNode enrollment created for “${enrollment.name}”.\n`);
  console.log('On that machine, run:\n');
  console.log(`  macOS:  deploy agent join ${serverUrl}`);
  console.log(`  Linux:  sudo deploy agent join ${serverUrl}\n`);
  console.log(`Enrollment code: ${enrollment.code}`);
  console.log(`Expires: ${new Date(enrollment.expiresAt).toLocaleString()}\n`);
  console.log(`Tip: administrators can also create and manage nodes in the web interface:`);
  console.log(`  ${nodesDashboard}\n`);
}

function agentPlacementLabels() {
  const source = process.env.DEPLOY_NODE_LABELS?.trim();
  if (!source) return {};
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('DEPLOY_NODE_LABELS must be a JSON object containing string values');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DEPLOY_NODE_LABELS must be a JSON object containing string values');
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!key || typeof value !== 'string' || !value) {
      throw new Error(`DEPLOY_NODE_LABELS.${key || '<empty>'} must be a non-empty string`);
    }
  }
  return Object.fromEntries(
    Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** Never blocks: a Docker daemon that hangs is reported as unreachable, not waited for. */
async function agentCapabilities() {
  const docker = await runBounded('docker', ['version', '--format', '{{.Server.Version}}']);
  const containers =
    docker.status === 0
      ? await runBounded('docker', [
          'ps',
          '-a',
          '--filter',
          'name=deploy-sh-',
          '--format',
          '{{.ID}}\\t{{.Names}}\\t{{.State}}\\t{{.Status}}\\t{{.Label "deploy-sh.app"}}',
        ])
      : null;
  const apps =
    containers?.status === 0
      ? reportedApps(
          containers.stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const [id, containerName, status, detail, label] = line.split('\t');
              return { id, containerName, status, detail, label };
            }),
          agentRelayList(),
        )
      : [];
  return {
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    labels: agentPlacementLabels(),
    docker: docker.status === 0,
    dockerVersion: docker.status === 0 ? docker.stdout.trim() : null,
    dockerError:
      docker.status === 0
        ? null
        : String(docker.stderr || docker.error?.message || 'Docker daemon is unreachable')
            .trim()
            .slice(0, 240),
    apps,
  };
}

function agentRelayList() {
  return [...agentRelays.entries()].map(([name, relay]) => ({
    name,
    targetPort: relay.targetPort,
    relayPort: relay.relayPort,
    wantedPort: relay.wantedPort,
    containerName: relay.containerName,
  }));
}

function agentLanAddress() {
  const configured = process.env.DEPLOY_AGENT_ADDRESS?.trim();
  if (configured) return configured;
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses || [])
      .filter((address) => address.family === 'IPv4' && !address.internal)
      .map((address) => ({ name, address: address.address })),
  );
  const virtual = /^(docker|br-|veth|utun|tun|tap|tailscale|wg|vmnet|vbox|colima)/i;
  const physical = /^(en\d+|eth\d+|eno\d+|ens\d+|enp\w+|wlan\d+|wlp\w+|bond\d+|br0)$/i;
  const privateAddress = (address) =>
    /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address);
  return (
    candidates.find(
      (candidate) =>
        physical.test(candidate.name) &&
        !virtual.test(candidate.name) &&
        privateAddress(candidate.address),
    )?.address ||
    candidates.find(
      (candidate) => !virtual.test(candidate.name) && privateAddress(candidate.address),
    )?.address ||
    candidates.find((candidate) => !virtual.test(candidate.name))?.address ||
    candidates[0]?.address ||
    '127.0.0.1'
  );
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function programArguments() {
  return serviceProgramArguments({
    agentDir: dirname(agentConfigPath()),
    self: selfProgramArguments(),
  });
}
function selfProgramArguments() {
  const executable = resolve(process.execPath);
  // A regular Node invocation is `node /path/to/deploy.js ...`, while a
  // single-executable application is `/path/to/deploy ...`. In a SEA,
  // argv[1] is already the first user argument ("agent"), not a script path.
  // Treating it as a path generated a launchd command like:
  //   deploy /current/directory/agent agent run
  // which exited immediately as an unknown command.
  if (/[/\\]node(?:\\.exe)?$/.test(executable) && process.argv[1]) {
    return [executable, resolve(process.argv[1])];
  }
  return [executable];
}

async function installExecutionAgentService(keepSupervisor = false) {
  // Keep the service executor on an immutable inode, independent of every future worker swap.
  // Reinstalling restarts the service, so this is the one safe moment to move it to the current build.
  if (!keepSupervisor) await linkWorkerSupervisor(dirname(agentConfigPath()));
  const args = [...programArguments().agent, 'agent', 'run'];
  if (platform() === 'darwin') {
    const label = 'sh.deploy.agent';
    const uid = process.getuid?.();
    if (uid == null || uid === 0) {
      throw new Error(
        'On macOS, install the agent from your normal login without sudo so it can access Docker Desktop and mounted storage.',
      );
    }
    const launchAgentsDir = resolve(homedir(), 'Library', 'LaunchAgents');
    const logDir = resolve(homedir(), 'Library', 'Logs', 'deploy.local');
    const agentRoot = resolve(agentConfigPath(), '..');
    const agentDataDir = resolve(agentRoot, 'data');
    const plistPath = resolve(launchAgentsDir, `${label}.plist`);
    mkdirSync(launchAgentsDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    mkdirSync(agentDataDir, { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map((arg) => `\n    <string>${xmlEscape(arg)}</string>`).join('')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>WorkingDirectory</key><string>${xmlEscape(agentRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DEPLOY_DATA_DIR</key><string>${xmlEscape(agentDataDir)}</string>
    <key>DEPLOY_AGENT_CONFIG</key><string>${xmlEscape(agentConfigPath())}</string>${
      process.env.DEPLOY_WORKER_APP
        ? `\n    <key>DEPLOY_WORKER_APP</key><string>${xmlEscape(resolve(process.env.DEPLOY_WORKER_APP))}</string>`
        : ''
    }
  </dict>
  <key>StandardOutPath</key><string>${xmlEscape(resolve(logDir, 'agent.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(resolve(logDir, 'agent.err.log'))}</string>
</dict>
</plist>
`;
    writeFileSync(plistPath, plist);
    const domain = `gui/${uid}`;
    const serviceTarget = `${domain}/${label}`;
    const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
    await runBounded('launchctl', ['bootout', serviceTarget], { timeoutMs: 120_000 });

    let loaded;
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (attempt > 1) await pause(attempt * 250);
      loaded = await runBounded('launchctl', ['bootstrap', domain, plistPath], {
        timeoutMs: 120_000,
      });
      if (loaded.status === 0) break;
      // launchd can return EIO while a KeepAlive process from the previous
      // definition is still exiting. Ensure both label and plist are unloaded
      // before retrying instead of telling the user to run the agent as root.
      await runBounded('launchctl', ['bootout', serviceTarget], { timeoutMs: 120_000 });
      await runBounded('launchctl', ['bootout', domain, plistPath], { timeoutMs: 120_000 });
    }
    if (loaded?.status !== 0) {
      const detail = String(loaded?.stderr || 'launchctl bootstrap failed').trim();
      throw new Error(
        `${detail}\nThe user agent could not be restarted after 4 attempts. Do not use sudo; wait a moment and retry.`,
      );
    }
    const kicked = await runBounded('launchctl', ['kickstart', '-k', serviceTarget], {
      timeoutMs: 120_000,
    });
    if (kicked.status !== 0)
      throw new Error(kicked.stderr || 'launchctl could not start the agent service');
    const started = await runBounded('launchctl', ['print', `${domain}/${label}`], {
      timeoutMs: 8000,
    });
    if (started.status !== 0) {
      throw new Error(started.stderr || 'launchd did not retain the agent service');
    }
    return;
  }

  if (process.getuid?.() !== 0) {
    throw new Error('Linux agent installation requires root. Re-run with sudo.');
  }
  mkdirSync('/var/lib/deploy.local/data', { recursive: true });
  const unitPath = '/etc/systemd/system/deploy-local-agent.service';
  // Lets the root agent restart the login user's task worker after an update.
  const taskUser = agentUser().uid;
  const command = args.map((arg) => systemdQuote(arg, true)).join(' ');
  writeFileSync(
    unitPath,
    `[Unit]
Description=deploy.local execution agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=${command}
WorkingDirectory=/var/lib/deploy.local
Restart=always
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
Environment=DEPLOY_DATA_DIR=/var/lib/deploy.local/data
Environment=${systemdQuote(`DEPLOY_AGENT_CONFIG=${agentConfigPath()}`)}${taskUser > 0 ? `\nEnvironment=DEPLOY_TASK_WORKER_UID=${taskUser}` : ''}

[Install]
WantedBy=multi-user.target
`,
  );
  const reload = await runBounded('systemctl', ['daemon-reload'], { timeoutMs: 120_000 });
  if (reload.status !== 0) throw new Error(reload.stderr || 'systemctl daemon-reload failed');
  const enabled = await runBounded('systemctl', ['enable', '--now', 'deploy-local-agent.service'], {
    timeoutMs: 120_000,
  });
  if (enabled.status !== 0) throw new Error(enabled.stderr || 'systemctl enable failed');
  const restarted = await runBounded('systemctl', ['restart', 'deploy-local-agent.service'], {
    timeoutMs: 120_000,
  });
  if (restarted.status !== 0) throw new Error(restarted.stderr || 'systemctl restart failed');
}

async function installRoleServices(config, { repair = false, rollback = false } = {}) {
  const plan = servicePlan(config.roles);
  if (plan.worker && (!config.workerId || !config.workerToken))
    throw new Error(
      'Coding tasks needs a worker credential. Create a new enrollment and run deploy agent join.',
    );
  if (plan.worker && agentUser().uid === 0)
    throw new Error(
      'Task workers require a normal login user; run sudo from that login when deployments are enabled.',
    );
  const agentDir = dirname(agentConfigPath());
  // On a Mac the services run the worker app; bare builds from an earlier install are unused.
  if (
    !repair &&
    workerExecutablePaths(agentDir).app &&
    isFile(workerExecutablePaths(agentDir).executable)
  ) {
    const removed = removeBareWorkers(agentDir);
    if (removed.length) console.log(`Removed unused worker builds: ${removed.join(', ')}`);
  }
  // A Mac that ran apps kept its build where the task worker's state directory goes.
  if (plan.worker && !rollback) moveClashingWorker(agentDir, workerRoot());
  let agent = plan.agent;
  if (agent && !plan.apps && platform() === 'linux' && process.getuid?.() !== 0) {
    // The execution agent is a system service on Linux; without it the task worker still runs.
    agent = false;
    console.log(
      'Automatic updates need the execution agent. Run sudo deploy agent install from this login to add it.',
    );
  }
  if (agent) await installExecutionAgentService(rollback);
  if (plan.worker) await installWorkerService(programArguments().worker);
  return plan;
}
/** Download the coordinator's worker build; on a Mac into the worker app, which is then sealed. */
async function downloadWorker(serverUrl, agentDir) {
  const { app, executable, previous } = workerExecutablePaths(agentDir);
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dirname(executable), { recursive: true });
  const installed = await downloadWorkerBuild(serverUrl, executable, undefined, previous);
  if (app) await sealWorkerBundle(app);
  return installed;
}
async function connectionSummary(config, services) {
  services ??= await installedServices();
  const plan = servicePlan(config.roles);
  const state = (enabled, service, label) =>
    !enabled ? 'off' : service?.running ? `${label} running` : `${label} not running`;
  return `This ${platform() === 'darwin' ? 'Mac' : 'computer'} is connected to ${new URL(config.coordinatorUrl).host} as ${config.name}: Coding tasks (${state(plan.worker, services.worker, 'task worker')}), Deploy apps (${state(plan.apps, services.agent, 'execution agent')})${!plan.agent && !plan.worker ? '. No background services requested; nothing installed.' : ''}`;
}
async function cmdAgentJoin(serverUrl, requestedName) {
  if (!['darwin', 'linux'].includes(platform()))
    throw new Error('Windows computers use the desktop app.');
  if (!process.env.DEPLOY_AGENT_CONFIG && platform() === 'darwin' && process.getuid?.() === 0)
    throw new Error('Do not use sudo on macOS. Run deploy agent join from your normal login.');
  const user = agentUser();
  const configPath =
    process.env.DEPLOY_AGENT_CONFIG ||
    (platform() === 'linux' && user.uid !== 0
      ? userAgentConfigPath(process.env.SUDO_UID ? {} : process.env, user.home)
      : agentConfigPath());
  // The service runs a worker build from the coordinator, so it can update in place later.
  enableLocalTlsTrust(serverUrl);
  const installedWorker = await downloadWorker(serverUrl, dirname(configPath));
  // The installer's --join passes the code in the environment, keeping it out of the process list.
  const code = process.env.DEPLOY_JOIN_CODE?.trim() || (await prompt('Enrollment code: ', true));
  const enrolled = await joinAgent({
    coordinatorUrl: serverUrl,
    code,
    name: requestedName,
    capabilities: await agentCapabilities(),
    version: installedWorker.version,
    configPath,
  });
  if (!process.env.DEPLOY_AGENT_CONFIG) await installRoleServices(enrolled);
  console.log(await connectionSummary(enrolled));
}
async function coordinatorRoles(config) {
  enableLocalTlsTrust(config.coordinatorUrl);
  const response = await fetch(`${config.coordinatorUrl}/api/agent/status`, {
    headers: agentHeaders(config),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (response.status === 404) return null; // Older coordinators use saved enrollment roles.
  if (!response.ok) throw new Error(`Cannot read computer roles (${response.status}).`);
  const body = await response.json();
  if (
    !body.roles ||
    !['deploy', 'tasks', 'computer', 'browser'].every(
      (role) => typeof body.roles[role] === 'boolean',
    )
  )
    throw new Error('Coordinator returned invalid computer roles.');
  return body.roles;
}
async function cmdAgentInstall() {
  if (platform() === 'darwin' && process.getuid?.() === 0)
    throw new Error('Do not use sudo on macOS. Run deploy agent install from your normal login.');
  const config = readAgentConfig();
  if (!config) throw new Error(`Agent is not enrolled (${agentConfigPath()} not found)`);
  const roles = await coordinatorRoles(config);
  if (roles) {
    config.roles = roles;
    writeFileSync(agentConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  }
  if (servicePlan(config.roles).agent) {
    await ensureWorkerBuild(config.coordinatorUrl, dirname(agentConfigPath()), {
      restartServices: ({ rollback }) => installRoleServices(config, { repair: true, rollback }),
    });
  } else await installRoleServices(config);
  console.log(await connectionSummary(config));
}
async function cmdAgentUninstall() {
  await uninstallServices();
  rmSync(agentConfigPath(), { force: true });
  console.log(
    'Local agent and task-worker services and credentials removed. The coordinator record is kept.',
  );
}
async function cmdWorker(command) {
  if (command === 'run') {
    const environment = loadWorkerConfig();
    Object.assign(process.env, environment);
    enableWorkerTlsTrust(environment.DEPLOY_WORKER_ROOT);
    process.chdir(environment.DEPLOY_WORKER_ROOT);
    await import('../server/workspace/remote-worker.ts');
  } else {
    // Provider adapters and the MCP server use the same embedded Node runtime.
    if (command === 'mcp') await import('../server/workspace/mcp.ts');
    else if (command === 'claude-agent') await import('../server/workspace/claude-agent.ts');
    else if (command === 'compatible-agent')
      await import('../server/workspace/compatible-agent.ts');
    else throw new Error('Usage: deploy worker run');
  }
}

async function sendAgentHeartbeat(config) {
  return request(`${config.coordinatorUrl}/api/agent/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-deploy-node-id': config.nodeId,
      'x-deploy-node-secret': config.secret,
    },
    body: JSON.stringify({
      platform: platform(),
      architecture: arch(),
      agentVersion: BUILD_INFO.version,
      address: agentLanAddress(),
      capabilities: agentHeartbeatCapabilities(
        {
          ...(await agentCapabilities()),
          launcherProtocol: acceptsLauncher(
            globalThis.deployLauncherBuild?.launcherProtocol,
            Number(process.env.DEPLOY_SUPERVISOR_LAUNCHER_PROTOCOL),
          )
            ? globalThis.deployLauncherBuild.launcherProtocol
            : undefined,
        },
        config.roles,
      ),
      supervisorSwapReport: supervisorSwapReceipt(
        process.env.DEPLOY_DATA_DIR || resolve(agentConfigPath(), '..', 'data'),
      ),
      updateReport: workerUpdateReceipt(
        process.env.DEPLOY_DATA_DIR || resolve(agentConfigPath(), '..', 'data'),
      ),
    }),
  });
}

function agentHeaders(config) {
  return {
    'x-deploy-node-id': config.nodeId,
    'x-deploy-node-secret': config.secret,
  };
}

const agentRelays = new Map();
let agentTelemetry;
const agentTelemetryTokens = new Map();

function agentRelayStatePath() {
  return resolve(agentConfigPath(), '..', 'data', 'relays.json');
}

let agentRelayController;
function relayController() {
  return (agentRelayController ||= createRelayController({
    path: agentRelayStatePath(),
    relays: agentRelays,
  }));
}

function ensureAgentRelay(deploymentName, targetPort, preferredPort, containerName) {
  return relayController().ensure(deploymentName, targetPort, preferredPort, containerName);
}

async function restoreAgentRelays() {
  await relayController().restore();
}

async function appContainerRows() {
  return relayContainerRows(
    await runBounded('docker', [
      'ps',
      '-a',
      '--filter',
      'name=deploy-sh-',
      '--format',
      '{"containerName":{{json .Names}},"status":{{json .State}},"label":{{json (.Label "deploy-sh.app")}}}',
    ]),
  );
}

async function runningAppHostPorts(rows = undefined) {
  const containers = rows === undefined ? await appContainerRows() : rows;
  if (!containers) return null;
  const hostPorts = new Map();
  for (const { containerName, status } of containers) {
    if (status !== 'running') continue;
    if (!/^deploy-sh-.+/.test(containerName) || /-prev-\d+$/.test(containerName)) continue;
    const ports = await runBounded('docker', ['port', containerName]);
    const hostPort = ports.status === 0 && !ports.timedOut ? publishedHostPort(ports.stdout) : 0;
    if (Number.isInteger(hostPort) && hostPort > 0) hostPorts.set(containerName, hostPort);
  }
  return hostPorts;
}

async function discoverAgentRelays(known) {
  const hostPorts = known ?? (await runningAppHostPorts());
  if (!hostPorts) return;
  for (const [containerName, targetPort] of hostPorts) {
    if (containerHasRelay(agentRelayList(), containerName)) continue;
    const deploymentName = containerName.replace(/^deploy-sh-/, '');
    try {
      await ensureAgentRelay(deploymentName, targetPort);
    } catch (err) {
      console.error(`Unable to expose ${deploymentName} to the coordinator: ${err.message}`);
    }
  }
}

let startingRuntimeAt = 0;

/** Colima has no service of its own; without this nothing starts it after the Mac restarts. */
async function startContainerRuntime() {
  if (Date.now() - startingRuntimeAt < 5 * 60_000) return;
  const context = await runBounded('docker', [
    'context',
    'inspect',
    '--format',
    '{{.Endpoints.docker.Host}}',
  ]);
  const start = runtimeStartCommand({
    platform: platform(),
    dockerHost: process.env.DOCKER_HOST || (context.status === 0 ? context.stdout.trim() : ''),
  });
  if (!start) return;
  startingRuntimeAt = Date.now();
  console.log(`Docker is not running; starting it with ${start.command} ${start.args.join(' ')}`);
  void runBounded(start.command, start.args, { timeoutMs: 10 * 60_000 }).then((result) => {
    if (result.status !== 0) console.error(`Unable to start ${start.command}: ${result.stderr}`);
  });
}

const removableRelaysSince = new Map();
let repairingAgentRelays = false;

/**
 * Keeps apps reachable after Docker or the computer restarts: starts the runtime when it is down,
 * then points each relay at the port its container came back on.
 */
async function repairAgentRelays() {
  if (repairingAgentRelays) return;
  repairingAgentRelays = true;
  try {
    await relayController().refresh();
    // Only consider relays that existed before this snapshot: a job can create one while Docker
    // is answering. Do not retire a relay that the job has since repointed, either.
    const relays = agentRelayList();
    const containers = await appContainerRows();
    if (!containers) {
      const version = await runBounded('docker', ['version', '--format', '{{.Server.Version}}']);
      // A daemon that is there but not answering is busy, not stopped: starting it again would not help.
      if (version.status !== 0 && !version.timedOut) await startContainerRuntime();
      return;
    }
    for (const stale of relaysDueForRemoval(
      relayRemovals(relays, containers),
      removableRelaysSince,
    )) {
      const current = agentRelays.get(stale.name);
      if (
        !current ||
        current.targetPort !== stale.targetPort ||
        current.containerName !== stale.containerName ||
        current.relayPort !== stale.relayPort
      )
        continue;
      await removeAgentRelay(stale.name);
      console.log(
        `Removed relay ${stale.name} on port ${stale.relayPort}: its container has been gone or replaced for an hour`,
      );
    }
    const hostPorts = await runningAppHostPorts(containers);
    for (const repair of relayRepairs(agentRelayList(), hostPorts)) {
      const before = { ...agentRelays.get(repair.name) };
      const relayPort = await ensureAgentRelay(
        repair.name,
        repair.targetPort,
        repair.relayPort,
        repair.containerName,
      );
      if (before.targetPort !== repair.targetPort || before.relayPort !== relayPort)
        console.log(
          `Relay ${repair.name} on port ${relayPort} now forwards to port ${repair.targetPort}`,
        );
    }
    await discoverAgentRelays(hostPorts);
  } catch (err) {
    console.error(`Unable to check app relays: ${err.message || err}`);
  } finally {
    repairingAgentRelays = false;
  }
}

async function removeAgentRelay(deploymentName) {
  await relayController().remove(deploymentName);
}

async function agentContainerExists(deploymentName) {
  return (
    (
      await runBounded('docker', [
        'container',
        'inspect',
        `deploy-sh-${deploymentName.toLowerCase()}`,
      ])
    ).status === 0
  );
}

async function agentGraphContainerNames(deploymentName) {
  const result = await runBounded('docker', [
    'ps',
    '-a',
    '--filter',
    `label=deploy-sh.app=${deploymentName}`,
    '--format',
    '{{.Names}}',
  ]);
  if (result.status !== 0) throw new Error(result.stderr || 'Unable to list app containers');
  return result.stdout.trim().split('\n').filter(Boolean);
}

async function claimAgentJobFromCoordinator(config) {
  const response = await fetch(`${config.coordinatorUrl}/api/agent/jobs/claim`, {
    method: 'POST',
    headers: agentHeaders(config),
  });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Unable to claim agent job');
  return body;
}

async function downloadAgentArtifact(config, job, destination) {
  const maxAttempts = 5;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let offset = existsSync(destination) ? statSync(destination).size : 0;
    try {
      const headers = agentHeaders(config);
      if (offset > 0) headers.Range = `bytes=${offset}-`;
      const response = await fetch(new URL(job.artifactUrl, config.coordinatorUrl), { headers });

      if (response.status === 416) {
        const total = Number(response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] || 0);
        if (total > 0 && offset === total) return;
        rmSync(destination, { force: true });
        throw new Error('Coordinator rejected the saved download offset; restarting from zero');
      }
      if (!response.ok || !response.body) {
        throw new Error(`Artifact download failed (${response.status})`);
      }

      const resumed = response.status === 206 && offset > 0;
      if (!resumed) offset = 0;
      const contentRange = response.headers.get('content-range');
      const totalBytes = Number(
        contentRange?.match(/\/(\d+)$/)?.[1] ||
          Number(response.headers.get('content-length') || 0) + offset,
      );
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(destination, { flags: resumed ? 'a' : 'w' }),
      );
      const downloadedBytes = statSync(destination).size;
      if (totalBytes > 0 && downloadedBytes !== totalBytes) {
        throw new Error(
          `Artifact download ended early at ${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}`,
        );
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      const downloadedBytes = existsSync(destination) ? statSync(destination).size : 0;
      console.error(
        `Artifact download interrupted at ${formatBytes(downloadedBytes)}; retrying (${attempt}/${maxAttempts})…`,
      );
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, Math.min(8_000, 1_000 * 2 ** (attempt - 1))),
      );
    }
  }
  const cause = lastError?.cause;
  const detail = [
    lastError?.message || String(lastError),
    cause?.code,
    cause?.message && cause.message !== lastError?.message ? cause.message : null,
  ]
    .filter(Boolean)
    .join(': ');
  throw new Error(`Artifact download failed after ${maxAttempts} attempts: ${detail}`, {
    cause: lastError,
  });
}

async function completeAgentJobOnCoordinator(config, jobId, completion) {
  await request(`${config.coordinatorUrl}/api/agent/jobs/${jobId}/complete`, {
    method: 'POST',
    headers: {
      ...agentHeaders(config),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(completion),
  });
}

async function reportAgentJobProgress(config, job, progress) {
  await request(`${config.coordinatorUrl}/api/agent/jobs/${job.id}/progress`, {
    method: 'POST',
    headers: {
      ...agentHeaders(config),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(progress),
    signal: AbortSignal.timeout(15_000),
  });
}

async function agentDirectorySize(directory) {
  const result = await runBounded('du', ['-sk', directory], { timeoutMs: 30_000 });
  return result.status === 0
    ? Number.parseInt(result.stdout.trim().split(/\s+/)[0] || '0', 10) * 1024
    : 0;
}

async function extractAgentArchive(config, job, archivePath, volumeDir) {
  await inspectUploadArchive(archivePath);
  const totalBytes = Math.max(0, Number(job.payload?.totalBytes || 0));
  let currentReport = null;
  const report = (message) => {
    if (currentReport) return currentReport;
    currentReport = (async () => {
      const processedBytes = await agentDirectorySize(volumeDir);
      await reportAgentJobProgress(config, job, {
        stage: 'extracting backup',
        processedBytes,
        totalBytes,
        message,
      }).catch(() => {});
    })().finally(() => {
      currentReport = null;
    });
    return currentReport;
  };
  void report('Extracting managed volumes');
  const timer = setInterval(() => void report(), 1000);
  timer.unref();
  try {
    await runChecked('tar', ['-xzf', archivePath, '-C', volumeDir], {
      timeoutMs: DATA_COMMAND_TIMEOUT_MS,
    });
    await currentReport;
    await report('Managed-volume extraction completed');
  } finally {
    clearInterval(timer);
  }
}

async function uploadAgentBackup(config, job, archivePath) {
  const response = await fetch(`${config.coordinatorUrl}/api/agent/jobs/${job.id}/backup`, {
    method: 'PUT',
    headers: {
      ...agentHeaders(config),
      'Content-Type': 'application/gzip',
      'Content-Length': String(statSync(archivePath).size),
    },
    body: createReadStream(archivePath),
    duplex: 'half',
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Backup upload failed');
  return body;
}

async function runAgentGraphDocker(args, options = {}) {
  const result = await runBounded('docker', args, {
    timeoutMs: dockerCommandTimeout(args),
    ...options,
  });
  return { ...result, exitCode: result.status ?? 1 };
}

async function agentBuildPackages(config, job) {
  return request(`${config.coordinatorUrl}/api/agent/jobs/${job.id}/packages`, {
    method: 'POST',
    headers: agentHeaders(config),
  });
}
function agentBuildDocker(config, job) {
  return registryBuildDocker(
    { run: runAgentGraphDocker },
    {
      root: resolve(agentConfigPath(), '..', 'data', 'packages', 'tmp'),
      config: () => agentBuildPackages(config, job),
      log: (line) => {
        console.log(line);
        void reportAgentJobProgress(config, job, { output: line + '\n' }).catch(() => {});
      },
    },
  );
}

async function executeAgentDeploy(config, job) {
  const root = resolve(agentConfigPath(), '..', 'data');
  const appRoot = resolve(root, 'apps', job.deploymentName);
  const sourceDir = resolve(appRoot, 'source');
  const artifactPath = resolve(appRoot, `${job.id}.tar.gz`);
  const volumeDir = resolve(root, 'volumes', job.deploymentName);
  mkdirSync(appRoot, { recursive: true });
  mkdirSync(volumeDir, { recursive: true });
  mkdirSync(resolve(volumeDir, 'data'), { recursive: true });
  mkdirSync(resolve(volumeDir, 'uploads'), { recursive: true });

  try {
    await reportAgentJobProgress(config, job, {
      stage: 'downloading source',
      processedBytes: 0,
      totalBytes: 0,
      message: 'Downloading application source',
    }).catch(() => {});
    await downloadAgentArtifact(config, job, artifactPath);
    await inspectUploadArchive(artifactPath);
    rmSync(sourceDir, { recursive: true, force: true });
    mkdirSync(sourceDir, { recursive: true });
    await reportAgentJobProgress(config, job, {
      stage: 'unpacking source',
      processedBytes: 0,
      totalBytes: 0,
      message: 'Unpacking application source',
    }).catch(() => {});
    await runChecked('tar', ['-xzf', artifactPath, '-C', sourceDir], {
      timeoutMs: DATA_COMMAND_TIMEOUT_MS,
    });
  } finally {
    rmSync(artifactPath, { force: true });
  }

  const payload = job.payload || {};
  if (payload.graph?.version === 1) {
    const manifestPath = resolve(sourceDir, 'deploy.yaml');
    if (!existsSync(manifestPath)) {
      throw new Error('Graph deployment artifact does not contain deploy.yaml');
    }
    const compiled = compileDeployYaml(readFileSync(manifestPath, 'utf8'));
    const buildStartedAt = Date.now();
    let buildOutput = '';
    let pendingBuildOutput = '';
    let buildOutputFlush = Promise.resolve();
    const flushBuildOutput = () => {
      const output = pendingBuildOutput;
      pendingBuildOutput = '';
      if (!output) return buildOutputFlush;
      buildOutputFlush = buildOutputFlush
        .then(() =>
          reportAgentJobProgress(config, job, {
            stage: 'building graph',
            processedBytes: 0,
            totalBytes: 0,
            output,
          }),
        )
        .catch(() => {});
      return buildOutputFlush;
    };
    let result;
    try {
      result = await executeAgentApplicationGraph(
        {
          deploymentName: job.deploymentName,
          jobId: job.id,
          sourceDirectory: sourceDir,
          volumeDirectory: volumeDir,
          statePath: resolve(appRoot, 'graph-state.json'),
          artifactSpecDigest: compiled.digest,
          artifactSpec: compiled.spec,
          graph: payload.graph,
          memoryLimit: payload.memoryLimit || '4g',
          cpuLimit: payload.cpuLimit || undefined,
          noCache: payload.noCache === true,
          onBuildOutput: (output) => {
            buildOutput += output;
            pendingBuildOutput += output;
            if (pendingBuildOutput.length >= 64 * 1024) void flushBuildOutput();
          },
          onProgress: (stage, message) =>
            reportAgentJobProgress(config, job, {
              stage,
              processedBytes: 0,
              totalBytes: 0,
              message,
            }).catch(() => {}),
        },
        agentBuildDocker(config, job),
      );
      await flushBuildOutput();
    } catch (error) {
      await flushBuildOutput();
      error.buildOutput = buildOutput;
      error.buildDuration = Date.now() - buildStartedAt;
      throw error;
    }
    const relayPort = result.primaryDockerPort
      ? await ensureAgentRelay(
          job.deploymentName,
          result.primaryDockerPort,
          undefined,
          result.primaryContainerName || undefined,
        )
      : null;
    return {
      ...result,
      port: relayPort,
      dockerPort: result.primaryDockerPort,
      containerId: result.primaryContainerId,
      containerName: result.primaryContainerName,
      primaryRouting: result.primaryRoute
        ? {
            ...result.primaryRoute,
            dockerPort: result.primaryDockerPort,
            relayPort,
          }
        : null,
      extraPorts: result.routes.slice(1),
      buildOutput,
      buildDuration: Date.now() - buildStartedAt,
    };
  }

  const type = agentClassifyProject(sourceDir);
  if (!type) throw new Error('Unknown project type in deployment artifact');
  agentEnsureDockerfile(sourceDir, type);
  const storedDeployConfig = agentReadDeployConfig(sourceDir);
  const deployConfig = {
    ...storedDeployConfig,
    ports: Array.isArray(payload.ports) ? payload.ports : storedDeployConfig.ports,
  };
  await reportAgentJobProgress(config, job, {
    stage: 'building image',
    processedBytes: 0,
    totalBytes: 0,
    message: 'Building Docker image',
  }).catch(() => {});

  // Docker builds can run for several minutes. Stream their output back to the
  // coordinator in small ordered batches instead of making the UI wait for the
  // completed job payload (or issuing one HTTP request per BuildKit line).
  let pendingBuildOutput = '';
  let buildOutputTimer = null;
  let buildOutputFlush = Promise.resolve();
  const flushBuildOutput = () => {
    if (buildOutputTimer) {
      clearTimeout(buildOutputTimer);
      buildOutputTimer = null;
    }
    const output = pendingBuildOutput;
    pendingBuildOutput = '';
    if (!output) return buildOutputFlush;
    buildOutputFlush = buildOutputFlush
      .then(() =>
        reportAgentJobProgress(config, job, {
          stage: 'building image',
          processedBytes: 0,
          totalBytes: 0,
          output,
        }),
      )
      .catch(() => {});
    return buildOutputFlush;
  };
  const queueBuildOutput = (line, timestamp) => {
    pendingBuildOutput += `[${timestamp}] ${line}\n`;
    if (pendingBuildOutput.length >= 64 * 1024) {
      void flushBuildOutput();
      return;
    }
    if (!buildOutputTimer) {
      buildOutputTimer = setTimeout(() => void flushBuildOutput(), 100);
      buildOutputTimer.unref();
    }
  };

  let build;
  try {
    build = await agentBuildImage(job.deploymentName, sourceDir, queueBuildOutput, {
      noCache: payload.noCache === true,
      installConfig: () => agentBuildPackages(config, job),
      remoteRegistry: true,
    });
  } finally {
    await flushBuildOutput();
  }
  if (!build.success) {
    throw Object.assign(new Error(`Build failed after ${build.duration}ms`), {
      buildOutput: build.output,
      buildDuration: build.duration,
    });
  }

  const storedVolumes = Array.isArray(payload.volumes) ? payload.volumes : [];
  const declaredVolumes = Array.isArray(deployConfig.volumes) ? deployConfig.volumes : [];
  const customVolumes = [
    ...storedVolumes,
    ...declaredVolumes.filter(
      (declared) =>
        !storedVolumes.some(
          (stored) =>
            stored.hostPath === declared.hostPath &&
            stored.containerPath === declared.containerPath,
        ),
    ),
  ];
  const volumeError = agentValidateVolumeMounts(customVolumes, {
    privilegedDocker: payload.privilegedDocker === true,
  });
  if (volumeError) throw new Error(volumeError);

  const port = await agentGetAvailablePort();
  await reportAgentJobProgress(config, job, {
    stage: 'starting container',
    processedBytes: 0,
    totalBytes: 0,
    message: `Starting container on port ${port}`,
  }).catch(() => {});
  const run = await agentRunContainer(
    build.tag,
    job.deploymentName,
    port,
    volumeDir,
    deployConfig,
    payload.envVars || {},
    payload.memoryLimit || '4g',
    customVolumes,
    payload.gpuEnabled === true,
    payload.privilegedDocker === true,
    payload.cpuLimit || undefined,
  );
  await reportAgentJobProgress(config, job, {
    stage: 'health check',
    processedBytes: 0,
    totalBytes: 0,
    message: 'Waiting for the application to become healthy',
  }).catch(() => {});
  const healthy = await agentHealthCheckPort(port, 30_000);
  if (!healthy) throw new Error(`Container did not accept connections on port ${port}`);
  const relayPort = await ensureAgentRelay(job.deploymentName, port);
  return {
    type,
    port: relayPort,
    dockerPort: port,
    containerId: run.id,
    containerName: run.containerName,
    extraPorts: run.extraPorts,
    buildOutput: build.output,
    buildDuration: build.duration,
  };
}

async function executeAgentRecreate(config, job) {
  const root = resolve(agentConfigPath(), '..', 'data');
  const sourceDir = resolve(root, 'apps', job.deploymentName, 'source');
  const volumeDir = resolve(root, 'volumes', job.deploymentName);
  const payload = job.payload || {};
  const payloadDeployConfig =
    payload.deployConfig &&
    typeof payload.deployConfig === 'object' &&
    !Array.isArray(payload.deployConfig)
      ? payload.deployConfig
      : null;
  if (!payloadDeployConfig && !existsSync(sourceDir)) {
    throw new Error(`Application source is not available on this node for ${job.deploymentName}`);
  }
  const storedDeployConfig = payloadDeployConfig || agentReadDeployConfig(sourceDir);
  const deployConfig = {
    ...storedDeployConfig,
    ports: Array.isArray(payload.ports) ? payload.ports : storedDeployConfig.ports,
  };
  const storedVolumes = Array.isArray(payload.volumes) ? payload.volumes : [];
  const declaredVolumes = Array.isArray(deployConfig.volumes) ? deployConfig.volumes : [];
  const customVolumes = [
    ...storedVolumes,
    ...declaredVolumes.filter(
      (declared) =>
        !storedVolumes.some(
          (stored) =>
            stored.hostPath === declared.hostPath &&
            stored.containerPath === declared.containerPath,
        ),
    ),
  ];
  const volumeError = agentValidateVolumeMounts(customVolumes, {
    privilegedDocker: payload.privilegedDocker === true,
  });
  if (volumeError) throw new Error(volumeError);

  mkdirSync(volumeDir, { recursive: true });
  mkdirSync(resolve(volumeDir, 'data'), { recursive: true });
  mkdirSync(resolve(volumeDir, 'uploads'), { recursive: true });
  const containerName = `deploy-sh-${job.deploymentName.toLowerCase()}`;
  const activeImageId = (
    await runChecked('docker', ['inspect', '--format', '{{.Image}}', containerName])
  ).trim();
  if (!activeImageId) {
    throw new Error(`Active container image is unavailable for ${job.deploymentName}`);
  }
  const dockerPort = await agentGetAvailablePort();
  const run = await agentRunContainer(
    activeImageId,
    job.deploymentName,
    dockerPort,
    volumeDir,
    deployConfig,
    payload.envVars || {},
    payload.memoryLimit || '4g',
    customVolumes,
    payload.gpuEnabled === true,
    payload.privilegedDocker === true,
    payload.cpuLimit || undefined,
  );
  const healthy = await agentHealthCheckPort(dockerPort, 30_000);
  if (!healthy) {
    throw new Error(`Recreated container did not accept connections on port ${dockerPort}`);
  }
  const relayPort = await ensureAgentRelay(
    job.deploymentName,
    dockerPort,
    Number(payload.relayPort) || undefined,
  );
  return {
    port: relayPort,
    dockerPort,
    containerId: run.id,
    containerName: run.containerName,
    extraPorts: run.extraPorts,
  };
}

async function processAgentJob(config, job) {
  try {
    let result;
    // The saved roles can be older than the coordinator's; check before refusing.
    if (config.roles?.deploy === false && job.type !== 'self-update')
      config.roles = (await coordinatorRoles(config).catch(() => null)) || config.roles;
    assertAgentJobAllowed(job, config.roles);
    if (job.telemetryToken) agentTelemetryTokens.set(job.deploymentName, job.telemetryToken);
    if (job.type === 'self-update') {
      if (!process.env.DEPLOY_WORKER_CHILD || !process.send)
        throw new Error('This worker has no restart supervisor.');
      // The terminal poll runs twice a second, and on a slow link each request takes most of
      // that (0.3 to 0.8 s from the iMac), so "a poll is in flight" was true nearly all the
      // time and the iMac declined every update. Being mid-poll is not a terminal: stop new
      // polls, let the one in flight finish, then look for a terminal that is really open.
      admittingUpdate = true;
      const admitted = setTimeout(() => (admittingUpdate = false), 60_000);
      admitted.unref();
      if (
        !(await settles(() => !claimingAgentExecSession, { timeoutMs: 15_000 })) ||
        activeAgentExecSessions.size
      ) {
        clearTimeout(admitted);
        admittingUpdate = false;
        throw new Error('A terminal is still active; the installed build was kept.');
      }
      if (
        job.payload.kind === 'code' &&
        !acceptsLauncher(
          job.payload.launcherProtocol,
          globalThis.deployLauncherBuild?.launcherProtocol,
        )
      )
        throw new Error('Unsupported launcher protocol');
      process.send({
        type: 'worker-update',
        request: {
          ...job.payload,
          jobId: job.id,
          url:
            job.payload.kind === 'code'
              ? `${config.coordinatorUrl}/cli/code?version=${encodeURIComponent(job.payload.targetVersion)}`
              : `${config.coordinatorUrl}/cli?os=${platform()}&arch=${arch()}&version=${encodeURIComponent(job.payload.targetVersion)}`,
        },
      });
      return;
    } else if (job.type === 'project-release') {
      // Sent in batches so the coordinator can show the build while it runs.
      let pendingOutput = '';
      let outputFlush = Promise.resolve();
      const flushOutput = () => {
        const output = pendingOutput;
        pendingOutput = '';
        if (!output) return outputFlush;
        outputFlush = outputFlush
          .then(() => reportAgentJobProgress(config, job, { stage: 'building', output }))
          .catch(() => {});
        return outputFlush;
      };
      const outputTimer = setInterval(() => void flushOutput(), 1000);
      try {
        result = await executeReleaseAgentJob({
          root: resolve(agentConfigPath(), '..', 'data'),
          job,
          download: (path) => downloadAgentArtifact(config, job, path),
          docker: agentBuildDocker(config, job),
          relay: (name, port, container) => ensureAgentRelay(name, port, undefined, container),
          onProgress: (parts) => reportAgentJobProgress(config, job, { parts }),
          onBuildOutput: (output) => {
            pendingOutput += output;
            if (pendingOutput.length >= 64 * 1024) void flushOutput();
          },
        });
      } finally {
        clearInterval(outputTimer);
        await flushOutput();
      }
    } else if (job.type === 'deploy') {
      result = await executeAgentDeploy(config, job);
    } else if (job.type === 'recreate') {
      result = await executeAgentRecreate(config, job);
    } else if (job.type === 'restart') {
      const graphContainers = await agentGraphContainerNames(job.deploymentName);
      await runChecked(
        'docker',
        [
          'restart',
          ...(graphContainers.length
            ? graphContainers
            : [`deploy-sh-${job.deploymentName.toLowerCase()}`]),
        ],
        { timeoutMs: 120_000 },
      );
      result = { restarted: true };
    } else if (job.type === 'start' || job.type === 'stop') {
      const graphContainers = await agentGraphContainerNames(job.deploymentName);
      await runChecked(
        'docker',
        [
          job.type,
          ...(graphContainers.length
            ? graphContainers
            : [`deploy-sh-${job.deploymentName.toLowerCase()}`]),
        ],
        { timeoutMs: 120_000 },
      );
      result = { [job.type]: true };
    } else if (job.type === 'delete') {
      agentTelemetryTokens.delete(job.deploymentName);
      await removeAgentDockerObjects({
        deploymentName: job.deploymentName,
        applicationId: job.payload?.applicationId,
        docker: (args) => runBounded('docker', args, { timeoutMs: dockerCommandTimeout(args) }),
      });
      if (job.payload?.deleteVolumes !== false) {
        rmSync(resolve(agentConfigPath(), '..', 'data', 'volumes', job.deploymentName), {
          recursive: true,
          force: true,
        });
      }
      await removeAgentRelay(job.deploymentName);
      // The coordinator treats anything short of this as not confirmed gone.
      result = { deleted: true, verified: true };
    } else if (job.type === 'logs') {
      const containerName = resolveAgentContainerName(
        job.deploymentName,
        job.payload?.containerName,
      );
      const logResult = await runBounded(
        'docker',
        ['logs', '--tail', String(job.payload?.tail || 1000), containerName],
        { maxOutput: 10 * 1024 * 1024 },
      );
      if (logResult.status !== 0) throw new Error(logResult.stderr || 'Unable to read logs');
      result = { logs: `${logResult.stdout || ''}${logResult.stderr || ''}` };
    } else if (job.type === 'backup') {
      const volumeDir = resolve(agentConfigPath(), '..', 'data', 'volumes', job.deploymentName);
      mkdirSync(resolve(volumeDir, 'data'), { recursive: true });
      mkdirSync(resolve(volumeDir, 'uploads'), { recursive: true });
      const archivePath = resolve(agentConfigPath(), '..', 'data', `${job.id}-backup.tar.gz`);
      await reportAgentJobProgress(config, job, {
        stage: 'compressing backup',
        processedBytes: 0,
        totalBytes: 0,
        message: 'Compressing managed volumes',
      }).catch(() => {});
      const volumeEntries = ['data', 'uploads'];
      if (existsSync(resolve(volumeDir, 'graph'))) volumeEntries.push('graph');
      try {
        await runChecked('tar', ['-czf', archivePath, '-C', volumeDir, ...volumeEntries], {
          timeoutMs: DATA_COMMAND_TIMEOUT_MS,
        });
        await reportAgentJobProgress(config, job, {
          stage: 'uploading backup',
          processedBytes: 0,
          totalBytes: statSync(archivePath).size,
          message: 'Uploading managed-volume archive to the coordinator',
        }).catch(() => {});
        result = await uploadAgentBackup(config, job, archivePath);
      } finally {
        rmSync(archivePath, { force: true });
      }
    } else if (job.type === 'restore') {
      if (!job.artifactUrl) throw new Error('Restore job is missing its backup archive');
      const volumeDir = resolve(agentConfigPath(), '..', 'data', 'volumes', job.deploymentName);
      const archivePath = resolve(agentConfigPath(), '..', 'data', `${job.id}-restore.tar.gz`);
      try {
        await downloadAgentArtifact(config, job, archivePath);
        // Validate before replacing the current managed-volume directory so a
        // corrupt or hostile backup cannot destroy the last usable copy.
        await inspectUploadArchive(archivePath);
        rmSync(volumeDir, { recursive: true, force: true });
        mkdirSync(volumeDir, { recursive: true });
        await extractAgentArchive(config, job, archivePath, volumeDir);
        if (job.payload?.restart !== false && (await agentContainerExists(job.deploymentName))) {
          await runChecked('docker', ['restart', `deploy-sh-${job.deploymentName.toLowerCase()}`], {
            timeoutMs: 120_000,
          });
        }
        result = { restored: true };
      } finally {
        rmSync(archivePath, { force: true });
      }
    } else {
      throw new Error(`Unsupported agent job type: ${job.type}`);
    }
    await completeAgentJobOnCoordinator(config, job.id, { success: true, result });
  } catch (err) {
    await completeAgentJobOnCoordinator(config, job.id, {
      success: false,
      error: err.message || String(err),
      result: {
        buildOutput: err.buildOutput || '',
        buildDuration: err.buildDuration || 0,
        ...(job.type === 'project-release' && err.parts ? { parts: err.parts } : {}),
      },
    }).catch((reportErr) => {
      console.error(`Unable to report failed job ${job.id}: ${reportErr.message}`);
    });
  }
}

const activeAgentExecSessions = new Map();
let claimingAgentExecSession = false;
let admittingUpdate = false;

async function postAgentExec(config, sessionId, action, body = {}) {
  return request(`${config.coordinatorUrl}/api/agent/exec/${sessionId}/${action}`, {
    method: 'POST',
    headers: {
      ...agentHeaders(config),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function runAgentExecSession(config, descriptor) {
  const containerName = resolveAgentContainerName(
    descriptor.deploymentName,
    descriptor.containerName,
  );
  const session = descriptor.containerName
    ? agentExecContainerByName(containerName, descriptor.cols, descriptor.rows)
    : agentExecContainer(descriptor.deploymentName, descriptor.cols, descriptor.rows);
  activeAgentExecSessions.set(descriptor.id, session);
  let output = Buffer.alloc(0);
  let flushTimer = null;
  const flushOutput = async () => {
    flushTimer = null;
    if (output.length === 0) return;
    const chunk = output;
    output = Buffer.alloc(0);
    await postAgentExec(config, descriptor.id, 'output', {
      output: chunk.toString('base64'),
    }).catch(() => {});
  };
  session.on('data', (chunk) => {
    output = Buffer.concat([output, chunk]);
    if (!flushTimer) {
      flushTimer = setTimeout(() => void flushOutput(), 20);
      flushTimer.unref();
    }
  });
  session.on('exit', (info) => {
    activeAgentExecSessions.delete(descriptor.id);
    void (async () => {
      if (flushTimer) clearTimeout(flushTimer);
      await flushOutput();
      await postAgentExec(config, descriptor.id, 'exit', info).catch(() => {});
    })();
  });
  void (async () => {
    while (!session.closed) {
      try {
        const control = await postAgentExec(config, descriptor.id, 'poll');
        for (const input of control.input || []) {
          session.write(Buffer.from(input, 'base64'));
        }
        if (control.resize) session.resize(control.resize.cols, control.resize.rows);
        if (control.kill) session.kill();
      } catch (err) {
        if (String(err.message || err).includes('not found')) {
          session.kill();
          break;
        }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  })();
}

async function claimAgentExecSessionFromCoordinator(config) {
  if (claimingAgentExecSession || admittingUpdate || workerUpdatePending()) return;
  claimingAgentExecSession = true;
  try {
    const response = await fetch(`${config.coordinatorUrl}/api/agent/exec/claim`, {
      method: 'POST',
      headers: agentHeaders(config),
    });
    if (response.status === 204) return;
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Unable to claim terminal session');
    if (!activeAgentExecSessions.has(body.id)) runAgentExecSession(config, body);
  } finally {
    claimingAgentExecSession = false;
  }
}

let supervisorMaintenance = false;
function workerUpdatePending() {
  if (supervisorMaintenance) return true;
  const receipt = workerUpdateReceipt(
    process.env.DEPLOY_DATA_DIR || resolve(agentConfigPath(), '..', 'data'),
  );
  const swap = supervisorSwapReceipt(
    process.env.DEPLOY_DATA_DIR || resolve(agentConfigPath(), '..', 'data'),
  );
  return (
    (receipt && ['staging', 'starting'].includes(receipt.state)) ||
    (swap && ['queued', 'staging', 'starting'].includes(swap.state))
  );
}

async function cmdAgentRun() {
  const config = readAgentConfig();
  if (!config) throw new Error(`Agent is not enrolled (${agentConfigPath()} not found)`);
  // launchd starts user agents with `/` as their working directory. Shared
  // build code falls back to `<cwd>/.deploy-data`, which would otherwise
  // become the unwritable `/.deploy-data`. Anchor every agent-owned cache and
  // temporary artifact beside agent.json instead.
  process.env.DEPLOY_DATA_DIR ||= resolve(agentConfigPath(), '..', 'data');
  mkdirSync(process.env.DEPLOY_DATA_DIR, { recursive: true });
  enableLocalTlsTrust(config.coordinatorUrl);
  const agentDir = dirname(agentConfigPath());
  const executable = supervisedExecutable(process.execPath, agentDir);
  if (!process.env.DEPLOY_WORKER_CHILD && executable && ['darwin', 'linux'].includes(platform())) {
    const paths = workerExecutablePaths(agentDir);
    const installed = executable === paths.executable;
    // A Mac's worker app must stay sealed to reach the coordinator. The running supervisor is
    // signed at install and never re-signed here.
    const seal =
      installed && paths.app
        ? () => sealWorkerBundle(paths.app, { signSupervisor: false })
        : undefined;
    const controller = new AbortController();
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
    await superviseWorker({
      executable,
      // Relays load current code on their next natural start; updates never interrupt them.
      relay: { executable: process.execPath, path: agentRelayStatePath() },
      previous: installed ? paths.previous : undefined,
      afterInstall: seal,
      // After the relays are up: this check waited ten minutes on a busy disk and, as the
      // first thing the supervisor did, kept the relays from ever starting.
      beforeWorker: seal
        ? () => sealWorkerBundle(paths.app, { signSupervisor: false, ifNeeded: true })
        : undefined,
      root: process.env.DEPLOY_DATA_DIR,
      agentDir,
      version: BUILD_INFO.version,
      signal: controller.signal,
      onUpdated: restartUpdatedServices,
    });
    return;
  }
  if (process.env.DEPLOY_WORKER_CHILD && process.connected)
    process.once('disconnect', () => process.exit(1));
  if (process.env.DEPLOY_WORKER_CHILD && process.connected) {
    setInterval(() => {
      if (process.connected)
        process.send?.(
          { type: 'worker-heartbeat', token: process.env.DEPLOY_WORKER_CHILD },
          () => {},
        );
    }, 10_000).unref();
  }
  const runApps = servicePlan(config.roles).apps;
  // Even discovery failure must not fall back to issuing tokens into the worker's own DB.
  configureRemoteTelemetry(async (name) => {
    const token = agentTelemetryTokens.get(name);
    if (!agentTelemetry || !token) return {};
    return {
      RFR_TELEMETRY_URL: agentTelemetry.url,
      RFR_TELEMETRY_TOKEN: token,
      DEPLOY_TELEMETRY_URL: agentTelemetry.url,
      DEPLOY_TELEMETRY_TOKEN: token,
    };
  });
  if (runApps) {
    try {
      agentTelemetry = await startTelemetryRelay(config);
    } catch (error) {
      console.warn('[telemetry] relay unavailable:', error.message || error);
    }
    await restoreAgentRelays();
    await repairAgentRelays();
    setInterval(() => void repairAgentRelays(), 15_000).unref();
  }
  enableLocalTlsTrust(config.coordinatorUrl);
  let reportedError = '';
  const heartbeat = async () => {
    try {
      await sendAgentHeartbeat(config);
      process.send?.({
        type: 'worker-ready',
        token: process.env.DEPLOY_WORKER_CHILD,
        version: BUILD_INFO.version,
      });
      reportedError = '';
    } catch (err) {
      const message = err.message || String(err);
      if (message !== reportedError) {
        console.error(`Agent heartbeat failed: ${message}`);
        reportedError = message;
      }
    }
  };
  await heartbeat();
  const heartbeatTimer = setInterval(heartbeat, 10_000);
  heartbeatTimer.unref();
  // App terminals need app containers; with Deploy apps off there are none to open.
  if (runApps) {
    const execClaimTimer = setInterval(
      () =>
        void claimAgentExecSessionFromCoordinator(config).catch((err) => {
          console.error(`Agent terminal poll failed: ${err.message || err}`);
        }),
      500,
    );
    execClaimTimer.unref();
  }
  let supervisorChecked = false;
  while (true) {
    try {
      const job = workerUpdatePending() ? null : await claimAgentJobFromCoordinator(config);
      if (job) await processAgentJob(config, job);
      else if (
        process.env.DEPLOY_WORKER_CHILD &&
        !supervisorChecked &&
        !workerUpdatePending() &&
        !activeAgentExecSessions.size &&
        !claimingAgentExecSession
      ) {
        supervisorMaintenance = true;
        try {
          await scheduleSupervisorSwap({
            agentDir,
            root: process.env.DEPLOY_DATA_DIR,
            reserve: async (target) => {
              const result = await request(`${config.coordinatorUrl}/api/agent/supervisor-swap`, {
                method: 'POST',
                headers: { ...agentHeaders(config), 'Content-Type': 'application/json' },
                body: JSON.stringify({ target }),
              });
              if (!result.reserved) throw new Error('Supervisor swap is waiting for idle jobs');
              return true;
            },
          });
          supervisorChecked = true;
        } finally {
          supervisorMaintenance = false;
        }
      }
    } catch (err) {
      console.error(`Agent job poll failed: ${err.message || err}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
}

async function cmdAgentStatus(json = false) {
  const config = readAgentConfig();
  const services = await installedServices();
  let roles = null,
    coordinatorError = null;
  if (config) {
    try {
      roles = await coordinatorRoles(config);
    } catch (error) {
      coordinatorError = error.message;
      process.exitCode = 1;
    }
  }
  if (json) {
    const status = await readNodeStatus({
      config,
      helper: async () => JSON.parse(await runDesktopHelper('status', { json: true })),
    });
    console.log(JSON.stringify({ ...status, services, roles, coordinatorError }, null, 2));
  } else {
    console.log(
      config
        ? `${config.name} is enrolled with ${config.coordinatorUrl}`
        : 'Agent is not enrolled.',
    );
    console.log(
      roles
        ? `Roles: ${Object.entries(roles)
            .map(([role, enabled]) => `${role} ${enabled ? 'on' : 'off'}`)
            .join(', ')}`
        : `Coordinator roles unavailable${coordinatorError ? `: ${coordinatorError}` : ''}`,
    );
    for (const [name, state] of Object.entries(services))
      console.log(
        `${name === 'worker' ? 'Task worker' : 'Execution agent'}: ${!state.installed ? 'not installed' : state.running ? 'running' : 'installed, stopped'}`,
      );
  }
  const plan = servicePlan(roles || config?.roles);
  if (
    !config ||
    Object.entries(services).some(
      // Without Deploy apps the agent only adds automatic updates; it is not required.
      ([name, state]) =>
        ((name === 'agent' ? plan.apps : plan[name]) || state.installed) && !state.running,
    )
  )
    process.exitCode = 1;
}

async function cmdDeploy(
  serverUrl,
  appName,
  { noCache = false, revisionResolution = null, confirmDestructive = false, projectId } = {},
) {
  const config = loadConfig();
  if (!config.token) {
    throw cliError("You're signed out.", 'deploy login');
  }

  const dir = process.cwd();
  const name = (appName || basename(dir)).toLowerCase();

  // Ask the coordinator before doing any bundling work. Older servers omit
  // placementReady, in which case the legacy single-node behavior continues.
  const admission = await request(`${serverUrl}/api/deploy-admission`, {
    headers: authHeaders(config),
  });
  if (admission.placementReady === false) {
    const setupUrl = new URL(admission.setupUrl || '/dashboard/nodes', serverUrl).toString();
    throw new Error(
      `A default computer has not been configured.\n\nChoose one at ${setupUrl}\nThen run deploy again.`,
    );
  }

  // A node move owns the application exclusively until its backup and restore
  // finish. New coordinators expose this preflight so a second deploy is
  // rejected before we spend time bundling or uploading it.
  const appAdmissionResponse = await fetch(
    `${serverUrl}/api/deploy-admission/${encodeURIComponent(name)}`,
    { headers: authHeaders(config) },
  );
  if (appAdmissionResponse.ok) {
    const appAdmission = await appAdmissionResponse.json();
    if (appAdmission.migrationActive) {
      const statusUrl = new URL(
        appAdmission.dashboardUrl || `/dashboard/${encodeURIComponent(name)}/build`,
        serverUrl,
      ).toString();
      throw new Error(
        `${name} is currently moving between computers.\n\nFollow its progress at ${statusUrl}`,
      );
    }
  } else if (appAdmissionResponse.status !== 404) {
    const message = await appAdmissionResponse.text();
    throw new Error(`Unable to check release admission: ${message}`);
  }

  const repositoryAdmission = await prepareRepositoryDeploy(
    serverUrl,
    name,
    config,
    dir,
    revisionResolution,
  );

  const tarball = resolve(dir, `${name}.tar.gz`);

  if (!values.json) console.log(`${name} · release${noCache ? ' (no cache)' : ''}\n`);

  const files = listBundleFiles(dir);
  const listFile = resolve(dir, '.deploy-tar-list');
  writeFileSync(listFile, files.join('\0'));
  const hasPigz = spawnSync('pigz', ['--version'], { stdio: 'ignore' }).status === 0;
  const bundleStartedAt = Date.now();
  const tarArgs = hasPigz
    ? ['-I', 'pigz -1', '-cf', tarball, '--null', '-T', listFile]
    : ['-czf', tarball, '--null', '-T', listFile];
  try {
    execFileSync('tar', tarArgs, {
      cwd: dir,
      stdio: 'pipe',
      // gzip level 1 is substantially faster for LAN deploys. pigz uses all
      // available cores when installed; regular gzip remains the fallback.
      env: { ...process.env, GZIP: '-1' },
    });
  } catch (error) {
    rmSync(tarball, { force: true });
    rmSync(listFile, { force: true });
    throw error;
  }
  const bundleMs = Date.now() - bundleStartedAt;
  if (!values.json)
    console.log(
      stepLine(
        '✓',
        `Packed ${files.length} files`,
        `${formatBytes(statSync(tarball).size)} · ${elapsed(bundleMs)}`,
      ),
    );
  try {
    unlinkSync(listFile);
  } catch {}

  const boundary = '----DeployBoundary' + Date.now();
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`;
  // Field order doesn't matter to busboy — server reads `name` and `noCache`
  // before invoking the docker build. Keep `name` first so legacy server
  // versions still accept the request.
  const nameField =
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}` +
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="detached"\r\n\r\n1` +
    (repositoryAdmission.expectedParentDigest
      ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="expectedParentDigest"\r\n\r\n${repositoryAdmission.expectedParentDigest}`
      : '') +
    (repositoryAdmission.resolution
      ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="revisionResolution"\r\n\r\n${repositoryAdmission.resolution}`
      : '') +
    (confirmDestructive
      ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="confirmDestructive"\r\n\r\n1`
      : '') +
    (noCache
      ? `\r\n--${boundary}\r\nContent-Disposition: form-data; name="noCache"\r\n\r\n1`
      : '') +
    `\r\n--${boundary}--\r\n`;

  const bodyParts = {
    prefix: Buffer.from(header),
    filePath: tarball,
    suffix: Buffer.from(nameField),
  };

  let deployment;
  try {
    deployment = await uploadWithProgress(`${serverUrl}/api/upload`, bodyParts, {
      ...authHeaders(config),
      ...(projectId ? { 'x-deploy-project-id': projectId } : {}),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    });
  } finally {
    rmSync(tarball, { force: true });
    rmSync(listFile, { force: true });
  }

  if (deployment?.unchanged && deployment?.sourceAligned) {
    if (values.json) outputJson({ name, state: 'unchanged', digest: deployment.digest, steps: [] });
    else
      console.log(
        `Repository matches ${deployment.digest}. Runtime was not restarted.\n  Next: deploy status`,
      );
    return;
  }

  // In a terminal each step shows as it happens and the command ends once the release is in
  // use. --json keeps waiting for the release to settle, as scripts expect.
  const reporter = values.json
    ? null
    : releaseReporter({
        write: (text) => process.stdout.write(text),
        live: !!process.stdout.isTTY,
      });
  const watch = reporter
    ? { onChange: (release) => reporter.update(release), untilActivated: true }
    : {};
  const result = deployment?.release
    ? await followDeploy(api, name, deployment, waitTimeout(), watch)
    : deployment?.accepted
      ? await followDeploy(api, name, deployment, waitTimeout(), watch)
      : { name, state: 'live', steps: releaseSteps('live', 'Build and startup completed') };
  result.url = appUrl(serverUrl, name);
  // Only a project release reports real steps; the older receipt keeps its plain summary.
  const stepped = (result.steps || []).some((step) => step.startedAt);
  if (values.json) outputJson(result);
  else if (stepped) {
    reporter.update(result);
    reporter.finish(result, { url: result.url, startedAt: bundleStartedAt });
  } else printRelease(result);
  if (result.state === 'failed') process.exitCode = 1;
  if (result.state === 'running' && !(reporter && releaseActivated(result))) process.exitCode = 1;
}

async function cmdList(serverUrl) {
  const config = loadConfig();
  const deployments = await request(`${serverUrl}/api/deployments`, {
    headers: authHeaders(config),
  });

  if (values.json) return outputJson(deployments);
  if (!deployments.length) {
    console.log('No deployments. Run: deploy  (from a project directory)');
    return;
  }

  console.log('');
  for (const d of deployments) {
    const status = d.status || 'unknown';
    console.log(`  ${d.name}  ${appUrl(serverUrl, d.name)}  [${status}]`);
  }
  console.log('');
}

async function cmdLogs(serverUrl, appName, selector = {}) {
  if (!appName) {
    console.error(
      'Usage: deploy logs -a <name> [--site <site>] [--component <component>] [--instance <id>]',
    );
    process.exit(1);
  }
  const config = loadConfig();
  if (selector.build) {
    const result = await api(`/api/deployments/${encodeURIComponent(appName)}/build-logs`);
    const build = result.activeBuild || result.logs?.[0] || null;
    if (selector.json) outputJson({ app: appName, build });
    else console.log(build?.output || 'No build output yet. Next: deploy status');
    return;
  }
  const url = new URL(`/api/deployments/${encodeURIComponent(appName)}/logs`, serverUrl);
  if (selector.siteId) url.searchParams.set('siteId', selector.siteId);
  if (selector.component) url.searchParams.set('component', selector.component);
  if (selector.instanceId) url.searchParams.set('instanceId', selector.instanceId);
  const res = await fetch(url, {
    headers: authHeaders(config),
  });
  if (!res.ok) {
    throw Object.assign(cliError(`Couldn't read logs (${res.status}).`, 'deploy status'), {
      status: res.status,
    });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    process.stdout.write(
      selector.json ? JSON.stringify({ app: appName, output: text }) + '\n' : text,
    );
  }
}

async function cmdDelete(serverUrl, appName) {
  if (!appName) {
    console.error('Usage: deploy delete -a <name>');
    process.exit(1);
  }
  const config = loadConfig();
  await request(`${serverUrl}/api/deployments/${appName}`, {
    method: 'DELETE',
    headers: authHeaders(config),
  });
  console.log(`Deleted ${appName}`);
}

async function cmdServer(port) {
  const { spawn } = await import('node:child_process');
  const child = spawn('pnpm', ['run', 'preview', '--', '--port', String(port)], {
    stdio: 'inherit',
    cwd: resolve(import.meta.dirname, '..'),
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

function cmdSchema() {
  const filename = 'deploy.v1.schema.json';
  const schemaDest = resolve(process.cwd(), filename);
  writeFileSync(schemaDest, `${JSON.stringify(deployV1Schema, null, 2)}\n`);
  console.log(`Copied ${filename} to current directory`);
  console.log('For YAML Language Server support, add this first line to deploy.yaml:');
  console.log('  # yaml-language-server: $schema=./deploy.v1.schema.json');
}

async function cmdOpen(serverUrl, appName) {
  if (!appName) {
    console.error('Usage: deploy open -a <name>');
    process.exit(1);
  }
  const url = appUrl(serverUrl, appName);
  if (values.json) return outputJson({ url });
  console.log(`Opening ${url}`);
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
  else execFileSync(cmd, [url]);
}

// Open an interactive shell inside a deployment's container. Bridges the local
// TTY to the server's exec/PTY WebSocket protocol (the same one the dashboard
// terminal uses): we send keystrokes as `exec:input`, render `exec:output`, and
// forward terminal resizes so full-screen programs (top, vim) lay out correctly.
async function cmdSsh(serverUrl, appName) {
  if (!appName) {
    console.error('Usage: deploy ssh <name>');
    process.exit(1);
  }
  const config = loadConfig();
  if (!config.token) {
    throw cliError("You're signed out.", 'deploy login');
  }

  const name = appName.toLowerCase();
  const u = new URL(serverUrl);
  const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProto}//${u.host}/ws?username=${encodeURIComponent(config.username)}&token=${encodeURIComponent(config.token)}`;

  const stdin = process.stdin;
  const isTty = !!stdin.isTTY;
  const dims = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });

  const ws = new WebSocket(wsUrl);
  let exited = false;
  let onData = null;

  const onResize = () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ 'exec:resize': dims() }));
    }
  };

  function cleanup() {
    if (isTty && stdin.isRaw) stdin.setRawMode(false);
    if (onData) stdin.removeListener('data', onData);
    stdin.pause();
    process.removeListener('SIGWINCH', onResize);
  }

  function finish(code, error) {
    if (exited) return;
    exited = true;
    cleanup();
    if (error) process.stderr.write(`\r\n${error}\r\n`);
    try {
      ws.close();
    } catch {}
    process.exit(code ?? 0);
  }

  ws.onopen = () => {
    const { cols, rows } = dims();
    ws.send(JSON.stringify({ exec: name, cols, rows }));

    if (isTty) stdin.setRawMode(true);
    stdin.resume();
    onData = (chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ 'exec:input': chunk.toString('utf8') }));
      }
    };
    stdin.on('data', onData);
    process.on('SIGWINCH', onResize);
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
      if (msg.type === 'exec:output') {
        process.stdout.write(
          values.json ? JSON.stringify({ output: msg.data.output }) + '\n' : msg.data.output,
        );
      } else if (msg.type === 'exec:exit') {
        finish(msg.data?.code ?? 0, msg.data?.error);
      }
    } catch {
      /* ignore malformed frames */
    }
  };

  ws.onerror = () => finish(1, exited ? undefined : 'Connection error');
  ws.onclose = () => finish(1, exited ? undefined : 'Connection closed');
}

// ── Version & self-upgrade ──────────────────────────────────────────────────

function cmdVersion({ json = false } = {}) {
  const executable = globalThis.deployLauncherBuild;
  const info = {
    ...BUILD_INFO,
    platform: platformTarget(),
    launcherProtocol: executable?.launcherProtocol,
    executable: executable || BUILD_INFO,
    code: BUILD_INFO,
  };

  if (json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  console.log(`deploy ${info.version}`);
  console.log(
    `  executable: ${info.executable.version} (launcher protocol ${info.launcherProtocol || 0})`,
  );
  console.log(`  code: ${info.code.version}`);
  console.log(`  commit:   ${info.commit}${info.dirty ? ' (dirty working tree)' : ''}`);
  console.log(`  built:    ${info.buildTime ?? 'running from source (unpackaged)'}`);
  console.log(`  platform: ${info.platform}`);
  console.log(`  runtime:  node ${(info.runtime ?? process.version).replace(/^v/, '')}`);
}

// Replace the installed binary with the build this server serves. Version
// equality — not ordering — decides: the CLI's job is to match its server, so
// a server rolled back to an older build should pull the CLI back with it.
async function cmdUpgrade(serverUrl, { check = false, force = false } = {}) {
  const target = platformTarget();

  let manifest;
  try {
    manifest = await request(`${serverUrl}/cli/version`);
  } catch (err) {
    throw new Error(`Update check against ${serverUrl} failed: ${err.message}`, { cause: err });
  }
  if (!manifest || typeof manifest !== 'object' || !manifest.version) {
    throw new Error(
      `${serverUrl} returned no CLI build manifest. Run 'pnpm build:cli' on the server.`,
    );
  }

  console.log(`Installed: ${BUILD_INFO.version}`);
  console.log(`Server:    ${manifest.version}`);

  if (manifest.version === BUILD_INFO.version && !force) {
    console.log('\nAlready running the build this server serves.');
    return;
  }
  if (check) {
    console.log('\nA different build is available. Run: deploy upgrade');
    process.exit(1);
  }

  const expected = manifest.targets?.[target];
  if (!expected) {
    const available = Object.keys(manifest.targets ?? {}).join(', ') || 'none';
    throw new Error(`Server has no CLI binary for ${target} (available: ${available})`);
  }

  if (!(await isPackagedBinary())) {
    console.error('\nNot a packaged binary — upgrade can only replace an installed deploy binary.');
    console.error('Running from source? Rebuild with: pnpm build:cli');
    console.error(`Otherwise reinstall with: curl -fsSL ${serverUrl}/install | sh`);
    process.exit(1);
  }

  // Resolve symlinks so we replace the real binary, not a link to it.
  const installPath = realpathSync(process.execPath);
  const installDir = dirname(installPath);
  try {
    accessSync(installDir, fsConstants.W_OK);
  } catch {
    console.error(`\nNo write access to ${installDir}.`);
    console.error(`Retry with: sudo ${installPath} upgrade`);
    process.exit(1);
  }

  console.log(`\nDownloading ${manifest.version} for ${target}...`);
  const res = await fetch(`${serverUrl}/cli?os=${process.platform}&arch=${process.arch}`);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());

  await installWorkerBuild({
    path: installPath,
    bytes,
    sha256: expected.sha256,
    size: expected.size,
    version: manifest.version,
  });

  console.log(`\nUpgraded ${installPath}`);
  const installed = await runBounded(installPath, ['version'], { timeoutMs: 30_000 });
  console.log(installed.stdout?.trim() || `deploy ${manifest.version}`);
}

// ── Catalog and recovery administration ───────────────────────────────────

function authenticatedAdminRequest(serverUrl) {
  const config = loadConfig();
  if (!config.token) throw new Error('Not logged in. Run: deploy login');
  return (path, options = {}) =>
    request(`${serverUrl}${path}`, {
      ...options,
      headers: { ...authHeaders(config), ...(options.headers || {}) },
    });
}

function jsonOption(value, label) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} must be a JSON object`);
  }
}

async function cmdComponent(action, args, options, serverUrl) {
  const adminRequest = authenticatedAdminRequest(serverUrl);
  const app = args[0] || options.app || options.application;
  if (!app) {
    throw new Error(
      'Usage: deploy component <inspect|scale|restart|replace|operation> <app> [component] [value]',
    );
  }
  const encodedApp = encodeURIComponent(String(app).toLowerCase());
  if (action === 'inspect') {
    const siteId = typeof options.site === 'string' ? options.site.trim() : '';
    const query = siteId ? `?siteId=${encodeURIComponent(siteId)}` : '';
    const result = await adminRequest(`/api/deployments/${encodedApp}/application-runtime${query}`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const component = args[1];
  if (!component) throw new Error(`Usage: deploy component ${action} <app> <component>`);
  const encodedComponent = encodeURIComponent(component);
  if (action === 'scale') {
    const useDefault = options['use-default'] === true;
    const siteId = typeof options.site === 'string' ? options.site.trim() : '';
    if (useDefault && !siteId) {
      throw new Error('--use-default requires --site <site-id>');
    }
    const instances = useDefault ? null : Number(args[2] || options.instances);
    if (
      instances !== null &&
      (!Number.isSafeInteger(instances) || instances < 1 || instances > 128)
    ) {
      throw new Error(
        'Usage: deploy component scale <app> <component> <instances> [--site <site-id>] [--use-default]',
      );
    }
    const current = await adminRequest(`/api/deployments/${encodedApp}/application-spec`);
    const result = await adminRequest(
      `/api/deployments/${encodedApp}/components/${encodedComponent}/scale`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances,
          expectedParentDigest: current.desiredDigest || current.activeDigest,
          confirmDestructive: options['confirm-destructive'] === true,
          scope: siteId ? 'site' : 'default',
          ...(siteId ? { siteId, useDefault } : {}),
        }),
      },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === 'restart') {
    const result = await adminRequest(
      `/api/deployments/${encodedApp}/components/${encodedComponent}/restart`,
      { method: 'POST' },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === 'replace') {
    const instanceId = args[2] || options.instance;
    if (!instanceId) {
      throw new Error('Usage: deploy component replace <app> <component> <instance-id>');
    }
    const result = await adminRequest(
      `/api/deployments/${encodedApp}/components/${encodedComponent}/instances/${encodeURIComponent(instanceId)}/replace`,
      { method: 'POST' },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === 'operation') {
    const operation = args[2] || options.operation;
    if (!operation) {
      throw new Error('Usage: deploy component operation <app> <component> <operation>');
    }
    const result = await adminRequest(
      `/api/deployments/${encodedApp}/components/${encodedComponent}/operations/${encodeURIComponent(operation)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variables: jsonOption(options.variables, '--variables') }),
      },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(
    'Usage: deploy component <inspect|scale|restart|replace|operation> <app> [component] [value]',
  );
}

async function resolveCatalogRelease(adminRequest, id, requestedRelease) {
  if (requestedRelease) return requestedRelease;
  const catalog = await adminRequest(`/api/catalog?query=${encodeURIComponent(id)}`);
  const matches = catalog.releases.filter((entry) => entry.id === id);
  if (matches.length === 0) throw new Error(`Catalog application ${JSON.stringify(id)} not found`);
  return matches[0].release;
}

async function cmdCatalog(action, args, options, serverUrl) {
  const adminRequest = authenticatedAdminRequest(serverUrl);
  if (action === 'list') {
    const query = args.join(' ') || options.query || '';
    const catalog = await adminRequest(`/api/catalog?query=${encodeURIComponent(query)}`);
    if (options.json) return console.log(JSON.stringify(catalog, null, 2));
    for (const entry of catalog.releases) {
      console.log(
        `${entry.id}@${entry.release}  ${entry.name}  [${entry.trustTier}/${entry.stage}]`,
      );
    }
    if (catalog.releases.length === 0) console.log('No catalog releases matched.');
    return;
  }
  if (action === 'targets') {
    const result = await adminRequest('/api/catalog/targets');
    if (options.json) return console.log(JSON.stringify(result, null, 2));
    for (const target of result.targets) {
      console.log(
        `${target.siteId}  ${target.operatingSystem}/${target.architecture}  ${target.engine} ${target.engineVersion}`,
      );
    }
    return;
  }
  if (action === 'installations') {
    const result = await adminRequest('/api/catalog/installations');
    if (options.json) return console.log(JSON.stringify(result, null, 2));
    for (const installation of result.installations) {
      console.log(
        `${installation.id}  ${installation.applicationName}  ${installation.blueprintId}@${installation.release}  [${installation.status}]`,
      );
    }
    if (result.installations.length === 0) console.log('No catalog installations.');
    return;
  }
  if (action === 'status') {
    const id = args[0];
    if (!id) throw new Error('Usage: deploy catalog status <installation-id>');
    const result = await adminRequest(`/api/catalog/installations/${encodeURIComponent(id)}`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === 'inspect') {
    const id = args[0];
    if (!id) throw new Error('Usage: deploy catalog inspect <catalog-id> [release]');
    const release = await resolveCatalogRelease(adminRequest, id, args[1] || options.release);
    const result = await adminRequest(
      `/api/catalog/releases/${encodeURIComponent(id)}/${encodeURIComponent(release)}`,
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === 'preflight' || action === 'install') {
    const id = args[0];
    if (!id) throw new Error(`Usage: deploy catalog ${action} <catalog-id> [release]`);
    const release = await resolveCatalogRelease(adminRequest, id, args[1] || options.release);
    const applicationName = options.name || id;
    const result = await adminRequest(
      `/api/catalog/releases/${encodeURIComponent(id)}/${encodeURIComponent(release)}/${action}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationName,
          targetSiteId: options.site || 'coordinator',
          answers: jsonOption(options.answers, '--answers'),
        }),
      },
    );
    if (options.json || action === 'preflight') console.log(JSON.stringify(result, null, 2));
    else
      console.log(
        `Catalog install ${result.operation.status}: ${result.installation.applicationName} (${result.installation.id})`,
      );
    return;
  }
  const installationId = args[0];
  if (!installationId) {
    throw new Error(
      'Usage: deploy catalog <upgrade|rollback|retry|recovery-point|uninstall|detach|derive> <installation-id>',
    );
  }
  const detail = await adminRequest(
    `/api/catalog/installations/${encodeURIComponent(installationId)}`,
  );
  const expectedRevision = detail.installation.revision;
  let operation = action;
  let body = { expectedRevision };
  if (action === 'upgrade') {
    const toRelease = args[1] || options.release;
    if (!toRelease) throw new Error('Usage: deploy catalog upgrade <installation-id> <release>');
    body = {
      ...body,
      toRelease,
      targetSiteId: options.site || detail.installation.siteId,
      answers: jsonOption(options.answers, '--answers'),
      recoveryPointId: options['recovery-point'],
    };
  } else if (action === 'rollback') {
    const recoveryPointId = args[1] || options['recovery-point'];
    if (!recoveryPointId)
      throw new Error('Usage: deploy catalog rollback <installation-id> <recovery-point-id>');
    body = { ...body, recoveryPointId };
  } else if (action === 'retry') {
    body = { ...body, answers: jsonOption(options.answers, '--answers') };
  } else if (action === 'recovery-point') {
    operation = 'recovery-points';
    body = {};
  } else if (action === 'uninstall') {
    body = {
      ...body,
      retainData: !options['delete-data'],
      recoveryPointId: options['recovery-point'],
    };
  } else if (action === 'derive') {
    const localBlueprintId = args[1] || options['local-blueprint'];
    if (!localBlueprintId)
      throw new Error('Usage: deploy catalog derive <installation-id> <local-blueprint-id>');
    body = { ...body, localBlueprintId };
  } else if (action !== 'detach') {
    throw new Error(`Unknown catalog command: ${action}`);
  }
  const result = await adminRequest(
    `/api/catalog/installations/${encodeURIComponent(installationId)}/${operation}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  console.log(JSON.stringify(result, null, 2));
}

async function recoveryPassphrase(options, confirmation = false) {
  if (options.passphrase) return options.passphrase;
  const first = await prompt('Recovery passphrase: ', true);
  if (!confirmation) return first;
  const second = await prompt('Confirm recovery passphrase: ', true);
  if (first !== second) throw new Error('Recovery passphrases do not match');
  return first;
}

async function cmdRecovery(action, args, options, serverUrl) {
  const adminRequest = authenticatedAdminRequest(serverUrl);
  if (action === 'list') {
    const result = await adminRequest('/api/operations/recovery-bundles');
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === 'readiness') {
    const result = await adminRequest('/api/operations/release-readiness');
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
    return;
  }
  if (action === 'create') {
    const outputPath = options.output || args[0];
    if (!outputPath) throw new Error('Usage: deploy recovery create --output <server-path>');
    const result = await adminRequest('/api/operations/recovery-bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outputPath,
        passphrase: await recoveryPassphrase(options, true),
      }),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === 'verify') {
    const bundlePath = options.bundle || args[0];
    if (!bundlePath) throw new Error('Usage: deploy recovery verify <server-bundle-path>');
    const result = await adminRequest('/api/operations/recovery-bundles/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bundlePath,
        bundleId: options['bundle-id'],
        passphrase: await recoveryPassphrase(options),
      }),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === 'rehearse') {
    const bundleId = args[0] || options['bundle-id'];
    const bundlePath = options.bundle || args[1];
    if (!bundleId || !bundlePath) {
      throw new Error('Usage: deploy recovery rehearse <bundle-id> <server-bundle-path>');
    }
    const response = await adminRequest(
      `/api/operations/recovery-bundles/${encodeURIComponent(bundleId)}/rehearsal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bundlePath,
          passphrase: await recoveryPassphrase(options),
        }),
      },
    );
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  if (action === 'restore') {
    const bundlePath = options.bundle || args[0];
    const destinationDataDirectory = options['data-dir'] || args[1];
    if (!bundlePath || !destinationDataDirectory) {
      throw new Error(
        'Usage: deploy recovery restore <bundle-path> <empty-destination-data-directory>',
      );
    }
    const result = await adminRequest('/api/operations/recovery-bundles/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bundlePath,
        destinationDataDirectory,
        passphrase: await recoveryPassphrase(options),
      }),
    });
    console.log(JSON.stringify(result, null, 2));
    console.log(
      'Restore complete. Start the replacement Home with DEPLOY_DATA_DIR set to that path.',
    );
    return;
  }
  if (action === 'support') {
    const outputPath = options.output || args[0];
    if (!outputPath) throw new Error('Usage: deploy recovery support --output <server-path>');
    const result = await adminRequest('/api/operations/support-bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputPath }),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error('Usage: deploy recovery <list|readiness|create|verify|rehearse|restore|support>');
}

function waitTimeout() {
  if (values['wait-timeout'] === undefined) return Infinity;
  const seconds = Number(values['wait-timeout']);
  if (!Number.isFinite(seconds) || seconds < 0)
    throw cliError('--wait-timeout must be a nonnegative number of seconds.', 'deploy --help', 2);
  return seconds * 1000;
}

async function projectReleases(name) {
  try {
    return await contracts.projectReleases(api, name);
  } catch (error) {
    if (error.status === 404)
      throw cliError(
        "This deploy.local doesn't support project releases yet",
        'deploy help advanced',
        2,
      );
    throw error;
  }
}

async function cmdRollback(name) {
  const result = await projectReleases(name);
  const releases = Array.isArray(result) ? result : result.releases || [];
  const current = releases.find((release) => release.state === 'live');
  const target = values.release
    ? releases.find((release) => release.id === values.release)
    : releases.find(
        (release) => release.id !== current?.id && ['superseded', 'live'].includes(release.state),
      );
  if (!current || !target)
    throw cliError(
      'No previous release is available for this project.',
      `deploy releases ${name}`,
      2,
    );
  const changes = [
    `${name} · ${current.id} → ${target.id}`,
    ...(target.apps || []).map((app) => `  ${app.appId} → ${app.to}`),
    ...(current.migrations || []).map(
      (migration) =>
        `  ${migration.title}: ${migration.reversible ? 'undo migration' : 'requires restoring data from backup'}`,
    ),
  ];
  if ((current.migrations || []).some((migration) => !migration.reversible))
    throw cliError(
      'This rollback requires a data restore. Review the backup and possible data loss in the app.',
      `deploy open ${name}`,
      2,
    );
  if (!values.json) console.log(changes.join('\n'));
  if (!(await confirmChange(`Roll back ${name}?`, values.yes, prompt))) {
    if (values.json) outputJson({ cancelled: true });
    else console.log('Cancelled. Next: deploy status');
    return;
  }
  let rollback;
  try {
    rollback = await contracts.rollbackProject(api, name, target.id, current.id);
  } catch (error) {
    if (error.status === 404)
      throw cliError(
        "This deploy.local doesn't support project rollback yet",
        'deploy help advanced',
        2,
      );
    throw error;
  }
  const release = { ...(await followRollback(api, name, rollback, waitTimeout())), name };
  if (values.json) outputJson(release);
  else printRelease(release);
  if (release.state === 'failed' || release.state === 'running') process.exitCode = 1;
}

async function cmdTasks(create = false) {
  if (!create) {
    const state = await contracts.workspaceState(api);
    if (values.json) outputJson({ tasks: state.tasks });
    else {
      for (const task of state.tasks || [])
        console.log(`${task.id}  ${task.title}  ${task.status}`);
      if (!state.tasks?.length) console.log('No tasks yet. Next: deploy task "what to do"');
    }
    return;
  }
  const text = positionals[1];
  if (!text) throw cliError('Describe the task to start.', 'deploy task "what to do"', 2);
  // `--agent scout` named the old built-in agent; it is accepted so existing scripts keep working.
  if (values.agent && values.agent !== 'scout')
    throw cliError(
      'Agents start their own background runs. Use Run now on the agent’s page.',
      'deploy task "what to do"',
      2,
    );
  let workerId = 'local';
  if (values.on) {
    const state = await contracts.workspaceState(api);
    const worker = state.workers?.find(
      (worker) => worker.id === values.on || worker.name === values.on,
    );
    if (!worker)
      throw cliError(`Computer "${values.on}" is not available for tasks.`, 'deploy computers', 2);
    workerId = worker.id;
  }
  const task = await contracts.createWorkspaceTask(
    api,
    text,
    workerId,
    createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex'),
  );
  if (values.json) outputJson(task);
  else console.log(`Started task ${task.title} · ${task.id}\n  Next: deploy tasks`);
}

// ── CLI entry ───────────────────────────────────────────────────────────────

const ADVANCED_HELP = `
deploy.local — self-hosted deployment platform

Usage:
  deploy server              Start the deploy.local server
  deploy                     Deploy the current directory
  deploy publish            Scoped CI source publish (--source-commit, --expected-release, --idempotency-key, --wait)
  deploy release head|status|wait  Scoped durable release receipt
  deploy validate            Validate and summarize the local application graph
  deploy plan [-a <name>]    Compare the local graph with the server
  deploy schema              Copy the deploy.yaml v1 schema to the current directory
  deploy files               List files that will be bundled
  deploy list                List all deployments
  deploy logs -a <name>      Stream logs from a deployment
  deploy browser install     Install Chromium for this task worker
  deploy desktop-helper setup  Set up this Linux desktop for agents, asking before each change
  deploy desktop-helper <install|status|uninstall>  Linux desktop capture service (view-only)
  deploy desktop-helper install --allow-input  Also let approved agents click and type there
  deploy desktop-helper screen-lock <off|restore>  Keep a capture desktop unlocked, or undo
  deploy ssh <name>          Open an interactive shell in a deployment
  deploy delete -a <name>    Delete a deployment
  deploy open -a <name>      Open a deployment in the browser
  deploy register            Create a new account
  deploy login               Authenticate with the server
  deploy logout              Log out
  deploy whoami              Show current user
  deploy version             Show the installed build (commit + build time)
  deploy upgrade             Replace this CLI with the build the server serves
  deploy nodes enroll        Create enrollment (also in Dashboard → Nodes)
  deploy agent join <url>     Connect this computer with its selected roles
  deploy agent install        Repair background services for the selected roles
  deploy agent status         Check roles and local background services
  deploy agent uninstall      Remove local services and credentials
  deploy catalog list         Browse supported one-click applications
  deploy catalog inspect      Inspect a pinned catalog release
  deploy catalog install      Install through the ordinary application graph
  deploy catalog installations|status|upgrade|rollback|retry|uninstall
                             Operate catalog-managed applications
  deploy component inspect <app> [--site <site-id>]
                             Inspect desired and actual component graph state
  deploy component scale <app> <component> <instances> [--site <site-id>]
  deploy component scale <app> <component> --site <site-id> --use-default
  deploy component restart <app> <component>
  deploy component replace <app> <component> <instance-id>
  deploy component operation <app> <component> <operation>
                             Run a declared component-profile operation
  deploy recovery readiness   Evaluate the complete v1 release gate
  deploy recovery create|verify|rehearse|restore|list
                             Create and rehearse encrypted Home recovery

Options:
  -u, --url <url>            Server URL (default: https://deploy.local)
  -a, --application <name>   Application name
  -p, --port <port>          Server port (default: 80)
      --check                Report whether a different build is available and
                             exit 1 if so, without installing (upgrade only)
      --force                Reinstall even when versions match (upgrade only)
      --rebase               Rebase repository graph edits onto the current desired revision
      --replace              Explicitly replace a stale desired graph with repository state
      --json                 Machine-readable output
      --component <name>     Application graph component for logs
      --instance <id>        Exact graph instance for logs
      --release <version>    Pinned catalog release
      --answers <json>       Catalog setup answers as a JSON object
      --recovery-point <id>  Catalog recovery point for upgrade/rollback
      --delete-data          Delete catalog data during uninstall
      --local-blueprint <id> Local blueprint name when deriving
      --output <path>        Recovery/support output path on the server
      --bundle <path>        Recovery bundle path
      --bundle-id <id>       Durable recovery bundle record
      --data-dir <path>      Empty replacement Home data directory
      --passphrase <value>   Recovery passphrase (prompted when omitted)
      --variables <json>     Component profile operation variables
      --project <id>         Associate this manual deploy with an owned hosted repository
      --confirm-destructive  Confirm destructive application graph changes
      --no-cache             Build without using cached layers (deploy only).
                             Use when a previous build cached a bad layer
                             (e.g. truncated lockfile) and you need to force
                             a clean rebuild.
  -h, --help                 Show this help
`.trim();

const _ciCommand =
  process.argv[2] !== 'packages' &&
  process.argv.slice(2).some((arg) => arg === 'publish' || arg === 'release');
const _initialConfig = _ciCommand ? {} : loadConfig();
let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: {
        type: 'string',
        short: 'u',
        default: _ciCommand ? undefined : _initialConfig.url || DEFAULT_URL,
      },
      tag: { type: 'string' },
      claim: { type: 'boolean' },
      off: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      password: { type: 'boolean', default: false },
      fingerprint: { type: 'boolean', default: false },
      application: { type: 'string', short: 'a' },
      app: { type: 'string' },
      name: { type: 'string' },
      roles: { type: 'string' },
      desktop: { type: 'boolean' },
      port: { type: 'string', short: 'p', default: '80' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      check: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      rebase: { type: 'boolean', default: false },
      replace: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'allow-input': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      build: { type: 'boolean', default: false },
      on: { type: 'string' },
      agent: { type: 'string' },
      'no-cache': { type: 'boolean', default: false },
      site: { type: 'string' },
      component: { type: 'string' },
      query: { type: 'string' },
      release: { type: 'string' },
      answers: { type: 'string' },
      'recovery-point': { type: 'string' },
      'delete-data': { type: 'boolean', default: false },
      'local-blueprint': { type: 'string' },
      output: { type: 'string' },
      bundle: { type: 'string' },
      'bundle-id': { type: 'string' },
      'data-dir': { type: 'string' },
      passphrase: { type: 'string' },
      variables: { type: 'string' },
      instances: { type: 'string' },
      'use-default': { type: 'boolean', default: false },
      instance: { type: 'string' },
      operation: { type: 'string' },
      'source-archive-sha256': { type: 'string' },
      'source-commit': { type: 'string' },
      'idempotency-key': { type: 'string' },
      'expected-release': { type: 'string' },
      'wait-timeout': { type: 'string' },
      wait: { type: 'boolean', default: false },
      project: { type: 'string' },
      'confirm-destructive': { type: 'boolean', default: false },
      result: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string' },
      'look-at': { type: 'string' },
      'drop-instances': { type: 'boolean', default: false },
    },
    strict: false,
  }));
} catch (error) {
  console.error(
    process.argv.includes('--json')
      ? JSON.stringify({ error: { message: error.message, next: 'deploy --help' }, exitCode: 2 })
      : `✗ ${error.message}\n  Next: deploy --help`,
  );
  process.exit(2);
}

// Legacy administration commands emit JSON records too; structured payloads stay intact.
if (values.json) {
  for (const method of ['log', 'error']) {
    const write = console[method].bind(console);
    console[method] = (...args) => {
      const message = format(...args);
      try {
        write(JSON.stringify(JSON.parse(message)));
      } catch {
        write(JSON.stringify({ [method === 'error' ? 'error' : 'message']: message }));
      }
    };
  }
}

if (values.help || positionals[0] === 'help') {
  const help =
    positionals[0] === 'design' || (positionals[0] === 'help' && positionals[1] === 'design')
      ? DESIGN_HELP
      : positionals[0] === 'worker'
        ? 'Usage: deploy worker run\nRuns the enrolled task worker using local agent credentials.'
        : positionals.includes('advanced')
          ? ADVANCED_HELP
          : HELP;
  console.log(values.json ? JSON.stringify({ help }) : help);
  process.exit(0);
}

if (values.version && !positionals.length) {
  cmdVersion({ json: !!values.json });
  process.exit(0);
}

const command = positionals[0] || 'deploy';
const serverUrl = values.url;
const appCommands = [
  'deploy',
  'd',
  'logs',
  'l',
  'open',
  'o',
  'ssh',
  'exec',
  'delete',
  'rm',
  'remove',
  'plan',
  'rollback',
  'releases',
];
const explicitApp = values.application || values.app;
const positionalApp = appCommands.includes(command) ? positionals[1] : undefined;
const folderApp = getDeployManifestName(process.cwd()) ? basename(process.cwd()) : undefined;
const appName = (
  explicitApp ||
  positionalApp ||
  (appCommands.includes(command) ? folderApp : undefined)
)?.toLowerCase();
const api = (path, options = {}) =>
  request(`${serverUrl}${path}`, {
    ...options,
    headers: {
      ...authHeaders(loadConfig()),
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
const outputJson = (data) => console.log(JSON.stringify(data, null, 2));
/** What deploy design needs from this process: the coordinator, Git and the terminal. */
function designDeps() {
  const computer = (() => {
    if (platform() === 'darwin') {
      const name = spawnSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' });
      if (name.status === 0 && name.stdout.trim()) return name.stdout.trim();
    }
    return hostname();
  })();
  return {
    api,
    serverUrl,
    cwd: process.cwd(),
    home: homedir(),
    computer,
    git: (args, cwd, env) =>
      execFileSync('git', args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 1 << 28,
      }).trimEnd(),
    exists: existsSync,
    write: (text) => process.stdout.write(text),
    color: !!process.stdout.isTTY && process.env.NO_COLOR === undefined,
    spinner: !!process.stdout.isTTY,
    interactive: !!process.stdin.isTTY && !values.json,
    prompt,
    now: Date.now,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    capture: (url, widths, height) => captureRunningApp(url, widths, height),
  };
}
function requireApp() {
  if (!appName)
    throw cliError(
      'Which app? This folder is not a project.',
      `deploy ${command} home-gym, or run it in the project folder`,
      2,
    );
  return appName;
}

try {
  if (!_ciCommand) enableLocalTlsTrust(serverUrl);
  if (explicitApp && positionalApp && explicitApp.toLowerCase() !== positionalApp.toLowerCase())
    throw cliError(
      'The positional app and -a name disagree.',
      `deploy ${command} ${positionalApp}`,
      2,
    );
  if (appCommands.includes(command) && positionals.length > 2)
    throw cliError('Too many arguments.', `deploy ${command} --help`, 2);
  switch (command) {
    case 'browser':
      if (positionals[1] !== 'install') throw new Error('Usage: deploy browser install');
      await installChromium({ onProgress: console.log });
      break;
    case 'desktop-helper':
      console.log(
        await runDesktopHelper(positionals[1], {
          json: !!values.json,
          action: positionals[2],
          allowInput: !!values['allow-input'],
        }),
      );
      break;
    case 'task':
      await cmdTasks(true);
      break;
    case 'tasks':
      await cmdTasks();
      break;
    case 'releases': {
      const result = await projectReleases(requireApp());
      if (values.json) outputJson(result);
      else {
        const releases = Array.isArray(result) ? result : result.releases || [];
        for (const release of releases)
          console.log(`${release.id}  ${release.state}  ${release.apps.length} apps`);
        if (!releases.length) console.log('No releases yet. Next: deploy');
      }
      break;
    }
    case 'rollback':
      await cmdRollback(requireApp());
      break;
    case 'status': {
      if (values.fingerprint) {
        await printCertificateFingerprint(serverUrl);
        break;
      }
      const [deployments, fleet, inbox] = await Promise.all([
        api('/api/deployments'),
        api('/api/nodes'),
        readInbox(api),
      ]);
      const status = liveStatus(deployments, fleet, inbox);
      if (values.json) outputJson(status);
      else printLive(status);
      if (status.waiting.length) process.exitCode = 3;
      break;
    }
    case 'inbox': {
      if (positionals[1] === 'wait') {
        const seconds = values['wait-timeout'] === undefined ? 600 : Number(values['wait-timeout']);
        if (!Number.isFinite(seconds) || seconds < 0)
          throw cliError(
            '--wait-timeout must be a nonnegative number of seconds.',
            'deploy --help',
            2,
          );
        const waited = await waitInbox(api, positionals.slice(2).join(' '), {
          seconds,
          json: values.json,
        });
        if (values.json) outputJson(waited);
        else if (waited.item) {
          const answer = waited.item.answer;
          const label =
            waited.item.actions?.find((action) => action.id === answer?.actionId)?.label ??
            answer?.actionId ??
            'Answered';
          console.log(
            `✓ ${waited.item.title}: ${label}${answer?.by ? ` by ${answer.by} on ${answer.on}` : ''}.`,
          );
        } else console.log('Still waiting on you. Next: deploy inbox');
        // The same code as deploy status while something waits, so scripts can branch on it.
        if (waited.waiting) process.exitCode = 3;
        break;
      }
      const result = await runInbox(api, positionals.slice(1), values, prompt);
      if (result !== undefined) {
        if (values.json) outputJson(result);
        else
          console.log(
            result.cancelled ? 'Cancelled. Next: deploy inbox' : '✓ Answered. Next: deploy status',
          );
      }
      break;
    }
    case 'design': {
      const result = await runDesign(positionals[1], positionals.slice(2), values, designDeps());
      if (values.json) outputJson(result.json);
      process.exitCode = result.exitCode;
      break;
    }
    case 'computers': {
      const fleet = await api('/api/nodes');
      if (values.json) outputJson(fleet);
      else
        for (const computer of fleet.nodes || fleet)
          console.log(
            `${computer.name}  ${computer.status || (computer.online === true ? 'online' : computer.online === false ? 'offline' : 'Unavailable')}  ${computer.kind === 'coordinator' ? 'Coordinator' : 'Run apps'}`,
          );
      break;
    }
    case 'discover':
      await cmdCatalog(
        'list',
        [],
        { ...values, query: positionals.slice(1).join(' ') || values.query },
        serverUrl,
      );
      break;
    case 'install':
      if (!positionals[1]) throw cliError('Choose an app to install.', 'deploy discover', 2);
      if (await confirmChange(`Install ${positionals[1]} from Discover?`, values.yes, prompt))
        await cmdCatalog('install', positionals.slice(1), values, serverUrl);
      break;
    case 'server':
    case 'start':
      await cmdServer(values.port);
      break;
    case 'publish':
    case 'release':
      await runCiCli(command, positionals, values);
      break;
    case 'deploy':
    case 'd':
      if (values.rebase && values.replace) {
        throw new Error('Choose either --rebase or --replace, not both.');
      }
      waitTimeout();
      await cmdDeploy(serverUrl, appName, {
        noCache: !!values['no-cache'],
        revisionResolution: values.rebase ? 'rebase' : values.replace ? 'replace' : null,
        confirmDestructive: values['confirm-destructive'] === true,
        projectId: values.project,
      });
      break;
    case 'packages':
      await runPackages(positionals.slice(1), values, {
        serverUrl,
        config: loadConfig(),
        api,
        prompt,
      });
      break;
    case 'validate':
      cmdValidate();
      break;
    case 'plan':
      await cmdPlan(serverUrl, appName);
      break;
    case 'schema':
      cmdSchema();
      break;
    case 'files':
    case 'f':
      cmdFiles();
      break;
    case 'list':
    case 'ls':
      await cmdList(serverUrl);
      break;
    case 'logs':
    case 'l':
      await cmdLogs(serverUrl, requireApp(), {
        build: values.build,
        json: values.json,
        siteId: values.site,
        component: values.component,
        instanceId: values.instance,
      });
      break;
    case 'remove':
    case 'delete':
    case 'rm':
      if (
        await confirmChange(
          `Remove ${requireApp()}, its runtime, and all managed data?`,
          values.yes,
          prompt,
        )
      )
        await cmdDelete(serverUrl, appName);
      else console.log('Cancelled. Next: deploy status');
      break;
    case 'open':
    case 'o':
      await cmdOpen(serverUrl, requireApp());
      break;
    case 'ssh':
    case 'exec':
      await cmdSsh(serverUrl, requireApp());
      break;
    case 'register':
    case 'r':
      await cmdRegister(serverUrl);
      break;
    case 'login':
      if (values.password) await cmdLogin(serverUrl);
      else
        await browserLogin({
          request,
          serverUrl,
          openBrowser: async (url) => {
            if (process.platform === 'win32')
              execFileSync('rundll32', ['url.dll,FileProtocolHandler', url]);
            else execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
          },
          save: async (account) => {
            saveConfig({ ...loadConfig(), ...account });
            chmodSync(RC_PATH, 0o600);
          },
          print: values.json ? (text) => console.error(text) : console.log,
        });
      break;
    case 'logout':
      await cmdLogout(serverUrl);
      break;
    case 'whoami':
    case 'who':
    case 'me':
      await cmdWhoami();
      break;
    case 'version':
    case 'v':
      cmdVersion({ json: !!values.json });
      break;
    case 'upgrade':
    case 'update':
      await cmdUpgrade(serverUrl, { check: !!values.check, force: !!values.force });
      break;
    case 'nodes':
      if (positionals[1] !== 'enroll') {
        throw new Error('Usage: deploy nodes enroll --name <node-name>');
      }
      await cmdNodesEnroll(serverUrl, values.name);
      break;
    case 'worker':
      await cmdWorker(positionals[1]);
      break;
    case 'computer':
    case 'agent': {
      const agentCommand = positionals[1];
      if (agentCommand === 'join') {
        const coordinatorUrl = positionals[2] || serverUrl;
        enableLocalTlsTrust(coordinatorUrl);
        await cmdAgentJoin(coordinatorUrl, values.name);
      } else if (agentCommand === 'supervisor-swap') {
        try {
          await swapSupervisor({
            agentDir: dirname(agentConfigPath()),
            root: process.env.DEPLOY_DATA_DIR || resolve(agentConfigPath(), '..', 'data'),
            scheduled: true,
          });
        } finally {
          const job = process.env.DEPLOY_SWAP_JOB;
          // Removing the job also ends this process, so it is the last thing done. A failed
          // swap has already restored the old supervisor and recorded why.
          if (job && /^sh\.deploy\.supervisor-swap\.\d+$/.test(job))
            await runBounded('/bin/launchctl', ['remove', job], { timeoutMs: 15000 });
        }
      } else if (agentCommand === 'relay') {
        await runRelayProcess();
      } else if (agentCommand === 'run') {
        await cmdAgentRun();
      } else if (agentCommand === 'install') {
        await cmdAgentInstall();
      } else if (agentCommand === 'uninstall') {
        await cmdAgentUninstall();
      } else if (agentCommand === 'status') {
        await cmdAgentStatus(!!values.json);
      } else {
        throw new Error('Usage: deploy agent <join|install|status|uninstall>');
      }
      break;
    }
    case 'catalog':
      await cmdCatalog(positionals[1] || 'list', positionals.slice(2), values, serverUrl);
      break;
    case 'component':
      await cmdComponent(positionals[1] || 'inspect', positionals.slice(2), values, serverUrl);
      break;
    case 'recovery':
      await cmdRecovery(positionals[1] || 'readiness', positionals.slice(2), values, serverUrl);
      break;
    default: {
      const suggestion = suggestCommand(
        command,
        HELP.match(/^  [a-z]+/gm)
          .map((line) => line.trim())
          .concat(['login', 'logout', 'whoami', 'version', 'upgrade', 'help']),
      );
      throw cliError(
        `Unknown command "${command}".${suggestion ? ` Did you mean ${suggestion}?` : ''}`,
        suggestion ? `deploy ${suggestion}` : 'deploy --help',
        2,
      );
    }
  }
} catch (err) {
  const signedOut = err.status === 401 || /Not logged in/.test(err.message);
  const network = err.message === 'fetch failed';
  const message = signedOut
    ? "You're signed out."
    : network
      ? `Can't reach the coordinator at ${serverUrl}`
      : err.message;
  const next = signedOut
    ? 'deploy login'
    : err.next ||
      (network
        ? 'deploy status'
        : ['deploy', 'd', 'rollback'].includes(command)
          ? 'deploy logs --build'
          : `deploy ${command} --help`);
  const exitCode = err.exitCode || (/^Usage:/.test(message) ? 2 : 1);
  if (values.json) console.error(JSON.stringify({ error: { message, next }, exitCode }));
  else console.error(`✗ ${message}\n  Next: ${next}`);
  process.exitCode = exitCode;
}
