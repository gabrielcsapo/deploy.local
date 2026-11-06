import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { prefetchRSC } from './prefetch-cache.js';
import { prepareStylesheets } from './route-css.js';
import { RouterProvider, useRouter } from './router-context.js';

const order = ['/root.css', '/a.css', '/b.css'];
function link(href: string) {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].find(
    (l) => l.getAttribute('href') === href,
  )!;
}
function active() {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
    .filter((l) => l.media !== 'not all')
    .map((l) => l.getAttribute('href'));
}
function installed(href: string) {
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  Object.defineProperty(l, 'sheet', { value: {} });
  document.head.appendChild(l);
}
beforeEach(() => {
  // No HTTP server or browser: simulate resource load/error events explicitly.
  (window as any).happyDOM.settings.disableCSSFileLoading = true;
  (window as any).happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
  vi.spyOn(HTMLLinkElement.prototype, 'dispatchEvent').mockImplementation(() => true);
  document.head.innerHTML = '';
  installed('/root.css');
  installed('/a.css');
  installed('/application.css');
});
afterEach(() => {
  cleanup();
  document.head.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('stages without changing the current page, then removes old sheets and preserves SSR order', async () => {
  const pending = prepareStylesheets(['/root.css', '/b.css'], order);
  expect(active()).toEqual(['/root.css', '/a.css', '/application.css']);
  expect(link('/b.css').media).toBe('not all');
  link('/b.css').onload!(new Event('load'));
  const next = await pending;
  expect(active()).toContain('/a.css');
  next.commit();
  expect(active()).toEqual(['/root.css', '/application.css', '/b.css']);
  const back = prepareStylesheets(['/root.css', '/a.css'], order);
  link('/a.css').onload!(new Event('load'));
  (await back).commit();
  expect(active()).toEqual(['/root.css', '/application.css', '/a.css']);
});
it('staged sheets take their final place, so loaded sheets never move', async () => {
  document.head.innerHTML = '';
  installed('/root.css');
  installed('/b.css');
  const kept = [link('/root.css'), link('/b.css')];
  const pending = prepareStylesheets(['/root.css', '/a.css', '/b.css'], order);
  const staged = [...document.head.querySelectorAll('link')].map((item) =>
    item.getAttribute('href'),
  );
  expect(staged).toEqual(['/root.css', '/a.css', '/b.css']);
  link('/a.css').onload!(new Event('load'));
  const inserted = vi.spyOn(document.head, 'insertBefore');
  const appended = vi.spyOn(document.head, 'appendChild');
  (await pending).commit();
  expect(inserted).not.toHaveBeenCalled();
  expect(appended).not.toHaveBeenCalled();
  expect(link('/root.css')).toBe(kept[0]);
  expect(link('/b.css')).toBe(kept[1]);
  expect(link('/a.css').media).toBe('');
});
it('discards failed and abandoned preparations without removing current sheets', async () => {
  const pending = prepareStylesheets(['/root.css', '/b.css'], order);
  const rejection = expect(pending).rejects.toThrow('Failed to load stylesheet');
  link('/b.css').onerror!(new Event('error'));
  await rejection;
  expect(link('/b.css')).toBeUndefined();
  expect(active()).toContain('/a.css');
  const abandoned = prepareStylesheets(['/root.css', '/b.css'], order);
  link('/b.css').onload!(new Event('load'));
  (await abandoned).dispose();
  expect(active()).toContain('/a.css');
  expect(link('/b.css')).toBeUndefined();
});
it('times out a stalled stylesheet without showing the unstyled destination', async () => {
  vi.useFakeTimers();
  try {
    const pending = prepareStylesheets(['/b.css'], order);
    const rejection = expect(pending).rejects.toThrow('Stylesheet timed out');
    await vi.advanceTimersByTimeAsync(15000);
    await rejection;
    expect(active()).toContain('/a.css');
    expect(link('/b.css')).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

function wrapper({ children }: { children: ReactNode }) {
  return createElement(RouterProvider, {
    children,
    initialUrl: '/a',
    initialSegments: { root: 'a' },
    initialParams: {},
    cssOrder: order,
    createFromReadableStream: async (stream) => JSON.parse(await new Response(stream).text()),
    callServer: async () => undefined,
  });
}
function response(page: string) {
  return {
    body: new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              segments: { root: page },
              params: {},
              cssFiles: ['/root.css', `/${page}.css`],
              cssOrder: order,
            }),
          ),
        );
        c.close();
      },
    }),
  };
}
it('gates navigate and refresh on CSS and discards stale navigations', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(response('b'))),
  );
  const { result } = renderHook(() => useRouter(), { wrapper });
  await act(async () => {
    result.current.navigate('/b');
  });
  expect(result.current.segments.root).toBe('a');
  expect(result.current.pendingUrl).toBe('/b');
  Object.defineProperty(link('/b.css'), 'sheet', { value: {} });
  await act(async () => {
    link('/b.css').onload!(new Event('load'));
  });
  expect(result.current.segments.root).toBe('b');
  expect(active()).not.toContain('/a.css');
  (fetch as any).mockImplementation(() => Promise.resolve(response('a')));
  let refresh!: Promise<void>;
  await act(async () => {
    refresh = result.current.refresh();
  });
  expect(result.current.segments.root).toBe('b');
  Object.defineProperty(link('/a.css'), 'sheet', { value: {} });
  await act(async () => {
    link('/a.css').onload!(new Event('load'));
    await refresh;
  });
  expect(result.current.segments.root).toBe('a');
  (fetch as any).mockImplementation(() => Promise.resolve(response('b')));
  await act(async () => {
    result.current.navigate('/b');
  });
  const stale = link('/b.css');
  (fetch as any).mockImplementation(() => Promise.resolve(response('a')));
  await act(async () => {
    result.current.navigate('/a');
  });
  await act(async () => {
    stale.onload!(new Event('load'));
  });
  expect(result.current.segments.root).toBe('a');
  expect(link('/b.css')).toBeUndefined();
});

it('waits for CSS after consuming a prefetched response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ...response('b'), ok: true }));
  await act(async () => {
    prefetchRSC('/b?prefetched');
  });
  const { result } = renderHook(() => useRouter(), { wrapper });
  await act(async () => {
    result.current.navigate('/b?prefetched');
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.current.segments.root).toBe('a');
  await act(async () => {
    link('/b.css').onload!(new Event('load'));
  });
  expect(result.current.segments.root).toBe('b');
});
