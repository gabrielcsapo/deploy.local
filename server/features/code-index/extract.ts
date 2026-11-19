import { basename } from 'node:path/posix';
import { extractLock, cargoManifest, npmManifest } from './manifests.ts';
import { extractRust } from './rust.ts';
import { extractTypeScript } from './typescript.ts';
import { lineCount, oneLine, type ExtractedFile } from './model.ts';
import type { TreeFile } from './git-source.ts';

const decoder = new TextDecoder('utf-8', { fatal: true });
function readText(blob: Buffer) {
  if (blob.includes(0)) return undefined;
  try {
    return decoder.decode(blob);
  } catch {
    return undefined;
  }
}

export function extractFiles(files: TreeFile[], blobs: Buffer[]): ExtractedFile[] {
  const scripts: { path: string; text: string; index: number }[] = [];
  let blobIndex = 0;
  const results = files.map(({ path, policy, kind }, index): ExtractedFile => {
    if (policy) return { kind, coverage: 'skipped', lines: 0, reason: policy };
    const text = readText(blobs[blobIndex++]);
    if (text === undefined)
      return {
        kind: 'Binary',
        coverage: 'skipped',
        lines: 0,
        reason: 'Binary or non-UTF-8 content',
      };
    const base = { kind, lines: lineCount(text), text };
    if (kind === 'TypeScript' || kind === 'JavaScript') {
      scripts.push({ path, text, index });
      return { ...base, coverage: 'symbols' };
    }
    if (kind === 'Rust') return extractRust(text);
    if (kind === 'Package manifest' || kind === 'Lockfile') {
      try {
        if (kind === 'Lockfile')
          return { ...base, coverage: 'packages', lock: extractLock(basename(path), text) };
        return {
          ...base,
          coverage: 'packages',
          manifest: basename(path) === 'package.json' ? npmManifest(text) : cargoManifest(text),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const line = message.match(/\bline (\d+)/i)?.[1];
        return {
          ...base,
          coverage: 'skipped',
          reason: 'Invalid manifest or lockfile syntax',
          errorLine: line ? Number(line) : 1,
        };
      }
    }
    const title = /^readme(?:\.|$)/i.test(basename(path))
      ? text.match(/^#\s+(.+?)\s*#*$/m)?.[1]
      : undefined;
    return { ...base, coverage: 'text', title: title ? oneLine(title) : undefined };
  });
  for (const [index, result] of extractTypeScript(scripts).entries())
    results[scripts[index].index] = result;
  return results;
}
