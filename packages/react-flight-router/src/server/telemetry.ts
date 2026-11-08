import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import type { TimingEntry } from '../shared/types.js';
import { normalizeError } from '../shared/telemetry-error.js';

export interface RequestRecord {
  t: number;
  kind: 'page' | 'rsc' | 'action';
  route: string;
  status: number;
  ms: number;
  phases: Partial<Record<'match' | 'rsc' | 'ssr' | 'stream' | 'action', number>>;
  build: string | null;
  aborted: boolean;
}
export interface ErrorRecord {
  t: number;
  kind: 'error';
  route: string;
  where: 'rsc' | 'ssr' | 'action';
  name: string;
  message: string;
  stack: string;
  fingerprint: string;
}
export type TelemetryRecord = RequestRecord | ErrorRecord;

export function telemetryError(
  error: unknown,
  route: string,
  where: ErrorRecord['where'],
  t = Date.now(),
): ErrorRecord {
  const normalized = normalizeError(error, (path) =>
    relative(process.cwd(), path).replaceAll('\\', '/'),
  );
  return {
    t,
    kind: 'error',
    route,
    where,
    ...normalized.fields,
    fingerprint: createHash('sha1').update(normalized.fingerprintInput).digest('hex'),
  };
}

const ms = (duration: number) => String(Math.round(Math.max(0, duration) * 100) / 100);
export function serverTiming(
  route: string,
  match?: number,
  render?: number,
  action?: number,
): string {
  // RFC 8941 sf-string: printable ASCII, escaping DQUOTE and backslash.
  const escaped = route.replace(/[^\x20-\x7e]/g, '?').replace(/["\\]/g, '\\$&');
  return (
    `route;desc="${escaped}"` +
    (match === undefined ? '' : `, match;dur=${ms(match)}`) +
    (render === undefined ? '' : `, render;dur=${ms(render)}`) +
    (action === undefined ? '' : `, action;dur=${ms(action)}`)
  );
}

export function telemetryPhases(entries: TimingEntry[]): RequestRecord['phases'] {
  const phases: RequestRecord['phases'] = {};
  for (const entry of entries) {
    let phase: keyof RequestRecord['phases'] | undefined;
    if (entry.label === 'matchRoutes') phase = 'match';
    else if (entry.label.endsWith(':stream')) phase = 'stream';
    else if (
      entry.label === 'buildSegmentMap' ||
      entry.label === 'buildBoundaryComponents' ||
      entry.label.startsWith('rsc:')
    )
      phase = 'rsc';
    else if (entry.label.startsWith('ssr:')) phase = 'ssr';
    else if (entry.label.startsWith('action:')) phase = 'action';
    if (phase && entry.durationMs !== undefined)
      phases[phase] = (phases[phase] ?? 0) + entry.durationMs;
  }
  return phases;
}

export function createTelemetryReporter(env: Record<string, string | undefined> = process.env) {
  const url = env.DEPLOY_TELEMETRY_URL;
  if (!url) return undefined;
  const endpoint = `${url.replace(/\/+$/, '')}/v1/server`;
  const records: TelemetryRecord[] = [];
  let inFlight: Promise<void> | undefined;
  let dropped = 0;
  let lastWarning = -Infinity;
  let closed = false;
  const flush = (): Promise<void> | undefined => {
    if (inFlight || records.length === 0) return inFlight;
    const batch = records.splice(0);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    timeout.unref();
    inFlight = (async () => {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${env.DEPLOY_TELEMETRY_TOKEN ?? ''}`,
          },
          body: JSON.stringify({ v: 1, records: batch }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Telemetry rejected');
        await response.body?.cancel();
      } catch {
        if (Date.now() - lastWarning >= 600_000) {
          lastWarning = Date.now();
          console.warn('[react-flight-router] Telemetry batch dropped');
        }
      } finally {
        clearTimeout(timeout);
      }
    })().finally(() => {
      inFlight = undefined;
      if (!closed && records.length >= 100) void flush();
    });
    return inFlight;
  };
  const timer = setInterval(() => {
    void flush();
  }, 5000);
  timer.unref();
  // beforeExit allows the final POST to complete; exit can only start best effort IO.
  const onExit = () => {
    void flush();
  };
  process.on('beforeExit', onExit);
  process.on('exit', onExit);
  return {
    add(record: TelemetryRecord) {
      if (closed) return;
      if (records.length >= 1000) {
        records.shift();
        dropped++;
      }
      records.push(record);
      if (records.length >= 100) void flush();
    },
    flush,
    get dropped() {
      return dropped;
    },
    close() {
      closed = true;
      clearInterval(timer);
      process.off('beforeExit', onExit);
      process.off('exit', onExit);
    },
  };
}
