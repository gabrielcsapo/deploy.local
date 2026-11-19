import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { openDatabase } from '../../kernel/db/index.ts';
import { searchRepositoryCode } from '../repositories/repository-search.ts';
import { expand, listIndexProjects, openIndex } from './database.ts';
import { defaultTip } from './git-source.ts';
import { oneLine, type IndexProject } from './model.ts';
import { projectSections } from './tool-schema.ts';

type Db = ReturnType<typeof openIndex>;
type Row = Record<string, any>;
type Args = Record<string, unknown>;
const defaultLimit = 5;
const maxLimit = 20;
const maxResultBytes = 12 * 1024;
const maxOffset = 10_000;
const projectHandle = (id: string) => 'project:' + id;
const symbolHandle = (project: string, commit: string, handle: string) =>
  `symbol:${project}@${commit}:${handle}`;
const digest = (parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 16);
const bounded = (value: unknown, max: number) =>
  typeof value === 'string' ? value.slice(0, max) : undefined;
const qstring = (value: unknown, name: string, max: number) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  )
    throw new Error(`Invalid ${name}`);
  return value.trim();
};
const clamp = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
const sqlLike = (query: string) => '%' + query.replace(/[\\%_]/g, '\\$&') + '%';

function page(args: Args, key: unknown[]) {
  const fingerprint = digest(key);
  const limit = clamp(args.limit, defaultLimit, 1, maxLimit);
  let offset = 0;
  if (args.cursor !== undefined) {
    const cursor = qstring(args.cursor, 'cursor', 128);
    const match = /^(\d{1,5})\.([A-Za-z0-9_-]{16})$/.exec(cursor);
    if (!match || match[2] !== fingerprint || Number(match[1]) > maxOffset)
      throw new Error('This cursor is invalid or no longer current');
    offset = Number(match[1]);
  }
  return { limit, offset, next: (count: number) => `${offset + count}.${fingerprint}` };
}

function paged(
  args: Args,
  key: unknown[],
  select: (limit: number, offset: number) => Row[],
  summary: Row = {},
) {
  const { limit, offset, next } = page(args, key);
  const rows = select(limit + 1, offset);
  const items: Row[] = [];
  for (const row of rows.slice(0, limit)) {
    if (
      Buffer.byteLength(JSON.stringify({ ...summary, items: [...items, row] })) >
      maxResultBytes - 256
    )
      break;
    items.push(row);
  }
  return {
    ...summary,
    items,
    nextCursor:
      items.length && items.length < rows.length && offset + items.length <= maxOffset
        ? next(items.length)
        : null,
  };
}

function editDistance(a: string, b: string) {
  const steps = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = steps[0];
    steps[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const after = Math.min(
        steps[j] + 1,
        steps[j - 1] + 1,
        diagonal + Number(a[i - 1] !== b[j - 1]),
      );
      diagonal = steps[j];
      steps[j] = after;
    }
  }
  return steps.at(-1)!;
}

function similarity(text: unknown, query: string, fuzzy = true) {
  const name = bounded(text, 160)?.toLowerCase().trim();
  if (!name) return 0;
  if (name === query) return 120;
  if (name.startsWith(query)) return 100;
  if (name.includes(query)) return 80;
  if (!fuzzy || query.length < 3) return 0;
  const tokens = query.split(/[^a-z0-9]+/).filter((token) => token.length > 1);
  const words = new Set(name.split(/[^a-z0-9]+/));
  const overlap = tokens.filter((token) => words.has(token)).length;
  if (overlap >= 2 && overlap / tokens.length >= 0.5) return 62 + overlap;
  const distance = editDistance(name, query);
  return distance <= Math.min(5, Math.floor(Math.max(name.length, query.length) * 0.3))
    ? 50 - distance
    : 0;
}

function versionTuple(value: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(value);
  return match
    ? { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? [] }
    : undefined;
}

function lessThan(a: string, b: string) {
  const left = versionTuple(a);
  const right = versionTuple(b);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++)
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i];
  if (!left.prerelease.length || !right.prerelease.length)
    return !!left.prerelease.length && !right.prerelease.length;
  for (const [index, x] of left.prerelease.entries()) {
    const y = right.prerelease[index];
    if (y === undefined) return false;
    if (x === y) continue;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return Number(x) < Number(y);
    if (numericX !== numericY) return numericX;
    return x < y;
  }
  return left.prerelease.length < right.prerelease.length;
}

class Queries {
  readonly byId: Map<string, IndexProject>;
  readonly allowed: string;
  readonly pending: string[] = [];
  readonly db: Db;
  readonly owner: string;
  readonly projects: IndexProject[];
  readonly registry?: Db;
  constructor(db: Db, owner: string, projects: IndexProject[], registry?: Db) {
    this.db = db;
    this.owner = owner;
    this.projects = projects;
    this.registry = registry;
    this.byId = new Map(projects.map((row) => [row.id, row]));
    this.allowed = JSON.stringify([...this.byId.keys()]);
  }

  private count(sql: string, ...params: unknown[]) {
    return (this.db.prepare(sql).get(...params) as { count: number }).count;
  }

  private recentCommits() {
    return this.db
      .prepare(
        'SELECT project,"commit" FROM code_projects WHERE owner=? AND project IN (SELECT value FROM json_each(?)) ORDER BY project',
      )
      .all(this.owner, this.allowed);
  }

  private selectProject(value: unknown) {
    const input = qstring(value, 'project', 256);
    const byId = this.byId.get(input.replace(/^project:/, ''));
    const byName = this.projects.filter(({ name }) => name.toLowerCase() === input.toLowerCase());
    if (byId) return byId;
    if (byName.length === 1) return byName[0];
    throw new Error('Project not found. Use a project handle from deploy_code_find.');
  }

  private displayProject(id: string) {
    const project = this.byId.get(id);
    return { name: bounded(project?.name, 120), handle: projectHandle(id) };
  }

  private displaySymbol(row: Row) {
    return {
      handle: symbolHandle(row.project, row.commit, row.handle),
      name: bounded(row.name, 120),
      kind: row.kind,
      path: bounded(row.path, 360),
      line: row.line,
      column: row.col,
      signature: bounded(row.signature, 200),
      doc: bounded(row.doc, 160),
    };
  }

  find(args: Args) {
    const query = qstring(args.query, 'query', 160).toLowerCase();
    const committed = this.recentCommits();
    const ready = new Set(committed.map((row) => (row as Row).project));
    const titleRows = this.db
      .prepare(
        'SELECT project,title FROM code_files WHERE owner=? AND title IS NOT NULL AND project IN (SELECT value FROM json_each(?)) ORDER BY project,path LIMIT 5000',
      )
      .all(this.owner, this.allowed) as Row[];
    const titles = new Map<string, string[]>();
    for (const { project, title } of titleRows) {
      const existing = titles.get(project) ?? [];
      existing.push(title);
      titles.set(project, existing);
    }
    const results: (Row & { score: number })[] = [];
    for (const project of this.projects) {
      const score = Math.max(
        similarity(project.name, query),
        similarity(project.description, query) - 14,
        ...(titles.get(project.id) ?? []).map((title) => similarity(title, query) - 6),
      );
      if (score > 0)
        results.push({
          type: 'project',
          ...this.displayProject(project.id),
          about: oneLine(
            project.description || titles.get(project.id)?.[0] || 'Hosted project',
            140,
          ),
          score,
        });
    }
    const packages = this.db
      .prepare(
        'SELECT project,manifest,ecosystem,name,version,description FROM code_packages WHERE owner=? AND project IN (SELECT value FROM json_each(?)) ORDER BY project,manifest LIMIT 5000',
      )
      .all(this.owner, this.allowed) as Row[];
    for (const row of packages) {
      const score = Math.max(
        similarity(row.name, query),
        similarity(row.description, query) - 14,
        ...(titles.get(row.project) ?? []).map((title) => similarity(title, query) - 8),
      );
      if (score > 0)
        results.push({
          type: 'package',
          ecosystem: row.ecosystem,
          name: bounded(row.name, 120),
          version: bounded(row.version, 80),
          project: projectHandle(row.project),
          about: oneLine(
            row.description || 'Package published by ' + (this.byId.get(row.project)?.name ?? ''),
            140,
          ),
          score: score + 6,
        });
    }
    const symbols = this.db
      .prepare(`SELECT s.*,p."commit" FROM code_symbols s JOIN code_projects p USING(owner,project)
      WHERE s.owner=? AND s.project IN (SELECT value FROM json_each(?)) AND s.name LIKE ? ESCAPE '\\'
      ORDER BY (s.name=? COLLATE NOCASE) DESC, (s.name LIKE ? ESCAPE '\\') DESC, LENGTH(s.name),s.name,s.project,s.path,s.offset LIMIT 1000`)
      .all(this.owner, this.allowed, sqlLike(query), query, sqlLike(query).slice(1)) as Row[];
    for (const row of symbols)
      results.push({
        type: 'symbol',
        handle: symbolHandle(row.project, row.commit, row.handle),
        name: bounded(row.name, 120),
        kind: row.kind,
        project: projectHandle(row.project),
        about: oneLine(row.doc || row.signature, 140),
        score: similarity(row.name, query, false),
      });
    const external = this.db
      .prepare(`SELECT ecosystem,name,COUNT(*) AS manifests FROM code_dependencies WHERE owner=?
      AND project IN (SELECT value FROM json_each(?)) AND (producer IS NULL OR producer NOT IN (SELECT value FROM json_each(?)))
      AND name LIKE ? ESCAPE '\\' GROUP BY ecosystem,name ORDER BY (name=? COLLATE NOCASE) DESC,manifests DESC,name,ecosystem LIMIT 500`)
      .all(this.owner, this.allowed, this.allowed, sqlLike(query), query) as Row[];
    for (const row of external)
      results.push({
        type: 'package',
        ecosystem: row.ecosystem,
        name: bounded(row.name, 120),
        about: `External dependency in ${row.manifests} manifests`,
        score: similarity(row.name, query, false) - 85,
      });
    results.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
    for (const project of this.projects.filter(({ id }) => !ready.has(id)).slice(0, 40))
      this.pending.push(project.id);
    return paged(
      args,
      [this.owner, 'find', query, committed],
      (limit, offset) =>
        results.slice(offset, offset + limit).map(({ score: _score, ...row }) => row),
      {
        matches: results.length,
        indexedProjects: ready.size,
        projects: this.projects.length,
        truncated:
          symbols.length === 1000 ||
          external.length === 500 ||
          packages.length === 5000 ||
          titleRows.length === 5000,
      },
    );
  }

  private snippets(project: string, path: string, line: number, context: number, query?: string) {
    const file = this.db
      .prepare('SELECT body FROM code_files WHERE owner=? AND project=? AND path=?')
      .get(this.owner, project, path) as { body: Buffer | null } | undefined;
    if (!file?.body) return {};
    const lines = expand(file.body).split(/\r\n|[\n\r\u2028\u2029]/);
    const text = (lines[line - 1] ?? '').trim();
    const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : 0;
    const from = Math.max(0, at - 55);
    return {
      snippet: (from ? '…' : '') + oneLine(text.slice(from)),
      ...(context
        ? {
            context: lines
              .slice(Math.max(0, line - 1 - context), line + context)
              .map((neighbor, i) => ({
                line: Math.max(1, line - context) + i,
                text: oneLine(neighbor, 140),
              })),
          }
        : {}),
    };
  }

  symbol(args: Args) {
    const handle = qstring(args.handle, 'handle', 256);
    const [, project, commit, key] =
      /^symbol:([^@]+)@([a-f0-9]{40,64}):([A-Za-z0-9_-]{43})$/.exec(handle) ?? [];
    if (!project || !this.byId.has(project)) throw new Error('Symbol not found');
    const current = this.db
      .prepare('SELECT "commit" FROM code_projects WHERE owner=? AND project=?')
      .get(this.owner, project) as { commit: string } | undefined;
    if (!current || current.commit !== commit)
      throw new Error('Symbol handle is stale. Find the symbol again.');
    const symbol = this.db
      .prepare('SELECT * FROM code_symbols WHERE owner=? AND project=? AND handle=?')
      .get(this.owner, project, key) as Row | undefined;
    if (!symbol) throw new Error('Symbol not found');
    const params = [this.owner, project, symbol.path, symbol.offset, this.allowed];
    const where =
      'WHERE owner=? AND targetProject=? AND targetPath=? AND targetOffset=? AND project IN (SELECT value FROM json_each(?))';
    const context = clamp(args.context, 0, 0, 3);
    if (args.section !== undefined && args.section !== 'references')
      throw new Error('Unknown symbol section');
    const summary = this.db
      .prepare(
        `SELECT COUNT(*) places,COUNT(DISTINCT project) projects,COUNT(DISTINCT json_array(project,path)) files FROM code_references ${where}`,
      )
      .get(...params) as Row;
    if (args.section === 'references')
      return paged(
        args,
        [this.owner, handle, this.recentCommits()],
        (limit, offset) =>
          (
            this.db
              .prepare(
                `SELECT project,path,line,col,confidence FROM code_references ${where} ORDER BY project,path,offset LIMIT ? OFFSET ?`,
              )
              .all(...params, limit, offset) as Row[]
          ).map((row) => ({
            project: projectHandle(row.project),
            path: bounded(row.path, 360),
            line: row.line,
            column: row.col,
            confidence: row.confidence,
            ...this.snippets(row.project, row.path, row.line, context),
          })),
        { handle, ...summary },
      );
    const byProject = this.db
      .prepare(
        `SELECT project,COUNT(*) places FROM code_references ${where} GROUP BY project ORDER BY places DESC,project LIMIT 3`,
      )
      .all(...params) as Row[];
    const byFile = this.db
      .prepare(
        `SELECT project,path,COUNT(*) places FROM code_references ${where} GROUP BY project,path ORDER BY places DESC,project,path LIMIT 3`,
      )
      .all(...params) as Row[];
    const confidence = this.db
      .prepare(
        `SELECT confidence,COUNT(*) places FROM code_references ${where} GROUP BY confidence ORDER BY confidence`,
      )
      .all(...params);
    return {
      definition: {
        ...this.displaySymbol({ ...symbol, commit }),
        project: projectHandle(project),
        ...this.snippets(project, symbol.path, symbol.line, context),
      },
      usage: {
        ...summary,
        confidence,
        topProjects: byProject.map((row) => ({
          ...this.displayProject(row.project),
          places: row.places,
        })),
        topFiles: byFile.map((row) => ({
          project: projectHandle(row.project),
          path: bounded(row.path, 360),
          places: row.places,
        })),
      },
      references: { handle, section: 'references' },
    };
  }

  private registryVersion(row: Row) {
    if (!this.registry || !row.producer) return;
    try {
      const pkg = this.registry
        .prepare(`SELECT id FROM packages WHERE ecosystem=? AND name=? AND created_by=?
        AND (project_id=? OR project_id IS NULL)`)
        .get(row.ecosystem, row.name, this.owner, row.producer) as { id: string } | undefined;
      if (!pkg) return;
      if (row.ecosystem === 'npm') {
        const latest = this.registry
          .prepare("SELECT version FROM package_tags WHERE package_id=? AND tag='latest'")
          .get(pkg.id) as { version: string } | undefined;
        if (latest) return latest.version;
      }
      const releases = this.registry
        .prepare(
          'SELECT version FROM package_versions WHERE package_id=? AND yanked=0 ORDER BY created_at DESC LIMIT 300',
        )
        .all(pkg.id) as { version: string }[];
      return releases.reduce<string | undefined>(
        (latest, { version }) => (!latest || lessThan(latest, version) ? version : latest),
        undefined,
      );
    } catch {
      // The graph works with only the workspace DB, including during migrations or recovery.
      return undefined;
    }
  }

  private dependency(row: Row) {
    const producer = this.byId.has(row.producer) ? projectHandle(row.producer) : null;
    const versions = JSON.parse(row.versions) as string[];
    const released = producer ? this.registryVersion(row) : undefined;
    const latest = producer ? (bounded(released ?? row.latest, 80) ?? null) : null;
    const freshness =
      !latest || !versions.length
        ? 'unknown'
        : versions.every((version) => lessThan(version, latest))
          ? 'behind'
          : versions.every((version) => version === latest)
            ? 'current'
            : 'mixed';
    return {
      name: bounded(row.name, 120),
      ecosystem: row.ecosystem,
      manifest: bounded(row.manifest, 240),
      ...(row.alias !== row.name ? { alias: bounded(row.alias, 120) } : {}),
      requirement: bounded(row.requirement, 160) ?? null,
      versions: versions.slice(0, 4).map((item) => bounded(item, 80)),
      ...(versions.length > 4 ? { versionCount: versions.length } : {}),
      producer,
      latest,
      freshness,
      ...(latest ? { latestSource: released ? 'registry' : 'manifest' } : {}),
      places: row.places,
      files: row.files,
      mostly: (JSON.parse(row.mostly) as string[]).map((item) => bounded(item, 80)),
    };
  }

  async project(args: Args) {
    const project = this.selectProject(args.project);
    const { owner, db } = this;
    const id = project.id;
    const handle = projectHandle(id);
    const row = db
      .prepare('SELECT * FROM code_projects WHERE owner=? AND project=?')
      .get(owner, id) as Row | undefined;
    const attempt = db
      .prepare('SELECT "commit",error FROM code_attempts WHERE owner=? AND project=?')
      .get(owner, id) as Row | undefined;
    const tip = await defaultTip(project).catch(() => null);
    const fresh =
      tip === null
        ? 'unknown'
        : !tip
          ? 'no commit'
          : !row
            ? 'pending'
            : tip === row.commit && project.defaultBranch === row.branch
              ? 'current'
              : 'stale';
    if (tip && fresh !== 'current') this.pending.push(id);
    const status = {
      branch: project.defaultBranch,
      head: tip || null,
      commit: row?.commit ?? null,
      freshness: fresh,
      ...(row
        ? {
            indexedAt: row.indexedAt,
            durationMs: row.durationMs,
            computer: row.computer,
            extractedFiles: row.extractedFiles,
            incremental: Boolean(row.incremental),
            omittedFiles: row.omittedFiles,
          }
        : {}),
      ...(attempt
        ? {
            indexTarget: attempt.commit,
            ...(attempt.error
              ? { indexError: 'Indexing failed; the last complete snapshot remains available.' }
              : {}),
          }
        : {}),
    };
    const section = args.section;
    if (section !== undefined && !projectSections.some((candidate) => candidate === section))
      throw new Error('Unknown project section');
    if (!row) return { project: this.displayProject(id), status };
    const byProject = 'WHERE owner=? AND project=?';
    const whereUsed =
      'WHERE owner=? AND producer=? AND project<>producer AND project IN (SELECT value FROM json_each(?))';
    const unreferenced = `FROM code_exports e JOIN code_symbols s ON (s.owner,s.project,s.path,s.offset)=(e.owner,e.targetProject,e.targetPath,e.targetOffset)
      WHERE e.owner=? AND e.project=? AND e.targetProject=e.project AND NOT EXISTS (
        SELECT 1 FROM code_references r WHERE (r.owner,r.targetProject,r.targetPath,r.targetOffset)=(s.owner,s.project,s.path,s.offset)
        AND r.project IN (SELECT value FROM json_each(?)))`;
    const commands: Record<
      (typeof projectSections)[number],
      { sql: string; params: unknown[]; display?: (row: Row) => Row }
    > = {
      entries: {
        sql: `SELECT manifest,name,path,exposure FROM code_entries ${byProject} ORDER BY manifest,name,path`,
        params: [owner, id],
        display: (item) => ({
          manifest: bounded(item.manifest, 240),
          name: bounded(item.name, 120),
          path: bounded(item.path, 360),
          exposure: item.exposure,
        }),
      },
      exports: {
        sql: `SELECT e.name AS exportedName,e.path AS exportedFrom,s.*,p."commit" FROM code_exports e
        JOIN code_symbols s ON (s.owner,s.project,s.path,s.offset)=(e.owner,e.targetProject,e.targetPath,e.targetOffset)
        JOIN code_projects p ON (p.owner,p.project)=(s.owner,s.project)
        WHERE e.owner=? AND e.project=? AND s.project IN (SELECT value FROM json_each(?)) ORDER BY e.path,e.name,s.project,s.path,s.offset`,
        params: [owner, id, this.allowed],
        display: (item) => ({
          exportedName: bounded(item.exportedName, 120),
          exportedFrom: bounded(item.exportedFrom, 360),
          ...this.displaySymbol(item),
        }),
      },
      symbols: {
        sql: `SELECT *,? AS "commit" FROM code_symbols ${byProject} ORDER BY path,offset`,
        params: [row.commit, owner, id],
        display: (item) => this.displaySymbol(item),
      },
      uses: {
        sql: `SELECT * FROM code_dependencies ${byProject} ORDER BY places DESC,name,manifest,alias`,
        params: [owner, id],
        display: (item) => this.dependency(item),
      },
      usedBy: {
        sql: `SELECT * FROM code_dependencies ${whereUsed} ORDER BY places DESC,project,name,manifest,alias`,
        params: [owner, id, this.allowed],
        display: (item) => ({
          consumer: this.displayProject(item.project),
          ...this.dependency(item),
        }),
      },
      unreferenced: {
        sql: `SELECT DISTINCT s.*,? AS "commit" ${unreferenced} ORDER BY s.path,s.offset`,
        params: [row.commit, owner, id, this.allowed],
        display: (item) => this.displaySymbol(item),
      },
      files: {
        sql: `SELECT path,kind,bytes,lines,coverage,reason,errorLine FROM code_files ${byProject} ORDER BY path`,
        params: [owner, id],
        display: (item) => ({ ...item, path: bounded(item.path, 360) }),
      },
      skipped: {
        sql: `SELECT path,kind,bytes,lines,reason,errorLine FROM code_files ${byProject} AND coverage='skipped' ORDER BY path`,
        params: [owner, id],
        display: (item) => ({ ...item, path: bounded(item.path, 360) }),
      },
      coverage: {
        sql: `SELECT kind,coverage,COUNT(*) files,SUM(lines) lines FROM code_files ${byProject} GROUP BY kind,coverage ORDER BY kind,coverage`,
        params: [owner, id],
      },
    };
    if (section) {
      const command = commands[section as keyof typeof commands];
      return paged(
        args,
        [owner, handle, section, row.commit, this.recentCommits()],
        (limit, offset) =>
          (
            db
              .prepare(command.sql + ' LIMIT ? OFFSET ?')
              .all(...command.params, limit, offset) as Row[]
          ).map(command.display ?? ((item) => item)),
        { project: handle, section, commit: row.commit },
      );
    }
    const sections = Object.fromEntries(
      Object.entries(commands).map(([key, command]) => [
        key,
        {
          count: this.count(
            `SELECT COUNT(*) AS count FROM (${command.sql.replace(/ ORDER BY[\s\S]*$/, '')})`,
            ...command.params,
          ),
          project: handle,
          section: key,
        },
      ]),
    );
    const files = db
      .prepare(`SELECT SUM(lines) lines,SUM(coverage IN ('symbols','packages')) connected,
      SUM(coverage='text') text,SUM(coverage='skipped') skipped FROM code_files ${byProject}`)
      .get(owner, id) as Row;
    return { project: this.displayProject(id), status, files, sections };
  }

  async search(args: Args) {
    const query = qstring(args.query, 'query', 160);
    const needle = query.toLowerCase();
    const filter = args.project === undefined ? undefined : this.selectProject(args.project);
    const projects = filter ? [filter] : this.projects;
    const ids = JSON.stringify(projects.map(({ id }) => id));
    const context = clamp(args.context, 0, 0, 3);
    const committed = this.recentCommits() as { project: string; commit: string }[];
    const commits = new Map(committed.map(({ project, commit }) => [project, commit]));
    const candidates = new Map<
      string,
      Row & { project: string; path: string; line: number; commit: string; score: number }
    >();
    let truncated = false;
    const add = (
      row: Row & { project: string; path: string; line: number; commit: string; score: number },
    ) => {
      const key = JSON.stringify([row.project, row.commit, row.path, row.line]);
      const existing = candidates.get(key);
      if (!existing || existing.score < row.score) candidates.set(key, row);
    };
    const allowed = 'project IN (SELECT value FROM json_each(?))';
    const maxMatches = 1800;
    // Exact symbol hits rank ahead of literal lines, so uses through aliases remain discoverable.
    const semantic = this.db
      .prepare(`WITH named AS (
        SELECT project,path,line,offset,handle FROM code_symbols WHERE owner=? AND name=? COLLATE NOCASE AND ${allowed}
      )
      SELECT project,path,line,handle,1 AS definition,NULL AS confidence FROM named
      UNION ALL
      SELECT r.project,r.path,r.line,NULL,0,r.confidence
      FROM named n JOIN code_references r ON r.owner=? AND (r.targetProject,r.targetPath,r.targetOffset)=(n.project,n.path,n.offset)
      WHERE r.${allowed}
      ORDER BY definition DESC,project,path,line LIMIT ?`)
      .all(this.owner, query, this.allowed, this.owner, ids, maxMatches) as {
      project: string;
      path: string;
      line: number;
      handle?: string;
      definition: number;
      confidence: string | null;
    }[];
    truncated ||= semantic.length === maxMatches;
    for (const row of semantic) {
      const commit = commits.get(row.project);
      if (commit && projects.some(({ id }) => id === row.project))
        add({
          project: row.project,
          path: row.path,
          line: row.line,
          commit,
          score: row.definition ? 4 : 3,
          ...(row.handle ? { definition: symbolHandle(row.project, commit, row.handle) } : {}),
          ...(row.confidence ? { confidence: row.confidence } : {}),
        });
    }
    if ([...needle].length >= 3) {
      const maxFiles = 768;
      const fileRows = this.db
        .prepare(`SELECT f.project,f.path,f.id,f.bytes FROM code_text
        JOIN code_files f ON f.id=code_text.rowid WHERE code_text MATCH ? AND f.owner=? AND f.${allowed}
        ORDER BY rank,f.project,f.path LIMIT ?`)
        .all('"' + needle.replaceAll('"', '""') + '"', this.owner, ids, maxFiles) as {
        project: string;
        path: string;
        id: number;
        bytes: number;
      }[];
      const read = this.db.prepare('SELECT body FROM code_files WHERE id=?');
      truncated ||= fileRows.length === maxFiles;
      let bytes = 0;
      for (const file of fileRows) {
        bytes += file.bytes;
        if (bytes > 20 * 1024 * 1024 || candidates.size >= maxMatches) {
          truncated = true;
          break;
        }
        const commit = commits.get(file.project);
        if (!commit) continue;
        const { body } = read.get(file.id) as { body: Buffer };
        const lines = expand(body).split(/\r\n|[\n\r\u2028\u2029]/);
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(needle)) continue;
          add({
            project: file.project,
            path: file.path,
            line: i + 1,
            commit,
            score: file.path.toLowerCase().includes(needle) ? 2 : 1,
          });
          if (candidates.size >= maxMatches) {
            truncated = true;
            break;
          }
        }
      }
    }
    const fallback = projects.filter(({ id }) => [...needle].length < 3 || !commits.has(id));
    truncated ||= fallback.length > 12;
    let fallbackProjects = 0;
    for (let i = 0; i < Math.min(fallback.length, 12); i += 4) {
      await Promise.all(
        fallback.slice(i, i + 4).map(async (project) => {
          try {
            if (!commits.has(project.id)) this.pending.push(project.id);
            const commit = commits.get(project.id) || (await defaultTip(project));
            if (!commit) return;
            const result = await searchRepositoryCode(project.repositoryPath, commit, query, {
              keep: 120,
              count: 121,
              timeout: 1500,
            });
            fallbackProjects++;
            truncated ||= result.truncated;
            for (const item of result.items)
              add({
                ...item,
                project: project.id,
                commit,
                score: 0,
                fallback: true,
                snippet: item.text,
              });
          } catch {
            truncated = true;
          }
        }),
      );
    }
    const results = [...candidates.values()].sort(
      (a, b) =>
        b.score - a.score ||
        a.project.localeCompare(b.project) ||
        a.path.localeCompare(b.path) ||
        a.line - b.line,
    );
    return paged(
      args,
      [
        this.owner,
        'search',
        query,
        filter?.id,
        committed,
        [...new Set(results.map((row) => row.commit))],
      ],
      (limit, offset) =>
        results.slice(offset, offset + limit).map((row) => ({
          project: projectHandle(row.project),
          path: bounded(row.path, 360),
          line: row.line,
          commit: row.commit,
          ...(row.definition ? { definition: row.definition } : {}),
          ...(row.confidence ? { confidence: row.confidence } : {}),
          ...(row.fallback
            ? { source: 'git grep', snippet: row.snippet }
            : {
                source: 'index',
                ...this.snippets(row.project, row.path, row.line, context, query),
              }),
        })),
      {
        matches: results.length,
        indexedProjects: projects.filter(({ id }) => commits.has(id)).length,
        fallbackProjects,
        truncated,
      },
    );
  }
}

export async function queryIndex({
  database,
  workspace,
  registry,
  owner,
  name,
  args,
}: {
  database: string;
  workspace: string;
  registry?: string;
  owner: string;
  name: string;
  args: Args;
}) {
  const projects = listIndexProjects(workspace, owner);
  let db = existsSync(database) ? openIndex(database, true) : openIndex(database);
  if (db.pragma('user_version', { simple: true }) === 0) {
    db.close();
    db = openIndex(database);
  }
  let packageRegistry: Db | undefined;
  try {
    if (registry && existsSync(registry) && name === 'deploy_code_project')
      packageRegistry = openDatabase(registry, {
        readonly: true,
        fileMustExist: true,
        busyTimeoutMs: 1000,
      });
    // Pin status, definitions, text and graph edges to the same WAL snapshot.
    db.exec('BEGIN');
    const queries = new Queries(db, owner, projects, packageRegistry);
    let result;
    switch (name) {
      case 'deploy_code_find':
        result = queries.find(args);
        break;
      case 'deploy_code_symbol':
        result = queries.symbol(args);
        break;
      case 'deploy_code_project':
        result = await queries.project(args);
        break;
      case 'deploy_code_search':
        result = await queries.search(args);
        break;
      default:
        throw new Error('Unknown code index tool');
    }
    return { result, pending: queries.pending };
  } finally {
    packageRegistry?.close();
    db.close();
  }
}
