/** Workspace/router lookups mark expected missing resources with HTTP status 404. */
export function logFlightRouterError(error: unknown) {
  if (error instanceof Error && 'status' in error && error.status === 404) return;
  console.error('Flight router error:', error);
}
