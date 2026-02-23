import { ACTION_ENDPOINT, RSC_ACTION_HEADER } from '../shared/constants.js';

/**
 * Call a server action from the client.
 * Serializes the action ID and arguments, POSTs to the server,
 * and returns the RSC response.
 */
export async function callServer(id: string, args: unknown[]): Promise<unknown> {
  const rscClientModule = await import('react-server-dom-webpack/client.browser') as any;
  const { encodeReply, createFromReadableStream } = rscClientModule;

  const body = await encodeReply(args);

  const response = await fetch(ACTION_ENDPOINT, {
    method: 'POST',
    headers: {
      [RSC_ACTION_HEADER]: id,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Server action failed: ${response.statusText}`);
  }

  const rscStream = response.body!;
  return createFromReadableStream(rscStream, { callServer });
}
