#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { basename, resolve, dirname } from 'node:path';
import { execSync, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { arch, cpus, homedir, networkInterfaces, platform, totalmem } from 'node:os';
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
  renameSync,
  realpathSync,
  accessSync,
  constants as fsConstants,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { connect, createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
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
import { executeAgentApplicationGraph } from '../server/agent-graph-runtime.ts';
import { SuitcaseTargetManager } from '../lib/suitcase-target.ts';
import { pairSuitcase } from '../lib/suitcase-sync-client.ts';
import deployV1Schema from '../deploy.v1.schema.json' with { type: 'json' };

const DEFAULT_URL = 'https://deploy.local';
const RC_PATH = resolve(homedir(), '.deployrc');

// ── Build identity ──────────────────────────────────────────────────────────

// scripts/build-cli.mjs bakes the build stamp in as a JSON string at bundle
// time. Run from source there is no stamp, so read the checkout instead.
const BUILD_INFO = (() => {
  if (typeof __DEPLOY_BUILD_INFO__ === 'string') {
    try {
      return JSON.parse(__DEPLOY_BUILD_INFO__);
    } catch {
      /* fall through to the source stamp */
    }
  }
  return sourceBuildInfo();
})();

function sourceBuildInfo() {
  let commit = 'unknown';
  let dirty = false;
  try {
    const opts = { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'ignore'] };
    commit = execSync('git rev-parse HEAD', opts).toString().trim() || 'unknown';
    dirty = execSync('git status --porcelain', opts).toString().trim() !== '';
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

// Trust self-signed certs when connecting to .local domains over HTTPS.
// This only affects this CLI process, not the server.
function enableLocalTlsTrust(serverUrl) {
  try {
    const u = new URL(serverUrl);
    if (u.protocol === 'https:' && u.hostname.endsWith('.local')) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
  } catch {}
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
  return new Promise((resolve) => {
    if (hidden) {
      const stdin = process.stdin;
      process.stdout.write(question);
      if (!stdin.isTTY) {
        const rl = createInterface({ input: stdin, output: process.stdout, terminal: false });
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
            process.stdout.write('\n');
            resolve(value);
            return;
          } else if (ch === '\u0003') {
            stdin.setRawMode(originalRawMode);
            process.stdout.write('\n');
            process.exit(130);
          } else if (ch === '\u007f' || ch === '\b') {
            if (value.length > 0) {
              value = value.slice(0, -1);
              process.stdout.write('\b \b');
            }
          } else if (ch >= ' ') {
            value += ch;
            process.stdout.write('*');
          }
        }
      };
      stdin.on('data', onData);
    } else {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
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
      process.stdout.write(
        `\n⚠ Upload ${err.reason || 'failed'} at ${formatBytes(err.uploadedBytes || 0)} / ${formatBytes(totalBytes)}` +
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
      // Trust self-signed certs for .local domains
      ...(isHttps && urlObj.hostname.endsWith('.local') && { rejectUnauthorized: false }),
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

function getDeployManifestName(dir) {
  return existsSync(resolve(dir, 'deploy.yaml')) ? 'deploy.yaml' : null;
}

function getIgnorePatterns(dir) {
  const manifestName = getDeployManifestName(dir);
  if (manifestName === 'deploy.yaml') {
    const source = readFileSync(resolve(dir, manifestName), 'utf-8');
    const { spec } = compileDeployYaml(source, manifestName);
    return [
      ...new Set(
        Object.values(spec.components).flatMap((component) => component.build?.ignore ?? []),
      ),
    ];
  }

  return [];
}

function listBundleFiles(dir) {
  const manifestName = getDeployManifestName(dir);
  const ignorePatterns = getIgnorePatterns(dir);
  const excludes = ['node_modules', ...ignorePatterns];

  let isGitRepo = false;
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe' });
    isGitRepo = true;
  } catch {}

  if (isGitRepo) {
    const allFiles = execSync('git ls-files -co --exclude-standard -z', {
      cwd: dir,
      encoding: 'utf-8',
    })
      .split('\0')
      .filter(Boolean);

    // Always include the deployment manifest even if gitignored — the server
    // needs it to compile the application.
    if (manifestName && !allFiles.includes(manifestName)) {
      allFiles.push(manifestName);
    }

    return allFiles.filter((f) => {
      if (f === manifestName) return true;
      if (excludes.some((p) => f === p || f.startsWith(p + '/'))) return false;
      // Drop paths that no longer exist on disk — `git ls-files -c` lists
      // tracked files including ones the user has `rm`'d but not yet
      // committed, which would make tar fail.
      return existsSync(resolve(dir, f));
    });
  } else {
    // For non-git repos, use find and apply excludes
    const findArgs = ['.', '-type', 'f'];
    for (const pattern of excludes) {
      findArgs.push('-not', '-path', `./${pattern}`, '-not', '-path', `./${pattern}/*`);
    }
    const files = execFileSync('find', findArgs, { cwd: dir, encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//, ''));
    return files;
  }
}

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
  console.log(`Plan for ${name}`);
  console.log(`  Current: ${remote.desiredDigest}`);
  console.log(`  Desired: ${local.compiled.digest} (${local.format})`);
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
      `Data: ${plan.impacts.data.effect}  ` +
      `Suitcase: ${plan.impacts.suitcase.disposition}`,
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
  const username = await prompt('Username: ');
  const password = await prompt('Password: ', true);

  const res = await request(`${serverUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  saveConfig({ ...loadConfig(), username, token: res.token, url: serverUrl });
  console.log(`Registered and logged in as ${username}`);
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
    console.log(config.username);
  } else {
    console.log('Not logged in. Run: deploy register  or  deploy login');
    process.exit(1);
  }
}

async function cmdNodesEnroll(serverUrl, nodeName) {
  if (!nodeName) {
    console.error('Usage: deploy nodes enroll --name <node-name>');
    process.exit(1);
  }
  const config = loadConfig();
  if (!config.token) {
    console.error('Not logged in. Run: deploy login');
    process.exit(1);
  }
  const enrollment = await request(`${serverUrl}/api/nodes/enrollment`, {
    method: 'POST',
    headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nodeName }),
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

function agentConfigPath() {
  if (process.env.DEPLOY_AGENT_CONFIG) return resolve(process.env.DEPLOY_AGENT_CONFIG);
  return platform() === 'darwin'
    ? resolve(homedir(), 'Library', 'Application Support', 'deploy.local', 'agent.json')
    : '/var/lib/deploy.local/agent.json';
}

function readAgentConfig() {
  const path = agentConfigPath();
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
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

function agentCapabilities() {
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const containers =
    docker.status === 0
      ? spawnSync(
          'docker',
          [
            'ps',
            '-a',
            '--filter',
            'name=deploy-sh-',
            '--format',
            '{{.ID}}\\t{{.Names}}\\t{{.State}}\\t{{.Status}}\\t{{.Label "deploy-sh.app"}}',
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        )
      : null;
  const reportedApps =
    containers?.status === 0
      ? containers.stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [id, containerName, status, detail, graphDeploymentName] = line.split('\t');
            const name =
              graphDeploymentName ||
              containerName.replace(/^deploy-sh-/, '').replace(/-prev-\d+$/, '');
            const relay = agentRelays.get(name);
            return {
              id,
              name,
              containerName,
              status,
              detail,
              relayPort:
                !relay?.containerName || relay.containerName === containerName
                  ? relay?.relayPort
                  : undefined,
            };
          })
          .filter((app) => app.containerName.startsWith('deploy-sh-'))
      : [];
  const apps = reportedApps.reduce((selected, app) => {
    const existing = selected.findIndex((candidate) => candidate.name === app.name);
    if (existing === -1) selected.push(app);
    else if (app.relayPort) selected[existing] = app;
    return selected;
  }, []);
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

function agentProgramArguments() {
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

function installAgentService() {
  const args = [...agentProgramArguments(), 'agent', 'run'];
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
  </dict>
  <key>StandardOutPath</key><string>${xmlEscape(resolve(logDir, 'agent.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(resolve(logDir, 'agent.err.log'))}</string>
</dict>
</plist>
`;
    writeFileSync(plistPath, plist);
    const domain = `gui/${uid}`;
    const serviceTarget = `${domain}/${label}`;
    const pause = (milliseconds) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    };
    spawnSync('launchctl', ['bootout', serviceTarget], { stdio: 'ignore' });

    let loaded;
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (attempt > 1) pause(attempt * 250);
      loaded = spawnSync('launchctl', ['bootstrap', domain, plistPath], {
        encoding: 'utf8',
      });
      if (loaded.status === 0) break;
      // launchd can return EIO while a KeepAlive process from the previous
      // definition is still exiting. Ensure both label and plist are unloaded
      // before retrying instead of telling the user to run the agent as root.
      spawnSync('launchctl', ['bootout', serviceTarget], { stdio: 'ignore' });
      spawnSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
    }
    if (loaded?.status !== 0) {
      const detail = String(loaded?.stderr || 'launchctl bootstrap failed').trim();
      throw new Error(
        `${detail}\nThe user agent could not be restarted after 4 attempts. Do not use sudo; wait a moment and retry.`,
      );
    }
    spawnSync('launchctl', ['kickstart', '-k', serviceTarget], { stdio: 'ignore' });
    const started = spawnSync('launchctl', ['print', `${domain}/${label}`], {
      encoding: 'utf8',
    });
    if (started.status !== 0) {
      throw new Error(started.stderr || 'launchd did not retain the agent service');
    }
    return;
  }

  if (process.getuid?.() !== 0) {
    throw new Error('Linux agent installation requires root. Re-run with sudo.');
  }
  const unitPath = '/etc/systemd/system/deploy-local-agent.service';
  const command = args.map((arg) => JSON.stringify(arg)).join(' ');
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

[Install]
WantedBy=multi-user.target
`,
  );
  const reload = spawnSync('systemctl', ['daemon-reload'], { encoding: 'utf8' });
  if (reload.status !== 0) throw new Error(reload.stderr || 'systemctl daemon-reload failed');
  const enabled = spawnSync('systemctl', ['enable', '--now', 'deploy-local-agent.service'], {
    encoding: 'utf8',
  });
  if (enabled.status !== 0) throw new Error(enabled.stderr || 'systemctl enable failed');
}

async function cmdAgentJoin(serverUrl, requestedName) {
  if (!process.env.DEPLOY_AGENT_CONFIG) {
    if (platform() === 'darwin' && process.getuid?.() === 0) {
      throw new Error(
        'Do not use sudo on macOS. Run deploy agent join from your normal login so the agent can use Docker Desktop and mounted storage.',
      );
    }
    if (platform() !== 'darwin' && process.getuid?.() !== 0) {
      throw new Error('On Linux, re-run with sudo to install the systemd service.');
    }
  }
  const code = await prompt('Enrollment code: ', true);
  const capabilities = agentCapabilities();
  const enrolled = await request(`${serverUrl}/api/agent/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      name: requestedName || undefined,
      platform: platform(),
      architecture: arch(),
      agentVersion: BUILD_INFO.version,
      capabilities,
    }),
  });
  const configPath = agentConfigPath();
  mkdirSync(resolve(configPath, '..'), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        coordinatorUrl: serverUrl,
        nodeId: enrolled.nodeId,
        name: enrolled.name,
        secret: enrolled.secret,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  chmodSync(configPath, 0o600);
  if (!process.env.DEPLOY_AGENT_CONFIG) installAgentService();
  console.log(`\n✓ Node registered as ${enrolled.name}`);
  console.log(`✓ Credentials stored in ${configPath}`);
  console.log('✓ Agent service installed and started');
  console.log(`\nConfigure this node at ${serverUrl}/dashboard/nodes\n`);
}

function cmdAgentInstall() {
  const config = readAgentConfig();
  if (!config) {
    throw new Error(`Agent is not enrolled (${agentConfigPath()} not found)`);
  }
  installAgentService();
  console.log(`Background agent service installed and started for ${config.name}`);
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
      capabilities: agentCapabilities(),
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

function agentRelayStatePath() {
  return resolve(agentConfigPath(), '..', 'data', 'relays.json');
}

function persistAgentRelays() {
  const relays = [...agentRelays.entries()].map(([deploymentName, relay]) => ({
    deploymentName,
    targetPort: relay.targetPort,
    relayPort: relay.relayPort,
    containerName: relay.containerName,
  }));
  writeFileSync(agentRelayStatePath(), JSON.stringify(relays, null, 2));
}

function listenAgentRelay(server, preferredPort) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (err) => {
      server.off('listening', onListening);
      rejectPromise(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolvePromise(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(preferredPort || 0);
  });
}

async function ensureAgentRelay(deploymentName, targetPort, preferredPort, containerName) {
  const previous = agentRelays.get(deploymentName);
  if (
    previous &&
    previous.targetPort === targetPort &&
    (!preferredPort || previous.relayPort === preferredPort)
  ) {
    return previous.relayPort;
  }
  if (previous) {
    for (const socket of previous.sockets) socket.destroy();
    await new Promise((resolvePromise) => previous.server.close(resolvePromise));
    agentRelays.delete(deploymentName);
  }
  const sockets = new Set();
  const server = createServer((client) => {
    const target = connect({ host: '127.0.0.1', port: targetPort });
    sockets.add(client);
    sockets.add(target);
    client.pipe(target);
    target.pipe(client);
    const close = () => {
      sockets.delete(client);
      sockets.delete(target);
      client.destroy();
      target.destroy();
    };
    client.on('close', close);
    target.on('close', close);
    client.on('error', close);
    target.on('error', close);
  });
  let relayPort;
  try {
    relayPort = await listenAgentRelay(server, preferredPort);
  } catch (err) {
    if (!preferredPort) throw err;
    relayPort = await listenAgentRelay(server, 0);
  }
  agentRelays.set(deploymentName, { server, sockets, targetPort, relayPort, containerName });
  persistAgentRelays();
  return relayPort;
}

async function restoreAgentRelays() {
  let saved = [];
  try {
    saved = JSON.parse(readFileSync(agentRelayStatePath(), 'utf8'));
  } catch {
    return;
  }
  for (const relay of saved) {
    if (
      typeof relay?.deploymentName !== 'string' ||
      !Number.isInteger(relay.targetPort) ||
      !Number.isInteger(relay.relayPort)
    ) {
      continue;
    }
    try {
      await ensureAgentRelay(
        relay.deploymentName,
        relay.targetPort,
        relay.relayPort,
        relay.containerName,
      );
    } catch (err) {
      console.error(`Unable to restore relay for ${relay.deploymentName}: ${err.message}`);
    }
  }
}

async function discoverAgentRelays() {
  const containers = spawnSync(
    'docker',
    ['ps', '--filter', 'name=deploy-sh-', '--format', '{{.Names}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (containers.status !== 0) return;
  for (const containerName of containers.stdout.trim().split('\n').filter(Boolean)) {
    if (!/^deploy-sh-.+/.test(containerName) || /-prev-\d+$/.test(containerName)) continue;
    const deploymentName = containerName.replace(/^deploy-sh-/, '');
    if (agentRelays.has(deploymentName)) continue;
    const ports = spawnSync('docker', ['port', containerName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const targetPort = Number(ports.stdout.match(/->\s+.*:(\d+)\s*$/m)?.[1] || 0);
    if (!Number.isInteger(targetPort) || targetPort <= 0) continue;
    try {
      await ensureAgentRelay(deploymentName, targetPort);
    } catch (err) {
      console.error(`Unable to expose ${deploymentName} to the coordinator: ${err.message}`);
    }
  }
}

async function removeAgentRelay(deploymentName) {
  const relay = agentRelays.get(deploymentName);
  if (!relay) return;
  for (const socket of relay.sockets) socket.destroy();
  await new Promise((resolvePromise) => relay.server.close(resolvePromise));
  agentRelays.delete(deploymentName);
  persistAgentRelays();
}

function agentContainerExists(deploymentName) {
  return (
    spawnSync('docker', ['container', 'inspect', `deploy-sh-${deploymentName.toLowerCase()}`])
      .status === 0
  );
}

function agentGraphContainerNames(deploymentName) {
  const result = spawnSync(
    'docker',
    ['ps', '-a', '--filter', `label=deploy-sh.app=${deploymentName}`, '--format', '{{.Names}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return result.status === 0 ? result.stdout.trim().split('\n').filter(Boolean) : [];
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
  });
}

function agentDirectorySize(directory) {
  return new Promise((resolvePromise) => {
    const sizeCheck = spawn('du', ['-sk', directory], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    sizeCheck.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    sizeCheck.on('error', () => resolvePromise(0));
    sizeCheck.on('close', (code) => {
      if (code !== 0) {
        resolvePromise(0);
        return;
      }
      resolvePromise(Number.parseInt(stdout.trim().split(/\s+/)[0] || '0', 10) * 1024);
    });
  });
}

async function extractAgentArchive(config, job, archivePath, volumeDir) {
  await inspectUploadArchive(archivePath);
  const totalBytes = Math.max(0, Number(job.payload?.totalBytes || 0));
  return new Promise((resolvePromise, rejectPromise) => {
    const extraction = spawn('tar', ['-xzf', archivePath, '-C', volumeDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    extraction.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
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
    extraction.on('error', (err) => {
      clearInterval(timer);
      rejectPromise(err);
    });
    extraction.on('close', (code) => {
      clearInterval(timer);
      if (code !== 0) {
        rejectPromise(new Error(`Backup extraction failed (${code}): ${stderr.trim()}`));
        return;
      }
      void (async () => {
        await currentReport;
        await report('Managed-volume extraction completed');
        resolvePromise();
      })();
    });
  });
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

function runAgentGraphDocker(args, options = {}) {
  return new Promise((resolvePromise) => {
    const command = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    command.stdout.on('data', (chunk) => {
      const output = chunk.toString();
      stdout += output;
      options.onOutput?.(output);
    });
    command.stderr.on('data', (chunk) => {
      const output = chunk.toString();
      stderr += output;
      options.onOutput?.(output);
    });
    command.on('error', (error) => {
      resolvePromise({ exitCode: 1, stdout, stderr: `${stderr}${error.message}` });
    });
    command.on('close', (code) => {
      resolvePromise({ exitCode: Number.isInteger(code) ? code : 1, stdout, stderr });
    });
  });
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
    execFileSync('tar', ['-xzf', artifactPath, '-C', sourceDir], { stdio: 'pipe' });
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
        { run: runAgentGraphDocker },
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
  const activeImageId = execFileSync(
    'docker',
    ['inspect', '--format', '{{.Image}}', containerName],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
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
    if (job.type === 'deploy') {
      result = await executeAgentDeploy(config, job);
    } else if (job.type === 'recreate') {
      result = await executeAgentRecreate(config, job);
    } else if (job.type === 'restart') {
      const graphContainers = agentGraphContainerNames(job.deploymentName);
      execFileSync(
        'docker',
        [
          'restart',
          ...(graphContainers.length
            ? graphContainers
            : [`deploy-sh-${job.deploymentName.toLowerCase()}`]),
        ],
        { stdio: 'pipe' },
      );
      result = { restarted: true };
    } else if (job.type === 'start' || job.type === 'stop') {
      const graphContainers = agentGraphContainerNames(job.deploymentName);
      execFileSync(
        'docker',
        [
          job.type,
          ...(graphContainers.length
            ? graphContainers
            : [`deploy-sh-${job.deploymentName.toLowerCase()}`]),
        ],
        { stdio: 'pipe' },
      );
      result = { [job.type]: true };
    } else if (job.type === 'delete') {
      const graphContainers = agentGraphContainerNames(job.deploymentName);
      if (graphContainers.length) {
        spawnSync('docker', ['rm', '-f', ...graphContainers], { stdio: 'ignore' });
      }
      spawnSync('docker', ['rm', '-f', `deploy-sh-${job.deploymentName.toLowerCase()}`], {
        stdio: 'ignore',
      });
      if (job.payload?.deleteVolumes !== false) {
        rmSync(resolve(agentConfigPath(), '..', 'data', 'volumes', job.deploymentName), {
          recursive: true,
          force: true,
        });
      }
      await removeAgentRelay(job.deploymentName);
      result = { deleted: true };
    } else if (job.type === 'logs') {
      const containerName = resolveAgentContainerName(
        job.deploymentName,
        job.payload?.containerName,
      );
      const logResult = spawnSync(
        'docker',
        ['logs', '--tail', String(job.payload?.tail || 1000), containerName],
        { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
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
      execFileSync('tar', ['-czf', archivePath, '-C', volumeDir, ...volumeEntries], {
        stdio: 'pipe',
      });
      try {
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
        if (job.payload?.restart !== false && agentContainerExists(job.deploymentName)) {
          execFileSync('docker', ['restart', `deploy-sh-${job.deploymentName.toLowerCase()}`], {
            stdio: 'pipe',
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
      },
    }).catch((reportErr) => {
      console.error(`Unable to report failed job ${job.id}: ${reportErr.message}`);
    });
  }
}

const activeAgentExecSessions = new Map();
let claimingAgentExecSession = false;

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
  if (claimingAgentExecSession) return;
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

async function cmdAgentRun() {
  const config = readAgentConfig();
  if (!config) throw new Error(`Agent is not enrolled (${agentConfigPath()} not found)`);
  // launchd starts user agents with `/` as their working directory. Shared
  // build code falls back to `<cwd>/.deploy-data`, which would otherwise
  // become the unwritable `/.deploy-data`. Anchor every agent-owned cache and
  // temporary artifact beside agent.json instead.
  process.env.DEPLOY_DATA_DIR = resolve(agentConfigPath(), '..', 'data');
  mkdirSync(process.env.DEPLOY_DATA_DIR, { recursive: true });
  await restoreAgentRelays();
  await discoverAgentRelays();
  enableLocalTlsTrust(config.coordinatorUrl);
  let reportedError = '';
  const heartbeat = async () => {
    try {
      await sendAgentHeartbeat(config);
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
  const execClaimTimer = setInterval(
    () =>
      void claimAgentExecSessionFromCoordinator(config).catch((err) => {
        console.error(`Agent terminal poll failed: ${err.message || err}`);
      }),
    500,
  );
  execClaimTimer.unref();
  while (true) {
    try {
      const job = await claimAgentJobFromCoordinator(config);
      if (job) await processAgentJob(config, job);
    } catch (err) {
      console.error(`Agent job poll failed: ${err.message || err}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
}

async function cmdAgentStatus() {
  const config = readAgentConfig();
  if (!config) {
    console.log('Agent is not enrolled.');
    process.exitCode = 1;
    return;
  }
  enableLocalTlsTrust(config.coordinatorUrl);
  try {
    await sendAgentHeartbeat(config);
    console.log(`${config.name} is enrolled and connected to ${config.coordinatorUrl}`);
    if (!process.env.DEPLOY_AGENT_CONFIG) {
      const service =
        platform() === 'darwin'
          ? spawnSync('launchctl', ['print', `gui/${process.getuid?.()}/sh.deploy.agent`], {
              stdio: 'ignore',
            })
          : spawnSync('systemctl', ['is-active', '--quiet', 'deploy-local-agent.service'], {
              stdio: 'ignore',
            });
      console.log(
        service.status === 0
          ? 'Background agent service is running'
          : 'Background agent service is not running; re-run agent join to install it',
      );
      if (service.status !== 0) process.exitCode = 1;
    }
  } catch (err) {
    console.log(`${config.name} is enrolled but cannot reach ${config.coordinatorUrl}`);
    console.log(`  ${err.message}`);
    process.exitCode = 1;
  }
}

async function cmdDeploy(
  serverUrl,
  appName,
  { noCache = false, revisionResolution = null, confirmDestructive = false } = {},
) {
  const config = loadConfig();
  if (!config.token) {
    console.error('Not logged in. Run: deploy register  or  deploy login');
    process.exit(1);
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
      `A default deployment node has not been configured.\n\nChoose one at ${setupUrl}\nThen run deploy again.`,
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
        `${name} is currently migrating between nodes.\n\nFollow its progress at ${statusUrl}`,
      );
    }
  } else if (appAdmissionResponse.status !== 404) {
    const message = await appAdmissionResponse.text();
    throw new Error(`Unable to check deployment admission: ${message}`);
  }

  const repositoryAdmission = await prepareRepositoryDeploy(
    serverUrl,
    name,
    config,
    dir,
    revisionResolution,
  );

  const tarball = resolve(dir, `${name}.tar.gz`);

  console.log(`Bundling ${name}${noCache ? ' (no cache)' : ''}...`);

  const files = listBundleFiles(dir);
  const listFile = resolve(dir, '.deploy-tar-list');
  writeFileSync(listFile, files.join('\0'));
  const hasPigz = spawnSync('pigz', ['--version'], { stdio: 'ignore' }).status === 0;
  const bundleStartedAt = Date.now();
  const tarArgs = hasPigz
    ? ['-I', 'pigz -1', '-cf', tarball, '--null', '-T', listFile]
    : ['-czf', tarball, '--null', '-T', listFile];
  execFileSync('tar', tarArgs, {
    cwd: dir,
    stdio: 'pipe',
    // gzip level 1 is substantially faster for LAN deploys. pigz uses all
    // available cores when installed; regular gzip remains the fallback.
    env: { ...process.env, GZIP: '-1' },
  });
  const bundleMs = Date.now() - bundleStartedAt;
  console.log(
    `Bundle ready: ${formatBytes(statSync(tarball).size)} in ${(bundleMs / 1000).toFixed(2)}s (${hasPigz ? 'pigz -1' : 'gzip -1'})`,
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

  // Open WebSocket before upload to stream build logs in real-time
  let ws;
  try {
    const u = new URL(serverUrl);
    const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${u.host}/ws?username=${encodeURIComponent(config.username)}&token=${encodeURIComponent(config.token)}`;
    ws = new WebSocket(wsUrl);

    await new Promise((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ subscribe: `deployment:${name}` }));
        resolve();
      };
      ws.onerror = () => resolve();
      setTimeout(resolve, 3000);
    });

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
        if (event.deploymentName !== name) return;

        if (event.type === 'deployment:status') {
          const status = event.data.status;
          if (status === 'building') {
            process.stdout.write('Building...\n');
          } else if (status === 'backing-up') {
            process.stdout.write('Backing up application data before moving nodes...\n');
          } else if (status === 'restoring') {
            process.stdout.write('Restoring application data on the destination node...\n');
          } else if (status === 'starting') {
            process.stdout.write('Starting container...\n');
          }
        } else if (event.type === 'build:output') {
          process.stdout.write(`${event.data.line}\n`);
        } else if (event.type === 'build:complete') {
          const label = event.data.success ? '\x1b[32mSuccess\x1b[0m' : '\x1b[31mFailed\x1b[0m';
          process.stdout.write(`\nBuild ${label} (${(event.data.duration / 1000).toFixed(1)}s)\n`);
        }
      } catch {
        /* ignore */
      }
    };
  } catch {
    // WebSocket not available — upload still works, just no streaming
  }

  const deployment = await uploadWithProgress(`${serverUrl}/api/upload`, bodyParts, {
    ...authHeaders(config),
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  });

  // Close WebSocket (also handles CONNECTING state to avoid hanging)
  if (ws) {
    ws.onopen = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.close();
  }

  // Clean up tarball
  try {
    execSync(`rm ${JSON.stringify(tarball)}`, { stdio: 'pipe' });
  } catch {
    // ignore
  }

  if (deployment?.accepted) {
    const dashboardUrl = new URL(
      deployment.dashboardUrl || `/dashboard/${encodeURIComponent(name)}/build`,
      serverUrl,
    ).toString();
    console.log(`Deployment accepted. The coordinator is handling the remaining lifecycle.`);
    console.log(`  Status: ${dashboardUrl}`);
    console.log(`  App:    ${appUrl(serverUrl, name)}`);
    return;
  }

  if (deployment?.unchanged && deployment?.sourceAligned) {
    console.log(`Repository matches ${deployment.digest}. Runtime was not restarted.`);
    return;
  }

  // Compatibility with coordinators that predate detached deployments.
  console.log(`Deployed ${name}`);
  console.log(`  URL: ${appUrl(serverUrl, name)}`);
}

async function cmdList(serverUrl) {
  const config = loadConfig();
  const deployments = await request(`${serverUrl}/api/deployments`, {
    headers: authHeaders(config),
  });

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
  const url = new URL(`/api/deployments/${encodeURIComponent(appName)}/logs`, serverUrl);
  if (selector.siteId) url.searchParams.set('siteId', selector.siteId);
  if (selector.component) url.searchParams.set('component', selector.component);
  if (selector.instanceId) url.searchParams.set('instanceId', selector.instanceId);
  const res = await fetch(url, {
    headers: authHeaders(config),
  });
  if (!res.ok) {
    console.error(`Error: ${res.status}`);
    process.exit(1);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    process.stdout.write(decoder.decode(value, { stream: true }));
  }
}

async function cmdDelete(serverUrl, appName) {
  if (!appName) {
    console.error('Usage: deploy delete -a <name>');
    process.exit(1);
  }
  const config = loadConfig();
  try {
    await request(`${serverUrl}/api/deployments/${appName}`, {
      method: 'DELETE',
      headers: authHeaders(config),
    });
  } catch (err) {
    const body = err.body;
    if (body?.code === 'fleet_acknowledgement_required' && body.gate) {
      const gate = body.gate;
      const lines = [
        `Delete held: ${gate.blockers.length} suitcase acknowledgement${gate.blockers.length === 1 ? '' : 's'} required.`,
        ...gate.blockers.map(
          (replica) =>
            `  - ${replica.siteName} (${replica.siteId}): ${replica.mode}; last contact ${
              replica.lastContactAt ? new Date(replica.lastContactAt).toISOString() : 'unknown'
            }`,
        ),
        `Consequence: ${gate.consequence}`,
        gate.instructions.retry,
        'If a replica is permanently lost, explicitly accept unreceived data loss:',
        ...gate.blockers.map(
          (replica) =>
            `  ${gate.instructions.removeLostReplicaCli.replace('{siteId}', replica.siteId)}`,
        ),
      ];
      const blocked = new Error(lines.join('\n'));
      blocked.code = body.code;
      throw blocked;
    }
    throw err;
  }
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
  console.log(`Opening ${url}`);
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execSync(`${cmd} ${url}`);
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
    console.error('Not logged in. Run: deploy register  or  deploy login');
    process.exit(1);
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
        process.stdout.write(msg.data.output);
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
  const info = { ...BUILD_INFO, platform: platformTarget() };

  if (json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  console.log(`deploy ${info.version}`);
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

  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected.sha256) {
    throw new Error(
      `Checksum mismatch — expected ${expected.sha256}, got ${digest}. Nothing was replaced.`,
    );
  }
  console.log(`Downloaded ${formatBytes(bytes.length)}, sha256 verified`);

  // Stage beside the target so the swap is a same-filesystem rename: the
  // running process keeps its old inode, and a failure never leaves a
  // half-written `deploy` behind.
  const stagePath = `${installPath}.upgrade-${process.pid}`;
  try {
    writeFileSync(stagePath, bytes);
    chmodSync(stagePath, 0o755);

    // The binary is cross-built on the server, where codesign is unavailable,
    // and postject's blob injection invalidates the Mach-O signature. Apple
    // Silicon SIGKILLs binaries with a broken signature, so re-sign ad-hoc.
    if (process.platform === 'darwin') {
      const signed = spawnSync('codesign', ['--sign', '-', '--force', stagePath], {
        stdio: 'ignore',
      });
      if (signed.status !== 0) {
        console.warn('WARNING: could not code-sign the new binary; it may be killed on launch.');
      }
      spawnSync('xattr', ['-d', 'com.apple.quarantine', stagePath], { stdio: 'ignore' });
    }

    const smoke = spawnSync(stagePath, ['--help'], { stdio: 'ignore' });
    if (smoke.error || smoke.status !== 0) {
      throw new Error(
        `Downloaded binary failed to run (${smoke.error?.message ?? `exit ${smoke.status}`}) — keeping the current one.`,
      );
    }

    renameSync(stagePath, installPath);
  } finally {
    if (existsSync(stagePath)) unlinkSync(stagePath);
  }

  console.log(`\nUpgraded ${installPath}`);
  const installed = spawnSync(installPath, ['version'], { encoding: 'utf-8' });
  console.log(installed.stdout?.trim() || `deploy ${manifest.version}`);
}

// ── Portable Docker target ─────────────────────────────────────────────────

function suitcaseTargetManager(options) {
  const parseOptionalPort = (value, label) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
    return parsed;
  };
  return new SuitcaseTargetManager({
    directory: options['target-dir'],
    coreImage: options['core-image'],
    helperImage: options['helper-image'],
    httpsPort: parseOptionalPort(options['https-port'], 'HTTPS port'),
    httpPort: parseOptionalPort(options['http-port'], 'HTTP port'),
    accessMode: options['access-mode'],
    allowMutableImages: !!options['allow-mutable-images'],
    cosignKey: options['cosign-key'],
    cosignCertificateIdentity: options['cosign-certificate-identity'],
    cosignCertificateOidcIssuer: options['cosign-certificate-oidc-issuer'],
  });
}

function printSuitcaseStatus(status, json = false) {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  if (!status.initialized) {
    console.log('Suitcase target is not initialized.');
    console.log('Run: deploy suitcase target start --accept-docker-socket-risk');
    return;
  }
  console.log(`Suitcase: ${status.target.name} (${status.target.targetId})`);
  console.log(`State:    ${status.healthy ? 'healthy' : status.running ? 'starting' : 'stopped'}`);
  console.log(`Compose:  ${status.composePath}`);
  if (status.releaseState?.active) {
    const release = status.releaseState.slots[status.releaseState.active];
    console.log(
      `Platform: slot ${status.releaseState.active} active${status.releaseState.previous ? `, slot ${status.releaseState.previous} rollback` : ''}`,
    );
    if (release) console.log(`Verify:   ${release.signatureVerification.status}`);
  }
  if (status.accessUrl) console.log(`Open:     ${status.accessUrl}`);
  if (status.error) console.log(`Docker:   ${status.error}`);
}

async function cmdSuitcaseTarget(action, options) {
  const manager = suitcaseTargetManager(options);
  switch (action) {
    case 'compose': {
      const generated = manager.compose();
      if (options.json) {
        console.log(
          JSON.stringify(
            { target: generated.target, path: generated.path, compose: generated.contents },
            null,
            2,
          ),
        );
      } else {
        console.log(`# Written to ${generated.path}\n`);
        process.stdout.write(generated.contents);
      }
      break;
    }
    case 'start': {
      const started = await manager.start({
        acceptDockerSocketRisk: !!options['accept-docker-socket-risk'],
      });
      if (options.json) {
        console.log(JSON.stringify(started, null, 2));
        break;
      }
      console.warn(`WARNING: ${started.securityWarning}`);
      for (const warning of started.warnings) console.warn(`WARNING: ${warning}`);
      printSuitcaseStatus(started.status);
      console.log('\nOffline access:');
      for (const instruction of started.accessInstructions) console.log(`  - ${instruction}`);
      break;
    }
    case 'stop': {
      const stopped = await manager.stop();
      if (options.json) {
        console.log(JSON.stringify(stopped, null, 2));
      } else if (!stopped.initialized) {
        console.log('Suitcase target is not initialized.');
      } else {
        console.log('Suitcase target stopped. Persistent volumes were preserved:');
        for (const volume of stopped.preservedVolumes) console.log(`  - ${volume}`);
      }
      break;
    }
    case 'status': {
      const status = await manager.status();
      printSuitcaseStatus(status, !!options.json);
      if (!status.running) process.exitCode = 1;
      break;
    }
    case 'upgrade': {
      const upgraded = await manager.upgrade({
        acceptDockerSocketRisk: !!options['accept-docker-socket-risk'],
      });
      if (options.json) {
        console.log(JSON.stringify(upgraded, null, 2));
      } else {
        console.warn(`WARNING: ${upgraded.securityWarning}`);
        if (upgraded.activated) {
          console.log(
            `Activated immutable platform slot ${upgraded.releaseState.active}; slot ${upgraded.releaseState.previous} is available for rollback.`,
          );
        } else {
          console.error(
            `Candidate failed health admission; restored slot ${upgraded.releaseState.active}.`,
          );
          if (upgraded.failure) console.error(`Failure: ${upgraded.failure}`);
        }
        printSuitcaseStatus(upgraded.status);
      }
      if (!upgraded.activated) process.exitCode = 1;
      break;
    }
    case 'rollback': {
      const rolledBack = await manager.rollback({
        acceptDockerSocketRisk: !!options['accept-docker-socket-risk'],
      });
      if (options.json) {
        console.log(JSON.stringify(rolledBack, null, 2));
      } else {
        console.warn(`WARNING: ${rolledBack.securityWarning}`);
        if (rolledBack.activated) {
          console.log(
            `Rollback activated slot ${rolledBack.releaseState.active}; slot ${rolledBack.releaseState.previous} is now the reversible release.`,
          );
        } else {
          console.error(
            'Rollback candidate failed health admission; the current release was restored.',
          );
          if (rolledBack.failure) console.error(`Failure: ${rolledBack.failure}`);
        }
        printSuitcaseStatus(rolledBack.status);
      }
      if (!rolledBack.activated) process.exitCode = 1;
      break;
    }
    case 'diagnose': {
      const diagnostics = await manager.diagnose();
      if (options.json) {
        console.log(JSON.stringify(diagnostics, null, 2));
      } else {
        console.log(`Suitcase diagnostics (${diagnostics.platform})`);
        for (const check of diagnostics.checks) {
          const symbol = check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗';
          console.log(`  ${symbol} ${check.id}: ${check.detail}`);
        }
        if (diagnostics.accessUrl) console.log(`\nOffline URL: ${diagnostics.accessUrl}`);
        console.log('Access setup:');
        for (const instruction of diagnostics.accessInstructions) console.log(`  - ${instruction}`);
      }
      if (!diagnostics.ok) process.exitCode = 1;
      break;
    }
    default:
      throw new Error(
        'Usage: deploy suitcase target <start|stop|status|upgrade|rollback|compose|diagnose>',
      );
  }
}

async function cmdSuitcaseFleet(action, args, options, serverUrl) {
  const targetDirectory = options['target-dir'];
  const coreControl = (controlAction, controlArgs = []) =>
    suitcaseTargetManager(options).control(controlAction, controlArgs);
  const config = loadConfig();
  const adminRequest = async (path, requestOptions = {}) => {
    if (!config.token) throw new Error('Not logged in. Run: deploy login');
    return request(`${serverUrl}${path}`, {
      ...requestOptions,
      headers: { ...authHeaders(config), ...(requestOptions.headers || {}) },
    });
  };

  if (action === 'pair') {
    if (args[0] === 'create') {
      if (!options.name) throw new Error('Usage: deploy suitcase pair create --name <name>');
      const pairing = await adminRequest('/api/suitcases/pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: options.name,
          defaultDataPolicy: options.policy || 'none',
          accessMode: options['access-mode'] || 'existing-lan',
          securityProfile: options['security-profile'] || 'isolated',
        }),
      });
      if (options.json) console.log(JSON.stringify(pairing, null, 2));
      else {
        console.log(`Pairing code for ${options.name}: ${pairing.code}`);
        console.log(`Expires: ${new Date(pairing.expiresAt).toLocaleString()}`);
        console.log('\nOn the suitcase target, run:');
        console.log(`  deploy suitcase pair ${serverUrl} --code ${pairing.code}`);
      }
      return;
    }
    const coordinatorUrl = args[0] === 'redeem' ? args[1] || serverUrl : args[0] || serverUrl;
    if (!options.code) {
      throw new Error('Usage: deploy suitcase pair <coordinator-url> --code <pairing-code>');
    }
    enableLocalTlsTrust(coordinatorUrl);
    const target = suitcaseTargetManager(options).ensureArtifacts().target;
    const membership = await pairSuitcase(
      {
        coordinatorUrl,
        code: options.code,
        targetId: target.targetId,
        version: BUILD_INFO.version,
        capabilities: {
          dockerTarget: true,
          cpuCount: cpus().length,
          memoryBytes: totalmem(),
          targetAccessMode: target.accessMode,
        },
      },
      { directory: targetDirectory },
    );
    if (options.json) console.log(JSON.stringify(membership, null, 2));
    else {
      console.log(`Paired ${membership.name} as ${membership.siteId}`);
      console.log(`Target identity: ${membership.targetId}`);
      console.log(`Default data sync: ${membership.defaultDataPolicy}`);
    }
    return;
  }

  if (action === 'topology') {
    const topology = await adminRequest('/api/suitcases/topology');
    if (options.json) {
      console.log(JSON.stringify(topology, null, 2));
      return;
    }
    console.log(`${topology.fleet.name} (${topology.fleet.id})`);
    for (const site of topology.sites) {
      const sync = site.sync?.replicas || [];
      const pending = sync.reduce(
        (count, replica) => count + replica.pendingChangesets + replica.pendingBlobs,
        0,
      );
      console.log(
        `  ${site.kind === 'home' ? 'home' : 'suitcase'}  ${site.name}  ${site.mode}` +
          (site.revoked_at ? ' (revoked)' : '') +
          (pending ? `  ${pending} pending data item(s)` : ''),
      );
    }
    console.log(`Applications: ${topology.applications.length}`);
    return;
  }

  if (action === 'capacity') {
    const selectedAppIds = [
      ...new Set([
        ...args.filter(Boolean),
        ...(options.app
          ? String(options.app)
              .split(',')
              .map((value) => value.trim())
          : []),
      ]),
    ].filter(Boolean);
    if (selectedAppIds.length === 0) {
      throw new Error(
        'Usage: deploy suitcase capacity <app-id>... [--trip-days 14] [--offline-builds] [--site <site-id>]',
      );
    }
    const tripHorizonDays = Number(options['trip-days'] ?? 14);
    const growthGiB = Number(options['growth-gib'] ?? 0);
    const retainedBackupCopies = Number(options.backups ?? 2);
    if (![tripHorizonDays, growthGiB, retainedBackupCopies].every(Number.isFinite)) {
      throw new Error('Capacity days, growth, and backup retention must be finite numbers');
    }
    const plan = await adminRequest('/api/fleet/capacity-plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selectedAppIds,
        tripHorizonDays,
        offlineBuilds: options['offline-builds'] === true,
        projectedDailyGrowthBytes: Math.round(growthGiB * 1024 ** 3),
        retainedBackupCopies,
        targetSiteId: options.site,
      }),
    });
    if (options.json) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    console.log(`Suitcase capacity for ${plan.selectedAppIds.length} application(s)`);
    console.log(
      `  RAM      minimum ${formatBytes(plan.minimumMemoryBytes)} · recommended ${formatBytes(plan.recommendedMemoryBytes)}`,
    );
    console.log(
      `  Storage  minimum ${formatBytes(plan.minimumStorageBytes)} · recommended ${formatBytes(plan.recommendedStorageBytes)}`,
    );
    console.log(
      `  Evidence ${plan.evidenceSummary.measured} measured · ${plan.evidenceSummary.declared} declared · ${plan.evidenceSummary.default} default · ${plan.unknowns.length} unknown`,
    );
    for (const category of ['memory', 'storage']) {
      console.log(`\n${category === 'memory' ? 'Memory' : 'Storage'} contributors:`);
      for (const contributor of plan.contributors.filter(
        (candidate) => candidate.category === category,
      )) {
        console.log(
          `  ${formatBytes(contributor.bytes).padStart(10)}  ${contributor.name} [${contributor.confidence}]`,
        );
        console.log(`              ${contributor.source}`);
      }
    }
    if (plan.targetComparison) {
      console.log(
        `\nTarget ${plan.targetComparison.siteName}: ${plan.targetComparison.status.replace('-', ' ')}`,
      );
      console.log(
        `  RAM      ${formatBytes(plan.targetComparison.memory.availableBytes || 0)} probed · ${plan.targetComparison.memory.status}`,
      );
      console.log(
        `  Storage  ${formatBytes(plan.targetComparison.storage.availableBytes || 0)} free · ${plan.targetComparison.storage.status}`,
      );
      for (const blocker of plan.targetComparison.blockers) console.log(`  Blocker  ${blocker}`);
    }
    if (plan.unknowns.length > 0) {
      console.log('\nEvidence gaps:');
      for (const unknown of plan.unknowns) console.log(`  - ${unknown}`);
    }
    return;
  }

  if (action === 'dock' || action === 'away' || action === 'rejoin') {
    const mode = action === 'dock' ? 'docked' : action === 'rejoin' ? 'rejoining' : 'away';
    const membership = await coreControl('mode', [mode]);
    if (options.json) console.log(JSON.stringify(membership, null, 2));
    else console.log(`${membership.name} is now ${mode}.`);
    return;
  }

  if (action === 'sync') {
    const syncAction = args[0] || 'status';
    if (syncAction === 'app') {
      const applicationId = args[1] || options.app;
      const siteId = args[2] || options.site;
      if (!applicationId || !siteId) {
        throw new Error('Usage: deploy suitcase sync app <app-id> <site-id>');
      }
      const syncRequest = await adminRequest(
        `/api/fleet/apps/${encodeURIComponent(applicationId)}/sync`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteId }),
        },
      );
      if (options.json) console.log(JSON.stringify(syncRequest, null, 2));
      else {
        console.log(
          syncRequest.reused
            ? `Manual sync ${syncRequest.id} is already waiting for ${siteId}.`
            : `Manual sync ${syncRequest.id} requested for ${applicationId} on ${siteId}.`,
        );
      }
      return;
    }
    if (syncAction === 'status') {
      const status = await coreControl('status');
      if (options.json) console.log(JSON.stringify(status, null, 2));
      else if (!status.paired) console.log('This target is not paired to a fleet.');
      else {
        console.log(`Coordinator: ${status.connected ? 'connected' : 'offline'}`);
        console.log(`Site:        ${status.local.name} (${status.local.siteId})`);
        console.log(`Mode:        ${status.local.mode}`);
        console.log(`Outbox:      ${status.local.pendingEvents} event(s)`);
        console.log(`Artifacts:   ${status.local.pendingArtifacts} pending`);
        if (status.error) console.log(`Last error:  ${status.error}`);
      }
      return;
    }
    if (syncAction !== 'now') throw new Error('Usage: deploy suitcase sync <status|now|app>');
    const result = await coreControl('sync');
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Sync complete for ${result.name}.`);
      console.log(`Sent ${result.sent}, received ${result.received}, replayed ${result.replayed}.`);
      console.log(`Downloaded ${result.downloaded.length} artifact(s).`);
    }
    return;
  }

  if (action === 'writer') {
    const writerAction = args[0];
    if (writerAction === 'plan' || writerAction === 'move') {
      const appId = args[1] || options.app;
      const targetSiteId = args[2] || options.site;
      if (!appId || !targetSiteId) {
        throw new Error(`Usage: deploy suitcase writer ${writerAction} <app-id> <target-site-id>`);
      }
      const plan = await adminRequest(
        `/api/fleet/apps/${encodeURIComponent(appId)}/writer-transfer/plan`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetSiteId }),
        },
      );
      if (writerAction === 'plan') {
        if (options.json) console.log(JSON.stringify(plan, null, 2));
        else {
          console.log(`Writer move: ${plan.sourceSiteId} → ${plan.targetSiteId}`);
          console.log(
            `CAS boundary: epoch ${plan.expectedAuthorityEpoch}, data sequence ${plan.expectedDataSequence}`,
          );
          console.log(plan.consequence);
        }
        return;
      }
      const transfer = await adminRequest(
        `/api/fleet/apps/${encodeURIComponent(appId)}/writer-transfer/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(plan),
        },
      );
      if (options.json) console.log(JSON.stringify(transfer, null, 2));
      else {
        console.log(`Writer handoff ${transfer.id} started: ${transfer.state}`);
        console.log('The source stays authoritative unless verified target restore commits.');
      }
      return;
    }
    if (writerAction === 'status') {
      const transferId = args[1];
      if (!transferId) throw new Error('Usage: deploy suitcase writer status <transfer-id>');
      const transfer = await adminRequest(
        `/api/fleet/writer-transfers/${encodeURIComponent(transferId)}`,
      );
      if (options.json) console.log(JSON.stringify(transfer, null, 2));
      else {
        console.log(`${transfer.id}: ${transfer.state}`);
        console.log(`  ${transfer.sourceSiteId} → ${transfer.targetSiteId}`);
        console.log(
          `  epoch ${transfer.expectedAuthorityEpoch} / sequence ${transfer.expectedDataSequence}`,
        );
        if (transfer.snapshotId) console.log(`  snapshot ${transfer.snapshotId}`);
        if (transfer.error) console.log(`  blocker ${transfer.error}`);
        if (transfer.state === 'failed' || transfer.state === 'aborted') {
          console.log(`  source resumed: ${transfer.sourceResumed ? 'yes' : 'pending'}`);
        }
      }
      return;
    }
    if (writerAction === 'abort') {
      const transferId = args[1];
      if (!transferId) throw new Error('Usage: deploy suitcase writer abort <transfer-id>');
      const transfer = await adminRequest(
        `/api/fleet/writer-transfers/${encodeURIComponent(transferId)}/abort`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: options.reason }),
        },
      );
      if (options.json) console.log(JSON.stringify(transfer, null, 2));
      else {
        console.log(`Writer handoff ${transfer.id} is ${transfer.state}.`);
        console.log(`Source resumed: ${transfer.sourceResumed ? 'yes' : 'pending source sync'}`);
      }
      return;
    }
    throw new Error('Usage: deploy suitcase writer <plan|move|status|abort>');
  }

  if (action === 'revoke') {
    const siteId = args[0] || options.site;
    if (!siteId) throw new Error('Usage: deploy suitcase revoke <site-id> [--reason <reason>]');
    const result = await adminRequest(`/api/suitcases/${encodeURIComponent(siteId)}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: options.reason }),
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`Revoked ${siteId}. Future sync attempts will be rejected.`);
    return;
  }

  if (action === 'rotate-credentials') {
    const siteId = args[0] || options.site;
    const result = await adminRequest('/api/suitcases/credentials/rotation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId }),
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (result.count === 0) console.log('No active Suitcase credentials need rotation.');
    else {
      console.log(
        `Requested credential rotation for ${result.count} Suitcase${result.count === 1 ? '' : 's'}.`,
      );
      console.log('Each device will generate and install its replacement on its next sync.');
    }
    return;
  }

  if (action === 'remove-replica') {
    const appId = args[0] || options.app;
    const siteId = args[1] || options.site;
    if (!appId || !siteId) {
      throw new Error(
        'Usage: deploy suitcase remove-replica <app-id> <site-id> --confirm-data-loss',
      );
    }
    if (!options['confirm-data-loss']) {
      throw new Error(
        'Removing a lost replica may abandon unreceived away data; repeat with --confirm-data-loss',
      );
    }
    const result = await adminRequest(
      `/api/fleet/apps/${encodeURIComponent(appId)}/remove-replica`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, acknowledgeUnreceivedDataLoss: true }),
      },
    );
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Removed ${appId} from ${siteId}.`);
      console.log(`Last adopted checkpoint: ${result.lastAdoptedCheckpointId || 'none'}`);
    }
    return;
  }

  if (action === 'access') {
    const siteId = args[0] === 'diagnose' ? args[1] || options.site : args[0] || options.site;
    if (siteId) {
      const result = await adminRequest(`/api/suitcases/${encodeURIComponent(siteId)}/access`);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Access mode for ${siteId}: ${result.mode}`);
        console.log(`Ready: ${result.ready ? 'yes' : 'no'}`);
        for (const blocker of result.blockers) console.log(`  ✗ ${blocker}`);
        for (const instruction of result.instructions) console.log(`  - ${instruction}`);
      }
      return;
    }
    const diagnostics = await suitcaseTargetManager(options).diagnose();
    const membership = await coreControl('membership');
    const output = {
      target: diagnostics,
      fleet: membership,
    };
    if (options.json) console.log(JSON.stringify(output, null, 2));
    else {
      console.log(`Local access: ${diagnostics.accessUrl}`);
      for (const instruction of diagnostics.accessInstructions) console.log(`  - ${instruction}`);
      console.log(
        membership ? `Fleet site: ${membership.siteId} (${membership.mode})` : 'Fleet: not paired',
      );
    }
    return;
  }

  if (action === 'candidate') {
    const appId = args[0] || options.app;
    const candidateCommand = args[1] || options.command;
    if (!appId || !candidateCommand) {
      throw new Error('Usage: deploy suitcase candidate <app-id> <command>');
    }
    const event = await coreControl('candidate', [appId, candidateCommand]);
    if (options.json) console.log(JSON.stringify(event, null, 2));
    else {
      console.log(`Queued ${candidateCommand} as candidate event ${event.id}.`);
      console.log(
        'It will be reviewed by the coordinator after the next sync; it was not executed.',
      );
    }
    return;
  }

  throw new Error(
    'Usage: deploy suitcase <pair|topology|capacity|dock|away|rejoin|sync|writer|revoke|rotate-credentials|remove-replica|access|candidate>',
  );
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
      `/api/catalog/${encodeURIComponent(id)}/${encodeURIComponent(release)}`,
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
      `/api/catalog/${encodeURIComponent(id)}/${encodeURIComponent(release)}/${action}`,
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

// ── CLI entry ───────────────────────────────────────────────────────────────

const HELP = `
deploy.local — self-hosted deployment platform

Usage:
  deploy server              Start the deploy.local server
  deploy                     Deploy the current directory
  deploy validate            Validate and summarize the local application graph
  deploy plan [-a <name>]    Compare the local graph with the server
  deploy schema              Copy the deploy.yaml v1 schema to the current directory
  deploy files               List files that will be bundled
  deploy list                List all deployments
  deploy logs -a <name>      Stream logs from a deployment
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
  deploy agent join <url>     Enroll this machine as an execution node
  deploy agent install        Repair or reinstall the background agent service
  deploy agent status         Check this machine's agent connection
  deploy suitcase target      Run and rollback an offline-capable Docker target
  deploy suitcase pair        Create or redeem a fleet pairing
  deploy suitcase topology    Show home and suitcase sites
  deploy suitcase capacity <app-id>...
                             Calculate workload capacity and optionally compare --site probes
  deploy suitcase dock|away|rejoin
                             Change this suitcase's lifecycle mode
  deploy suitcase sync        Show status, exchange local state, or request one app/site sync
  deploy suitcase sync app <app-id> <site-id>
                             Request one durable manual data sync (admin)
  deploy suitcase writer      Plan, move, inspect, or abort a Follows one site writer handoff
  deploy suitcase revoke      Revoke a suitcase credential (admin)
  deploy suitcase rotate-credentials [site-id]  Rotate one or every Suitcase credential (admin)
  deploy suitcase remove-replica <app-id> <site-id>
                             Stop waiting for a lost app replica (admin)
  deploy suitcase access      Diagnose offline access mode
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
      --json                 Machine-readable output (version only)
      --target-dir <path>    Suitcase target files (default: ~/.deploy/suitcase-target)
      --https-port <port>    Suitcase HTTPS port (default: 8443)
      --http-port <port>     Suitcase HTTP port (default: 8080)
      --access-mode <mode>   auto, native-local, host-helper-local, or ip
      --code <code>          Suitcase pairing code
      --policy <mode>        Data sync default: none, manual, or automatic
      --reason <text>        Suitcase revocation reason
      --site <site-id>       Suitcase fleet site identity
      --use-default          Remove a site component-count override
      --trip-days <days>     Capacity planning horizon (default: 14)
      --growth-gib <GiB>     Expected selected-app growth per day
      --backups <count>      Retained backup copies (default: 2)
      --offline-builds       Include independent offline build and cache capacity
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
      --confirm-destructive  Confirm destructive application graph changes
      --confirm-data-loss    Confirm a lost replica may contain unreceived data
      --accept-docker-socket-risk
                             Acknowledge core access to the Docker socket
      --allow-mutable-images  Development only: permit images without repository digests
      --cosign-key <path>     Verify both suitcase image digests with this cosign key
      --cosign-certificate-identity <identity>
                             Expected identity for keyless cosign verification
      --cosign-certificate-oidc-issuer <issuer>
                             Expected OIDC issuer for keyless cosign verification
      --no-cache             Build without using cached layers (deploy only).
                             Use when a previous build cached a bad layer
                             (e.g. truncated lockfile) and you need to force
                             a clean rebuild.
  -h, --help                 Show this help
`.trim();

const _initialConfig = loadConfig();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', short: 'u', default: _initialConfig.url || DEFAULT_URL },
    application: { type: 'string', short: 'a' },
    app: { type: 'string' },
    name: { type: 'string' },
    port: { type: 'string', short: 'p', default: '80' },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
    check: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    rebase: { type: 'boolean', default: false },
    replace: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    'no-cache': { type: 'boolean', default: false },
    'target-dir': { type: 'string' },
    'core-image': { type: 'string' },
    'helper-image': { type: 'string' },
    'https-port': { type: 'string' },
    'http-port': { type: 'string' },
    'access-mode': { type: 'string' },
    code: { type: 'string' },
    policy: { type: 'string' },
    reason: { type: 'string' },
    site: { type: 'string' },
    'trip-days': { type: 'string' },
    'growth-gib': { type: 'string' },
    backups: { type: 'string' },
    'offline-builds': { type: 'boolean', default: false },
    component: { type: 'string' },
    command: { type: 'string' },
    'security-profile': { type: 'string' },
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
    'confirm-destructive': { type: 'boolean', default: false },
    'confirm-data-loss': { type: 'boolean', default: false },
    result: { type: 'string' },
    'accept-docker-socket-risk': { type: 'boolean', default: false },
    'allow-mutable-images': { type: 'boolean', default: false },
    'cosign-key': { type: 'string' },
    'cosign-certificate-identity': { type: 'string' },
    'cosign-certificate-oidc-issuer': { type: 'string' },
  },
  strict: false,
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

if (values.version && !positionals.length) {
  cmdVersion({ json: !!values.json });
  process.exit(0);
}

const command = positionals[0] || 'deploy';
const serverUrl = values.url;
const appName = (values.application || values.app)?.toLowerCase();

enableLocalTlsTrust(serverUrl);

try {
  switch (command) {
    case 'server':
    case 'start':
      await cmdServer(values.port);
      break;
    case 'deploy':
    case 'd':
      if (values.rebase && values.replace) {
        throw new Error('Choose either --rebase or --replace, not both.');
      }
      await cmdDeploy(serverUrl, appName, {
        noCache: !!values['no-cache'],
        revisionResolution: values.rebase ? 'rebase' : values.replace ? 'replace' : null,
        confirmDestructive: values['confirm-destructive'] === true,
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
      await cmdLogs(serverUrl, appName || positionals[1], {
        siteId: values.site,
        component: values.component,
        instanceId: values.instance,
      });
      break;
    case 'delete':
    case 'rm':
      await cmdDelete(serverUrl, appName);
      break;
    case 'open':
    case 'o':
      await cmdOpen(serverUrl, appName);
      break;
    case 'ssh':
    case 'exec':
      await cmdSsh(serverUrl, appName || positionals[1]);
      break;
    case 'register':
    case 'r':
      await cmdRegister(serverUrl);
      break;
    case 'login':
      await cmdLogin(serverUrl);
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
    case 'agent': {
      const agentCommand = positionals[1];
      if (agentCommand === 'join') {
        const coordinatorUrl = positionals[2] || serverUrl;
        enableLocalTlsTrust(coordinatorUrl);
        await cmdAgentJoin(coordinatorUrl, values.name);
      } else if (agentCommand === 'run') {
        await cmdAgentRun();
      } else if (agentCommand === 'install') {
        cmdAgentInstall();
      } else if (agentCommand === 'status') {
        await cmdAgentStatus();
      } else {
        throw new Error('Usage: deploy agent <join|install|status>');
      }
      break;
    }
    case 'suitcase':
      if (positionals[1] === 'target') {
        await cmdSuitcaseTarget(positionals[2], values);
      } else {
        await cmdSuitcaseFleet(positionals[1], positionals.slice(2), values, serverUrl);
      }
      break;
    case 'catalog':
      await cmdCatalog(positionals[1] || 'list', positionals.slice(2), values, serverUrl);
      break;
    case 'component':
      await cmdComponent(positionals[1] || 'inspect', positionals.slice(2), values, serverUrl);
      break;
    case 'recovery':
      await cmdRecovery(positionals[1] || 'readiness', positionals.slice(2), values, serverUrl);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
