---
title: "Worker Threads"
description: "Offload server actions to worker threads to keep page rendering fast under load. Learn how to enable workers, how they work, and see benchmark results."
---

# Worker Threads

Server actions run on the main thread by default. Under load, a slow action (e.g., a database write or external API call) blocks the event loop, delaying page renders for other users. Worker threads solve this by running actions in a separate thread pool.

## The Problem

Node.js is single-threaded. When a server action takes 200ms to complete, every page render that arrives during that window is queued behind it:

```
Main Thread:
  ├─ Action (200ms) ──────────────────┤
  │                                   ├─ Page render (2ms) ─┤
  │                                   │  ↑ waited 200ms     │
```

Under concurrent load, this compounds — p95 page render latency can spike to seconds even though the render itself only takes a few milliseconds.

## The Solution

The `workers` option offloads server actions to a pool of worker threads, keeping the main thread free for page rendering:

```
Main Thread:     ├─ Page render (2ms) ─┤  (never blocked)
Worker Thread 1: ├─ Action (200ms) ────┤
Worker Thread 2: ├─ Action (200ms) ────┤
```

## Setup

### Production

Pass `workers` to `createServer`:

```ts
// server.ts
import { serve } from "@hono/node-server";
import { createServer } from "react-flight-router/server";

const app = await createServer({
  buildDir: "./dist",
  workers: { size: 2 },
});

serve({ fetch: app.fetch, port: 3000 });
```

Or use `workers: true` for the default pool size (number of CPU cores minus one, minimum 1):

```ts
const app = await createServer({
  buildDir: "./dist",
  workers: true,
});
```

### Development

Worker threads are a production-only feature. In development, Vite's `ssrLoadModule` handles module loading, which is incompatible with worker thread isolation. Actions run on the main thread during development.

## How It Works

1. **Pool creation** — On startup, `createServer` spawns a pool of worker threads. Each worker loads the RSC runtime, server action modules, and manifests independently.

2. **Least-busy dispatch** — When an action request arrives, the pool dispatches it to the worker with the fewest in-flight tasks. This balances load across workers without round-robin's worst-case behavior.

3. **MessageChannel streaming** — Each action gets a dedicated `MessagePort` pair. The worker streams RSC response chunks back to the main thread as `ArrayBuffer` transfers (zero-copy), which are piped directly to the HTTP response.

4. **Request context** — `getRequest()` works automatically in workers. The framework serializes the request's URL, method, and headers to the worker, which reconstructs a `Request` object and populates `requestStorage` before executing the action.

5. **Abort propagation** — If the client disconnects mid-action, the main thread sends an abort signal to the worker via its `MessagePort`. The worker's `AbortSignal` fires, allowing actions to clean up.

6. **Crash recovery** — If a worker crashes (uncaught exception, out of memory), the pool automatically spawns a replacement. The failed request receives a 500 response.

## Benchmark Results

Artillery load tests with 20 requests/second for 30 seconds, comparing workers vs. no workers. The test server runs a 200ms slow action alongside page renders:

### Mixed Load (pages + actions concurrently)

| Metric | No Workers | Workers (2) | Improvement |
| ------ | ---------- | ----------- | ----------- |
| p50    | 1ms        | 1ms         | —           |
| p95    | 102.5ms    | 2ms         | **-98%**    |
| p99    | 204ms      | 3ms         | **-99%**    |
| Errors | 0          | 0           | —           |

### Actions Only

| Metric | No Workers | Workers (2) | Improvement |
| ------ | ---------- | ----------- | ----------- |
| p50    | 202.4ms    | 1ms         | **-100%**   |
| p95    | 204ms      | 1ms         | **-100%**   |
| p99    | 204.1ms    | 1.7ms       | **-99%**    |
| Errors | 0          | 0           | —           |

### Pages Only (baseline)

| Metric | No Workers | Workers (2) | Improvement |
| ------ | ---------- | ----------- | ----------- |
| p50    | 1ms        | 1ms         | —           |
| p95    | 2ms        | 2ms         | —           |
| p99    | 3ms        | 3ms         | —           |

When no actions are running, workers add zero overhead. The improvement appears only when actions and page renders compete for the event loop.

## Configuration

```ts
interface WorkerOptions {
  /** Number of worker threads (default: os.cpus().length - 1, minimum 1) */
  size?: number;
  /** Timeout in ms for action execution (default: 30000) */
  timeout?: number;
}
```

| Option    | Default               | Description                                                     |
| --------- | --------------------- | --------------------------------------------------------------- |
| `size`    | CPU cores - 1 (min 1) | Number of worker threads in the pool.                           |
| `timeout` | 30000                 | Maximum time in ms for an action to complete before timing out. |

### Example: Environment-Based Worker Toggle

A common pattern is toggling workers via an environment variable so you can use the same server entry point across environments:

```ts
// server.ts
import { serve } from "@hono/node-server";
import { createServer } from "react-flight-router/server";

const useWorkers = process.env.WORKERS === "1";
const workerConfig = useWorkers ? { size: 2 } : undefined;

const app = await createServer({
  buildDir: "./dist",
  workers: workerConfig,
});

serve({ fetch: app.fetch, port: 3000 });
```

Start with workers enabled:

```bash
WORKERS=1 node server.js
```

See the [e2e test server](https://github.com/gabrielcsapo/react-flight-router/blob/main/packages/react-flight-router-e2e/server.ts) for a complete working example that also includes timing events, health checks, and Hono API routes alongside the flight app.

## Limitations

- **Module-level mutable state** — Each worker has its own module instances. Mutable state at module scope (e.g., an in-memory Map) is not shared between workers or with the main thread. Use a database or external store for shared state.
- **Development mode** — Workers are not used in development. Vite's `ssrLoadModule` requires the main thread's module graph.
- **Programmatic actions only** — Workers handle server actions invoked via the `/__action` endpoint. API routes (e.g., Hono middleware) still run on the main thread.
