import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWanderAdoptionCli } from '../bin/wander-adoption.mjs';
const account = {
  username: 'synthetic-owner',
  token: 'synthetic-only-token',
  url: 'https://fixture.invalid',
};
const headers = () => ({});
test('owner CLI rejects wrong app, non-HTTPS origin and missing exact recovery acknowledgement', async () => {
  const noRequest = () => {
    throw Error('Unexpected network');
  };
  await assert.rejects(
    () =>
      runWanderAdoptionCli(
        ['adopt', 'status'],
        { application: 'groffee' },
        account,
        noRequest,
        headers,
      ),
    /limited/,
  );
  await assert.rejects(
    () =>
      runWanderAdoptionCli(
        ['adopt', 'status'],
        { application: 'wander', url: 'http://fixture.invalid' },
        account,
        noRequest,
        headers,
      ),
    /HTTPS/,
  );
  await assert.rejects(
    () =>
      runWanderAdoptionCli(
        ['adopt', 'recover'],
        { application: 'wander' },
        account,
        noRequest,
        headers,
      ),
    /confirm-downtime/,
  );
  await assert.rejects(
    () =>
      runWanderAdoptionCli(
        ['adopt', 'recover'],
        { application: 'wander', 'confirm-downtime': true },
        account,
        noRequest,
        headers,
      ),
    /operation/,
  );
  await assert.rejects(
    () =>
      runWanderAdoptionCli(
        ['adopt', 'update'],
        { application: 'wander', 'confirm-downtime': true },
        account,
        noRequest,
        headers,
      ),
    /idempotency-key/,
  );
});
test('owner CLI never loads scoped CI auth for storage adoption', async () => {
  const prior = process.env.DEPLOY_AUTH_JSON;
  process.env.DEPLOY_AUTH_JSON = 'synthetic-test-scope';
  try {
    await assert.rejects(
      () =>
        runWanderAdoptionCli(
          ['adopt', 'status'],
          { application: 'wander' },
          account,
          () => {},
          headers,
        ),
      /owner account/,
    );
  } finally {
    if (prior === undefined) delete process.env.DEPLOY_AUTH_JSON;
    else process.env.DEPLOY_AUTH_JSON = prior;
  }
});
