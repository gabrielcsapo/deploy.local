import type { RouteConfig, RouteMatch } from "./types.js";

/**
 * Match a URL pathname against a route configuration tree.
 * Returns an array of matches from outermost (root) to innermost (leaf).
 */
export function matchRoutes(routes: RouteConfig[], pathname: string): RouteMatch[] {
  const matches: RouteMatch[] = [];
  const normalized = normalizePath(pathname);
  matchRecursive(routes, normalized, "", matches);
  return matches;
}

function matchRecursive(
  routes: RouteConfig[],
  remainingPath: string,
  parentSegmentKey: string,
  matches: RouteMatch[],
): boolean {
  for (const route of routes) {
    if (route.index) {
      if (remainingPath === "" || remainingPath === "/") {
        const segmentKey = buildSegmentKey(parentSegmentKey, route.id);
        matches.push({
          route,
          params: {},
          pathname: remainingPath,
          segmentKey,
        });
        return true;
      }
      continue;
    }

    const pattern = route.path ?? "";
    const result = matchSegment(pattern, remainingPath);

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
        if (matchRecursive(route.children, result.rest, segmentKey, matches)) {
          return true;
        }
        // Backtrack if children didn't match
        matches.pop();
      } else if (result.rest === "" || result.rest === "/") {
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
  rest: string;
}

function matchSegment(pattern: string, pathname: string): SegmentMatchResult {
  const noMatch: SegmentMatchResult = { matched: false, params: {}, consumed: "", rest: pathname };

  // Layout route - matches everything, consumes nothing
  if (pattern === "") {
    return { matched: true, params: {}, consumed: "", rest: pathname };
  }

  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  const params: Record<string, string> = {};

  for (let i = 0; i < patternSegments.length; i++) {
    const seg = patternSegments[i];
    const pathSeg = pathSegments[i];

    if (pathSeg === undefined) {
      return noMatch;
    }

    if (seg.startsWith(":")) {
      if (seg.endsWith("*")) {
        // Catch-all: consume the rest
        const paramName = seg.slice(1, -1);
        params[paramName] = pathSegments.slice(i).map(decodeURIComponent).join("/");
        const consumed = "/" + pathSegments.join("/");
        return { matched: true, params, consumed, rest: "" };
      }
      // Dynamic segment
      const paramName = seg.slice(1);
      params[paramName] = decodeURIComponent(pathSeg);
    } else if (seg !== pathSeg) {
      return noMatch;
    }
  }

  const consumed = "/" + pathSegments.slice(0, patternSegments.length).join("/");
  const restSegments = pathSegments.slice(patternSegments.length);
  const rest = restSegments.length > 0 ? "/" + restSegments.join("/") : "";

  return { matched: true, params, consumed, rest };
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
