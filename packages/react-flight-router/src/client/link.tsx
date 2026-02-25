"use client";

import type { AnchorHTMLAttributes, CSSProperties, MouseEvent, ReactNode } from "react";
import { useRouter } from "./router-context.js";

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
export function Link({ to, children, onClick, className, style, end = true, ...rest }: LinkProps) {
  // useRouter() may return null during production SSR when the context
  // is not yet provided (module deduplication across RSC/SSR bundles).
  // In that case, render a plain <a> without active state.
  const router = useRouter();

  const url = router?.url ?? "";
  const navigate = router?.navigate;
  const pendingUrl = router?.pendingUrl ?? null;

  const origin = globalThis.location?.origin ?? "http://localhost";
  const currentPathname = url ? new URL(url, origin).pathname : "";
  const toPathname = new URL(to, origin).pathname;

  const isActive = currentPathname ? isPathActive(currentPathname, toPathname, end) : false;

  const pendingPathname = pendingUrl ? new URL(pendingUrl, origin).pathname : null;
  const isPending = pendingPathname != null && isPathActive(pendingPathname, toPathname, end);

  const renderProps: LinkRenderProps = { isActive, isPending };

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
      className={resolvedClassName}
      style={resolvedStyle}
      aria-current={isActive ? "page" : undefined}
      {...rest}
    >
      {resolvedChildren}
    </a>
  );
}
