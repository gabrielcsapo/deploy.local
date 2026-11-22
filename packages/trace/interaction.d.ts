export interface InteractionSpan {
  spanId: string;
  parentSpanId: string;
  name: string;
  startMs: number;
  durationMs: number;
  failed?: boolean;
  statusCode?: number;
}
export interface InteractionEvent {
  traceId: string;
  spanId: string;
  name: string;
  outcome: 'ok' | 'error' | 'cancelled';
  milestone: string;
  startedAtUnixMs?: number;
  durationMs: number;
  platform: 'web' | 'apple';
  spans: InteractionSpan[];
}
type Options = {
  origin: string;
  scope: string;
  storage?: Storage;
} & (
  | { send: (event: InteractionEvent) => Promise<boolean>; sendBatch?: never }
  | { sendBatch: (events: InteractionEvent[]) => Promise<boolean>; send?: never }
);
export declare function interactionTracer(options: Options): {
  flush: () => Promise<void>;
  close(clear?: boolean): void;
  start(
    name: string,
    startedAt?: number,
  ): {
    traceId: string;
    traceparent: string;
    span: <T>(name: string, work: (parent: string) => Promise<T>) => Promise<T>;
    navigation(to: string): void;
    fetch(input: string, init?: RequestInit, request?: typeof fetch): Promise<Response>;
    finish(milestone: string, outcome?: InteractionEvent['outcome']): void;
  };
};
export type Interaction = ReturnType<ReturnType<typeof interactionTracer>['start']>;
export {};
