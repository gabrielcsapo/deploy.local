export interface TaskDiffLine {
  text: string;
  kind: 'context' | 'added' | 'removed' | 'hunk' | 'metadata';
  oldLine?: number;
  newLine?: number;
}

export interface TaskFileDiff {
  path: string;
  lines: TaskDiffLine[];
}

function gitPath(value: string): string {
  let path = value;
  if (path.startsWith('"')) {
    try {
      const octal = /\\[0-7]{3}/.test(path);
      path = JSON.parse(
        path.replace(
          /\\([0-7]{3})/g,
          (_, digits) => `\\u00${parseInt(digits, 8).toString(16).padStart(2, '0')}`,
        ),
      );
      if (octal)
        path = new TextDecoder().decode(Uint8Array.from(path, (char) => char.charCodeAt(0)));
    } catch {
      /* Keep unusual Git paths readable. */
    }
  }
  return path;
}

/** Porcelain status quotes paths and represents renames as old -> new. */
export function taskDiffIndex(files: TaskFileDiff[], path: string, status = ''): number {
  const current = status.includes('R') ? path.split(' -> ').at(-1)! : path;
  return files.findIndex((file) => file.path === gitPath(current));
}

/** Keep review navigation tied to real patch headers, including deleted/renamed files. */
export function parseTaskDiff(patch: string): TaskFileDiff[] {
  return patch
    .split(/(?=^diff --git )/m)
    .filter((part) => part.trim())
    .map((part) => {
      const source = part.split('\n');
      if (source.at(-1) === '') source.pop();
      const firstHunk = source.findIndex((line) => line.startsWith('@@'));
      const fileHeaders = source.slice(0, firstHunk < 0 ? undefined : firstHunk);
      const next = fileHeaders.find((line) => line.startsWith('+++ '))?.slice(4);
      const previous = fileHeaders.find((line) => line.startsWith('--- '))?.slice(4);
      const header = source[0]?.match(/^diff --git (?:"a\/.*?"|a\/.*?) ("b\/.*"|b\/.*)$/)?.[1];
      const path = gitPath(
        next && next !== '/dev/null' ? next : (previous ?? header ?? 'Patch'),
      ).replace(/^[ab]\//, '');
      let oldLine = 0,
        newLine = 0,
        inHunk = false;
      const lines: TaskDiffLine[] = source.flatMap((text): TaskDiffLine[] => {
        if (!inHunk && /^(diff --git |index |--- |\+\+\+ )/.test(text)) return [];
        const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
          oldLine = Number(hunk[1]);
          newLine = Number(hunk[2]);
          inHunk = true;
          return [{ text, kind: 'hunk' }];
        }
        if (inHunk && text.startsWith('+')) return [{ text, kind: 'added', newLine: newLine++ }];
        if (inHunk && text.startsWith('-')) return [{ text, kind: 'removed', oldLine: oldLine++ }];
        if (inHunk && text.startsWith(' '))
          return [{ text, kind: 'context', oldLine: oldLine++, newLine: newLine++ }];
        return [{ text, kind: 'metadata' }];
      });
      return { path, lines };
    });
}
