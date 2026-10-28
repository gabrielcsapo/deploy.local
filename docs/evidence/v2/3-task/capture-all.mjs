// Run after starting fixture-server.mjs and Vite on 5188/5187.
import { spawnSync } from 'node:child_process';
import { boards } from './fixtures.mjs';
const root = 'docs/evidence/v2/3-task';
for (const board of boards) {
  const path =
    board === 'PullRequests'
      ? '/dashboard/projects/deploy.local/pulls'
      : `/dashboard/tasks/${board}${board === 'TaskChanges' ? '/changes' : board === 'TaskChecks' ? '/checks' : board === 'ShipDialog' ? '#ship' : ''}`;
  const height = 900;
  const capture = spawnSync(
    process.execPath,
    [
      'design/v2/tools/capture.mjs',
      `http://127.0.0.1:5187${path}`,
      `${root}/captures/${board}`,
      '1440,700',
      String(height),
    ],
    { stdio: 'inherit' },
  );
  if (capture.status !== 0) process.exit(capture.status || 1);
  for (const width of [1440, 700]) {
    const paired = spawnSync(
      'python3',
      [
        'design/v2/tools/pair.py',
        `${root}/${board}-${width}.png`,
        `design/v2/canvas/png/${board}-${width}.png`,
        `${root}/captures/${board}-${width}.png`,
      ],
      { stdio: 'inherit' },
    );
    if (paired.status !== 0) process.exit(paired.status || 1);
  }
}
