import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = mkdtempSync(join(tmpdir(), 'release-plan-'));
process.env.DEPLOY_DATA_DIR = root;
const { releaseChoices, validateReleaseChoices } = await import('./releases-plan.ts');
const { CoordinatorReleaseRuntime } = await import('./releases-runtime.ts');
const { saveDeployment, getSqlite, _resetDb } = await import('../store.ts');
const { db, save } = await import('../workspace/store.ts');
const { ProjectReleaseService, assertApplicationReleaseIdle } = await import('./releases.ts');
const { beginApplicationMutation, withinProjectRelease, assertReleaseMutation } =
  await import('./releases-fence.ts');
const { assertCiMutation } = await import('../ci-fence.ts');
after(() => {
  _resetDb();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const directory = join(root, 'source');
mkdirSync(directory);
writeFileSync(
  join(directory, 'deploy.yaml'),
  'apiVersion: deploy.local/v1\nkind: Application\ncomponents:\n  web:\n    image: test:1\n    interfaces:\n      http: {port: 8080, protocol: http}\nroutes:\n  public: {to: web.http}\n',
);
saveDeployment({ name: 'home-gym', username: 'owner', directory, desiredNodeId: 'coordinator' });
const project = {
  id: 'gym',
  name: 'home-gym',
  apps: [{ id: 'home-gym', name: 'home-gym', kind: 'web' as const }],
};
getSqlite()!
  .prepare(
    "INSERT OR IGNORE INTO nodes(id,name,address,enrolled_at,last_seen_at) VALUES('bazzite','bazzite','127.0.0.1',?,?)",
  )
  .run(new Date().toISOString(), Date.now());

test('plan returns real Run apps computers and validates every selected app', async () => {
  const plan = releaseChoices('owner', project);
  assert(plan.computers.some((computer) => computer.id === 'bazzite'));
  const choices = {
    apps: [
      {
        appId: 'home-gym',
        computerId: 'bazzite',
        address: 'gym.local',
        visibility: 'home' as const,
        data: 'new' as const,
      },
    ],
  };
  assert.deepEqual(validateReleaseChoices('owner', project, choices), choices);
  assert.throws(() => validateReleaseChoices('owner', project, { apps: [] }));
  assert.throws(
    () =>
      validateReleaseChoices('owner', project, {
        apps: [{ ...choices.apps[0], computerId: 'missing' }],
      }),
    { status: 409 },
  );
  assert.throws(() =>
    validateReleaseChoices('owner', project, {
      apps: [{ ...choices.apps[0], address: 'attacker.example' }],
    }),
  );
  const runtime = new CoordinatorReleaseRuntime();
  const release = await runtime.plan(project, undefined, choices);
  assert.equal((release.runtime as any).apps[0].nodeId, 'bazzite');
  assert.equal((release.runtime as any).apps[0].spec.routes.public.hostname, 'gym.local');
  assert.equal((release.runtime as any).apps[0].spec.routes.public.discoverable, true);
});
test('project reservations fence legacy deploy, restart, scale and configuration mutations', () => {
  save('v2-project-run', 'owner', { id: 'gym', operationId: 'release', apps: ['home-gym'] });
  for (const operation of ['deploy', 'restart', 'scale', 'configuration']) {
    assert.throws(() => beginApplicationMutation('owner', 'home-gym'), { status: 409 }, operation);
    assert.throws(() => assertCiMutation('home-gym'), { status: 409 }, operation);
  }
  assert.throws(() => assertApplicationReleaseIdle('owner', 'home-gym'), { status: 409 });
  assert.doesNotThrow(() =>
    withinProjectRelease('release', () => assertReleaseMutation('home-gym')),
  );
  assert.doesNotThrow(() => assertReleaseMutation('other'));
  db.prepare("DELETE FROM records WHERE kind='v2-project-run'").run();
  const releaseMutation = beginApplicationMutation('owner', 'home-gym');
  const service = new ProjectReleaseService(new CoordinatorReleaseRuntime());
  assert.throws(() => service.ship('owner', project, { source: { kind: 'ship', ref: 'main' } }), {
    status: 409,
  });
  releaseMutation();
});
