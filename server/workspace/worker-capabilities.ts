import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
let inventory = [
  'git',
  'shell',
  'node',
  // job-artifacts: finished checkpoint jobs can stream requested files back to the coordinator.
  ...(['darwin', 'linux'].includes(platform())
    ? ['checkpoint-jobs', 'package-publish-v1', 'job-artifacts', 'terminal', 'task-terminal']
    : []),
];
let refreshing = false;
function probe(command: string, args: string[]) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}
/** Only executable names, never shell fragments or argument strings. */
export function toolNames(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some(
      (name) => typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,40}$/.test(name),
    )
  )
    throw new Error('Needs must be bare tool names, such as xcodebuild or docker');
  return [...new Set(value)];
}
/**
 * macOS keeps placeholders in /usr/bin for developer programs that are not installed: the file is
 * there, and running it only offers to install the real thing. xcrun knows whether one exists.
 */
function realOnMac(name: string, path: string) {
  if (platform() !== 'darwin' || !path.startsWith('/usr/bin/')) return true;
  // xcrun cannot find itself. It is real once it has developer tools to run.
  if (name === 'xcrun') return probe('/usr/bin/xcode-select', ['-p']);
  return probe('/usr/bin/xcrun', ['--find', name]);
}
export function probeTool(name: string): Promise<boolean> {
  toolNames([name]);
  // Availability is a PATH lookup; programs need not support a particular version flag.
  const extensions =
    process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [];
  return (async () => {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      for (const extension of ['', ...extensions]) {
        const path = resolve(directory, name + extension);
        try {
          await access(path, constants.X_OK);
          if ((await stat(path)).isFile()) return await realOnMac(name, path);
        } catch {}
      }
    }
    return false;
  })();
}
export function workerCapabilities() {
  return inventory;
}
export async function refreshCapabilities() {
  if (refreshing) return;
  refreshing = true;
  try {
    const tools = [
      ['docker', ['info', '--format', '{{.OSType}}']],
      ['swift', ['--version']],
      ['xcode', ['-version']],
      ['python', ['--version']],
      ['git-lfs', ['version']],
    ] as const;
    const found = await Promise.all(
      tools.map(async ([name, args]) => {
        const executable = name === 'xcode' ? 'xcodebuild' : name === 'python' ? 'python3' : name;
        return (await probe(executable, [...args])) ? name : null;
      }),
    );
    inventory = [
      ...new Set([
        ...inventory.filter((c) => !['docker', 'swift', 'xcode', 'python', 'git-lfs'].includes(c)),
        ...found.filter((name): name is NonNullable<typeof name> => name !== null),
      ]),
    ];
  } finally {
    refreshing = false;
  }
}
