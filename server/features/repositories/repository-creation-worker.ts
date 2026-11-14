import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureSnapshot,
  recordCheckpointBase,
  restoreSnapshot,
} from '../../workspace/checkpoint.ts';
import { gitText } from '../../workspace/repository-git.ts';

/** Publish through the scoped tool protocol; never expose the worker's enrollment token to agents. */
export async function continueRepositoryCreation(
  cwd: string,
  args: any,
  initial: any,
  call: (args: any) => Promise<any>,
  options: { wait?: () => Promise<void>; now?: () => number } = {},
) {
  const wait = options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 1000)));
  const now = options.now ?? Date.now;
  const deadline = now() + 600000;
  let result = initial;
  while (result.pending) {
    if (now() >= deadline)
      throw new Error('Repository setup is still pending. Retry the identical operationId.');
    await wait();
    result = await call(args);
  }
  const receipt = `refs/deploy/repository-creation/${createHash('sha256').update(args.operationId).digest('hex')}`;
  if (result.stage !== 'publish') {
    // A lost final response is safe: the worker installed the commit before sending it.
    return result;
  }
  const directory = await mkdtemp(join(tmpdir(), 'deploy-repository-worker-'));
  try {
    let commit = await gitText(cwd, ['rev-parse', '--verify', '--quiet', receipt]).catch(() => '');
    const bundlePath = join(directory, 'initial.bundle');
    if (!commit) {
      const snapshot = captureSnapshot(cwd);
      if (snapshot.excluded.length)
        throw new Error(
          `Resolve excluded files before creating the initial repository commit: ${snapshot.excluded.join(', ')}`,
        );
      const stage = join(directory, 'source');
      restoreSnapshot(snapshot, stage);
      await gitText(stage, ['init', '--template=', '--initial-branch=initial']);
      const seedPath = join(directory, 'seed.bundle');
      await writeFile(seedPath, Buffer.from(result.seedBundle, 'base64'), { mode: 0o600 });
      await gitText(stage, ['fetch', seedPath, 'refs/heads/main']);
      await gitText(stage, ['add', '--force', '--all']);
      const tree = await gitText(stage, ['write-tree']);
      commit = await gitText(stage, ['commit-tree', tree, '-p', result.seed], {
        identity: 'deploy.local',
        input: 'Create repository from task workspace\n',
      });
      await gitText(stage, ['update-ref', 'refs/heads/initial', commit]);
      await gitText(stage, ['bundle', 'create', bundlePath, 'refs/heads/initial']);
      await gitText(cwd, ['fetch', '--no-tags', bundlePath, `refs/heads/initial:${receipt}`]);
    } else {
      // Export a fixed ref name, irrespective of the task's branch or later working edits.
      const stage = join(directory, 'source');
      await gitText(cwd, ['clone', '--bare', '--no-hardlinks', cwd, stage]);
      await gitText(stage, ['update-ref', 'refs/heads/initial', commit]);
      await gitText(stage, ['bundle', 'create', bundlePath, 'refs/heads/initial']);
    }
    const remotes = (await gitText(cwd, ['remote'])).split('\n');
    await gitText(cwd, [
      'remote',
      remotes.includes('origin') ? 'set-url' : 'add',
      'origin',
      result.cloneUrl,
    ]);
    // Change Git metadata only. Preserve working files, including ignored local configuration.
    // Install once; an identical retry must not move a branch that has advanced since publication.
    const branch = `refs/heads/task/${result.taskId}`;
    const installed = `${receipt}-installed`;
    const proof = await gitText(cwd, ['rev-parse', '--verify', '--quiet', installed]).catch(
      () => '',
    );
    if (!proof) {
      const existing = await gitText(cwd, ['rev-parse', '--verify', '--quiet', branch]).catch(
        () => '',
      );
      await gitText(cwd, ['update-ref', branch, commit, existing || '0'.repeat(40)]);
      await gitText(cwd, ['symbolic-ref', 'HEAD', branch]);
      await gitText(cwd, ['read-tree', commit]);
      await gitText(cwd, ['update-ref', installed, commit]);
    }
    result = await call({
      ...args,
      publication: { commit, bundle: (await readFile(bundlePath)).toString('base64') },
    });
    // The coordinator now has this commit, so later checkpoints are a delta over it.
    recordCheckpointBase(cwd, commit);
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
