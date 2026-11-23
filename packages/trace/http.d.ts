import type { SpanContext } from './index.js';
export type HttpSpan = ((method: string, route: string, status: number) => object) & {
  phases: SpanContext;
  children(): object[];
};
export declare function startHttpSpan(parent: unknown): HttpSpan | undefined;
export declare function httpBatch(service: string, spans: object[]): object;
export declare function bufferedExporter(
  send: (spans: object[]) => Promise<unknown>,
): (span: object) => void;
