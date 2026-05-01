"use client";

import { useCallback, useMemo } from "react";
import { useLocationState, useNavigationActions } from "./router-context.js";

type SearchParamsUpdater = URLSearchParams | ((prev: URLSearchParams) => URLSearchParams);

/**
 * Read and write URL search parameters.
 * Returns a [searchParams, setSearchParams] tuple similar to useState.
 *
 * setSearchParams triggers a client navigation to the same pathname with new query params.
 * It accepts either a URLSearchParams instance or an updater function.
 */
export function useSearchParams(): [URLSearchParams, (next: SearchParamsUpdater) => void] {
  // The narrow hooks may return null during production SSR when the context
  // is not yet provided (module deduplication across RSC/SSR bundles).
  // Subscribing only to location + actions — segment changes don't cause
  // useSearchParams consumers to re-render.
  const locationState = useLocationState();
  const actions = useNavigationActions();
  const url = locationState?.url ?? "";
  const navigate = actions?.navigate;

  const origin = globalThis.location?.origin ?? "http://localhost";
  const searchParams = useMemo(() => new URL(url || "/", origin).searchParams, [url, origin]);

  const setSearchParams = useCallback(
    (next: SearchParamsUpdater) => {
      const currentUrl = new URL(url || "/", globalThis.location?.origin ?? "http://localhost");
      const newParams = typeof next === "function" ? next(currentUrl.searchParams) : next;
      const search = newParams.toString();
      const newUrl = currentUrl.pathname + (search ? `?${search}` : "");
      navigate?.(newUrl, { replace: true });
    },
    [url, navigate],
  );

  return [searchParams, setSearchParams];
}
