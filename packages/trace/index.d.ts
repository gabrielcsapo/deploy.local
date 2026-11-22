export interface SpanContext {
  readonly traceparent: string;
  span<T>(name: string, work: (span: SpanContext) => T): Promise<Awaited<T>>;
}
export interface RecordedSpan {
  name: string;
  spanId: string;
  parentSpanId: string;
  startMs: number;
  durationMs: number;
  failed?: boolean;
}
export interface RequestTrace extends SpanContext {
  readonly traceId: string;
  serverTiming(): string;
  clientEvent(
    requestId: string,
    route: string,
  ): {
    type: 'spans';
    requestId: string;
    route: string;
    traceId: string;
    spans: RecordedSpan[];
  };
}
export function startTrace(traceparent?: string | null): RequestTrace;
