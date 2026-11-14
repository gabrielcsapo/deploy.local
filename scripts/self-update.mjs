#!/usr/bin/env node
import {
  preparePackageInstall,
  secretOutput,
  registryFallback,
} from '../shared/package-install.mjs';
// Updates the coordinator to a commit on its own main: prepare a new release, back up the
// databases, then `deploy-update activate`. The server starts this as the deploy account in a
// transient systemd unit, so restarting deploy-server.service does not stop it. Progress goes to
// the run's JSON file, which the server reads; output goes to the run's log.
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function backupSelfUpdateDatabases(dataDirectory, revision) {
  const { backup, DatabaseSync } = await import('node:sqlite');
  const directory = join(dataDirectory, 'backups');
  for (const [name, path] of [
    ['deploy', join(dataDirectory, 'deploy.db')],
    ['workspace', join(dataDirectory, 'workspace', 'workspace.db')],
  ]) {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      await backup(database, join(directory, `self-update-${short(revision)}-${name}.db`));
    } finally {
      database.close();
    }
  }
  // Keep the three most recent updates' backups; older ones are this updater's own.
  const ours = readdirSync(directory)
    .filter((name) => /^self-update-[0-9a-f]{7}-(deploy|workspace)\.db$/.test(name))
    .map((name) => ({ name, time: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const { name } of ours.slice(6)) rmSync(join(directory, name));
}

const short = (sha) => sha.slice(0, 7);
export function duration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds} s`
    : `${Math.floor(seconds / 60)} m ${String(seconds % 60).padStart(2, '0')} s`;
}

/** Reads `deploy-update prepare` output: which pnpm step ran last, and the test totals. */
export function readPrepare(output) {
  let command = '';
  let pass = 0;
  let failed = 0;
  const files = new Set();
  for (const line of output.split('\n')) {
    const step = line.match(/^pnpm (install|typecheck|build|test)\b/);
    if (step) command = step[1];
    const total = line.match(/^ℹ (pass|fail) (\d+)/);
    if (total?.[1] === 'pass') pass += Number(total[2]);
    if (total?.[1] === 'fail') failed += Number(total[2]);
    const where = line.match(
      /^\s*test at (?:file:\/\/)?(?:.*?\/)?((?:server|app|packages|bin|shared|scripts|desktop|examples)\/[^:\s]+):\d+/,
    );
    if (where) files.add(where[1]);
  }
  return { command, pass, failed, files: [...files] };
}
export function prepareDetail({ command, pass, failed, files }, ok) {
  if (ok) return `install, typecheck, build, ${pass} tests passed`;
  if (command === 'test' && failed)
    return `${failed} of ${pass + failed} tests failed${files.length ? ` in ${files.slice(0, 2).join(', ')}` : ''}`;
  return command ? `pnpm ${command} failed` : 'could not start the build';
}

/** Only direct directories in the data folder; symlinks and unrelated files are left alone. */
export function pruneCliBuilds(data, log = () => {}) {
  const root = realpathSync(data);
  const removed = [];
  const pinned = new Set(
    ['cli', 'cli.previous', 'cli.next']
      .map((name) => join(root, name))
      .filter(existsSync)
      .map((path) => realpathSync(path)),
  );
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith('cli.') || ['cli.previous', 'cli.next'].includes(entry.name))
      continue;
    const path = join(root, entry.name);
    if (!entry.isDirectory() || lstatSync(path).isSymbolicLink() || pinned.has(realpathSync(path)))
      continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(join(data, entry.name));
    log(`Removed stale worker build ${path}\n`);
  }
  return removed;
}

/** Swaps the new worker builds into <data>/cli, keeping the last ones as cli.previous. */
export function publishWorkers(data, commit, log = () => {}) {
  const next = join(data, 'cli.next');
  try {
    if (JSON.parse(readFileSync(join(next, 'build-info.json'), 'utf8')).commit !== commit) return;
  } catch {
    return;
  }
  const current = join(data, 'cli');
  const previous = join(data, 'cli.previous');
  try {
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(current)) renameSync(current, previous);
    renameSync(next, current);
    log(`Published worker builds for ${short(commit)}.\n`);
  } catch (error) {
    log(`Publishing worker builds failed: ${error.message}\n`);
  }
}

/** The server provisions the coordinator's install-only key outside the release.
 * A missing configuration is the original manual prepare path. */
export async function selfUpdateInstall(plan, log = () => {}) {
  let config = null;
  if (plan.packageConfig) {
    try {
      config = JSON.parse(readFileSync(plan.packageConfig, 'utf8'));
    } catch {
      log(registryFallback + '\n');
    } finally {
      rmSync(plan.packageConfig, { force: true });
    }
  }
  return preparePackageInstall(config, {
    cwd: plan.release,
    root: dirname(plan.packageConfig || plan.history || plan.release),
    log: (line) => log(line + '\n'),
  });
}

/** Also used at the next start after an uncatchable kill or power loss. */
export function cleanupUpdatePackages(directory, keep) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (path !== keep && (name.startsWith('package-install-') || name.endsWith('.packages.json')))
      rmSync(path, { recursive: true, force: true });
  }
}

export async function prepareSelfUpdate(plan, installation, exec, log = () => {}) {
  try {
    try {
      return await exec('deploy-update', ['prepare', plan.release], {
        env: { ...process.env, ...installation.env },
      });
    } catch (error) {
      // Older installed helpers print execFileSync's error, newer ones also print step headings.
      const output = String(error.output || error.message || '');
      const failures = [...output.matchAll(/^Command failed: pnpm ([^\r\n]+)$/gm)];
      const failedInstall = failures.at(-1)?.[1] === 'install --frozen-lockfile';
      if (
        !installation.npmrc ||
        !failedInstall ||
        ['typecheck', 'build', 'test'].includes(readPrepare(output).command)
      )
        throw error;
      await installation.cleanup();
      log('deploy.local package install failed; retrying without registry configuration.\n');
      return await exec('deploy-update', ['prepare', plan.release], { env: { ...process.env } });
    }
  } finally {
    await installation.cleanup();
  }
}

/** The names `releaseName` gives; anything else in the releases folder is not this updater's. */
const UPDATER_RELEASE = /^\d{8}-main-[0-9a-f]{7}(-\d+)?$/;

/** Removes all but the newest updater-made releases, never one that `protect` names. */
export function pruneReleases(releases, protect, keep = 3, log = () => {}) {
  if (!Number.isInteger(keep) || keep < 0) throw new Error('Invalid release retention count');
  const root = realpathSync(releases);
  const safe = new Set(protect.map((path) => realpathSync(path)));
  const removed = [];
  const candidates = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(releases, entry.name);
    if (!entry.isDirectory() || !UPDATER_RELEASE.test(entry.name)) {
      log(`Unrecognized release entry (kept): ${path}\n`);
      continue;
    }
    candidates.push({ path, time: statSync(path).mtimeMs });
  }
  for (const { path } of candidates
    .sort((a, b) => b.time - a.time || b.path.localeCompare(a.path))
    .slice(keep)) {
    // Recheck type and canonical parent immediately before removing a directory.
    if (lstatSync(path).isSymbolicLink()) continue;
    const actual = realpathSync(path);
    if (dirname(actual) !== root || safe.has(actual)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

/** Keep the running and rollback release pins across updater restarts. No credentials here. */
export function finishSelfUpdatePins(plan, run, state) {
  if (!plan.packageProject || !existsSync(join(plan.data, 'deploy.db'))) return;
  const database = new Database(join(plan.data, 'deploy.db'));
  try {
    database.pragma('busy_timeout = 5000');
    database.transaction(() => {
      if (state === 'done')
        database
          .prepare(
            "DELETE FROM package_pins WHERE project_id=? AND reason='self-release' AND release_id NOT IN (?,?)",
          )
          .run(plan.packageProject, run.to, run.from);
      else
        database
          .prepare(
            "DELETE FROM package_pins WHERE project_id=? AND reason='self-release' AND release_id=? AND release_id<>?",
          )
          .run(plan.packageProject, run.to, run.from);
      database
        .prepare(
          "UPDATE system_settings SET value=?,updated_at=? WHERE key='packages.selfUpdateContext'",
        )
        .run(JSON.stringify({ state, projectId: plan.packageProject }), new Date().toISOString());
    })();
  } finally {
    database.close();
  }
}

function main(file) {
  let run = JSON.parse(readFileSync(file, 'utf8'));
  const { plan } = run;
  const updateDirectory = dirname(file);
  cleanupUpdatePackages(updateDirectory, plan.packageConfig);
  // Synchronous exit cleanup covers exceptions and catchable signals; next start covers SIGKILL.
  const cleanup = () => cleanupUpdatePackages(updateDirectory);
  process.once('exit', cleanup);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'])
    process.once(signal, () => {
      cleanup();
      process.exit(1);
    });
  const save = () => {
    writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2), { mode: 0o644 });
    renameSync(`${file}.tmp`, file);
  };
  const log = (text) => appendFileSync(plan.log, text);
  let installSecrets = [];
  const exec = (command, args, options = {}) =>
    new Promise((resolve, reject) => {
      log(`$ ${command} ${args.join(' ')}\n`);
      let output = '';
      const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      const take = (chunk) => {
        output += chunk;
        log(chunk);
      };
      const redacted = secretOutput(installSecrets, take);
      child.stdout.on('data', redacted.write);
      child.stderr.on('data', redacted.write);
      child.once('close', () => redacted.end());
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve(output)
          : reject(Object.assign(new Error(`${command} exited with ${code}`), { output })),
      );
    });
  const step = (id) => run.steps.find((s) => s.id === id);
  const begin = (id) => {
    Object.assign(step(id), { state: 'running', startedAt: new Date().toISOString() });
    save();
    return Date.now();
  };
  const finish = (id, state, detail) => {
    Object.assign(step(id), { state, detail, finishedAt: new Date().toISOString() });
    save();
  };
  const end = (state, error) => {
    try {
      finishSelfUpdatePins(plan, run, state);
    } catch {
      log('Could not reconcile package pins; existing pins were kept.\n');
    }
    if (plan.packageConfig) rmSync(plan.packageConfig, { force: true });
    for (const s of run.steps)
      if (s.state === 'waiting') Object.assign(s, { state: 'skipped', detail: 'skipped' });
    run = { ...run, state, error, finishedAt: new Date().toISOString() };
    save();
    let history = [];
    try {
      history = JSON.parse(readFileSync(plan.history, 'utf8'));
    } catch {}
    const { plan: _plan, ...summary } = run;
    writeFileSync(plan.history, JSON.stringify([...history, summary].slice(-20), null, 2));
  };

  return (async () => {
    log(`Updating ${short(run.from)} to ${short(run.to)} into ${plan.release}\n`);
    try {
      pruneCliBuilds(plan.data, log);
    } catch (error) {
      log(`Could not remove stale worker builds: ${error.message}\n`);
    }
    let started = begin('prepare');
    let output = '';
    // The release a failed activation goes back to, so it outlives the cleanup after a success.
    const serving = realpathSync(plan.current);
    try {
      if (existsSync(plan.release)) throw new Error(`${plan.release} already exists`);
      // Copying the serving release keeps node_modules, so the install is quick.
      await exec('cp', ['-a', serving, plan.release]);
      // A release is a detached checkout with no refs. Without the tip, git has nothing to compare
      // against and fetches the repository's whole history again.
      await exec('git', [
        '-C',
        plan.release,
        'fetch',
        '--no-tags',
        '--quiet',
        '--negotiation-tip=HEAD',
        plan.repository,
        run.to,
      ]);
      await exec('git', ['-C', plan.release, 'checkout', '--quiet', '--detach', '--force', run.to]);
      await exec('git', ['-C', plan.release, 'clean', '-fdq']);
      // Housekeeping only: a release with a larger .git still works.
      await exec('git', ['-C', plan.release, 'gc', '--quiet', '--prune=now']).catch((error) =>
        log(`Could not compact the release's git data.\n${error.message}\n`),
      );
      rmSync(join(plan.release, 'dist'), { recursive: true, force: true });
      const installation = await selfUpdateInstall(plan, log);
      installSecrets = installation.secrets;
      try {
        output = await prepareSelfUpdate(plan, installation, exec, log);
      } finally {
        await installation.cleanup();
        installSecrets = [];
      }
      finish(
        'prepare',
        'done',
        `${prepareDetail(readPrepare(output), true)} · ${duration(Date.now() - started)}`,
      );
    } catch (error) {
      const detail = prepareDetail(readPrepare(error.output || output), false);
      finish('prepare', 'failed', `${detail} · ${duration(Date.now() - started)}`);
      return end(
        'failed',
        `The update to ${short(run.to)} stopped while preparing, before anything changed.`,
      );
    }

    // Other computers follow SER: build their worker from the same commit, outside the verified
    // release, and publish it once SER serves that commit. A failure here only means they wait.
    const workers = join(plan.data, 'cli.next');
    try {
      const scratch = join(dirname(plan.history), 'cli-build');
      const cache = join(dirname(plan.history), 'node-cache');
      rmSync(scratch, { recursive: true, force: true });
      rmSync(workers, { recursive: true, force: true });
      await exec('cp', ['-a', plan.release, scratch]);
      rmSync(join(scratch, '.deploy-release.json'), { force: true });
      rmSync(join(scratch, 'dist', 'cli'), { recursive: true, force: true });
      mkdirSync(cache, { recursive: true });
      mkdirSync(join(scratch, '.deploy-data'), { recursive: true });
      rmSync(join(scratch, '.deploy-data', 'node-cache'), { recursive: true, force: true });
      symlinkSync(cache, join(scratch, '.deploy-data', 'node-cache'));
      // rcodesign (in ~/.local/bin) signs the macOS builds so Macs can run them.
      await exec(process.execPath, ['scripts/build-cli.mjs'], {
        cwd: scratch,
        env: {
          ...process.env,
          PATH: `${join(process.env.HOME || '', '.local/bin')}:${dirname(process.execPath)}:${process.env.PATH}`,
        },
      });
      await exec('mv', [join(scratch, 'dist', 'cli'), workers]);
      rmSync(scratch, { recursive: true, force: true });
    } catch (error) {
      log(
        `Worker builds for other computers failed; they keep their version.\n${error.stack || error}\n`,
      );
      rmSync(workers, { recursive: true, force: true });
    }

    started = begin('backup');
    try {
      await backupSelfUpdateDatabases(plan.data, run.to);
      finish('backup', 'done', `deploy.db and workspace.db · ${duration(Date.now() - started)}`);
    } catch (error) {
      log(`${error.stack || error}\n`);
      finish('backup', 'failed', `${error.message} · ${duration(Date.now() - started)}`);
      return end(
        'failed',
        `The update to ${short(run.to)} stopped while backing up, before anything changed.`,
      );
    }

    begin('restart');
    try {
      await exec('deploy-update', ['activate', plan.release]);
      finish('restart', 'done', `serving ${short(run.to)}`);
      publishWorkers(plan.data, run.to, log);
      finish('check', 'done', 'healthy over HTTPS');
      try {
        for (const path of pruneReleases(
          dirname(plan.release),
          [
            plan.release,
            serving,
            realpathSync(plan.current),
            resolve(dirname(fileURLToPath(import.meta.url)), '..'),
          ],
          3,
          log,
        ))
          log(`Removed old release ${path}\n`);
      } catch (error) {
        log(`Could not remove old releases; the update itself is fine.\n${error.stack || error}\n`);
      }
      return end('done');
    } catch (error) {
      const text = error.output || error.message;
      const rolledBack = /Update failed; restored /.test(text);
      run.rolledBack = rolledBack;
      finish(
        'restart',
        'failed',
        rolledBack ? `did not come back healthy` : text.trim().split('\n').at(-1),
      );
      return end(
        'failed',
        rolledBack
          ? `${short(run.to)} did not come back healthy, so ${plan.computer || 'the coordinator'} went back to ${short(run.from)}.`
          : /needs attention/.test(text)
            ? 'The update failed and going back to the previous release needs attention. Check the log.'
            : `The update to ${short(run.to)} stopped before the restart.`,
      );
    }
  })().catch((error) => {
    log(`${error.stack || error}\n`);
    end('failed', 'The updater stopped unexpectedly. Check the log.');
    process.exitCode = 1;
  });
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main(process.argv[2]);
