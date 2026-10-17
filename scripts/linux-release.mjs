#!/usr/bin/env node
/** One-time host setup, then ordinary-user release activation with automatic rollback. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const service = 'deploy-server.service';
const configPath = '/etc/deploy-local-release.json';
const toolPath = '/usr/local/lib/deploy.local/linux-release.mjs';
const commandPath = '/usr/local/bin/deploy-update';
const overridePath = '/etc/systemd/system/deploy-server.service.d/99-user-releases.conf';
const rulePath = '/etc/polkit-1/rules.d/49-deploy-local-release.rules';
const manifestName = '.deploy-release.json';
const run = (command, args, options = {}) =>
  (
    execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }) ?? ''
  ).trim();
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export function restartRule(user) {
  if (!/^[a-z_][a-z0-9_-]*[$]?$/.test(user)) throw new Error('Invalid deploy user.');
  return `// Only the named deployer may restart this one existing service, including over SSH.\npolkit.addRule(function(action, subject) {\n  if (action.id === "org.freedesktop.systemd1.manage-units" &&\n      action.lookup("unit") === "${service}" &&\n      action.lookup("verb") === "restart" &&\n      subject.user === ${JSON.stringify(user)}) {\n    return polkit.Result.YES;\n  }\n});\n`;
}

const iniString = (value) => JSON.stringify(value).replaceAll('%', '%%');
const execArg = (value) => iniString(value).replaceAll('$', '$$');
export function releaseOverride(config) {
  if (
    !config.current.startsWith('/') ||
    ['\r', '\n', '\0'].some((character) => config.current.includes(character)) ||
    /\s$/.test(config.current)
  )
    throw new Error('Invalid current release path.');
  // WorkingDirectory is a single path value, not an ExecStart argument list.
  // Quoting it makes the quote part of the path on the systemd version on SER.
  return `[Service]\nWorkingDirectory=${config.current.replaceAll('%', '%%')}\nExecStart=\nExecStart=${execArg(config.node)} ${execArg(join(config.current, 'dist/supervisor.js'))}\nEnvironment=${iniString('DEPLOY_DATA_DIR=' + config.data)}\n`;
}

export function releaseLocation(path, releases) {
  const root = realpathSync(releases);
  const release = realpathSync(path);
  if (dirname(release) !== root || !lstatSync(release).isDirectory())
    throw new Error('Release must be a direct directory inside the configured releases directory.');
  return release;
}

function revision(release) {
  const git = (args) => run('git', ['-c', `safe.directory=${release}`, '-C', release, ...args]);
  if (git(['status', '--porcelain', '--untracked-files=no']))
    throw new Error('Release has modified tracked files.');
  return git(['rev-parse', 'HEAD']);
}

export function artifactHashes(release) {
  const hashes = {};
  function visit(relative) {
    const path = join(release, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Build artifact is a symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(relative, name));
    } else if (stat.isFile())
      hashes[relative] = createHash('sha256').update(readFileSync(path)).digest('hex');
    else throw new Error(`Unsupported build artifact: ${relative}`);
  }
  visit('dist');
  if (!hashes['dist/supervisor.js'] || !hashes['dist/server.js'] || !hashes['dist/edge.js'])
    throw new Error('Build is missing its production entry points.');
  return hashes;
}

export function verifyRelease(release) {
  const manifest = JSON.parse(readFileSync(join(release, manifestName), 'utf8'));
  if (
    manifest.revision !== revision(release) ||
    manifest.typecheck !== 'passed' ||
    manifest.build !== 'passed' ||
    manifest.tests !== 'passed'
  )
    throw new Error('Release is missing successful checks for its current revision.');
  if (JSON.stringify(manifest.artifacts) !== JSON.stringify(artifactHashes(release)))
    throw new Error('Build artifacts changed after verification. Run prepare again.');
  return manifest;
}

export function pointCurrent(current, release) {
  if (existsSync(current) && !lstatSync(current).isSymbolicLink())
    throw new Error('Current release pointer is not a symlink.');
  const next = `${current}.next-${process.pid}`;
  try {
    symlinkSync(release, next);
    renameSync(next, current);
  } finally {
    rmSync(next, { force: true });
  }
}

/** Validate before swapping; keep the previous release on any restart/readiness failure. */
export async function promote({
  current,
  release,
  validate,
  restart,
  healthy,
  point = pointCurrent,
}) {
  validate(release);
  const previous = realpathSync(current);
  point(current, release);
  try {
    await restart();
    await healthy(release);
  } catch (failure) {
    point(current, previous);
    try {
      await restart();
      await healthy(previous);
    } catch (rollbackFailure) {
      const recoveryError = new AggregateError(
        [failure, rollbackFailure],
        'Update failed; previous pointer restored but service recovery needs attention.',
        { cause: rollbackFailure },
      );
      throw recoveryError;
    }
    throw new Error(`Update failed; restored ${previous}.`, { cause: failure });
  }
}

async function waitForHealthy(config, release, previousPid) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const pid = run('systemctl', ['show', service, '-p', 'MainPID', '--value']);
      run('systemctl', ['is-active', '--quiet', service]);
      const directory = run('systemctl', ['show', service, '-p', 'WorkingDirectory', '--value']);
      if (
        !Number(pid) ||
        pid === previousPid ||
        directory !== config.current ||
        realpathSync(directory) !== release
      )
        throw new Error('The selected release has not restarted yet.');
      run('curl', [
        '--cacert',
        join(config.data, 'certs/ca.crt'),
        '--resolve',
        'deploy.local:443:127.0.0.1',
        '--max-time',
        '3',
        '-fsS',
        '-o',
        '/dev/null',
        'https://deploy.local/',
      ]);
      return;
    } catch {
      await pause(1000);
    }
  }
  throw new Error('Service did not become ready within 30 checks.');
}

async function activate(path) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (process.getuid() !== config.uid)
    throw new Error(`Run deploy-update as ${config.user}, without sudo.`);
  const release = releaseLocation(path, config.releases);
  const lock = join(dirname(config.current), '.release-update.lock');
  mkdirSync(lock, { mode: 0o700 });
  try {
    let previousPid;
    await promote({
      current: config.current,
      release,
      validate: verifyRelease,
      restart: () => {
        previousPid = run('systemctl', ['show', service, '-p', 'MainPID', '--value']);
        run('systemctl', ['--no-ask-password', 'restart', service]);
      },
      healthy: (target) => waitForHealthy(config, target, previousPid),
    });
    console.log(`Serving ${release}\nRevision ${revision(release)}`);
  } finally {
    rmSync(lock, { recursive: true });
  }
}

async function prepare(path) {
  if (process.getuid() === 0) throw new Error('Build releases as the ordinary deploy user.');
  const release = realpathSync(path);
  process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}`;
  const before = revision(release);
  for (const args of [['install', '--frozen-lockfile'], ['typecheck'], ['build'], ['test']]) {
    console.log(`pnpm ${args.join(' ')}`);
    run('pnpm', args, { cwd: release, stdio: 'inherit' });
  }
  if (revision(release) !== before) throw new Error('Revision changed while building.');
  writeFileSync(
    join(release, manifestName),
    JSON.stringify(
      {
        revision: before,
        verifiedAt: new Date().toISOString(),
        typecheck: 'passed',
        build: 'passed',
        tests: 'passed',
        artifacts: artifactHashes(release),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Verified ${before}. Ready for deploy-update activate ${release}`);
}

async function install(user, path, data) {
  if (process.getuid() !== 0)
    throw new Error(
      'One-time installation requires administrator access. Routine activation does not.',
    );
  restartRule(user); // Validate before using the account in files or process arguments.
  const account = run('getent', ['passwd', user]).split(':');
  const uid = Number(account[2]),
    gid = Number(account[3]),
    home = account[5];
  if (!uid || !gid || !home?.startsWith('/'))
    throw new Error('Use an existing, non-root deploy account.');
  const base = join(home, '.local/share/deploy.local');
  const config = {
    user,
    uid,
    releases: join(base, 'releases'),
    current: join(base, 'current'),
    data: realpathSync(data),
    node: process.execPath,
  };
  const release = releaseLocation(path, config.releases);
  // Run checks under the deployer's identity; no build or package hooks execute as root.
  run('runuser', ['-u', user, '--', config.node, fileURLToPath(import.meta.url), 'check', release]);
  const previous = realpathSync(
    run('systemctl', ['show', service, '-p', 'WorkingDirectory', '--value']),
  );
  for (const file of [configPath, overridePath, rulePath, commandPath, toolPath, config.current]) {
    if (existsSync(file))
      throw new Error(`Setup target already exists: ${file}. Inspect before reinstalling.`);
  }
  const installed = [];
  try {
    pointCurrent(config.current, previous);
    installed.push(config.current);
    // A user-writable release directory is the existing deployment trust boundary.
    for (const [file, content, mode] of [
      [configPath, JSON.stringify(config, null, 2) + '\n', 0o644],
      [overridePath, releaseOverride(config), 0o644],
      [rulePath, restartRule(user), 0o644],
      [
        commandPath,
        `#!/bin/sh\nexec ${shellQuote(config.node)} ${shellQuote(toolPath)} "$@"\n`,
        0o755,
      ],
    ]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, { mode });
      installed.push(file);
    }
    mkdirSync(dirname(toolPath), { recursive: true });
    copyFileSync(fileURLToPath(import.meta.url), toolPath);
    chmodSync(toolPath, 0o644);
    installed.push(toolPath);
    run('systemctl', ['daemon-reload']);
    // Polkit watches its rules directory. Activation below tests the real systemd
    // request as the deployer; pkcheck cannot supply action details as that user.
    await pause(1000);
    run('runuser', ['-u', user, '--', commandPath, 'activate', release], { stdio: 'inherit' });
    console.log('Installed. Future updates and rollbacks use deploy-update without sudo.');
  } catch (failure) {
    for (const file of installed.reverse()) rmSync(file, { force: true });
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['restart', service]);
    throw failure;
  }
}

const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function main(args) {
  if (process.platform !== 'linux')
    throw new Error('This host update workflow requires Linux/systemd.');
  const [command, ...values] = args;
  if (command === 'prepare' && values.length === 1) return prepare(values[0]);
  if (command === 'check' && values.length === 1) {
    verifyRelease(realpathSync(values[0]));
    return;
  }
  if (command === 'activate' && values.length === 1) return activate(values[0]);
  if (command === 'install' && values.length === 3) return install(...values);
  if (command === 'status' && values.length === 0) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    console.log(`Current release: ${realpathSync(config.current)}`);
    console.log(
      run('systemctl', [
        'show',
        service,
        '-p',
        'MainPID',
        '-p',
        'ActiveState',
        '-p',
        'WorkingDirectory',
      ]),
    );
    return;
  }
  throw new Error(
    'Usage: linux-release.mjs prepare|check|activate <release> | status | install <user> <release> <existing-data-dir>',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    if (error.cause) console.error(error.cause.message);
    process.exitCode = 1;
  });
