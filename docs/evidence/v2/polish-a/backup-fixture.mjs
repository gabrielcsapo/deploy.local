// Capture-only data adapted from ../10-backups/fixture-server.mjs; no production imports.
// In-memory visual fixture; imports no coordinator code and never opens app data.
const point = (id, name, sizeBytes, contents, computer, extra = {}) => ({
  id,
  name,
  projectId: name.toLowerCase(),
  apps: [name.toLowerCase()],
  kind: 'scheduled',
  createdAt: '2026-10-27T07:00:00Z',
  sizeBytes,
  contents,
  destination: '/mnt/backup',
  computer,
  verified: true,
  testStatus: 'untested',
  restoreAvailable: true,
  ...extra,
});
const backups = [
  point('pre-release', 'home-gym', 1.2e9, ['Postgres 17'], 'SER', {
    kind: 'pre-release',
    createdAt: '2026-10-27T17:57:00Z',
    releaseId: '9c3e1fa',
    testedAt: '2026-10-21T07:00:00Z',
    testStatus: 'passed',
  }),
  point('nightly', 'home-gym', 1.2e9, ['Postgres 17'], 'SER'),
  point('yesterday', 'home-gym', 1.2e9, ['Postgres 17'], 'SER', {
    createdAt: '2026-10-26T07:00:00Z',
  }),
  point('immich', 'Immich', 212e9, ['Photos and database'], 'SER'),
  point('vault', 'Vaultwarden', 40e6, ['Database'], 'bazzite'),
  point('recovery', 'deploy.local', 3.4e9, ['Projects, tasks, settings and secrets'], 'SER', {
    kind: 'recovery',
    restoreAvailable: false,
    unavailableReason:
      'Recover deploy.local on a new computer. Test-restore checks this bundle in a temporary folder.',
  }),
];

export { backups };
