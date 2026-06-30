/**
 * Last-resort crash containment for the server process.
 *
 * This process is the network's ingress: if it dies, every *.local app
 * disappears (TLS, routing, and mDNS all live here). An uncaught exception
 * from one subsystem (a bad RSC render, a WS edge case) should not take the
 * proxy down with it — log loudly and keep serving.
 *
 * Escape hatch: if exceptions arrive in a hot loop (>25 in 60s) the process
 * is genuinely wedged — exit non-zero so the supervisor (launchd/systemd)
 * restarts us into a clean state instead of spinning.
 */

const WINDOW_MS = 60_000;
const MAX_EXCEPTIONS_PER_WINDOW = 25;

let recentExceptions: number[] = [];

export function installCrashGuard() {
  process.on('uncaughtException', (err, origin) => {
    console.error(`[crash-guard] uncaughtException (${origin}):`, err);

    const now = Date.now();
    recentExceptions = recentExceptions.filter((t) => now - t < WINDOW_MS);
    recentExceptions.push(now);
    if (recentExceptions.length > MAX_EXCEPTIONS_PER_WINDOW) {
      console.error(
        `[crash-guard] ${recentExceptions.length} uncaught exceptions in ${WINDOW_MS / 1000}s — exiting for supervisor restart`,
      );
      process.exit(1);
    }
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[crash-guard] unhandledRejection:', reason);
  });
}
