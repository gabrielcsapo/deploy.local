import { Readable, Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Exercise JSON routes with request/response streams, without opening a listening socket. */
export function routeFetch(
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<unknown>,
) {
  return async (url: string, init: RequestInit = {}) => {
    const parsed = new URL(url);
    const request = Object.assign(
      Readable.from(init.body === undefined ? [] : [Buffer.from(String(init.body))]),
      {
        url: parsed.pathname + parsed.search,
        method: init.method || 'GET',
        headers: Object.fromEntries(new Headers(init.headers)),
      },
    );
    const chunks: Buffer[] = [];
    let status = 200;
    let headers: Record<string, string> = {};
    const response = Object.assign(
      new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk));
          done();
        },
      }),
      {
        writeHead(code: number, values: Record<string, string> = {}) {
          status = code;
          headers = values;
          return response;
        },
      },
    );
    await handle(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    if (!response.writableEnded) throw new Error(`Route did not end its response: ${url}`);
    return new Response(Buffer.concat(chunks), { status, headers });
  };
}
