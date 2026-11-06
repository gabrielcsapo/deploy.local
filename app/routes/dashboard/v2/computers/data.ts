'use client';
import { useEffect, useState } from 'react';
import { authenticatedFetch, onAuthReset } from '../data/hooks';
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
  const [data, setData] = useState<T>(),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    setData(undefined);
    async function refresh() {
      if (busy) return;
      busy = true;
      try {
        const next = await computerRequest<T>(path, 'GET', undefined, controller.signal);
        if (!controller.signal.aborted) {
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
    void refresh();
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
  }, [path, attempt]);
  return { data, error, refresh: () => setAttempt((value) => value + 1) };
}
