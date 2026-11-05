import "./framework-runtime.js";
import { startTransition, StrictMode } from "react";
import { RouterProvider, OutletDepthContext } from "./router-context.js";
import { callServer } from "./call-server.js";
import type { RSCPayload } from "../shared/types.js";

declare global {
  interface Window {
    __RSC_STREAM__: ReadableStream;
    __RSC_MANIFEST__?: Record<string, { file: string }>;
    __SSR__?: boolean;
  }
}

// Dynamic imports for CJS modules - Vite pre-bundles them into ESM wrappers
const reactDomClient = (await import("react-dom/client")) as any;
const { createRoot, hydrateRoot } = reactDomClient;

const rscClient = (await import("react-server-dom-webpack/client.browser")) as any;
const { createFromReadableStream } = rscClient;

// Read the inlined RSC stream from the HTML.
// createFromReadableStream returns a React thenable (not a standard Promise).
// Wrapping in Promise.resolve ensures .then() returns a chainable Promise,
// which is necessary when the stream resolves synchronously (e.g., when
// compression delivers the full HTML before this module executes).
const initialPayloadPromise = Promise.resolve(
  createFromReadableStream(window.__RSC_STREAM__, {
    callServer,
  }) as Promise<RSCPayload>,
);

// Render the app once the initial RSC payload is ready
initialPayloadPromise
  .then((payload: RSCPayload) => {
    const rootKey = Object.keys(payload.segments)[0] ?? "";
    const RootSegment = payload.segments[rootKey];

    const app = (
      <StrictMode>
        <RouterProvider
          initialUrl={payload.url}
          initialSegments={payload.segments}
          initialParams={payload.params}
          initialBoundaryComponents={payload.boundaryComponents}
          createFromReadableStream={(stream: ReadableStream, opts: any) =>
            createFromReadableStream(stream, opts) as Promise<RSCPayload>
          }
          callServer={callServer}
        >
          <OutletDepthContext.Provider value={{ segmentKey: rootKey, depth: 0 }}>
            {RootSegment}
          </OutletDepthContext.Provider>
        </RouterProvider>
      </StrictMode>
    );

    startTransition(() => {
      if (window.__SSR__) {
        // SSR mode: hydrate against server-rendered HTML
        hydrateRoot(document, app);
      } else {
        // CSR mode: render into the document
        // Root layout renders <html>, <head>, <body> - React 19 handles these as singletons
        createRoot(document).render(app);
      }
    });
  })
  .catch((err) => {
    console.error("[react-flight-router] Failed to load initial RSC payload:", err);
    // Show a minimal error UI so users don't see a blank page
    document.body.innerHTML =
      '<div style="font-family:system-ui;padding:2rem"><h1>Failed to load page</h1><p>An error occurred while loading the application. Please try refreshing.</p></div>';
  });

// HMR support: revalidate when server components change
if (import.meta.hot) {
  import.meta.hot.on("react-flight-router:invalidate", () => {
    console.log("[react-flight-router] Server component changed, revalidating...");
    window.location.reload();
  });
}
