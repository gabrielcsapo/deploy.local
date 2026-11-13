import type { RedirectStatus } from '../router/types.js';

export class RedirectError extends Error {
  constructor(
    public readonly destination: string,
    public readonly status: RedirectStatus,
  ) {
    super(`Redirect to ${destination}`);
    this.name = 'RedirectError';
  }
}

/**
 * Redirect to a new URL from a server component or server action.
 *
 * During SSR (initial page load), the server renders the destination (same origin) or returns
 * an HTTP redirect with this status. 307 and 308 keep the request method; 301 and 302 may not.
 * During client-side navigation, the RSC payload includes redirect info and
 * the router navigates to the destination URL.
 *
 * @example
 * ```tsx
 * import { redirect } from "react-flight-router/server";
 *
 * export default async function ProtectedPage() {
 *   const session = await getSession();
 *   if (!session) return redirect("/login");
 *   return <Dashboard />;
 * }
 * ```
 */
export function redirect(url: string, status: RedirectStatus = 302): never {
  throw new RedirectError(url, status);
}
