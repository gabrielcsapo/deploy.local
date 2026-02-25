import type { ReactNode, ComponentType } from "react";

export interface RouteConfig {
  /** Unique route identifier */
  id: string;
  /** URL path segment (e.g., 'about', ':id', 'posts/:slug') */
  path?: string;
  /** Whether this is an index route (matches when parent path is exact) */
  index?: boolean;
  /** Lazy import of route module */
  component: () => Promise<RouteModule>;
  /** Nested child routes */
  children?: RouteConfig[];
  /** Component to render when no child routes match within this layout.
   *  Works at any nesting level — the deepest matching layout catches it. */
  notFound?: () => Promise<RouteModule>;
  /** Component to render when a child route's module fails to import.
   *  Works at any nesting level — the deepest matching ancestor catches it. */
  error?: () => Promise<RouteModule>;
}

export interface RouteModule {
  /** The page/layout component */
  default: ComponentType<{ params?: Record<string, string>; children?: ReactNode }>;
}

export interface RouteMatch {
  /** The matched route config */
  route: RouteConfig;
  /** Extracted URL params */
  params: Record<string, string>;
  /** The matched pathname portion */
  pathname: string;
  /** Hierarchical key for partial updates (e.g., "root", "root/home") */
  segmentKey: string;
}
