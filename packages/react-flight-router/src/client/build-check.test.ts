import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, recoverFromChunkError, reloadForNewBuild } from './build-check.js';
import { RSC_BUILD_HEADER } from '../shared/constants.js';

const reload = vi.fn();

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

function response(build?: string) {
  const cancel = vi.fn().mockResolvedValue(undefined);
  return {
    cancel,
    value: {
      headers: new Headers(build ? { [RSC_BUILD_HEADER]: build } : {}),
      body: { cancel } as unknown as ReadableStream,
    },
  };
}

beforeEach(() => {
  reload.mockReset();
  vi.stubGlobal('location', { href: 'https://deploy.local/dashboard/design', reload });
  vi.stubGlobal('sessionStorage', storage());
  vi.stubGlobal('__RSC_BUILD__', 'old');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('reloadForNewBuild', () => {
  it('reloads and drops the response when the server has moved to another build', () => {
    const { value, cancel } = response('new');
    expect(reloadForNewBuild(value)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('leaves a response from the same build alone', () => {
    expect(reloadForNewBuild(response('old').value)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('does nothing when either side has no build, as in dev mode', () => {
    expect(reloadForNewBuild(response().value)).toBe(false);
    vi.stubGlobal('__RSC_BUILD__', undefined);
    expect(reloadForNewBuild(response('new').value)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('tries once per build, so stale HTML from a proxy cannot loop', () => {
    expect(reloadForNewBuild(response('new').value)).toBe(true);
    expect(reloadForNewBuild(response('new').value)).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads again for the release after that', () => {
    reloadForNewBuild(response('new').value);
    expect(reloadForNewBuild(response('newer').value)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload when it cannot remember having tried', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(reloadForNewBuild(response('new').value)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('copes with a response that has no headers', () => {
    expect(reloadForNewBuild({ body: null } as unknown as Response)).toBe(false);
  });
});

describe('recoverFromChunkError', () => {
  const chunkError = new TypeError(
    'Failed to fetch dynamically imported module: https://deploy.local/assets/a.js',
  );

  it.each([
    'Failed to fetch dynamically imported module: https://deploy.local/assets/a.js',
    'error loading dynamically imported module: https://deploy.local/assets/a.js',
    'Importing a module script failed.',
  ])('recognizes %s', (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it('leaves other errors to the error boundary', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await recoverFromChunkError(new Error('InboxProvider is required'));
    await recoverFromChunkError('Failed to fetch dynamically imported module');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when the server answers, even with an error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await recoverFromChunkError(chunkError);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('keeps the page when the server cannot be reached, and can try again later', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await recoverFromChunkError(chunkError);
    expect(reload).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await recoverFromChunkError(chunkError);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not reload the same page twice in a row, but does after a while', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await recoverFromChunkError(chunkError);
    await recoverFromChunkError(chunkError);
    expect(reload).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30_001);
    await recoverFromChunkError(chunkError);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
