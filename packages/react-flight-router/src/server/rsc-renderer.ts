import { createElement } from 'react';
import { matchRoutes } from '../router/route-matcher.js';
import type { RouteConfig, RouteMatch } from '../router/types.js';
import type { RSCClientManifest, ModuleLoader } from '../shared/types.js';

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
  /** Module loader for route components (different in dev vs prod) */
  loadModule: ModuleLoader;
}

/**
 * Render matched routes to an RSC Flight stream.
 * The payload is a segment map that the client can merge partially.
 */
export async function renderRSC(opts: RenderRSCOptions): Promise<ReadableStream> {
  const { url, routes, clientManifest, renderToReadableStream, segments, loadModule } = opts;

  const matches = matchRoutes(routes, url.pathname);

  if (matches.length === 0) {
    // 404: render a simple not found element
    const payload = {
      url: url.pathname,
      segments: {} as Record<string, unknown>,
      params: {},
    };
    return renderToReadableStream(payload, clientManifest, {
      onError: (err) => console.error('[flight-router] RSC render error:', err),
    });
  }

  const segmentMap = await buildSegmentMap(matches, segments, loadModule);

  const payload = {
    url: url.pathname,
    segments: segmentMap,
    params: matches[matches.length - 1]?.params ?? {},
  };

  return renderToReadableStream(payload, clientManifest, {
    onError: (err) => console.error('[flight-router] RSC render error:', err),
  });
}

/**
 * Build the segment map by loading and rendering each matched route component.
 * If `onlySegments` is provided, only re-render those specific segments.
 */
async function buildSegmentMap(
  matches: RouteMatch[],
  onlySegments: string[] | undefined,
  loadModule: ModuleLoader,
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
