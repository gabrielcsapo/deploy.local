import type { RequestTimingEvent } from "react-flight-router/server";

const MAX_EVENTS = 200;

// Use globalThis to ensure a single shared events array across module instances.
// In dev mode, vite.config.ts imports this module through Node's native require,
// while the API plugin loads it through Vite's ssrLoadModule — creating two
// separate module instances. globalThis bridges them.
const STORE_KEY = "__flight_perf_events__";

function getStore(): RequestTimingEvent[] {
  if (!(globalThis as any)[STORE_KEY]) {
    (globalThis as any)[STORE_KEY] = [];
  }
  return (globalThis as any)[STORE_KEY];
}

export function recordEvent(event: RequestTimingEvent) {
  const events = getStore();
  events.push(event);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
}

/** Return the last N events (newest first) */
export function getEvents(limit = 50): RequestTimingEvent[] {
  const events = getStore();
  return events.slice(-limit).reverse();
}

export function clearEvents() {
  const events = getStore();
  events.length = 0;
}
