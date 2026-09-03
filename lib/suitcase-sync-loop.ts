import {
  readSuitcaseMembership,
  setSuitcaseLocalMode,
  setSuitcaseMode,
  syncSuitcaseNow,
  type ClientOptions,
  type SuitcaseMembership,
} from './suitcase-sync-client.ts';

export interface SuitcaseSyncLoopOptions extends Pick<
  ClientOptions,
  'directory' | 'membershipFile' | 'fetch' | 'projectEvent'
> {
  signal?: AbortSignal;
  successIntervalMs?: number;
  idleIntervalMs?: number;
  retryBaseMs?: number;
  retryMaximumMs?: number;
  awayAfterFailures?: number;
  random?: () => number;
  readMembership?: () => SuitcaseMembership | undefined;
  sync?: () => Promise<unknown>;
  markDocked?: () => Promise<unknown>;
  markAway?: () => Promise<unknown> | unknown;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onError?: (error: unknown, retryInMs: number) => void;
  beforeSync?: (membership: SuitcaseMembership) => Promise<void> | void;
  afterSync?: (membership: SuitcaseMembership) => Promise<void> | void;
  prepareMembership?: () => Promise<void> | void;
}

function abortableWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function suitcaseRetryDelay(
  failures: number,
  baseMs: number,
  maximumMs: number,
  random = Math.random,
): number {
  const bounded = Math.min(maximumMs, baseMs * 2 ** Math.max(0, failures - 1));
  // 80–100% jitter keeps the result bounded by the configured maximum while
  // preventing several docked suitcases from retrying in lockstep.
  return Math.max(1, Math.round(bounded * (0.8 + random() * 0.2)));
}

export async function runSuitcaseSyncLoop(options: SuitcaseSyncLoopOptions = {}): Promise<void> {
  const successIntervalMs = options.successIntervalMs ?? 15_000;
  const idleIntervalMs = options.idleIntervalMs ?? 5_000;
  const retryBaseMs = options.retryBaseMs ?? 1_000;
  const retryMaximumMs = options.retryMaximumMs ?? 60_000;
  const awayAfterFailures = options.awayAfterFailures ?? 3;
  const wait = options.wait ?? abortableWait;
  const readMembership =
    options.readMembership ??
    (() => readSuitcaseMembership(options.directory, options.membershipFile));
  const sync =
    options.sync ??
    (() =>
      syncSuitcaseNow({
        directory: options.directory,
        membershipFile: options.membershipFile,
        fetch: options.fetch,
        manualSync: false,
        projectEvent: options.projectEvent,
      }));
  const markDocked =
    options.markDocked ??
    (() =>
      setSuitcaseMode('docked', {
        directory: options.directory,
        membershipFile: options.membershipFile,
        fetch: options.fetch,
      }));
  const markAway =
    options.markAway ??
    (() =>
      setSuitcaseLocalMode('away', {
        directory: options.directory,
        membershipFile: options.membershipFile,
      }));
  let failures = 0;

  while (!options.signal?.aborted) {
    await options.prepareMembership?.();
    const membership = readMembership();
    if (!membership) {
      failures = 0;
      await wait(idleIntervalMs, options.signal);
      continue;
    }
    try {
      await options.beforeSync?.(membership);
      await sync();
      await options.afterSync?.(readMembership() || membership);
      if (membership.mode !== 'docked') await markDocked();
      failures = 0;
      await wait(successIntervalMs, options.signal);
    } catch (error) {
      failures += 1;
      if (membership.mode !== 'away' && failures === awayAfterFailures) await markAway();
      const retryInMs = suitcaseRetryDelay(failures, retryBaseMs, retryMaximumMs, options.random);
      options.onError?.(error, retryInMs);
      await wait(retryInMs, options.signal);
    }
  }
}
