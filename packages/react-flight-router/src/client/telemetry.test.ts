import { afterEach, describe, expect, it, vi } from 'vitest';
import { fingerprint, startBrowserTelemetry } from './telemetry.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('v1 browser beacon', () => {
  it('batches at 20 events and only sends masked route identities', async () => {
    const send = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: send });
    const telemetry = startBrowserTelemetry('/photos/:id', 'build', '/metrics/browser');
    try {
      for (let i = 0; i < 20; i++)
        telemetry.commitNavigation(
          '/photos/:id',
          { from: '/photos/:id', start: performance.now() - 1 },
          'inflight',
        );
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][0]).toBe('/metrics/browser');
      const body = JSON.parse(send.mock.calls[0][1]);
      expect(body).toMatchObject({ v: 1, build: 'build' });
      expect(body.events).toHaveLength(20);
      expect(body.events[0]).toMatchObject({
        type: 'nav',
        route: '/photos/:id',
        from: '/photos/:id',
        prefetch: 'inflight',
      });
    } finally {
      telemetry.stop();
    }
  });
  it('sends load metrics on pagehide, caps UTF-8 payloads and falls back to fetch', () => {
    const send = vi.fn().mockReturnValue(false);
    const fetcher = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('navigator', { sendBeacon: send });
    vi.stubGlobal('fetch', fetcher);
    const telemetry = startBrowserTelemetry('/photos/:id', 'build', '/metrics/browser');
    try {
      window.dispatchEvent(new Event('pagehide'));
      expect(send).toHaveBeenCalledOnce();
      const body = send.mock.calls[0][1];
      expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(16 * 1024);
      expect(JSON.parse(body).events[0]).toMatchObject({ type: 'load', route: '/photos/:id' });
      expect(fetcher).toHaveBeenCalledWith(
        '/metrics/browser',
        expect.objectContaining({ method: 'POST', keepalive: true, body }),
      );
    } finally {
      telemetry.stop();
    }
  });
  it('dedupes errors, limits them to five per view and uses SHA-1 fingerprints', async () => {
    const send = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: send });
    const telemetry = startBrowserTelemetry('/photos/:id', 'build', '/metrics/browser');
    try {
      for (let i = 0; i < 8; i++) {
        const error = new Error('message'.repeat(100));
        error.stack = `Error: message\n at fn${i}(https://example.test/assets/file.js?secret=x:1:2)`;
        window.dispatchEvent(new ErrorEvent('error', { error }));
        window.dispatchEvent(new ErrorEvent('error', { error }));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      window.dispatchEvent(new Event('pagehide'));
      const events = send.mock.calls
        .flatMap((call) => JSON.parse(call[1]).events)
        .filter((event) => event.type === 'error');
      expect(events).toHaveLength(5);
      expect(events[0].message).toHaveLength(500);
      expect(events[0].stack).not.toContain('example.test');
      expect(events[0].stack).not.toContain('secret');
      expect(events[0].fingerprint).toMatch(/^[a-f0-9]{40}$/);
    } finally {
      telemetry.stop();
    }
  });
});

describe('browser performance metrics', () => {
  it('uses CLS session windows, ignores recent input and takes the worst interaction', () => {
    const callbacks = new Map<string, (entries: PerformanceEntry[]) => void>();
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        type = '';
        constructor(readonly callback: (list: { getEntries(): PerformanceEntry[] }) => void) {}
        observe({ type }: { type: string }) {
          this.type = type;
          callbacks.set(type, (entries) => this.callback({ getEntries: () => entries }));
        }
        takeRecords() {
          return [];
        }
        disconnect() {}
      },
    );
    const send = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: send });
    const telemetry = startBrowserTelemetry('/', 'build', '/metrics/browser');
    const emit = (type: string, data: object) =>
      callbacks.get(type)!([{ entryType: type, ...data } as PerformanceEntry]);
    try {
      emit('navigation', { startTime: 0, responseStart: 20 });
      emit('paint', { name: 'first-contentful-paint', startTime: 30 });
      emit('largest-contentful-paint', { startTime: 40 });
      for (let i = 0; i < 11; i++)
        emit('layout-shift', { startTime: 100 + i * 500, value: 0.1, hadRecentInput: false });
      emit('layout-shift', { startTime: 5200, value: 5, hadRecentInput: true });
      emit('event', { interactionId: 0, duration: 500 });
      emit('event', { interactionId: 1, duration: 100 });
      emit('event', { interactionId: 2, duration: 200 });
      window.dispatchEvent(new Event('pagehide'));
      const load = JSON.parse(send.mock.calls[0][1]).events.find(
        (event: any) => event.type === 'load',
      );
      expect(load).toMatchObject({ ttfb: 20, fcp: 30, lcp: 40, inp: 200 });
      expect(load.cls).toBeCloseTo(1.1);
    } finally {
      telemetry.stop();
    }
  });
});

describe('browser SHA-1', () => {
  it('matches standard SHA-1 vectors', () => {
    expect(fingerprint('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(fingerprint('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(fingerprint('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
    );
  });
});
