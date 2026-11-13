'use client';
import { useEffect, useState } from 'react';
import { useDataSeed, freshSeed } from '../data/seeds';
import { authenticatedFetch, onAuthReset, remembered, remember } from '../data/hooks';
export async function computerRequest<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await authenticatedFetch(`/api/v2${path}`, {
    method,
    signal,
    headers: {
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Sign in again to see your computers.'
        : result.error || 'Computers are unavailable.',
    );
  return result;
}
export function useComputerData<T>(path: string) {
  const seed = useDataSeed();
  const key = `/api/v2${path}`;
  const initial = () => remembered<T>(key, seed);
  const [loaded, setLoaded] = useState({ path, seed });
  const [data, setData] = useState<T | undefined>(initial),
    [error, setError] = useState(seed?.errors?.[key] ?? ''),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    setLoaded({ path, seed });
    setData(remembered<T>(key, seed));
    setError(seed?.errors?.[key] ?? '');
    async function refresh() {
      if (busy) return;
      busy = true;
      try {
        const next = await computerRequest<T>(path, 'GET', undefined, controller.signal);
        if (!controller.signal.aborted) {
          remember(key, next);
          setData(next);
          setError('');
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Computers are unavailable.');
      } finally {
        busy = false;
      }
    }
    if (attempt || !freshSeed(seed, key)) void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    const offReset = onAuthReset(() => {
      controller.abort();
      setData(undefined);
      setError('');
      setAttempt((value) => value + 1);
    });
    return () => {
      offReset();
      controller.abort();
      clearInterval(timer);
    };
  }, [path, key, attempt, seed]);
  return {
    data: loaded.path === path && loaded.seed === seed ? data : initial(),
    error,
    refresh: () => setAttempt((value) => value + 1),
  };
}
