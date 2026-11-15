import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

/** A conversation has private working files without becoming a hosted project.
 * A deterministic empty baseline lets any assigned worker review against the same commit.
 */
export function initializeScratchWorkspace(path: string) {
  mkdirSync(path, { recursive: true });
  const run = (args: string[]) => {
    const result = spawnSync('git', ['-C', path, ...args], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'deploy.local',
        GIT_AUTHOR_EMAIL: 'workspace@deploy.local',
        GIT_COMMITTER_NAME: 'deploy.local',
        GIT_COMMITTER_EMAIL: 'workspace@deploy.local',
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      },
    });
    if (result.status !== 0) throw new Error(result.stderr || 'Unable to prepare conversation');
    return result.stdout.trim();
  };
  run(['init', '--template=', '--initial-branch=main', '--object-format=sha1']);
  run([
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--allow-empty',
    '-m',
    'Initialize conversation',
  ]);
  return run(['rev-parse', 'HEAD']);
}
