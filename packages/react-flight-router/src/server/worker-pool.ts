import { Worker, MessageChannel } from "node:worker_threads";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import type { SerializedRequestContext, WorkerOptions } from "../shared/types.js";

/** Internal task dispatched to a worker */
export interface ActionTask {
  taskId: string;
  actionId: string;
  body: ArrayBuffer;
  contentType: string;
  requestContext: SerializedRequestContext;
}

/** Result of dispatching a task to the worker pool */
export interface DispatchResult {
  /** Readable stream of RSC chunks from the worker */
  stream: ReadableStream<Uint8Array>;
  /** Resolves with the response status when the worker finishes */
  done: Promise<{ status: number; error?: string }>;
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
}

export interface WorkerPool {
  dispatch(task: ActionTask): DispatchResult;
  abort(taskId: string): void;
  destroy(): Promise<void>;
}

const DEFAULT_POOL_SIZE = Math.max(1, cpus().length - 1);
const DEFAULT_TIMEOUT = 30_000;

/**
 * Create a pool of worker threads for executing server actions.
 * Workers are initialized with the RSC runtime and action modules
 * from the build directory, mirroring the main thread's setup.
 */
export async function createWorkerPool(config: WorkerPoolConfig): Promise<WorkerPool> {
  const poolSize = config.size ?? DEFAULT_POOL_SIZE;
  const timeout = config.timeout ?? DEFAULT_TIMEOUT;
  const workerPath = fileURLToPath(new URL("./action-worker.js", import.meta.url));

  const workers: ManagedWorker[] = [];

  // Track which worker is handling which task (for abort routing)
  const taskToWorker = new Map<string, ManagedWorker>();

  function spawnWorker(): Promise<ManagedWorker> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: { buildDir: config.buildDir },
      });

      const managed: ManagedWorker = {
        worker,
        pendingTasks: 0,
        taskAborts: new Map(),
      };

      const onMessage = (msg: { type: string; message?: string }) => {
        if (msg.type === "ready") {
          worker.off("message", onMessage);
          worker.off("error", onError);
          resolve(managed);
        } else if (msg.type === "init-error") {
          worker.off("message", onMessage);
          worker.off("error", onError);
          reject(new Error(`Worker initialization failed: ${msg.message}`));
        }
      };

      const onError = (err: Error) => {
        worker.off("message", onMessage);
        reject(err);
      };

      worker.on("message", onMessage);
      worker.on("error", onError);

      // Handle unexpected worker exit — replace the worker
      worker.on("exit", (code) => {
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

  // Initialize all workers in parallel
  const spawned = await Promise.all(Array.from({ length: poolSize }, () => spawnWorker()));
  workers.push(...spawned);

  let destroyed = false;

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
      throw new Error("Worker pool has been destroyed");
    }

    const managed = pickWorker();
    const { port1: mainPort, port2: workerPort } = new MessageChannel();

    managed.pendingTasks++;
    taskToWorker.set(task.taskId, managed);

    // Set up timeout
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    let resolveStatus: (result: { status: number; error?: string }) => void;
    const done = new Promise<{ status: number; error?: string }>((resolve) => {
      resolveStatus = resolve;
    });

    function cleanup() {
      if (timeoutId) clearTimeout(timeoutId);
      managed.pendingTasks--;
      managed.taskAborts.delete(task.taskId);
      taskToWorker.delete(task.taskId);
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Set up the abort function for this task
        managed.taskAborts.set(task.taskId, () => {
          controller.error(new Error("Worker crashed or was terminated"));
          mainPort.close();
          cleanup();
          resolveStatus({ status: 500, error: "Worker crashed" });
        });

        mainPort.on(
          "message",
          (msg: { type: string; data?: ArrayBuffer; status?: number; message?: string }) => {
            switch (msg.type) {
              case "chunk":
                controller.enqueue(new Uint8Array(msg.data!));
                break;
              case "done":
                controller.close();
                mainPort.close();
                cleanup();
                resolveStatus({ status: 200 });
                break;
              case "error":
                controller.error(new Error(msg.message));
                mainPort.close();
                cleanup();
                resolveStatus({ status: msg.status ?? 500, error: msg.message });
                break;
            }
          },
        );

        mainPort.on("close", () => {
          // If the port closes without a done/error message, treat as error
          try {
            controller.close();
          } catch {
            // Already closed or errored
          }
        });

        // Start timeout
        timeoutId = setTimeout(() => {
          managed.worker.postMessage({ type: "abort", taskId: task.taskId });
          try {
            controller.error(new Error("Action execution timed out"));
          } catch {
            // Already closed
          }
          mainPort.close();
          cleanup();
          resolveStatus({ status: 504, error: "Action execution timed out" });
        }, timeout);
      },
      cancel() {
        // Client disconnected — tell worker to abort
        managed.worker.postMessage({ type: "abort", taskId: task.taskId });
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
        type: "execute",
        taskId: task.taskId,
        actionId: task.actionId,
        contentType: task.contentType,
        body: bodyBuffer,
        requestContext: task.requestContext,
        resultPort: workerPort,
      },
      [bodyBuffer, workerPort],
    );

    return { stream, done };
  }

  function abort(taskId: string) {
    const managed = taskToWorker.get(taskId);
    if (managed) {
      managed.worker.postMessage({ type: "abort", taskId });
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

        managed.worker.once("exit", () => {
          clearTimeout(forceTimer);
          resolve();
        });

        // Ask workers to exit gracefully
        managed.worker.postMessage({ type: "shutdown" });
      });
    });

    // Remove all workers from the pool
    workers.length = 0;

    await Promise.all(terminations);
  }

  return { dispatch, abort, destroy };
}
