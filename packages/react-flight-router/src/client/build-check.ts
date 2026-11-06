import { RSC_BUILD_HEADER } from '../shared/constants.js';

/**
 * A page left open across a release runs the old build, but the new server's responses point at the
 * new build's chunks. Rendering them leaves the page with two copies of every shared module, so
 * React contexts stop matching and pages crash. Such a page loads again instead.
 *
 * Both guards are per tab. A proxy that keeps serving old HTML must not turn into a reload loop, so
 * after one try the page carries on as it would have without this check.
 */
const BUILD_RELOAD_KEY = 'rfr:build-reload';
const CHUNK_RELOAD_KEY = 'rfr:chunk-reload';
const CHUNK_RETRY_AFTER_MS = 30_000;

function storedValue(key: string): string | null | undefined {
  try {
    return globalThis.sessionStorage.getItem(key);
  } catch {
    return undefined;
  }
}

function store(key: string, value: string): boolean {
  try {
    globalThis.sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads the current URL again when this response comes from a different build than the page. By
 * then the URL is already the one being navigated to. Returns true when the response should be
 * dropped because the page is going away.
 */
export function reloadForNewBuild(response: Pick<Response, 'headers' | 'body'>): boolean {
  const pageBuild = (globalThis as { __RSC_BUILD__?: string }).__RSC_BUILD__;
  const serverBuild = response.headers?.get(RSC_BUILD_HEADER);
  if (!pageBuild || !serverBuild || pageBuild === serverBuild) return false;
  if (storedValue(BUILD_RELOAD_KEY) === serverBuild) return false;
  if (!store(BUILD_RELOAD_KEY, serverBuild)) return false;
  response.body?.cancel().catch(() => {});
  globalThis.location.reload();
  return true;
}

// Chromium, Firefox and Safari word this failure differently.
const CHUNK_LOAD_FAILURE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i;

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_LOAD_FAILURE.test(error.message);
}

/**
 * A chunk that will not load usually belongs to a build that is gone, so one reload fixes it. Not
 * when the server cannot be reached: reloading would swap the page for the browser's error screen.
 */
export async function recoverFromChunkError(error: unknown): Promise<void> {
  if (!isChunkLoadError(error)) return;
  const url = globalThis.location.href;
  const [lastUrl, lastAt] = (storedValue(CHUNK_RELOAD_KEY) ?? '').split('\n');
  if (lastUrl === url && Date.now() - Number(lastAt) < CHUNK_RETRY_AFTER_MS) return;
  try {
    // Any answer at all means the server is there.
    await fetch(url, { method: 'HEAD', cache: 'no-store' });
  } catch {
    return;
  }
  if (store(CHUNK_RELOAD_KEY, `${url}\n${Date.now()}`)) globalThis.location.reload();
}
