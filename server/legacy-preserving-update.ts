import { randomUUID } from 'node:crypto';
import {
  assertExistingLegacyData,
  snapshotStoppedLegacyData,
  restoreStoppedLegacyData,
  type LegacySnapshot,
} from './legacy-snapshot.mjs';
export {
  assertExistingLegacyData,
  snapshotStoppedLegacyData,
  restoreStoppedLegacyData,
  verifyLegacySnapshot,
  type LegacySnapshot,
} from './legacy-snapshot.mjs';
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function assertNoImplicitLegacyGraphAdoption(input: {
  name: string;
  containerName: string | null;
  activeSpecDigest: string | null;
}) {
  if (
    ['groffee', 'wander'].includes(input.name) &&
    input.containerName === `deploy-sh-${input.name}` &&
    !input.activeSpecDigest
  ) {
    throw Object.assign(
      new Error(
        'Existing legacy runtime requires a verified preservation update; implicit graph adoption would allocate new storage and omit existing SSH routing',
      ),
      { status: 409 },
    );
  }
}

/** Compatibility is deliberately limited to the three existing managed binds.
 * The caller must hold the normal deployment admission lease and authorize the
 * existing host-control capabilities before invoking this transaction. */
export interface LegacyUpdateRuntime {
  imageId: string;
  containerId: string;
  mounts: Array<{ source: string; destination: string; readOnly: boolean }>;
  ports: Record<string, Array<{ hostIp: string; hostPort: string }>>;
  environment: string[];
  settingsDigest: string;
}

export function assertLegacyUpdateEligible(input: {
  administrator: boolean;
  owner: boolean;
  activeGraphDigest: string | null;
  nodeId: string;
  volumeDirectory: string;
  runtime: LegacyUpdateRuntime;
}) {
  if (!input.owner || !input.administrator)
    throw new Error('Legacy updates require owner and administrator access');
  if (input.activeGraphDigest) throw new Error('An active graph cannot use legacy compatibility');
  if (input.nodeId !== 'coordinator') throw new Error('Legacy compatibility cannot move nodes');
  if (!/^sha256:[a-f0-9]{64}$/.test(input.runtime.imageId))
    throw new Error('Immutable rollback image required');
  const expected = new Map([
    ['/app/data', resolve(input.volumeDirectory, 'data')],
    ['/app/uploads', resolve(input.volumeDirectory, 'uploads')],
    ['/etc/ssh', resolve(input.volumeDirectory, '.ssh-host-keys')],
  ]);
  const seen = new Set<string>();
  for (const mount of input.runtime.mounts) {
    if (seen.has(mount.destination)) throw new Error('Duplicate runtime mount');
    seen.add(mount.destination);
    if (
      mount.destination === '/var/run/docker.sock' &&
      mount.source === mount.destination &&
      !mount.readOnly
    )
      continue;
    if (expected.get(mount.destination) !== mount.source || mount.readOnly)
      throw new Error('Unsupported legacy mount topology');
  }
  for (const destination of expected.keys()) {
    if (!seen.has(destination)) throw new Error(`Missing durable mount: ${destination}`);
  }
  const ssh = input.runtime.ports['2223/tcp'];
  if (!ssh?.length || ssh.some((port) => !port.hostPort || !port.hostIp))
    throw new Error('Existing SSH routing required');
  if (!input.runtime.environment.includes('EXTERNAL_URL=https://groffee.local'))
    throw new Error('Existing Groffee external URL required');
}

export interface LegacyUpdateOperations {
  validateData?(): Promise<void>;
  snapshot?(): Promise<LegacySnapshot>;
  restore?(snapshot: LegacySnapshot): Promise<void>;
  checkpoint?(
    phase: 'prepared' | 'stopped' | 'snapshot',
    previous: LegacyUpdateRuntime,
    snapshot?: LegacySnapshot,
  ): Promise<void>;
  inspect(): Promise<LegacyUpdateRuntime>;
  build(): Promise<string>; // immutable image ID; runs before downtime
  stopPrevious(): Promise<void>; // must verify stopped, not merely request stop
  startCandidate(imageId: string, previous: LegacyUpdateRuntime): Promise<void>;
  stopCandidate(): Promise<void>; // must verify stopped before restoring
  verifyCandidate(previous: LegacyUpdateRuntime): Promise<void>; // health + exact mounts/ports/env/settings and SSH fingerprints
  commit(snapshot: LegacySnapshot, previous: LegacyUpdateRuntime): Promise<void>;
  startPrevious(previous: LegacyUpdateRuntime): Promise<void>;
  verifyPrevious(previous: LegacyUpdateRuntime): Promise<void>;
}

/** A fail-closed, same-host code-only transaction, not graph adoption. This
 * callers cannot silently inherit the
 * normal blue/green path, which would run two writers on the same data. */
export async function runLegacyPreservingUpdate(input: {
  administrator: boolean;
  owner: boolean;
  activeGraphDigest: string | null;
  nodeId: string;
  volumeDirectory: string;
  recoveryRoot: string;
  operations: LegacyUpdateOperations;
}) {
  mkdirSync(input.recoveryRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(input.recoveryRoot, 'legacy-update.lock');
  const lock = openSync(lockPath, 'wx', 0o600);
  closeSync(lock);
  let stopped = false;
  let candidateAttempted = false;
  let snapshot: LegacySnapshot | undefined;
  let previous: LegacyUpdateRuntime | undefined;
  let recoveryIncomplete = false;
  try {
    previous = await input.operations.inspect();
    assertLegacyUpdateEligible({ ...input, runtime: previous });
    if (input.operations.validateData) await input.operations.validateData();
    else assertExistingLegacyData(input.volumeDirectory);
    const imageId = await input.operations.build();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
      throw new Error('Immutable candidate image required');
    const rechecked = await input.operations.inspect();
    if (JSON.stringify(rechecked) !== JSON.stringify(previous))
      throw new Error('Legacy runtime changed during build');
    await input.operations.checkpoint?.('prepared', previous);
    // A rejected stop may have stopped the writer before losing its response.
    // Preserve the lock in that ambiguous case; do not guess at writer state.
    try {
      await input.operations.stopPrevious();
    } catch (stopFailure) {
      recoveryIncomplete = true;
      const stopError = new AggregateError(
        [stopFailure],
        'Previous writer stop unconfirmed; recovery lock retained',
        { cause: stopFailure },
      );
      throw stopError;
    }
    stopped = true;
    await input.operations.checkpoint?.('stopped', previous);
    snapshot = input.operations.snapshot
      ? await input.operations.snapshot()
      : snapshotStoppedLegacyData(input.volumeDirectory, input.recoveryRoot);
    await input.operations.checkpoint?.('snapshot', previous, snapshot);
    writeFileSync(
      join(snapshot.directory, 'transaction.json'),
      JSON.stringify({ id: randomUUID(), phase: 'verified-snapshot', previous }),
      { mode: 0o600, flag: 'wx' },
    );
    candidateAttempted = true;
    await input.operations.startCandidate(imageId, previous);
    await input.operations.verifyCandidate(previous);
    await input.operations.commit(snapshot, previous);
    return snapshot;
  } catch (failure) {
    if (stopped && previous) {
      try {
        if (candidateAttempted) await input.operations.stopCandidate();
        if (snapshot && candidateAttempted) {
          if (input.operations.restore) await input.operations.restore(snapshot);
          else restoreStoppedLegacyData(input.volumeDirectory, snapshot);
        }
        await input.operations.startPrevious(previous);
        await input.operations.verifyPrevious(previous);
      } catch (rollbackFailure) {
        recoveryIncomplete = true;
        const recoveryError = new AggregateError(
          [failure, rollbackFailure],
          'Legacy rollback incomplete; recovery lock retained; operator recovery required',
          { cause: failure },
        );
        throw recoveryError;
      }
    }
    throw failure;
  } finally {
    // A crash or incomplete rollback intentionally leaves an admission marker.
    if (!recoveryIncomplete) rmSync(lockPath);
  }
}
