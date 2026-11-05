export class RedirectError extends Error {
  constructor(
    public readonly destination: string,
    public readonly status: 301 | 302,
  ) {
    super(`Redirect to ${destination}`);
    this.name = "RedirectError";
  }
}

/**
 * Redirect to a new URL from a server component or server action.
 *
 * During SSR (initial page load), the server returns an HTTP 301/302 response.
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
export function redirect(url: string, status: 301 | 302 = 302): never {
  throw new RedirectError(url, status);
}
