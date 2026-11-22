const id = (n) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const ms = (n) => Math.round(n * 100) / 100;
export function interactionTracer(options) {
  const key = 'trace.pending.' + options.scope;
  let pending = [];
  let closed = false,
    sending = false;
  try {
    const saved = JSON.parse(options.storage?.getItem(key) || '[]');
    if (Array.isArray(saved)) pending = saved.slice(-16);
  } catch {}
  function persist() {
    try {
      if (pending.length) options.storage?.setItem(key, JSON.stringify(pending));
      else options.storage?.removeItem(key);
    } catch {}
  }
  let timer;
  async function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (closed || sending) return;
    sending = true;
    try {
      while (!closed && pending.length) {
        const batch = pending.slice(0, options.sendBatch ? 16 : 1);
        if (!(await (options.sendBatch ? options.sendBatch(batch) : options.send(batch[0])))) break;
        pending = pending.filter((event) => !batch.includes(event));
        if (!closed) persist();
      }
    } catch {
      /* Offline. A reconnect or the next interaction retries. */
    } finally {
      sending = false;
    }
  }
  return {
    flush,
    close(clear = true) {
      closed = true;
      clearTimeout(timer);
      if (clear) {
        pending = [];
        persist();
      }
    },
    start(name, startedAt = performance.now()) {
      const traceId = id(16),
        spanId = id(8),
        start = startedAt;
      const startedAtUnixMs = performance.timeOrigin + start;
      const spans = [];
      let detachNavigation;
      let ended = false,
        count = 0;
      const context = '00-' + traceId + '-' + spanId + '-01';
      async function span(name, work) {
        if (ended || closed || count >= 16) return work(context);
        count++;
        const child = id(8),
          at = performance.now();
        const entry = {
          name,
          spanId: child,
          parentSpanId: spanId,
          startMs: ms(at - start),
          durationMs: 0,
        };
        try {
          const result = await work('00-' + traceId + '-' + child + '-01');
          if (result instanceof Response) {
            entry.statusCode = result.status;
            if (result.status >= 400) entry.failed = true;
          }
          return result;
        } catch (error) {
          entry.failed = true;
          throw error;
        } finally {
          entry.durationMs = ms(performance.now() - at);
          if (!ended) spans.push(entry);
        }
      }
      return {
        traceId,
        traceparent: context,
        span,
        navigation(to) {
          const target = new URL(to, options.origin).href;
          detachNavigation?.();
          const listener = ({ detail }) => {
            if (
              ended ||
              closed ||
              !detail?.to ||
              new URL(detail.to, options.origin).href !== target
            )
              return;
            detachNavigation();
            void span('router.commit', (parent) => {
              detail.traceparent = parent;
              return new Promise((resolve) => {
                detail.onCommit = resolve;
              });
            });
          };
          window.addEventListener('rfr:navigation-context', listener);
          detachNavigation = () => window.removeEventListener('rfr:navigation-context', listener);
        },
        fetch(input, init = {}, request = fetch) {
          if (
            ended ||
            closed ||
            new URL(input, options.origin).origin !== options.origin ||
            new Headers(init.headers).has('traceparent')
          )
            return request(input, init);
          return span('http.fetch', (parent) => {
            const headers = new Headers(init.headers);
            headers.set('traceparent', parent);
            return request(input, { ...init, headers });
          });
        },
        finish(milestone, outcome = 'ok') {
          if (ended || closed) return;
          ended = true;
          detachNavigation?.();
          const event = {
            traceId,
            spanId,
            name,
            outcome,
            milestone,
            platform: 'web',
            startedAtUnixMs,
            durationMs: ms(performance.now() - start),
            spans,
          };
          queueMicrotask(() => {
            if (closed) return;
            pending.push(event);
            if (pending.length > 16) pending.shift();
            persist();
            if (options.sendBatch) timer ??= setTimeout(flush, 500);
            else void flush();
          });
        },
      };
    },
  };
}
