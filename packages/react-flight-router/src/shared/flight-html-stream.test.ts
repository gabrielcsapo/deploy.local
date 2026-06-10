import { describe, it, expect } from "vitest";
import {
  escapeInlineScriptJSON,
  HtmlInjectionScanner,
  injectFlightPayload,
  flightPayloadScriptStream,
} from "./flight-html-stream.js";

function streamFrom(chunks: string[]): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("escapeInlineScriptJSON", () => {
  it("escapes < so </script> cannot terminate the inline script", () => {
    const out = escapeInlineScriptJSON('payload with "</script><svg onload=x>"');
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c/script>");
    // Still valid JSON that round-trips to the original
    expect(JSON.parse(out)).toBe('payload with "</script><svg onload=x>"');
  });
});

describe("HtmlInjectionScanner", () => {
  function scanned(...chunks: string[]): HtmlInjectionScanner {
    const s = new HtmlInjectionScanner();
    for (const c of chunks) s.scan(c);
    return s;
  }

  it("is safe after a completed element at body level", () => {
    expect(scanned("<!DOCTYPE html><html><head></head><body><div>x</div>").safe).toBe(true);
  });

  it("is unsafe mid-text (would split a text node and break hydration)", () => {
    expect(scanned("<html><body><p>Hello ").safe).toBe(false);
  });

  it("is unsafe after a tag deeper than body level", () => {
    // </span> closes back to depth 3 (html>body>div) — deeper than body
    expect(scanned("<html><body><div><span>a</span>").safe).toBe(false);
    // closing the div returns to body level
    expect(scanned("<html><body><div><span>a</span></div>").safe).toBe(true);
  });

  it("is unsafe before <body> opens", () => {
    expect(scanned("<!DOCTYPE html><html><head></head>").safe).toBe(false);
  });

  it("is unsafe inside a tag and ignores > inside quoted attributes", () => {
    expect(scanned('<html><body><div title="a > b"').safe).toBe(false);
    expect(scanned('<html><body><div title="a > b"></div>').safe).toBe(true);
  });

  it("treats raw-text content as unsafe until the real close tag", () => {
    const base = "<html><body>";
    expect(scanned(base + '<script>var a = "</div>";').safe).toBe(false);
    expect(scanned(base + '<script>var a = "</div>";</script>').safe).toBe(true);
    expect(scanned(base + "<style>.a{content:'<b>'}").safe).toBe(false);
    expect(scanned(base + "<style>.a{content:'<b>'}</style>").safe).toBe(true);
  });

  it("is safe after comments (Suspense boundary markers)", () => {
    expect(scanned("<html><body><!--$-->").safe).toBe(true);
    expect(scanned("<html><body><!--$").safe).toBe(false);
  });

  it("void and self-closing elements do not change depth", () => {
    expect(scanned('<html><body><img src="x.png">').safe).toBe(true);
    expect(scanned("<html><body><br/>").safe).toBe(true);
    expect(scanned('<html><body><svg><path d="M0 0"/></svg>').safe).toBe(true);
  });

  it("is unsafe after </body> (trailing chunks flush after the HTML ends)", () => {
    expect(scanned("<html><body><div></div></body>").safe).toBe(false);
  });

  it("produces identical results when fed one character at a time", () => {
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
      '<body><div class="a"><script>let x = "</di";</script><!--$--><p>hi</p></div>';
    const whole = scanned(html);
    const charwise = new HtmlInjectionScanner();
    for (const ch of html) charwise.scan(ch);
    expect(charwise.safe).toBe(whole.safe);
    expect(whole.safe).toBe(true); // </div> closed back to body level
  });
});

describe("injectFlightPayload", () => {
  it("injects flight chunks at body-level tag boundaries, not mid-text", async () => {
    const html = streamFrom([
      "<!DOCTYPE html><html><head></head><body><div>Hel",
      "lo</div>",
      "<section>more</section></body></html>",
    ]);
    const rsc = streamFrom(['1:"a"\n']);
    const out = await readAll(injectFlightPayload(html, rsc));

    // The text node "Hello" must never be split by a script
    expect(out).toContain("<div>Hello</div>");
    // Payload chunk and close sentinel are present exactly once
    expect(out.match(/__RSC_CHUNKS__/g)!.length).toBeGreaterThanOrEqual(2);
    expect(out).toContain('.push("1:\\"a\\"\\n")');
    expect(out).toContain(".push(null)");
    // Close sentinel is the final script
    expect(out.lastIndexOf(".push(null)")).toBeGreaterThan(out.lastIndexOf('.push("'));
  });

  it("escapes </script> inside flight chunks", async () => {
    const html = streamFrom(["<html><body><div>x</div></body></html>"]);
    const rsc = streamFrom(['1:"</script><b>"\n']);
    const out = await readAll(injectFlightPayload(html, rsc));
    // The raw sequence must not appear inside the inline script
    expect(out).not.toContain('.push("1:\\"</script>');
    expect(out).toContain("\\u003c/script>");
  });

  it("injects CSS links before </head>", async () => {
    const html = streamFrom(["<html><head><title>t</title></head><body></body></html>"]);
    const rsc = streamFrom([]);
    const out = await readAll(injectFlightPayload(html, rsc, { cssFiles: ["/assets/a.css"] }));
    const headEnd = out.indexOf("</head>");
    const link = out.indexOf('<link rel="stylesheet" href="/assets/a.css">');
    expect(link).toBeGreaterThan(-1);
    expect(link).toBeLessThan(headEnd);
  });

  it("emits modulepreload links for chunk URLs referenced by the payload", async () => {
    const html = streamFrom(["<html><body><div>x</div>", "</body></html>"]);
    const rsc = streamFrom(['2:I["mod-1",["/assets/counter-abc.js"],"default"]\n']);
    const out = await readAll(
      injectFlightPayload(html, rsc, {
        moduleMap: { "mod-1": "/assets/counter-abc.js", "mod-2": "/assets/unused.js" },
      }),
    );
    expect(out).toContain('<link rel="modulepreload" href="/assets/counter-abc.js">');
    expect(out).not.toContain("/assets/unused.js");
  });

  it("flushes flight chunks that arrive after the HTML stream ends", async () => {
    const encoder = new TextEncoder();
    let rscController!: ReadableStreamDefaultController;
    const rsc = new ReadableStream({
      start(c) {
        rscController = c;
      },
    });
    const html = streamFrom(["<html><body><p>shell</p></body></html>"]);
    const merged = injectFlightPayload(html, rsc);

    const resultPromise = readAll(merged);
    // Late flight chunks (e.g. a slow Suspense boundary)
    setTimeout(() => {
      rscController.enqueue(encoder.encode('9:"late"\n'));
      rscController.close();
    }, 20);

    const out = await resultPromise;
    expect(out).toContain('.push("9:\\"late\\"\\n")');
    expect(out).toContain(".push(null)");
  });
});

describe("flightPayloadScriptStream", () => {
  it("emits each chunk as a script followed by the close sentinel", async () => {
    const out = await readAll(flightPayloadScriptStream(streamFrom(['1:"a"\n', '2:"b"\n'])));
    expect(out).toContain('.push("1:\\"a\\"\\n")');
    expect(out).toContain('.push("2:\\"b\\"\\n")');
    expect(out.endsWith(".push(null)</script>")).toBe(true);
  });
});
