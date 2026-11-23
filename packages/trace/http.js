import { startTrace } from './index.js';

// Only an incoming, sampled W3C parent opts a request into recording.
export function startHttpSpan(parent) {
  const match =
    typeof parent === 'string' && /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(parent);
  if (!match || !(parseInt(match[3], 16) & 1) || /^0+$/.test(match[1]) || /^0+$/.test(match[2]))
    return;
  const start = performance.now();
  const epoch = BigInt(Math.round((performance.timeOrigin + start) * 1000)) * 1000n;
  const spanId = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  let phases;
  let phaseEpoch;
  const finish = (method, route, status) => ({
    traceId: match[1],
    parentSpanId: match[2],
    spanId,
    name: method + ' ' + route,
    kind: 2,
    startTimeUnixNano: String(epoch),
    endTimeUnixNano: String(epoch + BigInt(Math.round((performance.now() - start) * 1e6))),
    attributes: [
      { key: 'http.route', value: { stringValue: route } },
      { key: 'http.request.method', value: { stringValue: method } },
      { key: 'http.response.status_code', value: { intValue: String(status) } },
    ],
    status: { code: status >= 500 ? 2 : 0 },
  });
  Object.defineProperty(finish, 'phases', {
    get() {
      if (!phases) {
        phaseEpoch =
          BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n;
        phases = startTrace(`00-${match[1]}-${spanId}-${match[3]}`);
      }
      return phases;
    },
  });
  return Object.assign(finish, {
    children() {
      return (phases?.completedSpans() ?? []).map((span) => ({
        traceId: match[1],
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        kind: 1,
        startTimeUnixNano: String(phaseEpoch + BigInt(Math.round(span.startMs * 1e6))),
        endTimeUnixNano: String(
          phaseEpoch + BigInt(Math.round((span.startMs + span.durationMs) * 1e6)),
        ),
        status: { code: span.failed ? 2 : 0 },
      }));
    },
  });
}
export function httpBatch(service, spans) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [{ scope: { name: 'http.server' }, spans }],
      },
    ],
  };
}
// Delivery runs outside the request. Bound memory even during an outage.
export function bufferedExporter(send) {
  const pending = [];
  let timer,
    sending = false;
  async function flush() {
    timer = undefined;
    if (sending || !pending.length) return;
    sending = true;
    const batch = pending.splice(0, 64);
    try {
      await send(batch);
    } catch {
    } finally {
      sending = false;
      if (pending.length && !timer) timer = setTimeout(flush, 250);
    }
  }
  return (span) => {
    if (pending.length >= 128) return;
    pending.push(span);
    if (!sending && !timer) timer = setTimeout(flush, 250);
  };
}
