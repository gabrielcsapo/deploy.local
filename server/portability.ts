import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import type { ApplicationSpec } from './application-spec.ts';
import { sortableId } from './multisite.ts';
import { getSqlite } from './store.ts';

export const PORTABILITY_ANALYZER_VERSION = '1.0.0';

export type PortabilityClass =
  | 'stateless-replica'
  | 'file-replica'
  | 'sqlite-replica'
  | 'adapter-managed-replica'
  | 'follows-one-site'
  | 'not-suitcase-compatible';

export type CapabilityStatus = 'pass' | 'conditional' | 'block' | 'unknown';
export type EvidenceTrust = 'observed' | 'declared' | 'validated' | 'enforced';

export type CapabilityDimension =
  | 'compute'
  | 'runtimeContainment'
  | 'checkpointability'
  | 'dataCoverage'
  | 'conflictSafety'
  | 'offlineDependencies'
  | 'identityAndSecrets'
  | 'materialization'
  | 'buildability'
  | 'verification';

export interface PortabilityEvidence {
  trust: EvidenceTrust;
  source: string;
  detail: string;
  digest?: string;
}

export interface PortabilityFinding {
  id: string;
  dimension: CapabilityDimension;
  severity: 'info' | 'warning' | 'error';
  message: string;
  blocks: string[];
  evidence: string[];
  remediation?: string;
}

export interface CapabilityResult {
  status: CapabilityStatus;
  summary: string;
  evidence: PortabilityEvidence[];
  findingIds: string[];
}

export type PortabilityCapabilityVector = Record<CapabilityDimension, CapabilityResult>;

export interface SQLiteColumnProfile {
  name: string;
  type: string;
  notNull: boolean;
  primaryKeyOrder: number;
  generated: boolean;
}

export interface SQLiteTableProfile {
  name: string;
  kind: 'table' | 'virtual';
  sql: string;
  columns: SQLiteColumnProfile[];
  primaryKey: string[];
  integerPrimaryKey: boolean;
  withoutRowid: boolean;
  strict: boolean;
  eligible: boolean;
  blockers: string[];
}

export interface SQLiteFileProfile {
  resource: string;
  relativePath: string;
  byteSize: number;
  integrity: 'ok' | 'failed';
  foreignKeyViolations: number;
  schemaFingerprint: string;
  tables: SQLiteTableProfile[];
  triggers: string[];
}

export interface FileProfile {
  resource: string;
  relativePath: string;
  kind: 'file' | 'directory' | 'symlink' | 'special';
  byteSize: number;
  digest?: string;
  role: 'uploaded-content' | 'database-sidecar' | 'empty-directory' | 'blocked';
}

export interface PortabilityVolumeSnapshot {
  /** Logical ApplicationSpec resource key. */
  resource: string;
  /** Immutable or quiesced snapshot root. The analyzer never writes to it. */
  snapshotPath: string;
}

export interface PortabilityTargetEvidence {
  platform?: string;
  architecture?: string;
  compatibleArchitectures?: string[];
  runtimeAvailable?: boolean;
  /** A temporary replica passed with a read-only root and only declared managed state writable. */
  containmentValidated?: boolean;
  requiredDevicesAvailable?: boolean;
  secretsMaterialized?: boolean;
  artifactsMaterialized?: boolean;
  offlineAccessValidated?: boolean;
  offlineBuildValidated?: boolean;
  reconciliationValidated?: boolean;
}

export interface PortabilityAnalysisInput {
  appId: string;
  specDigest: string;
  siteId: string;
  spec: ApplicationSpec;
  volumes: PortabilityVolumeSnapshot[];
  target?: PortabilityTargetEvidence;
  adapter?: { name: string; version: string; validated: boolean };
}

export interface ReconciliationProfileDraft {
  version: string;
  schemaFingerprint?: string;
  sqliteFiles: SQLiteFileProfile[];
  eligibleTables: Array<{ file: string; table: string; primaryKey: string[] }>;
  excludedTables: Array<{ file: string; table: string; reason: string }>;
  uploadPaths: string[];
  opaquePaths: string[];
  conflictPolicy: 'collect' | 'prefer-home' | 'prefer-suitcase';
  compatibilityDigest: string;
}

export interface PortabilityReport {
  id: string;
  appId: string;
  specDigest: string;
  siteId: string;
  analyzerVersion: string;
  classification: PortabilityClass;
  syncsAcrossSites: boolean;
  capabilityVector: PortabilityCapabilityVector;
  findings: PortabilityFinding[];
  evidence: PortabilityEvidence[];
  files: FileProfile[];
  reconciliationProfile: ReconciliationProfileDraft;
  profileDigest: string;
  createdAt: string;
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary');
const BLOCKED_RUN_ARGUMENTS = [
  '--pid=host',
  '--ipc=host',
  '--uts=host',
  '--network=host',
  '--privileged',
];

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function fileDigest(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function isRecognizedUploadedContent(path: string): boolean {
  const bytes = readFileSync(path).subarray(0, 8192);
  if (bytes.length === 0) return true;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return true;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return true;
  if (bytes.subarray(0, 4).toString('ascii') === 'GIF8') return true;
  if (bytes.subarray(0, 4).toString('ascii') === '%PDF') return true;
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return true;
  // UTF-8/text uploads are safe to preserve as opaque immutable blobs. NUL is
  // deliberately rejected so an unknown mutable binary format fails closed.
  return !bytes.includes(0) && Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes);
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function relativePortable(root: string, path: string): string {
  return relative(root, path).split(sep).join('/') || '.';
}

function finding(
  id: string,
  dimension: CapabilityDimension,
  severity: PortabilityFinding['severity'],
  message: string,
  blocks: string[],
  evidence: string[],
  remediation?: string,
): PortabilityFinding {
  return { id, dimension, severity, message, blocks, evidence, remediation };
}

function inspectSqlite(
  resource: string,
  root: string,
  path: string,
  findings: PortabilityFinding[],
): SQLiteFileProfile {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    database.pragma('query_only = ON');
    const integrityRows = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const integrity =
      integrityRows.length === 1 && integrityRows[0]?.integrity_check === 'ok' ? 'ok' : 'failed';
    const foreignKeys = database.pragma('foreign_key_check') as unknown[];
    const tableList = database.pragma('table_list') as Array<{
      schema: string;
      name: string;
      type: string;
      wr: number;
      strict: number;
    }>;
    const schemaRows = database
      .prepare(
        `SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
           FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name`,
      )
      .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
    const triggers = schemaRows.filter((row) => row.type === 'trigger').map((row) => row.name);
    const tables: SQLiteTableProfile[] = [];

    for (const row of schemaRows.filter((entry) => entry.type === 'table')) {
      const tableMeta = tableList.find(
        (entry) => entry.schema === 'main' && entry.name === row.name,
      );
      const columns = database
        .prepare(`PRAGMA table_xinfo(${sqliteString(row.name)})`)
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
        hidden: number;
      }>;
      const profileColumns: SQLiteColumnProfile[] = columns.map((column) => ({
        name: column.name,
        type: column.type || '',
        notNull:
          Boolean(column.notnull) ||
          (column.pk > 0 && /^INTEGER$/i.test(column.type || '')) ||
          Boolean(tableMeta?.wr) ||
          Boolean(tableMeta?.strict),
        primaryKeyOrder: column.pk,
        generated: column.hidden === 2 || column.hidden === 3,
      }));
      const primaryKeyColumns = profileColumns
        .filter((column) => column.primaryKeyOrder > 0)
        .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder);
      const isVirtual = /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql);
      const blockers: string[] = [];
      if (isVirtual) blockers.push('virtual-table-requires-rebuild-profile');
      if (primaryKeyColumns.length === 0) blockers.push('missing-primary-key');
      if (primaryKeyColumns.some((column) => !column.notNull))
        blockers.push('nullable-primary-key');
      if (profileColumns.some((column) => column.generated)) {
        findings.push(
          finding(
            'DATA.SQLITE.GENERATED_COLUMNS',
            'dataCoverage',
            'warning',
            `${relativePortable(root, path)}:${row.name} uses generated or hidden columns; values will be regenerated rather than copied.`,
            [],
            [`${resource}:${relativePortable(root, path)}:${row.name}`],
          ),
        );
      }
      tables.push({
        name: row.name,
        kind: isVirtual ? 'virtual' : 'table',
        sql: row.sql,
        columns: profileColumns,
        primaryKey: primaryKeyColumns.map((column) => column.name),
        integerPrimaryKey:
          primaryKeyColumns.length === 1 && /^INTEGER$/i.test(primaryKeyColumns[0]!.type),
        withoutRowid: Boolean(tableMeta?.wr),
        strict: Boolean(tableMeta?.strict),
        eligible: blockers.length === 0,
        blockers,
      });
    }

    const relativePath = relativePortable(root, path);
    if (integrity === 'failed') {
      findings.push(
        finding(
          'DATA.SQLITE.INTEGRITY_CHECK_FAILED',
          'checkpointability',
          'error',
          `${relativePath} failed SQLite integrity_check.`,
          ['Automatic sync', 'Manual sync', 'Verified snapshot transfer'],
          [`${resource}:${relativePath}`],
          'Repair or restore the database and create a new verified checkpoint.',
        ),
      );
    }
    if (foreignKeys.length > 0) {
      findings.push(
        finding(
          'DATA.SQLITE.FOREIGN_KEY_CHECK_FAILED',
          'dataCoverage',
          'error',
          `${relativePath} contains ${foreignKeys.length} foreign-key violation(s).`,
          ['Automatic sync', 'Manual sync'],
          [`${resource}:${relativePath}`],
          'Repair referential integrity before enabling reconciliation.',
        ),
      );
    }
    for (const table of tables) {
      if (table.blockers.includes('missing-primary-key')) {
        findings.push(
          finding(
            'DATA.SQLITE.TABLE_NO_PRIMARY_KEY',
            'dataCoverage',
            'error',
            `${relativePath} table ${table.name} has no usable primary key.`,
            ['Automatic sync', 'Manual sync'],
            [`${resource}:${relativePath}:${table.name}`],
            'Add a stable non-null primary key, classify the table as rebuildable with validation, or use Follows one site.',
          ),
        );
      }
      if (table.blockers.includes('nullable-primary-key')) {
        findings.push(
          finding(
            'DATA.SQLITE.NULLABLE_PRIMARY_KEY',
            'dataCoverage',
            'error',
            `${relativePath} table ${table.name} has a primary key that SQLite permits to be NULL.`,
            ['Automatic sync', 'Manual sync'],
            [`${resource}:${relativePath}:${table.name}`],
            'Migrate the key to a non-null definition or use Follows one site.',
          ),
        );
      }
      if (table.kind === 'virtual') {
        findings.push(
          finding(
            'DATA.SQLITE.VIRTUAL_TABLE_UNCLASSIFIED',
            'dataCoverage',
            'error',
            `${relativePath} virtual table ${table.name} needs an explicit deterministic rebuild profile.`,
            ['Automatic sync', 'Manual sync'],
            [`${resource}:${relativePath}:${table.name}`],
            'Identify the durable base table and validate a rebuild step, or use Follows one site.',
          ),
        );
      }
      if (table.integerPrimaryKey) {
        findings.push(
          finding(
            'DATA.SQLITE.INTEGER_PRIMARY_KEY_COLLISION_RISK',
            'conflictSafety',
            'warning',
            `${relativePath} table ${table.name} uses an integer primary key cloned across sites. Concurrent inserts reconcile with explicit conflicts.`,
            [],
            [`${resource}:${relativePath}:${table.name}`],
            'Prefer random or site-prefixed keys to reduce expected insert collisions.',
          ),
        );
      }
    }

    const schemaFingerprint = digest({
      schema: schemaRows,
      tables: tables.map(({ name, columns, primaryKey, withoutRowid, strict, kind }) => ({
        name,
        columns,
        primaryKey,
        withoutRowid,
        strict,
        kind,
      })),
    });
    return {
      resource,
      relativePath,
      byteSize: statSync(path).size,
      integrity,
      foreignKeyViolations: foreignKeys.length,
      schemaFingerprint,
      tables,
      triggers,
    };
  } finally {
    database.close();
  }
}

function initialVector(): PortabilityCapabilityVector {
  const pending = (summary: string): CapabilityResult => ({
    status: 'unknown',
    summary,
    evidence: [],
    findingIds: [],
  });
  return {
    compute: pending('Target compute compatibility has not been probed.'),
    runtimeContainment: pending('Runtime containment has not been evaluated.'),
    checkpointability: pending('Checkpoint behavior has not been evaluated.'),
    dataCoverage: pending('Durable data has not been inventoried.'),
    conflictSafety: pending('Conflict behavior has not been evaluated.'),
    offlineDependencies: pending('Offline workflows have not been validated.'),
    identityAndSecrets: pending('Site identity and secret materialization have not been checked.'),
    materialization: pending('Required immutable artifacts have not been checked.'),
    buildability: pending('No-network build has not been validated.'),
    verification: pending('The exact release/profile has not completed validation.'),
  };
}

function setCapability(
  vector: PortabilityCapabilityVector,
  dimension: CapabilityDimension,
  status: CapabilityStatus,
  summary: string,
  evidence: PortabilityEvidence[],
  findings: PortabilityFinding[],
): void {
  vector[dimension] = {
    status,
    summary,
    evidence,
    findingIds: findings.filter((entry) => entry.dimension === dimension).map((entry) => entry.id),
  };
}

export function analyzePortability(input: PortabilityAnalysisInput): PortabilityReport {
  const findings: PortabilityFinding[] = [];
  const evidence: PortabilityEvidence[] = [];
  const vector = initialVector();
  const sqliteFiles: SQLiteFileProfile[] = [];
  const files: FileProfile[] = [];
  const resourceByKey = input.spec.resources;

  const requiredArchitectures = input.target?.compatibleArchitectures || [];
  const targetArchitecture = input.target?.architecture;
  const architectureEvidenceAvailable = requiredArchitectures.length > 0;
  const architectureMatches =
    !targetArchitecture ||
    !architectureEvidenceAvailable ||
    requiredArchitectures.includes(targetArchitecture);
  if (input.target?.runtimeAvailable === false || !architectureMatches) {
    findings.push(
      finding(
        'COMPUTE.TARGET_INCOMPATIBLE',
        'compute',
        'error',
        !architectureMatches
          ? `Target architecture ${targetArchitecture} is not in the compatible release set.`
          : 'The container runtime is unavailable on this target.',
        ['Keep on suitcase', 'Runtime ready', 'Build ready'],
        [input.siteId],
        'Choose a compatible target or provide a validated native build path.',
      ),
    );
    setCapability(
      vector,
      'compute',
      'block',
      'The selected target cannot execute this release.',
      [],
      findings,
    );
  } else if (
    input.target?.runtimeAvailable === true &&
    targetArchitecture &&
    architectureEvidenceAvailable
  ) {
    const targetEvidence: PortabilityEvidence = {
      trust: 'observed',
      source: `site:${input.siteId}`,
      detail: `Container runtime available on ${input.target.platform || 'unknown'}/${targetArchitecture}.`,
    };
    evidence.push(targetEvidence);
    setCapability(
      vector,
      'compute',
      'pass',
      'Target runtime and architecture checks passed.',
      [targetEvidence],
      findings,
    );
  } else if (input.target?.runtimeAvailable === true && targetArchitecture) {
    const targetEvidence: PortabilityEvidence = {
      trust: 'observed',
      source: `site:${input.siteId}`,
      detail: `Container runtime observed on ${input.target.platform || 'unknown'}/${targetArchitecture}; release architecture is not yet materialized.`,
    };
    evidence.push(targetEvidence);
    setCapability(
      vector,
      'compute',
      'conditional',
      'Runtime is available; exact release architecture still requires materialization evidence.',
      [targetEvidence],
      findings,
    );
  }

  let containmentBlocked = false;
  for (const [componentKey, component] of Object.entries(input.spec.components)) {
    const dangerousArgument = component.runtime.runArgs.find((argument) =>
      BLOCKED_RUN_ARGUMENTS.some(
        (blocked) => argument === blocked || argument.startsWith(`${blocked}=`),
      ),
    );
    if (component.runtime.privilegedDocker || dangerousArgument) {
      containmentBlocked = true;
      findings.push(
        finding(
          'RUNTIME.EXTERNAL_MUTABLE_SIDE_EFFECTS',
          'runtimeContainment',
          'error',
          `Component ${componentKey} can mutate host-level state through privileged runtime access.`,
          ['Syncs across sites'],
          [dangerousArgument || 'privilegedDocker'],
          'Remove the host-level access or supply a versioned adapter that snapshots and validates its side effects.',
        ),
      );
    }
  }
  const requiredDevices = Object.entries(input.spec.components).flatMap(([component, value]) =>
    value.runtime.devices.map((device) => `${component}:${device.hostPath}`),
  );
  if (requiredDevices.length > 0 && input.target?.requiredDevicesAvailable === false) {
    findings.push(
      finding(
        'COMPUTE.REQUIRED_DEVICE_MISSING',
        'compute',
        'error',
        'The selected target does not expose every device required by this application.',
        ['Keep on suitcase', 'Runtime ready'],
        requiredDevices,
        'Attach the declared devices or choose a target with matching hardware capabilities.',
      ),
    );
    setCapability(
      vector,
      'compute',
      'block',
      'Required target devices are unavailable.',
      [],
      findings,
    );
  }
  for (const [resourceKey, resource] of Object.entries(resourceByKey)) {
    if (resource.source?.type === 'bind') {
      const writableConsumers = Object.values(input.spec.components).filter(
        (component) => component.mounts[resourceKey] && !component.mounts[resourceKey]!.readOnly,
      );
      if (writableConsumers.length > 0) {
        containmentBlocked = true;
        findings.push(
          finding(
            'RUNTIME.CUSTOM_WRITABLE_MOUNT',
            'runtimeContainment',
            'error',
            `Resource ${resourceKey} is a writable host bind mount outside deploy.local's managed volume boundary.`,
            ['Syncs across sites'],
            [resource.source.hostPath],
            'Adopt the data into a managed volume or use Follows one site.',
          ),
        );
      }
    }
  }
  const containmentEvidence: PortabilityEvidence = {
    trust: containmentBlocked
      ? 'observed'
      : input.target?.containmentValidated
        ? 'enforced'
        : 'declared',
    source: 'ApplicationSpec',
    detail: containmentBlocked
      ? 'The manifest contains host-level mutable access.'
      : input.target?.containmentValidated
        ? 'A temporary replica passed with a read-only root, explicit tmpfs scratch paths, and only declared managed state writable.'
        : 'All declared writable mounts resolve to managed resources; a read-only-root validation is still required.',
    digest: input.specDigest,
  };
  evidence.push(containmentEvidence);
  setCapability(
    vector,
    'runtimeContainment',
    containmentBlocked ? 'block' : input.target?.containmentValidated ? 'pass' : 'conditional',
    containmentBlocked
      ? 'Host-level mutable state prevents generic reconciliation.'
      : input.target?.containmentValidated
        ? 'Runtime state containment was enforced by a temporary replica.'
        : 'Declared mounts are contained; enforcement validation remains pending.',
    [containmentEvidence],
    findings,
  );

  const snapshotsByResource = new Map(input.volumes.map((volume) => [volume.resource, volume]));
  let emptyDurableVolume = false;
  let specialOrOpaque = false;
  let ordinaryFileCount = 0;
  for (const [resourceKey, resource] of Object.entries(resourceByKey)) {
    if (resource.durability !== 'durable') continue;
    const snapshot = snapshotsByResource.get(resourceKey);
    if (!snapshot) {
      specialOrOpaque = true;
      findings.push(
        finding(
          'DATA.MANAGED_VOLUME_NOT_SNAPSHOTTED',
          'checkpointability',
          'error',
          `Durable resource ${resourceKey} has no immutable or quiesced snapshot to analyze.`,
          ['Automatic sync', 'Manual sync', 'Suitcase data ready'],
          [resourceKey],
          'Create a consistent volume snapshot and rerun the analyzer.',
        ),
      );
      continue;
    }
    const root = resolve(snapshot.snapshotPath);
    let rootReal: string;
    try {
      rootReal = realpathSync(root);
    } catch {
      specialOrOpaque = true;
      findings.push(
        finding(
          'DATA.SNAPSHOT_UNREADABLE',
          'checkpointability',
          'error',
          `Snapshot for ${resourceKey} cannot be read.`,
          ['Automatic sync', 'Manual sync', 'Suitcase data ready'],
          [root],
          'Recreate the snapshot with readable, immutable contents.',
        ),
      );
      continue;
    }
    const queue = [rootReal];
    let entries = 0;
    let resourceFileCount = 0;
    while (queue.length > 0) {
      const path = queue.pop()!;
      if (++entries > 100_000) {
        specialOrOpaque = true;
        findings.push(
          finding(
            'DATA.INVENTORY_LIMIT_EXCEEDED',
            'dataCoverage',
            'error',
            `Snapshot ${resourceKey} exceeds the 100,000-entry analyzer safety limit.`,
            ['Automatic sync', 'Manual sync'],
            [root],
            'Split the data set or use a versioned adapter designed for this layout.',
          ),
        );
        break;
      }
      const metadata = lstatSync(path);
      const relativePath = relativePortable(rootReal, path);
      if (metadata.isDirectory()) {
        const children = readdirSync(path).sort((left, right) => right.localeCompare(left));
        if (children.length === 0 && path !== rootReal) {
          files.push({
            resource: resourceKey,
            relativePath,
            kind: 'directory',
            byteSize: 0,
            role: 'empty-directory',
          });
        }
        for (const child of children) queue.push(resolve(path, child));
        continue;
      }
      if (metadata.isSymbolicLink()) {
        const link = readlinkSync(path);
        let escapes = true;
        try {
          const destination = realpathSync(resolve(path, '..', link));
          escapes = destination !== rootReal && !destination.startsWith(`${rootReal}${sep}`);
        } catch {
          escapes = true;
        }
        files.push({
          resource: resourceKey,
          relativePath,
          kind: 'symlink',
          byteSize: metadata.size,
          digest: digest({ link }),
          role: escapes ? 'blocked' : 'uploaded-content',
        });
        if (escapes) {
          specialOrOpaque = true;
          findings.push(
            finding(
              'DATA.FILE.ESCAPING_SYMLINK',
              'dataCoverage',
              'error',
              `${resourceKey}/${relativePath} escapes the managed snapshot root.`,
              ['Automatic sync', 'Manual sync'],
              [link],
              'Replace it with managed content or use Follows one site.',
            ),
          );
        }
        continue;
      }
      if (!metadata.isFile()) {
        specialOrOpaque = true;
        files.push({
          resource: resourceKey,
          relativePath,
          kind: 'special',
          byteSize: metadata.size,
          role: 'blocked',
        });
        findings.push(
          finding(
            'DATA.FILE.MUTABLE_SPECIAL_FILE',
            'dataCoverage',
            'error',
            `${resourceKey}/${relativePath} is a socket, FIFO, device, or other special file.`,
            ['Automatic sync', 'Manual sync'],
            [`mode:${metadata.mode.toString(8)}`],
            'Move runtime-only special files to declared ephemeral storage.',
          ),
        );
        continue;
      }

      resourceFileCount++;
      const firstBytes = readFileSync(path).subarray(0, SQLITE_HEADER.length);
      if (firstBytes.equals(SQLITE_HEADER)) {
        try {
          sqliteFiles.push(inspectSqlite(resourceKey, rootReal, path, findings));
        } catch (error) {
          specialOrOpaque = true;
          findings.push(
            finding(
              'DATA.SQLITE.UNREADABLE',
              'dataCoverage',
              'error',
              `${resourceKey}/${relativePath} looks like SQLite but could not be safely inspected: ${error instanceof Error ? error.message : String(error)}`,
              ['Automatic sync', 'Manual sync'],
              [`${resourceKey}:${relativePath}`],
              'Create a consistent SQLite backup and rerun the analyzer, or use Follows one site.',
            ),
          );
        }
        continue;
      }
      if (/-(wal|shm|journal)$/i.test(relativePath)) {
        files.push({
          resource: resourceKey,
          relativePath,
          kind: 'file',
          byteSize: metadata.size,
          digest: fileDigest(path),
          role: 'database-sidecar',
        });
        continue;
      }
      if (resource.dataRole === 'database' && !isRecognizedUploadedContent(path)) {
        specialOrOpaque = true;
        files.push({
          resource: resourceKey,
          relativePath,
          kind: 'file',
          byteSize: metadata.size,
          digest: fileDigest(path),
          role: 'blocked',
        });
        findings.push(
          finding(
            'DATA.DATABASE.OPAQUE_FORMAT',
            'dataCoverage',
            'error',
            `${resourceKey}/${relativePath} is mutable database content with no generic reconciliation profile.`,
            ['Automatic sync', 'Manual sync'],
            [`${resourceKey}:${relativePath}`],
            'Use a logical export adapter, classify the app as Follows one site, or move the state to eligible SQLite.',
          ),
        );
      } else {
        ordinaryFileCount++;
        files.push({
          resource: resourceKey,
          relativePath,
          kind: 'file',
          byteSize: metadata.size,
          digest: fileDigest(path),
          role: 'uploaded-content',
        });
      }
    }
    if (resourceFileCount === 0) {
      emptyDurableVolume = true;
      findings.push(
        finding(
          'DATA.EMPTY_DURABLE_VOLUME',
          'dataCoverage',
          'warning',
          `Durable resource ${resourceKey} is empty and needs initialization evidence; it is not assumed stateless.`,
          [],
          [root],
        ),
      );
    }
  }

  const declaredTableExclusions = (resource: string) =>
    new Set(input.spec.resources[resource]?.reconciliation?.excludeTables ?? []);
  const declaredPathExcluded = (resource: string, path: string) =>
    (input.spec.resources[resource]?.reconciliation?.excludePaths ?? []).some(
      (excluded) => path === excluded || path.startsWith(`${excluded.replace(/\/$/, '')}/`),
    );
  const declaredExclusions = Object.entries(input.spec.resources).flatMap(([resource, value]) => [
    ...(value.reconciliation?.excludeTables ?? []).map((table) => `${resource}:table:${table}`),
    ...(value.reconciliation?.excludePaths ?? []).map((path) => `${resource}:path:${path}`),
  ]);
  if (declaredExclusions.length > 0) {
    findings.push(
      finding(
        'DATA.RECONCILIATION.DECLARED_EXCLUSIONS',
        'dataCoverage',
        'info',
        'deploy.yaml explicitly keeps selected tables or paths outside the shared reconciliation profile.',
        [],
        declaredExclusions,
      ),
    );
  }

  const sqliteBlocked = sqliteFiles.some(
    (file) =>
      file.integrity !== 'ok' ||
      file.foreignKeyViolations > 0 ||
      file.tables.some((table) => !table.eligible),
  );
  const multipleSqliteFiles = sqliteFiles.length > 1;
  if (multipleSqliteFiles) {
    findings.push(
      finding(
        'DATA.SQLITE.MULTIPLE_DATABASES_UNSUPPORTED',
        'dataCoverage',
        'error',
        `Generic v1 reconciliation supports exactly one SQLite database per application checkpoint; this snapshot contains ${sqliteFiles.length}.`,
        ['Automatic sync', 'Manual sync'],
        sqliteFiles.map((file) => `${file.resource}/${file.relativePath}`),
        'Consolidate the databases, provide an application adapter with consistency-group semantics, or use Follows one site.',
      ),
    );
  }
  const dataBlocked = specialOrOpaque || sqliteBlocked || multipleSqliteFiles;
  const dataEvidence: PortabilityEvidence = {
    trust: 'observed',
    source: 'managed-volume-snapshots',
    detail: `Inventoried ${files.length} file entries and ${sqliteFiles.length} SQLite database(s).`,
    digest: digest({ files, sqliteFiles }),
  };
  evidence.push(dataEvidence);
  setCapability(
    vector,
    'checkpointability',
    dataBlocked ? 'block' : input.volumes.length > 1 ? 'conditional' : 'pass',
    dataBlocked
      ? 'At least one durable resource cannot produce a verified generic checkpoint.'
      : input.volumes.length > 1
        ? 'Multiple durable resources require an application quiesce or atomic snapshot validation.'
        : 'The observed data set can be represented by one checkpoint.',
    [dataEvidence],
    findings,
  );
  setCapability(
    vector,
    'dataCoverage',
    dataBlocked ? 'block' : emptyDurableVolume ? 'conditional' : 'pass',
    dataBlocked
      ? 'Some durable mutations are opaque or unsafe for generic reconciliation.'
      : emptyDurableVolume
        ? 'Observed content is covered, but an empty durable volume still needs initialization validation.'
        : 'Every observed durable path has a reconciliation role.',
    [dataEvidence],
    findings,
  );
  const integerRisk = sqliteFiles.some((file) =>
    file.tables.some((table) => table.integerPrimaryKey),
  );
  setCapability(
    vector,
    'conflictSafety',
    dataBlocked ? 'block' : integerRisk || ordinaryFileCount > 0 ? 'conditional' : 'pass',
    dataBlocked
      ? 'Ambiguous state cannot be retained by the generic reconciler.'
      : integerRisk
        ? 'Conflicts are detectable and preserved; cloned integer keys make concurrent-insert conflicts likely.'
        : ordinaryFileCount > 0
          ? 'File collisions use deterministic keep-both behavior and require administrator resolution.'
          : 'Observed rows can be compared by stable primary key.',
    [dataEvidence],
    findings,
  );

  const target = input.target;
  if (target?.offlineAccessValidated === true) {
    const item: PortabilityEvidence = {
      trust: 'validated',
      source: `site:${input.siteId}`,
      detail:
        'Startup, local route, and declared offline probe passed with external access denied.',
    };
    evidence.push(item);
    setCapability(
      vector,
      'offlineDependencies',
      'pass',
      'Validated workflows run offline.',
      [item],
      findings,
    );
  }
  if (target?.secretsMaterialized === true) {
    const item: PortabilityEvidence = {
      trust: 'validated',
      source: `site:${input.siteId}`,
      detail: 'Required site identity and secret references are materialized.',
    };
    evidence.push(item);
    setCapability(
      vector,
      'identityAndSecrets',
      'pass',
      'Identity and secret projection passed.',
      [item],
      findings,
    );
  }
  if (target?.artifactsMaterialized === true) {
    const item: PortabilityEvidence = {
      trust: 'validated',
      source: `site:${input.siteId}`,
      detail:
        'Release, image/source, checkpoint, blob, certificate, and rollback digests are present.',
    };
    evidence.push(item);
    setCapability(
      vector,
      'materialization',
      'pass',
      'All required immutable bytes are present.',
      [item],
      findings,
    );
  }
  if (target?.offlineBuildValidated === true) {
    const item: PortabilityEvidence = {
      trust: 'validated',
      source: `site:${input.siteId}`,
      detail: 'The exact dependency graph rebuilt successfully with network access denied.',
    };
    evidence.push(item);
    setCapability(
      vector,
      'buildability',
      'pass',
      'No-network build validation passed.',
      [item],
      findings,
    );
  }
  if (target?.reconciliationValidated === true && !dataBlocked) {
    const item: PortabilityEvidence = {
      trust: 'validated',
      source: `site:${input.siteId}`,
      detail: 'Fork/diff/apply/integrity validation passed for this release and profile.',
    };
    evidence.push(item);
    setCapability(
      vector,
      'verification',
      'pass',
      'Release/profile reconciliation validation passed.',
      [item],
      findings,
    );
  } else if (dataBlocked) {
    setCapability(
      vector,
      'verification',
      'block',
      'Validation cannot pass while data blockers remain.',
      [],
      findings,
    );
  }

  let classification: PortabilityClass;
  if (vector.compute.status === 'block') classification = 'not-suitcase-compatible';
  else if (input.adapter?.validated) classification = 'adapter-managed-replica';
  else if (dataBlocked || containmentBlocked) classification = 'follows-one-site';
  else if (sqliteFiles.length > 0) classification = 'sqlite-replica';
  else if (ordinaryFileCount > 0 || emptyDurableVolume) classification = 'file-replica';
  else classification = 'stateless-replica';

  const declaredPolicies = [
    ...new Set(
      Object.values(input.spec.resources)
        .map((resource) => resource.reconciliation?.conflictPolicy ?? 'collect')
        .filter((policy) => policy !== 'collect'),
    ),
  ];
  const conflictPolicy = declaredPolicies.length === 1 ? declaredPolicies[0] : 'collect';
  if (declaredPolicies.length > 1) {
    findings.push(
      finding(
        'DATA.RECONCILIATION.CONFLICT_POLICY_MISMATCH',
        'conflictSafety',
        'warning',
        'Volume annotations request different automatic conflict policies; the profile falls back to collect.',
        [],
        declaredPolicies,
        'Use one application-wide conflict policy across reconciled resources.',
      ),
    );
  }
  const eligibleTables = sqliteFiles.flatMap((file) =>
    file.tables
      .filter((table) => table.eligible && !declaredTableExclusions(file.resource).has(table.name))
      .map((table) => ({
        file: `${file.resource}/${file.relativePath}`,
        table: table.name,
        primaryKey: table.primaryKey,
      })),
  );
  const excludedTables = sqliteFiles.flatMap((file) =>
    file.tables
      .filter((table) => !table.eligible || declaredTableExclusions(file.resource).has(table.name))
      .map((table) => ({
        file: `${file.resource}/${file.relativePath}`,
        table: table.name,
        reason: table.eligible
          ? 'excluded by deploy.yaml reconciliation guidance'
          : table.blockers.join(','),
      })),
  );
  const uploadPaths = files
    .filter(
      (file) =>
        file.role === 'uploaded-content' && !declaredPathExcluded(file.resource, file.relativePath),
    )
    .map((file) => `${file.resource}/${file.relativePath}`)
    .sort();
  const opaquePaths = files
    .filter((file) => file.role === 'blocked')
    .map((file) => `${file.resource}/${file.relativePath}`)
    .sort();
  const schemaFingerprint =
    sqliteFiles.length > 0
      ? digest(sqliteFiles.map((file) => [file.relativePath, file.schemaFingerprint]))
      : undefined;
  const profileCore = {
    analyzerVersion: PORTABILITY_ANALYZER_VERSION,
    schemaFingerprint,
    sqliteFiles,
    eligibleTables,
    excludedTables,
    uploadPaths,
    opaquePaths,
    conflictPolicy,
  };
  const profileDigest = digest(profileCore);
  const reconciliationProfile: ReconciliationProfileDraft = {
    version: profileDigest,
    schemaFingerprint,
    sqliteFiles,
    eligibleTables,
    excludedTables,
    uploadPaths,
    opaquePaths,
    conflictPolicy,
    compatibilityDigest: digest({
      analyzerVersion: PORTABILITY_ANALYZER_VERSION,
      schemaFingerprint,
      eligibleTables,
      excludedTables,
      uploadPaths,
      conflictPolicy,
    }),
  };

  return {
    id: sortableId('portability'),
    appId: input.appId,
    specDigest: input.specDigest,
    siteId: input.siteId,
    analyzerVersion: PORTABILITY_ANALYZER_VERSION,
    classification,
    syncsAcrossSites:
      ['stateless-replica', 'file-replica', 'sqlite-replica', 'adapter-managed-replica'].includes(
        classification,
      ) && !dataBlocked,
    capabilityVector: vector,
    findings,
    evidence,
    files,
    reconciliationProfile,
    profileDigest,
    createdAt: new Date().toISOString(),
  };
}

export function persistPortabilityReport(report: PortabilityReport): void {
  const sqlite = getSqlite()!;
  const write = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO data_reconciliation_profiles
          (id, app_id, version, analyzer_version, schema_fingerprint, sqlite_files,
           eligible_tables, excluded_tables, upload_paths, opaque_paths,
           conflict_policy, compatibility_digest, findings, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        report.profileDigest,
        report.appId,
        report.reconciliationProfile.version,
        report.analyzerVersion,
        report.reconciliationProfile.schemaFingerprint || null,
        JSON.stringify(report.reconciliationProfile.sqliteFiles),
        JSON.stringify(report.reconciliationProfile.eligibleTables),
        JSON.stringify(report.reconciliationProfile.excludedTables),
        JSON.stringify(report.reconciliationProfile.uploadPaths),
        JSON.stringify(report.reconciliationProfile.opaquePaths),
        report.reconciliationProfile.conflictPolicy,
        report.reconciliationProfile.compatibilityDigest,
        JSON.stringify(report.findings),
        report.createdAt,
      );
    sqlite
      .prepare(
        `INSERT INTO portability_reports
          (id, app_id, spec_digest, site_id, analyzer_version, classification,
           capability_vector, findings, evidence, profile_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.id,
        report.appId,
        report.specDigest,
        report.siteId,
        report.analyzerVersion,
        report.classification,
        JSON.stringify(report.capabilityVector),
        JSON.stringify(report.findings),
        JSON.stringify(report.evidence),
        report.profileDigest,
        report.createdAt,
      );
  });
  write.immediate();
}

const GIB = 1024 ** 3;

export interface CapacityQuantity {
  bytes: number;
  confidence: 'measured' | 'declared' | 'default' | 'estimated' | 'unknown';
  source: string;
}

export interface CapacityComponentInput {
  appId: string;
  component: string;
  instances: number;
  runtimeWorkingSet: CapacityQuantity;
  rollingSurgeInstances?: number;
  buildPeak?: CapacityQuantity;
  storage?: CapacityQuantity;
  projectedGrowthBytes?: number;
}

export interface SuitcaseCapacityInput {
  fleetId: string;
  components: CapacityComponentInput[];
  platformMemoryReserve?: CapacityQuantity;
  syncMemoryPeak?: CapacityQuantity;
  platformStorageBytes?: CapacityQuantity;
  currentDataBytes?: CapacityQuantity;
  imageAndSourceBytes?: CapacityQuantity;
  buildCacheBytes?: CapacityQuantity;
  /** Additional policy budget above the cache bytes currently retained. */
  buildCacheReserveBytes?: CapacityQuantity;
  checkpointAndConflictBytes?: CapacityQuantity;
  rollbackBytes?: CapacityQuantity;
  backupBytes?: CapacityQuantity;
  ephemeralStorageBytes?: CapacityQuantity;
  tripHorizonDays: number;
  offlineBuilds: boolean;
  memoryHeadroomRatio?: number;
  storageSafetyFloorBytes?: number;
  evidenceUnknowns?: string[];
  evidenceWindow?: {
    startAt: string | null;
    endAt: string | null;
    sampleCount: number;
    peakAt: string | null;
  };
  targetProbe?: {
    siteId: string;
    siteName: string;
    memoryBytes: number | null;
    freeStorageBytes: number | null;
    architecture: string | null;
    platform: string | null;
    dockerAvailable: boolean | null;
    offlineBuildAvailable: boolean | null;
    privilegedContainers: boolean | null;
    hostNetwork: boolean | null;
    observedAt: string | null;
  };
  targetRequirements?: {
    architectures: string[];
    docker: boolean;
    offlineBuild: boolean;
    privilegedContainers: boolean;
    hostNetwork: boolean;
  };
}

export interface CapacityContributor {
  category: 'memory' | 'storage';
  name: string;
  bytes: number;
  confidence: CapacityQuantity['confidence'];
  source: string;
}

export interface SuitcaseCapacityPlan {
  id: string;
  fleetId: string;
  selectedAppIds: string[];
  minimumMemoryBytes: number;
  recommendedMemoryBytes: number;
  minimumStorageBytes: number;
  recommendedStorageBytes: number;
  contributors: CapacityContributor[];
  confidence: CapacityQuantity['confidence'];
  unknowns: string[];
  assumptions: Record<string, unknown>;
  evidenceSummary: {
    measured: number;
    declared: number;
    default: number;
    unknown: number;
    observationWindow: SuitcaseCapacityInput['evidenceWindow'] | null;
  };
  targetComparison: null | {
    siteId: string;
    siteName: string;
    status: 'recommended' | 'minimum-only' | 'insufficient' | 'unknown';
    ready: boolean;
    observedAt: string | null;
    memory: {
      availableBytes: number | null;
      minimumBytes: number;
      recommendedBytes: number;
      status: 'recommended' | 'minimum-only' | 'insufficient' | 'unknown';
    };
    storage: {
      availableBytes: number | null;
      minimumBytes: number;
      recommendedBytes: number;
      status: 'recommended' | 'minimum-only' | 'insufficient' | 'unknown';
    };
    capabilities: Array<{
      name: string;
      required: boolean | string[];
      observed: boolean | string | null;
      status: 'pass' | 'block' | 'unknown';
    }>;
    blockers: string[];
  };
  createdAt: string;
}

function roundCapacity(bytes: number, tiersGiB: number[]): number {
  const tier = tiersGiB.find((candidate) => candidate * GIB >= bytes);
  return (tier || Math.ceil(bytes / GIB / 16) * 16) * GIB;
}

function weakestConfidence(inputs: CapacityQuantity[]): CapacityQuantity['confidence'] {
  const order: CapacityQuantity['confidence'][] = [
    'measured',
    'declared',
    'default',
    'estimated',
    'unknown',
  ];
  const confidence = order[Math.max(...inputs.map((input) => order.indexOf(input.confidence)))]!;
  return confidence === 'estimated' ? 'default' : confidence;
}

function normalizedQuantity(quantity: CapacityQuantity): CapacityQuantity {
  return quantity.confidence === 'estimated' ? { ...quantity, confidence: 'default' } : quantity;
}

function capacityStatus(
  available: number | null,
  minimum: number,
  recommended: number,
): 'recommended' | 'minimum-only' | 'insufficient' | 'unknown' {
  if (available === null || !Number.isFinite(available)) return 'unknown';
  if (available < minimum) return 'insufficient';
  if (available < recommended) return 'minimum-only';
  return 'recommended';
}

export function planSuitcaseCapacity(input: SuitcaseCapacityInput): SuitcaseCapacityPlan {
  if (!Number.isFinite(input.tripHorizonDays) || input.tripHorizonDays < 0)
    throw new Error('Trip horizon must be a non-negative number of days');
  const reserve = input.platformMemoryReserve || {
    bytes: 2 * GIB,
    confidence: 'default' as const,
    source: 'deploy.local default platform reserve',
  };
  const syncPeak = input.syncMemoryPeak || {
    bytes: 512 * 1024 ** 2,
    confidence: 'default' as const,
    source: 'generic reconciliation helper estimate',
  };
  const contributors: CapacityContributor[] = [
    { category: 'memory', name: 'Platform and OS reserve', ...normalizedQuantity(reserve) },
  ];
  let runtime = 0;
  let rollingSurge = 0;
  for (const component of input.components) {
    const bytes = component.runtimeWorkingSet.bytes * component.instances;
    runtime += bytes;
    contributors.push({
      category: 'memory',
      name: `${component.appId}/${component.component} runtime ×${component.instances}`,
      bytes,
      confidence: normalizedQuantity(component.runtimeWorkingSet).confidence,
      source: component.runtimeWorkingSet.source,
    });
    const surge =
      component.runtimeWorkingSet.bytes * Math.max(0, component.rollingSurgeInstances || 0);
    rollingSurge += surge;
    if (surge > 0) {
      contributors.push({
        category: 'memory',
        name: `${component.appId}/${component.component} rolling surge`,
        bytes: surge,
        confidence: normalizedQuantity(component.runtimeWorkingSet).confidence,
        source: component.runtimeWorkingSet.source,
      });
    }
  }
  const largestBuild = input.offlineBuilds
    ? input.components
        .map((component) => component.buildPeak)
        .filter((quantity): quantity is CapacityQuantity => Boolean(quantity))
        .sort((left, right) => right.bytes - left.bytes)[0]
    : undefined;
  if (largestBuild) {
    contributors.push({
      category: 'memory',
      name: 'Largest serialized offline build',
      ...normalizedQuantity(largestBuild),
    });
  }
  contributors.push({
    category: 'memory',
    name: 'Reconciliation/helper overlap',
    ...normalizedQuantity(syncPeak),
  });
  const minimumMemory =
    reserve.bytes + runtime + (input.offlineBuilds ? largestBuild?.bytes || 0 : 0);
  const beforeHeadroom = minimumMemory + rollingSurge + syncPeak.bytes;
  const headroom = Math.ceil(beforeHeadroom * (input.memoryHeadroomRatio ?? 0.2));
  contributors.push({
    category: 'memory',
    name: 'Safety headroom',
    bytes: headroom,
    confidence: 'default',
    source: `${Math.round((input.memoryHeadroomRatio ?? 0.2) * 100)}% policy`,
  });

  const storageInputs: Array<[string, CapacityQuantity]> = [
    [
      'Platform current and rollback releases',
      input.platformStorageBytes || {
        bytes: 4 * GIB,
        confidence: 'default',
        source: 'deploy.local platform retention estimate',
      },
    ],
    [
      'Current application data',
      input.currentDataBytes || {
        bytes: input.components.reduce(
          (sum, component) => sum + (component.storage?.bytes || 0),
          0,
        ),
        confidence: input.components.some((component) => !component.storage)
          ? 'unknown'
          : weakestConfidence(input.components.map((component) => component.storage!)),
        source: 'selected component storage observations',
      },
    ],
    [
      'Current and rollback source/images',
      input.imageAndSourceBytes || {
        bytes: 0,
        confidence: 'unknown',
        source: 'image/source inventory unavailable',
      },
    ],
    [
      'Build cache',
      input.buildCacheBytes || {
        bytes: input.offlineBuilds ? 8 * GIB : 0,
        confidence: 'default',
        source: input.offlineBuilds ? 'offline build cache default' : 'offline builds disabled',
      },
    ],
    [
      'Additional build-cache reserve',
      input.buildCacheReserveBytes || {
        bytes: 0,
        confidence: 'measured',
        source: 'no additional cache reserve requested',
      },
    ],
    [
      'Checkpoints, staging, and retained conflicts',
      input.checkpointAndConflictBytes || {
        bytes: 0,
        confidence: 'unknown',
        source: 'checkpoint retention inventory unavailable',
      },
    ],
    [
      'Verified rollback and recovery artifacts',
      input.rollbackBytes || {
        bytes: 0,
        confidence: 'unknown',
        source: 'rollback artifact inventory unavailable',
      },
    ],
    [
      'Backups',
      input.backupBytes || {
        bytes: 0,
        confidence: 'unknown',
        source: 'backup retention inventory unavailable',
      },
    ],
    [
      'Runtime and build scratch space',
      input.ephemeralStorageBytes || {
        bytes: 0,
        confidence: 'unknown',
        source: 'component ephemeral-storage requirements unavailable',
      },
    ],
  ];
  let storage = 0;
  for (const [name, quantity] of storageInputs) {
    storage += quantity.bytes;
    contributors.push({ category: 'storage', name, ...normalizedQuantity(quantity) });
  }
  const projectedGrowth = input.components.reduce(
    (sum, component) => sum + (component.projectedGrowthBytes || 0),
    0,
  );
  contributors.push({
    category: 'storage',
    name: `Projected growth over ${input.tripHorizonDays} day(s)`,
    bytes: projectedGrowth,
    confidence: projectedGrowth > 0 ? 'declared' : 'unknown',
    source: 'selected application growth assumptions',
  });
  const storageFloor = input.storageSafetyFloorBytes ?? 16 * GIB;
  contributors.push({
    category: 'storage',
    name: 'Free-space safety floor',
    bytes: storageFloor,
    confidence: 'default',
    source: 'deploy.local safety policy',
  });

  const quantities: CapacityQuantity[] = contributors.map((entry) => ({
    bytes: entry.bytes,
    confidence: entry.confidence,
    source: entry.source,
  }));
  const unknowns = [
    ...contributors
      .filter((entry) => entry.confidence === 'unknown')
      .map((entry) => `${entry.name}: ${entry.source}`),
    ...(input.evidenceUnknowns || []),
  ];
  const minimumMemoryBytes = Math.ceil(minimumMemory);
  const recommendedMemoryBytes = roundCapacity(
    beforeHeadroom + headroom,
    [2, 4, 8, 12, 16, 24, 32, 48, 64],
  );
  const minimumStorageBytes = Math.ceil(storage);
  const recommendedStorageBytes = roundCapacity(
    storage + projectedGrowth + storageFloor,
    [64, 128, 256, 512, 1024, 2048, 4096],
  );
  const target = input.targetProbe;
  const requirements = input.targetRequirements;
  const targetComparison = target
    ? (() => {
        const memoryStatus = capacityStatus(
          target.memoryBytes,
          minimumMemoryBytes,
          recommendedMemoryBytes,
        );
        const storageStatus = capacityStatus(
          target.freeStorageBytes,
          minimumStorageBytes,
          recommendedStorageBytes,
        );
        const capability = (name: string, required: boolean, observed: boolean | null) => ({
          name,
          required,
          observed,
          status: (!required
            ? 'pass'
            : observed === null
              ? 'unknown'
              : observed
                ? 'pass'
                : 'block') as 'pass' | 'block' | 'unknown',
        });
        const architectureRequired = requirements?.architectures || [];
        const architectureStatus =
          architectureRequired.length === 0 ||
          (target.architecture && architectureRequired.includes(target.architecture))
            ? 'pass'
            : target.architecture
              ? 'block'
              : 'unknown';
        const capabilities = [
          {
            name: 'architecture',
            required: architectureRequired,
            observed: target.architecture,
            status: architectureStatus as 'pass' | 'block' | 'unknown',
          },
          capability('Docker runtime', requirements?.docker === true, target.dockerAvailable),
          capability(
            'Offline builds',
            requirements?.offlineBuild === true,
            target.offlineBuildAvailable,
          ),
          capability(
            'Privileged containers',
            requirements?.privilegedContainers === true,
            target.privilegedContainers,
          ),
          capability('Host networking', requirements?.hostNetwork === true, target.hostNetwork),
        ];
        const blockers = [
          ...(memoryStatus === 'insufficient'
            ? ['Target memory is below the calculated minimum']
            : []),
          ...(storageStatus === 'insufficient'
            ? ['Target free storage is below the calculated minimum']
            : []),
          ...capabilities
            .filter((check) => check.status === 'block')
            .map((check) => `${check.name} does not satisfy the selected graph`),
          ...(memoryStatus === 'unknown' ? ['Target memory probe is unavailable'] : []),
          ...(storageStatus === 'unknown' ? ['Target free-storage probe is unavailable'] : []),
          ...capabilities
            .filter((check) => check.status === 'unknown' && check.required)
            .map((check) => `${check.name} has not been probed on the target`),
        ];
        const statuses = [memoryStatus, storageStatus];
        const status = blockers.some(
          (blocker) => blocker.includes('below') || blocker.includes('does not'),
        )
          ? 'insufficient'
          : blockers.length > 0
            ? 'unknown'
            : statuses.includes('minimum-only')
              ? 'minimum-only'
              : 'recommended';
        return {
          siteId: target.siteId,
          siteName: target.siteName,
          status: status as 'recommended' | 'minimum-only' | 'insufficient' | 'unknown',
          ready: status === 'recommended' || status === 'minimum-only',
          observedAt: target.observedAt,
          memory: {
            availableBytes: target.memoryBytes,
            minimumBytes: minimumMemoryBytes,
            recommendedBytes: recommendedMemoryBytes,
            status: memoryStatus,
          },
          storage: {
            availableBytes: target.freeStorageBytes,
            minimumBytes: minimumStorageBytes,
            recommendedBytes: recommendedStorageBytes,
            status: storageStatus,
          },
          capabilities,
          blockers,
        };
      })()
    : null;
  const confidenceCounts = contributors.reduce(
    (counts, contributor) => {
      const confidence =
        contributor.confidence === 'estimated' ? 'default' : contributor.confidence;
      counts[confidence] += 1;
      return counts;
    },
    { measured: 0, declared: 0, default: 0, unknown: 0 },
  );
  return {
    id: sortableId('capacity'),
    fleetId: input.fleetId,
    selectedAppIds: [...new Set(input.components.map((component) => component.appId))].sort(),
    minimumMemoryBytes,
    recommendedMemoryBytes,
    minimumStorageBytes,
    recommendedStorageBytes,
    contributors,
    confidence: weakestConfidence(quantities),
    unknowns,
    assumptions: {
      tripHorizonDays: input.tripHorizonDays,
      offlineBuilds: input.offlineBuilds,
      buildsSerialized: true,
      memoryHeadroomRatio: input.memoryHeadroomRatio ?? 0.2,
      storageSafetyFloorBytes: storageFloor,
    },
    evidenceSummary: {
      ...confidenceCounts,
      observationWindow: input.evidenceWindow || null,
    },
    targetComparison,
    createdAt: new Date().toISOString(),
  };
}

export function persistSuitcaseCapacityPlan(plan: SuitcaseCapacityPlan): void {
  getSqlite()!
    .prepare(
      `INSERT INTO suitcase_capacity_plans
        (id, fleet_id, selected_app_ids, assumptions, minimum_memory_bytes,
         recommended_memory_bytes, minimum_storage_bytes, recommended_storage_bytes,
         contributors, confidence, unknowns, measured_result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      plan.id,
      plan.fleetId,
      JSON.stringify(plan.selectedAppIds),
      JSON.stringify(plan.assumptions),
      plan.minimumMemoryBytes,
      plan.recommendedMemoryBytes,
      plan.minimumStorageBytes,
      plan.recommendedStorageBytes,
      JSON.stringify(plan.contributors),
      plan.confidence,
      JSON.stringify(plan.unknowns),
      JSON.stringify({
        evidenceSummary: plan.evidenceSummary,
        targetComparison: plan.targetComparison,
      }),
      plan.createdAt,
    );
}
