#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { createReadStream } from 'node:fs';
import { basename, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const DEFAULT_URL = 'https://deploy.local';
const RC_PATH = resolve(homedir(), '.deployrc');

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
    throw new Error(`${res.status}: ${msg}`);
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
 * 64KB read buffer regardless of project size.
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
 * chunk (bounded by the 64KB read buffer regardless of project size).
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
        fileStream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
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
      '  • Large bundles widen the exposure window; trim it with a deploy.json "ignore" list',
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

function getIgnorePatterns(dir) {
  const ignorePatterns = [];
  const deployJsonPath = resolve(dir, 'deploy.json');
  if (existsSync(deployJsonPath)) {
    try {
      const deployConfig = JSON.parse(readFileSync(deployJsonPath, 'utf-8'));
      if (Array.isArray(deployConfig.ignore)) {
        for (const entry of deployConfig.ignore) {
          if (typeof entry === 'string' && entry.length > 0) {
            ignorePatterns.push(entry);
          }
        }
      }
    } catch {
      // If deploy.json is invalid, let the server validate and report the error
    }
  }
  return ignorePatterns;
}

function listBundleFiles(dir) {
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

    // Always include deploy.json even if gitignored — the server needs it
    if (!allFiles.includes('deploy.json') && existsSync(resolve(dir, 'deploy.json'))) {
      allFiles.push('deploy.json');
    }

    return allFiles.filter((f) => {
      if (excludes.some((p) => f === p || f.startsWith(p + '/'))) return false;
      // Drop paths that no longer exist on disk — `git ls-files -c` lists
      // tracked files including ones the user has `rm`'d but not yet
      // committed, which would make tar fail.
      return existsSync(resolve(dir, f));
    });
  } else {
    // For non-git repos, use find and apply excludes
    const excludeArgs = excludes.map((p) => `-not -path './${p}' -not -path './${p}/*'`).join(' ');
    const files = execSync(`find . -type f ${excludeArgs}`, { cwd: dir, encoding: 'utf-8' })
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

async function cmdDeploy(serverUrl, appName, { noCache = false } = {}) {
  const config = loadConfig();
  if (!config.token) {
    console.error('Not logged in. Run: deploy register  or  deploy login');
    process.exit(1);
  }

  const dir = process.cwd();
  const name = (appName || basename(dir)).toLowerCase();
  const tarball = resolve(dir, `${name}.tar.gz`);

  console.log(`Bundling ${name}${noCache ? ' (no cache)' : ''}...`);

  const files = listBundleFiles(dir);
  const listFile = resolve(dir, '.deploy-tar-list');
  writeFileSync(listFile, files.join('\0'));
  execSync(`tar -czf ${JSON.stringify(tarball)} --null -T ${JSON.stringify(listFile)}`, {
    cwd: dir,
    stdio: 'pipe',
  });
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

  await uploadWithProgress(`${serverUrl}/api/upload`, bodyParts, {
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

async function cmdLogs(serverUrl, appName) {
  if (!appName) {
    console.error('Usage: deploy logs -app <name>');
    process.exit(1);
  }
  const config = loadConfig();
  const res = await fetch(`${serverUrl}/api/deployments/${appName}/logs`, {
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
    console.error('Usage: deploy delete -app <name>');
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
  const schemaSource = resolve(import.meta.dirname, '..', 'deploy.schema.json');
  const schemaDest = resolve(process.cwd(), 'deploy.schema.json');

  if (!existsSync(schemaSource)) {
    console.error('Schema file not found in deploy.local package');
    process.exit(1);
  }

  writeFileSync(schemaDest, readFileSync(schemaSource));
  console.log('Copied deploy.schema.json to current directory');
  console.log('Add this to your deploy.json:');
  console.log('  "$schema": "./deploy.schema.json"');
}

async function cmdOpen(serverUrl, appName) {
  if (!appName) {
    console.error('Usage: deploy open -app <name>');
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

// ── CLI entry ───────────────────────────────────────────────────────────────

const HELP = `
deploy.local — self-hosted deployment platform

Usage:
  deploy server              Start the deploy.local server
  deploy                     Deploy the current directory
  deploy schema              Copy deploy.schema.json to current directory
  deploy files               List files that will be bundled
  deploy list                List all deployments
  deploy logs -app <name>    Stream logs from a deployment
  deploy ssh <name>          Open an interactive shell in a deployment
  deploy delete -app <name>  Delete a deployment
  deploy open -app <name>    Open a deployment in the browser
  deploy register            Create a new account
  deploy login               Authenticate with the server
  deploy logout              Log out
  deploy whoami              Show current user

Options:
  -u, --url <url>            Server URL (default: https://deploy.local)
  -app, --application <name> Application name
  -p, --port <port>          Server port (default: 80)
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
    port: { type: 'string', short: 'p', default: '80' },
    help: { type: 'boolean', short: 'h', default: false },
    'no-cache': { type: 'boolean', default: false },
  },
  strict: false,
});

if (values.help) {
  console.log(HELP);
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
      await cmdDeploy(serverUrl, appName, { noCache: !!values['no-cache'] });
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
      await cmdLogs(serverUrl, appName);
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
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
