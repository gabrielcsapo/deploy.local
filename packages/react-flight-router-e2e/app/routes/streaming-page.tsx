import { Suspense } from "react";

async function SlowSection({ delayMs }: { delayMs: number }) {
  await new Promise((r) => setTimeout(r, delayMs));
  return (
    <p className="text-gray-700" data-testid="slow-section">
      Slow section resolved after {delayMs}ms
    </p>
  );
}

/**
 * SSR-streaming bench fixture: fast outer shell + Suspense-wrapped slow
 * inner content. The shell can stream as soon as the RSC payload's first
 * chunk arrives; the slow section streams in later. This makes the
 * difference between "buffer entire RSC then SSR" and "stream SSR with
 * RSC" visible in TTFB.
 */
export default async function StreamingPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold mb-4">Streaming Page</h1>
      <p className="text-gray-600">
        Fast shell (rendered immediately). Slow Suspense'd section streams in below.
      </p>
      <Suspense fallback={<p className="text-gray-400">Loading slow section…</p>}>
        <SlowSection delayMs={100} />
      </Suspense>
    </div>
  );
}
