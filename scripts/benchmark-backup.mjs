// Temporary data only. Run: node scripts/benchmark-backup.mjs [file-count=235000]
import { mkdtemp, mkdir, writeFile, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  copyBytesNeeded,
  createCopyDirectory,
  listBackupCopies,
  markCopyComplete,
  assertDestinationHardLinks,
  pruneBackupCopies,
} from '../server/rsync-backup.ts';

const files = Number(process.argv[2] ?? 235000);
if (!Number.isSafeInteger(files) || files < 1) throw new Error('Expected a positive file count');
const root = await mkdtemp(join(tmpdir(), 'deploy-backup-benchmark-'));
const destination = join(root, 'drive');
const previous = join(root, 'previous');
await mkdir(destination);
await mkdir(previous);
const source = await createCopyDirectory(destination, new Date('2020-01-01'));

async function measure(name, operation) {
  const start = performance.now();
  let last = start;
  let worstGap = 0;
  let ticks = 0;
  const sample = () => {
    const now = performance.now();
    worstGap = Math.max(worstGap, now - last);
    last = now;
    ticks++;
  };
  const timer = setInterval(sample, 1);
  try {
    const result = await operation();
    sample();
    console.log(
      JSON.stringify({
        name,
        files,
        durationMs: +(performance.now() - start).toFixed(3),
        worstTimerDelayMs: +Math.max(0, worstGap - 1).toFixed(3),
        maxTimerGapMs: +worstGap.toFixed(3),
        ticks,
        ...(typeof result === 'number' ? { bytes: result } : {}),
      }),
    );
  } finally {
    clearInterval(timer);
  }
}

try {
  // One wide directory exercises enumeration and deletion without small-directory batching hiding stalls.
  await measure('seed-1-byte-files-and-reference-hardlinks', async () => {
    let next = 0;
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        while (next < files) {
          const name = String(next++);
          const path = join(source, name);
          await writeFile(path, 'x');
          await link(path, join(previous, name));
        }
      }),
    );
  });
  await measure('first-copy-budget', () => copyBytesNeeded(source));
  await measure('unchanged-copy-budget', () => copyBytesNeeded(source, previous));
  await measure('publish-marker', () => markCopyComplete(root, source));
  await measure('hard-link-probe', () => assertDestinationHardLinks(destination));
  // The same 235,000-file copy will be expired by retention.
  for (let day = 1; day <= 40; day++) {
    const copy = await createCopyDirectory(destination, new Date(Date.UTC(2020, 0, day + 1)));
    await markCopyComplete(root, copy);
  }
  await measure('list-copies', () => listBackupCopies(destination));
  await measure('prune-same-tree', () => pruneBackupCopies(destination, new Date('2020-02-10')));
} finally {
  await rm(root, { recursive: true, force: true });
}
