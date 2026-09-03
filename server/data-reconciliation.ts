import { createHash } from 'node:crypto';
import {
  copyFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { constants as sqliteConstants, DatabaseSync } from 'node:sqlite';
import Database from 'better-sqlite3';
import { getArtifact, putArtifactBytes, putArtifactFile } from './content-store.ts';
import {
  appendLocalFleetEvent,
  resolveLocalSiteId,
  sortableId,
  type DataSyncPolicy,
} from './multisite.ts';
import { loadOrCreateSiteIdentity, signSitePayload } from './site-identity.ts';
import { getSqlite } from './store.ts';

export type ConflictPolicy = 'collect' | 'prefer-home' | 'prefer-suitcase';
export type ConflictResolution = 'home' | 'suitcase' | 'keep-both';
export type EncodedSqliteValue =
  | { type: 'null' }
  | { type: 'text'; value: string }
  | { type: 'integer'; value: string }
  | { type: 'real'; value: number }
  | { type: 'blob'; value: string };
export type EncodedSqliteRow = Record<string, EncodedSqliteValue>;

export interface ReconciliationConflict {
  kind: 'sqlite-row' | 'file-path' | 'schema' | 'validation';
  logicalAddress: string;
  baseValue: unknown;
  homeValue: unknown;
  suitcaseValue: unknown;
  suggestedResolution: 'home' | 'suitcase' | 'keep-both' | 'manual';
  reason: string;
}

function conflictKey(conflict: Pick<ReconciliationConflict, 'kind' | 'logicalAddress'>): string {
  return `${conflict.kind}:${conflict.logicalAddress}`;
}

export interface FileManifestEntry {
  path: string;
  kind: 'file' | 'directory';
  digest?: string;
  byteSize: number;
  mode: number;
}

export interface FileManifest {
  formatVersion: 1;
  rootDigest: string;
  entries: Record<string, FileManifestEntry>;
}

export interface FileReconciliationResult {
  status: 'merged' | 'conflicted';
  manifest: FileManifest;
  conflicts: ReconciliationConflict[];
  conflictCopies: Array<{ originalPath: string; preservedPath: string; digest: string }>;
}

export interface SqliteReconciliationResult {
  status: 'merged' | 'conflicted' | 'blocked';
  outputPath?: string;
  schemaFingerprint?: string;
  conflicts: ReconciliationConflict[];
  integrityCheck?: 'ok';
  foreignKeyViolations?: number;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function portablePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function encodeValue(value: unknown): EncodedSqliteValue {
  if (value === null || value === undefined) return { type: 'null' };
  if (Buffer.isBuffer(value)) return { type: 'blob', value: value.toString('base64') };
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { type: 'integer', value: value.toString() };
    return { type: 'real', value };
  }
  return { type: 'text', value: String(value) };
}

function decodeValue(value: EncodedSqliteValue): null | string | number | bigint | Buffer {
  switch (value.type) {
    case 'null':
      return null;
    case 'blob':
      return Buffer.from(value.value, 'base64');
    case 'real':
      return value.value;
    case 'integer': {
      const integer = BigInt(value.value);
      return integer <= BigInt(Number.MAX_SAFE_INTEGER) &&
        integer >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(integer)
        : integer;
    }
    case 'text':
      return value.value;
  }
}

function sqliteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqliteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function threeWay<T>(
  base: T | undefined,
  home: T | undefined,
  suitcase: T | undefined,
): { value?: T; conflict: boolean } {
  if (valuesEqual(home, suitcase)) return { value: home, conflict: false };
  if (valuesEqual(home, base)) return { value: suitcase, conflict: false };
  if (valuesEqual(suitcase, base)) return { value: home, conflict: false };
  return { value: home, conflict: true };
}

/** Create a deterministic manifest without mutating the content store. */
export function createFileManifest(rootPath: string): FileManifest {
  const root = resolve(rootPath);
  const entries: Record<string, FileManifestEntry> = {};
  const queue = [root];
  let count = 0;
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (++count > 100_000) throw new Error('File manifest exceeds the 100,000-entry safety limit');
    const metadata = lstatSync(path);
    const logicalPath = portablePath(root, path);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`Unsupported special file in reconciliation manifest: ${logicalPath}`);
    }
    if (metadata.isDirectory()) {
      if (logicalPath) {
        entries[logicalPath] = {
          path: logicalPath,
          kind: 'directory',
          byteSize: 0,
          mode: metadata.mode & 0o777,
        };
      }
      const children = readdirSync(path).sort((left, right) => right.localeCompare(left));
      for (const child of children) queue.push(resolve(path, child));
      continue;
    }
    entries[logicalPath] = {
      path: logicalPath,
      kind: 'file',
      digest: `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`,
      byteSize: metadata.size,
      mode: metadata.mode & 0o777,
    };
  }
  return { formatVersion: 1, rootDigest: digest(entries), entries };
}

export async function createFileManifestAsync(rootPath: string): Promise<FileManifest> {
  const root = resolve(rootPath);
  const entries: Record<string, FileManifestEntry> = {};
  const queue = [root];
  let count = 0;
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (++count > 100_000) throw new Error('File manifest exceeds the 100,000-entry safety limit');
    const metadata = lstatSync(path);
    const logicalPath = portablePath(root, path);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`Unsupported special file in reconciliation manifest: ${logicalPath}`);
    }
    if (metadata.isDirectory()) {
      if (logicalPath) {
        entries[logicalPath] = {
          path: logicalPath,
          kind: 'directory',
          byteSize: 0,
          mode: metadata.mode & 0o777,
        };
      }
      const children = readdirSync(path).sort((left, right) => right.localeCompare(left));
      for (const child of children) queue.push(resolve(path, child));
      continue;
    }
    const artifact = await putArtifactFile(path, {
      type: 'file-blob',
      retentionClass: 'checkpoint',
    });
    entries[logicalPath] = {
      path: logicalPath,
      kind: 'file',
      digest: artifact.digest,
      byteSize: metadata.size,
      mode: metadata.mode & 0o777,
    };
  }
  return { formatVersion: 1, rootDigest: digest(entries), entries };
}

function emptyFileManifest(): FileManifest {
  return { formatVersion: 1, rootDigest: digest({}), entries: {} };
}

function conflictCopyPath(path: string, suitcaseSiteId: string, contentDigest: string): string {
  const suffix = suitcaseSiteId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32) || 'suitcase';
  const shortDigest = contentDigest.replace('sha256:', '').slice(0, 10);
  return `${path}.conflict-${suffix}-${shortDigest}`;
}

export function reconcileFileManifests(input: {
  base?: FileManifest;
  home: FileManifest;
  suitcase: FileManifest;
  suitcaseSiteId: string;
  conflictPolicy?: ConflictPolicy;
  conflictResolutions?: Readonly<Record<string, ConflictResolution>>;
}): FileReconciliationResult {
  const policy = input.conflictPolicy || 'collect';
  const base = input.base || emptyFileManifest();
  const entries: Record<string, FileManifestEntry> = {};
  const conflicts: ReconciliationConflict[] = [];
  const conflictCopies: FileReconciliationResult['conflictCopies'] = [];
  let unresolvedConflicts = 0;
  const paths = new Set([
    ...Object.keys(base.entries),
    ...Object.keys(input.home.entries),
    ...Object.keys(input.suitcase.entries),
  ]);

  for (const path of [...paths].sort()) {
    const baseEntry = base.entries[path];
    const homeEntry = input.home.entries[path];
    const suitcaseEntry = input.suitcase.entries[path];
    const merged = threeWay(baseEntry, homeEntry, suitcaseEntry);
    if (!merged.conflict) {
      if (merged.value) entries[path] = merged.value;
      continue;
    }

    const conflict: ReconciliationConflict = {
      kind: 'file-path',
      logicalAddress: path,
      baseValue: baseEntry || null,
      homeValue: homeEntry || null,
      suitcaseValue: suitcaseEntry || null,
      suggestedResolution: homeEntry && suitcaseEntry ? 'keep-both' : 'manual',
      reason: 'Both sites changed the same path differently from their shared base.',
    };
    conflicts.push(conflict);
    const resolution = input.conflictResolutions?.[conflictKey(conflict)];
    if (resolution === 'home' || (!resolution && policy === 'prefer-home')) {
      if (homeEntry) entries[path] = homeEntry;
      continue;
    }
    if (resolution === 'suitcase' || (!resolution && policy === 'prefer-suitcase')) {
      if (suitcaseEntry) entries[path] = suitcaseEntry;
      continue;
    }

    // Collect mode never overwrites ambiguous state. Home retains the
    // canonical path and a divergent suitcase file is materialized beside it.
    if (homeEntry) entries[path] = homeEntry;
    if (suitcaseEntry?.kind === 'file' && suitcaseEntry.digest) {
      const preservedPath = conflictCopyPath(path, input.suitcaseSiteId, suitcaseEntry.digest);
      entries[preservedPath] = { ...suitcaseEntry, path: preservedPath };
      conflictCopies.push({
        originalPath: path,
        preservedPath,
        digest: suitcaseEntry.digest,
      });
    }
    if (resolution !== 'keep-both') unresolvedConflicts += 1;
  }

  return {
    status: unresolvedConflicts > 0 ? 'conflicted' : 'merged',
    manifest: { formatVersion: 1, rootDigest: digest(entries), entries },
    conflicts,
    conflictCopies,
  };
}

export function materializeFileManifest(manifest: FileManifest, destinationPath: string): void {
  const destination = resolve(destinationPath);
  mkdirSync(destination, { recursive: true });
  for (const entry of Object.values(manifest.entries).sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const path = resolve(destination, entry.path);
    if (path !== destination && !path.startsWith(`${destination}${sep}`))
      throw new Error(`Manifest path escapes destination: ${entry.path}`);
    if (entry.kind === 'directory') {
      mkdirSync(path, { recursive: true, mode: entry.mode });
      continue;
    }
    if (!entry.digest) throw new Error(`File manifest entry is missing a digest: ${entry.path}`);
    const artifact = getArtifact(entry.digest);
    if (!artifact) throw new Error(`Required file blob is not materialized: ${entry.digest}`);
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(artifact.localPath, path);
  }
}

interface SqliteTableState {
  name: string;
  createSql: string;
  primaryKey: string[];
  insertColumns: string[];
  rows: Map<string, EncodedSqliteRow>;
}

interface SqliteState {
  schemaFingerprint: string;
  schemaRows: Array<{ type: string; name: string; tableName: string; sql: string }>;
  tables: Map<string, SqliteTableState>;
}

export interface SqliteChangesetArtifact {
  formatVersion: 1;
  schemaFingerprint: string;
  bytes: Uint8Array;
}

function readSqliteState(path: string): SqliteState {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  database.defaultSafeIntegers(true);
  try {
    database.pragma('query_only = ON');
    const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
      throw new Error(`${path} failed SQLite integrity_check`);
    const foreignKeys = database.pragma('foreign_key_check') as unknown[];
    if (foreignKeys.length > 0)
      throw new Error(`${path} has ${foreignKeys.length} foreign-key violation(s)`);
    const schemaRows = database
      .prepare(
        `SELECT type, name, tbl_name AS tableName, COALESCE(sql, '') AS sql
           FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name`,
      )
      .all() as Array<{ type: string; name: string; tableName: string; sql: string }>;
    if (
      schemaRows.some(
        (row) => row.type === 'table' && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql),
      )
    )
      throw new Error(`${path} has a virtual table without a rebuild adapter`);
    const tables = new Map<string, SqliteTableState>();
    for (const schema of schemaRows.filter((row) => row.type === 'table')) {
      const columns = database
        .prepare(`PRAGMA table_xinfo(${sqliteLiteral(schema.name)})`)
        .all() as Array<{
        name: string;
        type: string;
        notnull: bigint;
        pk: bigint;
        hidden: bigint;
      }>;
      const primaryKeyColumns = columns
        .filter((column) => column.pk > 0n)
        .sort((left, right) => Number(left.pk - right.pk));
      if (primaryKeyColumns.length === 0)
        throw new Error(`${path} table ${schema.name} has no primary key`);
      const tableList = database.pragma('table_list') as Array<{
        schema: string;
        name: string;
        wr: bigint;
        strict: bigint;
      }>;
      const tableMeta = tableList.find(
        (entry) => entry.schema === 'main' && entry.name === schema.name,
      );
      for (const column of primaryKeyColumns) {
        const inherentlyNotNull =
          column.notnull > 0n ||
          /^INTEGER$/i.test(column.type || '') ||
          Boolean(tableMeta?.wr) ||
          Boolean(tableMeta?.strict);
        if (!inherentlyNotNull)
          throw new Error(`${path} table ${schema.name} has a nullable primary key`);
      }
      const rows = new Map<string, EncodedSqliteRow>();
      const rawRows = database
        .prepare(`SELECT * FROM ${sqliteIdentifier(schema.name)}`)
        .all() as Array<Record<string, unknown>>;
      for (const rawRow of rawRows) {
        const row = Object.fromEntries(
          Object.entries(rawRow).map(([key, value]) => [key, encodeValue(value)]),
        ) as EncodedSqliteRow;
        const key = canonical(primaryKeyColumns.map((column) => row[column.name]));
        if (rows.has(key))
          throw new Error(`${path} table ${schema.name} has a duplicate primary key`);
        rows.set(key, row);
      }
      tables.set(schema.name, {
        name: schema.name,
        createSql: schema.sql,
        primaryKey: primaryKeyColumns.map((column) => column.name),
        insertColumns: columns
          .filter((column) => column.hidden === 0n)
          .map((column) => column.name),
        rows,
      });
    }
    return {
      schemaFingerprint: digest(schemaRows),
      schemaRows,
      tables,
    };
  } finally {
    database.close();
  }
}

function sqliteStateMatchesProjection(
  actual: SqliteState,
  base: SqliteState,
  branch: SqliteState,
  includedTables: ReadonlySet<string>,
): boolean {
  if (
    actual.schemaFingerprint !== base.schemaFingerprint ||
    branch.schemaFingerprint !== base.schemaFingerprint
  )
    return false;
  return (
    canonical(
      [...actual.tables.entries()].map(([table, state]) => [
        table,
        [...state.rows.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ]),
    ) ===
    canonical(
      [...base.tables.entries()].map(([table, state]) => [
        table,
        [
          ...(includedTables.has(table) ? branch.tables.get(table)!.rows : state.rows).entries(),
        ].sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
  );
}

/**
 * Produce the binary SQLite Session Extension changeset carried between sites.
 *
 * Applications do not need to use a deploy.local database library: the helper
 * opens a quiesced shared-base copy, attaches an official SQLite session, and
 * deterministically mutates that copy to the captured branch state. The session
 * therefore records the old values required for three-way conflict detection.
 */
export function createSqliteChangesetArtifact(
  basePath: string,
  branchPath: string,
  options: { includedTables?: readonly string[] } = {},
): SqliteChangesetArtifact {
  const base = readSqliteState(basePath);
  const branch = readSqliteState(branchPath);
  if (base.schemaFingerprint !== branch.schemaFingerprint) {
    throw new Error('SQLite changesets require an exact shared-base schema fingerprint');
  }
  const includedTables = new Set(options.includedTables ?? base.tables.keys());
  for (const table of includedTables) {
    if (!base.tables.has(table))
      throw new Error(`SQLite changeset profile names unknown table ${table}`);
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'deploy-sqlite-session-'));
  const workingPath = join(temporaryRoot, 'branch.sqlite');
  copyFileSync(basePath, workingPath);
  chmodSync(workingPath, 0o600);
  const database = new DatabaseSync(workingPath, {
    enableForeignKeyConstraints: false,
    readBigInts: true,
  });
  const session = database.createSession();
  try {
    database.exec('BEGIN IMMEDIATE');
    for (const [tableName, baseTable] of base.tables) {
      if (!includedTables.has(tableName)) continue;
      const branchTable = branch.tables.get(tableName)!;
      const keys = new Set([...baseTable.rows.keys(), ...branchTable.rows.keys()]);
      const primaryKeyWhere = baseTable.primaryKey
        .map((column) => `${sqliteIdentifier(column)} = ?`)
        .join(' AND ');
      const remove = database.prepare(
        `DELETE FROM ${sqliteIdentifier(tableName)} WHERE ${primaryKeyWhere}`,
      );
      const columnSql = baseTable.insertColumns.map(sqliteIdentifier).join(', ');
      const insert = database.prepare(
        `INSERT INTO ${sqliteIdentifier(tableName)} (${columnSql}) VALUES (${baseTable.insertColumns.map(() => '?').join(', ')})`,
      );
      const changedKeys = [...keys]
        .sort()
        .filter((key) => !valuesEqual(baseTable.rows.get(key), branchTable.rows.get(key)));
      // Remove every changed old row before inserting replacements so a valid
      // branch that swaps UNIQUE values can still be represented.
      for (const key of changedKeys) {
        const baseRow = baseTable.rows.get(key);
        if (baseRow) {
          remove.run(...baseTable.primaryKey.map((column) => decodeValue(baseRow[column]!)));
        }
      }
      for (const key of changedKeys) {
        const branchRow = branchTable.rows.get(key);
        if (branchRow) {
          insert.run(...baseTable.insertColumns.map((column) => decodeValue(branchRow[column]!)));
        }
      }
    }
    database.exec('COMMIT');
    const captured = readSqliteState(workingPath);
    if (!sqliteStateMatchesProjection(captured, base, branch, includedTables)) {
      throw new Error('SQLite session capture did not reproduce the admitted branch state');
    }
    const bytes = session.changeset();
    const verificationPath = join(temporaryRoot, 'verified.sqlite');
    copyFileSync(basePath, verificationPath);
    chmodSync(verificationPath, 0o600);
    const verification = new DatabaseSync(verificationPath, {
      enableForeignKeyConstraints: true,
      readBigInts: true,
    });
    try {
      if (
        !verification.applyChangeset(bytes, {
          onConflict: () => sqliteConstants.SQLITE_CHANGESET_ABORT,
        })
      ) {
        throw new Error(
          'SQLite could not replay this branch changeset losslessly; keep it local and use a custom adapter',
        );
      }
    } finally {
      verification.close();
    }
    if (
      !sqliteStateMatchesProjection(readSqliteState(verificationPath), base, branch, includedTables)
    ) {
      throw new Error('SQLite branch changeset replay did not reproduce the admitted branch state');
    }
    return {
      formatVersion: 1,
      schemaFingerprint: base.schemaFingerprint,
      bytes,
    };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The transaction may already have committed.
    }
    throw error;
  } finally {
    session.close();
    database.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/** Reconstruct a branch snapshot solely from its retained base and session changeset. */
export function materializeSqliteChangeset(input: {
  basePath: string;
  changesetPath: string;
  outputPath: string;
  expectedSchemaFingerprint?: string;
}): void {
  const output = resolve(input.outputPath);
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  copyFileSync(input.basePath, output);
  chmodSync(output, 0o600);
  const database = new DatabaseSync(output, {
    enableForeignKeyConstraints: true,
    readBigInts: true,
  });
  try {
    const applied = database.applyChangeset(readFileSync(input.changesetPath), {
      onConflict: () => sqliteConstants.SQLITE_CHANGESET_ABORT,
    });
    if (!applied) throw new Error('SQLite changeset application was aborted');
  } catch (error) {
    database.close();
    rmSync(output, { force: true });
    throw error;
  } finally {
    if (database.isOpen) database.close();
  }
  const state = readSqliteState(output);
  if (
    input.expectedSchemaFingerprint &&
    state.schemaFingerprint !== input.expectedSchemaFingerprint
  ) {
    rmSync(output, { force: true });
    throw new Error('Materialized SQLite changeset has an unexpected schema fingerprint');
  }
}

function serializeRow(row: EncodedSqliteRow | undefined): EncodedSqliteRow | null {
  return row || null;
}

export function reconcileSqliteDatabases(input: {
  basePath: string;
  homePath: string;
  suitcasePath: string;
  outputPath: string;
  /** Official Session Extension artifact from base to suitcase, when available. */
  sessionChangesetPath?: string;
  conflictPolicy?: ConflictPolicy;
  conflictResolutions?: Readonly<Record<string, ConflictResolution>>;
}): SqliteReconciliationResult {
  let base: SqliteState;
  let home: SqliteState;
  let suitcase: SqliteState;
  try {
    base = readSqliteState(input.basePath);
    home = readSqliteState(input.homePath);
    suitcase = readSqliteState(input.suitcasePath);
  } catch (error) {
    return {
      status: 'blocked',
      conflicts: [
        {
          kind: 'validation',
          logicalAddress: 'database',
          baseValue: null,
          homeValue: null,
          suitcaseValue: null,
          suggestedResolution: 'manual',
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  if (
    base.schemaFingerprint !== home.schemaFingerprint ||
    base.schemaFingerprint !== suitcase.schemaFingerprint
  ) {
    return {
      status: 'blocked',
      conflicts: [
        {
          kind: 'schema',
          logicalAddress: 'sqlite_schema',
          baseValue: base.schemaFingerprint,
          homeValue: home.schemaFingerprint,
          suitcaseValue: suitcase.schemaFingerprint,
          suggestedResolution: 'manual',
          reason: 'All branches must use the exact reconciliation-profile schema fingerprint.',
        },
      ],
    };
  }

  const policy = input.conflictPolicy || 'collect';
  const conflicts: ReconciliationConflict[] = [];
  let unresolvedConflicts = 0;
  const mergedTables = new Map<string, Map<string, EncodedSqliteRow>>();
  for (const [tableName, baseTable] of base.tables) {
    const homeTable = home.tables.get(tableName)!;
    const suitcaseTable = suitcase.tables.get(tableName)!;
    const rows = new Map<string, EncodedSqliteRow>();
    const keys = new Set([
      ...baseTable.rows.keys(),
      ...homeTable.rows.keys(),
      ...suitcaseTable.rows.keys(),
    ]);
    for (const key of [...keys].sort()) {
      const baseRow = baseTable.rows.get(key);
      const homeRow = homeTable.rows.get(key);
      const suitcaseRow = suitcaseTable.rows.get(key);
      const merged = threeWay(baseRow, homeRow, suitcaseRow);
      if (!merged.conflict) {
        if (merged.value) rows.set(key, merged.value);
        continue;
      }
      const conflict: ReconciliationConflict = {
        kind: 'sqlite-row',
        logicalAddress: `${tableName}:${key}`,
        baseValue: serializeRow(baseRow),
        homeValue: serializeRow(homeRow),
        suitcaseValue: serializeRow(suitcaseRow),
        suggestedResolution: 'manual',
        reason: 'Both sites changed the same primary-key row differently from their shared base.',
      };
      conflicts.push(conflict);
      const resolution = input.conflictResolutions?.[conflictKey(conflict)];
      if (resolution === 'keep-both') {
        unresolvedConflicts += 1;
        continue;
      }
      if (!resolution && policy === 'collect') unresolvedConflicts += 1;
      const chosen =
        resolution === 'suitcase' || (!resolution && policy === 'prefer-suitcase')
          ? suitcaseRow
          : homeRow;
      if (chosen) rows.set(key, chosen);
    }
    mergedTables.set(tableName, rows);
  }

  if (unresolvedConflicts > 0) {
    return {
      status: 'conflicted',
      schemaFingerprint: base.schemaFingerprint,
      conflicts,
    };
  }

  const output = resolve(input.outputPath);
  mkdirSync(dirname(output), { recursive: true });
  if (existsSync(output)) rmSync(output, { force: true });
  copyFileSync(input.homePath, output);
  chmodSync(output, 0o600);
  if (input.sessionChangesetPath && conflicts.length === 0) {
    const nativeDatabase = new DatabaseSync(output, {
      enableForeignKeyConstraints: true,
      readBigInts: true,
    });
    try {
      const applied = nativeDatabase.applyChangeset(readFileSync(input.sessionChangesetPath), {
        onConflict: () => sqliteConstants.SQLITE_CHANGESET_ABORT,
      });
      if (!applied) throw new Error('SQLite Session Extension aborted the staged merge');
    } catch (error) {
      nativeDatabase.close();
      rmSync(output, { force: true });
      return {
        status: 'blocked',
        schemaFingerprint: base.schemaFingerprint,
        conflicts: [
          {
            kind: 'validation',
            logicalAddress: 'sqlite-changeset',
            baseValue: null,
            homeValue: null,
            suitcaseValue: null,
            suggestedResolution: 'manual',
            reason: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    } finally {
      if (nativeDatabase.isOpen) nativeDatabase.close();
    }
  }
  const database = new Database(output);
  database.defaultSafeIntegers(true);
  try {
    database.pragma('foreign_keys = ON');
    database.pragma('defer_foreign_keys = ON');
    if (!input.sessionChangesetPath || conflicts.length > 0) {
      const apply = database.transaction(() => {
        for (const [tableName, rows] of mergedTables) {
          const table = home.tables.get(tableName)!;
          database.prepare(`DELETE FROM ${sqliteIdentifier(tableName)}`).run();
          if (rows.size === 0) continue;
          const columnSql = table.insertColumns.map(sqliteIdentifier).join(', ');
          const placeholders = table.insertColumns.map(() => '?').join(', ');
          const insert = database.prepare(
            `INSERT INTO ${sqliteIdentifier(tableName)} (${columnSql}) VALUES (${placeholders})`,
          );
          for (const row of rows.values()) {
            insert.run(...table.insertColumns.map((column) => decodeValue(row[column]!)));
          }
        }
      });
      apply.immediate();
    }
    const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const foreignKeys = database.pragma('foreign_key_check') as unknown[];
    if (
      integrity.length !== 1 ||
      integrity[0]?.integrity_check !== 'ok' ||
      foreignKeys.length > 0
    ) {
      database.close();
      rmSync(output, { force: true });
      return {
        status: 'blocked',
        schemaFingerprint: base.schemaFingerprint,
        conflicts: [
          ...conflicts,
          {
            kind: 'validation',
            logicalAddress: 'merged-database',
            baseValue: null,
            homeValue: integrity,
            suitcaseValue: foreignKeys,
            suggestedResolution: 'manual',
            reason: 'The staged merge failed integrity or foreign-key validation.',
          },
        ],
      };
    }
  } catch (error) {
    database.close();
    rmSync(output, { force: true });
    return {
      status: 'blocked',
      schemaFingerprint: base.schemaFingerprint,
      conflicts: [
        ...conflicts,
        {
          kind: 'validation',
          logicalAddress: 'merged-database',
          baseValue: null,
          homeValue: null,
          suitcaseValue: null,
          suggestedResolution: 'manual',
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  } finally {
    if (database.open) database.close();
  }
  try {
    const staged = readSqliteState(output);
    const expected = canonical(
      [...mergedTables.entries()].map(([table, rows]) => [
        table,
        [...rows.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ]),
    );
    const actual = canonical(
      [...staged.tables.entries()].map(([table, state]) => [
        table,
        [...state.rows.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ]),
    );
    if (staged.schemaFingerprint !== base.schemaFingerprint || actual !== expected) {
      rmSync(output, { force: true });
      return {
        status: 'blocked',
        schemaFingerprint: base.schemaFingerprint,
        conflicts: [
          ...conflicts,
          {
            kind: 'validation',
            logicalAddress: 'merged-database',
            baseValue: expected,
            homeValue: actual,
            suitcaseValue: null,
            suggestedResolution: 'manual',
            reason:
              'The staged database does not exactly match the intended merged rows after triggers and constraints ran.',
          },
        ],
      };
    }
  } catch (error) {
    rmSync(output, { force: true });
    return {
      status: 'blocked',
      schemaFingerprint: base.schemaFingerprint,
      conflicts: [
        ...conflicts,
        {
          kind: 'validation',
          logicalAddress: 'merged-database',
          baseValue: null,
          homeValue: null,
          suitcaseValue: null,
          suggestedResolution: 'manual',
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  return {
    status: 'merged',
    outputPath: output,
    schemaFingerprint: base.schemaFingerprint,
    conflicts,
    integrityCheck: 'ok',
    foreignKeyViolations: 0,
  };
}

export function setDataSyncPolicy(input: {
  appId: string;
  siteId?: string;
  policy: DataSyncPolicy;
  conflictPolicy?: ConflictPolicy;
  acknowledgedRisks?: string[];
  updatedBy: string;
}): void {
  const now = new Date().toISOString();
  getSqlite()!
    .prepare(
      `INSERT INTO data_sync_policies
        (app_id, site_id, policy, conflict_policy, acknowledged_risks, revision, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(app_id, site_id) DO UPDATE SET
         policy = excluded.policy,
         conflict_policy = excluded.conflict_policy,
         acknowledged_risks = excluded.acknowledged_risks,
         revision = data_sync_policies.revision + 1,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.appId,
      input.siteId || '',
      input.policy,
      input.conflictPolicy || 'collect',
      JSON.stringify(input.acknowledgedRisks || []),
      input.updatedBy,
      now,
    );
  if (input.siteId) {
    getSqlite()!
      .prepare(
        'UPDATE app_replicas SET sync_policy = ?, updated_at = ? WHERE app_id = ? AND site_id = ?',
      )
      .run(input.policy, now, input.appId, input.siteId);
  }
  appendLocalFleetEvent({
    originSiteId: resolveLocalSiteId(),
    appId: input.appId,
    actor: input.updatedBy,
    operation: 'application.data.policy.updated',
    payload: {
      siteId: input.siteId || '',
      policy: input.policy,
      conflictPolicy: input.conflictPolicy || 'collect',
      acknowledgedRisks: input.acknowledgedRisks || [],
    },
  });
}

export function getDataSyncPolicy(
  appId: string,
  siteId?: string,
): {
  policy: DataSyncPolicy;
  conflictPolicy: ConflictPolicy;
  source: 'site' | 'application' | 'safe-default';
} {
  const sqlite = getSqlite()!;
  const sitePolicy = siteId
    ? (sqlite
        .prepare(
          'SELECT policy, conflict_policy FROM data_sync_policies WHERE app_id = ? AND site_id = ?',
        )
        .get(appId, siteId) as
        | { policy: DataSyncPolicy; conflict_policy: ConflictPolicy }
        | undefined)
    : undefined;
  if (sitePolicy)
    return {
      policy: sitePolicy.policy,
      conflictPolicy: sitePolicy.conflict_policy,
      source: 'site',
    };
  const applicationPolicy = sqlite
    .prepare(
      "SELECT policy, conflict_policy FROM data_sync_policies WHERE app_id = ? AND site_id = ''",
    )
    .get(appId) as { policy: DataSyncPolicy; conflict_policy: ConflictPolicy } | undefined;
  if (applicationPolicy)
    return {
      policy: applicationPolicy.policy,
      conflictPolicy: applicationPolicy.conflict_policy,
      source: 'application',
    };
  return { policy: 'none', conflictPolicy: 'collect', source: 'safe-default' };
}

export function assertSyncAllowed(appId: string, siteId: string, explicitManual = false): void {
  const policy = getDataSyncPolicy(appId, siteId);
  if (policy.policy === 'none')
    throw new Error('Data sync is disabled for this application replica');
  if (policy.policy === 'manual' && !explicitManual)
    throw new Error('Data sync is pending an explicit Sync now action');
}

export async function createDataCheckpoint(input: {
  appId: string;
  originSiteId: string;
  parentId?: string;
  databasePath?: string;
  filesRoot?: string;
  schemaFingerprint?: string;
  profileVersion?: string;
  actor?: string;
  emitEvent?: boolean;
  /** Allows an explicit empty lineage anchor for a validated stateless replica. */
  allowEmpty?: boolean;
}): Promise<{ id: string; manifestDigest: string }> {
  if (!input.databasePath && !input.filesRoot && !input.allowEmpty)
    throw new Error('A checkpoint requires a database or file snapshot');
  const sqlite = getSqlite()!;
  const previous = sqlite
    .prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM data_checkpoints WHERE app_id = ?')
    .get(input.appId) as { sequence: number };
  const sequence = previous.sequence + 1;
  const databaseArtifact = input.databasePath
    ? await putArtifactFile(input.databasePath, {
        type: 'sqlite-checkpoint',
        retentionClass: 'checkpoint',
      })
    : undefined;
  const fileManifest = input.filesRoot ? await createFileManifestAsync(input.filesRoot) : undefined;
  const fileManifestArtifact = fileManifest
    ? putArtifactBytes(Buffer.from(canonical(fileManifest)), {
        type: 'file-manifest',
        mediaType: 'application/vnd.deploy.file-manifest+json',
        retentionClass: 'checkpoint',
      })
    : undefined;
  const checkpointManifest = {
    formatVersion: 1,
    appId: input.appId,
    originSiteId: input.originSiteId,
    parentId: input.parentId || null,
    sequence,
    databaseArtifactDigest: databaseArtifact?.digest || null,
    filesystemArtifactDigest: fileManifestArtifact?.digest || null,
    schemaFingerprint: input.schemaFingerprint || null,
    profileVersion: input.profileVersion || null,
  };
  const manifestArtifact = putArtifactBytes(Buffer.from(canonical(checkpointManifest)), {
    type: 'data-checkpoint-manifest',
    mediaType: 'application/vnd.deploy.checkpoint+json',
    retentionClass: 'checkpoint',
  });
  const id = sortableId('checkpoint');
  const now = new Date().toISOString();
  const save = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO data_checkpoints
          (id, app_id, parent_id, origin_site_id, sequence, database_artifact_digest,
           filesystem_artifact_digest, manifest_artifact_digest, schema_fingerprint,
           profile_version, verification_status, acknowledgements, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', '{}', ?)`,
      )
      .run(
        id,
        input.appId,
        input.parentId || null,
        input.originSiteId,
        sequence,
        databaseArtifact?.digest || null,
        fileManifestArtifact?.digest || null,
        manifestArtifact.digest,
        input.schemaFingerprint || null,
        input.profileVersion || null,
        now,
      );
    if (fileManifest) {
      const insert = sqlite.prepare(
        `INSERT INTO blob_references
          (app_id, logical_path, checkpoint_id, digest, metadata, marker, conflict_state)
         VALUES (?, ?, ?, ?, ?, 'present', NULL)`,
      );
      for (const entry of Object.values(fileManifest.entries)) {
        insert.run(
          input.appId,
          entry.path,
          id,
          entry.digest || null,
          JSON.stringify({ kind: entry.kind, byteSize: entry.byteSize, mode: entry.mode }),
        );
      }
    }
  });
  save.immediate();
  if (input.emitEvent !== false) {
    appendLocalFleetEvent({
      originSiteId: input.originSiteId,
      appId: input.appId,
      actor: input.actor || `system@${input.originSiteId}`,
      operation: 'data.checkpoint.created',
      payload: {
        checkpointId: id,
        parentId: input.parentId || null,
        sequence,
        databaseArtifactDigest: databaseArtifact?.digest || null,
        filesystemArtifactDigest: fileManifestArtifact?.digest || null,
        manifestArtifactDigest: manifestArtifact.digest,
        schemaFingerprint: input.schemaFingerprint || null,
        profileVersion: input.profileVersion || null,
      },
      artifactDigests: [
        manifestArtifact.digest,
        ...(databaseArtifact ? [databaseArtifact.digest] : []),
        ...(fileManifestArtifact ? [fileManifestArtifact.digest] : []),
        ...Object.values(fileManifest?.entries || {})
          .map((entry) => entry.digest)
          .filter((value): value is string => Boolean(value)),
      ],
    });
  }
  return { id, manifestDigest: manifestArtifact.digest };
}

export function recordReconciliationConflicts(input: {
  appId: string;
  changesetId?: string;
  conflicts: ReconciliationConflict[];
}): string[] {
  const sqlite = getSqlite()!;
  const ids: string[] = [];
  const insert = sqlite.prepare(
    `INSERT INTO data_conflicts
      (id, app_id, changeset_id, kind, logical_address, base_value, home_value,
       suitcase_value, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  );
  const save = sqlite.transaction(() => {
    for (const conflict of input.conflicts) {
      const id = sortableId('conflict');
      ids.push(id);
      insert.run(
        id,
        input.appId,
        input.changesetId || null,
        conflict.kind,
        conflict.logicalAddress,
        JSON.stringify(conflict.baseValue),
        JSON.stringify(conflict.homeValue),
        JSON.stringify(conflict.suitcaseValue),
        new Date().toISOString(),
      );
    }
  });
  save.immediate();
  return ids;
}

export function resolveDataConflict(input: {
  conflictId: string;
  resolution: 'home' | 'suitcase' | 'keep-both' | 'custom';
  resolvedBy: string;
}): {
  appId: string;
  changesetId: string | null;
  originSiteId: string | null;
  readyToReconcile: boolean;
} {
  if (input.resolution === 'custom') {
    throw new Error(
      'Custom conflict repair requires a new validated branch; choose Home, Suitcase, or keep both',
    );
  }
  const sqlite = getSqlite()!;
  const conflict = sqlite
    .prepare('SELECT app_id, changeset_id, kind FROM data_conflicts WHERE id = ? AND status = ?')
    .get(input.conflictId, 'open') as
    | { app_id: string; changeset_id: string | null; kind: string }
    | undefined;
  if (!conflict) throw new Error('Open data conflict not found');
  if (conflict.kind === 'schema' || conflict.kind === 'validation') {
    throw new Error(
      'Schema and validation conflicts require a new branch that passes portability validation',
    );
  }
  if (input.resolution === 'keep-both' && conflict.kind !== 'file-path') {
    throw new Error('Keep both is available only for uploaded-file path conflicts');
  }
  const changesetOrigin = conflict.changeset_id
    ? (
        sqlite
          .prepare('SELECT origin_site_id FROM data_changesets WHERE id = ?')
          .get(conflict.changeset_id) as { origin_site_id: string } | undefined
      )?.origin_site_id
    : undefined;
  const storedResolution =
    changesetOrigin === resolveLocalSiteId() && input.resolution === 'home'
      ? 'suitcase'
      : changesetOrigin === resolveLocalSiteId() && input.resolution === 'suitcase'
        ? 'home'
        : input.resolution;
  const result = sqlite
    .prepare(
      `UPDATE data_conflicts
          SET resolution = ?, status = 'resolved', resolved_at = ?, resolved_by = ?
        WHERE id = ? AND status = 'open'`,
    )
    .run(storedResolution, new Date().toISOString(), input.resolvedBy, input.conflictId);
  if (result.changes === 0) throw new Error('Open data conflict not found');
  const remaining = conflict.changeset_id
    ? (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM data_conflicts
              WHERE changeset_id = ? AND status = 'open'`,
          )
          .get(conflict.changeset_id) as { count: number }
      ).count
    : 0;
  let originSiteId: string | null = null;
  if (conflict.changeset_id && remaining === 0) {
    originSiteId = changesetOrigin || null;
    sqlite
      .prepare(
        `UPDATE data_changesets SET status = 'pending', conflict_report = NULL, verified_at = NULL
          WHERE id = ? AND status IN ('conflicted', 'blocked')`,
      )
      .run(conflict.changeset_id);
  }
  appendLocalFleetEvent({
    originSiteId: resolveLocalSiteId(),
    appId: conflict!.app_id,
    actor: input.resolvedBy,
    operation: 'data.conflict.resolved',
    payload: { conflictId: input.conflictId, resolution: input.resolution },
  });
  return {
    appId: conflict.app_id,
    changesetId: conflict.changeset_id,
    originSiteId,
    readyToReconcile: Boolean(conflict.changeset_id && remaining === 0 && originSiteId),
  };
}

export function loadFileManifestArtifact(manifestDigest: string): FileManifest {
  const artifact = getArtifact(manifestDigest);
  if (!artifact) throw new Error(`File manifest is not materialized: ${manifestDigest}`);
  const parsed = JSON.parse(readFileSync(artifact.localPath, 'utf8')) as FileManifest;
  if (parsed.formatVersion !== 1 || digest(parsed.entries) !== parsed.rootDigest)
    throw new Error('File manifest digest or format is invalid');
  return parsed;
}

export function checkpointStats(checkpointId: string): {
  logicalBytes: number;
  files: number;
  blobs: number;
} {
  const row = getSqlite()!
    .prepare(
      `SELECT COUNT(*) AS files,
              COUNT(DISTINCT digest) AS blobs,
              COALESCE(SUM(CAST(json_extract(metadata, '$.byteSize') AS INTEGER)), 0) AS bytes
         FROM blob_references WHERE checkpoint_id = ? AND marker = 'present'`,
    )
    .get(checkpointId) as { files: number; blobs: number; bytes: number };
  return { logicalBytes: row.bytes, files: row.files, blobs: row.blobs };
}

export async function createDataChangeset(input: {
  appId: string;
  originSiteId: string;
  baseCheckpointId: string;
  databasePath?: string;
  /** Resource-relative identity (for example `data/app.sqlite`) for profile filtering. */
  databaseLogicalPath?: string;
  filesRoot?: string;
  schemaFingerprint?: string;
  explicitManual?: boolean;
  actor?: string;
  emitEvent?: boolean;
}): Promise<{ id: string; authenticatedDigest: string }> {
  assertSyncAllowed(input.appId, input.originSiteId, input.explicitManual);
  const sqlite = getSqlite()!;
  const base = sqlite
    .prepare(
      `SELECT id, app_id, verification_status, database_artifact_digest, schema_fingerprint,
              profile_version
         FROM data_checkpoints
        WHERE id = ? AND app_id = ?`,
    )
    .get(input.baseCheckpointId, input.appId) as
    | {
        id: string;
        app_id: string;
        verification_status: string;
        database_artifact_digest: string | null;
        schema_fingerprint: string | null;
        profile_version: string | null;
      }
    | undefined;
  if (!base || base.verification_status !== 'verified')
    throw new Error('Changesets require a verified retained base checkpoint');
  if (!input.databasePath && !input.filesRoot)
    throw new Error('A changeset requires a database or file branch snapshot');
  let databaseArtifact: ReturnType<typeof putArtifactBytes> | undefined;
  let capturedSchemaFingerprint: string | undefined;
  if (input.databasePath) {
    if (!base.database_artifact_digest) {
      throw new Error('A SQLite changeset requires a database artifact in its shared base');
    }
    const baseArtifact = getArtifact(base.database_artifact_digest);
    if (!baseArtifact) {
      throw new Error(`Shared-base database is not materialized: ${base.database_artifact_digest}`);
    }
    const profile = base.profile_version
      ? (sqlite
          .prepare(
            `SELECT sqlite_files, eligible_tables
               FROM data_reconciliation_profiles
              WHERE app_id = ? AND (id = ? OR version = ?)
              ORDER BY created_at DESC LIMIT 1`,
          )
          .get(input.appId, base.profile_version, base.profile_version) as
          | { sqlite_files: string; eligible_tables: string }
          | undefined)
      : undefined;
    let includedTables: string[] | undefined;
    if (profile) {
      const sqliteFiles = JSON.parse(profile.sqlite_files) as Array<{
        resource: string;
        relativePath: string;
      }>;
      const logicalPath =
        input.databaseLogicalPath ||
        (sqliteFiles.length === 1
          ? `${sqliteFiles[0]!.resource}/${sqliteFiles[0]!.relativePath}`
          : undefined);
      if (!logicalPath) {
        throw new Error(
          'A reconciliation profile with multiple SQLite files requires databaseLogicalPath',
        );
      }
      includedTables = (
        JSON.parse(profile.eligible_tables) as Array<{ file: string; table: string }>
      )
        .filter((table) => table.file === logicalPath)
        .map((table) => table.table);
    }
    const changeset = createSqliteChangesetArtifact(baseArtifact.localPath, input.databasePath, {
      includedTables,
    });
    capturedSchemaFingerprint = changeset.schemaFingerprint;
    if (
      input.schemaFingerprint &&
      input.schemaFingerprint !== capturedSchemaFingerprint &&
      input.schemaFingerprint !== base.schema_fingerprint
    ) {
      throw new Error('Declared SQLite schema fingerprint does not match the captured branch');
    }
    databaseArtifact = putArtifactBytes(Buffer.from(changeset.bytes), {
      type: 'sqlite-session-changeset',
      mediaType: 'application/vnd.sqlite3.changeset',
      retentionClass: 'checkpoint',
    });
  }
  const fileManifest = input.filesRoot ? await createFileManifestAsync(input.filesRoot) : undefined;
  const fileArtifact = fileManifest
    ? putArtifactBytes(Buffer.from(canonical(fileManifest)), {
        type: 'file-branch-manifest',
        mediaType: 'application/vnd.deploy.file-manifest+json',
        retentionClass: 'checkpoint',
      })
    : undefined;
  const branchManifest = {
    formatVersion: 1,
    appId: input.appId,
    originSiteId: input.originSiteId,
    baseCheckpointId: input.baseCheckpointId,
    schemaFingerprint: capturedSchemaFingerprint || input.schemaFingerprint || null,
    databaseChangesetArtifactDigest: databaseArtifact?.digest || null,
    fileManifestDigest: fileArtifact?.digest || null,
  };
  const branchArtifact = putArtifactBytes(Buffer.from(canonical(branchManifest)), {
    type: 'data-changeset-manifest',
    mediaType: 'application/vnd.deploy.changeset+json',
    retentionClass: 'checkpoint',
  });
  const signature = signSitePayload(
    loadOrCreateSiteIdentity(input.originSiteId),
    canonical(branchManifest),
  );
  const id = sortableId('changeset');
  sqlite
    .prepare(
      `INSERT INTO data_changesets
        (id, app_id, origin_site_id, base_checkpoint_id, branch_manifest_digest,
         schema_fingerprint, database_artifact_digest, file_delta_artifact_digest,
         authenticated_digest, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      id,
      input.appId,
      input.originSiteId,
      input.baseCheckpointId,
      branchArtifact.digest,
      capturedSchemaFingerprint || input.schemaFingerprint || null,
      databaseArtifact?.digest || null,
      fileArtifact?.digest || null,
      signature,
      new Date().toISOString(),
    );
  sqlite
    .prepare(
      `UPDATE app_replicas
          SET pending_changesets = pending_changesets + 1, branch_checkpoint_id = ?, updated_at = ?
        WHERE app_id = ? AND site_id = ?`,
    )
    .run(input.baseCheckpointId, new Date().toISOString(), input.appId, input.originSiteId);
  if (input.emitEvent !== false) {
    appendLocalFleetEvent({
      originSiteId: input.originSiteId,
      appId: input.appId,
      actor: input.actor || `system@${input.originSiteId}`,
      operation: 'data.changeset.created',
      payload: {
        changesetId: id,
        baseCheckpointId: input.baseCheckpointId,
        branchManifestDigest: branchArtifact.digest,
        schemaFingerprint: capturedSchemaFingerprint || input.schemaFingerprint || null,
        databaseChangesetArtifactDigest: databaseArtifact?.digest || null,
        // Wire compatibility: the storage column predates the binary session format.
        databaseArtifactDigest: databaseArtifact?.digest || null,
        fileDeltaArtifactDigest: fileArtifact?.digest || null,
        branchAuthenticatedDigest: signature,
      },
      artifactDigests: [
        branchArtifact.digest,
        ...(databaseArtifact ? [databaseArtifact.digest] : []),
        ...(fileArtifact ? [fileArtifact.digest] : []),
        ...Object.values(fileManifest?.entries || {})
          .map((entry) => entry.digest)
          .filter((value): value is string => Boolean(value)),
      ],
    });
  }
  return { id, authenticatedDigest: signature };
}

function checkpointRecord(checkpointId: string, appId: string): Record<string, unknown> {
  const row = getSqlite()!
    .prepare(
      `SELECT * FROM data_checkpoints
        WHERE id = ? AND app_id = ? AND verification_status = 'verified'`,
    )
    .get(checkpointId, appId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Verified checkpoint not found: ${checkpointId}`);
  return row;
}

function artifactPathFor(digestValue: unknown, label: string): string | undefined {
  if (!digestValue) return undefined;
  const artifact = getArtifact(String(digestValue));
  if (!artifact) throw new Error(`${label} is not materialized: ${String(digestValue)}`);
  return artifact.localPath;
}

/**
 * Apply one authenticated branch to staging from its retained base and the
 * latest merged checkpoint. A checkpoint is published only after every
 * database/file validation succeeds and no collect-mode conflict remains.
 */
export async function applyDataChangeset(input: {
  changesetId: string;
  currentCheckpointId: string;
  coordinatorSiteId: string;
  stagingDatabasePath?: string;
  stagingFilesPath?: string;
  conflictPolicy?: ConflictPolicy;
}): Promise<
  | { status: 'merged'; checkpointId: string }
  | { status: 'conflicted' | 'blocked'; conflictIds: string[] }
> {
  const sqlite = getSqlite()!;
  const changeset = sqlite
    .prepare('SELECT * FROM data_changesets WHERE id = ?')
    .get(input.changesetId) as Record<string, unknown> | undefined;
  if (!changeset) throw new Error('Changeset not found');
  if (changeset.status === 'applied' && changeset.resulting_checkpoint_id)
    return { status: 'merged', checkpointId: String(changeset.resulting_checkpoint_id) };
  if (changeset.status === 'conflicted' || changeset.status === 'blocked') {
    const existing = sqlite
      .prepare('SELECT id FROM data_conflicts WHERE changeset_id = ? AND status = ?')
      .all(input.changesetId, 'open') as Array<{ id: string }>;
    return {
      status: String(changeset.status) as 'conflicted' | 'blocked',
      conflictIds: existing.map((row) => row.id),
    };
  }
  const appId = String(changeset.app_id);
  const originSiteId = String(changeset.origin_site_id);
  assertSyncAllowed(appId, originSiteId, true);
  const base = checkpointRecord(String(changeset.base_checkpoint_id), appId);
  const current = checkpointRecord(input.currentCheckpointId, appId);
  const policy = input.conflictPolicy || getDataSyncPolicy(appId, originSiteId).conflictPolicy;
  const conflictResolutions = Object.fromEntries(
    (
      sqlite
        .prepare(
          `SELECT kind, logical_address, resolution FROM data_conflicts
            WHERE changeset_id = ? AND status = 'resolved' AND resolution IS NOT NULL`,
        )
        .all(input.changesetId) as Array<{
        kind: ReconciliationConflict['kind'];
        logical_address: string;
        resolution: ConflictResolution;
      }>
    ).map((conflict) => [`${conflict.kind}:${conflict.logical_address}`, conflict.resolution]),
  );
  const conflicts: ReconciliationConflict[] = [];
  let unresolvedConflicts = false;
  let databaseMergedPath: string | undefined;
  let filesMergedPath: string | undefined;

  const databaseChangesetPath = artifactPathFor(
    changeset.database_artifact_digest,
    'SQLite session changeset artifact',
  );
  if (databaseChangesetPath) {
    const basePath = artifactPathFor(base.database_artifact_digest, 'Base database checkpoint');
    const homePath = artifactPathFor(
      current.database_artifact_digest,
      'Current database checkpoint',
    );
    if (!basePath || !homePath || !input.stagingDatabasePath)
      throw new Error('Database reconciliation requires base/current artifacts and a staging path');
    const branchPath = `${input.stagingDatabasePath}.incoming-${input.changesetId}.sqlite`;
    let result: SqliteReconciliationResult;
    try {
      materializeSqliteChangeset({
        basePath,
        changesetPath: databaseChangesetPath,
        outputPath: branchPath,
        expectedSchemaFingerprint: changeset.schema_fingerprint
          ? String(changeset.schema_fingerprint)
          : undefined,
      });
      result = reconcileSqliteDatabases({
        basePath,
        homePath,
        suitcasePath: branchPath,
        outputPath: input.stagingDatabasePath,
        sessionChangesetPath: databaseChangesetPath,
        conflictPolicy: policy,
        conflictResolutions,
      });
    } catch (error) {
      result = {
        status: 'blocked',
        conflicts: [
          {
            kind: 'validation',
            logicalAddress: 'sqlite-changeset',
            baseValue: null,
            homeValue: null,
            suitcaseValue: null,
            suggestedResolution: 'manual',
            reason: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    } finally {
      rmSync(branchPath, { force: true });
    }
    conflicts.push(...result.conflicts);
    if (result.status === 'blocked') {
      const conflictIds = recordReconciliationConflicts({
        appId,
        changesetId: input.changesetId,
        conflicts,
      });
      sqlite
        .prepare(
          `UPDATE data_changesets SET status = 'blocked', conflict_report = ?, verified_at = ?
            WHERE id = ?`,
        )
        .run(JSON.stringify(conflicts), new Date().toISOString(), input.changesetId);
      return { status: 'blocked', conflictIds };
    }
    if (result.status === 'conflicted') unresolvedConflicts = true;
    if (result.status === 'merged') databaseMergedPath = result.outputPath;
  }

  if (changeset.file_delta_artifact_digest) {
    if (!input.stagingFilesPath) throw new Error('File reconciliation requires a staging path');
    const baseDigest = base.filesystem_artifact_digest;
    const homeDigest = current.filesystem_artifact_digest;
    const suitcaseDigest = changeset.file_delta_artifact_digest;
    if (!baseDigest || !homeDigest)
      throw new Error('File reconciliation requires base and current manifests');
    const result = reconcileFileManifests({
      base: loadFileManifestArtifact(String(baseDigest)),
      home: loadFileManifestArtifact(String(homeDigest)),
      suitcase: loadFileManifestArtifact(String(suitcaseDigest)),
      suitcaseSiteId: originSiteId,
      conflictPolicy: policy,
      conflictResolutions,
    });
    conflicts.push(...result.conflicts);
    if (result.status === 'conflicted') unresolvedConflicts = true;
    if (result.status === 'merged') {
      if (existsSync(input.stagingFilesPath) && readdirSync(input.stagingFilesPath).length > 0)
        throw new Error('File reconciliation staging directory must be empty');
      materializeFileManifest(result.manifest, input.stagingFilesPath);
      filesMergedPath = input.stagingFilesPath;
    }
  }

  if (unresolvedConflicts) {
    const conflictIds = recordReconciliationConflicts({
      appId,
      changesetId: input.changesetId,
      conflicts,
    });
    sqlite
      .prepare(
        `UPDATE data_changesets SET status = 'conflicted', conflict_report = ?, verified_at = ?
          WHERE id = ?`,
      )
      .run(JSON.stringify(conflicts), new Date().toISOString(), input.changesetId);
    return { status: 'conflicted', conflictIds };
  }

  const checkpoint = await createDataCheckpoint({
    appId,
    originSiteId: input.coordinatorSiteId,
    parentId: input.currentCheckpointId,
    databasePath: databaseMergedPath,
    filesRoot: filesMergedPath,
    schemaFingerprint: changeset.schema_fingerprint
      ? String(changeset.schema_fingerprint)
      : current.schema_fingerprint
        ? String(current.schema_fingerprint)
        : undefined,
    profileVersion: current.profile_version ? String(current.profile_version) : undefined,
  });
  const commit = sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE data_changesets
            SET status = 'applied', conflict_report = ?, resulting_checkpoint_id = ?, verified_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(JSON.stringify(conflicts), checkpoint.id, new Date().toISOString(), input.changesetId);
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `UPDATE app_replicas SET base_checkpoint_id = ?, branch_checkpoint_id = NULL,
                pending_changesets = MAX(0, pending_changesets - 1), updated_at = ?
          WHERE app_id = ? AND site_id IN (?, ?)`,
      )
      .run(checkpoint.id, now, appId, input.coordinatorSiteId, originSiteId);
  });
  commit.immediate();
  return { status: 'merged', checkpointId: checkpoint.id };
}

export function acknowledgeCheckpoint(input: {
  appId: string;
  siteId: string;
  checkpointId: string;
  actor?: string;
  emitEvent?: boolean;
}): void {
  checkpointRecord(input.checkpointId, input.appId);
  const result = getSqlite()!
    .prepare(
      `UPDATE app_replicas SET base_checkpoint_id = ?, branch_checkpoint_id = NULL,
              pending_changesets = 0, updated_at = ?
        WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
    )
    .run(input.checkpointId, new Date().toISOString(), input.appId, input.siteId);
  if (result.changes !== 1) throw new Error('Active application replica not found');
  if (input.emitEvent !== false) {
    appendLocalFleetEvent({
      originSiteId: input.siteId,
      appId: input.appId,
      actor: input.actor || `system@${input.siteId}`,
      operation: 'data.checkpoint.adopted',
      payload: { checkpointId: input.checkpointId, siteId: input.siteId },
    });
  }
}

export function listCheckpointRetentionBlockers(appId: string): Array<{
  checkpointId: string;
  waitingForSiteIds: string[];
}> {
  const sqlite = getSqlite()!;
  const checkpoints = sqlite
    .prepare('SELECT id, sequence FROM data_checkpoints WHERE app_id = ? ORDER BY sequence')
    .all(appId) as Array<{ id: string; sequence: number }>;
  const replicas = sqlite
    .prepare(
      `SELECT r.site_id, r.base_checkpoint_id
         FROM app_replicas r JOIN sites s ON s.id = r.site_id
        WHERE r.app_id = ? AND r.removed_at IS NULL AND s.revoked_at IS NULL
          AND r.shared_lineage = 1`,
    )
    .all(appId) as Array<{ site_id: string; base_checkpoint_id: string | null }>;
  const sequenceById = new Map(
    checkpoints.map((checkpoint) => [checkpoint.id, checkpoint.sequence]),
  );
  return checkpoints.map((checkpoint) => ({
    checkpointId: checkpoint.id,
    waitingForSiteIds: replicas
      .filter(
        (replica) =>
          !replica.base_checkpoint_id ||
          (sequenceById.get(replica.base_checkpoint_id) || 0) <= checkpoint.sequence,
      )
      .map((replica) => replica.site_id),
  }));
}
