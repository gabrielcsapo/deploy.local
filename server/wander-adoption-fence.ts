import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  readFileSync,
  renameSync,
  unlinkSync,
  constants,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { deployDataPath } from './data-directory.ts';
import { currentCiMutation } from './ci-fence.ts';
export const WANDER_MANAGED_DIGEST =
  'sha256:3f6bd9ee8b563e6d95429a6d66a9fd0bd2f5d86325f5ef5b119c23b6eed98fa1';
export interface WanderSnapshot {
  directory: string;
  archiveDigest: string;
  inventoryDigest: string;
  databaseDigest: string;
  resources: Record<string, string>;
}
export interface WanderJournal {
  version: 1;
  id: string;
  application: 'wander';
  applicationId: string;
  owner: string;
  requestKey: string;
  phase:
    | 'reserved'
    | 'building'
    | 'built'
    | 'stopping'
    | 'stopped'
    | 'snapshot'
    | 'seeding'
    | 'seeded'
    | 'starting'
    | 'publishing'
    | 'committed'
    | 'cancelled';
  activePid: number | null;
  activeThread: number | null;
  failure: string | null;
  createdAt: number;
  updatedAt: number;
  sourceCommit: string;
  sourceDigest: string;
  sourceArchiveDigest: string;
  specDigest: string;
  sourceDirectory: string;
  baselineFingerprint: string;
  baselineRuntimeSettings: string;
  baselineContainer: string;
  baselineImage: string;
  baselineSource: string | null;
  baselineParent: string;
  baselineDeployment: Record<string, unknown>;
  rootIdentity: string;
  image: string | null;
  snapshot: WanderSnapshot | null;
  providers: Record<string, { name: string; created: boolean; seeded: boolean }>;
  candidateContainer: string | null;
  candidateName: string | null;
  helper: string | null;
}
export const wanderJournalRoot = () => deployDataPath('wander-adoption');
const path = () => join(wanderJournalRoot(), 'journal.json');
const fail = () => {
  throw Object.assign(new Error('Wander adoption requires explicit owner recovery'), {
    status: 409,
  });
};
function checkedFile(file: string) {
  const s = lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.mode & 0o077 || s.size > 256 * 1024) fail();
  if (s.uid !== (process.getuid?.() ?? s.uid)) fail();
}
export function readWanderJournal(): WanderJournal | undefined {
  if (!existsSync(path())) return undefined;
  try {
    checkedFile(path());
    const j = JSON.parse(readFileSync(path(), 'utf8'));
    if (
      j.version !== 1 ||
      j.application !== 'wander' ||
      !/^[-a-f0-9]{36}$/.test(j.id) ||
      typeof j.applicationId !== 'string' ||
      typeof j.phase !== 'string'
    )
      fail();
    return j;
  } catch {
    fail();
  }
}
function sync(file: string) {
  const fd = openSync(file, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function writeWanderJournal(j: WanderJournal, initial = false) {
  const root = wanderJournalRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const s = lstatSync(root);
  if (!s.isDirectory() || s.isSymbolicLink() || s.mode & 0o077) fail();
  const target = initial ? path() : join(root, '.journal-' + randomUUID());
  const fd = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, JSON.stringify(j));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!initial) renameSync(target, path());
  sync(root);
}
export function wanderReservation(name: string) {
  if (name !== 'wander') return undefined;
  const j = readWanderJournal();
  return j && !['committed', 'cancelled'].includes(j.phase) ? j.id : undefined;
}
export function wanderOwnerAlive(j: WanderJournal) {
  if (!j.activePid) return false;
  try {
    process.kill(j.activePid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
export function assertWanderLegacyAllowed(name: string) {
  if (name !== 'wander') return;
  const j = readWanderJournal();
  if (j && j.phase !== 'cancelled' && currentCiMutation() !== j.id)
    throw Object.assign(
      new Error(
        'Retained Wander legacy runtime is protected; use managed adoption/recovery or graph APIs',
      ),
      { status: 409 },
    );
}
export function assertWanderContainerMutation(target: string) {
  let j: WanderJournal | undefined;
  try {
    j = readWanderJournal();
  } catch (e) {
    if (target.replace(/^\//, '') === 'deploy-sh-wander') throw e;
    return;
  }
  if (!j || j.phase === 'cancelled') return;
  if (
    [j.baselineContainer, 'deploy-sh-wander'].includes(target.replace(/^\//, '')) &&
    currentCiMutation() !== j.id
  )
    fail();
}
export function releaseWanderWorker(pid: number, thread: number) {
  let j: WanderJournal | undefined;
  try {
    j = readWanderJournal();
  } catch {
    return;
  }
  if (j?.activePid === pid && j.activeThread === thread) {
    j.activePid = null;
    j.activeThread = null;
    j.failure = 'Owner worker interrupted; explicit recovery required';
    writeWanderJournal(j);
  }
}
// Tests remove only their disposable journal; no production clear/unlock endpoint exists.
export function _resetWanderJournal() {
  if (existsSync(path())) unlinkSync(path());
}
