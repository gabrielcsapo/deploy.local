import { Link } from "react-flight-router/client";
import { getRequest } from "react-flight-router/server";

/**
 * Regression test page for the search-only-navigation bug
 * (`packages/react-flight-router/src/router/segment-diff.ts`).
 *
 * Reads `?value` from the request URL via `getRequest()` and renders it. The
 * three Link buttons all navigate to the same pathname with different
 * `?value` query params — so the only thing the router has to detect is the
 * search-string change. Before the diffSegments fix, soft-navigating between
 * these links left the rendered value stale.
 *
 * A per-render counter (server-timestamp) is also exposed so the spec can
 * additionally assert the server re-rendered, not just that the URL
 * appeared to change in the address bar.
 */
export default function SearchParamsPage() {
  const request = getRequest();
  const url = request ? new URL(request.url) : null;
  const value = url?.searchParams.get("value") ?? "(none)";

  // Cheap render fingerprint — different value each server render. The spec
  // asserts this changes across navigations.
  const renderId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  return (
    <div data-testid="search-params-page">
      <h1 className="text-3xl font-bold mb-2">Search Params</h1>
      <p className="text-gray-600 mb-4">
        Tests that soft-navigations which change only the URL search string force the page to
        re-render on the server.
      </p>

      <div className="mb-4">
        <div className="text-sm text-gray-500">Current ?value:</div>
        <div data-testid="search-params-value" className="text-2xl font-mono">
          {value}
        </div>
      </div>

      <div className="mb-4">
        <div className="text-sm text-gray-500">Server render id:</div>
        <div data-testid="search-params-render-id" className="font-mono text-sm">
          {renderId}
        </div>
      </div>

      <nav className="flex gap-2">
        <Link
          to="/search-params?value=A"
          data-testid="link-value-a"
          className="px-3 py-1.5 rounded bg-blue-500 text-white"
        >
          ?value=A
        </Link>
        <Link
          to="/search-params?value=B"
          data-testid="link-value-b"
          className="px-3 py-1.5 rounded bg-blue-500 text-white"
        >
          ?value=B
        </Link>
        <Link
          to="/search-params?value=C"
          data-testid="link-value-c"
          className="px-3 py-1.5 rounded bg-blue-500 text-white"
        >
          ?value=C
        </Link>
      </nav>
    </div>
  );
}
