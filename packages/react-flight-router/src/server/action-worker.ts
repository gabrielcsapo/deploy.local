/**
 * Worker thread entry point for executing server actions off the main thread.
 *
 * Each worker mirrors the main thread's action setup:
 * 1. Loads manifests (server-actions, rsc-client)
 * 2. Imports RSC runtime (renderToReadableStream, decodeReply)
 * 3. Pre-imports server-action-*.js to populate __flight_server_modules
 * 4. Listens for execute/abort messages from the main thread
 *
 * Results are streamed back via a per-task MessagePort using zero-copy
 * ArrayBuffer transfers.
 */

import { parentPort, workerData } from "node:worker_threads";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { MessagePort } from "node:worker_threads";
import type { SerializedRequestContext } from "../shared/types.js";
import { requestStorage } from "./request-context.js";

if (!parentPort) {
  throw new Error("action-worker.ts must be run as a worker thread");
}

const { buildDir } = workerData as { buildDir: string };

// --- Initialization (mirrors index.ts setup) ---

// 1. Load manifests
const serverActionsManifest = JSON.parse(
  readFileSync(resolve(buildDir, "server-actions-manifest.json"), "utf-8"),
);
const rscClientManifest = JSON.parse(
  readFileSync(resolve(buildDir, "rsc-client-manifest.json"), "utf-8"),
);

// 2. Import RSC runtime (pre-built with react-server conditions)
const rscRuntime = await import(resolve(buildDir, "server/rsc-runtime.js"));
const { renderToReadableStream, decodeReply } = rscRuntime as {
  renderToReadableStream: (
    model: unknown,
    webpackMap: unknown,
    options?: { onError?: (error: unknown) => void },
  ) => ReadableStream;
  decodeReply: (body: string | FormData, manifest: unknown) => Promise<unknown[]>;
};

// 3. Pre-import server action entry files to populate globalThis.__flight_server_modules
const serverDir = resolve(buildDir, "server");
const actionEntries = readdirSync(serverDir).filter(
  (f) => f.startsWith("server-action-") && f.endsWith(".js"),
);
for (const entry of actionEntries) {
  await import(resolve(serverDir, entry));
}

// 4. Module loader (same logic as index.ts)
const loadModule = async (id: string): Promise<Record<string, unknown>> => {
  const registry = (globalThis as any).__flight_server_modules;
  if (registry?.[id]) return registry[id];
  return import(resolve(buildDir, `server/chunks/${id}.js`));
};

// --- Message Types ---

interface ExecuteMessage {
  type: "execute";
  taskId: string;
  actionId: string;
  contentType: string;
  body: ArrayBuffer;
  requestContext: SerializedRequestContext;
  resultPort: MessagePort;
}

interface AbortMessage {
  type: "abort";
  taskId: string;
}

// --- Task Management ---

const pendingAborts = new Map<string, AbortController>();

function reconstructRequest(ctx: SerializedRequestContext): Request {
  return new Request(ctx.url, {
    method: ctx.method,
    headers: new Headers(ctx.headers),
  });
}

async function handleExecute(msg: ExecuteMessage): Promise<void> {
  const { taskId, actionId, body, contentType, requestContext, resultPort } = msg;

  const ac = new AbortController();
  pendingAborts.set(taskId, ac);

  try {
    // Parse actionId: "moduleId#exportName"
    const hashIndex = actionId.indexOf("#");
    const moduleId = hashIndex >= 0 ? actionId.slice(0, hashIndex) : actionId;
    const exportName = hashIndex >= 0 ? actionId.slice(hashIndex + 1) : "default";

    // Validate action exists in manifest
    const manifestEntry = serverActionsManifest[moduleId];
    if (!manifestEntry) {
      resultPort.postMessage({
        type: "error",
        status: 404,
        message: `Action not found in manifest: ${actionId}`,
      });
      resultPort.close();
      return;
    }

    // Check for early abort
    if (ac.signal.aborted) {
      resultPort.postMessage({ type: "done" });
      resultPort.close();
      return;
    }

    // Decode arguments
    let args: unknown[];
    if (
      contentType.includes("multipart/form-data") ||
      contentType.includes("application/x-www-form-urlencoded")
    ) {
      const response = new Response(body, {
        headers: { "content-type": contentType },
      });
      const formData = await response.formData();
      args = (await decodeReply(formData, serverActionsManifest)) as unknown[];
    } else {
      const text = new TextDecoder().decode(body);
      args = (await decodeReply(text, serverActionsManifest)) as unknown[];
    }

    // Load the action module
    const mod = await loadModule(manifestEntry.id);
    const actionFn = mod[exportName] as (...args: unknown[]) => Promise<unknown>;

    if (typeof actionFn !== "function") {
      resultPort.postMessage({
        type: "error",
        status: 404,
        message: `Action export "${exportName}" is not a function in ${moduleId}`,
      });
      resultPort.close();
      return;
    }

    // Execute the action within the request context
    const request = reconstructRequest(requestContext);
    const result = await requestStorage.run(request, () => actionFn(...args));

    // Check for abort after execution
    if (ac.signal.aborted) {
      resultPort.postMessage({ type: "done" });
      resultPort.close();
      return;
    }

    // Serialize result to RSC stream
    const rscStream: ReadableStream<Uint8Array> = renderToReadableStream(
      result,
      rscClientManifest,
      {
        onError: (err: unknown) => console.error("[flight-worker] Action RSC error:", err),
      },
    );

    // Stream chunks back via MessagePort with zero-copy transfer
    const reader = rscStream.getReader();
    try {
      while (true) {
        if (ac.signal.aborted) {
          await reader.cancel().catch(() => {});
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        // Transfer the underlying ArrayBuffer for zero-copy
        const buffer = value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength,
        ) as ArrayBuffer;
        resultPort.postMessage({ type: "chunk", data: buffer }, [buffer]);
      }
    } finally {
      reader.releaseLock();
    }

    resultPort.postMessage({ type: "done" });
    resultPort.close();
  } catch (err) {
    try {
      resultPort.postMessage({
        type: "error",
        status: 500,
        message: err instanceof Error ? err.message : "Internal server error",
      });
      resultPort.close();
    } catch {
      // Port may already be closed
    }
  } finally {
    pendingAborts.delete(taskId);
  }
}

function handleAbort(msg: AbortMessage): void {
  const ac = pendingAborts.get(msg.taskId);
  if (ac) {
    ac.abort();
  }
}

// --- Main message listener ---

parentPort.on("message", (msg: { type: string; taskId?: string }) => {
  switch (msg.type) {
    case "execute":
      handleExecute(msg as ExecuteMessage).catch((err) => {
        console.error("[flight-worker] Unhandled error in handleExecute:", err);
      });
      break;
    case "abort":
      handleAbort(msg as AbortMessage);
      break;
    case "shutdown":
      // Graceful shutdown: let pending tasks finish, then exit
      // In practice the main thread will terminate us after a grace period
      process.exit(0);
      break;
  }
});

// Signal that initialization is complete
parentPort.postMessage({ type: "ready" });
