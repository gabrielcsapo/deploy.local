/**
 * Where a `redirect()` thrown inside a server action goes on the client.
 *
 * The router registers its navigate here. It is kept on globalThis so a
 * second copy of this module (a separately bundled entry) sees the same one.
 */
type ActionRedirectHandler = (url: string) => void;

const KEY = '__RFR_ACTION_REDIRECT__';

/** @internal */
export function setActionRedirectHandler(handler: ActionRedirectHandler | null): void {
  (globalThis as Record<string, unknown>)[KEY] = handler ?? undefined;
}

/** @internal Navigates with the router when one is mounted, else loads the page. */
export function followActionRedirect(url: string): void {
  const handler = (globalThis as Record<string, unknown>)[KEY] as ActionRedirectHandler | undefined;
  if (handler) handler(url);
  else if (typeof window !== 'undefined') window.location.assign(url);
}
