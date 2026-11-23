/** Request-scoped tracing for Web Crypto runtimes, including browsers and Node. */
const hex = (length) =>
  Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const operation = /^[a-z][a-z0-9_.-]{0,47}$/;
const maxSpans = 16;

export function startTrace(parent) {
  const incoming =
    typeof parent === 'string' && /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(parent);
  const valid =
    incoming && !/^0+$/.test(incoming[1]) && !/^0+$/.test(incoming[2]) ? incoming : null;
  const traceId = valid?.[1] ?? hex(16);
  const flags = valid?.[3] ?? '00';
  const start = performance.now();
  const now = () => Math.round((performance.now() - start) * 100) / 100;
  const spans = [];
  const context = (id) => ({
    traceparent: `00-${traceId}-${id}-${flags}`,
    async span(name, work) {
      // Dropped spans still run the operation and preserve its parent context.
      if (typeof name !== 'string' || !operation.test(name) || spans.length >= maxSpans)
        return work(context(id));
      const spanId = hex(8);
      const span = { name, spanId, parentSpanId: id, startMs: now() };
      spans.push(span);
      try {
        return await work(context(spanId));
      } catch (error) {
        span.failed = true;
        throw error;
      } finally {
        span.durationMs = Math.max(0, Math.round((now() - span.startMs) * 100) / 100);
      }
    },
  });
  // At the app server the incoming parent is the edge's upstream attempt.
  // A caller starting a trace locally owns its root span.
  const root = context(valid?.[2] ?? hex(8));
  const finished = () => spans.filter((s) => s.durationMs !== undefined);
  return {
    ...root,
    traceId,
    completedSpans: finished,
    serverTiming() {
      return finished()
        .map(
          (s) =>
            `span;desc="${s.name}";dur=${s.durationMs};start=${s.startMs};id=${s.spanId};parent=${s.parentSpanId}${s.failed ? ';failed' : ''}`,
        )
        .join(', ');
    },
    // Send to the same app's telemetry endpoint after the interaction ends.
    clientEvent(requestId, route) {
      return { type: 'spans', route, traceId, requestId, spans: finished() };
    },
  };
}
