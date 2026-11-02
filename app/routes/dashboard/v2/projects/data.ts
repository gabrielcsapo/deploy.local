import { useEffect, useState } from 'react';
import { authenticatedFetch, remember, remembered } from '../data/hooks';
import type { Project } from '../../../../../shared/v2/contracts';
export { authenticatedFetch };
export async function request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authenticatedFetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}
/** Data for a path; a path read before shows its last answer at once while it refreshes. */
export function useData<T>(path: string | undefined) {
  const [data, setData] = useState<T | undefined>(() => (path ? remembered<T>(path) : undefined));
  const [error, setError] = useState('');
  const [version, refresh] = useState(0);
  useEffect(() => {
    setData(path ? remembered<T>(path) : undefined);
    setError('');
    if (!path) return;
    const controller = new AbortController();
    request<T>(path, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        remember(path, value);
        setData(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [path, version]);
  return { data, error, refresh: () => refresh((n) => n + 1) };
}
export type Work = {
  id: string;
  title: string;
  state?: string;
  status?: string;
  taskId?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type Overview = {
  project: Project;
  repository: null | {
    defaultBranch?: string;
    head?: string;
    status: string;
    source?: { url?: string; path?: string; location?: string };
    clonePath?: string;
  };
  repositoryError: boolean;
  tasks: Work[];
  issues: Work[];
  pulls: Work[];
  apps: Array<Project['apps'][number] & { computer?: string; memoryLimit?: string }>;
};
