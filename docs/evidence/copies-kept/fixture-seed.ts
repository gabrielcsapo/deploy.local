// Synthetic data only: fills an empty data directory with kept npm packages and Cargo crates
// shaped like the Copies boards, for comparing the real pages with them.
//   DEPLOY_DATA_DIR=<empty folder> node docs/evidence/copies-kept/fixture-seed.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

if (!process.env.DEPLOY_DATA_DIR) throw new Error('Set DEPLOY_DATA_DIR to an empty folder');
const { registerUser } = await import('../../../server/store.ts');
const { db, objectPath } = await import('../../../server/packages/store.ts');
const { save } = await import('../../../server/workspace/store.ts');

const owner = 'gabriel';
registerUser(owner, 'copies-fixture-password');
db().prepare("UPDATE users SET role='admin' WHERE username=?").run(owner);
const projects = ['forma', 'wander', 'mdink', 'tally', 'home-gym'];
for (const name of projects) save('project', owner, { id: name, name });

const MB = 1024 ** 2;
const day = 86400000;
async function add(ecosystem: string, name: string, version: string, size: number, days: number) {
  const key = `${name}@${version}`;
  const sha256 = createHash('sha256')
    .update(ecosystem + key)
    .digest('hex');
  const path = objectPath('cache', sha256);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'copy');
  const date = new Date(Date.now() - days * day).toISOString();
  db()
    .prepare(
      "INSERT INTO package_cache_entries(ecosystem,kind,key,sha256,size,fetched_at,last_used_at) VALUES(?,'file',?,?,?,?,?)",
    )
    .run(ecosystem, key, sha256, Math.round(size), date, date);
}
function need(project: string, name: string, version: string) {
  db()
    .prepare('INSERT INTO package_project_requirements VALUES(?,?,?,?,?)')
    .run(owner, project, `${name}@${version}`, name, version);
}
// name, kind, versions, total MB, days since the newest was installed, projects needing the newest
const rows: [string, string, number, number, number, string[]][] = [
  ['typescript', 'npm', 41, 412, 0, ['forma', 'wander', 'tally']],
  ['@swc/core-darwin-arm64', 'npm', 12, 268, 4, ['forma', 'wander']],
  ['next', 'npm', 18, 231, 17, ['forma']],
  ['windows-sys', 'cargo', 9, 44, 7, []],
  ['esbuild', 'npm', 22, 38, 0, projects],
  ['puppeteer', 'npm', 3, 31, 86, []],
  ['tokio', 'cargo', 6, 12, 7, []],
];
for (let i = 0; i < 60; i++)
  rows.push([`left-pad-${String(i).padStart(2, '0')}`, 'npm', 2, 4 - i / 20, 35 + i, []]);
for (let i = 0; i < 6; i++) rows.push([`serde-extra-${i}`, 'cargo', 2, 2, 50, []]);
for (const [name, ecosystem, versions, size, days, needing] of rows) {
  for (let v = 0; v < versions; v++) {
    const version = `${ecosystem === 'npm' ? 5 : 1}.${versions - v}.0`;
    // Older versions were last installed longer ago, so the idle list has something in it.
    await add(ecosystem, name, version, (size * MB) / versions, days + v * 12);
    if (v === 0) for (const project of needing) need(project, name, version);
  }
}
console.log(`Seeded ${rows.length} packages for ${owner}`);
