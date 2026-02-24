import { createElement } from "react";
import { matchRoutes } from "../router/route-matcher.js";
import { diffSegments } from "../router/segment-diff.js";
import type { RouteConfig, RouteMatch } from "../router/types.js";
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

/**
 * Render matched routes to an RSC Flight stream.
 * The payload is a segment map that the client can merge partially.
 *
 * When `previousUrl` is provided, computes a diff and only renders changed segments.
 * The payload includes `segmentKeys` so the client can merge correctly.
 */
export async function renderRSC(opts: RenderRSCOptions): Promise<ReadableStream> {
  const { url, routes, clientManifest, renderToReadableStream, segments, previousUrl, loadModule } =
    opts;

  const matches = matchRoutes(routes, url.pathname);

  if (matches.length === 0) {
    const payload = {
      url: url.pathname,
      segments: {} as Record<string, unknown>,
      params: {},
    };
    return renderToReadableStream(payload, clientManifest, {
      onError: (err) => console.error("[flight-router] RSC render error:", err),
    });
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

  const payload: Record<string, unknown> = {
    url: url.pathname,
    segments: segmentMap,
    params: matches[matches.length - 1]?.params ?? {},
  };

  // Include segmentKeys for partial updates so the client can merge correctly
  if (isPartial) {
    payload.segmentKeys = matches.map((m) => m.segmentKey);
  }

  return renderToReadableStream(payload, clientManifest, {
    onError: (err) => console.error("[flight-router] RSC render error:", err),
  });
}

/**
 * Build the segment map by loading and rendering each matched route component.
 * If `onlySegments` is provided, only re-render those specific segments.
 */
async function buildSegmentMap(
  matches: RouteMatch[],
  onlySegments: string[] | undefined,
  _loadModule: ModuleLoader,
): Promise<Record<string, unknown>> {
  const segmentMap: Record<string, unknown> = {};

  for (const match of matches) {
    // Skip segments that aren't in the partial update list
    if (onlySegments && !onlySegments.includes(match.segmentKey)) {
      continue;
    }

    const mod = await match.route.component();
    const Component = mod.default;

    segmentMap[match.segmentKey] = createElement(Component, {
      params: match.params,
    });
  }

  return segmentMap;
}
