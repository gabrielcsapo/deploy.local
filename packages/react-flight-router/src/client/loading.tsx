"use client";

import { Suspense, type ReactNode } from "react";

interface LoadingProps {
  children: ReactNode;
  /** Fallback UI shown while child content is loading during navigation */
  fallback?: ReactNode;
}

/**
 * Wraps children in a Suspense boundary that activates during route transitions.
 *
 * Place around <Outlet /> in your layout to show a loading fallback
 * while the child route segment is being fetched from the server:
 *
 *   <Loading fallback={<Skeleton />}>
 *     <Outlet />
 *   </Loading>
 */
export function Loading({ children, fallback }: LoadingProps) {
  return <Suspense fallback={fallback ?? null}>{children}</Suspense>;
}
