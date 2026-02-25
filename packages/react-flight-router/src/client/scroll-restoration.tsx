"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "./router-context.js";

const STORAGE_KEY = "react-flight-router:scroll";

function getScrollPositions(): Record<string, number> {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function saveScrollPosition(key: string, y: number) {
  try {
    const positions = getScrollPositions();
    positions[key] = y;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // sessionStorage may be unavailable
  }
}

/**
 * Manages scroll position across client-side navigations.
 *
 * - New navigations (link clicks): scrolls to top
 * - Back/forward (popstate): restores the previous scroll position
 * - Positions are persisted in sessionStorage for tab reload support
 *
 * Place once in the root layout, inside RouterProvider:
 * ```tsx
 * <body>
 *   <ScrollRestoration />
 *   <nav>...</nav>
 *   <Outlet />
 * </body>
 * ```
 */
export function ScrollRestoration() {
  const { url } = useRouter();
  const previousUrlRef = useRef(url);
  const isPopstateRef = useRef(false);

  // Disable native scroll restoration so the browser doesn't interfere
  // with our manual scroll management during SPA navigations.
  useEffect(() => {
    if (typeof globalThis.history !== "undefined") {
      globalThis.history.scrollRestoration = "manual";
    }
  }, []);

  // Track popstate events to distinguish back/forward from link clicks.
  // On popstate, save the scroll position for the page we're LEAVING
  // before history.state.key changes to the target entry's key.
  useEffect(() => {
    const handler = () => {
      isPopstateRef.current = true;
    };
    globalThis.addEventListener("popstate", handler);
    return () => globalThis.removeEventListener("popstate", handler);
  }, []);

  // Handle scroll on URL change
  useEffect(() => {
    if (url === previousUrlRef.current) return;

    if (isPopstateRef.current) {
      // Back/forward: restore scroll position.
      // Keep isPopstateRef true until AFTER the scroll is restored in the
      // next frame — otherwise scroll events from DOM updates can fire between
      // the effect and the rAF, overwriting the saved position with scrollY=0.
      const key = globalThis.history.state?.key;
      if (key) {
        const positions = getScrollPositions();
        const savedY = positions[key];
        if (savedY != null) {
          requestAnimationFrame(() => {
            window.scrollTo(0, savedY);
            isPopstateRef.current = false;
          });
        } else {
          isPopstateRef.current = false;
        }
      } else {
        isPopstateRef.current = false;
      }
    } else {
      // New navigation: scroll to top
      window.scrollTo(0, 0);
    }

    previousUrlRef.current = url;
  }, [url]);

  // Continuously save scroll position (debounced)
  useEffect(() => {
    const saveCurrentScroll = () => {
      const key = globalThis.history.state?.key;
      if (key) {
        saveScrollPosition(key, window.scrollY);
      }
    };

    let scrollTimer: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      // Don't save during back/forward transitions — the old page content is
      // still rendered at scrollY=0 but history.state.key already points to
      // the target page. Saving now would overwrite the target's stored position.
      if (isPopstateRef.current) return;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(saveCurrentScroll, 100);
    };

    globalThis.addEventListener("scroll", onScroll, { passive: true });
    globalThis.addEventListener("beforeunload", saveCurrentScroll);

    return () => {
      clearTimeout(scrollTimer);
      globalThis.removeEventListener("scroll", onScroll);
      globalThis.removeEventListener("beforeunload", saveCurrentScroll);
    };
  }, []);

  return null;
}
