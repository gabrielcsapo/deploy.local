/**
 * True when a server action or server render rejected because the session is
 * no longer valid. Server actions throw `new Error('Unauthorized')`; the
 * router carries that message to the client's rejected promise.
 */
export function isUnauthorizedError(error: unknown): boolean {
  return /\bunauthorized\b/i.test(error instanceof Error ? error.message : '');
}
