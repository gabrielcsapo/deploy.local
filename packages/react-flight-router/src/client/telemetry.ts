import { normalizeError } from '../shared/telemetry-error.js';

export type PrefetchSource = 'hit' | 'inflight' | 'miss';
export interface NavigationStart {
  from: string;
  start: number;
}
export interface BrowserTelemetry {
  startNavigation(): NavigationStart;
  commitNavigation(route: string, navigation: NavigationStart, prefetch: PrefetchSource): void;
  stop(): void;
}
declare global {
  interface Window {
    __RSC_BUILD__?: string;
    __DEPLOY_TELEMETRY__?: { route: string };
    __DEPLOY_METRICS__?: BrowserTelemetry;
  }
}

/** Small synchronous SHA-1 so pagehide never has to wait for a digest promise. */
export function fingerprint(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new DataView(new ArrayBuffer(length));
  bytes.forEach((value, index) => data.setUint8(index, value));
  data.setUint8(bytes.length, 128);
  data.setUint32(length - 4, bytes.length * 8);
  const hash = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const rotate = (value: number, bits: number) => (value << bits) | (value >>> (32 - bits));
  for (let offset = 0; offset < length; offset += 64) {
    const words = Array<number>(80);
    for (let i = 0; i < 80; i++)
      words[i] =
        i < 16
          ? data.getUint32(offset + i * 4)
          : rotate(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    let [a, b, c, d, e] = hash;
    for (let i = 0; i < 80; i++) {
      const f =
        i < 20
          ? (b & c) | (~b & d)
          : i < 40
            ? b ^ c ^ d
            : i < 60
              ? (b & c) | (b & d) | (c & d)
              : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const next = (rotate(a, 5) + f + e + k + words[i]) | 0;
      e = d;
      d = c;
      c = rotate(b, 30);
      b = a;
      a = next;
    }
    [a, b, c, d, e].forEach((value, index) => {
      hash[index] = (hash[index] + value) | 0;
    });
  }
  return hash.map((value) => (value >>> 0).toString(16).padStart(8, '0')).join('');
}

export function startBrowserTelemetry(initialRoute: string, build: string): BrowserTelemetry {
  let route = initialRoute;
  let events: Record<string, unknown>[] = [];
  let errorCount = 0;
  const seen = new Set<string>();
  const observers: PerformanceObserver[] = [];
  const load: Record<string, unknown> = { type: 'load', route: initialRoute };
  let loadSent = false;
  let clsValue = 0;
  let clsWindowValue = 0;
  let clsStart = 0;
  let clsLast = 0;
  const encoder = new TextEncoder();
  const body = () => JSON.stringify({ v: 1, build, events });
  function flush() {
    if (!events.length) return;
    const payload = body();
    events = [];
    try {
      if (navigator.sendBeacon?.('/__deploy/telemetry', payload)) return;
    } catch {
      /* keepalive fallback below */
    }
    try {
      void fetch('/__deploy/telemetry', {
        method: 'POST',
        body: payload,
        keepalive: true,
        credentials: 'omit',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
      }).catch(() => {});
    } catch {
      /* telemetry is best effort */
    }
  }
  function enqueue(event: Record<string, unknown>) {
    events.push(event);
    if (encoder.encode(body()).length > 16 * 1024) {
      events.pop();
      flush();
      // Multibyte errors can exceed the cap even with the character limits.
      while (
        encoder.encode(JSON.stringify({ v: 1, build, events: [event] })).length > 16 * 1024 &&
        typeof event.stack === 'string' &&
        event.stack.length
      ) {
        event.stack = event.stack.slice(0, Math.floor(event.stack.length / 2));
      }
      if (encoder.encode(JSON.stringify({ v: 1, build, events: [event] })).length <= 16 * 1024)
        events.push(event);
    }
    if (events.length >= 20) flush();
  }
  function collect(entries: PerformanceEntry[]) {
    for (const entry of entries) {
      if (entry.entryType === 'navigation')
        load.ttfb = (entry as PerformanceNavigationTiming).responseStart - entry.startTime;
      if (entry.entryType === 'paint' && entry.name === 'first-contentful-paint')
        load.fcp = entry.startTime;
      if (entry.entryType === 'largest-contentful-paint') load.lcp = entry.startTime;
      const value = entry as PerformanceEntry & {
        hadRecentInput?: boolean;
        value?: number;
        interactionId?: number;
      };
      if (entry.entryType === 'layout-shift' && !value.hadRecentInput) {
        if (
          clsLast === 0 ||
          entry.startTime - clsLast > 1000 ||
          entry.startTime - clsStart > 5000
        ) {
          clsStart = entry.startTime;
          clsWindowValue = 0;
        }
        clsLast = entry.startTime;
        clsWindowValue += value.value ?? 0;
        clsValue = Math.max(clsValue, clsWindowValue);
        load.cls = clsValue;
      }
      if (entry.entryType === 'event' && value.interactionId)
        load.inp = Math.max(Number(load.inp ?? 0), entry.duration);
    }
  }
  if (typeof PerformanceObserver !== 'undefined') {
    for (const type of [
      'navigation',
      'paint',
      'largest-contentful-paint',
      'layout-shift',
      'event',
    ]) {
      try {
        const observer = new PerformanceObserver((list) => collect(list.getEntries()));
        observer.observe({
          type,
          buffered: true,
          ...(type === 'event' ? { durationThreshold: 16 } : {}),
        });
        observers.push(observer);
      } catch {
        /* unsupported metric is omitted */
      }
    }
  }
  collect(performance.getEntriesByType?.('navigation') ?? []);
  function hide() {
    for (const observer of observers) collect(observer.takeRecords());
    if (!loadSent) {
      loadSent = true;
      enqueue(load);
    }
    flush();
  }
  const visibility = () => {
    if (document.visibilityState === 'hidden') hide();
  };
  function report(error: unknown) {
    if (errorCount >= 5) return;
    const normalized = normalizeError(error, (path) => path.replace(/^\/+/, ''));
    const key = fingerprint(normalized.fingerprintInput);
    if (seen.has(key)) return;
    seen.add(key);
    errorCount++;
    enqueue({ type: 'error', route, ...normalized.fields, fingerprint: key });
  }
  const onError = (event: ErrorEvent) => report(event.error ?? new Error(event.message));
  const onRejection = (event: PromiseRejectionEvent) => report(event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('pagehide', hide);
  document.addEventListener('visibilitychange', visibility);
  return {
    startNavigation: () => ({ from: route, start: performance.now() }),
    commitNavigation(next, navigation, prefetch) {
      route = next;
      errorCount = 0;
      seen.clear();
      enqueue({
        type: 'nav',
        route,
        from: navigation.from,
        ms: performance.now() - navigation.start,
        prefetch,
      });
    },
    stop() {
      observers.forEach((observer) => observer.disconnect());
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('pagehide', hide);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}
