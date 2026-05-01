"use client";

import type { AnchorHTMLAttributes, CSSProperties, MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import { useNavigationActions, useLocationState } from "./router-context.js";
import { prefetchRSC } from "./prefetch-cache.js";

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
  const currentPathname = url ? new URL(url, origin).pathname : "";
  const toPathname = new URL(to, origin).pathname;

  const isActive = currentPathname ? isPathActive(currentPathname, toPathname, end) : false;

  const pendingPathname = pendingUrl ? new URL(pendingUrl, origin).pathname : null;
  const isPending = pendingPathname != null && isPathActive(pendingPathname, toPathname, end);

  const renderProps: LinkRenderProps = { isActive, isPending };

  // Prefetch on render
  useEffect(() => {
    if (prefetch === "render" && !isActive) {
      prefetchRSC(to);
    }
  }, [prefetch, to, isActive]);

  // Prefetch on intent (hover/focus) with a short delay
  const intentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePointerEnter = useCallback(() => {
    if (prefetch !== "intent" || isActive) return;
    intentTimerRef.current = setTimeout(() => prefetchRSC(to), 80);
  }, [prefetch, to, isActive]);

  const handlePointerLeave = useCallback(() => {
    if (intentTimerRef.current) {
      clearTimeout(intentTimerRef.current);
      intentTimerRef.current = null;
    }
  }, []);

  const handleFocus = useCallback(() => {
    if (prefetch === "intent" && !isActive) {
      prefetchRSC(to);
    }
  }, [prefetch, to, isActive]);

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onClick?.(e);
    navigate?.(to);
  };

  const resolvedClassName = typeof className === "function" ? className(renderProps) : className;
  const resolvedStyle = typeof style === "function" ? style(renderProps) : style;
  const resolvedChildren = typeof children === "function" ? children(renderProps) : children;

  return (
    <a
      href={to}
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
