import { repositoryGit } from './repository-git.ts';
import { hydrateLfs } from './lfs-checkout.ts';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { restoreSnapshot } from './checkpoint.ts';
import { shellEnvironment } from './shell-environment.ts';

// One independent job slot per worker. The agent loop never waits for this slot.
export class JobRunner {
  private state: any;
  private child: ReturnType<typeof spawn> | null = null;
  private busy = false;
  private closing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  private statePath: string;
  private directory: string;
  private preparation?: AbortController;
  private authentication?: { origin: string; header: string };
  private request: (action: string, body: any) => Promise<any>;
  constructor(
    directory: string,
    request: (action: string, body: any) => Promise<any>,
    authentication?: { origin: string; header: string },
  ) {
    this.authentication = authentication;
    this.directory = directory;
    this.request = request;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
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
        const source = assignment.repository;
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
      } else restoreSnapshot(assignment.snapshot, cwd);
      if (this.closing || this.state.reason) throw new Error('Job cancelled during preparation');
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
            job.container,
            '/bin/sh',
            '-lc',
            job.command,
          ]
        : ['-lc', job.command];
      const child = (this.child = spawn(executable, args, {
        cwd,
        env: shellEnvironment(),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
      const append = (data: Buffer) => {
        this.state.output += data.toString();
        if (this.state.output.length > 64000) this.state.truncated = true;
        this.state.output = this.state.output.slice(-64000);
      };
      child.stdout!.on('data', append);
      child.stderr!.on('data', append);
      let spawnError: string | undefined;
      child.once('error', (error) => {
        spawnError = error.message;
      });
      child.once('close', async (code) => {
        if (job.container) {
          const error = await this.removeContainer(job);
          if (error) this.state.terminal = { status: 'unknown', error };
        }
        clearTimeout(this.timer);
        // Kill any remaining descendants of the shell before releasing the slot.
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
        clearTimeout(this.killTimer);
        this.killTimer = undefined;
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
      clearTimeout(this.timer);
      this.preparation = undefined;
      this.state.terminal = { status: this.state.reason || 'failed', error: error.message };
      this.persist();
    }
  }
  private removeContainer(job: any): Promise<string | null> {
    return new Promise((done) => {
      const cleanup = spawn('docker', ['rm', '-f', `deploy-job-${job.id}-${job.generation}`], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: shellEnvironment(),
      });
      let stderr = '',
        timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        cleanup.kill('SIGKILL');
      }, 10000);
      cleanup.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      cleanup.on('error', () => {});
      cleanup.on('close', (code) => {
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
      if (this.state) {
        const completing = Boolean(this.state.terminal);
        const result = await this.request(completing ? 'complete' : 'update', {
          ...this.state,
          ...this.state.terminal,
        });
        if (result.stopRequested) this.stop();
        if (completing) {
          this.state = null;
          this.persist();
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
