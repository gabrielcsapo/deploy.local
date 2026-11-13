'use client';

import { RSC_ENDPOINT } from '../shared/constants.js';

/**
 * Client-side prefetch cache for RSC payloads.
 *
 * Stores prefetched Response objects keyed by pathname+search so the router
 * can use them on navigation instead of making a duplicate request.
 */

// Completed prefetch responses ready to be consumed by the router.
// Bounded + time-limited: entries are only removed on consumption, so an
// unbounded map would accumulate Response objects (with unread bodies) for
// every link ever hovered, and an old entry would serve stale data on click.
const PREFETCH_MAX_ENTRIES = 25;
const PREFETCH_TTL_MS = 30_000;

interface PrefetchEntry {
  response: Response;
  expiresAt: number;
}

const prefetchCache = new Map<string, PrefetchEntry>();

// In-flight prefetch promises to avoid duplicate requests.
let generation = 0;
const inflightPrefetches = new Map<string, Promise<void>>();

function cacheKey(to: string): string {
  const origin = globalThis.location?.origin ?? 'http://localhost';
  const url = new URL(to, origin);
  return url.pathname + url.search;
}

function dropEntry(key: string, entry: PrefetchEntry): void {
  prefetchCache.delete(key);
  // Release the unread body so the browser can free the connection/buffer.
  entry.response.body?.cancel().catch(() => {});
}

/** Drop credentials-sensitive speculative responses when the host changes identity. */
export function clearPrefetchCache(): void {
  generation++;
  for (const [key, entry] of prefetchCache) dropEntry(key, entry);
  inflightPrefetches.clear();
}

/**
 * Prefetch the RSC payload for a given path.
 * The response is stored in the cache for the router to consume on navigation.
 */
export function prefetchRSC(to: string): void {
  const key = cacheKey(to);
  const existing = prefetchCache.get(key);
  if (existing) {
    if (existing.expiresAt > Date.now()) return;
    dropEntry(key, existing); // expired — refetch below
  }
  if (inflightPrefetches.has(key)) return;

  const startedGeneration = generation;
  const promise = fetch(`${RSC_ENDPOINT}?url=${encodeURIComponent(key)}`, {
    priority: 'low' as RequestPriority,
  })
    .then((response) => {
      if (startedGeneration !== generation) {
        response.body?.cancel().catch(() => {});
        return;
      }
      if (response.ok && response.body) {
        // Evict oldest entries to stay under the cap (Map preserves
        // insertion order, so the first key is the oldest).
        while (prefetchCache.size >= PREFETCH_MAX_ENTRIES) {
          const oldestKey = prefetchCache.keys().next().value;
          if (oldestKey === undefined) break;
          dropEntry(oldestKey, prefetchCache.get(oldestKey)!);
        }
        prefetchCache.set(key, { response, expiresAt: Date.now() + PREFETCH_TTL_MS });
      }
    })
    .catch(() => {
      // Prefetch failure is non-critical
    })
    .finally(() => {
      if (inflightPrefetches.get(key) === promise) inflightPrefetches.delete(key);
    });

  inflightPrefetches.set(key, promise);
}

/**
 * Consume a prefetched response for the given path.
 * Returns the Response if available and fresh, or null otherwise.
 * The entry is removed from the cache after consumption (one-time use).
 */
export function consumePrefetch(pathname: string, search: string): Response | null {
  const key = pathname + search;
  const entry = prefetchCache.get(key);
  if (!entry) return null;
  prefetchCache.delete(key);
  if (entry.expiresAt <= Date.now()) {
    dropEntry(key, entry);
    return null;
  }
  return entry.response;
}

/** Take a completed prefetch, or await its headers without issuing a duplicate fetch. */
export async function takePrefetch(
  pathname: string,
  search: string,
  signal: AbortSignal,
  onConsume?: (source: 'hit' | 'inflight' | 'miss') => void,
): Promise<Response | null> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const response = consumePrefetch(pathname, search);
  if (response) {
    onConsume?.('hit');
    return response;
  }
  const pending = inflightPrefetches.get(pathname + search);
  if (!pending) {
    onConsume?.('miss');
    return null;
  }

  // Cancelling a navigation stops the wait but leaves the speculative fetch
  // available for a later navigation. Only one caller can consume its body.
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    pending.finally(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const result = consumePrefetch(pathname, search);
  onConsume?.(result ? 'inflight' : 'miss');
  return result;
}
