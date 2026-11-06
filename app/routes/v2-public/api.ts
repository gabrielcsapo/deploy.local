import { authenticatedFetch } from '../dashboard/v2/data/hooks';

export async function api<T = any>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await authenticatedFetch(
    path,
    body === undefined
      ? {}
      : {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error || 'Request failed. Try again.'), {
      status: response.status,
    });
  return result;
}
