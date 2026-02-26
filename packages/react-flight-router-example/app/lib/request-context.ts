import { AsyncLocalStorage } from "node:async_hooks";

// Use a globalThis singleton so the same AsyncLocalStorage instance is shared
// across build phases. The RSC server bundle and the server entry bundle each
// get their own copy of this module — without a shared global, enterWith()
// in server.ts sets one instance while getRequest() in server components
// reads from a different one.
const GLOBAL_KEY = "__example_request_storage__";
export const requestStorage: AsyncLocalStorage<Request> = ((globalThis as any)[GLOBAL_KEY] ??=
  new AsyncLocalStorage<Request>());

export function getRequest(): Request | undefined {
  return requestStorage.getStore();
}
