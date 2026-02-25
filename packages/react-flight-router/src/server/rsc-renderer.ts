import { createElement } from "react";
import { matchRoutes } from "../router/route-matcher.js";
import { diffSegments } from "../router/segment-diff.js";
import type { RouteConfig, RouteMatch, RouteModule } from "../router/types.js";
import type { RSCClientManifest, ModuleLoader } from "../shared/types.js";

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
}

export interface RenderRSCResult {
  stream: ReadableStream;
  status: number;
}

/**
 * Render matched routes to an RSC Flight stream.
 * The payload is a segment map that the client can merge partially.
 *
 * When `previousUrl` is provided, computes a diff and only renders changed segments.
 * The payload includes `segmentKeys` so the client can merge correctly.
 */
export async function renderRSC(opts: RenderRSCOptions): Promise<RenderRSCResult> {
  const { url, routes, clientManifest, renderToReadableStream, segments, previousUrl, loadModule } =
    opts;

  const matches = matchRoutes(routes, url.pathname);

  if (matches.length === 0) {
    const payload = {
      url: url.pathname + url.search,
      segments: {} as Record<string, unknown>,
      params: {},
      status: 404,
    };
    return {
      stream: renderToReadableStream(payload, clientManifest, {
        onError: (err) => console.error("[react-flight-router] RSC render error:", err),
      }),
      status: 404,
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

  const segmentMap = await buildSegmentMap(matches, onlySegments, loadModule);

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

  // Include segmentKeys for partial updates so the client can merge correctly.
  // We combine unchanged match keys (not in onlySegments) with actually rendered
  // segment map keys. This ensures error segments (e.g., root/__error__) replace
  // the failed match key (e.g., root/broken) in the client's segment state.
  if (isPartial) {
    const keys: string[] = [];
    for (const m of matches) {
      if (!onlySegments?.includes(m.segmentKey) || m.segmentKey in segmentMap) {
        keys.push(m.segmentKey);
      }
    }
    for (const k of Object.keys(segmentMap)) {
      if (!keys.includes(k)) {
        keys.push(k);
      }
    }
    payload.segmentKeys = keys;
  }

  return {
    stream: renderToReadableStream(payload, clientManifest, {
      onError: (err) => console.error("[react-flight-router] RSC render error:", err),
    }),
    status,
  };
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
  onlySegments: string[] | undefined,
  _loadModule: ModuleLoader,
): Promise<Record<string, unknown>> {
  const segmentMap: Record<string, unknown> = {};

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];

    // Skip segments that aren't in the partial update list
    if (onlySegments && !onlySegments.includes(match.segmentKey)) {
      continue;
    }

    try {
      const mod = await match.route.component();
      const Component = mod.default;

      segmentMap[match.segmentKey] = createElement(Component, {
        params: match.params,
      });
    } catch (componentError) {
      const result = findNearestErrorHandler(matches, i);
      if (!result) {
        throw componentError;
      }

      const { handler, ancestorIndex } = result;
      const ancestorKey = matches[ancestorIndex].segmentKey;

      // Remove intermediate layout segments between the handler and the error
      for (let k = ancestorIndex + 1; k < i; k++) {
        delete segmentMap[matches[k].segmentKey];
      }

      // Load the error handler module
      let errorMod: RouteModule;
      try {
        errorMod = await handler();
      } catch (handlerError) {
        console.warn("[react-flight-router] Error handler module failed to import:", handlerError);
        throw componentError;
      }

      const ErrorComponent = errorMod.default;
      const errorKey = ancestorKey ? `${ancestorKey}/__error__` : "__error__";

      // Error components receive { error, params } — cast since the RouteModule
      // type doesn't include `error` in the default component props.
      segmentMap[errorKey] = createElement(ErrorComponent as any, {
        error: componentError instanceof Error ? componentError : new Error(String(componentError)),
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
