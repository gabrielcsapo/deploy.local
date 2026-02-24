"use client";

import { useContext, type ReactNode } from "react";
import { useRouter, OutletDepthContext } from "./router-context.js";

/**
 * Renders the child route segment.
 * Works by looking up the next-level segment key in the segment map.
 */
export function Outlet() {
  const { segments } = useRouter();
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

  return (
    <OutletDepthContext.Provider value={{ segmentKey: childKey, depth: depth + 1 }}>
      {segments[childKey] as ReactNode}
    </OutletDepthContext.Provider>
  );
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
