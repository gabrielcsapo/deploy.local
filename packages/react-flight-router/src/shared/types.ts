import type { ReactNode } from 'react';

/** The RSC payload structure sent over the wire */
export interface RSCPayload {
  url: string;
  segments: Record<string, ReactNode>;
  params: Record<string, string>;
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
  serverModuleMap: Record<string, { id: string; chunks: string[]; name: string }>;
  moduleLoading: { prefix: string; crossOrigin?: string } | null;
}

/** Server actions manifest */
export type ServerActionsManifest = Record<string, {
  id: string;
  name: string;
  chunks: string[];
}>;

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
