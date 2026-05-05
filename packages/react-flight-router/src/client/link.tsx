"use client";

import type { AnchorHTMLAttributes, CSSProperties, MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import { useNavigationActions, useLocationState } from "./router-context.js";
import { prefetchRSC } from "./prefetch-cache.js";
import { fastPathname } from "./fast-pathname.js";

export type LinkRenderProps = {
  isActive: boolean;
  isPending: boolean;
};

interface LinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "className" | "style" | "href" | "children"
> {
  to: string;
  children: ReactNode | ((props: LinkRenderProps) => ReactNode);
  className?: string | ((props: LinkRenderProps) => string | undefined);
  style?: CSSProperties | ((props: LinkRenderProps) => CSSProperties | undefined);
  /**
   * When true (default), isActive requires an exact pathname match.
   * When false, isActive is true if the current pathname starts with the link's pathname.
   * Useful for parent layout links (e.g., "Dashboard" active for all /dashboard/* routes).
   */
  end?: boolean;
  /**
   * Controls when the link's RSC payload is prefetched.
   * - "none" (default): No prefetching.
   * - "intent": Prefetch on hover or focus (fires after a short delay to avoid wasted requests).
   * - "render": Prefetch as soon as the link renders (use sparingly).
   */
  prefetch?: "none" | "intent" | "render";
  /**
   * When set, the link opens `to` inside the named parallel-route slot
   * instead of replacing the current page. Resolves to a URL like
   * `<currentPathname>?@<intoSlot>=<to>`, so a hard-load of `to` still
   * works as a normal page (the share-link property of intercepting routes).
   */
  intoSlot?: string;
}

/**
 * Build a URL that opens `to` inside the named slot of the current page.
 * Preserves any other search params already on the URL (including other
 * open slots), so opening `?@modal=...` does not close `?@drawer=...`.
 */
function buildSlotUrl(currentUrl: string, slotName: string, to: string, origin: string): string {
  const current = new URL(currentUrl, origin);
  current.searchParams.set(`@${slotName}`, to);
  return current.pathname + current.search + current.hash;
}

function isPathActive(currentPathname: string, toPathname: string, end: boolean): boolean {
  if (end) {
    return currentPathname === toPathname;
  }
  return (
    currentPathname.startsWith(toPathname) &&
    (toPathname === "/" ||
      currentPathname.length === toPathname.length ||
      currentPathname.charAt(toPathname.length) === "/")
  );
}

/**
 * A navigation link that provides active and pending state awareness.
 *
 * Renders a standard <a> element and intercepts clicks for SPA navigation.
 * className, style, and children can be static values or callbacks receiving { isActive, isPending }.
 * Sets aria-current="page" when active for accessibility.
 */
export function Link({
  to,
  children,
  onClick,
  className,
  style,
  end = true,
  prefetch = "none",
  intoSlot,
  ...rest
}: LinkProps) {
  // The narrow hooks may return null during production SSR when the context
  // is not yet provided (module deduplication across RSC/SSR bundles).
  // In that case, render a plain <a> without active state.
  // Subscribing to actions + location only — segment changes during a
  // navigation no longer cause every Link on the page to re-render.
  const actions = useNavigationActions();
  const locationState = useLocationState();

  const url = locationState?.url ?? "";
  const navigate = actions?.navigate;
  const pendingUrl = locationState?.pendingUrl ?? null;

  const origin = globalThis.location?.origin ?? "http://localhost";
  const currentPathname = url ? fastPathname(url, origin) : "";
  const toPathname = fastPathname(to, origin);

  // Resolved navigation target. For slot links, keep the current pathname and
  // attach `?@<slot>=<to>` so the modal opens "on top of" the current page
  // while a hard-visit to `to` still renders the page normally.
  const resolvedTo = intoSlot
    ? buildSlotUrl(url || (globalThis.location?.href ?? "/"), intoSlot, to, origin)
    : to;

  const isActive = currentPathname ? isPathActive(currentPathname, toPathname, end) : false;

  const pendingPathname = pendingUrl ? fastPathname(pendingUrl, origin) : null;
  const isPending = pendingPathname != null && isPathActive(pendingPathname, toPathname, end);

  const renderProps: LinkRenderProps = { isActive, isPending };

  // Prefetch on render
  useEffect(() => {
    if (prefetch === "render" && !isActive) {
      prefetchRSC(resolvedTo);
    }
  }, [prefetch, resolvedTo, isActive]);

  // Prefetch on intent (hover/focus) with a short delay
  const intentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePointerEnter = useCallback(() => {
    if (prefetch !== "intent" || isActive) return;
    intentTimerRef.current = setTimeout(() => prefetchRSC(resolvedTo), 80);
  }, [prefetch, resolvedTo, isActive]);

  const handlePointerLeave = useCallback(() => {
    if (intentTimerRef.current) {
      clearTimeout(intentTimerRef.current);
      intentTimerRef.current = null;
    }
  }, []);

  const handleFocus = useCallback(() => {
    if (prefetch === "intent" && !isActive) {
      prefetchRSC(resolvedTo);
    }
  }, [prefetch, resolvedTo, isActive]);

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onClick?.(e);
    navigate?.(resolvedTo);
  };

  const resolvedClassName = typeof className === "function" ? className(renderProps) : className;
  const resolvedStyle = typeof style === "function" ? style(renderProps) : style;
  const resolvedChildren = typeof children === "function" ? children(renderProps) : children;

  return (
    <a
      href={resolvedTo}
      onClick={handleClick}
      onPointerEnter={prefetch === "intent" ? handlePointerEnter : undefined}
      onPointerLeave={prefetch === "intent" ? handlePointerLeave : undefined}
      onFocus={prefetch === "intent" ? handleFocus : undefined}
      className={resolvedClassName}
      style={resolvedStyle}
      aria-current={isActive ? "page" : undefined}
      {...rest}
    >
      {resolvedChildren}
    </a>
  );
}
