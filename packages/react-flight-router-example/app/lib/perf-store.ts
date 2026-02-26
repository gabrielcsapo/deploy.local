import type { RequestTimingEvent } from "react-flight-router/server";

const MAX_EVENTS = 200;
const events: RequestTimingEvent[] = [];

export function recordEvent(event: RequestTimingEvent) {
  events.push(event);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
}

/** Return the last N events (newest first) */
export function getEvents(limit = 50): RequestTimingEvent[] {
  return events.slice(-limit).reverse();
}

export function clearEvents() {
  events.length = 0;
}
