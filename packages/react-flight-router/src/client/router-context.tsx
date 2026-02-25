"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useTransition,
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
  const [isPending, startTransition] = useTransition();
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const isPopstateRef = useRef(false);

  // Set initial history key on mount for scroll restoration
  useEffect(() => {
    if (typeof globalThis.history !== "undefined" && !globalThis.history.state?.key) {
      const key = Math.random().toString(36).slice(2);
      globalThis.history.replaceState({ key }, "", globalThis.location.href);
    }
  }, []);

  const navigate = useCallback(
    (to: string, options?: NavigateOptions) => {
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

      setPendingUrl(to);

      startTransition(async () => {
        const response = await fetch(
          `${RSC_ENDPOINT}?url=${encodeURIComponent(targetUrl.pathname + targetUrl.search)}`,
          {
            headers: {
              [RSC_PREVIOUS_URL_HEADER]: currentPathname,
            },
          },
        );

        const rscStream = response.body!;

        // Tee the stream: one fork for React to deserialize, one to track completion.
        // createFromReadableStream resolves as soon as the model structure arrives
        // (first chunk), but lazy references (async server components) stream later.
        // Without waiting for the full stream, the transition callback resolves early,
        // causing isPending to become false before all data has arrived.
        const [parseStream, trackStream] = rscStream.tee();
        const streamDone = (async () => {
          const reader = trackStream.getReader();
          while (!(await reader.read()).done) {
            // drain
          }
        })();

        const payload = await createFromReadableStream(parseStream, { callServer });

        // Wait for the entire RSC stream to finish so the transition
        // (and isPending) stays active until all data has arrived.
        await streamDone;

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
      });
    },
    [url, createFromReadableStream, callServer, startTransition],
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
        navigationState: isPending ? "loading" : "idle",
        params,
        pendingUrl: isPending ? pendingUrl : null,
      }}
    >
      {children}
    </RouterContext.Provider>
  );
}
