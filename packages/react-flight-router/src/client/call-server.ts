import { ACTION_ENDPOINT, RSC_ACTION_HEADER, RSC_CONTENT_TYPE } from "../shared/constants.js";

/**
 * Call a server action from the client.
 * Serializes the action ID and arguments, POSTs to the server,
 * and returns the RSC response.
 */
export async function callServer(id: string, args: unknown[]): Promise<unknown> {
  const rscClientModule = (await import("react-server-dom-webpack/client.browser")) as any;
  const { encodeReply, createFromReadableStream } = rscClientModule;

  const body = await encodeReply(args);

  const response = await fetch(ACTION_ENDPOINT, {
    method: "POST",
    headers: {
      [RSC_ACTION_HEADER]: id,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Server action failed: ${response.statusText}`);
  }

  // An action response MUST be a flight payload. Anything else — a proxy's
  // "starting up" HTML page during a deploy, an auth middleware's 302 that
  // fetch transparently followed to an HTML page, a misrouted handler —
  // would otherwise be fed to createFromReadableStream, whose promise NEVER
  // settles on non-flight input. That turns an infrastructure hiccup into a
  // silent permanent hang (observed in production as action calls that the
  // server logged as completed but the client waited on forever). Fail loudly
  // instead so callers can retry or surface the error.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes(RSC_CONTENT_TYPE)) {
    throw new Error(
      `[react-flight-router] Server action "${id}" returned ${
        response.redirected ? `a redirect (to ${response.url}) with ` : ""
      }content-type "${contentType || "unknown"}" instead of "${RSC_CONTENT_TYPE}" — ` +
        `the response is not a flight payload (server restarting, proxy error page, or ` +
        `an HTTP redirect on the action endpoint).`,
    );
  }

  if (!response.body) {
    throw new Error(
      `[react-flight-router] Server action response has no body (status: ${response.status})`,
    );
  }

  return createFromReadableStream(response.body, { callServer });
}
