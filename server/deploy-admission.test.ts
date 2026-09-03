import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  acquireDeploySlot,
  cancelQueuedDeploy,
  getDeployAdmissionState,
} from './deploy-admission.ts';

it('serializes deploys for the same app', async () => {
  const first = await acquireDeploySlot('same-app', 'alice');
  let secondAcquired = false;
  const secondPromise = acquireDeploySlot('same-app', 'bob').then((lease) => {
    secondAcquired = true;
    return lease;
  });

  await Promise.resolve();
  assert.equal(secondAcquired, false);
  assert.equal(getDeployAdmissionState().queued, 1);
  assert.deepEqual(getDeployAdmissionState('alice').activeDeployments, ['same-app']);
  assert.equal(getDeployAdmissionState('bob').queue[0]?.position, 1);

  first.release();
  const second = await secondPromise;
  assert.equal(secondAcquired, true);
  second.release();
});

it('lets an owner cancel a queued deploy', async () => {
  const active = await acquireDeploySlot('cancel-app', 'alice');
  const queued = acquireDeploySlot('cancel-app', 'alice');
  assert.equal(cancelQueuedDeploy('cancel-app', 'bob'), false);
  assert.equal(cancelQueuedDeploy('cancel-app', 'alice'), true);
  await assert.rejects(queued, /cancelled/);
  active.release();
});
