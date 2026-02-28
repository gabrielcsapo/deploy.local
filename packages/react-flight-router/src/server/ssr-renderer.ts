import type { SSRManifest, RSCPayload } from "../shared/types.js";
import type { ReactNode } from "react";
import type { FlightLogger } from "../shared/logger.js";
import { generateBootstrapScript } from "../shared/bootstrap-script.js";

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
  const htmlStream = await renderToReadableStream(app, {
    bootstrapScriptContent: bootstrapScript,
    bootstrapModules: [clientEntryUrl],
    onError: (err) => console.error("[react-flight-router] SSR error:", err),
  });
  logger?.timeEnd("ssr:renderToHTML");

  // Interleave the RSC payload data into the HTML stream
  return interleaveRSCPayload(htmlStream, streamForInline, cssFiles);
}

/**
 * Merge the HTML stream and RSC stream so that RSC data is inlined as
 * script tags in the HTML. This allows zero-waterfall hydration.
 */
function interleaveRSCPayload(
  htmlStream: ReadableStream,
  rscStream: ReadableStream,
  cssFiles: string[],
): ReadableStream {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // Read all RSC chunks and buffer them
  const rscReader = rscStream.getReader();
  const rscChunks: string[] = [];
  let rscReadPromise: Promise<void> | null = null;

  function startReadingRSC() {
    rscReadPromise = (async () => {
      try {
        while (true) {
          const { done, value } = await rscReader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          rscChunks.push(text);
        }
      } catch (err) {
        // RSC stream errored, proceed with whatever chunks we have
        console.error("[react-flight-router] RSC stream error during SSR:", err);
      }
    })();
  }

  startReadingRSC();

  const htmlReader = htmlStream.getReader();
  let cssInjected = false;

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await htmlReader.read();

      if (done) {
        // HTML stream is complete. The bootstrap script (which defines
        // window.__RSC_PUSH__) was injected by React at the end of <body>.
        // Now emit all RSC data as script tags AFTER the HTML.
        // Browsers execute scripts after </html> perfectly fine.
        await rscReadPromise;
        for (const chunk of rscChunks) {
          controller.enqueue(
            encoder.encode(`<script>window.__RSC_PUSH__(${JSON.stringify(chunk)})</script>`),
          );
        }
        rscChunks.length = 0;
        controller.enqueue(encoder.encode(`<script>window.__RSC_CLOSE__()</script>`));
        controller.close();
        return;
      }

      // Inject CSS <link> tags before </head> in the HTML stream
      if (!cssInjected && cssFiles.length > 0) {
        const html = decoder.decode(value, { stream: true });
        const headCloseIndex = html.indexOf("</head>");
        if (headCloseIndex !== -1) {
          const cssLinks = cssFiles.map((f) => `<link rel="stylesheet" href="${f}">`).join("");
          const modified = html.slice(0, headCloseIndex) + cssLinks + html.slice(headCloseIndex);
          controller.enqueue(encoder.encode(modified));
          cssInjected = true;
          return;
        }
      }

      // Pass through HTML chunk as-is.
      // Do NOT inject RSC scripts between HTML chunks — chunk boundaries
      // can fall inside elements like <style>, where <script> tags won't execute.
      controller.enqueue(value);
    },
  });
}
