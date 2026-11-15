import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
const root = mkdtempSync(join(tmpdir(), 'v2-phone-preferences-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, list, save, event } = await import('../../workspace/store.ts');
const {
  notificationPreferences,
  putNotificationPreferences,
  agentControl,
  putAgentControl,
  shouldNotify,
} = await import('./phone-preferences.ts');
const { registerDevice, deliverPushEvents } = await import('../../v2/push.ts');
const { authDb, session } = await import('../../v2/auth-store.ts');
const { removeDevice, pairedDeviceForRequest } = await import('../../v2/devices.ts');
const { _resetDb, registerUser } = await import('../../store.ts');
after(() => {
  _resetDb();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('preferences are owner scoped, typed, and support quiet hours with rollback exceptions', () => {
  assert.deepEqual(notificationPreferences('one'), {
    decisions: true,
    failingApps: true,
    quietHours: false,
    timeZone: 'UTC',
  });
  putNotificationPreferences('one', { quietHours: true, timeZone: 'America/New_York' });
  const night = Date.parse('2026-10-28T03:00:00Z');
  assert.equal(shouldNotify('one', 'decision', 'warden', false, night), false);
  assert.equal(shouldNotify('one', 'decision', 'warden', true, night), true);
  assert.equal(shouldNotify('two', 'health', undefined, false, night), true);
  assert.equal(
    shouldNotify('one', 'health', undefined, false, Date.parse('2026-10-28T14:00:00Z')),
    true,
  );
  putNotificationPreferences('one', { decisions: false, failingApps: false });
  assert.equal(shouldNotify('one', 'decision', 'warden', true, night), false);
  assert.equal(shouldNotify('one', 'health'), false);
  for (const body of [
    { decisions: 'false' },
    { timeZone: 'wrong' },
    { quietHours: 1 },
    { other: true },
    [],
  ])
    assert.throws(() => putNotificationPreferences('one', body));
});

test('mute expires after an hour and pause blocks unattended execution even with an allow rule', async () => {
  const { isAllowed } = await import('../../v2/releases.ts');
  const time = Date.now();
  putAgentControl('controls', 'warden', { muteMinutes: 60, paused: true }, time);
  save('v2-approval', 'controls', {
    id: 'allow',
    agent: 'warden',
    action: 'rollback',
    mode: 'allow',
  });
  assert.equal(isAllowed('controls', 'warden', 'rollback'), false);
  assert.equal(shouldNotify('controls', 'decision', 'warden', true, time), false);
  assert.equal(shouldNotify('controls', 'decision', 'warden', true, time + 3600_000), true);
  assert.equal(agentControl('other', 'warden').paused, false);
  putAgentControl('controls', 'warden', { paused: false, muteMinutes: 0 });
  assert.equal(isAllowed('controls', 'warden', 'rollback'), true);
  assert.throws(() => putAgentControl('controls', 'warden', { muteMinutes: -1 }));
});

test('pair revocation removes only the authenticated device token and delivery checks revoked sessions', async () => {
  const owner = 'paired';
  registerUser(owner, 'long-fixture-password');
  const paired = session(owner, 'iPhone');
  authDb()
    .prepare('INSERT INTO v2_devices VALUES(?,?,?,?,?)')
    .run('phone', owner, paired.sessionId, 'iPhone', new Date().toISOString());
  const request = { headers: { 'x-deploy-token': paired.token } } as unknown as IncomingMessage;
  assert.equal(pairedDeviceForRequest(owner, request), 'phone');
  assert.throws(() => pairedDeviceForRequest('other', request), { status: 401 });
  registerDevice(owner, { token: 'ab'.repeat(32), environment: 'sandbox' }, 'phone');
  registerDevice(owner, { token: 'cd'.repeat(32), environment: 'sandbox' });
  assert.throws(() => removeDevice('other', 'phone'));
  removeDevice(owner, 'phone');
  assert.equal(list('v2-device', owner).length, 1);
  assert.throws(() => pairedDeviceForRequest(owner, request), { status: 401 });
  // Even a registration racing revocation cannot deliver to the revoked session.
  registerDevice(owner, { token: 'ab'.repeat(32), environment: 'sandbox' }, 'phone');
  event(owner, '', null, 'v2.inbox', {
    item: {
      id: 'decision',
      kind: 'question',
      from: 'scout',
      state: 'waiting',
      title: 'Choose',
      text: 'Choose',
      actions: [],
    },
  });
  let calls = 0;
  await deliverPushEvents(owner, {
    async send(device) {
      assert.equal(device.token, 'cd'.repeat(32));
      calls++;
      return { status: 200 };
    },
  });
  assert.equal(calls, 1);
  assert.equal(list('v2-device', owner).length, 1);
});
