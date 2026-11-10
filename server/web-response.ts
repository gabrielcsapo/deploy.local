import type { ServerResponse } from 'node:http';

/**
 * Copy a fetch Response body to a Node response, at the client's pace.
 *
 * Writing without waiting for 'drain' buffers a whole streamed page in memory for a slow
 * client, and reading on after the client has gone keeps a render running for nobody. This
 * waits when the socket is full and cancels the body, which aborts its producer, when the
 * client disconnects. It does not end the response.
 */
export async function pipeWebBody(
  body: ReadableStream<Uint8Array>,
  res: Pick<ServerResponse, 'write' | 'on' | 'once' | 'off' | 'destroyed'>,
): Promise<void> {
  const reader = body.getReader();
  let closed = false;
  let wake: (() => void) | null = null;
  const onClose = () => {
    closed = true;
    wake?.();
    void reader.cancel().catch(() => {});
  };
  const onDrain = () => wake?.();
  res.once('close', onClose);
  res.on('drain', onDrain);
  try {
    while (!closed && !res.destroyed) {
      const { done, value } = await reader.read();
      if (done || closed || res.destroyed) break;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    }
  } finally {
    res.off('close', onClose);
    res.off('drain', onDrain);
    // Covers a response destroyed without a 'close' seen here; a finished read ignores it.
    if (closed || res.destroyed) void reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
}
