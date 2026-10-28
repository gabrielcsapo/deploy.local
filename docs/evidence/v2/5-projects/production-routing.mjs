// Run after pnpm build. Exercises production RSC routing in memory, with no
// listener, coordinator, database or runtime services.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'react-flight-router/server';
const app = await createServer({ buildDir: resolve('dist'), workers: false });
for (const name of ['deploy.local', 'deploy%2Elocal']) {
  for (const suffix of [
    '',
    '/code',
    '/issues',
    '/apps/deploy.local',
    '/apps/deploy.local/settings',
    '/logs?app=deploy.local',
    '/settings',
  ]) {
    const path = `/dashboard/projects/${name}${suffix}`;
    const response = await app.request(new Request(`http://fixture.invalid${path}`));
    const html = await response.text();
    assert.equal(response.status, 200, path);
    assert.ok(html.includes('v2-projects-p'), path);
    console.log(`200 ${path}`);
  }
}
