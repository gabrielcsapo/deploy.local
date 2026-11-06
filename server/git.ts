import {
  execFile,
  spawn,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';

export const gitEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  // Do not let a launching shell redirect Git into a different repository/config.
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_') && key !== 'GIT_SSL_CAINFO') delete env[key];
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
  };
};
export function repositoryGit(
  cwd: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    indexFile?: string;
    identity?: string;
    committer?: string;
    input?: string | Buffer;
    authentication?: { origin: string; header: string };
    limit?: number;
    timeout?: number;
    /** Exit statuses to resolve with the command's output instead of rejecting, for commands
     * whose nonzero status is a result rather than a failure (`merge-tree` reporting conflicts). */
    allowStatus?: number[];
    onProcess?: (pid: number | null) => void;
  } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-C', cwd, ...args],
      {
        env: {
          ...gitEnvironment(),
          ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
          ...(options.identity
            ? {
                GIT_AUTHOR_NAME: options.identity,
                GIT_AUTHOR_EMAIL: `${options.identity}@deploy.local`,
                GIT_COMMITTER_NAME: options.identity,
                GIT_COMMITTER_EMAIL: `${options.identity}@deploy.local`,
              }
            : {}),
          ...(options.committer
            ? {
                GIT_COMMITTER_NAME: options.committer,
                GIT_COMMITTER_EMAIL: `${options.committer}@deploy.local`,
              }
            : {}),
          ...(options.authentication
            ? {
                GIT_CONFIG_COUNT: '2',
                GIT_CONFIG_KEY_0: `http.${options.authentication.origin}/.extraHeader`,
                GIT_CONFIG_VALUE_0: options.authentication.header,
                GIT_CONFIG_KEY_1: 'http.followRedirects',
                GIT_CONFIG_VALUE_1: 'false',
              }
            : {}),
        },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stdin.on('error', () => {}); // Exit status/stderr report a rejected Git transaction.
    child.stdin.end(options.input);
    const output: Buffer[] = [];
    let length = 0,
      stderr = '',
      failure: Error | undefined;
    const stop = (error: Error) => {
      failure ||= error;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const abort = () => stop(new Error('Repository operation cancelled'));
    const timer = setTimeout(
      () => stop(new Error('Git operation timed out')),
      options.timeout ?? 30000,
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > (options.limit ?? 1024 * 1024))
        stop(
          Object.assign(new Error('Repository response exceeds the size limit'), { status: 413 }),
        );
      else output.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.once('error', (error) => {
      failure ||= error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        options.onProcess?.(null);
      } catch (error: any) {
        failure ||= error;
      }
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 && options.allowStatus?.includes(code!)) resolve(Buffer.concat(output));
      else if (code !== 0)
        reject(
          new Error(
            `Git command failed (${code}): ${stderr.replace(/https?:\/\/[^\s/@]+@/g, 'https://[redacted]@').trim()}`,
          ),
        );
      else resolve(Buffer.concat(output));
    });
    try {
      if (child.pid) options.onProcess?.(child.pid);
    } catch (error: any) {
      stop(error);
    }
  });
}
/** A single small repository read or ref write, for callers that cannot await: returns the
 * trimmed output, or null when Git failed. Never use it for pack transfers or user input. */
export function gitSync(cwd: string, args: string[]): string | null {
  const result = gitResultSync(cwd, args, { ...repositoryReadOptions, env: gitEnvironment() });
  return result.status === 0 ? String(result.stdout).trimEnd() : null;
}
export const gitText = async (
  cwd: string,
  args: string[],
  options?: Parameters<typeof repositoryGit>[2],
) => (await repositoryGit(cwd, args, options)).toString().trimEnd();

// Legacy callers intentionally retain their own environment, flags and failure contract.
export type GitOptions = Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> & {
  prefix?: string[];
  literalPathspecs?: boolean;
  trim?: 'end' | 'both' | 'none';
  fallback?: string;
};
const repositoryReadOptions: GitOptions = {
  prefix: ['-c', 'core.hooksPath=/dev/null'],
  maxBuffer: 4 * 1024 * 1024,
  timeout: 30000,
};
function gitArguments(cwd: string, args: string[], options: GitOptions) {
  return [
    ...(options.prefix ?? []),
    '-C',
    cwd,
    ...(options.literalPathspecs ? ['--literal-pathspecs'] : []),
    ...args,
  ];
}
export function gitResultSync(cwd: string, args: string[], options: GitOptions = {}) {
  return spawnSync('git', gitArguments(cwd, args, options), { ...options, encoding: 'utf8' });
}
export function gitStringSync(cwd: string, args: string[], options: GitOptions = {}) {
  const result = gitResultSync(cwd, args, options);
  if (result.status !== 0) throw new Error(result.stderr || options.fallback || 'Git failed');
  return options.trim === 'none'
    ? result.stdout
    : options.trim === 'both'
      ? result.stdout.trim()
      : result.stdout.trimEnd();
}
/** Same small-read contract as gitSync, for callers that can yield. */
export async function gitRead(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      gitArguments(cwd, args, repositoryReadOptions),
      {
        env: gitEnvironment(),
        encoding: 'utf8',
        maxBuffer: repositoryReadOptions.maxBuffer,
        timeout: repositoryReadOptions.timeout,
      },
      (error, stdout) => resolve(error ? null : stdout.trimEnd()),
    );
  });
}
export default repositoryGit;

/** Nullable repository read used by design summaries; keeps repositoryGit's hardening. */
export async function tryGitText(
  cwd: string,
  args: string[],
  options: Parameters<typeof repositoryGit>[2] = { limit: 4 * 1024 * 1024 },
) {
  try {
    return await gitText(cwd, args, options);
  } catch {
    return null;
  }
}
