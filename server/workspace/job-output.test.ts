import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { openDatabase } from '../sqlite.ts';
import { inlineJobOutput, migrateJobOutput } from './job-output.ts';

const root = mkdtempSync(join(tmpdir(), 'job-output-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, save, get, list, remove, jobOutput } = await import('./store.ts');
test.after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const raw = (owner: string, id: string) =>
  JSON.parse(
    (
      db
        .prepare("SELECT data FROM records WHERE kind='job' AND owner=? AND id=?")
        .get(owner, id) as { data: string }
    ).data,
  );
const inline = (owner: string, id: string, output: string) =>
  db
    .prepare(
      "UPDATE records SET data=json_set(data,'$.output',?) WHERE kind='job' AND owner=? AND id=?",
    )
    .run(output, owner, id);

test('listed metadata saves preserve output; explicit empty output clears it, with owner isolation', () => {
  const row = { id: 'job', status: 'running', output: 'progress' };
  assert.equal(save('job', 'crud', row), row);
  save('job', 'other', { ...row, output: 'other owner' });
  assert.deepEqual(raw('crud', 'job'), { id: 'job', status: 'running' });
  assert.deepEqual(list('job', 'crud'), [{ id: 'job', status: 'running' }]);
  save('job', 'crud', { ...list('job', 'crud')[0], status: 'succeeded' });
  assert.equal(get('job', 'crud', 'job').output, 'progress');
  assert.equal(jobOutput('crud', 'job'), 'progress');
  save('job', 'crud', { ...list('job', 'crud')[0], output: '' });
  assert.equal(get('job', 'crud', 'job').output, '');
  assert.equal(get('job', 'other', 'job').output, 'other owner');
  remove('job', 'crud', 'job');
  assert.equal(db.prepare('SELECT 1 FROM job_output WHERE owner=?').get('crud'), undefined);
  assert.throws(() => get('job', 'crud', 'job'), /Not found/);
  assert.equal(jobOutput('other', 'job'), 'other owner');
});

test('bulk SQL deletion removes output and rolled back saves/deletes leave both tables intact', () => {
  save('job', 'atomic', { id: 'job', output: 'original' });
  assert.throws(
    () =>
      db
        .transaction(() => {
          save('job', 'atomic', { id: 'job', output: 'replacement', status: 'failed' });
          remove('job', 'atomic', 'job');
          throw new Error('abort');
        })
        .immediate(),
    /abort/,
  );
  assert.deepEqual(get('job', 'atomic', 'job'), { id: 'job', output: 'original' });
  // Fail the metadata write after the output write, outside an outer transaction.
  db.exec(`CREATE TEMP TRIGGER reject_job BEFORE UPDATE ON records
    WHEN NEW.owner='atomic' BEGIN SELECT RAISE(ABORT,'reject metadata'); END`);
  try {
    assert.throws(() => save('job', 'atomic', { id: 'job', output: 'lost' }), /reject metadata/);
    assert.equal(jobOutput('atomic', 'job'), 'original');
  } finally {
    db.exec('DROP TRIGGER reject_job');
  }
  db.prepare('DELETE FROM records WHERE owner=?').run('atomic');
  assert.equal(db.prepare('SELECT 1 FROM job_output WHERE owner=?').get('atomic'), undefined);
});

test('old code output wins after migration, including empty output, on reads and metadata-only saves', () => {
  save('job', 'legacy', { id: 'job', output: 'old external' });
  const metadata = list('job', 'legacy')[0];
  inline('legacy', 'job', 'new inline');
  assert.equal(get('job', 'legacy', 'job').output, 'new inline');
  assert.equal(jobOutput('legacy', 'job'), 'new inline');
  assert.equal(Object.hasOwn(list('job', 'legacy')[0], 'output'), false);
  save('job', 'legacy', { ...metadata, status: 'succeeded' });
  assert.equal(jobOutput('legacy', 'job'), 'new inline');
  assert.equal(Object.hasOwn(raw('legacy', 'job'), 'output'), false);
  inline('legacy', 'job', '');
  assert.equal(jobOutput('legacy', 'job'), '');
  migrateJobOutput(db);
  assert.equal(Object.hasOwn(raw('legacy', 'job'), 'output'), false);
  assert.equal(jobOutput('legacy', 'job'), '');
  inline('legacy', 'job', 'later inline');
  migrateJobOutput(db);
  migrateJobOutput(db);
  assert.equal(jobOutput('legacy', 'job'), 'later inline');
});

function legacyDatabase(name: string, count = 640) {
  const data = join(root, name);
  mkdirSync(join(data, 'workspace'), { recursive: true });
  const file = join(data, 'workspace/workspace.db');
  const legacy = openDatabase(file, { wal: true, busyTimeoutMs: 5000 });
  legacy.exec(
    'CREATE TABLE records(kind TEXT,id TEXT,owner TEXT,data TEXT,PRIMARY KEY(kind,id,owner))',
  );
  const insert = legacy.prepare("INSERT INTO records VALUES('job',?,'owner',?)");
  legacy.transaction(() => {
    for (let i = 0; i < count; i++)
      insert.run(
        String(i),
        JSON.stringify({
          id: String(i),
          status: 'succeeded',
          output: 'x'.repeat(22_000) + i,
        }),
      );
  })();
  legacy.close();
  return { data, file };
}
const storeUrl = new URL('./store.ts', import.meta.url).href;
const migrationUrl = new URL('./job-output.ts', import.meta.url).href;
const sqliteUrl = new URL('../sqlite.ts', import.meta.url).href;
const openStore = `const {db,get,list}=await import(${JSON.stringify(storeUrl)});
  if(get('job','owner','0').output.length!==22001) throw Error('missing output');
  if(Object.hasOwn(list('job','owner')[0],'output')) throw Error('inline output'); db.close();`;

function child(code: string, data: string) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, DEPLOY_DATA_DIR: data },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    proc.stdout.on('data', (chunk) => {
      output += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      output += chunk;
    });
    proc.on('error', reject);
    proc.on('exit', (exitCode, signal) =>
      exitCode === 0 ? resolve() : reject(new Error(`${exitCode}/${signal}: ${output}`)),
    );
  });
}

test('concurrent first opens migrate 640 rows / 14 MB, and subsequent opens are idempotent', async (t) => {
  const { data, file } = legacyDatabase('concurrent');
  const start = performance.now();
  await Promise.all([child(openStore, data), child(openStore, data), child(openStore, data)]);
  t.diagnostic(`Three concurrent opens and migration: ${Math.round(performance.now() - start)} ms`);
  const migrated = openDatabase(file);
  try {
    assert.equal((migrated.prepare('SELECT count(*) AS n FROM job_output').get() as any).n, 640);
    assert.equal(
      migrated.prepare(`SELECT 1 FROM records WHERE ${inlineJobOutput}`).get(),
      undefined,
    );
    const before = migrated.prepare('SELECT * FROM job_output ORDER BY id').all();
    migrateJobOutput(migrated);
    assert.deepEqual(migrated.prepare('SELECT * FROM job_output ORDER BY id').all(), before);
    migrated
      .prepare("UPDATE records SET data=json_set(data,'$.output','after rollback') WHERE id='0'")
      .run();
  } finally {
    migrated.close();
  }
  await child(
    `const {db,get}=await import(${JSON.stringify(storeUrl)});
    if(get('job','owner','0').output!=='after rollback') throw Error('legacy write lost');
    if(db.prepare("SELECT 1 FROM records WHERE json_type(data,'$.output') IS NOT NULL").get()) throw Error('not repaired');
    db.close();`,
    data,
  );
});

test('SIGKILL during migration rolls back the output copy and schema; next open retries safely', async () => {
  const { data, file } = legacyDatabase('interrupted', 3);
  const legacy = openDatabase(file);
  legacy.exec(
    `CREATE TRIGGER interrupt_move BEFORE UPDATE ON records BEGIN SELECT interrupt_move(); END`,
  );
  legacy.close();
  const killed = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const {openDatabase}=await import(${JSON.stringify(sqliteUrl)});
    const {migrateJobOutput}=await import(${JSON.stringify(migrationUrl)});
    const db=openDatabase(${JSON.stringify(file)});
    db.function('interrupt_move',()=>process.kill(process.pid,'SIGKILL'));
    migrateJobOutput(db);`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const recovered = openDatabase(file);
  try {
    assert.equal(
      (recovered.prepare(`SELECT count(*) AS n FROM records WHERE ${inlineJobOutput}`).get() as any)
        .n,
      3,
    );
    assert.equal(
      recovered.prepare("SELECT 1 FROM sqlite_master WHERE name='job_output'").get(),
      undefined,
    );
    recovered.exec('DROP TRIGGER interrupt_move');
  } finally {
    recovered.close();
  }
  await child(openStore, data);
});

test('status lookups and startup residual checks use their partial indexes', () => {
  const queries = [
    [
      "SELECT json_remove(data,'$.output') AS data FROM records WHERE kind='job' AND owner=? AND json_extract(data,'$.status')=? ORDER BY rowid",
      ['owner', 'queued'],
    ],
    [
      "SELECT json_remove(data,'$.output') AS data FROM records WHERE kind='job' AND owner=? AND json_extract(data,'$.pipelineId')=? AND json_extract(data,'$.status') IN ('waiting','queued','running')",
      ['owner', 'pipeline'],
    ],
  ] as const;
  for (const [sql, args] of queries) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
    // A pipeline-specific cancellation can use the more selective pipeline index.
    assert.match(
      JSON.stringify(plan),
      sql.includes('$.pipelineId') ? /record_job_(pipeline|status)/ : /record_job_status/,
    );
  }
  assert.match(
    JSON.stringify(
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT data FROM records WHERE kind='job' AND owner=? AND json_extract(data,'$.status') IN ('queued','running')",
        )
        .all('owner'),
    ),
    /record_job_status/,
  );
  assert.match(
    JSON.stringify(
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT 1 FROM records INDEXED BY record_job_inline_output WHERE ${inlineJobOutput} LIMIT 1`,
        )
        .all(),
    ),
    /record_job_inline_output/,
  );
});

test('listing large jobs never reads job_output or parses output bodies', () => {
  db.transaction(() => {
    for (let i = 0; i < 640; i++)
      save('job', 'large', {
        id: String(i),
        status: 'succeeded',
        output: 'OUTPUT_SENTINEL' + 'x'.repeat(64_000),
      });
  }).immediate();
  // Any attempt to hydrate the outputs will fail while this table is unavailable.
  db.exec('ALTER TABLE job_output RENAME TO unavailable_job_output');
  const parse = JSON.parse;
  let parsedBytes = 0;
  JSON.parse = (text, ...args) => {
    assert.ok(!text.includes('OUTPUT_SENTINEL'));
    parsedBytes += Buffer.byteLength(text);
    return parse(text, ...args);
  };
  try {
    const jobs = list('job', 'large');
    assert.equal(jobs.length, 640);
    assert.ok(jobs.every((job) => !Object.hasOwn(job, 'output')));
    assert.ok(parsedBytes < 64_000);
  } finally {
    JSON.parse = parse;
    db.exec('ALTER TABLE unavailable_job_output RENAME TO job_output');
  }
});

test('job tools, task snapshot tails, and pipeline detail hydrate only the selected jobs', async () => {
  const { coordinationTool, describeJob, jobSnapshot } = await import('./coordination.ts');
  const { pipelineRead, pipelineCancel } = await import('./pipelines.ts');
  const owner = 'presentation';
  const scope = { owner, taskId: 'task', runId: 'run' };
  const output = 'line\n'.repeat(10_000);
  save('project', owner, { id: 'project' });
  save('pipeline-run', owner, { id: 'pipeline', projectId: 'project', status: 'running' });
  save('job', owner, {
    id: 'selected',
    taskId: 'task',
    pipelineId: 'pipeline',
    status: 'running',
    output,
  });
  save('job', owner, { id: 'unrelated', taskId: 'other-task', output: 'unrelated' });
  assert.equal(coordinationTool(scope, 'deploy_get_job', { jobId: 'selected' }).output, output);
  const jobs = coordinationTool(scope, 'deploy_list_jobs', {}).jobs;
  assert.deepEqual(
    jobs.map((job: any) => job.id),
    ['selected'],
  );
  assert.equal(jobs[0].output, output);
  const snapshot = jobSnapshot(describeJob(owner, list('job', owner)[0]));
  assert.equal(snapshot.output, output.slice(-16_000));
  assert.equal(snapshot.outputTruncated, true);
  assert.equal(pipelineRead(owner, 'project', 'pipeline').jobs![0].output, output);
  save('project', owner, { id: 'other-project' });
  assert.throws(() => pipelineCancel(owner, 'other-project', 'pipeline'), /Not found/);
  assert.equal(get('job', owner, 'selected').stopRequested, undefined);
  pipelineCancel(owner, 'project', 'pipeline');
  assert.equal(get('job', owner, 'selected').output, output);
  assert.equal(get('job', owner, 'selected').stopRequested, true);
  inline(owner, 'selected', 'old release progress');
  assert.equal(
    coordinationTool(scope, 'deploy_list_jobs', {}).jobs[0].output,
    'old release progress',
  );
  assert.equal(pipelineRead(owner, 'project', 'pipeline').jobs![0].output, 'old release progress');
});
