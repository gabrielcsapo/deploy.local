"use client";

import {
  createContext,
  createElement,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { RSC_ENDPOINT, RSC_PREVIOUS_URL_HEADER } from "../shared/constants.js";
import { SuspenseSentinel } from "./suspense-sentinel.js";
import { consumePrefetch } from "./prefetch-cache.js";
import { fastPathname } from "./fast-pathname.js";

// Cached element to avoid creating a new one on every navigation
const suspenseSentinelElement = createElement(SuspenseSentinel);

export interface NavigateOptions {
  /** Use replaceState instead of pushState */
  replace?: boolean;
}

type BoundaryComponentMap = Record<string, { loading?: ReactNode; error?: ReactNode }>;

interface RouterContextValue {
  url: string;
  navigate: (to: string, options?: NavigateOptions) => void;
  /** Re-fetch the current page via the RSC endpoint without a hard browser reload */
  refresh: () => Promise<void>;
  segments: Record<string, ReactNode>;
  navigationState: "idle" | "loading";
  params: Record<string, string>;
  /** Target URL during an active navigation, null when idle */
  pendingUrl: string | null;
  /** Loading and error boundary components from route config, keyed by segment key */
  boundaryComponents: BoundaryComponentMap;
  /** Navigation error to be thrown by Outlet for ErrorBoundary to catch */
  navigationError: Error | null;
}

// === Split contexts for fine-grained subscription ===
//
// The router state has three independent slices:
//   - actions: navigate / refresh callbacks (rarely change)
//   - location: url / pendingUrl / navigationState (change on URL transitions)
//   - segments: segments / params / boundaryComponents / navigationError
//                 (change on every render result)
//
// Splitting them means a component that only cares about location (e.g. a
// <Link>) doesn't re-render when segments change during navigation. The
// public useRouter() merges all three for backward compatibility.

interface NavigationActionsValue {
  navigate: (to: string, options?: NavigateOptions) => void;
  refresh: () => Promise<void>;
}

interface LocationValue {
  url: string;
  pendingUrl: string | null;
  navigationState: "idle" | "loading";
}

interface SegmentsValue {
  segments: Record<string, ReactNode>;
  params: Record<string, string>;
  boundaryComponents: BoundaryComponentMap;
  navigationError: Error | null;
  /**
   * parentSegmentKey → child segmentKey, precomputed once per segments
   * change. Replaces the per-Outlet-render `Object.keys(segments).find(...)`
   * scan: every Outlet now resolves its child via a single property lookup
   * instead of an O(N) scan with string slicing on each render.
   */
  childKeyByParent: Record<string, string>;
}

/**
 * Build the parentSegmentKey → child segmentKey map from a segments record.
 * The "parent" of a key like "root/posts/123" is "root/posts" (everything
 * before the last "/"); the parent of a top-level key like "root" is "".
 *
 * If multiple children exist for the same parent (shouldn't happen with
 * well-formed route configs, but defensive), the first one wins — matching
 * the prior `Object.keys(...).find(...)` semantic.
 */
function buildChildKeyByParent(segments: Record<string, ReactNode>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const key in segments) {
    const lastSlash = key.lastIndexOf("/");
    const parentKey = lastSlash === -1 ? "" : key.slice(0, lastSlash);
    if (!(parentKey in map)) map[parentKey] = key;
  }
  return map;
}

const NavigationActionsContext = createContext<NavigationActionsValue>(null!);
const LocationContext = createContext<LocationValue>(null!);
const SegmentsContext = createContext<SegmentsValue>(null!);

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

// === Internal hooks (used by Link, Outlet, etc. for narrow subscription) ===

/** @internal */
export function useNavigationActions(): NavigationActionsValue {
  return useContext(NavigationActionsContext);
}

/** @internal */
export function useLocationState(): LocationValue {
  return useContext(LocationContext);
}

/** @internal */
export function useSegmentsState(): SegmentsValue {
  return useContext(SegmentsContext);
}

// === Public hooks ===

/**
 * Returns the merged router state. Components that consume this re-render
 * whenever any router slice changes (URL, segments, navigation actions, etc.).
 * For finer-grained subscription, use the targeted hooks: `useNavigation`,
 * `useLocation`, `useParams`.
 */
export function useRouter(): RouterContextValue {
  const actions = useContext(NavigationActionsContext);
  const location = useContext(LocationContext);
  const segments = useContext(SegmentsContext);
  return useMemo<RouterContextValue>(() => {
    // Preserve the legacy "null when no provider above" behavior so callers
    // that defensively use `useRouter()?.url` (e.g. <Link>) keep working.
    if (!actions || !location || !segments) return null!;
    return { ...actions, ...location, ...segments };
  }, [actions, location, segments]);
}

export function useNavigation() {
  const { navigationState } = useContext(LocationContext);
  return { state: navigationState };
}

/**
 * Internal hook into the split context implementation. Exposed for the
 * perf regression test in router-context.test.tsx — do not import from
 * application code.
 *
 * @internal
 */
export const _testInternals = {
  NavigationActionsContext,
  LocationContext,
  SegmentsContext,
};

export function useParams() {
  return useContext(SegmentsContext).params;
}

export function useLocation() {
  const { url } = useContext(LocationContext);
  return useMemo(
    () => ({ pathname: fastPathname(url, globalThis.location?.origin ?? "http://localhost") }),
    [url],
  );
}

interface RouterProviderProps {
  children: ReactNode;
  initialUrl: string;
  initialSegments: Record<string, ReactNode>;
  initialParams: Record<string, string>;
  initialBoundaryComponents?: BoundaryComponentMap;
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
  initialBoundaryComponents,
  createFromReadableStream,
  callServer,
}: RouterProviderProps) {
  const [url, setUrl] = useState(initialUrl);
  const [segments, setSegments] = useState(initialSegments);
  const [params, setParams] = useState(initialParams);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [boundaryComponents, setBoundaryComponents] = useState<BoundaryComponentMap>(
    initialBoundaryComponents ?? {},
  );
  const [navigationError, setNavigationError] = useState<Error | null>(null);
  const urlRef = useRef(url);
  urlRef.current = url;
  const isPopstateRef = useRef(false);
  const navigationIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const boundaryComponentsRef = useRef(boundaryComponents);
  boundaryComponentsRef.current = boundaryComponents;

  // Set initial history key on mount for scroll restoration.
  // Also handles SSR redirects: if the server rendered the redirect destination
  // but the browser URL still shows the original URL, update it here so the
  // URL bar reflects the canonical location without an extra round trip.
  useEffect(() => {
    if (typeof globalThis.history !== "undefined" && !globalThis.history.state?.key) {
      const key = Math.random().toString(36).slice(2);
      const browserPath = globalThis.location.pathname + globalThis.location.search;
      const targetUrl = initialUrl !== browserPath ? initialUrl : globalThis.location.href;
      globalThis.history.replaceState({ key }, "", targetUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = useCallback(
    async (to: string, options?: NavigateOptions) => {
      const targetUrl = new URL(to, globalThis.location.origin);
      const currentLocator = new URL(urlRef.current, globalThis.location.origin);
      // Send pathname + search so the server can diff parallel-route slots,
      // which live in `?@<slot>=<path>` search params.
      const currentPathname = currentLocator.pathname + currentLocator.search;
      const isPopstate = isPopstateRef.current;
      isPopstateRef.current = false;

      // Clear any previous navigation error
      setNavigationError(null);

      // Only push/replace state for programmatic navigation (not popstate)
      if (!isPopstate) {
        const key = Math.random().toString(36).slice(2);
        if (options?.replace) {
          globalThis.history.replaceState({ key }, "", to);
        } else {
          globalThis.history.pushState({ key }, "", to);
        }
      }

      // Abort any in-flight navigation fetch
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Track navigation ID so stale navigations are discarded
      const navId = ++navigationIdRef.current;

      setPendingUrl(to);

      // Immediately replace segments whose parent has a loading boundary
      // with suspense sentinels. This triggers Suspense fallbacks before
      // the server responds, giving instant visual feedback.
      const currentBoundaries = boundaryComponentsRef.current;
      if (Object.keys(currentBoundaries).length > 0) {
        setSegments((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(prev)) {
            const parentKey = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
            if (parentKey && currentBoundaries[parentKey]?.loading) {
              next[key] = suspenseSentinelElement;
            }
          }
          return next;
        });
      }

      try {
        // Check if we have a prefetched response for this URL.
        // Prefetched responses are full renders (no previous URL header),
        // which the client handles correctly via the full update path.
        const prefetched = consumePrefetch(targetUrl.pathname, targetUrl.search);
        const response =
          prefetched ??
          (await fetch(
            `${RSC_ENDPOINT}?url=${encodeURIComponent(targetUrl.pathname + targetUrl.search)}`,
            {
              headers: {
                [RSC_PREVIOUS_URL_HEADER]: currentPathname,
              },
              signal: controller.signal,
            },
          ));

        if (!response.body) {
          throw new Error(
            `[react-flight-router] RSC response has no body (status: ${response.status})`,
          );
        }

        // Clear the abort controller BEFORE handing the stream to React.
        // Once the fetch response has arrived, React will own the body stream
        // and read it internally for Suspense boundaries. Aborting the controller
        // after this point would kill the stream mid-read, causing a race condition
        // in React's Flight client where chunks are set to "rejected" by the abort
        // error while buffered data is still being processed — resulting in
        // "t.reason.enqueueModel is not a function" errors. Future navigations
        // use the navId check below to discard stale results instead.
        //
        // Note: For truly slow routes (no Suspense), the fetch hasn't completed
        // yet when the user navigates away, so the abort on line 119 cancels it
        // before we reach this point. For routes where the response arrives quickly,
        // we stop aborting here and rely on navId-based discarding.
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }

        // createFromReadableStream resolves as soon as the model structure arrives
        // (first chunk). Segments may contain lazy references for async server
        // components inside Suspense boundaries — React will show the Suspense
        // fallbacks immediately and replace them as data streams in.
        const payload = await createFromReadableStream(response.body, { callServer });

        // Discard if a newer navigation started while we were fetching
        if (navId !== navigationIdRef.current) return;

        // A server component called redirect() — follow it client-side.
        if (payload.redirect) {
          navigate(payload.redirect.url, { replace: true });
          return;
        }

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

        // Merge boundary components from full renders
        if (payload.boundaryComponents) {
          setBoundaryComponents((prev) => ({
            ...prev,
            ...payload.boundaryComponents,
          }));
        }

        setUrl(to);
        setParams(payload.params ?? {});
        setPendingUrl(null);

        // If the target URL has a hash fragment, scroll to that element
        if (targetUrl.hash) {
          requestAnimationFrame(() => {
            const element = document.getElementById(targetUrl.hash.slice(1));
            if (element) {
              element.scrollIntoView();
            }
          });
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Expected: a newer navigation aborted this one
          return;
        }
        setPendingUrl(null);
        // Store the error so Outlet can throw it during render,
        // making it catchable by the nearest ErrorBoundary.
        setNavigationError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [createFromReadableStream, callServer],
  );

  const refresh = useCallback(async () => {
    const currentUrl = new URL(urlRef.current, globalThis.location.origin);

    // Abort any in-flight navigation fetch
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const navId = ++navigationIdRef.current;
    setPendingUrl(urlRef.current);
    setNavigationError(null);

    try {
      const response = await fetch(
        `${RSC_ENDPOINT}?url=${encodeURIComponent(currentUrl.pathname + currentUrl.search)}`,
        { signal: controller.signal },
      );

      if (!response.body) {
        throw new Error(
          `[react-flight-router] RSC response has no body (status: ${response.status})`,
        );
      }

      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }

      const payload = await createFromReadableStream(response.body, { callServer });

      if (navId !== navigationIdRef.current) return;

      if (payload.redirect) {
        navigate(payload.redirect.url, { replace: true });
        return;
      }

      setSegments(payload.segments);

      if (payload.boundaryComponents) {
        setBoundaryComponents((prev) => ({ ...prev, ...payload.boundaryComponents }));
      }

      setParams(payload.params ?? {});
      setPendingUrl(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      setPendingUrl(null);
      setNavigationError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [createFromReadableStream, callServer, navigate]);

  // Abort in-flight navigation on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // Handle browser back/forward
  useEffect(() => {
    const handler = () => {
      isPopstateRef.current = true;
      navigate(
        globalThis.location.pathname + globalThis.location.search + globalThis.location.hash,
      );
    };
    globalThis.addEventListener("popstate", handler);
    return () => globalThis.removeEventListener("popstate", handler);
  }, [navigate]);

  // Memoize each context's value independently so consumers re-render only
  // when the slice they subscribe to actually changes. Identity stability
  // matters here: a fresh object on every RouterProvider render would
  // propagate to every useContext consumer regardless of memoization.
  const navigationState: "idle" | "loading" = pendingUrl != null ? "loading" : "idle";

  const actionsValue = useMemo<NavigationActionsValue>(
    () => ({ navigate, refresh }),
    [navigate, refresh],
  );

  const locationValue = useMemo<LocationValue>(
    () => ({ url, pendingUrl, navigationState }),
    [url, pendingUrl, navigationState],
  );

  const segmentsValue = useMemo<SegmentsValue>(
    () => ({
      segments,
      params,
      boundaryComponents,
      navigationError,
      childKeyByParent: buildChildKeyByParent(segments),
    }),
    [segments, params, boundaryComponents, navigationError],
  );

  return (
    <NavigationActionsContext.Provider value={actionsValue}>
      <LocationContext.Provider value={locationValue}>
        <SegmentsContext.Provider value={segmentsValue}>{children}</SegmentsContext.Provider>
      </LocationContext.Provider>
    </NavigationActionsContext.Provider>
  );
}
