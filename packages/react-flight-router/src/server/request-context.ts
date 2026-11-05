import { AsyncLocalStorage } from "node:async_hooks";

const GLOBAL_KEY = "__flight_request_storage__";

/**
 * Framework-managed AsyncLocalStorage for the current HTTP request.
 * Populated automatically by createServer() before RSC renders, SSR, and actions.
 * Use `getRequest()` to read the current request in server components and actions.
 */
export const requestStorage: AsyncLocalStorage<Request> = ((globalThis as any)[GLOBAL_KEY] ??=
  new AsyncLocalStorage<Request>());

/**
 * Get the current HTTP request from the framework-managed AsyncLocalStorage.
 * Returns `undefined` if called outside a request context.
 *
 * Works in server components, server actions (both main-thread and worker-thread),
 * and any code called during request handling.
 *
 * @example
 * ```ts
 * import { getRequest } from "react-flight-router/server";
 *
 * export default async function MyComponent() {
 *   const request = getRequest();
 *   const cookie = request?.headers.get("Cookie");
 *   // ...
 * }
 * ```
 */
export function getRequest(): Request | undefined {
  return requestStorage.getStore();
}
