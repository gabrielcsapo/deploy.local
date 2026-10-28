// Single-port fixture: actual Task route and ShipDialog, isolated from the coordinator.
import { readFileSync } from 'node:fs';
import { createServer, loadConfigFromFile } from 'vite';
const original = new URL('../3-task/fixture-server.mjs', import.meta.url);
let source = readFileSync(original, 'utf8')
  .replace(
    "'./fixtures.mjs'",
    JSON.stringify(new URL('../3-task/fixtures.mjs', import.meta.url).href),
  )
  .replace(
    'new URL(`./assets/meal-planner-${index}.svg`, import.meta.url)',
    'new URL(`./assets/meal-planner-${index}.svg`, ' + JSON.stringify(original.href) + ')',
  )
  .replace("server.listen(5188, '127.0.0.1', () => console.log('Task fixture on 5188'));", '')
  .replace('for (const signal of', 'export { server };\nfor (const signal of');
source = source.replace(
  "  if (path === '/api/user')",
  `  if (path.endsWith('/releases/plan')) return send({ plan: {
    computers: [{ id: 'coordinator', name: 'SER' }, { id: 'bazzite', name: 'bazzite' }],
    apps: [{ appId: 'meal-planner', computerId: 'coordinator', address: 'meal-planner.deploy.local', visibility: 'home', data: 'new' }],
  }});
  if (path === '/api/user')`,
);
const { server: fixture } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);
const handler = fixture.listeners('request')[0];
const config = (await loadConfigFromFile({ command: 'serve', mode: 'development' })).config;
const vite = await createServer({
  ...config,
  configFile: false,
  server: { ...config.server, proxy: {}, host: '127.0.0.1', port: 5188, strictPort: true },
  plugins: [
    {
      name: 'release-choices-fixture',
      enforce: 'pre',
      configureServer(server) {
        server.middlewares.use((req, res, next) =>
          req.url?.startsWith('/api/') ? handler(req, res) : next(),
        );
      },
    },
    ...config.plugins.filter((plugin) => plugin.name !== 'deploy-local-development-api-proxy'),
  ],
});
await vite.listen();
console.log('ShipDialog fixture: http://127.0.0.1:5188/dashboard/tasks/ShipDialog#ship');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await vite.close();
    process.exit();
  });
