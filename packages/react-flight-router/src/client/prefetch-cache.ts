"use client";

import { RSC_ENDPOINT } from "../shared/constants.js";

/**
 * Client-side prefetch cache for RSC payloads.
 *
 * Stores prefetched Response objects keyed by pathname+search so the router
 * can use them on navigation instead of making a duplicate request.
 */

// Completed prefetch responses ready to be consumed by the router.
const prefetchCache = new Map<string, Response>();

// In-flight prefetch promises to avoid duplicate requests.
const inflightPrefetches = new Map<string, Promise<void>>();

function cacheKey(to: string): string {
  const origin = globalThis.location?.origin ?? "http://localhost";
  const url = new URL(to, origin);
  return url.pathname + url.search;
}

/**
 * Prefetch the RSC payload for a given path.
 * The response is stored in the cache for the router to consume on navigation.
 */
export function prefetchRSC(to: string): void {
  const key = cacheKey(to);
  if (prefetchCache.has(key) || inflightPrefetches.has(key)) return;

  const promise = fetch(`${RSC_ENDPOINT}?url=${encodeURIComponent(key)}`, {
    priority: "low" as RequestPriority,
  })
    .then((response) => {
      if (response.ok && response.body) {
        prefetchCache.set(key, response);
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
 * Returns the Response if available, or null if not prefetched.
 * The entry is removed from the cache after consumption (one-time use).
 */
export function consumePrefetch(pathname: string, search: string): Response | null {
  const key = pathname + search;
  const response = prefetchCache.get(key);
  if (response) {
    prefetchCache.delete(key);
    return response;
  }
  return null;
}
