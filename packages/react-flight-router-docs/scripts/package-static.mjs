import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const bundle = join(dist, 'deploy');
const archive = join(dist, 'flight-router-docs.tar.gz');
rmSync(bundle, { recursive: true, force: true });
rmSync(archive, { force: true });
const assets = readdirSync(dist);
mkdirSync(join(bundle, 'site'), { recursive: true });
for (const name of assets) cpSync(join(dist, name), join(bundle, 'site', name), { recursive: true });
for (const name of ['Dockerfile', 'nginx.conf', 'deploy.yaml']) cpSync(join(root, name), join(bundle, name));
execFileSync('tar', ['-czf', archive, '-C', bundle, '.']);
console.log(`Static deployment bundle: ${archive}`);
