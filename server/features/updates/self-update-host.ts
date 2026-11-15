import { presentationCommit, optionalCommitText } from '../../workspace/repository-views.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SelfUpdateChange } from '../../../shared/v2/contracts.ts';
import { gitRead } from '../../workspace/repository-git.ts';

/** Written once by `scripts/linux-release.mjs install`; its absence means this host has no deploy-update. */
export type ReleaseConfig = {
  user: string;
  uid: number;
  releases: string;
  current: string;
  data: string;
  node: string;
};
const configPath = () => process.env.DEPLOY_RELEASE_CONFIG || '/etc/deploy-local-release.json';

export function readReleaseConfig(path = configPath()): ReleaseConfig | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
export function runningRevision(config: ReleaseConfig): string | undefined {
  try {
    return JSON.parse(readFileSync(join(config.current, '.deploy-release.json'), 'utf8')).revision;
  } catch {
    return undefined;
  }
}

/** The project whose main contains what this coordinator runs; deploy.local hosts its own source. */
export async function findSourceRepository(
  repositories: { name: string; path: string }[],
  running: string,
  presentation = false,
) {
  const candidates = repositories
    .filter(({ path }) => path && existsSync(path))
    .sort((a, b) => Number(b.name === 'deploy.local') - Number(a.name === 'deploy.local'));
  for (const candidate of candidates) {
    const main = presentation
      ? await presentationCommit(candidate.path, 'refs/heads/main').catch(() => null)
      : 'refs/heads/main';
    if (
      main &&
      (await (presentation ? optionalCommitText : gitRead)(candidate.path, [
        'merge-base',
        '--is-ancestor',
        running,
        main,
      ])) !== null
    )
      return candidate;
  }
  return undefined;
}
export async function changesSince(path: string, running: string, presentation = false) {
  const main = presentation
    ? await presentationCommit(path, 'refs/heads/main').catch(() => '')
    : (await gitRead(path, ['rev-parse', '--verify', 'refs/heads/main^{commit}'])) || '';
  const read = presentation && main ? optionalCommitText : gitRead;
  const ahead = Number(
    (await read(path, ['rev-list', '--first-parent', '--count', `${running}..${main}`])) || 0,
  );
  const changes: SelfUpdateChange[] = (
    (await read(path, [
      'log',
      '--first-parent',
      '-n',
      '50',
      '--format=%H%x00%s%x00%cI',
      `${running}..${main}`,
    ])) || ''
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, date] = line.split('\0');
      return { sha, subject, date };
    });
  return { main, ahead, changes };
}

/** A login account's home directory, from /etc/passwd. */
export function homeOf(user: string, passwd = '/etc/passwd') {
  try {
    const line = readFileSync(passwd, 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith(`${user}:`));
    return line?.split(':')[5] || undefined;
  } catch {
    return undefined;
  }
}
