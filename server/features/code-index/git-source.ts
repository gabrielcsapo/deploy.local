import { basename, extname } from 'node:path/posix';
import { gitText, repositoryGit } from '../../kernel/git.ts';
import { fileLimit, projectByteLimit, projectFileLimit, type IndexProject } from './model.ts';

export type TreeFile = { path: string; oid: string; bytes: number; policy: string; kind: string };
const inventoryLimit = projectFileLimit * 2;
const image = /\.(?:svg|png|jpe?g|gif|webp|avif|ico|tiff?|bmp|heic|jxl)$/i;

export const defaultTip = (project: IndexProject) =>
  gitText(
    project.repositoryPath,
    ['rev-parse', '--verify', '--end-of-options', `refs/heads/${project.defaultBranch}^{commit}`],
    { allowStatus: [128, 1], limit: 1024, timeout: 5000 },
  );

export function fileKind(path: string) {
  if (/\.[cm]?tsx?$/i.test(path)) return 'TypeScript';
  if (/\.[cm]?jsx?$/i.test(path)) return 'JavaScript';
  if (/\.rs$/i.test(path)) return 'Rust';
  if (['Cargo.toml', 'package.json'].includes(basename(path))) return 'Package manifest';
  if (
    /^(?:Cargo\.lock|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lock)$/.test(
      basename(path),
    )
  )
    return 'Lockfile';
  if (/\.(?:md|mdx|markdown)$/i.test(path)) return 'Markdown';
  if (/\.(?:sh|zsh|bash|fish)$/i.test(path)) return 'Shell';
  if (image.test(path)) return 'Image';
  const ext = extname(path);
  return /^\.[a-z0-9]{1,16}$/i.test(ext) ? ext.slice(1).toUpperCase() : 'Other';
}

export async function readTree(repo: string, commit: string) {
  const rows = (
    await repositoryGit(repo, ['ls-tree', '-r', '-l', '-z', commit], {
      limit: 64 * 1024 * 1024,
      timeout: 60_000,
    })
  )
    .toString()
    .split('\0')
    .filter(Boolean);
  const files: TreeFile[] = [];
  let bytesRead = 0;
  let filesRead = 0;
  for (const row of rows.slice(0, inventoryLimit)) {
    const tab = row.indexOf('\t');
    const [mode, type, oid, size] = row.slice(0, tab).split(/\s+/);
    const path = row.slice(tab + 1);
    const bytes = Number(size) || 0;
    const kind = fileKind(path);
    let policy = '';
    if (type !== 'blob') policy = 'Git submodule';
    else if (mode === '120000') policy = 'Symbolic link';
    else if (bytes > fileLimit) policy = 'Over the 1 MB per-file limit';
    else if (kind === 'Image') policy = 'Image';
    else if (filesRead >= projectFileLimit || bytesRead + bytes > projectByteLimit)
      policy = 'Project indexing limit';
    else {
      bytesRead += bytes;
      filesRead++;
    }
    files.push({ path, oid, bytes, policy, kind });
  }
  return { files, omittedFiles: Math.max(0, rows.length - inventoryLimit) };
}

export async function changedPaths(repo: string, previous: string, commit: string) {
  const args = ['diff', '--name-status', '-z', '--no-renames', previous, commit, '--'];
  const result = (await repositoryGit(repo, args, { limit: 64 * 1024 * 1024, timeout: 60_000 }))
    .toString()
    .split('\0');
  const changed = new Set<string>();
  for (let i = 1; i < result.length; i += 2) changed.add(result[i]);
  return changed;
}

export async function readBlobs(repo: string, files: TreeFile[]) {
  if (!files.length) return [];
  const result = await repositoryGit(repo, ['cat-file', '--batch'], {
    input: files.map(({ oid }) => oid + '\n').join(''),
    limit: files.reduce((sum, file) => sum + file.bytes + 160, 0),
    timeout: 30_000,
  });
  let cursor = 0;
  return files.map(({ oid, bytes }) => {
    const end = result.indexOf(10, cursor);
    if (end < 0 || result.subarray(cursor, end).toString() !== `${oid} blob ${bytes}`)
      throw new Error('Git returned an incomplete source blob batch');
    cursor = end + 1 + bytes + 1;
    return result.subarray(end + 1, cursor - 1);
  });
}
