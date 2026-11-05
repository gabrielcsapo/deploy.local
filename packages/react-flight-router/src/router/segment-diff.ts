import type { RouteMatch } from "./types.js";

export interface DiffSegmentsOptions {
  /**
   * Set to true when the URL search string changed between navigations.
   * Pathname-based matching by itself returns "no changes" when only the
   * search params differ, but any component in the matched chain may have
   * read URL state via `getRequest()` (filters, sort, page, etc.). Since we
   * can't statically know which components depend on the URL, the
   * conservative correct behavior is to invalidate every matched segment.
   *
   * Without this flag, `router.navigate("/x?a=1")` followed by
   * `router.navigate("/x?a=2")` would render no new segments and the page
   * would show stale data.
   */
  searchChanged?: boolean;
}

/**
 * Compare old and new route matches to determine which segments changed.
 * Returns segment keys that need re-rendering.
 */
export function diffSegments(
  oldMatches: RouteMatch[],
  newMatches: RouteMatch[],
  options?: DiffSegmentsOptions,
): string[] {
  if (options?.searchChanged) {
    // Force every matched segment to re-render. We still return the full
    // chain (not a single key) so ancestor layouts that read the URL pick
    // up the change too. Callers that opt into this path accept the cost
    // of re-rendering segments that didn't read the URL.
    return newMatches.map((m) => m.segmentKey);
  }

  let divergeIndex = 0;

  for (let i = 0; i < Math.min(oldMatches.length, newMatches.length); i++) {
    if (
      oldMatches[i].route.id !== newMatches[i].route.id ||
      !paramsEqual(oldMatches[i].params, newMatches[i].params)
    ) {
      break;
    }
    divergeIndex = i + 1;
  }

  // All segments from divergeIndex onward in newMatches need re-rendering
  const changed: string[] = [];
  for (let i = divergeIndex; i < newMatches.length; i++) {
    changed.push(newMatches[i].segmentKey);
  }

  return changed;
}

function paramsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a[key] === b[key]);
}
