import type { ServerResponse } from 'node:http';
import { maybeCreateLogger, type FlightTimer } from '../shared/logger.js';
import type { RequestTimingEvent } from '../shared/types.js';
import {
  createTelemetryReporter,
  resolveTelemetryOptions,
  serverTiming,
  telemetryError,
  telemetryPhases,
} from '../server/telemetry.js';

/** Dev uses the same logger and wire format, with Node's response completion events. */
export function createDevRequestTiming(
  debug?: boolean,
  complete?: (event: RequestTimingEvent) => void,
) {
  const telemetry = resolveTelemetryOptions();
  const reporter = createTelemetryReporter(telemetry);
  const requests = new WeakMap<
    FlightTimer,
    {
      type: RequestTimingEvent['type'];
      t: number;
      route: string;
      match: number;
      errors: Set<unknown>;
      streaming?: boolean;
    }
  >();
  function error(logger: FlightTimer, where: 'rsc' | 'ssr' | 'action', value: unknown) {
    const state = requests.get(logger)!;
    if (
      !reporter ||
      state.errors.has(value) ||
      (value instanceof Error && value.name === 'AbortError')
    )
      return;
    state.errors.add(value);
    try {
      reporter.add(telemetryError(value, state.route, where));
    } catch {
      /* best effort */
    }
  }
  return {
    begin(type: RequestTimingEvent['type'], pathname: string, response: ServerResponse) {
      const logger = maybeCreateLogger(debug, true, !reporter && !complete)!;
      const state = {
        type,
        t: Date.now(),
        route: '__not_found',
        match: 0,
        errors: new Set<unknown>(),
      };
      requests.set(logger, state);
      logger.time('total');
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        response.off('finish', finish);
        response.off('close', finish);
        logger.timeEnd(
          type === 'SSR' ? 'ssr:stream' : type === 'RSC' ? 'rsc:stream' : 'action:stream',
        );
        logger.timeEnd('total');
        logger.flush(`${type} ${state.route} (dev)`);
        const entries = logger.getEntries();
        const totalMs = entries.find((entry) => entry.label === 'total')?.durationMs ?? 0;
        const aborted = !response.writableFinished;
        reporter?.add({
          t: state.t,
          kind: type === 'SSR' ? 'page' : type === 'RSC' ? 'rsc' : 'action',
          route: state.route,
          status: response.statusCode,
          ms: totalMs,
          phases: telemetryPhases(entries),
          build: null,
          aborted,
        });
        try {
          complete?.({
            type,
            pathname,
            status: response.statusCode,
            totalMs,
            timings: entries.filter((entry) => entry.label !== 'total'),
            timestamp: new Date().toISOString(),
            ...(aborted ? { cancelled: true } : {}),
          });
        } catch (error) {
          console.error('[react-flight-router] onRequestComplete callback error:', error);
        }
      };
      response.once('finish', finish);
      response.once('close', finish);
      return logger;
    },
    headers(logger: FlightTimer, response: ServerResponse) {
      if (response.headersSent) return;
      const state = requests.get(logger)!;
      if (!state.streaming) {
        state.streaming = true;
        logger.time(
          state.type === 'SSR'
            ? 'ssr:stream'
            : state.type === 'RSC'
              ? 'rsc:stream'
              : 'action:stream',
        );
      }
      const entries = logger.getEntries(false);
      const elapsed = entries.find((entry) => entry.label === 'total')?.durationMs ?? 0;
      const action = entries.filter(
        (entry) => entry.label.startsWith('action:execute(') && entry.durationMs !== undefined,
      );
      response.setHeader(
        'Server-Timing',
        state.type === 'ACTION'
          ? serverTiming(
              state.route,
              undefined,
              undefined,
              action.length
                ? action.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0)
                : undefined,
            )
          : serverTiming(state.route, state.match, elapsed),
      );
    },
    action(logger: FlightTimer, id: string) {
      requests.get(logger)!.route = `action:${id}`;
    },
    hooks(logger: FlightTimer) {
      return {
        telemetry: !!reporter,
        beaconPath: reporter && telemetry.beaconPath !== false ? telemetry.beaconPath : undefined,
        onMatch(route: string, duration: number) {
          const state = requests.get(logger)!;
          if (state.type !== 'ACTION') {
            state.route = route;
            state.match = duration;
          }
        },
        onError: (value: unknown) => error(logger, 'rsc', value),
      };
    },
    error,
    close() {
      void reporter?.flush();
      reporter?.close();
    },
  };
}
export type DevTimingHooks = ReturnType<ReturnType<typeof createDevRequestTiming>['hooks']> & {
  signal?: AbortSignal;
};
