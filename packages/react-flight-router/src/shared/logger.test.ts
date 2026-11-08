// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createFlightLogger } from './logger.js';
describe('request timing snapshots and failed streams', () => {
  it('snapshots phases without ending the open total timer', async () => {
    const logger = createFlightLogger({ silent: true });
    logger.time('total');
    const snapshot = logger.getEntries(false)[0].durationMs!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    logger.timeEnd('total');
    expect(logger.getEntries()[0].durationMs! - snapshot).toBeGreaterThan(15);
  });
  it('completes exactly once when a stream errors', async () => {
    const logger = createFlightLogger({ silent: true });
    logger.time('total');
    const complete = vi.fn();
    const source = new ReadableStream({
      pull() {
        throw new Error('stream failed');
      },
    });
    await expect(new Response(logger.wrapStream(source, 'RSC', complete)).text()).rejects.toThrow(
      'stream failed',
    );
    expect(complete).toHaveBeenCalledExactlyOnceWith(false);
  });
});
