'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useTransition,
  useEffect,
  type ReactNode,
} from 'react';
import { RSC_ENDPOINT } from '../shared/constants.js';

interface RouterContextValue {
  url: string;
  navigate: (to: string) => void;
  segments: Record<string, ReactNode>;
  navigationState: 'idle' | 'loading';
  params: Record<string, string>;
}

const RouterContext = createContext<RouterContextValue>(null!);

// Outlet depth context - defined here (not in outlet.tsx) to ensure
// module identity is shared across all consumers. Vite's import analysis
// rewrites router-context.js imports consistently, while outlet.js may
// be loaded via __webpack_require__ at a different URL.
export interface OutletDepthContextValue {
  segmentKey: string;
  depth: number;
}

export const OutletDepthContext = createContext<OutletDepthContextValue>({
  segmentKey: '',
  depth: 0,
});

export function useRouter() {
  return useContext(RouterContext);
}

export function useNavigation() {
  const { navigationState } = useContext(RouterContext);
  return { state: navigationState };
}

export function useParams() {
  return useContext(RouterContext).params;
}

export function useLocation() {
  const { url } = useContext(RouterContext);
  return { pathname: new URL(url, globalThis.location?.origin ?? 'http://localhost').pathname };
}

interface RouterProviderProps {
  children: ReactNode;
  initialUrl: string;
  initialSegments: Record<string, ReactNode>;
  initialParams: Record<string, string>;
  createFromReadableStream: (stream: ReadableStream, opts: { callServer: CallServerFn }) => Promise<any>;
  callServer: CallServerFn;
}

type CallServerFn = (id: string, args: unknown[]) => Promise<unknown>;

export function RouterProvider({
  children,
  initialUrl,
  initialSegments,
  initialParams,
  createFromReadableStream,
  callServer,
}: RouterProviderProps) {
  const [url, setUrl] = useState(initialUrl);
  const [segments, setSegments] = useState(initialSegments);
  const [params, setParams] = useState(initialParams);
  const [isPending, startTransition] = useTransition();

  const navigate = useCallback(
    (to: string) => {
      const targetUrl = new URL(to, globalThis.location.origin);

      // Push to browser history
      globalThis.history.pushState(null, '', to);

      startTransition(async () => {
        const response = await fetch(
          `${RSC_ENDPOINT}?url=${encodeURIComponent(targetUrl.pathname)}`,
        );

        const rscStream = response.body!;
        const payload = await createFromReadableStream(rscStream, { callServer });

        // Replace segments with the new route's segments
        setSegments(payload.segments);
        setUrl(to);
        setParams(payload.params ?? {});
      });
    },
    [createFromReadableStream, callServer, startTransition],
  );

  // Handle browser back/forward
  useEffect(() => {
    const handler = () => {
      navigate(globalThis.location.pathname);
    };
    globalThis.addEventListener('popstate', handler);
    return () => globalThis.removeEventListener('popstate', handler);
  }, [navigate]);

  return (
    <RouterContext.Provider
      value={{
        url,
        navigate,
        segments,
        navigationState: isPending ? 'loading' : 'idle',
        params,
      }}
    >
      {children}
    </RouterContext.Provider>
  );
}
