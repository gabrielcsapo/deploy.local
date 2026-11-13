import { finished } from 'node:stream/promises';
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
        socket: { remoteAddress: '127.0.0.1', encrypted: parsed.protocol === 'https:' },
        headers: Object.fromEntries(new Headers(init.headers)),
      },
    );
    const chunks: Buffer[] = [];
    let status = 200;
    let sent = false;
    let headers: Record<string, string> = {};
    const response = Object.assign(
      new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk));
          done();
        },
      }),
      {
        setHeader(name: string, value: string) {
          headers[name.toLowerCase()] = value;
          return response;
        },
        getHeader(name: string) {
          return headers[name.toLowerCase()];
        },
        writeHead(code: number, values: Record<string, string> = {}) {
          sent = true;
          status = code;
          for (const [name, value] of Object.entries(values)) headers[name.toLowerCase()] = value;
          return response;
        },
      },
    );
    await handle(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    if (sent && !response.writableEnded) await finished(response);
    if (!response.writableEnded) throw new Error(`Route did not end its response: ${url}`);
    return new Response(Buffer.concat(chunks), { status, headers });
  };
}
