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
    vi.stubEnv('DEPLOY_TELEMETRY_URL', '');
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
});
