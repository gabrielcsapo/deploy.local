#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { createReadStream } from 'node:fs';
import { basename, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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

async function uploadWithProgress(url, body, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const requestFn = isHttps ? httpsRequest : httpRequest;

    const totalBytes = body.length;
    let uploadedBytes = 0;
    const startTime = Date.now();

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': totalBytes,
      },
      // Trust self-signed certs for .local domains
      ...(isHttps && urlObj.hostname.endsWith('.local') && { rejectUnauthorized: false }),
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
          reject(
            new Error(`Server redirected to ${res.headers.location} — use the HTTPS URL directly`),
          );
        } else if (res.statusCode >= 400) {
          const msg =
            typeof responseBody === 'object'
              ? responseBody.message || responseBody.error || text
              : text;
          reject(new Error(`${res.statusCode}: ${msg}`));
        } else {
          resolve(responseBody);
        }
      });
    });

    req.on('error', reject);

    // Track upload progress
    const chunkSize = 64 * 1024; // 64KB chunks
    let offset = 0;

    const writeNextChunk = () => {
      if (offset >= totalBytes) {
        req.end();
        process.stdout.write('\n');
        return;
      }

      const end = Math.min(offset + chunkSize, totalBytes);
      const chunk = body.subarray(offset, end);

      const canContinue = req.write(chunk);
      uploadedBytes += chunk.length;
      offset = end;

      // Update progress
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = uploadedBytes / elapsed;
      const percentage = ((uploadedBytes / totalBytes) * 100).toFixed(1);
      const progress = `Uploading... ${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)} (${percentage}%) - ${formatBytes(speed)}/s`;
      process.stdout.write(`\r${progress}`);

      if (canContinue) {
        writeNextChunk();
      } else {
        req.once('drain', writeNextChunk);
      }
    };

    writeNextChunk();
  });
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

  const fileStream = createReadStream(tarball);
  const chunks = [];
  chunks.push(Buffer.from(header));
  for await (const chunk of fileStream) {
    chunks.push(chunk);
  }
  chunks.push(Buffer.from(nameField));
  const body = Buffer.concat(chunks);

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

  await uploadWithProgress(`${serverUrl}/api/upload`, body, {
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
