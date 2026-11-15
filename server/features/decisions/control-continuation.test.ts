import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continueControl } from './control-continuation.ts';

const request = { id: 'request', status: 'pending', expiresAt: 10000 };
const session = {
  id: 'session',
  status: 'active',
  controlOwner: 'agent',
  generation: 'generation',
};
function clock() {
  let time = 0;
  return {
    now: () => time,
    wait: async () => {
      time += 500;
    },
  };
}
test('one request waits through approval and worker readiness, returning the same session', async () => {
  const reads: string[] = [];
  let poll = 0;
  const result = await continueControl(
    { action: 'request' },
    request,
    async (args) => {
      reads.push(args.action);
      if (args.action === 'read') return { session, snapshot: null };
      poll++;
      return {
        requests: [
          poll === 1 ? request : { ...request, status: 'approved', sessionId: session.id },
        ],
        sessions: poll === 1 ? [] : [{ ...session, status: poll === 2 ? 'opening' : 'active' }],
      };
    },
    clock(),
  );
  assert.equal(poll, 3);
  assert.equal(result.session.generation, 'generation');
  assert.equal(result.request.status, 'approved');
  assert.deepEqual(reads, ['list', 'list', 'list', 'read']);
});
for (const status of ['denied', 'expired'])
  test(`${status} approval never continues input`, async () => {
    const result = await continueControl(
      { action: 'request' },
      request,
      async (args) => {
        assert.equal(args.action, 'list');
        return { requests: [{ ...request, status }], sessions: [] };
      },
      clock(),
    );
    assert.equal(result.request.status, status);
    assert.equal(result.session, undefined);
  });
test('bounded wait expires and a stopped run authentication failure propagates', async () => {
  const result = await continueControl(
    { action: 'request' },
    request,
    async () => ({ requests: [request], sessions: [] }),
    clock(),
  );
  assert.equal(result.request.status, 'expired');
  await assert.rejects(
    continueControl(
      { action: 'request' },
      request,
      async () => {
        throw new Error('Unauthorized');
      },
      clock(),
    ),
    /Unauthorized/,
  );
});
for (const status of ['stopped', 'suspended'])
  test(`approved but ${status} session cannot continue`, async () => {
    const result = await continueControl(
      { action: 'request' },
      request,
      async () => ({
        requests: [{ ...request, status: 'approved', sessionId: session.id }],
        sessions: [{ ...session, status }],
      }),
      clock(),
    );
    assert.equal(result.session.status, status);
    assert.match(result.nextStep, /Do not send input/);
  });
for (const status of ['succeeded', 'unknown', 'cancelled'])
  test(`input waits for ${status} evidence without replay`, async () => {
    let polls = 0;
    const result = await continueControl(
      { action: 'input', sessionId: session.id },
      { id: 'command' },
      async (args) => {
        assert.deepEqual(args, { action: 'read', sessionId: session.id });
        return {
          session,
          snapshot: { text: 'fresh evidence' },
          commands: [{ id: 'command', status: ++polls === 1 ? 'running' : status }],
        };
      },
      clock(),
    );
    assert.equal(polls, 2);
    assert.equal(result.command.status, status);
    assert.equal(result.snapshot.text, 'fresh evidence');
  });
test('takeover stops waiting; input completion timeout never retries mutation', async () => {
  const result = await continueControl(
    { action: 'input', sessionId: session.id },
    { id: 'command' },
    async () => ({ session: { ...session, controlOwner: 'user:1' }, commands: [] }),
    clock(),
  );
  assert.match(result.nextStep, /Control changed/);
  const timeout = await continueControl(
    { action: 'input', sessionId: session.id },
    { id: 'command', status: 'queued' },
    async () => ({ session, commands: [] }),
    clock(),
  );
  assert.match(timeout.nextStep, /not confirmed/);
});

test('approval near the wait deadline retains the real grant for cleanup if readiness is unconfirmed', async () => {
  const result = await continueControl(
    { action: 'request' },
    request,
    async () => ({
      requests: [{ ...request, status: 'approved', sessionId: session.id }],
      sessions: [{ ...session, status: 'opening' }],
    }),
    clock(),
  );
  assert.equal(result.request.status, 'approved');
  assert.equal(result.session.id, session.id);
  assert.match(result.nextStep, /readiness was not confirmed/);
});
