#!/usr/bin/env node
// Restore a whole-directory rsync backup into an empty data directory, with the server stopped.
// Usage: node scripts/restore-backup.mjs <backup-drive> [--list | <empty-data-directory> [--copy <name>] [--allow-incomplete]]
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
import { openDatabase } from '../server/sqlite.ts';

import { COMPLETE_MARKER, DESTINATION_MARKER, listBackupCopies } from '../shared/backup-copies.ts';

const DATABASES = ['deploy.db', 'requests.db', 'workspace/workspace.db'];

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const positional = [];
let copyName;
let list = false;
let allowIncomplete = false;
const usage =
  'Usage: node scripts/restore-backup.mjs <backup-drive> [--list | <empty-data-directory> [--copy <name>] [--allow-incomplete]]';
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--list') list = true;
  else if (arg === '--allow-incomplete') allowIncomplete = true;
  else if (arg === '--copy' && !copyName && args[index + 1] && !args[index + 1].startsWith('--'))
    copyName = args[++index];
  else if (arg.startsWith('--')) fail(usage);
  else positional.push(arg);
}
if (positional.length !== (list ? 1 : 2) || (list && (copyName || allowIncomplete))) fail(usage);
const drive = resolve(positional[0]);
let copies;
try {
  copies = await listBackupCopies(drive);
} catch (error) {
  fail(`Cannot read backup drive ${drive}: ${error.message}`);
}
if (list) {
  for (const copy of copies)
    console.log(`${copy.name}\t${copy.complete ? 'complete' : 'incomplete'}`);
  process.exit(0);
}
const selected = copyName
  ? copies.find((copy) => copy.name === copyName)
  : copies.find((copy) => copy.complete);
if (!selected)
  fail(
    copyName
      ? `No dated copy named ${copyName} on ${drive}.`
      : `No complete dated copy on ${drive}. Use --list, then --copy <name> --allow-incomplete only if you intend to recover an unfinished copy.`,
  );
const source = selected.path;
const destination = resolve(positional[1]);

for (const file of DATABASES)
  if (!existsSync(join(source, `${file}.snapshot`)))
    fail(`${source} is not a complete backup: ${file}.snapshot is missing.`);
const completePath = join(source, COMPLETE_MARKER);
if (!selected.complete && !allowIncomplete)
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
  const database = openDatabase(path, { readonly: true, fileMustExist: true });
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
if (selected.complete) {
  const { dataDirectory, finishedAt } = JSON.parse(readFileSync(completePath, 'utf8'));
  console.log(`Restored the backup finished at ${finishedAt}.`);
  if (dataDirectory !== destination)
    console.warn(
      `This data came from ${dataDirectory}. Repositories and task records store that absolute path, so restore there unless you are only reading the data.`,
    );
}
console.log(`Start the server with DEPLOY_DATA_DIR=${destination}`);
