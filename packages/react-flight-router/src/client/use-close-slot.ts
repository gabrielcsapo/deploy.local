"use client";

import { useCallback } from "react";
import { useNavigationActions, useLocationState } from "./router-context.js";

/**
 * Returns a function that closes the named parallel-route slot by removing
 * its `?@<slotName>` search param from the URL. Other slots and search
 * params are preserved.
 *
 * The slot's segments are dropped on the next navigation because the server
 * omits them from `segmentKeys` when the slot param is absent.
 */
export function useCloseSlot(slotName: string): () => void {
  const actions = useNavigationActions();
  const locationState = useLocationState();
  const url = locationState?.url ?? "";

  return useCallback(() => {
    if (!actions?.navigate) return;
    const origin = globalThis.location?.origin ?? "http://localhost";
    const current = new URL(url || globalThis.location?.href || "/", origin);
    current.searchParams.delete(`@${slotName}`);
    actions.navigate(current.pathname + current.search + current.hash, { replace: true });
  }, [actions, url, slotName]);
}
