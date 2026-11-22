type Attributes = Record<string, string | number | boolean>;
type SpanEvent = { name: string; timeUnixNano: string; attributes?: Attributes };
type OtelSpan = {
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  service: string;
  scope: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: number;
  attributes: Attributes;
  events: SpanEvent[];
};
type Attempt = { spanId: string; startMs: number; endMs?: number; status?: number; error?: string };
type Edge = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  endMs: number;
  attempts: Attempt[];
  cache: string;
};
export type TraceDetail = {
  spans: OtelSpan[];
  requests?: { method: string; status: number; timestamp: number; trace: Edge }[];
  truncated: boolean;
};
export type TraceRow = {
  id: string;
  parent?: string | null;
  name: string;
  service: string;
  start: number;
  end: number;
  status: string;
  attributes: Attributes;
  events: { at: number; name: string; attributes?: Attributes }[];
};
const millis = (nanos: string) => Number(BigInt(nanos)) / 1e6;
export function timeline(data: TraceDetail) {
  const byId = new Map<string, TraceRow>();
  for (const span of data.spans ?? []) {
    byId.set(span.spanId, {
      id: span.spanId,
      parent: span.parentSpanId,
      name: span.name,
      service: span.service || 'Unknown service',
      start: millis(span.startTimeUnixNano),
      end: millis(span.endTimeUnixNano),
      status: ['Unset', 'OK', 'Error'][span.status] ?? 'Unset',
      attributes: span.attributes,
      events: span.events
        .map((event) => ({
          name: event.name,
          at: millis(event.timeUnixNano),
          attributes: event.attributes,
        }))
        .sort((a, b) => a.at - b.at),
    });
  }
  for (const request of data.requests ?? []) {
    const trace = request.trace;
    if (!trace?.spanId || !Number.isFinite(trace.endMs)) continue;
    const end = request.timestamp,
      start = end - trace.endMs;
    byId.set(trace.spanId, {
      id: trace.spanId,
      parent: trace.parentSpanId,
      name: request.method + ' request',
      service: 'Edge',
      start,
      end,
      status: request.status >= 400 ? 'Error' : 'OK',
      attributes: { 'http.response.status_code': request.status, cache: trace.cache },
      events: [],
    });
    for (const attempt of trace.attempts ?? []) {
      byId.set(attempt.spanId, {
        id: attempt.spanId,
        parent: trace.spanId,
        name: 'Upstream attempt',
        service: 'Edge',
        start: start + attempt.startMs,
        end: start + (attempt.endMs ?? attempt.startMs),
        status:
          attempt.error || (attempt.status ?? 0) >= 400
            ? 'Error'
            : attempt.endMs === undefined
              ? 'Unset'
              : 'OK',
        attributes: {
          ...(attempt.error ? { 'error.type': attempt.error } : {}),
          ...(attempt.status ? { 'http.response.status_code': attempt.status } : {}),
        },
        events: [],
      });
    }
  }
  const children = new Map<string, TraceRow[]>(),
    all = [...byId.values()].sort((a, b) => a.start - b.start || b.end - a.end);
  for (const row of all) {
    const parent = row.parent && byId.has(row.parent) ? row.parent : '';
    const list = children.get(parent) ?? [];
    list.push(row);
    children.set(parent, list);
  }
  return {
    byId,
    all,
    children,
    partial: data.truncated || all.some((row) => row.parent && !byId.has(row.parent)),
  };
}

// Traverse iteratively. Partial or malformed exports can have missing parents, deep trees or cycles.
export function visibleRows(
  model: ReturnType<typeof timeline>,
  focus: string | undefined,
  collapsed: Set<string>,
) {
  const result: { row: TraceRow; depth: number }[] = [],
    seen = new Set<string>();
  const roots = focus ? [model.byId.get(focus)!] : (model.children.get('') ?? []);
  function visit(root: TraceRow) {
    const stack = [{ row: root, depth: 0 }];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next.row.id)) continue;
      seen.add(next.row.id);
      result.push(next);
      if (!collapsed.has(next.row.id))
        for (const row of [...(model.children.get(next.row.id) ?? [])].reverse())
          stack.push({ row, depth: next.depth + 1 });
    }
  }
  for (const root of roots) if (root) visit(root);
  if (!focus && !collapsed.size) for (const row of model.all) if (!seen.has(row.id)) visit(row);
  return result;
}
