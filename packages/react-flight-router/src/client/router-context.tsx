"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { RSC_ENDPOINT, RSC_PREVIOUS_URL_HEADER } from "../shared/constants.js";

export interface NavigateOptions {
  /** Use replaceState instead of pushState */
  replace?: boolean;
}

interface RouterContextValue {
  url: string;
  navigate: (to: string, options?: NavigateOptions) => void;
  segments: Record<string, ReactNode>;
  navigationState: "idle" | "loading";
  params: Record<string, string>;
  /** Target URL during an active navigation, null when idle */
  pendingUrl: string | null;
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
  segmentKey: "",
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
  return { pathname: new URL(url, globalThis.location?.origin ?? "http://localhost").pathname };
}

interface RouterProviderProps {
  children: ReactNode;
  initialUrl: string;
  initialSegments: Record<string, ReactNode>;
  initialParams: Record<string, string>;
  createFromReadableStream: (
    stream: ReadableStream,
    opts: { callServer: CallServerFn },
  ) => Promise<any>;
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
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const isPopstateRef = useRef(false);
  const navigationIdRef = useRef(0);

  // Set initial history key on mount for scroll restoration
  useEffect(() => {
    if (typeof globalThis.history !== "undefined" && !globalThis.history.state?.key) {
      const key = Math.random().toString(36).slice(2);
      globalThis.history.replaceState({ key }, "", globalThis.location.href);
    }
  }, []);

  const navigate = useCallback(
    async (to: string, options?: NavigateOptions) => {
      const targetUrl = new URL(to, globalThis.location.origin);
      const currentPathname = new URL(url, globalThis.location.origin).pathname;
      const isPopstate = isPopstateRef.current;
      isPopstateRef.current = false;

      // Only push/replace state for programmatic navigation (not popstate)
      if (!isPopstate) {
        const key = Math.random().toString(36).slice(2);
        if (options?.replace) {
          globalThis.history.replaceState({ key }, "", to);
        } else {
          globalThis.history.pushState({ key }, "", to);
        }
      }

      // Track navigation ID so stale navigations are discarded
      const navId = ++navigationIdRef.current;

      setPendingUrl(to);

      const response = await fetch(
        `${RSC_ENDPOINT}?url=${encodeURIComponent(targetUrl.pathname + targetUrl.search)}`,
        {
          headers: {
            [RSC_PREVIOUS_URL_HEADER]: currentPathname,
          },
        },
      );

      // createFromReadableStream resolves as soon as the model structure arrives
      // (first chunk). Segments may contain lazy references for async server
      // components inside Suspense boundaries — React will show the Suspense
      // fallbacks immediately and replace them as data streams in.
      const payload = await createFromReadableStream(response.body!, { callServer });

      // Discard if a newer navigation started while we were fetching
      if (navId !== navigationIdRef.current) return;

      if (payload.segmentKeys) {
        // Partial update: merge new segments with existing, remove stale keys
        setSegments((prev) => {
          const next: Record<string, ReactNode> = {};
          for (const key of payload.segmentKeys) {
            next[key] = payload.segments[key] ?? prev[key];
          }
          return next;
        });
      } else {
        // Full update: replace all segments
        setSegments(payload.segments);
      }
      setUrl(to);
      setParams(payload.params ?? {});
      setPendingUrl(null);
    },
    [url, createFromReadableStream, callServer],
  );

  // Handle browser back/forward
  useEffect(() => {
    const handler = () => {
      isPopstateRef.current = true;
      navigate(globalThis.location.pathname + globalThis.location.search);
    };
    globalThis.addEventListener("popstate", handler);
    return () => globalThis.removeEventListener("popstate", handler);
  }, [navigate]);

  return (
    <RouterContext.Provider
      value={{
        url,
        navigate,
        segments,
        navigationState: pendingUrl != null ? "loading" : "idle",
        params,
        pendingUrl,
      }}
    >
      {children}
    </RouterContext.Provider>
  );
}
