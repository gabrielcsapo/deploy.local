import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
export const captures = [
  ['Inbox', '/dashboard/inbox?tab=answered', '1440,700', 1000],
  ['AnsweredPhone', '/dashboard/inbox?tab=answered', '390', 844],
  ['Live', '/dashboard/live', '1440,700', 1100],
  ['Worker', '/dashboard/live/home-gym-sync', '1440,700', 1000],
  ['AutoRollback', '/dashboard/live?board=AutoRollback', '1440,700', 1100],
  ['Deployments', '/dashboard/projects/deploy%2Elocal/releases', '1440,700', 900],
  ['ReleaseFailed', '/dashboard/projects/home-gym/releases/b81e4c0', '1440,700', 900],
  ['Backups', '/dashboard/settings/backups', '1440,700', 1240],
  ['RestoreData', '/dashboard/settings/backups?restore=pre-release', '1440,700', 900],
  ['AppsHome', '/', '1440,700', 900],
  ['NewProject', '/dashboard/start/project', '1440,700', 900],
  ['InstallApp', '/dashboard/discover/immich', '1440,700', 900],
  ['FirstTask', '/dashboard/tasks/FirstTask', '1440,700', 900],
  ['LandingPhone', '/about', '390', 844],
];
const directory = 'docs/evidence/v2/polish-a';
mkdirSync(`${directory}/captures`, { recursive: true });
for (const [board, path, widths, height] of captures) {
  const capture = spawnSync(
    process.execPath,
    [
      'design/v2/tools/capture.mjs',
      `http://127.0.0.1:5194${path}`,
      `${directory}/captures/${board}`,
      widths,
      String(height),
    ],
    { stdio: 'inherit' },
  );
  if (capture.status) process.exit(capture.status);
  for (const width of widths.split(',')) {
    const pair = spawnSync(
      'uv',
      [
        'run',
        '--no-project',
        '--python',
        '3.13',
        '--with',
        'pillow',
        'python',
        'design/v2/tools/pair.py',
        `${directory}/${board}-${width}.png`,
        `design/v2/canvas/png/${board}-${width}.png`,
        `${directory}/captures/${board}-${width}.png`,
      ],
      { stdio: 'inherit' },
    );
    if (pair.status) process.exit(pair.status);
  }
}
