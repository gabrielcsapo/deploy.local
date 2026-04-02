import type { ReactNode } from "react";

/** The RSC payload structure sent over the wire */
export interface RSCPayload {
  url: string;
  segments: Record<string, ReactNode>;
  params: Record<string, string>;
  /** All segment keys for this URL (present during partial updates for client-side merging) */
  segmentKeys?: string[];
  /** HTTP status code (200 or 404). Present when route matching produces a not-found result. */
  status?: number;
  /** Loading and error boundary component elements keyed by segment key.
   *  Resolved from route-config loading/error modules on the server and serialized
   *  as client component references so <Outlet /> can wrap child segments. */
  boundaryComponents?: Record<
    string,
    {
      loading?: ReactNode;
      error?: ReactNode;
    }
  >;
}

/** Client manifest entry: maps module ID → client chunk info */
export interface ClientManifestEntry {
  id: string;
  chunks: string[];
  name: string;
  async?: boolean;
}

/** RSC client manifest used by renderToReadableStream */
export type RSCClientManifest = Record<string, ClientManifestEntry>;

/** SSR manifest used by createFromReadableStream on server */
export interface SSRManifest {
  moduleMap: Record<string, Record<string, { id: string; chunks: string[]; name: string }>>;
  serverModuleMap: Record<string, { id: string; chunks: string[]; name: string }> | null;
  moduleLoading: { prefix: string; crossOrigin?: string } | null;
}

/** Server actions manifest */
export type ServerActionsManifest = Record<
  string,
  {
    id: string;
    name: string;
    chunks: string[];
  }
>;

/** All manifests loaded at runtime */
export interface Manifests {
  rscClientManifest: RSCClientManifest;
  ssrManifest: SSRManifest;
  serverActionsManifest: ServerActionsManifest;
  clientEntryUrl: string;
  cssFiles: string[];
}

/** Module resolution function type (different in dev vs prod) */
export type ModuleLoader = (id: string) => Promise<Record<string, unknown>>;

/**
 * Configuration for the worker thread pool used to execute server actions
 * off the main thread.
 *
 * **Important:** Module-level mutable state (e.g., `const messages = []` in a
 * `"use server"` file) is NOT shared between workers. Each worker runs in its
 * own V8 isolate with a separate copy of module state. Use external storage
 * (database, Redis) for shared state when workers are enabled.
 */
export interface WorkerOptions {
  /** Number of worker threads. Default: `max(1, os.cpus().length - 1)` */
  size?: number;
  /** Maximum action execution time in ms before returning 504. Default: 30000 */
  timeout?: number;
}

/** Serialized request data passed from the main thread to a worker */
export interface SerializedRequestContext {
  url: string;
  method: string;
  headers: [string, string][];
}

/** A single timing measurement from a request */
export interface TimingEntry {
  /** Label identifying the phase (e.g., "matchRoutes", "ssr:renderToHTML") */
  label: string;
  /** Duration in milliseconds (undefined if the phase was never closed) */
  durationMs?: number;
  /** Nesting depth (0 = top-level, 1 = first child, etc.) */
  depth: number;
  /** Offset from the start of the request in ms — positions the entry on the timeline */
  offsetMs?: number;
  /** True when this entry ran concurrently with siblings (e.g., parallel module loads) */
  parallel?: boolean;
}

/** Structured performance data emitted after each request completes */
export interface RequestTimingEvent {
  /** Request type: "SSR" for initial page loads, "RSC" for client navigations, "ACTION" for server actions */
  type: "SSR" | "RSC" | "ACTION";
  /** The pathname of the request (not masked — use maskParams() if needed) */
  pathname: string;
  /** HTTP status code of the response */
  status: number;
  /** Total request duration in milliseconds */
  totalMs: number;
  /** Individual timing entries for each phase */
  timings: TimingEntry[];
  /** ISO 8601 timestamp of when the request completed */
  timestamp: string;
  /** True when the client disconnected before the stream was fully consumed */
  cancelled?: boolean;
}
