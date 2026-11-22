import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface Attempt {
  spanId: string;
  startMs: number;
  socketMs?: number;
  connectedMs?: number;
  reused?: boolean;
  headersMs?: number;
  endMs?: number;
  status?: number;
  error?: 'timeout' | 'refused' | 'reset' | 'transport';
}

export interface Wait {
  reason: 'route-publication' | 'retry-backoff';
  startMs: number;
  endMs?: number;
}

export function startRequestTrace(req: IncomingMessage, start = performance.now()) {
  const requestId = randomUUID().replaceAll('-', '');
  const input = req.headers.traceparent;
  const parent =
    typeof input === 'string' && /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(input);
  const valid = parent && !/^0+$/.test(parent[1]) && !/^0+$/.test(parent[2]) ? parent : null;
  const traceId = valid?.[1] ?? requestId;
  const spanId = randomBytes(8).toString('hex');
  const attempts: Attempt[] = [];
  const waits: Wait[] = [];
  // All offsets share one monotonic edge clock, including retries.
  const elapsed = () => Math.round((performance.now() - start) * 100) / 100;
  return {
    requestId,
    traceId,
    spanId,
    parentSpanId: valid?.[2],
    // Match the edge's existing one-in-256 retention decision for new root traces.
    flags: valid?.[3] ?? (requestId.startsWith('00') ? '01' : '00'),
    attempts,
    waits,
    elapsed,
    cache: 'bypass' as 'hit' | 'miss' | 'bypass',
    headerTiming() {
      let value = `edge-headers;dur=${elapsed()}`;
      for (const wait of waits) {
        if (wait.endMs !== undefined)
          value += `, ${wait.reason};dur=${(wait.endMs - wait.startMs).toFixed(2)}`;
      }
      return value;
    },
    attempt(): Attempt {
      const attempt = { spanId: randomBytes(8).toString('hex'), startMs: elapsed() };
      attempts.push(attempt);
      return attempt;
    },
  };
}
