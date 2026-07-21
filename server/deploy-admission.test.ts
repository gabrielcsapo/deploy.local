import assert from 'node:assert/strict';
import { it } from 'node:test';
import { acquireDeploySlot, getDeployAdmissionState } from './deploy-admission.ts';

it('serializes deploys for the same app', async () => {
  const first = await acquireDeploySlot('same-app');
  let secondAcquired = false;
  const secondPromise = acquireDeploySlot('same-app').then((lease) => {
    secondAcquired = true;
    return lease;
  });

  await Promise.resolve();
  assert.equal(secondAcquired, false);
  assert.equal(getDeployAdmissionState().queued, 1);

  first.release();
  const second = await secondPromise;
  assert.equal(secondAcquired, true);
  second.release();
});
