import { createElement } from "react";
import { matchRoutes, matchSlots } from "../router/route-matcher.js";
import { diffSegments } from "../router/segment-diff.js";
import type { RouteConfig, RouteMatch, RouteModule, SlotMatch } from "../router/types.js";
import type { RSCClientManifest, ModuleLoader } from "../shared/types.js";
import type { FlightLogger } from "../shared/logger.js";
import { RedirectError } from "./redirect.js";

// LRU cache for route matching results by pathname.
// Routes are static after build, so the same pathname always yields the same matches.
const ROUTE_MATCH_CACHE_MAX = 200;
const routeMatchCache = new Map<string, RouteMatch[]>();

/** Clear the route match cache. Exported for testing. */
export function clearRouteMatchCache(): void {
  routeMatchCache.clear();
}

function slotMapKey(s: SlotMatch): string {
  return `${s.parentSegmentKey}@${s.name}`;
}

/** Return true for errors caused by stream cancellation (client disconnect). */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    // React's renderToReadableStream throws this specific message when cancelled
    if (err.message === "The render was aborted by the server without a reason.") return true;
  }
  return false;
}

// react-server-dom-webpack types
type RenderToReadableStream = (
  model: unknown,
  webpackMap: RSCClientManifest,
  options?: { onError?: (error: unknown) => void },
) => ReadableStream;

interface RenderRSCOptions {
  url: URL;
  routes: RouteConfig[];
  clientManifest: RSCClientManifest;
  renderToReadableStream: RenderToReadableStream;
  /** If provided, only render these segment keys */
  segments?: string[];
  /** Previous URL for segment diffing — server computes which segments changed */
  previousUrl?: URL;
  /** Module loader for route components (different in dev vs prod) */
  loadModule: ModuleLoader;
  /** Performance logger (opt-in via FLIGHT_DEBUG or debug option) */
  logger?: FlightLogger;
}

export interface RenderRSCResult {
  stream: ReadableStream;
  status: number;
  /** Matched route params — used for masking PII in log output */
  params: Record<string, string>;
  /** Set when a route component called redirect() */
  redirect?: { url: string; status: 301 | 302 };
}

/**
 * Render matched routes to an RSC Flight stream.
 * The payload is a segment map that the client can merge partially.
 *
 * When `previousUrl` is provided, computes a diff and only renders changed segments.
 * The payload includes `segmentKeys` so the client can merge correctly.
 */
export async function renderRSC(opts: RenderRSCOptions): Promise<RenderRSCResult> {
  const {
    url,
    routes,
    clientManifest,
    renderToReadableStream,
    segments,
    previousUrl,
    loadModule,
    logger,
  } = opts;

  // Use cached route matching to avoid redundant tree traversals,
  // especially for the diff path where both current and previous URLs are matched.
  const cachedMatch = (pathname: string) => {
    let result = routeMatchCache.get(pathname);
    if (result) {
      // Move to end for LRU ordering
      routeMatchCache.delete(pathname);
      routeMatchCache.set(pathname, result);
      return result;
    }
    result = matchRoutes(routes, pathname);
    routeMatchCache.set(pathname, result);
    if (routeMatchCache.size > ROUTE_MATCH_CACHE_MAX) {
      const firstKey = routeMatchCache.keys().next().value;
      if (firstKey !== undefined) routeMatchCache.delete(firstKey);
    }
    return result;
  };

  logger?.time("matchRoutes");
  const matches = cachedMatch(url.pathname);
  const slotMatches = matchSlots(matches, url.searchParams);
  logger?.timeEnd("matchRoutes");

  if (matches.length === 0) {
    const payload = {
      url: url.pathname + url.search,
      segments: {} as Record<string, unknown>,
      params: {},
      status: 404,
    };
    return {
      stream: renderToReadableStream(payload, clientManifest, {
        onError: (err) => {
          if (!isAbortError(err)) console.error("[react-flight-router] RSC render error:", err);
        },
      }),
      status: 404,
      params: {},
    };
  }

  // Determine which segments to render
  let onlySegments = segments;
  let isPartial = false;

  // Per-slot render set. `undefined` = render the whole slot subtree;
  // empty Set = the slot is unchanged from the previous URL, so skip it.
  const slotRenderSets = new Map<string, Set<string> | undefined>();
  let prevSlotMatches: SlotMatch[] = [];

  if (!onlySegments && previousUrl) {
    const oldMatches = cachedMatch(previousUrl.pathname);
    if (oldMatches.length > 0) {
      prevSlotMatches = matchSlots(oldMatches, previousUrl.searchParams);
      const changed = diffSegments(oldMatches, matches);
      // A partial response is valid when EITHER the main tree has unchanged
      // ancestors OR a slot is unchanged. We bias toward partial whenever the
      // previousUrl is provided so slot deltas can ride this path too.
      if (changed.length < matches.length) {
        onlySegments = changed;
        isPartial = true;
      }
    }
  } else if (onlySegments) {
    isPartial = true;
  }

  if (isPartial) {
    for (const s of slotMatches) {
      const prev = prevSlotMatches.find(
        (p) => p.parentSegmentKey === s.parentSegmentKey && p.name === s.name,
      );
      // Skip rendering when the slot path is unchanged. Different path or
      // newly-opened slot falls through to a full render of the slot subtree.
      if (prev && prev.path === s.path) {
        slotRenderSets.set(slotMapKey(s), new Set());
      }
    }
  }

  // Convert to Set for O(1) lookups in buildSegmentMap and key merging
  const onlySegmentsSet = onlySegments ? new Set(onlySegments) : undefined;

  // Kick off the boundary-component load in parallel with segment-map build.
  // They share no inputs other than `matches`, so there's no reason to gate
  // the boundary import behind segment-map completion. Attach a swallowing
  // catch so a buildSegmentMap throw doesn't leave an unhandled rejection.
  // Avoid allocating a merged matches array on the no-slots fast path —
  // the vast majority of apps don't use slots and this runs every request.
  const allMatchesForBoundaries =
    slotMatches.length === 0 ? matches : [...matches, ...slotMatches.flatMap((s) => s.matches)];
  const boundaryComponentsPromise = buildBoundaryComponents(allMatchesForBoundaries);
  boundaryComponentsPromise.catch(() => {});

  logger?.time("buildSegmentMap");
  let segmentMap: Record<string, unknown>;
  try {
    if (slotMatches.length === 0) {
      // Fast path: no Promise.all wrapping or Object.assign copying.
      segmentMap = await buildSegmentMap(matches, onlySegmentsSet, loadModule, logger);
    } else {
      const trees = await Promise.all([
        buildSegmentMap(matches, onlySegmentsSet, loadModule, logger),
        ...slotMatches.map((s) =>
          buildSegmentMap(s.matches, slotRenderSets.get(slotMapKey(s)), loadModule, logger),
        ),
      ]);
      segmentMap = Object.assign({}, ...trees);
    }
  } catch (err) {
    logger?.timeEnd("buildSegmentMap");
    if (err instanceof RedirectError) {
      const redirectPayload = {
        url: url.pathname + url.search,
        segments: {},
        params: {},
        status: err.status,
        redirect: { url: err.destination, status: err.status },
      };
      return {
        stream: renderToReadableStream(redirectPayload, clientManifest, { onError: () => {} }),
        status: err.status,
        params: {},
        redirect: { url: err.destination, status: err.status },
      };
    }
    throw err;
  }
  logger?.timeEnd("buildSegmentMap");

  // Wait for the parallel boundary load (typically already complete by here).
  // Time entry measures wait duration only — the actual import work overlaps
  // with buildSegmentMap.
  logger?.time("buildBoundaryComponents");
  const boundaryComponents = await boundaryComponentsPromise;
  logger?.timeEnd("buildBoundaryComponents");

  const isNotFound = matches.some((m) => m.route.id === "__not-found__");
  const isError = Object.keys(segmentMap).some(
    (k) => k.endsWith("/__error__") || k === "__error__",
  );
  const status = isError ? 500 : isNotFound ? 404 : 200;

  const payload: Record<string, unknown> = {
    url: url.pathname + url.search,
    segments: segmentMap,
    params: matches[matches.length - 1]?.params ?? {},
    status,
  };

  if (boundaryComponents && Object.keys(boundaryComponents).length > 0) {
    payload.boundaryComponents = boundaryComponents;
  }

  // Include segmentKeys for partial updates so the client can merge correctly.
  // We combine unchanged match keys (not in onlySegments) with actually rendered
  // segment map keys. This ensures error segments (e.g., root/__error__) replace
  // the failed match key (e.g., root/broken) in the client's segment state.
  // Slot match keys are always included — when a slot is unchanged we want the
  // client to keep its existing segment, and when a slot disappears we just
  // omit its keys so the client drops them.
  if (isPartial) {
    const keysSet = new Set<string>();
    for (const m of matches) {
      if (!onlySegmentsSet?.has(m.segmentKey) || m.segmentKey in segmentMap) {
        keysSet.add(m.segmentKey);
      }
    }
    for (const s of slotMatches) {
      for (const m of s.matches) keysSet.add(m.segmentKey);
    }
    for (const k of Object.keys(segmentMap)) {
      keysSet.add(k);
    }
    payload.segmentKeys = Array.from(keysSet);
  }

  const matchedParams = (matches[matches.length - 1]?.params ?? {}) as Record<string, string>;

  logger?.time("rsc:serialize");
  const stream = renderToReadableStream(payload, clientManifest, {
    onError: (err) => {
      if (!isAbortError(err)) console.error("[react-flight-router] RSC render error:", err);
    },
  });
  logger?.timeEnd("rsc:serialize");

  return { stream, status, params: matchedParams };
}

/**
 * Build the segment map by loading and rendering each matched route component.
 * If `onlySegments` is provided, only re-render those specific segments.
 *
 * When a route module fails to import, the nearest ancestor with an `error`
 * handler catches it and renders the error component in place of the failed subtree.
 */
async function buildSegmentMap(
  matches: RouteMatch[],
  onlySegments: Set<string> | undefined,
  _loadModule: ModuleLoader,
  logger?: FlightLogger,
): Promise<Record<string, unknown>> {
  const segmentMap: Record<string, unknown> = {};

  // Determine which matches need loading
  const indicesToLoad: number[] = [];
  for (let i = 0; i < matches.length; i++) {
    if (onlySegments && !onlySegments.has(matches[i].segmentKey)) continue;
    indicesToLoad.push(i);
  }

  // Load and execute all route components in parallel. Components are called
  // directly (not via createElement) so that RedirectError thrown inside a
  // component propagates here instead of inside renderToReadableStream, where
  // we can no longer change the HTTP response. Each load+render measures its
  // own duration with raw performance.now(), recorded into the logger after
  // all settle — keeping depth tracking correct.
  const loadResults = await Promise.all(
    indicesToLoad.map(async (i) => {
      const match = matches[i];
      const startMs = logger ? performance.now() : 0;
      try {
        const mod = await match.route.component();
        const Component = mod.default as (props: { params: Record<string, string> }) => unknown;
        // Execute the component so RedirectError propagates out of Promise.all.
        // The result (a React element tree) is stored directly in the segment map;
        // renderToReadableStream serializes it just like it would a component element.
        const rendered = await Component({ params: match.params });
        return {
          index: i,
          rendered,
          mod,
          error: null,
          startMs,
          durationMs: logger ? performance.now() - startMs : 0,
        };
      } catch (error) {
        if (error instanceof RedirectError) throw error;
        return {
          index: i,
          rendered: null,
          mod: null,
          error,
          startMs,
          durationMs: logger ? performance.now() - startMs : 0,
        };
      }
    }),
  );

  // Record individual load durations into the logger with absolute start times
  // so the waterfall visualization shows when each load ran relative to its parent
  if (logger) {
    for (const result of loadResults) {
      logger.record(`load ${matches[result.index].route.id}`, result.startMs, result.durationMs);
    }
  }

  // Process results sequentially to preserve error handler semantics
  for (const result of loadResults) {
    const match = matches[result.index];

    if (!result.error) {
      segmentMap[match.segmentKey] = result.rendered;
    } else {
      const handlerResult = findNearestErrorHandler(matches, result.index);
      if (!handlerResult) {
        throw result.error;
      }

      const { handler, ancestorIndex } = handlerResult;
      const ancestorKey = matches[ancestorIndex].segmentKey;

      // Remove intermediate layout segments between the handler and the error
      for (let k = ancestorIndex + 1; k < result.index; k++) {
        delete segmentMap[matches[k].segmentKey];
      }

      // Load the error handler module
      let errorMod: RouteModule;
      try {
        errorMod = await handler();
      } catch (handlerError) {
        console.warn("[react-flight-router] Error handler module failed to import:", handlerError);
        throw result.error;
      }

      const ErrorComponent = errorMod.default;
      const errorKey = ancestorKey ? `${ancestorKey}/__error__` : "__error__";

      segmentMap[errorKey] = createElement(ErrorComponent as any, {
        error: result.error instanceof Error ? result.error : new Error(String(result.error)),
        params: match.params,
      });

      // Stop processing remaining matches — the error replaces the subtree
      break;
    }
  }

  return segmentMap;
}

/**
 * Walk backwards through the match chain to find the nearest ancestor
 * whose route config has an `error` handler.
 */
function findNearestErrorHandler(
  matches: RouteMatch[],
  errorIndex: number,
): { handler: () => Promise<RouteModule>; ancestorIndex: number } | null {
  for (let j = errorIndex - 1; j >= 0; j--) {
    if (matches[j].route.error) {
      return { handler: matches[j].route.error!, ancestorIndex: j };
    }
  }
  return null;
}

/**
 * Resolve loading/error boundary components from matched routes.
 *
 * For each route with a `loading` or `error` property, imports the module
 * and creates a React element. Since these are "use client" modules, the
 * RSC build replaces them with registerClientReference proxies. When
 * serialized by renderToReadableStream, they emit client component
 * references (I: instructions) — not rendered HTML — so the client can
 * instantiate them locally for use as Suspense/ErrorBoundary fallbacks.
 */
async function buildBoundaryComponents(
  matches: RouteMatch[],
): Promise<Record<string, { loading?: unknown; error?: unknown }>> {
  const result: Record<string, { loading?: unknown; error?: unknown }> = {};

  await Promise.all(
    matches
      .filter((match) => match.route.loading || match.route.error)
      .map(async (match) => {
        const boundaries: { loading?: unknown; error?: unknown } = {};

        // Load loading and error boundary modules in parallel
        const [loadingMod, errorMod] = await Promise.all([
          match.route.loading
            ? match.route.loading().catch((err: unknown) => {
                console.warn(
                  `[react-flight-router] Failed to load loading component for "${match.route.id}":`,
                  err,
                );
                return null;
              })
            : null,
          match.route.error
            ? match.route.error().catch((err: unknown) => {
                console.warn(
                  `[react-flight-router] Failed to load error boundary component for "${match.route.id}":`,
                  err,
                );
                return null;
              })
            : null,
        ]);

        if (loadingMod) boundaries.loading = createElement(loadingMod.default, {});
        if (errorMod) boundaries.error = createElement(errorMod.default, {});

        if (boundaries.loading || boundaries.error) {
          result[match.segmentKey] = boundaries;
        }
      }),
  );

  return result;
}
