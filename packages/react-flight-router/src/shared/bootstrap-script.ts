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
  // Inline flight-chunk scripts use the array protocol
  //   (self.__RSC_CHUNKS__||(self.__RSC_CHUNKS__=[])).push(chunk)
  // and may execute before OR after this bootstrap runs. Chunks pushed
  // before are drained into the stream controller here; afterwards `push`
  // is rebound to feed the controller directly. `push(null)` closes the
  // stream. See shared/flight-html-stream.ts for the emit side.
  return `
    window.__SSR__ = ${ssr};
    window.__MODULE_MAP__ = ${JSON.stringify(moduleMap)};
    var __rscQ = self.__RSC_CHUNKS__ = self.__RSC_CHUNKS__ || [];
    window.__RSC_STREAM__ = new ReadableStream({
      start(controller) {
        var enc = new TextEncoder();
        var closed = false;
        function feed(c) {
          if (closed) return;
          if (c === null) { closed = true; controller.close(); }
          else controller.enqueue(enc.encode(c));
        }
        for (var i = 0; i < __rscQ.length; i++) feed(__rscQ[i]);
        __rscQ.length = 0;
        __rscQ.push = function(c) { feed(c); return 0; };
      }
    });
    window.__RSC_PUSH__ = function(c) { __rscQ.push(c); };
    window.__RSC_CLOSE__ = function() { __rscQ.push(null); };
  `.replace(/\n\s+/g, "");
}
