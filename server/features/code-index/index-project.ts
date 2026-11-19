import { hostname } from 'node:os';
import { setImmediate as yieldThread } from 'node:timers/promises';
import { compress, expand, listIndexProjects, openIndex, readStatus } from './database.ts';
import { extractFiles } from './extract.ts';
import { changedPaths, defaultTip, readBlobs, readTree, type TreeFile } from './git-source.ts';
import { updateGraph } from './graph.ts';
import { oneLine, type ExtractedFile, type IndexProject, type IndexStatus } from './model.ts';

type Db = ReturnType<typeof openIndex>;
const sameFile = (a: TreeFile, b?: TreeFile) =>
  b && a.oid === b.oid && a.bytes === b.bytes && a.policy === b.policy;
const filesOf = (
  db: Db,
  table: 'code_files' | 'code_staged_files',
  owner: string,
  project: string,
) =>
  new Map(
    (
      db
        .prepare(`SELECT path,oid,bytes,policy FROM ${table} WHERE owner=? AND project=?`)
        .all(owner, project) as TreeFile[]
    ).map((file) => [file.path, file]),
  );

function clearStaging(db: Db, owner: string, project: string) {
  db.prepare('DELETE FROM code_staged_files WHERE owner=? AND project=?').run(owner, project);
  db.prepare('DELETE FROM code_attempts WHERE owner=? AND project=?').run(owner, project);
}

function removeFile(db: Db, owner: string, project: string, path: string) {
  const row = db
    .prepare('DELETE FROM code_files WHERE owner=? AND project=? AND path=? RETURNING id')
    .get(owner, project, path) as { id: number } | undefined;
  if (row) db.prepare('DELETE FROM code_text WHERE rowid=?').run(row.id);
}

function removeProject(db: Db, owner: string, project: string, active: Set<string>) {
  db.transaction(() => {
    const paths = new Set(filesOf(db, 'code_files', owner, project).keys());
    for (const path of paths) removeFile(db, owner, project, path);
    db.prepare('DELETE FROM code_projects WHERE owner=? AND project=?').run(owner, project);
    clearStaging(db, owner, project);
    updateGraph(db, owner, project, active, paths);
  }).immediate();
}

function storeBatch(
  db: Db,
  owner: string,
  project: string,
  files: TreeFile[],
  results: ExtractedFile[],
) {
  const insert = db.prepare('INSERT OR REPLACE INTO code_staged_files VALUES (?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const [index, file] of files.entries()) {
      const { text, ...data } = results[index];
      insert.run(
        owner,
        project,
        file.path,
        file.oid,
        file.bytes,
        file.policy,
        compress(JSON.stringify(data)),
        text === undefined ? null : compress(text),
      );
    }
  }).immediate();
}

function publish(
  db: Db,
  owner: string,
  status: IndexStatus,
  paths: Set<string>,
  active: Set<string>,
) {
  const { project } = status;
  const insert = db.prepare(
    'INSERT INTO code_files (owner,project,path,oid,bytes,policy,kind,coverage,lines,reason,errorLine,data,title,body) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
  );
  const text = db.prepare('INSERT INTO code_text(rowid,body) VALUES (?,?)');
  db.transaction(() => {
    const changed = new Set<string>();
    for (const path of filesOf(db, 'code_files', owner, project).keys()) {
      if (paths.has(path)) continue;
      removeFile(db, owner, project, path);
      changed.add(path);
    }
    const readPage = db.prepare(
      'SELECT path,oid,bytes,policy,data,body FROM code_staged_files WHERE owner=? AND project=? AND path>? ORDER BY path LIMIT 24',
    );
    let after = '';
    for (;;) {
      const page = readPage.all(owner, project, after) as (TreeFile & {
        data: Buffer;
        body: Buffer | null;
      })[];
      if (!page.length) break;
      for (const row of page) {
        const { kind, coverage, lines, reason, errorLine, title } = JSON.parse(
          expand(row.data),
        ) as ExtractedFile;
        removeFile(db, owner, project, row.path);
        changed.add(row.path);
        const { id } = insert.get(
          owner,
          project,
          row.path,
          row.oid,
          row.bytes,
          row.policy,
          kind,
          coverage,
          lines,
          reason ?? null,
          errorLine ?? null,
          row.data,
          title ?? null,
          row.body,
        ) as { id: number };
        if (row.body !== null) text.run(id, expand(row.body));
      }
      after = page.at(-1)!.path;
    }
    updateGraph(db, owner, project, active, changed);
    db.prepare(`INSERT OR REPLACE INTO code_projects VALUES
      (@owner,@project,@branch,@commit,@indexedAt,@durationMs,@computer,@extractedFiles,@incremental,@omittedFiles)`).run(
      {
        ...status,
        owner,
        durationMs: status.durationMs + Date.now() - Date.parse(status.indexedAt),
        indexedAt: new Date().toISOString(),
      },
    );
    clearStaging(db, owner, project);
  }).immediate();
}

export async function indexProject({
  database,
  workspace,
  owner,
  project,
}: {
  database: string;
  workspace: string;
  owner: string;
  project: string;
}) {
  const projects = listIndexProjects(workspace, owner);
  const repository = projects.find(({ id }) => id === project);
  const active = new Set(projects.map(({ id }) => id));
  const db = openIndex(database);
  try {
    if (!repository) {
      const exists =
        readStatus(db, owner, project) ||
        db.prepare('SELECT 1 FROM code_attempts WHERE owner=? AND project=?').get(owner, project);
      if (exists) removeProject(db, owner, project, active);
      return { state: 'missing' };
    }
    const commit = await defaultTip(repository);
    if (!commit) {
      // A newly created repository can have no commits. A deleted default ref
      // likewise has no current version; do not publish an empty graph over it.
      return { state: 'no commit' };
    }
    const start = Date.now();
    const last = readStatus(db, owner, project);
    const attempt = db
      .prepare('SELECT "commit" FROM code_attempts WHERE owner=? AND project=?')
      .get(owner, project) as { commit: string } | undefined;
    if (last?.commit === commit && last.branch === repository.defaultBranch) {
      if (attempt) db.transaction(() => clearStaging(db, owner, project)).immediate();
      return { state: 'current' };
    }
    db.transaction(() => {
      if (attempt?.commit !== commit) clearStaging(db, owner, project);
      db.prepare('INSERT OR REPLACE INTO code_attempts VALUES (?,?,?,NULL)').run(
        owner,
        project,
        commit,
      );
    }).immediate();
    try {
      const old = filesOf(db, 'code_files', owner, project);
      const staged = filesOf(db, 'code_staged_files', owner, project);
      let changed: Set<string> | undefined;
      if (last) {
        // This also works for force pushes and coalesced push notifications.
        // The older object may have been pruned, in which case the tree IDs suffice.
        changed = await changedPaths(repository.repositoryPath, last.commit, commit).catch(
          () => undefined,
        );
      }
      const { files, omittedFiles } = await readTree(repository.repositoryPath, commit);
      const work = files.filter((file) => {
        const previous = old.get(file.path);
        const needsExtraction =
          !previous ||
          previous.policy !== file.policy ||
          ((!changed || changed.has(file.path)) && !sameFile(file, previous));
        return needsExtraction && !sameFile(file, staged.get(file.path));
      });
      let extracted = 0;
      for (let at = 0; at < work.length;) {
        const batch: TreeFile[] = [];
        let bytes = 0;
        while (at < work.length && batch.length < 36 && bytes < 2 * 1024 * 1024) {
          const file = work[at++];
          batch.push(file);
          if (!file.policy) bytes += file.bytes;
        }
        const read = batch.filter((file) => !file.policy);
        const blobs = await readBlobs(repository.repositoryPath, read);
        storeBatch(db, owner, project, batch, extractFiles(batch, blobs));
        extracted += read.length;
        await yieldThread();
      }
      // Another push or repository edit while we were extracting should start
      // another pass. Readers still see the previous transaction.
      const refreshed = listIndexProjects(workspace, owner);
      const current = refreshed.find(({ id }) => id === project);
      if (
        !current ||
        !sameRepository(repository, current) ||
        (await defaultTip(current)) !== commit
      )
        return { state: 'superseded' };
      publish(
        db,
        owner,
        {
          project,
          commit,
          branch: repository.defaultBranch,
          indexedAt: new Date().toISOString(),
          durationMs: Date.now() - start,
          computer: hostname(),
          extractedFiles: extracted,
          incremental: Number(!!last),
          omittedFiles,
        },
        new Set(files.map(({ path }) => path)),
        new Set(refreshed.map(({ id }) => id)),
      );
      return { state: 'indexed', extractedFiles: extracted, resumedFiles: staged.size };
    } catch (error) {
      db.prepare('UPDATE code_attempts SET error=? WHERE owner=? AND project=? AND "commit"=?').run(
        oneLine(String(error)),
        owner,
        project,
        commit,
      );
      throw error;
    }
  } finally {
    db.close();
  }
}

function sameRepository(before: IndexProject, after: IndexProject) {
  return (
    before.repositoryPath === after.repositoryPath && before.defaultBranch === after.defaultBranch
  );
}
