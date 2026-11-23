// OTLP/HTTP JSON uses hexadecimal IDs and decimal uint64 Unix nanoseconds.
export function exportInteractions(events, service) {
  const spans = [];
  for (const e of events) {
    if (!Number.isFinite(e.startedAtUnixMs)) continue;
    const epoch = BigInt(Math.round(e.startedAtUnixMs * 1000)) * 1000n;
    const at = (ms) => String(epoch + BigInt(Math.round(ms * 1e6)));
    spans.push({
      traceId: e.traceId,
      spanId: e.spanId,
      name: e.name,
      kind: 1,
      startTimeUnixNano: at(0),
      endTimeUnixNano: at(e.durationMs),
      status: { code: e.outcome === 'error' ? 2 : 0 },
      events: [{ name: e.milestone, timeUnixNano: at(e.durationMs) }],
    });
    for (const child of e.spans) {
      spans.push({
        traceId: e.traceId,
        spanId: child.spanId,
        parentSpanId: child.parentSpanId,
        name: child.name,
        kind: child.name === 'http.fetch' ? 3 : 1,
        startTimeUnixNano: at(child.startMs),
        endTimeUnixNano: at(child.startMs + child.durationMs),
        attributes: child.statusCode
          ? [{ key: 'http.response.status_code', value: { intValue: String(child.statusCode) } }]
          : [],
        status: { code: child.failed ? 2 : 0 },
      });
    }
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [{ scope: { name: 'interaction-tracing' }, spans }],
      },
    ],
  };
}

// Only names supplied by the application may reach a span. Never record a dynamic path segment.
export function routeFamily(path, prefix, known) {
  if (!path.startsWith(prefix)) return;
  const part = path.slice(prefix.length).split('/')[0];
  return known.includes(part) ? part : 'other';
}

// Cover raw API calls as well as framework clients. Existing parents and non-API requests pass through.
export function observeWebFlows(tracer, nameRequest) {
  const original = window.fetch;
  const requests = new Set();
  let leaving = false;
  function flushOnExit() {
    // finish enqueues its event in a microtask before this flush.
    queueMicrotask(() => void tracer.flush(true));
  }
  function hide() {
    leaving = true;
    for (const open of requests) open.finish('page.left', 'cancelled');
    flushOnExit();
  }
  function show() {
    leaving = false;
  }
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', show);
  const wrapped = async (input, init) => {
    let url;
    try {
      url = new URL(input instanceof Request ? input.url : input, location.origin);
    } catch {
      return original.call(window, input, init);
    }
    const inherited = input instanceof Request ? input : undefined;
    const headers = new Headers(init?.headers ?? inherited?.headers);
    const method = (init?.method ?? inherited?.method ?? 'GET').toUpperCase();
    const name =
      url.origin === location.origin &&
      !headers.has('traceparent') &&
      nameRequest(
        url.pathname,
        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)
          ? method
          : 'OTHER',
      );
    if (!name) return original.call(window, input, init);
    const open = tracer.start(name);
    requests.add(open);
    try {
      const sending = open.span('http.fetch', (parent) => {
        headers.set('traceparent', parent);
        return original.call(window, input, { ...init, headers });
      });
      // Visibility listeners can issue a final write after pagehide has fired.
      if (leaving) {
        open.finish('page.left', 'cancelled');
        flushOnExit();
      }
      const response = await sending;
      open.finish('response.headers', response.status >= 400 ? 'error' : 'ok');
      return response;
    } catch (error) {
      const cancelled = (init?.signal ?? inherited?.signal)?.aborted;
      open.finish(
        cancelled ? 'request.cancelled' : 'request.failed',
        cancelled ? 'cancelled' : 'error',
      );
      throw error;
    } finally {
      requests.delete(open);
    }
  };
  window.fetch = wrapped;
  return () => {
    window.removeEventListener('pagehide', hide);
    window.removeEventListener('pageshow', show);
    if (window.fetch === wrapped) window.fetch = original;
  };
}

// Embed this static script in the signed-in document head. Configuration is read from HTML
// attributes so owner data never becomes JavaScript source.
export const navigationHandoffScript = `(() => {
  if (window !== window.top) return;
  const { traceScope: scope, tracePaths } = document.currentScript.dataset;
  const paths = (tracePaths || '').split(' ');
  const key = 'trace.navigation';
  let saved;
  try {
    const raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    saved = JSON.parse(raw);
  } catch {}
  let pending;
  function discard() {
    if (!pending) return;
    try { if (sessionStorage.getItem(key) === pending.value) sessionStorage.removeItem(key); } catch {}
    pending = undefined;
  }
  function click(event) {
    discard();
    const link = event.target instanceof Element && event.target.closest('a[href]');
    if (!link || !event.isTrusted || event.defaultPrevented || event.button !== 0 ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        link.hasAttribute('download') || (link.target && link.target !== '_self') ||
        !paths.includes(link.pathname) || link.href !== location.origin + link.pathname ||
        link.pathname === location.pathname) return;
    const value = JSON.stringify({ scope, path: link.pathname, at: performance.timeOrigin + event.timeStamp });
    try { sessionStorage.setItem(key, value); } catch { return; }
    pending = { event, value };
    setTimeout(() => { if (event.defaultPrevented && pending?.event === event) discard(); }, 0);
  }
  document.addEventListener('click', click, true);
  window.addEventListener('pagehide', () => {
    if (pending?.event.defaultPrevented) discard();
    pending = undefined;
    saved = undefined;
  });
  window[Symbol.for('interaction-tracing.navigation.start')] = (activeScope) => {
    document.removeEventListener('click', click, true);
    delete window[Symbol.for('interaction-tracing.navigation.start')];
    if (activeScope !== scope) { discard(); return; }
    if (!saved || saved.scope !== scope || !paths.includes(saved.path) ||
        location.href !== location.origin + saved.path ||
        performance.getEntriesByType('navigation')[0]?.type !== 'navigate' ||
        !document.referrer || new URL(document.referrer).origin !== location.origin) return;
    const start = saved.at - performance.timeOrigin;
    if (Number.isFinite(saved.at) && start <= 1 && performance.now() - start < 30000) return start;
  };
})();`;

export function takeNavigationStart(scope) {
  if (typeof window !== 'undefined')
    return window[Symbol.for('interaction-tracing.navigation.start')]?.(scope);
}

export function observeNavigation(tracer, nameRoute, documentStart) {
  let current;
  function finish(milestone, outcome) {
    if (!current) return;
    clearTimeout(current.timer);
    current.open.finish(milestone, outcome);
    current = undefined;
  }
  function begin(path, name, startedAt) {
    finish('navigation.replaced', 'cancelled');
    const open = tracer.start(name, startedAt);
    current = {
      path,
      open,
      timer: setTimeout(() => finish('navigation.timeout', 'cancelled'), 30000),
    };
    return open;
  }
  function click(event) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element && event.target.closest('a[href]');
    if (
      !link ||
      link.origin !== location.origin ||
      link.hasAttribute('download') ||
      (link.target && link.target !== '_self') ||
      link.pathname === location.pathname
    )
      return;
    const name = nameRoute(link.pathname);
    if (!name) return;
    begin(link.pathname, name).navigation(link.href);
  }
  if (documentStart !== undefined) {
    const name = nameRoute(location.pathname);
    if (name) begin(location.pathname, name, documentStart);
  }
  document.addEventListener('click', click, true);
  return {
    // The destination can take ownership through its first data load.
    take(path) {
      if (!current || current.path !== path) return;
      clearTimeout(current.timer);
      const open = current.open;
      current = undefined;
      return open;
    },
    committed(path) {
      if (current?.path === path) finish('route.committed', 'ok');
    },
    close() {
      document.removeEventListener('click', click, true);
      finish('navigation.left', 'cancelled');
    },
  };
}
