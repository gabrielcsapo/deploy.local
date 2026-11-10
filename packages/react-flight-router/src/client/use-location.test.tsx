'use client';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { _testInternals, useLocation, type Location } from './router-context.js';

const { LocationContext } = _testInternals;

function withUrl(url: string) {
  return ({ children }: { children: ReactNode }) =>
    createElement(
      LocationContext.Provider,
      { value: { url, pendingUrl: null, navigationState: 'idle' } },
      children,
    );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useLocation()', () => {
  it('splits the router URL into pathname, search, hash and href', () => {
    vi.stubGlobal('location', { origin: 'http://localhost', hash: '' });
    const { result } = renderHook(() => useLocation(), {
      wrapper: withUrl('/projects/42?tab=logs&q=a#line-3'),
    });
    expect(result.current).toEqual({
      pathname: '/projects/42',
      search: '?tab=logs&q=a',
      hash: '#line-3',
      href: '/projects/42?tab=logs&q=a#line-3',
    } satisfies Location);
  });

  it('reads the fragment from the browser when the URL came from the server', () => {
    vi.stubGlobal('location', { origin: 'http://localhost', hash: '#settings' });
    const { result } = renderHook(() => useLocation(), { wrapper: withUrl('/dashboard?x=1') });
    expect(result.current.search).toBe('?x=1');
    expect(result.current.hash).toBe('#settings');
    expect(result.current.href).toBe('/dashboard?x=1#settings');
  });

  it('renders no fragment on the server', () => {
    let seen: Location | undefined;
    function Probe() {
      seen = useLocation();
      return null;
    }
    vi.stubGlobal('location', undefined);
    renderToString(createElement(withUrl('/a?b=1'), null, createElement(Probe)));
    expect(seen).toEqual({ pathname: '/a', search: '?b=1', hash: '', href: '/a?b=1' });
  });

  it('gives empty strings for a bare path', () => {
    vi.stubGlobal('location', { origin: 'http://localhost', hash: '' });
    const { result } = renderHook(() => useLocation(), { wrapper: withUrl('/plain?') });
    expect(result.current).toEqual({ pathname: '/plain', search: '', hash: '', href: '/plain' });
  });
});
