// Local-only fixture: all generated files live in a temporary directory.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from '../dist/build/build-orchestrator.js';
import { createServer } from '../dist/server/index.js';

process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(packageRoot, 'package.json'));
const { serve } = require('@hono/node-server');
const port = Number(process.env.PORT ?? 5304);
if (port < 5300 || port > 5349) throw new Error('Use ports 5300–5349');
const directory = mkdtempSync(resolve(tmpdir(), 'rfr-v1-fixture-'));
const write = (file, contents) => {
  const path = resolve(directory, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
};
symlinkSync(
  resolve(packageRoot, '../react-flight-router-example/node_modules'),
  resolve(directory, 'node_modules'),
);
write('package.json', '{"name":"rfr-telemetry-fixture","type":"module"}');
if (process.argv.includes('--example')) {
  for (const file of ['app', 'public', 'vite.config.ts', 'server.ts'])
    cpSync(resolve(packageRoot, '../react-flight-router-example', file), resolve(directory, file), {
      recursive: true,
    });
} else {
  write(
    'app/routes.ts',
    `export const routes = [{id:'root', component:()=>import('./root'), children:[{id:'home',index:true,component:()=>import('./home')},{id:'photo',path:'photos/:id',component:()=>import('./photo')},{id:'suspense',path:'suspense',component:()=>import('./suspense')}]}];`,
  );
  write(
    'app/root.tsx',
    `import { Outlet } from 'react-flight-router/client'; export default function Root(){return <html><head/><body><Outlet/></body></html>}`,
  );
  write(
    'app/home.tsx',
    `import { Link } from 'react-flight-router/client'; export default function Home(){return <main><h1>Fixture home</h1><Link to='/photos/hit?secret=redacted' prefetch='render'>Hit</Link><Link to='/photos/inflight?secret=redacted' prefetch='intent'>Inflight</Link><Link to='/photos/miss?secret=redacted'>Miss</Link></main>}`,
  );
  write('app/photo.tsx', `export default function Photo(){return <h1>Committed photo</h1>}`);
  write(
    'app/suspense.tsx',
    `import { Suspense } from 'react'; async function Slow(){await new Promise(resolve=>setTimeout(resolve,500));return <div id='resolved'>Resolved boundary</div>} export default function Page(){return <main><h1>Shell</h1><Suspense fallback={<p id='fallback'>Waiting</p>}><Slow/></Suspense></main>}`,
  );
  write('server.ts', 'export {};');
}
const output = resolve(directory, 'dist');
process.chdir(directory);
await build({ appRoot: directory, outDir: output });
if (process.argv.includes('--build-only')) {
  console.log(`RFR_FIXTURE=${directory}`);
} else {
  // A fake local collector: the actual collector is owned by deploy.local's edge.
  const telemetry = process.argv.includes('--telemetry');
  if (telemetry) {
    process.env.DEPLOY_TELEMETRY_URL = `http://127.0.0.1:${port}`;
    process.env.DEPLOY_TELEMETRY_TOKEN = 'fixture-only';
  } else delete process.env.DEPLOY_TELEMETRY_URL;
  const app = await createServer({ buildDir: output });
  serve({
    hostname: '127.0.0.1',
    port,
    fetch: (request) => {
      const pathname = new URL(request.url).pathname;
      if (request.method === 'POST' && ['/__deploy/telemetry', '/v1/server'].includes(pathname))
        return new Response(null, { status: 204 });
      return app.fetch(request);
    },
  });
  console.log(`RFR_FIXTURE=${directory} URL=http://127.0.0.1:${port} TELEMETRY=${telemetry}`);
}
