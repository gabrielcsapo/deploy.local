// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelemetryReporter, serverTiming, telemetryError } from './telemetry.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const record = (t = 1) => ({
  t,
  kind: 'page' as const,
  route: '/photos/:id',
  status: 200,
  ms: 12,
  phases: { match: 1 },
  build: 'build',
  aborted: false,
});
describe('v1 server telemetry', () => {
  it('escapes route strings and rounds durations without emitting query strings', () => {
    expect(serverTiming('/a"\\b', 1.234, 5.678)).toBe(
      'route;desc="/a\\"\\\\b", match;dur=1.23, render;dur=5.68',
    );
    expect(serverTiming('action:save', undefined, undefined, 2.345)).toBe(
      'route;desc="action:save", action;dur=2.35',
    );
  });
  it('does nothing without the opt-in URL', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(createTelemetryReporter({})).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('flushes at 100 records or 5 seconds with v1 auth, only one request in flight', async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((yes) => {
            resolve = yes;
          }),
      )
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    const reporter = createTelemetryReporter({
      DEPLOY_TELEMETRY_URL: 'http://127.0.0.1:5301/',
      DEPLOY_TELEMETRY_TOKEN: 'secret',
    })!;
    try {
      for (let i = 0; i < 100; i++) reporter.add(record(i));
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:5301/v1/server');
      expect(fetcher.mock.calls[0][1].headers.authorization).toBe('Bearer secret');
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
        v: 1,
        records: Array.from({ length: 100 }, (_, i) => record(i)),
      });
      for (let i = 0; i < 1001; i++) reporter.add(record(i));
      expect(reporter.dropped).toBe(1);
      expect(fetcher).toHaveBeenCalledOnce();
      resolve(new Response(null, { status: 204 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetcher.mock.calls[1][1].body).records[0].t).toBe(1);
      reporter.add(record());
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      reporter.close();
    }
  });
  it('drops failed batches, limits warnings, and aborts after 2 seconds', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher = vi.fn(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(new Error('timeout'))),
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const reporter = createTelemetryReporter({ DEPLOY_TELEMETRY_URL: 'http://127.0.0.1:5301' })!;
    try {
      reporter.add(record());
      await vi.advanceTimersByTimeAsync(7000);
      expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
      reporter.add(record());
      await vi.advanceTimersByTimeAsync(5000);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      reporter.close();
    }
  });
  it('caps error text, relativizes paths and fingerprints normalized frames', () => {
    const error = new Error('x'.repeat(600));
    error.stack = `Error: ${error.message}\n    at handler (${process.cwd()}/src/page.ts:12:34)\n    at /other/root/file.ts:4:5`;
    const result = telemetryError(error, '/photos/:id', 'rsc', 123);
    expect(result).toMatchObject({
      t: 123,
      kind: 'error',
      route: '/photos/:id',
      where: 'rsc',
      name: 'Error',
    });
    expect(result.message).toHaveLength(500);
    expect(result.stack).not.toContain(process.cwd());
    expect(result.stack).not.toContain('at /other/root');
    expect(result.fingerprint).toMatch(/^[a-f0-9]{40}$/);
    const other = new Error('different message');
    other.stack =
      'Error: different message\n    at handler (' +
      process.cwd() +
      '/src/page.ts:90:21)\n    at /other/root/file.ts:8:9';
    expect(telemetryError(other, '/', 'rsc', 0).fingerprint).toBe(result.fingerprint);
  });
});
