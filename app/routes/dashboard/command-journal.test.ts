import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareCommand,
  workspaceRequest,
  WorkspaceRequestError,
  workspaceConnectionMessage,
} from './command-journal.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const path = '/tasks/task-1/messages';
const body = { revision: 3, content: 'Continue', adapter: 'codex' };
const auth = { username: 'alice', token: 'secret-not-to-persist' };

test('accepted send with lost response retries its original body after revision and token refresh', async () => {
  const storage = memoryStorage();
  const accepted = new Map<string, string>();
  let loseResponse = true;
  const request: typeof fetch = async (_url, options) => {
    const raw = String(options?.body);
    const payload = JSON.parse(raw);
    if (accepted.has(payload.operationId)) assert.equal(raw, accepted.get(payload.operationId));
    accepted.set(payload.operationId, raw);
    if (loseResponse) {
      loseResponse = false;
      throw new Error('connection reset after acceptance');
    }
    return new Response(JSON.stringify({ id: 'same-run' }));
  };
  await assert.rejects(workspaceRequest(path, body, auth, storage, request), /connection reset/);
  assert.ok(!JSON.stringify([...storage.values]).includes(auth.token));
  const result = await workspaceRequest(
    path,
    { ...body, revision: 4 },
    { ...auth, token: 'refreshed' },
    storage,
    request,
  );
  assert.equal(result.id, 'same-run');
  assert.equal(accepted.size, 1);
  assert.equal(storage.values.size, 0);
  await workspaceRequest(path, { ...body, revision: 4 }, auth, storage, request);
  assert.equal(accepted.size, 2, 'a later intentional identical message is a new operation');
});

test('account, task and provider scope retries; corrupt or unavailable storage never dispatches', async () => {
  const storage = memoryStorage();
  const first = prepareCommand(storage, 'alice', path, body);
  for (const [user, target, payload] of [
    ['bob', path, body],
    ['alice', '/tasks/other/messages', body],
    ['alice', path, { ...body, adapter: 'claude' }],
  ] as const)
    assert.notEqual(
      prepareCommand(storage, user, target, payload).payload.operationId,
      first.payload.operationId,
    );
  storage.setItem(first.key, 'corrupt');
  let dispatched = false;
  const request: typeof fetch = async () => {
    dispatched = true;
    return new Response('{}');
  };
  await assert.rejects(workspaceRequest(path, body, auth, storage, request));
  assert.equal(dispatched, false);
  assert.equal(storage.getItem(first.key), 'corrupt');
  const unavailable = {
    ...memoryStorage(),
    setItem() {
      throw new Error('quota');
    },
  };
  await assert.rejects(workspaceRequest(path, body, auth, unavailable, request), /quota/);
  assert.equal(dispatched, false);
});

test('transient failures retain retries; definitive rejection permits corrected dispatch', async () => {
  for (const status of [400, 401, 403, 408, 409, 422, 429, 503]) {
    const storage = memoryStorage();
    await assert.rejects(
      workspaceRequest(
        path,
        body,
        auth,
        storage,
        async () => new Response('{"error":"unavailable"}', { status }),
      ),
    );
    assert.equal(storage.values.size, [400, 409, 422].includes(status) ? 0 : 1);
  }
});

test('expired login is distinguished from network loss and preserves the send identity after reauthentication', async () => {
  const storage = memoryStorage();
  let firstId: string | undefined;
  await assert.rejects(
    workspaceRequest(path, body, auth, storage, async (_url, init) => {
      firstId = JSON.parse(String(init?.body)).operationId;
      return new Response('{"error":"Unauthorized"}', { status: 401 });
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceRequestError);
      assert.equal(error.status, 401);
      assert.match(workspaceConnectionMessage(error), /session has expired/);
      return true;
    },
  );
  await workspaceRequest(
    path,
    body,
    { ...auth, token: 'renewed-token' },
    storage,
    async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).operationId, firstId);
      return new Response('{"id":"accepted-once"}');
    },
  );
  assert.equal(storage.values.size, 0);
  assert.match(workspaceConnectionMessage(new TypeError('network failed')), /reconnecting/);
});
