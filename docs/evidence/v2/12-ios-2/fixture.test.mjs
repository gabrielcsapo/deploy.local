import assert from 'node:assert/strict';
import test from 'node:test';

const origin = 'http://127.0.0.1:5186';
async function request(path, body) {
  const response = await fetch(origin + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Deploy-Token': 'fixture-only', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
}
test('new native boards use real release, rollback, task and restore response shapes', async () => {
  for (const board of [
    'ReleasesPhone',
    'ReleasePhone',
    'ReleaseFailedPhone',
    'ShipPhone',
    'RollbackPhone',
    'RestorePhone',
    'SettingsPhone',
    'AgentMenuPhone',
    'NewProductPhone',
    'TaskInfoPhone',
    'ProjectPhone',
    'SignInPhone',
  ]) {
    assert.equal((await request('/fixture/board', { board })).board, board);
    assert.ok((await request('/api/projects')).projects.length);
  }
  const releases = await request('/api/projects/home-gym/releases');
  assert.equal(releases.releases[0].apps.length, 2);
  assert.equal((await request('/api/releases/9c3e1fa')).release.id, '9c3e1fa');
  await request('/fixture/board', { board: 'RollbackPhone' });
  assert.equal(
    (await request('/api/projects/home-gym/rollbacks')).rollbacks[0].steps[1].state,
    'running',
  );
  assert.ok(
    (await request('/api/activity-events?after=0')).events.some(
      (event) => event.type === 'rollback',
    ),
  );
  const shipped = await request('/api/projects/meal-planner/releases', {
    source: { kind: 'ship', ref: 'meal' },
    ref: 'main',
  });
  assert.equal(shipped.release.state, 'running');
  assert.ok(
    (await request('/api/activity-events?after=0')).events.some(
      (event) => event.type === 'release',
    ),
  );
  assert.equal((await request('/api/projects/deploy.local/pulls')).items.length, 2);
  assert.equal((await request('/api/projects/deploy.local/issues')).items.length, 5);
  await request('/fixture/board', { board: 'RestorePhone' });
  const { backups } = await request('/api/backups');
  const { restore } = await request(`/api/backups/${backups[0].id}/restore`, {});
  assert.equal(restore.state, 'ready');
  assert.equal(
    (await request(`/api/backups/${backups[0].id}/restore/${restore.id}/cancel`, {})).restore.state,
    'cancelled',
  );
  await request('/fixture/board', { board: 'RestorePhone' });
  const next = await request(`/api/backups/${backups[0].id}/restore`, {});
  assert.equal(
    (
      await request(`/api/backups/${backups[0].id}/restore/${next.restore.id}/switch`, {
        confirm: true,
      })
    ).restore.state,
    'live',
  );
});
