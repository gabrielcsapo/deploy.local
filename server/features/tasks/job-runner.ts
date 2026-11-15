import { rewriteManagedGitUrl } from '../../workspace/git-url-migration.ts';
import { finishPackageJob } from '../../workspace/package-publish.ts';
import { readdir, readFile, rm } from 'node:fs/promises';
import { preparePackageInstall, secretOutput } from '../../../shared/package-install.mjs';
import { repositoryGit } from '../../workspace/repository-git.ts';
import { hydrateLfs } from '../../workspace/lfs-checkout.ts';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { restoreCheckpoint } from './checkpoint.ts';
import { fetchBaseTree } from './checkpoint-tree.ts';
import { shellEnvironment } from '../../workspace/shell-environment.ts';
import { collectJobArtifacts, type ArtifactUpload } from './job-artifact-collect.ts';
import { artifactRequests } from './job-artifact-spec.ts';

export type JobRunnerOptions = {
  /** Streams one finished-job artifact to the coordinator over the worker's own channel. */
  uploadArtifact?: (job: any, ...upload: Parameters<ArtifactUpload>) => ReturnType<ArtifactUpload>;
};
/** Artifact collection never holds a job slot for longer than this. */
const artifactDeadlineMs = 5 * 60000;

// One independent job slot per worker. The agent loop never waits for this slot.
/**
 * Removes one job's checkout. A job that ran in a container leaves files owned by root, which
 * the worker cannot delete itself; the image it ran in can. `<folder>.container` names it.
 */
export async function removeJobFolder(folder: string) {
  const marker = folder + '.container';
  await rm(folder, { recursive: true, force: true }).catch(() => {});
  if (existsSync(folder)) {
    const image = (await readFile(marker, 'utf8').catch(() => '')).trim();
    if (image)
      await new Promise<void>((done) =>
        execFile(
          'docker',
          [
            'run',
            '--rm',
            '--entrypoint',
            '/bin/sh',
            '--volume',
            `${folder}:/workspace`,
            image,
            '-c',
            'rm -rf /workspace/* /workspace/.[!.]* /workspace/..?*; true',
          ],
          { timeout: 300_000 },
          () => done(),
        ),
      );
    await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
  if (!existsSync(folder)) await rm(marker, { force: true }).catch(() => {});
}

export class JobRunner {
  private state: any;
  private child: ReturnType<typeof spawn> | null = null;
  private busy = false;
  private closing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  private statePath: string;
  private directory: string;
  private packageCleanup: Promise<void>;
  private preparation?: AbortController;
  private collecting?: AbortController;
  private authentication?: { origin: string; header: string };
  private options: JobRunnerOptions;
  private request: (action: string, body: any) => Promise<any>;
  constructor(
    directory: string,
    request: (action: string, body: any) => Promise<any>,
    authentication?: { origin: string; header: string },
    options: JobRunnerOptions = {},
  ) {
    this.authentication = authentication;
    this.options = options;
    this.directory = directory;
    this.request = request;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.packageCleanup = readdir(directory, { withFileTypes: true }).then(async (entries) => {
      // No job runs while the worker starts, so every folder here was left by an earlier one:
      // a checkout with its installed dependencies is over a gigabyte.
      for (const entry of entries)
        if (entry.isDirectory() && entry.name !== 'cargo-home')
          await removeJobFolder(resolve(directory, entry.name));
    });
    this.statePath = resolve(directory, 'job.json');
    this.state = existsSync(this.statePath)
      ? JSON.parse(readFileSync(this.statePath, 'utf8'))
      : null;
    if (this.state) {
      renameSync(this.statePath, this.statePath + '.previous');
      this.state = null;
      this.persist();
    }
  }
  private persist() {
    writeFileSync(this.statePath + '.tmp', JSON.stringify(this.state), { mode: 0o600 });
    renameSync(this.statePath + '.tmp', this.statePath);
  }
  shutdown() {
    this.closing = true;
    this.stop();
  }
  stop(reason = 'cancelled') {
    if (this.preparation) {
      this.state.reason ||= reason;
      this.preparation.abort();
    }
    this.collecting?.abort();
    if (!this.child || !this.state) return;
    this.state.reason = this.state.reason || reason;
    const pid = this.child.pid;
    try {
      process.kill(-pid!, 'SIGTERM');
    } catch {}
    if (!this.killTimer)
      this.killTimer = setTimeout(() => {
        try {
          process.kill(-pid!, 'SIGKILL');
        } catch {}
      }, 1000);
  }
  private async start(assignment: any) {
    const job = assignment.job;
    // Coordinators without artifact support never send artifactPaths; an invalid list is ignored.
    let requests: ReturnType<typeof artifactRequests> = [];
    try {
      requests = artifactRequests(job.artifactPaths);
    } catch {}
    let started = false;
    let install: Awaited<ReturnType<typeof preparePackageInstall>> | undefined;
    this.state = {
      jobId: job.id,
      generation: job.generation,
      instanceId: job.instanceId,
      output: '',
      truncated: false,
      terminal: null,
    };
    this.persist(); // Fence execution before creating files or starting any process.
    try {
      const cwd = resolve(this.directory, job.id + '-' + job.generation);
      this.timer = setTimeout(() => this.stop('timed_out'), job.timeoutMs);
      if (assignment.repository) {
        this.preparation = new AbortController();
        mkdirSync(cwd);
        if (job.container) writeFileSync(cwd + '.container', String(job.container));
        const source = {
          ...assignment.repository,
          location: rewriteManagedGitUrl(
            assignment.repository.location,
            this.authentication ? [this.authentication.origin] : ['https://deploy.local'],
            true,
          ),
        };
        const location =
          source.location.startsWith('/api/') && this.authentication
            ? this.authentication.origin + source.location
            : source.location;
        const options = {
          signal: this.preparation.signal,
          authentication: this.authentication,
          timeout: job.timeoutMs,
        };
        await repositoryGit(cwd, ['init', '--template='], options);
        await repositoryGit(
          cwd,
          ['fetch', '--depth=1', '--no-tags', '--', location, source.ref],
          options,
        );
        const fetched = (await repositoryGit(cwd, ['rev-parse', 'FETCH_HEAD'], options))
          .toString()
          .trim();
        if (fetched !== source.commit)
          throw new Error('Pipeline source did not match the assigned commit');
        await repositoryGit(cwd, ['checkout', '--detach', fetched], options);
        await hydrateLfs(cwd, location, options);
        this.preparation = undefined;
      } else
        // A checkpoint job still gets a fresh, isolated directory holding the whole tree: the
        // base commit comes from the coordinator's Git, then the checkpoint's delta is applied.
        await restoreCheckpoint(assignment.snapshot, cwd, async (commit, destination) => {
          const base = assignment.base && {
            ...assignment.base,
            location: rewriteManagedGitUrl(
              assignment.base.location,
              this.authentication ? [this.authentication.origin] : ['https://deploy.local'],
              true,
            ),
          };
          if (base?.commit !== commit)
            throw new Error('The coordinator did not send this checkpoint’s base commit');
          this.preparation = new AbortController();
          try {
            await fetchBaseTree(
              {
                ...base,
                location:
                  base.location.startsWith('/api/') && this.authentication
                    ? this.authentication.origin + base.location
                    : base.location,
              },
              destination,
              {
                signal: this.preparation.signal,
                authentication: this.authentication,
                timeout: job.timeoutMs,
              },
            );
          } finally {
            this.preparation = undefined;
          }
        });
      if (this.closing || this.state.reason) throw new Error('Job cancelled during preparation');
      // New worker asks on its authenticated channel. Older coordinators answer 404;
      // older workers never make this request and retain their public-registry behavior.
      const config = await this.request('packages', {
        jobId: job.id,
        generation: job.generation,
        instanceId: job.instanceId,
      }).catch(() => null);
      install = await preparePackageInstall(config, {
        cwd,
        root: this.directory,
        container: !!job.container,
        log: (line: string) => {
          this.state.output += line + '\n';
        },
      });
      if (this.closing || this.state.reason) throw new Error('Job cancelled during preparation');
      started = true;
      const executable = job.container ? 'docker' : '/bin/sh';
      const args = job.container
        ? [
            'run',
            '--rm',
            '--name',
            `deploy-job-${job.id}-${job.generation}`,
            '--init',
            '--volume',
            `${cwd}:/workspace`,
            '--workdir',
            '/workspace',
            ...install.args,
            job.container,
            '/bin/sh',
            // Keep the image's PATH (rust images put cargo in /usr/local/cargo/bin).
            '-c',
            job.command,
          ]
        : ['-lc', job.command];
      const child = (this.child = spawn(executable, args, {
        cwd,
        env: { ...shellEnvironment(), ...install.env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
      const append = (data: string) => {
        this.state.output += data.toString();
        if (this.state.output.length > 64000) this.state.truncated = true;
        this.state.output = this.state.output.slice(-64000);
      };
      const output = secretOutput(install.secrets, append);
      child.stdout!.on('data', output.write);
      child.stderr!.on('data', output.write);
      let spawnError: string | undefined;
      child.once('error', (error) => {
        spawnError = error.message;
      });
      child.once('close', async (code) => {
        output.end();
        if (job.container) {
          const error = await this.removeContainer(job, install!);
          if (error) this.state.terminal = { status: 'unknown', error };
        }
        await install?.cleanup();
        // Kill any remaining descendants of the shell before releasing the slot.
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
        clearTimeout(this.killTimer);
        this.killTimer = undefined;
        if (
          job.packagePublish &&
          code === 0 &&
          !spawnError &&
          !this.state.reason &&
          !this.state.terminal
        ) {
          this.preparation = new AbortController();
          try {
            await finishPackageJob(
              job,
              cwd,
              () =>
                this.request('package-publish', {
                  jobId: job.id,
                  generation: job.generation,
                  instanceId: job.instanceId,
                }),
              config?.ca,
              this.preparation.signal,
            );
          } catch (error: any) {
            this.state.terminal = { status: this.state.reason || 'failed', error: error.message };
          } finally {
            this.preparation = undefined;
          }
        }
        clearTimeout(this.timer);
        // Collect on every outcome, before completion, while the job generation is still live.
        if (requests.length) this.state.skippedArtifacts = await this.collect(job, cwd, requests);
        this.state.terminal ||= {
          status:
            this.state.reason || (spawnError ? 'failed' : code === 0 ? 'succeeded' : 'failed'),
          exitCode: code,
          ...(spawnError ? { error: spawnError } : {}),
        };
        this.child = null;
        this.persist();
      });
    } catch (error: any) {
      await install?.cleanup();
      clearTimeout(this.timer);
      this.preparation = undefined;
      if (requests.length)
        this.state.skippedArtifacts = requests.map((request) => ({
          path: request.path,
          caption: request.caption || '',
          skipped: started
            ? `Artifacts were not collected: ${error.message}`
            : 'The job did not run, so no artifacts were collected',
        }));
      this.state.terminal = { status: this.state.reason || 'failed', error: error.message };
      this.persist();
    }
  }
  /** Returns only skipped entries; uploaded ones are recorded by the coordinator as they land. */
  private async collect(job: any, cwd: string, requests: ReturnType<typeof artifactRequests>) {
    const upload = this.options.uploadArtifact;
    this.collecting = new AbortController();
    const signal = AbortSignal.any([
      this.collecting.signal,
      AbortSignal.timeout(artifactDeadlineMs),
    ]);
    try {
      const results = await collectJobArtifacts(
        cwd,
        requests,
        upload && ((file, body, abort) => upload(job, file, body, abort)),
        signal,
      );
      return results.filter((result) => result.skipped);
    } finally {
      this.collecting = undefined;
    }
  }
  private removeContainer(
    job: any,
    install: Awaited<ReturnType<typeof preparePackageInstall>>,
  ): Promise<string | null> {
    return new Promise((done) => {
      const cleanup = spawn('docker', ['rm', '-f', `deploy-job-${job.id}-${job.generation}`], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...shellEnvironment(), ...install.env },
      });
      let stderr = '',
        timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        cleanup.kill('SIGKILL');
      }, 10000);
      const output = secretOutput(install.secrets, (chunk) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      cleanup.stderr.on('data', output.write);
      cleanup.on('error', () => {});
      cleanup.on('close', (code) => {
        output.end();
        clearTimeout(timer);
        done(
          !timedOut && (code === 0 || /No such (container|object)/i.test(stderr))
            ? null
            : 'Container cleanup could not be confirmed; inspect the worker before retrying',
        );
      });
    });
  }
  async tick() {
    if (this.busy || this.closing) return;
    this.busy = true;
    try {
      await this.packageCleanup;
      if (this.state) {
        const completing = Boolean(this.state.terminal);
        const result = await this.request(completing ? 'complete' : 'update', {
          ...this.state,
          ...this.state.terminal,
        });
        if (result.stopRequested) this.stop();
        if (completing) {
          const finished = resolve(this.directory, this.state.jobId + '-' + this.state.generation);
          this.state = null;
          this.persist();
          // The coordinator has the result, its output and its artifacts. Keeping the checkout
          // filled a disk with one copy of the repository and its dependencies per job.
          await removeJobFolder(finished);
        } else this.persist();
        return;
      }
      const assignment = await this.request('poll', {});
      if (assignment.job && !this.closing) void this.start(assignment);
    } finally {
      this.busy = false;
    }
  }
}
