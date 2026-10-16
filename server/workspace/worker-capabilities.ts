import { spawn } from 'node:child_process';
import { platform } from 'node:os';
let inventory = [
  'git',
  'shell',
  'node',
  ...(['darwin', 'linux'].includes(platform()) ? ['checkpoint-jobs'] : []),
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
