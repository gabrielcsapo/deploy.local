import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// Only loaded by unpackaged Electron with an explicit, disposable fixture profile.
export function fixtureRuntime() {
  const origin = process.env.DEPLOY_COORDINATOR_URL;
  if (origin !== 'http://127.0.0.1:5184' || process.env.DEPLOY_DESKTOP_DISABLE_MDNS !== '1')
    throw new Error('Capture requires the loopback fixture and disabled mDNS.');
  const directory = realpathSync(process.env.DEPLOY_DESKTOP_DATA_DIR);
  if (
    !basename(directory).startsWith('deploy-desktop-capture-') ||
    dirname(directory) !== realpathSync(tmpdir())
  )
    throw new Error('Capture requires a temporary user-data directory.');
  const linux = process.env.DEPLOY_DESKTOP_FIXTURE_PLATFORM === 'linux';
  const roles = { takeTasks: true, useScreen: false, runApps: false, serveModels: false };
  const worker = {
    selection: roles,
    state: 'Ready for tasks',
    status: () => ({ state: worker.state, roles, screenSupported: !linux }),
    stop: async () => {},
    configure: async () => {
      throw new Error('Fixture capture never enrolls or starts a worker.');
    },
  };
  return {
    origin,
    worker,
    vault: { available: () => true, read: () => ({}), write: () => {} },
    enrollment: { workerId: 'desktop-fixture' },
    state: {
      origin,
      platform: linux ? 'linux' : 'darwin',
      name: linux ? 'bazzite' : 'MacBook Pro',
      hardware: linux
        ? 'AMD Ryzen 7 7840HS · 32 GB · Bazzite 42'
        : 'Apple M4 Pro · 48 GB · macOS 27',
      now: Date.parse('2026-10-27T18:32:00Z'),
    },
    notificationFile: join(directory, 'notification.json'),
  };
}
