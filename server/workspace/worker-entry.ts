import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

/** A SEA launches itself as a command; source and server bundles launch adjacent scripts. */
export function workerEntry(name: string, sea = isSea(), url = import.meta.url) {
  return sea
    ? ['worker', name]
    : [
        fileURLToPath(
          new URL(url.endsWith('.ts') ? `./${name}.ts` : `./workspace-${name}.js`, url),
        ),
      ];
}
