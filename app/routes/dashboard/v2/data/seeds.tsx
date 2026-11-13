'use client';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useRouter } from 'react-flight-router/client';
import { getAuth } from '../../../../auth.ts';

export type DataSeed = {
  owner: string;
  at: number;
  origin?: string;
  timeZone?: string;
  cursor?: number;
  coordinatorName?: string;
  errors?: Record<string, string>;
  data: Record<string, unknown>;
};
const Seeds = createContext<DataSeed | undefined>(undefined);
export const SEED_FRESH_MS = 10_000;
export function DataSeeds({
  seed,
  children,
  part,
}: {
  seed?: DataSeed;
  children: ReactNode;
  part?: 'page' | 'tab' | 'shell';
}) {
  const parent = useContext(Seeds);
  const router = useRouter();
  const inDashboard =
    !router || /^\/dashboard(?:\/|$)/.test(new URL(router.url, 'http://localhost').pathname);
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const effective = seed ?? parent;
  const [invalidated, setInvalidated] = useState<DataSeed | null>(null);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === 'deploy-sh-auth' || event.key === null) setInvalidated(effective ?? null);
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [effective]);
  return (
    <Seeds.Provider
      value={
        inDashboard &&
        invalidated !== effective &&
        (!hydrated || !getAuth()?.username || getAuth()?.username === effective?.owner)
          ? effective
          : undefined
      }
    >
      {seed && part && (
        <script
          type="application/json"
          data-project-seed={part}
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              paths: [...Object.keys(seed.data), ...Object.keys(seed.errors ?? {})],
              at: seed.at,
            }).replaceAll('<', '\\u003c'),
          }}
        />
      )}
      {children}
    </Seeds.Provider>
  );
}
export const useDataSeed = () => useContext(Seeds);
export const resourceKey = (path: string) => path.replace(/%2e/gi, '.');
export function freshSeed(seed: DataSeed | undefined, path: string) {
  return (
    !!seed &&
    (Object.hasOwn(seed.data, resourceKey(path)) ||
      Object.hasOwn(seed.errors ?? {}, resourceKey(path))) &&
    Date.now() - seed.at < SEED_FRESH_MS
  );
}

/** First reads in form-specific loaders use the same freshness/identity rules as useData. */
export async function readSeeded<T>(
  seed: DataSeed | undefined,
  path: string,
  read: () => Promise<T>,
): Promise<T> {
  if (!freshSeed(seed, path)) return read();
  const key = resourceKey(path);
  if (seed?.errors?.[key]) throw new Error(seed.errors[key]);
  return seed!.data[key] as T;
}
