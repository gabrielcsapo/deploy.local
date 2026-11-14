import assert from 'node:assert/strict';
import test from 'node:test';
import {
  componentHarness,
  elements,
  uiStubs,
  settle,
} from '../../../../../../scripts/component-harness.mjs';

const data = {
  backups: [],
  restores: [],
  schedules: [{ name: 'drive', schedule: '0 3 * * *', destination: '/missing' }],
};
async function setup({
  loadFails = false,
  refreshFails = false,
  backupSucceeds = false,
  points = [],
} = {}) {
  const calls = [];
  let release;
  let runs = 0;
  let loads = 0;
  const h = await componentHarness(
    'app/routes/dashboard/v2/settings/backups/page.client.tsx',
    {
      '@/components/ui': uiStubs,
      '../../agents/shared': {
        request: async (path, method = 'GET') => {
          calls.push([method, path]);
          if (method !== 'GET') throw new Error('Restore failed');
          loads++;
          if ((loadFails && loads === 1) || (refreshFails && loads === 2))
            throw new Error('Load failed');
          return { ...data, backups: points };
        },
      },
      '../frame.client': { SettingsFrame: 'SettingsFrame' },
      '../../data/time': { formatTime: () => '' },
      '../../data/hooks': {
        authenticatedFetch: async (path, options) => {
          calls.push([options.method, path]);
          runs++;
          if (runs > 1)
            await new Promise((resolve) => {
              release = resolve;
            });
          return { ok: backupSucceeds, json: async () => ({ error: 'Destination missing' }) };
        },
      },
      './presentation': { allCopiesLocal: () => false },
    },
    { window: { location: { search: '' } } },
  );
  const render = () => h.render(h.exports.default);
  const button = (label) =>
    elements(render(), 'Action').find((node) => node.props.children === label);
  render();
  h.effects();
  await settle();
  return { h, render, button, calls, finish: () => release() };
}

test('Try again repeats a failed backup POST, stays busy, and retains a repeated failure', async () => {
  const f = await setup();
  f.button('Back up now').props.onClick();
  await settle();
  assert.equal(elements(f.render(), 'Banner')[0].props.children, 'Destination missing');
  f.button('Try again').props.onClick();
  assert.equal(f.button('Back up now').props.disabled, true);
  assert.equal(f.calls.filter(([method]) => method === 'POST').length, 2);
  f.finish();
  await settle();
  assert.equal(elements(f.render(), 'Banner')[0].props.children, 'Destination missing');
  assert.equal(f.button('Back up now').props.disabled, false);
  f.h.dispose();
});

test('Try again retries a failed page load with GET only', async () => {
  const f = await setup({ loadFails: true });
  f.button('Try again').props.onClick();
  await settle();
  assert.deepEqual(f.calls, [
    ['GET', '/backups'],
    ['GET', '/backups'],
  ]);
  assert.equal(elements(f.render(), 'Banner').length, 0);
  f.h.dispose();
});

test('backup banner Try again uses the approved quiet action', async () => {
  const f = await setup({ loadFails: true });
  assert.equal(f.button('Try again').props.variant, 'quiet');
  f.h.dispose();
});

test('a successful backup followed by a failed refresh retries only the read', async () => {
  const f = await setup({ backupSucceeds: true, refreshFails: true });
  f.button('Back up now').props.onClick();
  await settle();
  f.button('Try again').props.onClick();
  await settle();
  assert.deepEqual(f.calls, [
    ['GET', '/backups'],
    ['POST', '/api/backups/run'],
    ['GET', '/backups'],
    ['GET', '/backups'],
  ]);
  assert.equal(
    elements(f.render(), 'Banner').filter((node) => node.props.kind === 'danger').length,
    0,
  );
  f.h.dispose();
});

for (const operation of ['restore', 'test']) {
  test(`failed ${operation} stays in its dialog and retries the same endpoint`, async () => {
    const f = await setup({
      points: [{ id: 'point', name: 'Gym', kind: 'manual', contents: [], restoreAvailable: true }],
    });
    f.button(operation === 'restore' ? 'Restore…' : 'Test-restore now').props.onClick();
    const submit = () =>
      elements(f.render(), 'Action').find((node) => node.props.variant === 'primary');
    submit().props.onClick();
    await settle();
    assert.equal(f.button('Try again'), undefined);
    const dialog = elements(f.render(), 'Dialog').find((node) => node.props.open);
    assert.equal(elements(dialog, 'Banner')[0].props.children, 'Restore failed');
    assert.equal(submit().props.loading, false);
    submit().props.onClick();
    await settle();
    assert.deepEqual(f.calls.slice(1), [
      ['POST', `/backups/point/${operation}`],
      ['POST', `/backups/point/${operation}`],
    ]);
    f.h.dispose();
  });
}
