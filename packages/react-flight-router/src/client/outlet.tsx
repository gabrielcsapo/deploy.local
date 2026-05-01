"use client";

import { useContext, Suspense, cloneElement, isValidElement, type ReactNode } from "react";
import { useSegmentsState, OutletDepthContext } from "./router-context.js";
import { ErrorBoundary } from "./error-boundary.js";

/**
 * Renders the child route segment.
 * Works by looking up the next-level segment key in the segment map.
 *
 * When route-config loading/error boundary components are present for
 * the parent segment, automatically wraps the child in Suspense and/or
 * ErrorBoundary. Manual <Loading>/<ErrorBoundary> placed in layouts
 * take precedence (they are closer to the content).
 */
export function Outlet() {
  const { segments, boundaryComponents, navigationError } = useSegmentsState();
  const { segmentKey: parentKey, depth } = useContext(OutletDepthContext);

  // Find the child segment that extends the parent key
  const childKey = Object.keys(segments).find((key) => {
    if (key === parentKey) return false;
    // Must start with parent key and be exactly one level deeper
    if (parentKey && !key.startsWith(parentKey + "/")) return false;
    if (!parentKey && key.includes("/")) {
      // Root level: find keys with no slash
      return false;
    }
    const suffix = parentKey ? key.slice(parentKey.length + 1) : key;
    return !suffix.includes("/");
  });

  if (!childKey) return null;

  const parentBoundaries = boundaryComponents?.[parentKey];

  // If there's a navigation error and an error boundary for this segment,
  // throw the error during render so the ErrorBoundary catches it
  if (navigationError && parentBoundaries?.error) {
    throw navigationError;
  }

  let content: ReactNode = (
    <OutletDepthContext.Provider value={{ segmentKey: childKey, depth: depth + 1 }}>
      {segments[childKey] as ReactNode}
    </OutletDepthContext.Provider>
  );

  // Wrap with Suspense if route config has a loading component
  if (parentBoundaries?.loading) {
    content = <Suspense fallback={parentBoundaries.loading as ReactNode}>{content}</Suspense>;
  }

  // Wrap with ErrorBoundary if route config has an error component (OUTSIDE Suspense).
  // The key prop ensures React remounts the ErrorBoundary when the child route
  // changes, clearing any previous error state so navigation away from an error
  // page works correctly.
  if (parentBoundaries?.error) {
    const errorElement = parentBoundaries.error;
    content = (
      <ErrorBoundary
        key={childKey}
        fallback={(error: Error) => {
          if (isValidElement(errorElement)) {
            return cloneElement(errorElement as any, { error });
          }
          return errorElement as ReactNode;
        }}
      >
        {content}
      </ErrorBoundary>
    );
  }

  return content;
}

/**
 * Wraps the initial root segment for the RSC shell.
 */
export function SegmentRoot({ segmentKey, children }: { segmentKey: string; children: ReactNode }) {
  return (
    <OutletDepthContext.Provider value={{ segmentKey, depth: 0 }}>
      {children}
    </OutletDepthContext.Provider>
  );
}
