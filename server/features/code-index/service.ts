import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { deployDataPath } from '../../kernel/files/data-directory.ts';
import { packageWorkerFile } from '../../kernel/files/worker-file.ts';
import { db, root, save } from '../../workspace/store.ts';

type ProjectRow = { owner: string; id: string; rowid: number };
type Job = ProjectRow & { data?: string };
const database = join(root, 'code-index.db');
const workspace = join(root, 'workspace.db');
const sweepDelay = 5 * 60_000;
const requestKind = 'code-index-request';

function worker<Result>(
  work:
    | { kind: 'index'; owner: string; project: string }
    | { kind: 'query'; owner: string; name: string; args: Record<string, unknown> },
  timeout: number,
) {
  return new Promise<Result>((resolve, reject) => {
    const thread = new Worker(
      packageWorkerFile(import.meta.url, 'code-index-worker.js', './worker.ts'),
      {
        workerData: { ...work, database, workspace, registry: deployDataPath('deploy.db') },
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 768 },
      },
    );
    const stop = setTimeout(() => {
      void thread.terminate();
      reject(new Error('Code index worker timed out'));
    }, timeout);
    stop.unref();
    thread.once('message', ({ result, error }) => {
      clearTimeout(stop);
      if (error) reject(new Error(error));
      else resolve(result);
    });
    thread.once('error', (error) => {
      clearTimeout(stop);
      reject(error);
    });
    thread.once('exit', () => {
      clearTimeout(stop);
      reject(new Error('Code index worker exited without a result'));
    });
    if (work.kind === 'index') thread.unref();
  });
}

export function queueCodeIndex(owner: string, project: string) {
  save(requestKind, owner, { id: project, requestedAt: Date.now(), requestId: randomUUID() });
}

let sweep: number | null = 0;
let lastSweep = 0;
let sweepSteps = 0;
let timer: NodeJS.Timeout | undefined;
let running = false;
let busy = false;

function tickLater(delay: number) {
  if (timer || !running) return;
  timer = setTimeout(() => {
    timer = undefined;
    void tick();
  }, delay);
  timer.unref();
}

function nextJob(): Job | undefined {
  const queued = db
    .prepare('SELECT owner,id,rowid,data FROM records WHERE kind=? ORDER BY rowid LIMIT 1')
    .get(requestKind) as Job | undefined;
  if (sweep === null && Date.now() - lastSweep >= sweepDelay) sweep = 0;
  if (queued && (sweep === null || sweepSteps < 4)) {
    sweepSteps++;
    return queued;
  }
  if (sweep !== null) {
    const row = db
      .prepare(
        "SELECT owner,id,rowid FROM records WHERE kind='project' AND rowid>? ORDER BY rowid LIMIT 1",
      )
      .get(sweep) as ProjectRow | undefined;
    if (row) {
      sweep = row.rowid;
      sweepSteps = 0;
      return row;
    }
    sweep = null;
    lastSweep = Date.now();
  }
  return queued;
}

async function tick() {
  if (busy || !running) return;
  busy = true;
  let delay = 2000;
  try {
    const job = nextJob();
    if (!job) return;
    const { owner, id, data } = job;
    delay = 50;
    try {
      const result = await worker<{ state: string }>(
        { kind: 'index', owner, project: id },
        4 * 60_000,
      );
      if (
        result.state === 'superseded' &&
        !db
          .prepare('SELECT 1 FROM records WHERE kind=? AND owner=? AND id=?')
          .get(requestKind, owner, id)
      )
        queueCodeIndex(owner, id);
      if (result.state === 'superseded') return;
    } catch (error) {
      // Durable staged rows survive. The next push or periodic sweep retries.
      console.error('[code index]', error);
    }
    if (data)
      db.prepare('DELETE FROM records WHERE kind=? AND owner=? AND id=? AND data=?').run(
        requestKind,
        owner,
        id,
        data,
      );
  } catch (error) {
    console.error('[code index queue]', error);
    delay = 2000;
  } finally {
    busy = false;
    tickLater(delay);
  }
}

export function startCodeIndex() {
  running = true;
  tickLater(50);
}

let activeQueries = 0;
const waiting: (() => void)[] = [];

export async function callCodeIndex(owner: string, name: string, args: Record<string, unknown>) {
  if (waiting.length >= 16) throw new Error('Code index is busy. Retry shortly.');
  if (activeQueries < 2) activeQueries++;
  else await new Promise<void>((resume) => waiting.push(resume));
  try {
    const output = await worker<{ result: unknown; pending: string[] }>(
      { kind: 'query', owner, name, args },
      20_000,
    );
    const enqueue = db.prepare('INSERT OR IGNORE INTO records VALUES(?,?,?,?)');
    for (const project of output.pending)
      enqueue.run(
        requestKind,
        project,
        owner,
        JSON.stringify({ id: project, requestedAt: Date.now(), requestId: randomUUID() }),
      );
    if (output.pending.length) startCodeIndex();
    return output.result;
  } finally {
    const resume = waiting.shift();
    if (resume) resume();
    else activeQueries--;
  }
}
