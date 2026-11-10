import { Worker, MessageChannel } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { ErrorRecord } from './telemetry.js';
import type { ActionTimings, TimingEntry } from '../shared/types.js';
import type { SerializedRequestContext } from '../shared/types.js';

/** Internal task dispatched to a worker */
export interface ActionTask {
  taskId: string;
  actionId: string;
  body: ArrayBuffer;
  contentType: string;
  requestContext: SerializedRequestContext;
}

export interface WorkerCompletion {
  status: number;
  error?: string;
  errorRecord?: ErrorRecord;
  timings?: TimingEntry[];
  /** Where the action's time went; absent when the worker never answered. */
  action?: ActionTimings;
}

/** Phases the worker measures; the pool adds `totalMs` and `worker`. */
export type WorkerPhaseTimings = Pick<
  ActionTimings,
  'queueMs' | 'decodeMs' | 'executeMs' | 'serializeMs'
>;

/** How the worker answered, known before any byte of the response is sent. */
export type DispatchHead =
  | { kind: 'stream' }
  | { kind: 'error'; status: number; message: string; digest?: string }
  | { kind: 'redirect'; url: string; status: 301 | 302 };

/** Result of dispatching a task to the worker pool */
export interface DispatchResult {
  /** Readable stream of RSC chunks from the worker */
  stream: ReadableStream<Uint8Array>;
  /**
   * Resolves with the worker's first answer: the result is streaming, the
   * action threw (with the status and message to send), or it redirected.
   * Lets the host choose the HTTP status before it responds.
   */
  head: Promise<DispatchHead>;
  /** Resolves with the response status when the worker finishes */
  done: Promise<WorkerCompletion>;
}

interface ManagedWorker {
  worker: Worker;
  pendingTasks: number;
  /** Map of taskId → AbortController for cancellation */
  taskAborts: Map<string, () => void>;
}

interface WorkerPoolConfig {
  buildDir: string;
  size?: number;
  timeout?: number;
  /** Reporting enabled by the parent; workers never resolve telemetry environment values. */
  telemetry?: boolean;
}

export interface WorkerPool {
  dispatch(task: ActionTask): DispatchResult;
  abort(taskId: string): void;
  destroy(): Promise<void>;
}

const DEFAULT_POOL_SIZE = 1;
const DEFAULT_TIMEOUT = 30_000;

/**
 * Create a pool of worker threads for executing server actions.
 * Workers are initialized with the RSC runtime and action modules
 * from the build directory, mirroring the main thread's setup.
 *
 * No thread starts until the first dispatch, which waits for them; a failed
 * start fails that dispatch and the next one tries again.
 */
export function createWorkerPool(config: WorkerPoolConfig): WorkerPool {
  const poolSize = config.size ?? DEFAULT_POOL_SIZE;
  const timeout = config.timeout ?? DEFAULT_TIMEOUT;
  const workerPath = fileURLToPath(new URL('./action-worker.js', import.meta.url));

  const workers: ManagedWorker[] = [];

  // Track which worker is handling which task (for abort routing)
  const taskToWorker = new Map<string, ManagedWorker>();

  function spawnWorker(): Promise<ManagedWorker> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: { buildDir: config.buildDir, telemetry: config.telemetry ?? false },
      });

      const managed: ManagedWorker = {
        worker,
        pendingTasks: 0,
        taskAborts: new Map(),
      };

      const onMessage = (msg: { type: string; message?: string }) => {
        if (msg.type === 'ready') {
          worker.off('message', onMessage);
          worker.off('error', onError);
          resolve(managed);
        } else if (msg.type === 'init-error') {
          worker.off('message', onMessage);
          worker.off('error', onError);
          reject(new Error(`Worker initialization failed: ${msg.message}`));
        }
      };

      const onError = (err: Error) => {
        worker.off('message', onMessage);
        reject(err);
      };

      worker.on('message', onMessage);
      worker.on('error', onError);

      // Handle unexpected worker exit — replace the worker
      worker.on('exit', (code) => {
        const idx = workers.indexOf(managed);
        if (idx === -1) return; // Already removed (destroy)

        // Reject all pending tasks for this worker
        for (const [taskId, abortFn] of managed.taskAborts) {
          abortFn();
          taskToWorker.delete(taskId);
        }
        managed.taskAborts.clear();

        // Replace with a new worker (fire and forget — log errors)
        if (!destroyed) {
          spawnWorker()
            .then((replacement) => {
              workers[idx] = replacement;
            })
            .catch((err) => {
              console.error(
                `[react-flight-router] Failed to replace crashed worker (exit code ${code}):`,
                err,
              );
            });
        }
      });
    });
  }

  let destroyed = false;
  let starting: Promise<void> | null = null;
  function start(): Promise<void> {
    starting ??= Promise.all(Array.from({ length: poolSize }, () => spawnWorker())).then(
      (spawned) => {
        if (destroyed) {
          for (const managed of spawned) void managed.worker.terminate();
          throw new Error('Worker pool has been destroyed');
        }
        workers.push(...spawned);
      },
      (error) => {
        starting = null;
        throw error;
      },
    );
    return starting;
  }
  /** Aborts that arrived while their task waited for the pool to start. */
  const earlyAborts = new Set<string>();

  function pickWorker(): ManagedWorker {
    // Least-busy: pick the worker with fewest pending tasks
    let best = workers[0];
    for (let i = 1; i < workers.length; i++) {
      if (workers[i].pendingTasks < best.pendingTasks) {
        best = workers[i];
      }
    }
    return best;
  }

  function dispatch(task: ActionTask): DispatchResult {
    if (destroyed) {
      throw new Error('Worker pool has been destroyed');
    }
    const dispatchedAt = performance.now();
    if (workers.length > 0) return dispatchTo(pickWorker(), task, dispatchedAt);

    // First action: start the threads, then hand the task over.
    const pending = start().then(() => {
      const result = dispatchTo(pickWorker(), task, dispatchedAt);
      if (earlyAborts.delete(task.taskId)) abort(task.taskId);
      return result;
    });
    const failed = (error: unknown) => {
      earlyAborts.delete(task.taskId);
      return error instanceof Error ? error.message : String(error);
    };
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    pending.then(
      (result) => result.stream.pipeTo(writable).catch(() => {}),
      (error) => void writable.abort(error).catch(() => {}),
    );
    return {
      stream: readable,
      head: pending.then(
        (result) => result.head,
        (error) => ({ kind: 'error' as const, status: 500, message: failed(error) }),
      ),
      done: pending.then(
        (result) => result.done,
        (error) => ({ status: 500, error: failed(error) }),
      ),
    };
  }

  function dispatchTo(
    managed: ManagedWorker,
    task: ActionTask,
    dispatchedAt: number,
  ): DispatchResult {
    const { port1: mainPort, port2: workerPort } = new MessageChannel();

    managed.pendingTasks++;
    taskToWorker.set(task.taskId, managed);

    // Set up timeout
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    let resolveStatus: (result: WorkerCompletion) => void;
    const done = new Promise<WorkerCompletion>((resolve) => {
      resolveStatus = resolve;
    });
    let resolveHead: (head: DispatchHead) => void;
    const head = new Promise<DispatchHead>((resolve) => {
      resolveHead = resolve;
    });

    let cleaned = false;
    function cleanup() {
      // A timed-out task can still be cancelled by its reader; count it once.
      if (cleaned) return;
      cleaned = true;
      if (timeoutId) clearTimeout(timeoutId);
      managed.pendingTasks--;
      managed.taskAborts.delete(task.taskId);
      taskToWorker.delete(task.taskId);
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Set up the abort function for this task
        managed.taskAborts.set(task.taskId, () => {
          resolveHead({ kind: 'error', status: 500, message: 'Worker crashed or was terminated' });
          controller.error(new Error('Worker crashed or was terminated'));
          mainPort.close();
          cleanup();
          resolveStatus({ status: 500, error: 'Worker crashed' });
        });

        mainPort.on(
          'message',
          (msg: {
            type: string;
            data?: ArrayBuffer;
            status?: number;
            message?: string;
            digest?: string;
            url?: string;
            redirectStatus?: 301 | 302;
            errorRecord?: ErrorRecord;
            timings?: TimingEntry[];
            actionTimings?: WorkerPhaseTimings;
          }) => {
            const action = msg.actionTimings
              ? {
                  ...msg.actionTimings,
                  id: task.actionId,
                  worker: true,
                  totalMs: performance.now() - dispatchedAt,
                }
              : undefined;
            const measured = action ? { action } : {};
            switch (msg.type) {
              case 'chunk':
                resolveHead({ kind: 'stream' });
                controller.enqueue(new Uint8Array(msg.data!));
                break;
              case 'done':
                resolveHead({ kind: 'stream' });
                controller.close();
                mainPort.close();
                cleanup();
                resolveStatus({
                  status: 200,
                  ...(msg.errorRecord ? { errorRecord: msg.errorRecord } : {}),
                  ...(msg.timings ? { timings: msg.timings } : {}),
                  ...measured,
                });
                break;
              case 'redirect':
                resolveHead({
                  kind: 'redirect',
                  url: msg.url!,
                  status: msg.redirectStatus ?? 302,
                });
                controller.close();
                mainPort.close();
                cleanup();
                resolveStatus({
                  status: 200,
                  ...(msg.timings ? { timings: msg.timings } : {}),
                  ...measured,
                });
                break;
              case 'error':
                resolveHead({
                  kind: 'error',
                  status: msg.status ?? 500,
                  message: msg.message ?? 'Internal server error',
                  ...(msg.digest ? { digest: msg.digest } : {}),
                });
                controller.error(new Error(msg.message));
                mainPort.close();
                cleanup();
                resolveStatus({
                  status: msg.status ?? 500,
                  error: msg.message,
                  ...(msg.errorRecord ? { errorRecord: msg.errorRecord } : {}),
                  ...(msg.timings ? { timings: msg.timings } : {}),
                  ...measured,
                });
                break;
            }
          },
        );

        mainPort.on('close', () => {
          // If the port closes without a done/error message, treat as error
          resolveHead({ kind: 'stream' });
          try {
            controller.close();
          } catch {
            // Already closed or errored
          }
        });

        // Start timeout
        timeoutId = setTimeout(() => {
          managed.worker.postMessage({ type: 'abort', taskId: task.taskId });
          resolveHead({ kind: 'error', status: 504, message: 'Action execution timed out' });
          try {
            controller.error(new Error('Action execution timed out'));
          } catch {
            // Already closed
          }
          mainPort.close();
          cleanup();
          resolveStatus({ status: 504, error: 'Action execution timed out' });
        }, timeout);
      },
      cancel() {
        // Client disconnected — tell worker to abort
        managed.worker.postMessage({ type: 'abort', taskId: task.taskId });
        resolveHead({ kind: 'stream' });
        mainPort.close();
        cleanup();
        resolveStatus({ status: 200 }); // Client-initiated cancel is not an error
      },
    });

    // Send the task to the worker
    // Transfer the body ArrayBuffer and the MessagePort for zero-copy
    const bodyBuffer = task.body instanceof ArrayBuffer ? task.body : (task.body as ArrayBuffer);

    managed.worker.postMessage(
      {
        type: 'execute',
        taskId: task.taskId,
        actionId: task.actionId,
        contentType: task.contentType,
        body: bodyBuffer,
        requestContext: task.requestContext,
        resultPort: workerPort,
        // Epoch time, comparable across threads, so the worker can tell how
        // long the task waited for its thread.
        queuedAt: performance.timeOrigin + dispatchedAt,
      },
      [bodyBuffer, workerPort],
    );

    return { stream, head, done };
  }

  function abort(taskId: string) {
    const managed = taskToWorker.get(taskId);
    if (managed) {
      managed.worker.postMessage({ type: 'abort', taskId });
    } else if (starting && workers.length === 0) {
      earlyAborts.add(taskId);
    }
  }

  async function destroy(): Promise<void> {
    destroyed = true;
    const terminations = workers.map((managed) => {
      return new Promise<void>((resolve) => {
        // Give workers a short grace period to finish pending work
        const forceTimer = setTimeout(() => {
          managed.worker.terminate().then(() => resolve());
        }, 5_000);

        managed.worker.once('exit', () => {
          clearTimeout(forceTimer);
          resolve();
        });

        // Ask workers to exit gracefully
        managed.worker.postMessage({ type: 'shutdown' });
      });
    });

    // Remove all workers from the pool
    workers.length = 0;

    await Promise.all(terminations);
  }

  return { dispatch, abort, destroy };
}
