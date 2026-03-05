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
   *  Works at any nesting level — the deepest matching ancestor catches it.
   *  When the module is a "use client" component, it is also used as the
   *  client-side error boundary fallback for this route's <Outlet />. */
  error?: () => Promise<RouteModule>;
  /** Loading fallback component shown while child segments are loading during navigation.
   *  Must be a "use client" module. When present, <Outlet /> automatically wraps
   *  child segments in a Suspense boundary with this component as the fallback. */
  loading?: () => Promise<RouteModule>;
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
