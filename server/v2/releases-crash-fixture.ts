// Child process for recovery tests. Runtime side effects are files, never Docker or network.
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectReleaseService } from './releases.ts';
import type { ReleaseRuntime, ReleasePlan } from './releases.ts';
const root = process.env.DEPLOY_DATA_DIR!;
const boundary = process.argv[2];
const project = {
  id: 'gym',
  name: 'home-gym',
  apps: ['web', 'sync'].map((name) => ({ id: name, name, kind: 'web' as const })),
};
const saveLive = (value: unknown) => writeFileSync(join(root, 'live.json'), JSON.stringify(value));
const crash = () => process.kill(process.pid, 'SIGKILL');
let revision = 0;
let rollingBack = false;
const hit = (name: string) => boundary === (rollingBack ? `rollback-${name}` : name);
const runtime: ReleaseRuntime = {
  async plan() {
    revision++;
    return {
      apps: project.apps.map((app) => ({ appId: app.id, to: `next-${revision}` })),
      migrations: [],
      runtime: {},
    };
  },
  async prepare() {
    if (hit('prepare')) crash();
  },
  async verify() {},
  async backup() {
    throw new Error('No migrations in crash fixture');
  },
  async activate(plan) {
    saveLive({ web: plan.apps[0].to, sync: 'old' });
    if (hit('partial')) crash();
    saveLive({ web: plan.apps[0].to, sync: plan.apps[1].to });
    writeFileSync(join(root, 'published'), 'yes');
    if (hit('published')) crash();
  },
  async migrate() {},
  async watch() {
    if (hit('watch')) crash();
  },
  async rollback(_from: ReleasePlan, to: ReleasePlan) {
    writeFileSync(join(root, 'previous-live.json'), readFileSync(join(root, 'live.json')));
    rmSync(join(root, 'published'), { force: true });
    await runtime.activate(to);
  },
  async dispose() {},
};
saveLive({ web: 'old', sync: 'old' });
const service = new ProjectReleaseService(runtime, { watchMs: 0 });
service.ship('owner', project, { source: { kind: 'ship', ref: 'main' } });
await service.settled();

if (boundary.startsWith('rollback-')) {
  service.ship('owner', project, { source: { kind: 'ship', ref: 'second' } });
  await service.settled();
  rollingBack = true;
  service.rollback('owner', project, {});
  await service.settled();
}
