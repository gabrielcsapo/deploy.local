"use client";

/**
 * A component that suspends indefinitely by throwing a never-resolving Promise.
 * Used internally during navigation to trigger the nearest Suspense boundary
 * while waiting for the server to respond with new content.
 *
 * @internal Not exported to users.
 */
export function SuspenseSentinel(): never {
  throw new Promise(() => {});
}
