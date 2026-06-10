import type { SSRManifest, RSCPayload } from "../shared/types.js";
import type { ReactNode } from "react";
import type { FlightLogger } from "../shared/logger.js";
import { generateBootstrapScript } from "../shared/bootstrap-script.js";
import { injectFlightPayload, flightPayloadScriptStream } from "../shared/flight-html-stream.js";

// Types for react-server-dom-webpack/client.node
type CreateFromReadableStream = (
  stream: ReadableStream,
  options: { serverConsumerManifest: SSRManifest },
) => Promise<unknown>;

// Type for react-dom/server
type RenderToReadableStream = (
  element: unknown,
  options?: {
    bootstrapScriptContent?: string;
    bootstrapModules?: string[];
    onError?: (error: unknown) => void;
    signal?: AbortSignal;
  },
) => Promise<ReadableStream>;

interface SSRRenderOptions {
  rscStream: ReadableStream;
  ssrManifest: SSRManifest;
  clientEntryUrl: string;
  cssFiles: string[];
  /** Module ID → client chunk URL mapping for __webpack_require__ on the client */
  moduleMap: Record<string, string>;
  createFromReadableStream: CreateFromReadableStream;
  renderToReadableStream: RenderToReadableStream;
  /** SSR-built RouterProvider component */
  RouterProvider: any;
  /** SSR-built OutletDepthContext */
  OutletDepthContext: any;
  /**
   * React.createElement — passed in to ensure the same React instance is used
   * as react-dom/server. With pnpm linked packages, a top-level import from
   * "react" can resolve to a different copy than the app's react-dom, causing
   * hydration mismatches.
   */
  createElement: typeof import("react").createElement;
  /** React.StrictMode — same reason as createElement */
  StrictMode: typeof import("react").StrictMode;
  /** Performance logger (opt-in via FLIGHT_DEBUG or debug option) */
  logger?: FlightLogger;
  /**
   * Aborts the in-progress SSR render (e.g. when renderTimeoutMs fires).
   * Without it a timed-out render keeps consuming CPU and memory in the
   * background after the 504 has already been sent.
   */
  signal?: AbortSignal;
}

/**
 * Render an RSC Flight stream to HTML for the initial page load.
 *
 * 1. Tees the RSC stream: one copy for SSR, one to inline in HTML
 * 2. Deserializes the RSC stream into a React tree (with SSR-built client components)
 * 3. Wraps in RouterProvider + OutletDepthContext (matching client entry structure)
 * 4. Renders that tree to HTML
 * 5. Inlines the RSC payload as script tags for client hydration
 */
export async function renderSSR(opts: SSRRenderOptions): Promise<ReadableStream> {
  const {
    rscStream,
    ssrManifest,
    clientEntryUrl,
    cssFiles,
    moduleMap,
    createFromReadableStream,
    renderToReadableStream,
    RouterProvider,
    OutletDepthContext,
    createElement,
    StrictMode,
    logger,
    signal,
  } = opts;

  // Tee the stream: one for SSR deserialization, one for inlining
  const [streamForSSR, streamForInline] = rscStream.tee();

  // Deserialize RSC stream into the RSC payload object.
  // The payload is { url, segments, params } where segments contains React elements
  // with SSR-built client component versions (resolved via __webpack_require__).
  logger?.time("ssr:deserializeRSC");
  const payload = (await createFromReadableStream(streamForSSR, {
    serverConsumerManifest: ssrManifest,
  })) as RSCPayload;
  logger?.timeEnd("ssr:deserializeRSC");

  // Extract root segment and construct the full React tree,
  // mirroring the structure in client/entry.tsx
  const rootKey = Object.keys(payload.segments)[0] ?? "";
  const RootSegment = payload.segments[rootKey] as ReactNode;

  // Stub callServer for SSR (server actions don't run during SSR)
  const noopCallServer = () => Promise.resolve(undefined);
  // Stub createFromReadableStream for SSR (not used during initial render)
  const noopCreateFromReadableStream = () => Promise.resolve({} as any);

  const app = createElement(
    StrictMode,
    null,
    createElement(
      RouterProvider,
      {
        initialUrl: payload.url,
        initialSegments: payload.segments,
        initialParams: payload.params ?? {},
        initialBoundaryComponents: payload.boundaryComponents,
        createFromReadableStream: noopCreateFromReadableStream,
        callServer: noopCallServer,
      },
      createElement(
        OutletDepthContext.Provider,
        { value: { segmentKey: rootKey, depth: 0 } },
        RootSegment,
      ),
    ),
  );

  // Build the bootstrap script
  const bootstrapScript = generateBootstrapScript(moduleMap);

  // Render the React tree to HTML
  logger?.time("ssr:renderToHTML");
  let htmlStream: ReadableStream;
  try {
    htmlStream = await renderToReadableStream(app, {
      bootstrapScriptContent: bootstrapScript,
      bootstrapModules: [clientEntryUrl],
      onError: (err) => console.error("[react-flight-router] SSR error:", err),
      signal,
    });
  } catch {
    // SSR failed — a component threw synchronously during the initial shell
    // render. React's SSR error boundaries only fire for errors inside a
    // Suspense boundary; shell errors reject the entire render. Fall back
    // to CSR: emit a minimal HTML shell so the client renders from scratch
    // with createRoot, where route-level <ErrorBoundary> components catch
    // the error properly.
    logger?.timeEnd("ssr:renderToHTML");
    const csrBootstrap = generateBootstrapScript(moduleMap, false);
    return createCSRFallbackStream(streamForInline, clientEntryUrl, cssFiles, csrBootstrap);
  }
  logger?.timeEnd("ssr:renderToHTML");

  // Interleave the RSC payload into the HTML stream progressively, with
  // modulepreload hints for client chunks referenced by the payload.
  return injectFlightPayload(htmlStream, streamForInline, { cssFiles, moduleMap });
}

/**
 * Create a CSR fallback stream when SSR fails.
 * Sends a minimal HTML shell with the bootstrap script and RSC data inlined,
 * allowing the client to render from scratch (createRoot instead of hydrateRoot).
 */
function createCSRFallbackStream(
  rscStream: ReadableStream,
  clientEntryUrl: string,
  cssFiles: string[],
  bootstrapScript: string,
): ReadableStream {
  const encoder = new TextEncoder();
  const cssLinks = cssFiles.map((f) => `<link rel="stylesheet" href="${f}">`).join("");
  const shell =
    `<!DOCTYPE html><html><head>${cssLinks}</head><body>` +
    `<script>${bootstrapScript}</script>` +
    `<script type="module" src="${clientEntryUrl}" async=""></script>`;

  // Stream flight chunks as they arrive, then close out the document.
  const payloadReader = flightPayloadScriptStream(rscStream).getReader();

  let shellSent = false;
  let payloadDone = false;
  return new ReadableStream({
    async pull(controller) {
      if (!shellSent) {
        shellSent = true;
        controller.enqueue(encoder.encode(shell));
        return;
      }
      if (!payloadDone) {
        const { done, value } = await payloadReader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        payloadDone = true;
      }
      controller.enqueue(encoder.encode(`</body></html>`));
      controller.close();
    },
  });
}
