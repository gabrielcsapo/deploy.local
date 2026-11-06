'use client';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { RouterProvider, useRouter } from './router-context.js';
import { RSC_BUILD_HEADER, RSC_ENDPOINT } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Minimal test helpers
// ---------------------------------------------------------------------------

function makeStream(payload: object): ReadableStream {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(JSON.stringify(payload));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A createFromReadableStream that resolves with whatever makeStream encodes. */
async function fakeCreateFromReadableStream(stream: ReadableStream): Promise<any> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const decoder = new TextDecoder();
  const text = decoder.decode(chunks[0]);
  return JSON.parse(text);
}

const noop = async () => {};

function wrapper({ children }: { children: ReactNode }) {
  return createElement(RouterProvider, {
    children,
    initialUrl: '/current',
    initialSegments: {
      root: createElement('div', null, 'root'),
      'root/page': createElement('div', null, 'page'),
    },
    initialParams: {},
    createFromReadableStream: fakeCreateFromReadableStream as any,
    callServer: noop as any,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useRouter().refresh()', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'http://localhost', pathname: '/current', search: '' });
    vi.stubGlobal('history', {
      state: { key: 'test' },
      replaceState: vi.fn(),
      pushState: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is exposed on the router context', () => {
    const { result } = renderHook(() => useRouter(), { wrapper });
    expect(typeof result.current.refresh).toBe('function');
  });

  it('fetches the RSC endpoint for the current URL', async () => {
    const segments = { root: createElement('div', null, 'refreshed') };
    const fetchMock = vi.fn().mockResolvedValue({
      body: makeStream({ segments, params: {} }),
      status: 200,
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRouter(), { wrapper });

    await act(async () => {
      await result.current.refresh();
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${RSC_ENDPOINT}?url=${encodeURIComponent('/current')}`);
  });

  it('does NOT send the X-RSC-Previous-URL header (forces a full render)', async () => {
    const segments = { root: createElement('div', null, 'refreshed') };
    const fetchMock = vi.fn().mockResolvedValue({
      body: makeStream({ segments, params: {} }),
      status: 200,
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRouter(), { wrapper });

    await act(async () => {
      await result.current.refresh();
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers?.['X-RSC-Previous-URL']).toBeUndefined();
  });

  it('does NOT push or replace browser history', async () => {
    const pushState = vi.fn();
    const replaceState = vi.fn();
    vi.stubGlobal('history', { state: { key: 'test' }, pushState, replaceState });

    const segments = { root: createElement('div', null, 'refreshed') };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        body: makeStream({ segments, params: {} }),
        status: 200,
      }),
    );

    const { result } = renderHook(() => useRouter(), { wrapper });

    await act(async () => {
      await result.current.refresh();
    });

    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('updates segments from the server response', async () => {
    const freshNode = createElement('div', { id: 'fresh' }, 'fresh content');
    const segments = { root: freshNode, 'root/page': createElement('div', null, 'fresh page') };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        body: makeStream({ segments, params: { id: '42' } }),
        status: 200,
      }),
    );

    const { result } = renderHook(() => useRouter(), { wrapper });

    await act(async () => {
      await result.current.refresh();
    });

    // params should be updated from the response
    expect(result.current.params).toEqual({ id: '42' });
  });

  it("sets navigationState to 'loading' during the fetch then back to 'idle'", async () => {
    let resolveResponse!: (v: any) => void;
    const pendingResponse = new Promise<any>((res) => {
      resolveResponse = res;
    });

    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingResponse));

    const { result } = renderHook(() => useRouter(), { wrapper });

    // Start the refresh but don't await it yet
    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });

    // State should be "loading" while fetch is in-flight
    expect(result.current.navigationState).toBe('loading');

    // Resolve the fetch
    const segments = { root: createElement('div', null, 'done') };
    await act(async () => {
      resolveResponse({ body: makeStream({ segments, params: {} }), status: 200 });
      await refreshPromise;
    });

    expect(result.current.navigationState).toBe('idle');
  });

  it('follows a redirect from the server response', async () => {
    const pushState = vi.fn();
    vi.stubGlobal('history', { state: { key: 'test' }, pushState, replaceState: vi.fn() });

    // First call: returns a redirect payload
    // Second call (for the redirect target): returns normal segments
    const segments = { root: createElement('div', null, 'redirected') };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          body: makeStream({ redirect: { url: '/new-page' } }),
          status: 200,
        })
        .mockResolvedValueOnce({
          body: makeStream({ segments, params: {} }),
          status: 200,
        }),
    );

    const { result } = renderHook(() => useRouter(), { wrapper });

    await act(async () => {
      await result.current.refresh();
    });

    // The redirect should have triggered a navigate() with replaceState
    expect(result.current.navigationState).toBe('idle');
  });

  it('stores a navigation error when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));

    const { result } = renderHook(() => useRouter(), { wrapper });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.navigationError?.message).toBe('network failure');
    expect(result.current.navigationState).toBe('idle');
  });

  it('ignores an AbortError (concurrent navigation cancelled the refresh)', async () => {
    const abortError = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    const { result } = renderHook(() => useRouter(), { wrapper });

    await act(async () => {
      await result.current.refresh();
    });

    // AbortError must not surface as a navigationError — the cancelling
    // navigation is responsible for clearing pendingUrl/navigationState.
    expect(result.current.navigationError).toBeNull();
  });

  it('includes search params in the RSC request URL', async () => {
    vi.stubGlobal('location', {
      origin: 'http://localhost',
      pathname: '/search',
      search: '?q=hello',
    });

    const segments = { root: createElement('div', null, 'results') };
    const fetchMock = vi.fn().mockResolvedValue({
      body: makeStream({ segments, params: {} }),
      status: 200,
    });
    vi.stubGlobal('fetch', fetchMock);

    // Render with a URL that includes search params
    function wrapperWithSearch({ children }: { children: ReactNode }) {
      return createElement(RouterProvider, {
        children,
        initialUrl: '/search?q=hello',
        initialSegments: {},
        initialParams: {},
        createFromReadableStream: fakeCreateFromReadableStream as any,
        callServer: noop as any,
      });
    }

    const { result } = renderHook(() => useRouter(), { wrapper: wrapperWithSearch });

    await act(async () => {
      await result.current.refresh();
    });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${RSC_ENDPOINT}?url=${encodeURIComponent('/search?q=hello')}`);
  });
});

describe('a page left open across a release', () => {
  const reload = vi.fn();
  const applied = createElement('div', null, 'from the new build');

  function serverOn(build: string) {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      body: makeStream({ segments: { root: applied }, params: {} }),
      status: 200,
      headers: new Headers({ [RSC_BUILD_HEADER]: build }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    reload.mockReset();
    vi.stubGlobal('location', {
      origin: 'http://localhost',
      pathname: '/current',
      search: '',
      href: 'http://localhost/current',
      reload,
    });
    vi.stubGlobal('history', {
      state: { key: 'test' },
      replaceState: vi.fn(),
      pushState: vi.fn(),
    });
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    });
    vi.stubGlobal('__RSC_BUILD__', 'old');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the page it was going to instead of rendering the new build', async () => {
    serverOn('new');
    const { result } = renderHook(() => useRouter(), { wrapper });
    await act(async () => {
      await result.current.navigate('/next');
    });
    expect(globalThis.history.pushState).toHaveBeenCalledWith(expect.anything(), '', '/next');
    expect(reload).toHaveBeenCalledOnce();
    expect(result.current.url).toBe('/current');
  });

  it('navigates in place while the server is on the same build', async () => {
    serverOn('old');
    const { result } = renderHook(() => useRouter(), { wrapper });
    await act(async () => {
      await result.current.navigate('/next');
    });
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.url).toBe('/next');
  });

  it('carries on in place if a reload already tried this build', async () => {
    serverOn('new');
    const { result } = renderHook(() => useRouter(), { wrapper });
    await act(async () => {
      await result.current.navigate('/next');
    });
    await act(async () => {
      await result.current.navigate('/later');
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(result.current.url).toBe('/later');
  });

  it('also checks when refreshing the current page', async () => {
    serverOn('new');
    const { result } = renderHook(() => useRouter(), { wrapper });
    await act(async () => {
      await result.current.refresh();
    });
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('popstate racing a just-applied navigation', () => {
  beforeEach(() => {
    // Unmount providers leaked by earlier tests (no auto-cleanup without
    // vitest globals) — their popstate listeners would also react to the
    // dispatched event below and pollute the fetch call count.
    cleanup();
    vi.stubGlobal('location', {
      origin: 'http://localhost',
      pathname: '/current',
      search: '',
      hash: '',
    });
    vi.stubGlobal('history', {
      state: { key: 'test' },
      replaceState: vi.fn(),
      pushState: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Regression test for the back-after-redirect flake: navigate() applies a
  // payload (setSegments + setUrl), but urlRef only synced on the next React
  // render — a macrotask. A popstate arriving before that flush (browser back
  // immediately after a redirect-follow navigation, seen on slow CI runners)
  // read the STALE url and sent it as X-RSC-Previous-URL. The server then
  // diffed the target against itself, returned an empty partial payload, and
  // the client merge dropped the leaf segment — rendering an empty page.
  // Dispatching popstate in the same microtask turn as navigate()'s
  // resolution makes the race deterministic: React's render flush is a
  // macrotask and cannot have run yet.
  it('sends the last APPLIED url as X-RSC-Previous-URL, not the last rendered one', async () => {
    const prevUrlHeaders: (string | undefined)[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      prevUrlHeaders.push((init?.headers as Record<string, string>)?.['X-RSC-Previous-URL']);
      const target = decodeURIComponent(String(url).split('url=')[1] ?? '');
      if (target === '/destination') {
        return {
          status: 200,
          body: makeStream({
            segments: { 'root/dest': 'dest-content' },
            segmentKeys: ['root', 'root/dest'],
            params: {},
          }),
        };
      }
      // Back navigation to "/" — like the real server, diff against the
      // received previous URL: an up-to-date client gets the page segment.
      return {
        status: 200,
        body: makeStream({
          segments: { 'root/page': 'page-content' },
          segmentKeys: ['root', 'root/page'],
          params: {},
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRouter(), { wrapper });

    await act(async () => {
      // The redirect-follow navigation (replace:true, like payload.redirect)…
      // navigate's public type returns void, but the implementation is async;
      // Promise.resolve lets us chain onto its completion microtask.
      const applied = Promise.resolve(result.current.navigate('/destination', { replace: true }));
      // …with a browser back in the same microtask turn it applies.
      await applied.then(() => {
        (globalThis.location as { pathname: string }).pathname = '/';
        globalThis.dispatchEvent(new PopStateEvent('popstate'));
      });
      // Let the popstate navigation's fetch + application settle.
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First nav diffs against the original page.
    expect(prevUrlHeaders[0]).toBe('/current');
    // The popstate nav must diff against the navigation that already
    // APPLIED (/destination) — not the stale pre-redirect url.
    expect(prevUrlHeaders[1]).toBe('/destination');
  });
});
