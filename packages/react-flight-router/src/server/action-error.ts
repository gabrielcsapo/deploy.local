import { randomUUID } from 'node:crypto';
import { RedirectError } from './redirect.js';
import {
  ACTION_ERROR_CONTENT_TYPE,
  RSC_CONTENT_TYPE,
  RSC_REDIRECT_HEADER,
} from '../shared/constants.js';

/** What a failed programmatic action tells the client. Never a stack trace. */
export interface ActionFailure {
  status: number;
  message: string;
  digest: string;
}

/** A `redirect()` thrown inside an action. */
export interface ActionRedirect {
  url: string;
  status: 301 | 302;
}

/**
 * `instanceof` fails when the error comes from another copy of the router
 * (a worker's own module instance, or a bundled copy), so match the shape too.
 */
export function asRedirect(error: unknown): ActionRedirect | null {
  if (error instanceof RedirectError) return { url: error.destination, status: error.status };
  if (
    error instanceof Error &&
    error.name === 'RedirectError' &&
    typeof (error as { destination?: unknown }).destination === 'string'
  ) {
    const status = (error as { status?: unknown }).status === 301 ? 301 : 302;
    return { url: (error as unknown as { destination: string }).destination, status };
  }
  return null;
}

/**
 * The HTTP status for a thrown action error: a numeric `status` (or
 * `statusCode`) between 400 and 599 on the error, otherwise 500.
 */
export function actionErrorStatus(error: unknown): number {
  if (error && typeof error === 'object') {
    for (const key of ['status', 'statusCode'] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599)
        return value;
    }
  }
  return 500;
}

/** A short id that ties the client's error to the server's log line. */
export function actionErrorDigest(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export function actionFailure(error: unknown, digest = actionErrorDigest()): ActionFailure {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Internal server error';
  return { status: actionErrorStatus(error), message, digest };
}

export function actionFailureResponse(failure: ActionFailure): Response {
  return new Response(
    JSON.stringify({ error: { message: failure.message, digest: failure.digest } }),
    {
      status: failure.status,
      headers: {
        'Content-Type': ACTION_ERROR_CONTENT_TYPE,
        'Cache-Control': 'private, no-store, no-transform',
      },
    },
  );
}

/**
 * A programmatic action that called `redirect()`. The response is a 200 so
 * fetch does not follow it; the client reads the header and navigates.
 */
export function actionRedirectResponse(redirect: ActionRedirect): Response {
  return new Response(null, {
    status: 200,
    headers: {
      'Content-Type': RSC_CONTENT_TYPE,
      [RSC_REDIRECT_HEADER]: redirect.url,
      'Cache-Control': 'private, no-store, no-transform',
    },
  });
}
