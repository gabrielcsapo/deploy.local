import {
  ACTION_ENDPOINT,
  RSC_ACTION_HEADER,
  RSC_CONTENT_TYPE,
  RSC_REDIRECT_HEADER,
} from '../shared/constants.js';
import { followActionRedirect } from './action-redirect.js';

/** The rejection of a server action that threw on the server. */
export class ServerActionError extends Error {
  constructor(
    message: string,
    /** The HTTP status the server answered with. */
    public readonly status: number,
    /** Matches the digest in the server's log line for this error. */
    public readonly digest?: string,
  ) {
    super(message);
    this.name = 'ServerActionError';
  }
}

async function failure(response: Response): Promise<ServerActionError> {
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    try {
      const body = (await response.json()) as {
        error?: { message?: unknown; digest?: unknown };
      };
      if (body?.error && typeof body.error.message === 'string') {
        return new ServerActionError(
          body.error.message,
          response.status,
          typeof body.error.digest === 'string' ? body.error.digest : undefined,
        );
      }
    } catch {
      /* Not the router's error body; fall through. */
    }
  }
  // statusText is empty over HTTP/2, so always name the status.
  return new ServerActionError(
    `Server action failed: ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
    response.status,
  );
}

/**
 * Call a server action from the client.
 * Serializes the action ID and arguments, POSTs to the server,
 * and returns the RSC response.
 */
export async function callServer(id: string, args: unknown[]): Promise<unknown> {
  const rscClientModule = (await import('react-server-dom-webpack/client.browser')) as any;
  const { encodeReply, createFromReadableStream } = rscClientModule;

  const body = await encodeReply(args);

  const response = await fetch(ACTION_ENDPOINT, {
    method: 'POST',
    headers: {
      [RSC_ACTION_HEADER]: id,
    },
    body,
  });

  if (!response.ok) {
    throw await failure(response);
  }

  const redirect = response.headers.get(RSC_REDIRECT_HEADER);
  if (redirect) {
    void response.body?.cancel().catch(() => {});
    followActionRedirect(redirect);
    return undefined;
  }

  // An action response MUST be a flight payload. Anything else — a proxy's
  // "starting up" HTML page during a deploy, an auth middleware's 302 that
  // fetch transparently followed to an HTML page, a misrouted handler —
  // would otherwise be fed to createFromReadableStream, whose promise NEVER
  // settles on non-flight input. That turns an infrastructure hiccup into a
  // silent permanent hang (observed in production as action calls that the
  // server logged as completed but the client waited on forever). Fail loudly
  // instead so callers can retry or surface the error.
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes(RSC_CONTENT_TYPE)) {
    throw new Error(
      `[react-flight-router] Server action "${id}" returned ${
        response.redirected ? `a redirect (to ${response.url}) with ` : ''
      }content-type "${contentType || 'unknown'}" instead of "${RSC_CONTENT_TYPE}" — ` +
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
