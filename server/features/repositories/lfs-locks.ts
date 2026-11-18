import { randomUUID } from 'node:crypto';
import { list, remove, save } from '../../kernel/db/records.ts';

/**
 * Git LFS File Locking API v2 (git-lfs docs/api/locking.md). Locks apply to the whole
 * repository: the spec's v2 is single-branch, and `ref`/`refspec` are only used for
 * authorization there, so they are validated and kept but never narrow a match.
 * One `lfs-lock` record per repository and path; its record id is `<projectId>:<path>`.
 */
type Lock = {
  id: string;
  lockId: string;
  projectId: string;
  path: string;
  ownerName: string;
  ref: string | null;
  lockedAt: string;
};
const fail = (message: string, status = 400): never => {
  throw Object.assign(new Error(message), { status });
};
const defaultLimit = 100;
const maximumLimit = 1000;

export function lockPath(path: unknown) {
  if (
    typeof path !== 'string' ||
    !path ||
    Buffer.byteLength(path) > 4096 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '..' || part === '')
  )
    fail('Enter a file path relative to the repository root', 422);
  return path as string;
}
function refName(ref: unknown) {
  if (ref === undefined || ref === null) return null;
  const name = (ref as any)?.name;
  if (typeof ref !== 'object' || typeof name !== 'string' || !/^refs\/\S{1,1000}$/.test(name))
    fail('Expected ref.name to be a fully qualified ref', 422);
  return name as string;
}
function limitOf(value: unknown) {
  if (value === undefined || value === null || value === '' || value === 0) return defaultLimit;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 0) fail('Invalid limit', 422);
  return Math.min(limit, maximumLimit);
}
function offsetOf(cursor: unknown) {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  if (typeof cursor !== 'string' || !/^\d{1,9}$/.test(cursor)) fail('Invalid cursor', 422);
  return Number(cursor);
}
function locks(owner: string, projectId: string): Lock[] {
  return (list('lfs-lock', owner) as Lock[])
    .filter((lock) => lock.projectId === projectId)
    .sort((a, b) => a.lockedAt.localeCompare(b.lockedAt) || a.lockId.localeCompare(b.lockId));
}
function page<T>(items: T[], cursor: unknown, limit: unknown) {
  const start = offsetOf(cursor),
    size = limitOf(limit),
    end = start + size;
  return { items: items.slice(start, end), next: end < items.length ? String(end) : undefined };
}
/** The spec's lock object. `owner.name` is the deploy.local account that holds it. */
export function presentLock(lock: Lock) {
  return {
    id: lock.lockId,
    path: lock.path,
    locked_at: lock.lockedAt,
    owner: { name: lock.ownerName },
  };
}

/** POST /locks: 201 with the new lock, or 409 with the lock already on that path. */
export function createLock(owner: string, projectId: string, user: string, input: any) {
  const path = lockPath(input?.path);
  const ref = refName(input?.ref);
  // Synchronous read-then-write: no other request can interleave between the check and save.
  const existing = locks(owner, projectId).find((lock) => lock.path === path);
  if (existing)
    return {
      status: 409,
      body: { lock: presentLock(existing), message: `${path} is already locked` },
    };
  const lock: Lock = save('lfs-lock', owner, {
    id: projectId + ':' + path,
    lockId: randomUUID(),
    projectId,
    path,
    ownerName: user,
    ref,
    lockedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  return { status: 201, body: { lock: presentLock(lock) } };
}

/** GET /locks?path=&id=&cursor=&limit=&refspec= */
export function listLocks(owner: string, projectId: string, query: URLSearchParams) {
  const refspec = query.get('refspec');
  if (refspec !== null) refName({ name: refspec });
  const path = query.get('path'),
    id = query.get('id');
  const matching = locks(owner, projectId).filter(
    (lock) => (path === null || lock.path === path) && (id === null || lock.lockId === id),
  );
  const { items, next } = page(matching, query.get('cursor') ?? undefined, query.get('limit'));
  return { locks: items.map(presentLock), ...(next ? { next_cursor: next } : {}) };
}

/** POST /locks/verify: the page of locks split into the caller's and everyone else's. */
export function verifyLocks(owner: string, projectId: string, user: string, input: any) {
  refName(input?.ref);
  const { items, next } = page(locks(owner, projectId), input?.cursor, input?.limit);
  return {
    ours: items.filter((lock) => lock.ownerName === user).map(presentLock),
    theirs: items.filter((lock) => lock.ownerName !== user).map(presentLock),
    ...(next ? { next_cursor: next } : {}),
  };
}

/** POST /locks/:id/unlock: only the holder may unlock unless `force` is true. */
export function unlock(owner: string, projectId: string, user: string, id: string, input: any) {
  refName(input?.ref);
  if (input?.force !== undefined && typeof input.force !== 'boolean')
    fail('Expected force to be true or false', 422);
  const lock = locks(owner, projectId).find((candidate) => candidate.lockId === id);
  if (!lock) return fail('Lock not found', 404);
  if (lock.ownerName !== user && input?.force !== true)
    fail(`${lock.path} is locked by ${lock.ownerName}; unlock with --force to remove it`, 403);
  remove('lfs-lock', owner, lock.id);
  return { lock: presentLock(lock) };
}
