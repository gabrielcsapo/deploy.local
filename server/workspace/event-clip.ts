/**
 * One event (e.g. a tool result holding an image the agent viewed) can outgrow a request on its
 * own; shorten its long strings so it still delivers, keeping the event's shape.
 */
export function clipEvent(entry: any, limit = 256_000) {
  if (JSON.stringify(entry).length <= limit) return entry;
  const clip = (value: any): any =>
    typeof value === 'string'
      ? value.length > 4000
        ? `${value.slice(0, 2000)}… [${value.length - 2000} characters omitted]`
        : value
      : Array.isArray(value)
        ? value.map(clip)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clip(item)]))
          : value;
  return { ...entry, payload: clip(entry.payload), clipped: true };
}
