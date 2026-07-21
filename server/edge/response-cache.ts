import type { OutgoingHttpHeaders } from 'node:http';
import type { DeployConfig } from '../deploy-config.ts';

export interface CachedResponse {
  status: number;
  headers: OutgoingHttpHeaders;
  body: Buffer;
  storedAt: number;
  expiresAt: number;
}

const MAX_ENTRIES = 512;
const entries = new Map<string, CachedResponse>();

export function pathMatchesCacheConfig(path: string, config?: DeployConfig['cache']): boolean {
  if (!config?.enabled || config.paths.length === 0) return false;
  return config.paths.some((pattern) =>
    pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern,
  );
}

export function getCachedResponse(key: string): CachedResponse | null {
  const cached = entries.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    entries.delete(key);
    return null;
  }
  // Map insertion order doubles as a tiny LRU.
  entries.delete(key);
  entries.set(key, cached);
  return cached;
}

export function putCachedResponse(key: string, response: CachedResponse) {
  entries.delete(key);
  entries.set(key, response);
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value as string | undefined;
    if (!oldest) break;
    entries.delete(oldest);
  }
}

export function isPublicCacheable(headers: OutgoingHttpHeaders): boolean {
  const policy = String(headers['cache-control'] || '').toLowerCase();
  const vary = String(headers.vary || '').toLowerCase();
  return (
    (policy.includes('public') || policy.includes('s-maxage=') || policy.includes('max-age=')) &&
    !policy.includes('private') &&
    !policy.includes('no-store') &&
    headers['set-cookie'] === undefined &&
    (!vary || vary === 'accept-encoding')
  );
}
