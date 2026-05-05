"use client";

import { useContext, Suspense, cloneElement, isValidElement, type ReactNode } from "react";
import { useSegmentsState, OutletDepthContext } from "./router-context.js";
import { ErrorBoundary } from "./error-boundary.js";

interface OutletProps {
  /**
   * Renders a parallel-route slot declared on this layout's `slots` config
   * instead of the default child segment. The slot is matched against
   * `?@<name>=<path>` in the URL.
   */
  name?: string;
}

/**
 * Renders the child route segment, or a named parallel-route slot.
 * Works by looking up the next-level segment key in the segment map.
 *
 * When route-config loading/error boundary components are present for
 * the parent segment, automatically wraps the child in Suspense and/or
 * ErrorBoundary. Manual <Loading>/<ErrorBoundary> placed in layouts
 * take precedence (they are closer to the content).
 */
export function Outlet({ name }: OutletProps = {}) {
  const { segments, boundaryComponents, navigationError, childKeyByParent } = useSegmentsState();
  const { segmentKey: parentKey, depth } = useContext(OutletDepthContext);

  // For named slots the lookup key is `<parent>@<slotName>`, which matches
  // the segment-key shape produced by matchSlots() on the server. Default
  // outlets keep the existing behavior of looking up the parent directly.
  const lookupKey = name ? `${parentKey}@${name}` : parentKey;

  // O(1) lookup into the parent → child map computed once per segments
  // change in RouterProvider, replacing what was an O(N) Object.keys + find
  // with string-prefix work on every Outlet render.
  const childKey = childKeyByParent[lookupKey];

  if (!childKey) return null;

  const parentBoundaries = boundaryComponents?.[lookupKey];

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
