// Record a read-only CLI example against synthetic releases, never a coordinator.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const server = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/api/v2/projects/home-gym/releases') {
    res.writeHead(404);
    return res.end('{}');
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      releases: [
        { id: '9c3e1fa', state: 'live', apps: [{ appId: 'home-gym' }, { appId: 'home-gym-sync' }] },
        {
          id: '81be0d2',
          state: 'superseded',
          apps: [{ appId: 'home-gym' }, { appId: 'home-gym-sync' }],
        },
      ],
    }),
  );
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(5181, '127.0.0.1', resolve);
});
try {
  const child = spawn(
    process.execPath,
    ['bin/deploy.js', 'releases', 'home-gym', '-u', 'http://127.0.0.1:5181'],
    {
      // A non-empty auth override prevents reading ~/.deployrc. This fixture needs no credentials.
      env: { ...process.env, DEPLOY_AUTH_JSON: '{}', DEPLOY_AUTH_FILE: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(output);
  writeFileSync(
    new URL('./CliReleases.txt', import.meta.url),
    `$ deploy releases home-gym\n${output}[exit ${code}]\n`,
  );
  console.log(output);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
