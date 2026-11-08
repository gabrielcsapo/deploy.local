// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevRequestTiming } from './request-timing.js';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('development request timing', () => {
  it('uses matcher patterns in headers and completes the existing callback once', () => {
    vi.stubEnv('RFR_TELEMETRY_URL', '');
    const complete = vi.fn();
    const response = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      statusCode: 200,
      writableFinished: true,
    });
    const timing = createDevRequestTiming(false, complete);
    try {
      const logger = timing.begin('RSC', '/photos/private', response as unknown as ServerResponse);
      timing.hooks(logger).onMatch('/photos/:id', 1.25);
      timing.headers(logger, response as unknown as ServerResponse);
      expect(response.setHeader).toHaveBeenCalledWith(
        'Server-Timing',
        expect.stringMatching(/^route;desc="\/photos\/:id", match;dur=1.25, render;dur=[0-9.]+$/),
      );
      response.emit('finish');
      response.emit('close');
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0][0]).toMatchObject({
        type: 'RSC',
        pathname: '/photos/private',
        status: 200,
      });
    } finally {
      timing.close();
    }
  });
  it('uses neutral telemetry environment settings and provides the browser bootstrap path', async () => {
    vi.stubEnv('RFR_TELEMETRY_URL', 'http://127.0.0.1:5301');
    vi.stubEnv('RFR_TELEMETRY_TOKEN', 'dev-token');
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    const response = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      statusCode: 200,
      writableFinished: true,
    });
    const timing = createDevRequestTiming();
    try {
      const logger = timing.begin('SSR', '/photos/private', response as unknown as ServerResponse);
      expect(timing.hooks(logger)).toMatchObject({
        telemetry: true,
        beaconPath: '/__rfr/telemetry',
      });
      timing.hooks(logger).onMatch('/photos/:id', 1);
      response.emit('finish');
      process.emit('beforeExit', 0);
      await Promise.resolve();
      expect(fetcher).toHaveBeenCalledWith(
        'http://127.0.0.1:5301/v1/server',
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer dev-token' }),
        }),
      );
    } finally {
      timing.close();
    }
  });
});
