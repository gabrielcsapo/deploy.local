import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let cache: typeof import('./prefetch-cache.js');
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  cache = await import('./prefetch-cache.js');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function deferredResponse() {
  let resolve!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  fetchMock.mockReturnValueOnce(promise);
  return { resolve, reject };
}

const signal = () => new AbortController().signal;

describe('prefetch consumption', () => {
  it('joins a pending prefetch and gives its body to only one navigation', async () => {
    const pending = deferredResponse();
    cache.prefetchRSC('/photos?sort=new#top');
    cache.prefetchRSC('/photos?sort=new');
    const first = cache.takePrefetch('/photos', '?sort=new', signal());
    const second = cache.takePrefetch('/photos', '?sort=new', signal());
    pending.resolve(new Response('flight'));
    const responses = await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await responses[0]!.text()).toBe('flight');
    expect(responses[1]).toBeNull();
    expect(cache.consumePrefetch('/photos', '?sort=new')).toBeNull();
  });

  it('aborts the navigation wait while preserving the prefetch for a later navigation', async () => {
    const pending = deferredResponse();
    cache.prefetchRSC('/photos');
    const controller = new AbortController();
    const waiting = cache.takePrefetch('/photos', '', controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    const next = cache.takePrefetch('/photos', '', signal());
    pending.resolve(new Response('next'));
    expect(await (await next)!.text()).toBe('next');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not consume a completed response for an already aborted navigation', async () => {
    const pending = deferredResponse();
    cache.prefetchRSC('/photos');
    pending.resolve(new Response('cached'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const controller = new AbortController();
    controller.abort();
    await expect(cache.takePrefetch('/photos', '', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(await (await cache.takePrefetch('/photos', '', signal()))!.text()).toBe('cached');
  });

  it('falls back after a failed speculative request and permits a retry', async () => {
    const pending = deferredResponse();
    cache.prefetchRSC('/photos');
    const waiting = cache.takePrefetch('/photos', '', signal());
    pending.reject(new Error('offline'));
    expect(await waiting).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response('retry'));
    cache.prefetchRSC('/photos');
    expect(await (await cache.takePrefetch('/photos', '', signal()))!.text()).toBe('retry');
  });

  it('does not reuse HTTP errors or a different query', async () => {
    fetchMock.mockResolvedValueOnce(new Response('error', { status: 500 }));
    cache.prefetchRSC('/photos?sort=old');
    expect(await cache.takePrefetch('/photos', '?sort=new', signal())).toBeNull();
    expect(await cache.takePrefetch('/photos', '?sort=old', signal())).toBeNull();
  });

  it('expires completed responses and cancels their unread bodies', async () => {
    let now = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const response = new Response('stale');
    const cancel = vi.spyOn(response.body!, 'cancel');
    fetchMock.mockResolvedValueOnce(response);
    cache.prefetchRSC('/photos');
    // Flush the fetch/cache promise chain without consuming the response.
    await new Promise((resolve) => setTimeout(resolve, 0));
    now += 30_001;
    expect(await cache.takePrefetch('/photos', '', signal())).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
