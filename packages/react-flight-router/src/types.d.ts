declare module 'react-server-dom-webpack/server.node' {
  export function renderToReadableStream(
    model: unknown,
    webpackMap: unknown,
    options?: { onError?: (error: unknown) => void },
  ): ReadableStream;

  export function registerClientReference<T>(
    proxy: T,
    moduleId: string,
    exportName: string,
  ): T;

  export function registerServerReference(
    fn: Function,
    moduleId: string,
    exportName: string,
  ): void;

  export function decodeReply(
    body: Uint8Array | ArrayBuffer,
    manifest: unknown,
  ): Promise<unknown[]>;

  export function decodeAction(
    formData: FormData,
    manifest: unknown,
  ): Promise<() => Promise<unknown>>;

  export function decodeFormState(
    result: unknown,
    formData: FormData,
    manifest: unknown,
  ): Promise<unknown>;
}

declare module 'react-server-dom-webpack/client.node' {
  export function createFromReadableStream<T = unknown>(
    stream: ReadableStream,
    options: { serverConsumerManifest: unknown },
  ): Promise<T>;
}

declare module 'react-server-dom-webpack/client.browser' {
  export function createFromReadableStream<T = unknown>(
    stream: ReadableStream,
    options?: { callServer?: (id: string, args: unknown[]) => Promise<unknown> },
  ): Promise<T>;

  export function createServerReference(
    id: string,
    callServer: (id: string, args: unknown[]) => Promise<unknown>,
  ): (...args: unknown[]) => Promise<unknown>;

  export function encodeReply(
    args: unknown[],
  ): Promise<BodyInit>;
}

interface ImportMeta {
  hot?: {
    on(event: string, callback: () => void): void;
    accept(): void;
  };
}
