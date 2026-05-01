/**
 * Bootstrap script that sets up the RSC stream receiver on the client.
 * The client hydration code reads from window.__RSC_STREAM__.
 *
 * Used by both the production SSR renderer and the dev server to avoid
 * maintaining two copies of the same script.
 *
 * @param moduleMap - Module ID to chunk URL mapping. Defaults to empty object (dev mode).
 * @param ssr - Whether the document was server-rendered. When true, the client
 *   uses hydrateRoot; when false (CSR fallback after a shell-render failure),
 *   the client uses createRoot against an empty document.
 */
export function generateBootstrapScript(
  moduleMap: Record<string, string> = {},
  ssr: boolean = true,
): string {
  return `
    window.__SSR__ = ${ssr};
    window.__MODULE_MAP__ = ${JSON.stringify(moduleMap)};
    window.__RSC_CHUNKS__ = [];
    window.__RSC_STREAM_CONTROLLER__ = null;
    window.__RSC_STREAM__ = new ReadableStream({
      start(controller) {
        window.__RSC_STREAM_CONTROLLER__ = controller;
        window.__RSC_CHUNKS__.forEach(function(c) {
          controller.enqueue(new TextEncoder().encode(c));
        });
        delete window.__RSC_CHUNKS__;
      }
    });
    window.__RSC_PUSH__ = function(chunk) {
      if (window.__RSC_STREAM_CONTROLLER__) {
        window.__RSC_STREAM_CONTROLLER__.enqueue(new TextEncoder().encode(chunk));
      } else {
        window.__RSC_CHUNKS__.push(chunk);
      }
    };
    window.__RSC_CLOSE__ = function() {
      if (window.__RSC_STREAM_CONTROLLER__) {
        window.__RSC_STREAM_CONTROLLER__.close();
      }
    };
  `.replace(/\n\s+/g, "");
}
