import { exec, spawn, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';

export const execAsync = promisify(exec);

/** Exit status is data for probes and launchers, including a missing executable. */
export function processResult(
  command: string,
  args: string[],
  options: SpawnOptions & { maxBuffer?: number } = {},
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }>(
    (resolve) => {
      const child = spawn(command, args, options);
      child.stdin?.on('error', () => {});
      child.stdin?.end();
      let length = 0;
      let stdout = '',
        stderr = '',
        error: Error | undefined;
      const count = (chunk: string) => {
        length += Buffer.byteLength(chunk);
        if (length > (options.maxBuffer ?? 1024 * 1024) && !error) {
          error = Object.assign(new Error(`spawnSync ${command} ENOBUFS`), { code: 'ENOBUFS' });
          child.kill(options.killSignal ?? 'SIGTERM');
        }
      };
      child.stdout?.setEncoding('utf8').on('data', (chunk) => {
        if (error) return;
        stdout += chunk;
        count(chunk);
      });
      child.stderr?.setEncoding('utf8').on('data', (chunk) => {
        if (error) return;
        stderr += chunk;
        count(chunk);
      });
      child.on('error', (value) => {
        error = value;
      });
      child.on('close', (status) =>
        resolve({ status: error ? null : status, stdout, stderr, error }),
      );
    },
  );
}
