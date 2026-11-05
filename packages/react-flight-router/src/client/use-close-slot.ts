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
 *
 * Pass `{ preventScrollReset: true }` to leave the page where it is — a slot is
 * an overlay on top of the page underneath, so closing it usually should not
 * move that page.
 */
export function useCloseSlot(
  slotName: string,
  options?: { preventScrollReset?: boolean },
): () => void {
  const preventScrollReset = options?.preventScrollReset;
  const actions = useNavigationActions();
  const locationState = useLocationState();
  const url = locationState?.url ?? "";

  return useCallback(() => {
    if (!actions?.navigate) return;
    const origin = globalThis.location?.origin ?? "http://localhost";
    const current = new URL(url || globalThis.location?.href || "/", origin);
    current.searchParams.delete(`@${slotName}`);
    actions.navigate(current.pathname + current.search + current.hash, {
      replace: true,
      preventScrollReset,
    });
  }, [actions, url, slotName, preventScrollReset]);
}
