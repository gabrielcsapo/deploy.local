import { existsSync } from 'node:fs';

/**
 * Workers are copied beside the server in dist/, but the bundler may place the code asking for
 * one in dist/assets/. Look beside the caller, then one folder up, then fall back to the source.
 */
export function packageWorkerFile(base: string, bundled: string, source: string) {
  for (const candidate of [new URL('./' + bundled, base), new URL('../' + bundled, base)])
    if (existsSync(candidate)) return candidate;
  return new URL(source, base);
}
