import { defineConfig } from 'playwright/test';
export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:5304', browserName: 'chromium' },
  webServer: [
    {
      command:
        'DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5304 node scripts/telemetry-fixture.mjs --telemetry',
      url: 'http://127.0.0.1:5304',
      timeout: 60_000,
      reuseExistingServer: false,
      cwd: new URL('..', import.meta.url).pathname,
    },
    {
      command: 'DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5305 node scripts/telemetry-fixture.mjs',
      url: 'http://127.0.0.1:5305',
      timeout: 60_000,
      reuseExistingServer: false,
      cwd: new URL('..', import.meta.url).pathname,
    },
  ],
});
