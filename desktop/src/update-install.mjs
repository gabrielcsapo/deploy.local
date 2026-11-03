import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { mkdir, open, rm, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, basename } from 'node:path';
const run = promisify(execFile);

export function appBundle(executable) {
  const match = executable.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/);
  if (!match) throw new Error('Updates require a packaged Mac application.');
  return match[1];
}
export function returnPage(value, origin) {
  try {
    const url = new URL(value);
    if (
      url.origin === origin &&
      (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/'))
    )
      return url.pathname + url.search + url.hash;
  } catch {}
  return '/dashboard';
}
export async function prepareInstall({
  executable,
  staged,
  directory,
  page,
  build,
  pid = process.pid,
}) {
  const bundle = appBundle(executable);
  await access(dirname(bundle), constants.W_OK);
  const token = randomUUID();
  const candidate = join(dirname(bundle), `.${basename(bundle)}.update-${token}.app`);
  const backup = join(dirname(bundle), `.${basename(bundle)}.previous-${token}.app`);
  await mkdir(join(directory, 'updates'), { recursive: true });
  const receipt = join(directory, 'updates', token + '.json');
  try {
    // Stage on the destination volume before quitting; both swap renames stay atomic.
    await run('/usr/bin/ditto', [staged, candidate]);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate]);
    await writeFile(receipt, JSON.stringify({ bundle, backup, candidate, page, build }), {
      mode: 0o600,
    });
    await writeFile(receipt + '.sh', readFileSync(new URL('./update-helper.sh', import.meta.url)), {
      mode: 0o700,
    });
    const log = await open(receipt + '.log', 'a', 0o600);
    try {
      const helper = spawn(
        '/bin/sh',
        [
          receipt + '.sh',
          String(pid),
          bundle,
          candidate,
          backup,
          receipt,
          token,
          directory,
          '/usr/bin/open',
        ],
        { detached: true, stdio: ['ignore', log.fd, log.fd], cwd: directory },
      );
      await new Promise((resolve, reject) => {
        helper.once('spawn', resolve);
        helper.once('error', reject);
      });
      helper.unref();
    } finally {
      await log.close();
    }
  } catch (error) {
    await rm(candidate, { recursive: true, force: true });
    throw error;
  }
}

export function readHandoff({ args, directory, executable, build }) {
  const value = args.find((arg) => /^--deploy-update(?:-rollback)?=/.test(arg));
  if (!value) return null;
  const token = value.split('=')[1];
  if (!/^[0-9a-f-]{36}$/.test(token)) throw new Error('Invalid update handoff.');
  const receipt = join(directory, 'updates', token + '.json');
  const record = JSON.parse(readFileSync(receipt, 'utf8'));
  const bundle = appBundle(executable);
  if (
    record.bundle !== bundle ||
    record.backup !== join(dirname(bundle), `.${basename(bundle)}.previous-${token}.app`)
  )
    throw new Error('Update handoff does not match this application.');
  const rollback = value.startsWith('--deploy-update-rollback=');
  if (
    !rollback &&
    (record.build.commit !== build.commit ||
      record.build.buildTime !== build.buildTime ||
      record.build.version !== build.version)
  )
    throw new Error('Started application does not match the downloaded build.');
  if (!rollback) writeFileSync(receipt + '.pid', String(process.pid), { mode: 0o600 });
  return { ...record, receipt, rollback };
}
export async function acknowledgeStart(handoff) {
  if (!handoff || handoff.rollback) return true;
  try {
    mkdirSync(handoff.receipt + '.claim');
  } catch {
    return existsSync(handoff.receipt + '.ok');
  }
  writeFileSync(handoff.receipt + '.ok', 'started\n', { mode: 0o600 });
  try {
    await rm(handoff.backup, { recursive: true, force: true });
  } catch (error) {
    console.error('[desktop update] Keeping previous bundle:', error.message);
  }
  return true;
}
