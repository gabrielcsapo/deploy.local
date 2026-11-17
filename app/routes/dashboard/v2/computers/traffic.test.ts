import test from 'node:test';
import assert from 'node:assert/strict';
import { appWarning, pace, trafficWarnings } from './traffic.ts';
import type { RepeatingSender } from '../../../../../shared/v2/contracts.ts';

const sender: RepeatingSender = {
  app: 'forma',
  address: '10.0.0.159',
  computer: 'MacBook Pro',
  agent: 'curl',
  route: 'GET /',
  requests: 232_300,
  routeShare: 1,
  appShare: 0.96,
  perMinute: 161,
  sentBytes: 2_800_000_000,
  since: 0,
  sinceOrEarlier: false,
};
const when = () => 'Thursday at 7:41 PM';

test('a pace reads as a gap between requests', () => {
  assert.equal(pace(30), 'every 2 seconds');
  assert.equal(pace(60), 'every 1 second');
  assert.equal(pace(161), 'every 0.4 seconds');
  assert.equal(pace(0.2), 'every 5 minutes');
  assert.equal(pace(0), '');
});

test('Traffic names the sender once, with every app it keeps asking', () => {
  const warnings = trafficWarnings(
    { repeating: [sender, { ...sender, app: 'deploy.local', requests: 174_300, perMinute: 121 }] },
    486_136,
    when,
    () => '4.0 GB',
  );
  assert.deepEqual(warnings, [
    {
      key: '10.0.0.159',
      title: 'MacBook Pro keeps asking forma and deploy.local for the same page',
      text: 'It has sent GET / to each with curl every 0.4 seconds since Thursday at 7:41 PM: 406,600 requests and 4.0 GB in the last 24 hours, 84% of everything. A script was probably left running on it.',
    },
  ]);
  assert.deepEqual(trafficWarnings({ repeating: [] }, 10, when, String), []);
});

test('an app’s Requests page says how much of it is one sender', () => {
  assert.deepEqual(appWarning([sender], when), {
    key: '10.0.0.159 GET /',
    title: '96% of these requests are one computer asking for the same page',
    text: 'MacBook Pro (10.0.0.159) has sent GET / with curl every 0.4 seconds since Thursday at 7:41 PM. A script was probably left running on it. The numbers below include it.',
  });
  const unknown = appWarning(
    [{ ...sender, computer: undefined, agent: null, route: 'POST /api/sync' }],
    when,
  )!;
  assert.equal(unknown.title, '96% of these requests are one address asking for the same thing');
  assert.equal(
    unknown.text,
    '10.0.0.159 has sent POST /api/sync every 0.4 seconds since Thursday at 7:41 PM. A script was probably left running on it. The numbers below include it.',
  );
  assert.equal(appWarning([], when), null);
});
