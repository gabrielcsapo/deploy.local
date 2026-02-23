import type { SSRManifest } from '../shared/types.js';

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
  createFromReadableStream: CreateFromReadableStream;
  renderToReadableStream: RenderToReadableStream;
}

/**
 * Render an RSC Flight stream to HTML for the initial page load.
 *
 * 1. Tees the RSC stream: one copy for SSR, one to inline in HTML
 * 2. Deserializes the RSC stream into a React tree
 * 3. Renders that tree to HTML
 * 4. Inlines the RSC payload as script tags for client hydration
 */
export async function renderSSR(opts: SSRRenderOptions): Promise<ReadableStream> {
  const {
    rscStream,
    ssrManifest,
    clientEntryUrl,
    cssFiles,
    createFromReadableStream,
    renderToReadableStream,
  } = opts;

  // Tee the stream: one for SSR deserialization, one for inlining
  const [streamForSSR, streamForInline] = rscStream.tee();

  // Deserialize RSC stream into React element tree
  const rscPayload = await createFromReadableStream(streamForSSR, {
    serverConsumerManifest: ssrManifest,
  });

  // Build the HTML shell around the RSC content
  const bootstrapScript = generateBootstrapScript();

  // Render the RSC payload to HTML
  const htmlStream = await renderToReadableStream(rscPayload, {
    bootstrapScriptContent: bootstrapScript,
    bootstrapModules: [clientEntryUrl],
    onError: (err) => console.error('[flight-router] SSR error:', err),
  });

  // Interleave the RSC payload data into the HTML stream
  return interleaveRSCPayload(htmlStream, streamForInline, cssFiles);
}

/**
 * Bootstrap script that sets up the RSC stream receiver on the client.
 * The client hydration code reads from window.__RSC_STREAM__.
 */
function generateBootstrapScript(): string {
  return `
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
  `.replace(/\n\s+/g, '');
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
  let rscDone = false;

  // Read all RSC chunks and buffer them
  const rscReader = rscStream.getReader();
  const rscChunks: string[] = [];
  let rscReadPromise: Promise<void> | null = null;

  function startReadingRSC() {
    rscReadPromise = (async () => {
      try {
        while (true) {
          const { done, value } = await rscReader.read();
          if (done) {
            rscDone = true;
            break;
          }
          const text = decoder.decode(value, { stream: true });
          rscChunks.push(text);
        }
      } catch {
        rscDone = true;
      }
    })();
  }

  startReadingRSC();

  const htmlReader = htmlStream.getReader();

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await htmlReader.read();

      if (done) {
        // Flush remaining RSC chunks
        await rscReadPromise;
        for (const chunk of rscChunks) {
          controller.enqueue(
            encoder.encode(
              `<script>window.__RSC_PUSH__(${JSON.stringify(chunk)})</script>`,
            ),
          );
        }
        rscChunks.length = 0;
        controller.enqueue(
          encoder.encode(`<script>window.__RSC_CLOSE__()</script>`),
        );
        controller.close();
        return;
      }

      // Pass through HTML chunk
      controller.enqueue(value);

      // Flush any buffered RSC chunks as script tags
      while (rscChunks.length > 0) {
        const chunk = rscChunks.shift()!;
        controller.enqueue(
          encoder.encode(
            `<script>window.__RSC_PUSH__(${JSON.stringify(chunk)})</script>`,
          ),
        );
      }
    },
  });
}
