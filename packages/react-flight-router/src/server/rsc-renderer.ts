import { createElement } from "react";
import { matchRoutes } from "../router/route-matcher.js";
import { diffSegments } from "../router/segment-diff.js";
import type { RouteConfig, RouteMatch, RouteModule } from "../router/types.js";
import type { RSCClientManifest, ModuleLoader } from "../shared/types.js";
import type { FlightLogger } from "../shared/logger.js";

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

  logger?.time("matchRoutes");
  const matches = matchRoutes(routes, url.pathname);
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

  if (!onlySegments && previousUrl) {
    const oldMatches = matchRoutes(routes, previousUrl.pathname);
    if (oldMatches.length > 0) {
      const changed = diffSegments(oldMatches, matches);
      if (changed.length > 0 && changed.length < matches.length) {
        onlySegments = changed;
        isPartial = true;
      }
    }
  } else if (onlySegments) {
    isPartial = true;
  }

  // Convert to Set for O(1) lookups in buildSegmentMap and key merging
  const onlySegmentsSet = onlySegments ? new Set(onlySegments) : undefined;

  logger?.time("buildSegmentMap");
  const segmentMap = await buildSegmentMap(matches, onlySegmentsSet, loadModule, logger);
  logger?.timeEnd("buildSegmentMap");

  // Resolve loading/error boundary components from route config.
  // Included in every response (not just full renders) because the set of
  // matched routes can change between pages even during partial updates
  // (e.g., navigating from Home to a page with loading/error boundaries).
  const boundaryComponents = await buildBoundaryComponents(matches);

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
  if (isPartial) {
    const keysSet = new Set<string>();
    for (const m of matches) {
      if (!onlySegmentsSet?.has(m.segmentKey) || m.segmentKey in segmentMap) {
        keysSet.add(m.segmentKey);
      }
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

  // Load all modules in parallel. Each load measures its own duration
  // with raw performance.now(), then we record them into the logger
  // after all settle — keeping depth tracking correct.
  const loadResults = await Promise.all(
    indicesToLoad.map(async (i) => {
      const match = matches[i];
      const startMs = logger ? performance.now() : 0;
      try {
        const mod = await match.route.component();
        return {
          index: i,
          mod,
          error: null,
          startMs,
          durationMs: logger ? performance.now() - startMs : 0,
        };
      } catch (error) {
        return {
          index: i,
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
      const Component = result.mod!.default;
      segmentMap[match.segmentKey] = createElement(Component, {
        params: match.params,
      });
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

  for (const match of matches) {
    const boundaries: { loading?: unknown; error?: unknown } = {};

    if (match.route.loading) {
      try {
        const mod = await match.route.loading();
        boundaries.loading = createElement(mod.default, {});
      } catch (err) {
        console.warn(
          `[react-flight-router] Failed to load loading component for "${match.route.id}":`,
          err,
        );
      }
    }

    if (match.route.error) {
      try {
        const mod = await match.route.error();
        boundaries.error = createElement(mod.default, {});
      } catch (err) {
        console.warn(
          `[react-flight-router] Failed to load error boundary component for "${match.route.id}":`,
          err,
        );
      }
    }

    if (boundaries.loading || boundaries.error) {
      result[match.segmentKey] = boundaries;
    }
  }

  return result;
}
