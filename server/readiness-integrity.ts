import { Worker } from 'node:worker_threads';
import { packageWorkerFile } from './kernel/files/worker-file.ts';

export type IntegrityCheck =
  | 'ok'
  | 'integrity check pending'
  | 'integrity check failed'
  | 'integrity check unavailable';
export type IntegrityResult = Readonly<{ deploy: IntegrityCheck; workspace: IntegrityCheck }>;
export type IntegrityDatabases = { deploy: string; workspace: string };
type IntegrityWorker = Pick<Worker, 'unref' | 'terminate'> & {
  once(event: 'message', listener: (value: unknown) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
};

const unavailable: IntegrityResult = {
  deploy: 'integrity check unavailable',
  workspace: 'integrity check unavailable',
};

/** The request path only reads the last result; all scans happen in a disposable thread. */
export function startIntegrityChecks(
  databases: IntegrityDatabases,
  {
    createWorker = () =>
      new Worker(
        packageWorkerFile(
          import.meta.url,
          'readiness-integrity-worker.js',
          './readiness-integrity-worker.ts',
        ),
        {
          workerData: databases,
          // Standalone source (Node 26) and built workers need no launcher flags.
          // In particular, --input-type from an eval launcher is invalid for a file worker.
          execArgv: [],
        },
      ),
    stopGraceMs = 5000,
  }: { createWorker?: () => IntegrityWorker; stopGraceMs?: number } = {},
) {
  // Fail closed only until the immediate startup scan completes (normally seconds).
  // Activation already retries readiness 30 times at one-second intervals. Reporting ok
  // before any scan would admit a corrupt release; waiting ten minutes to start would time out.
  let result: IntegrityResult = {
    deploy: 'integrity check pending',
    workspace: 'integrity check pending',
  };
  let active: IntegrityWorker | undefined;
  let exited: Promise<void> = Promise.resolve();
  let stopped = false;
  function run() {
    if (stopped || active) return;
    try {
      const worker = createWorker();
      active = worker;
      let completed: IntegrityResult | undefined;
      let failed = false;
      worker.once('message', (value: unknown) => {
        const valid = (check: unknown) =>
          check === 'ok' ||
          check === 'integrity check failed' ||
          check === 'integrity check unavailable';
        if (
          value &&
          typeof value === 'object' &&
          'deploy' in value &&
          'workspace' in value &&
          valid(value.deploy) &&
          valid(value.workspace)
        ) {
          completed = { deploy: value.deploy, workspace: value.workspace } as IntegrityResult;
        }
      });
      worker.once('error', () => {
        failed = true;
        if (!stopped) result = unavailable;
      });
      exited = new Promise((resolve) =>
        worker.once('exit', (code) => {
          active = undefined;
          if (!stopped) result = !failed && code === 0 && completed ? completed : unavailable;
          resolve();
        }),
      );
      worker.unref();
    } catch {
      active = undefined;
      result = unavailable;
    }
  }
  const timer = setInterval(run, 10 * 60 * 1000);
  timer.unref();
  run();
  return {
    read: () => result,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (!active) return;
      // Let a running scan finish first (it takes about a second). Terminating the thread while
      // it is still loading the SQLite addon aborts the whole process (SIGABRT, no exit code),
      // which is how a SIGTERM soon after start could fail a shutdown.
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        exited,
        new Promise((resolve) => (grace = setTimeout(resolve, stopGraceMs))),
      ]);
      clearTimeout(grace);
      await active?.terminate();
    },
  };
}
