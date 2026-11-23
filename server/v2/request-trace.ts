import type { ServerResponse } from 'node:http';
import type { HttpSpan } from '../../packages/trace/http.js';
import type { SpanContext } from '../../packages/trace/index.js';

export const requestSpans = new WeakMap<ServerResponse, HttpSpan>();

export async function requestPhase<T>(
  trace: SpanContext | undefined,
  name: string,
  work: (phase: SpanContext | undefined) => Promise<T>,
): Promise<T> {
  return trace ? trace.span(name, work) : work(undefined);
}
