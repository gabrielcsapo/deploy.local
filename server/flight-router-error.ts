import type { RequestTimingEvent } from 'react-flight-router/server';

/** Workspace/router lookups mark expected missing resources with HTTP status 404. */
export function logFlightRouterError(error: unknown) {
  if (error instanceof Error && 'status' in error && error.status === 404) return;
  console.error('Flight router error:', error);
}

const ms = (value: number) => `${Math.round(value)}ms`;

/**
 * One `[flight]` line for a slow request. An action's line also says where
 * its time went, so a slow dashboard can be told apart from a busy worker.
 */
export function flightLogLine(event: RequestTimingEvent): string {
  const line = `[flight] ${event.type} ${event.pathname} ${event.status} ${ms(event.totalMs)}`;
  const action = event.action;
  if (!action) return line;
  return (
    `${line} action=${action.id} ${action.worker ? 'worker' : 'main'}` +
    ` queue=${ms(action.queueMs)} decode=${ms(action.decodeMs)}` +
    ` execute=${ms(action.executeMs)} serialize=${ms(action.serializeMs)}` +
    ` router=${ms(action.totalMs)}`
  );
}
