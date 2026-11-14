import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentScope } from './coordination.ts';
import { command, get, save, event, now } from './store.ts';
import { queueProject, repositoryWebURL } from './repositories.ts';
import { gitText } from './repository-git.ts';
import { queuePushTrigger } from './pipeline-triggers.ts';

/** The tool endpoint is the authenticated push transport. Worker Git credentials stay read-only. */
export async function createRepository(scope: AgentScope, args: any) {
  const { owner, taskId, runId } = scope;
  const signature = createHash('sha256')
    .update(
      JSON.stringify({
        taskId,
        tool: 'deploy_create_repository',
        name: args.name,
        description: args.description,
      }),
    )
    .digest('hex');
  const reservation = command(
    owner,
    args.operationId,
    () => {
      if (typeof args.name !== 'string') throw new Error('Repository name required');
      const task = get('task', owner, taskId);
      if (task.projectId) {
        const project = get('project', owner, task.projectId);
        throw new Error(`This conversation already has repository project "${project.name}"`);
      }
      const project = queueProject(owner, { name: args.name, description: args.description });
      save('task', owner, {
        ...task,
        projectId: project.id,
        revision: task.revision + 1,
        updatedAt: now(),
      });
      event(owner, taskId, runId, 'task.repository-attached', { projectId: project.id });
      return save('repository-creation', owner, {
        id: project.id,
        taskId,
        runId,
        createdAt: now(),
      });
    },
    signature,
  );
  const record = get('repository-creation', owner, reservation.id);
  if (record.result) return record.result;
  const project = get('project', owner, record.id);
  if (project.repositoryStatus !== 'ready') {
    if (project.repositoryStatus !== 'preparing')
      throw new Error(
        `Repository setup ${project.repositoryStatus}; inspect its repository operation before retrying`,
      );
    return { pending: true };
  }
  const directory = await mkdtemp(join(tmpdir(), 'deploy-create-repository-'));
  try {
    const seed = record.seed || project.head;
    if (!seed) throw new Error('Repository setup did not record its seed commit');
    // Persist the expected seed before accepting a worker publication, including after a restart.
    if (!record.seed)
      save('repository-creation', owner, {
        ...get('repository-creation', owner, project.id),
        seed,
      });
    const cloneUrl = `https://deploy.local/api/git/${project.id}`;
    const base = { project: { id: project.id, name: project.name }, cloneUrl, branch: 'main' };
    if (!args.publication) {
      const bundlePath = join(directory, 'seed.bundle');
      await gitText(project.repositoryPath, ['bundle', 'create', bundlePath, seed, '--all']);
      return {
        ...base,
        stage: 'publish',
        taskId,
        seed,
        seedBundle: (await readFile(bundlePath)).toString('base64'),
      };
    }
    const { commit, bundle } = args.publication;
    if (
      typeof commit !== 'string' ||
      !/^[a-f0-9]{40}$/.test(commit) ||
      typeof bundle !== 'string' ||
      bundle.length > 24 * 1024 * 1024
    )
      throw new Error('Invalid initial repository publication');
    const bundlePath = join(directory, 'initial.bundle');
    await writeFile(bundlePath, Buffer.from(bundle, 'base64'), { mode: 0o600 });
    await gitText(project.repositoryPath, ['bundle', 'verify', bundlePath]);
    await gitText(project.repositoryPath, [
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      bundlePath,
      'refs/heads/initial',
    ]);
    const tip = await gitText(project.repositoryPath, [
      'bundle',
      'list-heads',
      bundlePath,
      'refs/heads/initial',
    ]);
    if (
      tip !== `${commit} refs/heads/initial` ||
      (await gitText(project.repositoryPath, ['show', '-s', '--format=%P', commit])) !== seed
    )
      throw new Error('Initial publication must be one commit based on the repository seed');
    const current = await gitText(project.repositoryPath, ['rev-parse', 'main']);
    if (current !== commit) {
      if (current !== seed) throw new Error('Repository main changed; refusing to overwrite it');
      try {
        await gitText(project.repositoryPath, ['update-ref', 'refs/heads/main', commit, seed]);
      } catch (error) {
        // Concurrent identical retries can race the CAS; only the same published commit is success.
        if ((await gitText(project.repositoryPath, ['rev-parse', 'main'])) !== commit) throw error;
      }
    }
    return command(
      owner,
      `repository-created:${project.id}`,
      () => {
        const task = get('task', owner, taskId);
        if (task.projectId !== project.id) throw new Error('Task repository changed');
        const result = { ...base, commit };
        save('project', owner, {
          ...get('project', owner, project.id),
          head: commit,
          updatedAt: now(),
        });
        save('task', owner, {
          ...task,
          baseRevision: commit,
          sourceRef: 'main',
          revision: task.revision + 1,
          updatedAt: now(),
        });
        save('repository-creation', owner, {
          ...get('repository-creation', owner, project.id),
          result,
          completedAt: now(),
        });
        queuePushTrigger(owner, project.id, 'refs/heads/main', commit);
        const label = project.name.replace(/[\\`*_[\]<>]/g, '\\$&');
        const message = save('message', owner, {
          id: `repository:${project.id}`,
          taskId,
          runId,
          role: 'assistant',
          createdAt: now(),
          content: `> **Repository created**\n>\n> [${label}](${repositoryWebURL(owner, project)})`,
          repository: result,
        });
        event(owner, taskId, runId, 'message', message);
        return result;
      },
      signature,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
