// Runs in the existing pipeline service process, never on a request's main thread.
import { db as workspace, get, save, id, now } from '../workspace/store.ts';
import { gitText } from '../workspace/repository-git.ts';
import { computers } from '../workspace/coordination.ts';
import { db, nameOf, versionOf, packageByName } from './store.ts';
import { npmRegistry } from './npm.ts';
import type { NpmCopy } from './cache.ts';

const terminal = ['succeeded', 'failed', 'cancelled', 'timed_out', 'unknown', 'skipped'];
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export async function packageAtCommit(repository: string, commit: string, path: string) {
  // git show reads blobs only; no checkout, install, hooks, or project code on the server.
  const prefix = `${commit}:${path}/`;
  const text = await gitText(repository, ['show', prefix + 'package.json'], { limit: 65536 }).catch(
    () => null,
  );
  if (text === null) {
    if (
      await gitText(repository, ['show', prefix + 'Cargo.toml'], { limit: 65536 }).then(
        () => true,
        () => false,
      )
    )
      return { path, status: 'skipped', reason: "Cargo isn't available yet" };
    throw new Error(`${path}: package.json was not found at this commit`);
  }
  const manifest = JSON.parse(text);
  if (manifest.private) throw new Error(`${path}: This package is marked private.`);
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string')
    throw new Error(`${path}: A package name and version are required`);
  return {
    path,
    name: nameOf(manifest.name),
    version: versionOf(manifest.version),
    status: 'waiting',
  };
}
export async function checkPipelinePackage(projectId: string, item: any, copy: NpmCopy) {
  const pkg = packageByName(item.name);
  if (pkg && pkg.project_id !== projectId)
    throw new Error(
      `${item.name}: This package belongs to another project. Publish it once from this repository with your CLI sign-in.`,
    );
  if (pkg) {
    const existing = db()
      .prepare('SELECT 1 FROM package_versions WHERE package_id=? AND version=?')
      .get(pkg.id, item.version);
    const previous = db()
      .prepare(
        'SELECT version FROM package_versions WHERE package_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
      )
      .get(pkg.id) as any;
    return { exists: !!existing, previousVersion: previous?.version };
  }
  if (!item.name.startsWith('@deploy.local/')) {
    const doc = await copy.document(item.name, true);
    if (copy.failures)
      throw new Error(
        'Cannot check whether this name exists on npmjs.org while it is unreachable.',
      );
    if (doc && Object.keys(await copy.index(doc)).length)
      throw new Error(
        `${item.name}: This name exists on npmjs.org. An admin must use deploy packages publish --claim. Pipelines cannot claim names.`,
      );
  }
  return { exists: false };
}
export async function advancePipelinePackages(
  owner: string,
  pipelineId: string,
  copy = npmRegistry.copy,
) {
  let run = get('pipeline-run', owner, pipelineId);
  if (
    run.status !== 'succeeded' ||
    !run.specification.publish?.length ||
    ['succeeded', 'failed'].includes(run.packages?.status)
  )
    return;
  const persist = (packages: any) => {
    run = get('pipeline-run', owner, pipelineId);
    save('pipeline-run', owner, { ...run, packages, updatedAt: now() });
    run.packages = packages;
  };
  let items = run.packages?.items || [];
  try {
    const project = get('project', owner, run.projectId);
    if (project.owner !== owner)
      throw new Error("Only the repository owner's pipelines may publish");
    if (run.stopRequested) throw new Error('Pipeline cancelled');
    const checkOnly = !!run.pullId || run.trigger === 'pull_request';
    if (!run.packages?.items) {
      items = [];
      let base: string | undefined;
      if (checkOnly) {
        if (!run.pullId) throw new Error('Pull-request package checks require a pull request');
        const pull = get('pull-request', owner, run.pullId);
        base = await gitText(project.repositoryPath, [
          'merge-base',
          `refs/heads/${pull.targetBranch}`,
          run.commit,
        ]);
      }
      // Run pipeline accepts any ref, and a published version can't be taken back.
      const main = project.defaultBranch || 'main';
      const merged =
        checkOnly ||
        (await gitText(project.repositoryPath, [
          'merge-base',
          '--is-ancestor',
          run.commit,
          `refs/heads/${main}`,
        ]).then(
          () => true,
          () => false,
        ));
      for (const path of run.specification.publish) {
        const item: any = await packageAtCommit(project.repositoryPath, run.commit, path);
        if (!merged && item.status === 'waiting') {
          item.status = 'skipped';
          item.reason = `this commit isn't on ${main}`;
        }
        if (base && item.name) {
          const old = await packageAtCommit(project.repositoryPath, base, path).catch(() => null);
          if (old?.name === item.name && old?.version === item.version) continue;
        }
        items.push(item);
      }
      persist({ status: 'running', checkOnly, items, startedAt: now() });
    }
    for (const item of items) {
      if (['published', 'skipped', 'checked'].includes(item.status)) continue;
      if (item.jobId) {
        const job = get('job', owner, item.jobId);
        if (!terminal.includes(job.status)) {
          if (Date.now() - Date.parse(job.createdAt) > 35 * 60_000) {
            save('job', owner, {
              ...job,
              stopRequested: true,
              status: job.status === 'running' ? 'running' : 'failed',
              error: 'Package job timed out waiting for a capable computer',
              updatedAt: now(),
            });
            throw new Error(
              'Package job timed out. Update deploy.local on a Linux computer with pnpm and run the pipeline again.',
            );
          }
          return;
        }
        // Another run may have published while this one was packing, or the upload
        // may have committed before its response was lost. Never retry that version.
        const pkg = !checkOnly && packageByName(item.name);
        const published =
          pkg && pkg.project_id === project.id
            ? (db()
                .prepare('SELECT manifest FROM package_versions WHERE package_id=? AND version=?')
                .get(pkg.id, item.version) as { manifest: string } | undefined)
            : undefined;
        if (published) {
          item.status =
            JSON.parse(published.manifest)._deployPipeline?.id === run.id ? 'published' : 'skipped';
          if (item.status === 'skipped') item.reason = 'this version is already published';
          persist({ ...run.packages, items });
          continue;
        }
        if (job.status !== 'succeeded')
          throw new Error(
            `${item.name}: ${job.error || `Package job ${job.status}. Check its log.`}`,
          );
        if (checkOnly) {
          const result = await checkPipelinePackage(project.id, item, copy);
          if (result.exists)
            throw new Error(
              `${item.version} is already published. Set a new version in package.json.`,
            );
          item.status = 'checked';
        } else {
          throw new Error(
            'The computer did not publish the package. Update its deploy.local worker and run the pipeline again.',
          );
        }
        persist({ ...run.packages, items });
        continue;
      }
      const result = await checkPipelinePackage(project.id, item, copy);
      item.previousVersion = result.previousVersion;
      if (result.exists) {
        if (checkOnly)
          throw new Error(
            `${item.version} is already published. Set a new version in package.json.`,
          );
        item.status = 'skipped';
        item.reason = 'this version is already published';
        persist({ ...run.packages, items });
        continue;
      }
      const linux = computers(owner).filter(
        (computer: any) => computer.platform === 'linux' && computer.status === 'online',
      );
      if (
        linux.length &&
        !linux.some((computer: any) => computer.capabilities?.includes('package-publish-v1'))
      )
        throw new Error(
          'The online Linux computers run older workers. Update deploy.local on a Linux computer so it can publish packages, then run the pipeline again.',
        );
      const jobId = id();
      // A fresh checkout needs its dependencies; pnpm pack resolves workspace: ranges.
      // prepublishOnly is a publish hook, not a pack hook, so invoke it explicitly.
      const destination = '.deploy-pipeline-package';
      const command = `${checkOnly ? 'corepack enable && ' : ''}pnpm install --frozen-lockfile && cd ${quote(item.path)} && pnpm run --if-present prepublishOnly && pnpm pack --pack-destination ${quote(destination)}`;
      item.status = 'running';
      item.jobId = jobId;
      workspace.transaction(() => {
        save('job', owner, {
          id: jobId,
          pipelineId,
          projectId: project.id,
          taskId: run.taskId || null,
          runId: null,
          name: `package-${items.indexOf(item) + 1}`,
          needs: [],
          requirements: {
            os: 'linux',
            capabilities: ['node', 'package-publish-v1', ...(checkOnly ? ['docker'] : [])],
          },
          workerId: null,
          command,
          container: checkOnly ? 'node:26' : null,
          timeoutMs: 30 * 60_000,
          digest: run.commit,
          status: 'queued',
          output: '',
          createdAt: now(),
          updatedAt: now(),
          packagePublish: {
            path: item.path,
            name: item.name,
            version: item.version,
            checkOnly,
            destination,
          },
        });
        persist({ ...run.packages, items });
      })();
      return; // One package at a time, including its upload.
    }
    persist({ ...run.packages, status: 'succeeded', items, completedAt: now() });
  } catch (error: any) {
    const active = items.find((item: any) => ['waiting', 'running'].includes(item.status));
    if (active) {
      active.status = 'failed';
      active.reason = error.message;
    }
    persist({ ...run.packages, status: 'failed', items, error: error.message, completedAt: now() });
  }
}
export async function advanceAllPipelinePackages() {
  const rows = workspace
    .prepare(
      "SELECT owner,id FROM records WHERE kind='pipeline-run' AND json_extract(data,'$.status')='succeeded' AND json_array_length(data,'$.specification.publish')>0 AND COALESCE(json_extract(data,'$.packages.status'),'') NOT IN ('succeeded','failed')",
    )
    .all() as any[];
  for (const row of rows) await advancePipelinePackages(row.owner, row.id);
}
