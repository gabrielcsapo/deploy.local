"use client";

import { RSC_ENDPOINT } from "../shared/constants.js";

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
const inflightPrefetches = new Map<string, Promise<void>>();

function cacheKey(to: string): string {
  const origin = globalThis.location?.origin ?? "http://localhost";
  const url = new URL(to, origin);
  return url.pathname + url.search;
}

function dropEntry(key: string, entry: PrefetchEntry): void {
  prefetchCache.delete(key);
  // Release the unread body so the browser can free the connection/buffer.
  entry.response.body?.cancel().catch(() => {});
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

  const promise = fetch(`${RSC_ENDPOINT}?url=${encodeURIComponent(key)}`, {
    priority: "low" as RequestPriority,
  })
    .then((response) => {
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
      inflightPrefetches.delete(key);
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
