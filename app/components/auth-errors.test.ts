// The dashboard signs a person out when a server action rejects with
// "Unauthorized". This runs the real action through the router's action
// transport and the browser's callServer, so a change to how errors travel
// that hides the message (an empty HTTP/2 status text, a broken stream) fails here.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { isUnauthorizedError } from './auth-errors.ts';

const dataDirectory = mkdtempSync(join(tmpdir(), 'deploy-auth-errors-'));
process.env.DEPLOY_DATA_DIR = dataDirectory;
after(() => rmSync(dataDirectory, { recursive: true, force: true }));

test('matches the session errors and nothing else', () => {
  assert.equal(isUnauthorizedError(new Error('Unauthorized')), true);
  assert.equal(isUnauthorizedError(new Error('unauthorized: token expired')), true);
  assert.equal(isUnauthorizedError(new Error('Server action failed: 500')), false);
  assert.equal(isUnauthorizedError('Unauthorized'), false);
});

test('a dashboard action called with a stale token rejects with an error that signs out', async () => {
  // The browser's flight client looks these up when it loads; no module is ever requested.
  Object.assign(globalThis, {
    __webpack_require__: () => assert.fail('no client modules'),
    __webpack_chunk_load__: async () => {},
  });
  const actions = await import('../actions/deployments.ts');
  const { handleAction } = await import('react-flight-router/server');
  const { callServer } = await import('react-flight-router/client');
  const id = 'app/actions/deployments';

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    handleAction({
      request: new Request('https://deploy.local/__action', {
        method: 'POST',
        headers: init?.headers,
        body: init?.body,
      }),
      routes: [],
      serverActionsManifest: { [id]: { id, name: '*', chunks: [] } },
      clientManifest: {},
      loadModule: async () => actions as unknown as Record<string, unknown>,
      decodeReply: async (body) => JSON.parse(String(body)) as unknown[],
      renderToReadableStream: () => new ReadableStream(),
      renderRSC: async () => new ReadableStream(),
    })) as typeof fetch;
  const realError = console.error;
  console.error = () => {};
  try {
    const error = await callServer(`${id}#fetchDeployments`, ['someone', 'stale-token']).then(
      () => assert.fail('a stale token must not load deployments'),
      (rejection: unknown) => rejection,
    );
    assert.equal((error as Error).message, 'Unauthorized');
    assert.equal(isUnauthorizedError(error), true);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
});
