#!/usr/bin/env node
// Restore a whole-directory rsync backup into an empty data directory, with the server stopped.
// Usage: node scripts/restore-backup.mjs <backup-directory> <empty-data-directory> [--allow-incomplete]
// README.md has these same steps by hand.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const DATABASES = ['deploy.db', 'requests.db', 'workspace/workspace.db'];
const DESTINATION_MARKER = '.deploy-backup-destination';
const COMPLETE_MARKER = '.deploy-backup-complete';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const flags = process.argv.slice(2).filter((value) => value.startsWith('--'));
const positional = process.argv.slice(2).filter((value) => !value.startsWith('--'));
if (positional.length !== 2 || flags.some((flag) => flag !== '--allow-incomplete'))
  fail(
    'Usage: node scripts/restore-backup.mjs <backup-directory> <empty-data-directory> [--allow-incomplete]',
  );
const source = resolve(positional[0]);
const destination = resolve(positional[1]);

for (const file of DATABASES)
  if (!existsSync(join(source, `${file}.snapshot`)))
    fail(`${source} is not a complete backup: ${file}.snapshot is missing.`);
const completePath = join(source, COMPLETE_MARKER);
if (!existsSync(completePath) && !flags.includes('--allow-incomplete'))
  fail(
    `The last backup to ${source} did not finish, so its files may come from different runs. To restore it anyway, add --allow-incomplete.`,
  );
if (existsSync(destination) && readdirSync(destination).length > 0)
  fail(`${destination} must be empty.`);

mkdirSync(destination, { recursive: true, mode: 0o700 });
const copy = spawnSync(
  'rsync',
  [
    '-a',
    '--numeric-ids',
    '--exclude',
    `/${DESTINATION_MARKER}`,
    '--exclude',
    `/${COMPLETE_MARKER}`,
    `${source}/`,
    `${destination}/`,
  ],
  { stdio: 'inherit' },
);
if (copy.status !== 0)
  fail(`rsync failed with exit code ${copy.status}. ${destination} is partial.`);

for (const file of DATABASES) {
  const path = join(destination, file);
  renameSync(`${path}.snapshot`, path);
  for (const stale of [`${path}-wal`, `${path}-shm`]) rmSync(stale, { force: true });
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (database.pragma('integrity_check', { simple: true }) !== 'ok')
      fail(`${file} failed its integrity check. Do not start a server on ${destination}.`);
  } finally {
    database.close();
  }
  // Opening it read-only can leave an empty WAL behind.
  for (const stale of [`${path}-wal`, `${path}-shm`]) rmSync(stale, { force: true });
}

const keyPath = join(destination, 'secrets', 'master.key');
if (!existsSync(keyPath) || statSync(keyPath).size !== 32)
  console.warn(
    `${keyPath} is missing or invalid. The server will refuse to start until the key is put back or DEPLOY_SECRET_KEY is set.`,
  );
if (existsSync(completePath)) {
  const { dataDirectory, finishedAt } = JSON.parse(readFileSync(completePath, 'utf8'));
  console.log(`Restored the backup finished at ${finishedAt}.`);
  if (dataDirectory !== destination)
    console.warn(
      `This data came from ${dataDirectory}. Repositories and task records store that absolute path, so restore there unless you are only reading the data.`,
    );
}
console.log(`Start the server with DEPLOY_DATA_DIR=${destination}`);
