import { createGzip, createBrotliCompress, constants } from 'node:zlib';
import { Duplex } from 'node:stream';

/** Each input chunk is flushed, including small React shells and Suspense rows. */
export function compressStreamResponse(response: Response, acceptEncoding: string): Response {
  if (!response.body || response.headers.has('content-encoding')) return response;
  const qualities = new Map<string, number>();
  for (const part of acceptEncoding.toLowerCase().split(',')) {
    const [name, ...parameters] = part.trim().split(';');
    const q = parameters.find((parameter) => parameter.trim().startsWith('q='));
    const quality = q === undefined ? 1 : Number(q.trim().slice(2));
    qualities.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
  }
  const quality = (name: string) => qualities.get(name) ?? qualities.get('*') ?? 0;
  const encoding =
    quality('br') >= quality('gzip') && quality('br') > 0
      ? 'br'
      : quality('gzip') > 0
        ? 'gzip'
        : undefined;
  if (!encoding) return response;
  const compressor =
    encoding === 'br'
      ? createBrotliCompress({
          flush: constants.BROTLI_OPERATION_FLUSH,
          params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
        })
      : createGzip({ flush: constants.Z_SYNC_FLUSH });
  // Node's adapter provides backpressure, errors and cancellation in both directions.
  const transform = Duplex.toWeb(compressor) as {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  response.body.pipeTo(transform.writable).catch(() => {});
  const headers = new Headers(response.headers);
  headers.set('Content-Encoding', encoding);
  headers.delete('Content-Length');
  const vary = headers.get('Vary');
  if (
    !vary?.split(',').some((value) => value.trim().toLowerCase() === 'accept-encoding') &&
    vary !== '*'
  ) {
    headers.set('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
  }
  headers.set('Cache-Control', headers.get('Cache-Control') ?? 'no-transform');
  return new Response(transform.readable, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
