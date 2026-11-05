/**
 * Shared helpers for inlining an RSC Flight payload into a streaming HTML
 * response. Used by the production SSR renderer and the dev server so both
 * share one (correct) implementation.
 *
 * Inline chunk scripts use a self-sufficient array protocol:
 *
 *   (self.__RSC_CHUNKS__||(self.__RSC_CHUNKS__=[])).push("<chunk>")
 *
 * so they can execute *before* the bootstrap script runs. The bootstrap
 * script (see bootstrap-script.ts) drains the array into the stream
 * controller and replaces `push` so later inline scripts feed the stream
 * directly. `push(null)` closes the stream.
 *
 * Flight chunks are flushed into the HTML stream progressively, at points
 * where the HTML parser state allows a <script> element (tracked by
 * HtmlInjectionScanner) — instead of buffering the entire payload and
 * emitting it after </html>. This unblocks hydration: the client receives
 * payload bytes as soon as they exist rather than after the slowest
 * Suspense boundary resolves, and the server no longer holds the whole
 * payload in memory per request.
 */

/**
 * Serialize a flight chunk for embedding inside an inline <script>.
 * JSON.stringify does NOT escape `<`, so a chunk containing the literal
 * `</script>` (e.g. user-generated content rendered into a prop) would
 * terminate the script element early — breaking the document and opening
 * an HTML-injection vector. `<` is identical after JS string parsing.
 */
export function escapeInlineScriptJSON(text: string): string {
  return JSON.stringify(text).replace(/</g, "\\u003c");
}

function flightChunkScript(text: string): string {
  return `<script>(self.__RSC_CHUNKS__||(self.__RSC_CHUNKS__=[])).push(${escapeInlineScriptJSON(text)})</script>`;
}

const FLIGHT_CLOSE_SCRIPT = `<script>(self.__RSC_CHUNKS__||(self.__RSC_CHUNKS__=[])).push(null)</script>`;

/** Elements whose content the HTML parser treats as raw text — a <script>
 * tag inserted inside them would be text, not an executed script. */
const RAW_TEXT_TAGS = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);

/** HTML void elements — no closing tag, never change nesting depth. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const enum ScanState {
  Text,
  TagOpen, // just saw "<"
  Tag, // inside a tag, scanning for ">"
  Bang, // saw "<!", deciding comment vs doctype
  BangDash, // saw "<!-"
  Comment, // inside <!-- ... -->
  RawText, // inside <script>/<style>/... content
}

/**
 * Minimal incremental HTML scanner that tracks whether the byte position at
 * the end of the consumed text is a safe place to insert a <script> element
 * into HTML that React will hydrate.
 *
 * A position is safe only when ALL of these hold:
 *
 * 1. Not inside a tag, comment, or raw-text element content (parser safety —
 *    a <script> there would be text or break the surrounding markup).
 * 2. Immediately after a completed tag (`>`). React splits large flush
 *    segments into ~2KB chunks, so a chunk boundary can fall mid-text-node;
 *    inserting an element there splits one text node into two and hydration
 *    fails with a text mismatch (React error #418).
 * 3. At body level (element depth === <body>'s depth). React's hydration
 *    only skips unexpected <script> elements when they are direct children
 *    of the hydration root or a singleton (html/head/body) — see
 *    canHydrateInstance's `inRootOrSingleton` branch in react-dom. A script
 *    injected deeper (e.g. between two `</div>`s mid-shell) still breaks
 *    hydration. Between React's flushes the stream sits at body level, so
 *    in practice this admits exactly the inter-flush boundaries.
 *
 * React escapes `<`/`>` in text and attribute values, so any we see are
 * structural markup. The failure mode is conservative: if a position is
 * never judged safe, flight chunks are simply flushed after the HTML stream
 * ends — exactly the previous (fully buffered) behavior.
 */
export class HtmlInjectionScanner {
  private state: ScanState = ScanState.Text;
  private quote = ""; // active attribute quote char inside a tag
  private tagName = ""; // accumulates while reading a tag name
  private readingName = false;
  private isClosing = false;
  private isBang = false; // current "tag" is <!DOCTYPE …> — not an element
  private prevTagChar = ""; // last significant char inside the tag (for "/>")
  private rawCloseTarget = ""; // "</script" etc.
  private rawMatchPos = 0;
  private commentDashes = 0;
  private lastWasTagClose = false; // last consumed char completed a tag (">")
  private depth = 0; // open element count (html=1, body=2, …)
  private bodyDepth = -1; // depth while <body> is the innermost open element

  /** Handle a completed opening/closing tag and update depth tracking. */
  private completeTag(selfClosing: boolean): void {
    if (this.isBang) return;
    if (this.isClosing) {
      if (this.depth > 0) this.depth--;
      if (this.tagName === "body") this.bodyDepth = -1;
    } else if (!selfClosing && !VOID_TAGS.has(this.tagName)) {
      this.depth++;
      if (this.tagName === "body") this.bodyDepth = this.depth;
    }
  }

  /** Consume the next decoded HTML text chunk. */
  scan(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      // Reset on every char; the tag/comment close cases set it back.
      this.lastWasTagClose = false;
      switch (this.state) {
        case ScanState.Text:
          if (c === "<") {
            this.state = ScanState.TagOpen;
          }
          break;

        case ScanState.TagOpen:
          if (c === "!") {
            this.state = ScanState.Bang;
          } else if (c === "/") {
            this.state = ScanState.Tag;
            this.isClosing = true;
            this.isBang = false;
            this.tagName = "";
            this.readingName = true;
            this.quote = "";
            this.prevTagChar = "";
          } else {
            this.state = ScanState.Tag;
            this.isClosing = false;
            this.isBang = false;
            this.tagName = /[a-zA-Z]/.test(c) ? c.toLowerCase() : "";
            this.readingName = /[a-zA-Z]/.test(c);
            this.quote = "";
            this.prevTagChar = c;
          }
          break;

        case ScanState.Bang:
          if (c === "-") {
            this.state = ScanState.BangDash;
          } else {
            // <!DOCTYPE …> — scan to ">" but don't count it as an element
            this.state = ScanState.Tag;
            this.isClosing = false;
            this.isBang = true;
            this.tagName = "";
            this.readingName = false;
            this.quote = "";
            this.prevTagChar = "";
          }
          break;

        case ScanState.BangDash:
          if (c === "-") {
            this.state = ScanState.Comment;
            this.commentDashes = 0;
          } else {
            this.state = ScanState.Tag;
            this.isBang = true;
            this.quote = "";
            this.prevTagChar = "";
          }
          break;

        case ScanState.Comment:
          if (c === "-") {
            this.commentDashes++;
          } else if (c === ">" && this.commentDashes >= 2) {
            this.state = ScanState.Text;
            this.lastWasTagClose = true;
          } else {
            this.commentDashes = 0;
          }
          break;

        case ScanState.Tag:
          if (this.quote) {
            if (c === this.quote) this.quote = "";
          } else if (c === '"' || c === "'") {
            this.quote = c;
            this.readingName = false;
            this.prevTagChar = c;
          } else if (c === ">") {
            this.completeTag(this.prevTagChar === "/");
            if (!this.isClosing && !this.isBang && RAW_TEXT_TAGS.has(this.tagName)) {
              this.state = ScanState.RawText;
              this.rawCloseTarget = "</" + this.tagName;
              this.rawMatchPos = 0;
            } else {
              this.state = ScanState.Text;
              this.lastWasTagClose = true;
            }
            this.readingName = false;
          } else {
            if (this.readingName) {
              if (/[a-zA-Z0-9-]/.test(c)) {
                this.tagName += c.toLowerCase();
              } else {
                this.readingName = false;
              }
            }
            this.prevTagChar = c;
          }
          break;

        case ScanState.RawText: {
          const lower = c.toLowerCase();
          if (this.rawMatchPos === this.rawCloseTarget.length) {
            // Matched "</script" — next char decides if the tag really closes
            if (c === ">" || c === "/" || c === " " || c === "\n" || c === "\t") {
              // Re-scan the close tag tail as a normal closing tag
              this.state = ScanState.Tag;
              this.isClosing = true;
              this.isBang = false;
              this.tagName = this.rawCloseTarget.slice(2);
              this.readingName = false;
              this.quote = "";
              this.prevTagChar = "";
              if (c === ">") {
                this.completeTag(false);
                this.state = ScanState.Text;
                this.lastWasTagClose = true;
              }
            } else {
              this.rawMatchPos = c === "<" ? 1 : 0;
            }
          } else if (lower === this.rawCloseTarget[this.rawMatchPos]) {
            this.rawMatchPos++;
          } else {
            this.rawMatchPos = c === "<" ? 1 : 0;
          }
          break;
        }
      }
    }
  }

  /** True when a <script> element may be inserted at the current position. */
  get safe(): boolean {
    return (
      this.state === ScanState.Text &&
      this.lastWasTagClose &&
      this.bodyDepth !== -1 &&
      this.depth === this.bodyDepth
    );
  }
}

export interface InjectFlightPayloadOptions {
  /** CSS hrefs to inject as <link rel="stylesheet"> before </head>. */
  cssFiles?: string[];
  /**
   * Client chunk URLs (module ID → chunk URL). When provided, chunk URLs
   * referenced by the flight payload are announced via
   * <link rel="modulepreload"> as soon as they appear in the stream, so the
   * browser fetches client component code in parallel with the HTML instead
   * of discovering it after hydration starts.
   */
  moduleMap?: Record<string, string>;
  /** Called when the flight stream errors (already logged by default). */
  onFlightError?: (err: unknown) => void;
}

/**
 * Merge an HTML stream and an RSC Flight stream into one HTML response.
 *
 * HTML chunks pass through unbuffered. Flight chunks are wrapped in inline
 * scripts and flushed at the first parser-safe insertion point after they
 * arrive; anything still pending when the HTML ends is flushed after </html>
 * (browsers execute trailing scripts fine), followed by the close sentinel.
 */
export function injectFlightPayload(
  htmlStream: ReadableStream,
  rscStream: ReadableStream,
  opts: InjectFlightPayloadOptions = {},
): ReadableStream {
  const encoder = new TextEncoder();
  const htmlDecoder = new TextDecoder();
  const rscDecoder = new TextDecoder();
  const scanner = new HtmlInjectionScanner();

  // Flight scripts (and modulepreload links) ready to be injected.
  const pending: string[] = [];
  let rscDone = false;
  // Held in an object property (not a let) so TS control-flow analysis
  // doesn't narrow it to null across the closure boundary.
  const waiter: { notify: (() => void) | null } = { notify: null };

  // Chunk URLs not yet announced via modulepreload. Substring-scanning the
  // flight text against the known URL set avoids parsing the flight wire
  // format; a URL split across two chunks is missed (harmless — the browser
  // just discovers that chunk at hydration time like before).
  const unannounced = new Set<string>(opts.moduleMap ? Object.values(opts.moduleMap) : []);

  const rscReader = rscStream.getReader();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await rscReader.read();
        if (done) break;
        const text = rscDecoder.decode(value, { stream: true });
        if (unannounced.size > 0) {
          for (const url of unannounced) {
            if (text.includes(url)) {
              pending.push(`<link rel="modulepreload" href="${url}">`);
              unannounced.delete(url);
            }
          }
        }
        pending.push(flightChunkScript(text));
        waiter.notify?.();
      }
    } catch (err) {
      console.error("[react-flight-router] RSC stream error during SSR:", err);
      opts.onFlightError?.(err);
    } finally {
      rscDone = true;
      waiter.notify?.();
    }
  })();

  const htmlReader = htmlStream.getReader();
  let htmlDone = false;
  let cssInjected = !opts.cssFiles || opts.cssFiles.length === 0;

  return new ReadableStream({
    async pull(controller) {
      if (!htmlDone) {
        const { done, value } = await htmlReader.read();
        if (!done) {
          let text = htmlDecoder.decode(value, { stream: true });
          if (!cssInjected) {
            const headCloseIndex = text.indexOf("</head>");
            if (headCloseIndex !== -1) {
              const cssLinks = opts
                .cssFiles!.map((f) => `<link rel="stylesheet" href="${f}">`)
                .join("");
              text = text.slice(0, headCloseIndex) + cssLinks + text.slice(headCloseIndex);
              cssInjected = true;
            }
          }
          scanner.scan(text);
          controller.enqueue(encoder.encode(text));
          if (scanner.safe && pending.length > 0) {
            controller.enqueue(encoder.encode(pending.join("")));
            pending.length = 0;
          }
          return;
        }
        htmlDone = true;
      }

      // HTML complete — drain remaining flight chunks as they arrive.
      while (true) {
        if (pending.length > 0) {
          controller.enqueue(encoder.encode(pending.join("")));
          pending.length = 0;
          return;
        }
        if (rscDone) break;
        await new Promise<void>((r) => {
          waiter.notify = r;
        });
        waiter.notify = null;
      }
      controller.enqueue(encoder.encode(FLIGHT_CLOSE_SCRIPT));
      controller.close();
    },
  });
}

/**
 * Stream a flight payload as inline scripts with no HTML stream to merge
 * into (CSR fallback after a shell-render failure). Chunks are emitted as
 * they arrive rather than buffered.
 */
export function flightPayloadScriptStream(rscStream: ReadableStream): ReadableStream {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = rscStream.getReader();
  let closed = false;

  return new ReadableStream({
    async pull(controller) {
      if (closed) {
        controller.close();
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          closed = true;
          controller.enqueue(encoder.encode(FLIGHT_CLOSE_SCRIPT));
          return;
        }
        controller.enqueue(
          encoder.encode(flightChunkScript(decoder.decode(value, { stream: true }))),
        );
      } catch {
        // Flight stream errored — close what we have so the client can
        // attempt to render from the chunks that did arrive.
        closed = true;
        controller.enqueue(encoder.encode(FLIGHT_CLOSE_SCRIPT));
      }
    },
  });
}
