import type { RouteConfig, RouteMatch, SlotMatch } from "./types.js";

/**
 * Match a URL pathname against a route configuration tree.
 * Returns an array of matches from outermost (root) to innermost (leaf).
 *
 * `parentSegmentKey` is used by parallel-route slot matching to root the
 * generated segment keys under the owning layout (e.g. "root@modal/...").
 */
export function matchRoutes(
  routes: RouteConfig[],
  pathname: string,
  parentSegmentKey: string = "",
): RouteMatch[] {
  const matches: RouteMatch[] = [];
  const normalized = normalizePath(pathname);
  const pathSegments = normalized.split("/").filter(Boolean);
  matchRecursive(routes, pathSegments, 0, parentSegmentKey, matches);
  return matches;
}

/**
 * Match parallel-route slots declared on any of the layouts in `mainMatches`.
 *
 * For each layout route with a `slots` config, look at the URL search params
 * for `@<slotName>=<path>`. When present, match that path against the slot's
 * own route subtree, keying the resulting segments under the layout via the
 * `@<slotName>` separator (e.g. "root@modal", "root@modal/photo").
 *
 * A slot whose matches are empty (e.g. the path doesn't resolve) is dropped
 * silently — the client will still strip the segment because segmentKeys is
 * authoritative.
 */
export function matchSlots(mainMatches: RouteMatch[], searchParams: URLSearchParams): SlotMatch[] {
  const result: SlotMatch[] = [];
  for (const main of mainMatches) {
    const slots = main.route.slots;
    if (!slots) continue;
    for (const slotName of Object.keys(slots)) {
      const slotPath = searchParams.get(`@${slotName}`);
      if (!slotPath) continue;
      const slotMatches = matchRoutes(slots[slotName], slotPath, `${main.segmentKey}@${slotName}`);
      if (slotMatches.length === 0) continue;
      result.push({
        parentSegmentKey: main.segmentKey,
        name: slotName,
        path: slotPath,
        matches: slotMatches,
      });
    }
  }
  return result;
}

// Cache for pre-split pattern segments, keyed by pattern string.
// Pattern strings are static route definitions so this cache is bounded
// by the number of routes in the app.
const patternCache = new Map<string, string[]>();

function getPatternSegments(pattern: string): string[] {
  let cached = patternCache.get(pattern);
  if (!cached) {
    cached = pattern.split("/").filter(Boolean);
    patternCache.set(pattern, cached);
  }
  return cached;
}

function matchRecursive(
  routes: RouteConfig[],
  pathSegments: string[],
  pathOffset: number,
  parentSegmentKey: string,
  matches: RouteMatch[],
): boolean {
  for (const route of routes) {
    if (route.index) {
      if (pathOffset >= pathSegments.length) {
        const segmentKey = buildSegmentKey(parentSegmentKey, route.id);
        const parentParams = matches.length > 0 ? matches[matches.length - 1].params : {};
        matches.push({
          route,
          params: { ...parentParams },
          pathname: "",
          segmentKey,
        });
        return true;
      }
      continue;
    }

    const pattern = route.path ?? "";
    const result = matchSegment(pattern, pathSegments, pathOffset);

    if (result.matched) {
      const segmentKey = buildSegmentKey(parentSegmentKey, route.id);
      // Merge params from parent matches
      const parentParams = matches.length > 0 ? matches[matches.length - 1].params : {};
      const mergedParams = { ...parentParams, ...result.params };

      matches.push({
        route,
        params: mergedParams,
        pathname: result.consumed,
        segmentKey,
      });

      if (route.children) {
        if (matchRecursive(route.children, pathSegments, result.nextOffset, segmentKey, matches)) {
          return true;
        }
        // Children didn't match — check for notFound fallback
        const hasRemaining = result.nextOffset < pathSegments.length;
        if (route.notFound && hasRemaining) {
          const notFoundKey = buildSegmentKey(segmentKey, "__not-found__");
          const rest = "/" + pathSegments.slice(result.nextOffset).join("/");
          matches.push({
            route: {
              id: "__not-found__",
              component: route.notFound,
            },
            params: mergedParams,
            pathname: rest,
            segmentKey: notFoundKey,
          });
          return true;
        }
        // Backtrack if children didn't match
        matches.pop();
      } else if (result.nextOffset >= pathSegments.length) {
        return true;
      } else {
        // Path not fully consumed and no children
        matches.pop();
      }
    }
  }
  return false;
}

interface SegmentMatchResult {
  matched: boolean;
  params: Record<string, string>;
  consumed: string;
  /** Index into pathSegments where remaining path starts */
  nextOffset: number;
}

const noMatchResult: SegmentMatchResult = {
  matched: false,
  params: {},
  consumed: "",
  nextOffset: 0,
};

function matchSegment(
  pattern: string,
  pathSegments: string[],
  pathOffset: number,
): SegmentMatchResult {
  // Layout route - matches everything, consumes nothing
  if (pattern === "") {
    return { matched: true, params: {}, consumed: "", nextOffset: pathOffset };
  }

  const patternSegments = getPatternSegments(pattern);
  const params: Record<string, string> = {};

  for (let i = 0; i < patternSegments.length; i++) {
    const seg = patternSegments[i];
    const pathSeg = pathSegments[pathOffset + i];

    if (pathSeg === undefined) {
      return noMatchResult;
    }

    if (seg.startsWith(":")) {
      if (seg.endsWith("*")) {
        // Catch-all: consume the rest
        const paramName = seg.slice(1, -1);
        params[paramName] = pathSegments
          .slice(pathOffset + i)
          .map(decodeURIComponent)
          .join("/");
        const consumed = "/" + pathSegments.slice(pathOffset).join("/");
        return { matched: true, params, consumed, nextOffset: pathSegments.length };
      }
      // Dynamic segment
      const paramName = seg.slice(1);
      params[paramName] = decodeURIComponent(pathSeg);
    } else if (seg !== pathSeg) {
      return noMatchResult;
    }
  }

  const consumed =
    "/" + pathSegments.slice(pathOffset, pathOffset + patternSegments.length).join("/");

  return { matched: true, params, consumed, nextOffset: pathOffset + patternSegments.length };
}

function buildSegmentKey(parentKey: string, routeId: string): string {
  return parentKey ? `${parentKey}/${routeId}` : routeId;
}

function normalizePath(pathname: string): string {
  // Ensure leading slash, remove trailing slash (except for root)
  let p = pathname;
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}
