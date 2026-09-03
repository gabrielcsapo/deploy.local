import type Database from 'better-sqlite3';
import { getSqlite } from '../store.ts';
import { CatalogStoreConflictError, type CatalogStoreTransaction } from './store.ts';
import type { CatalogInstallation, CatalogOperation, CatalogRecoveryPoint } from './types.ts';

type Sqlite = InstanceType<typeof Database>;

/** SQLite-backed catalog state. Application manifests remain in the ordinary revision tables. */
export class DurableCatalogStore {
  read<T>(operation: (transaction: CatalogStoreTransaction) => T): T {
    return operation(view(sqlite()));
  }

  transaction<T>(operation: (transaction: CatalogStoreTransaction) => T): T {
    return sqlite()
      .transaction(() => operation(view(sqlite())))
      .immediate();
  }
}

function sqlite(): Sqlite {
  const connection = getSqlite();
  if (!connection) throw new Error('Catalog database is unavailable');
  return connection;
}

function view(db: Sqlite): CatalogStoreTransaction {
  return {
    getInstallation(id) {
      return installation(db.prepare('SELECT * FROM catalog_installations WHERE id = ?').get(id));
    },
    getInstallationByApplication(applicationName) {
      return installation(
        db
          .prepare('SELECT * FROM catalog_installations WHERE application_name = ?')
          .get(applicationName),
      );
    },
    listInstallations() {
      return db
        .prepare('SELECT * FROM catalog_installations ORDER BY created_at, id')
        .all()
        .map(requiredInstallation);
    },
    putInstallation(value, expectedRevision) {
      if (expectedRevision === null) {
        try {
          db.prepare(
            `INSERT INTO catalog_installations (
              id, application_name, blueprint_id, release, blueprint_digest,
              installed_spec_digest, current_spec_digest, site_id, mode, status, revision,
              drifted_addresses, local_blueprint_id, last_operation_id, failure, data_retained,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(...installationValues(value));
        } catch (error) {
          if (String(error).includes('UNIQUE constraint failed')) {
            throw new CatalogStoreConflictError(
              `Catalog installation for ${value.applicationName} already exists`,
            );
          }
          throw error;
        }
        return;
      }
      const result = db
        .prepare(
          `UPDATE catalog_installations SET
            application_name = ?, blueprint_id = ?, release = ?, blueprint_digest = ?,
            installed_spec_digest = ?, current_spec_digest = ?, site_id = ?, mode = ?, status = ?,
            revision = ?, drifted_addresses = ?, local_blueprint_id = ?, last_operation_id = ?,
            failure = ?, data_retained = ?, created_at = ?, updated_at = ?
          WHERE id = ? AND revision = ?`,
        )
        .run(...installationValues(value).slice(1), value.id, expectedRevision);
      if (result.changes !== 1) {
        throw new CatalogStoreConflictError(
          `Installation ${value.id} revision changed; expected ${expectedRevision}`,
        );
      }
    },
    deleteInstallation(id, expectedRevision) {
      const result = db
        .prepare('DELETE FROM catalog_installations WHERE id = ? AND revision = ?')
        .run(id, expectedRevision);
      if (result.changes !== 1) {
        throw new CatalogStoreConflictError(
          `Installation ${id} revision changed; expected ${expectedRevision}`,
        );
      }
    },
    getOperation(id) {
      return catalogOperation(db.prepare('SELECT * FROM catalog_operations WHERE id = ?').get(id));
    },
    listOperations(installationId) {
      return db
        .prepare(
          'SELECT * FROM catalog_operations WHERE installation_id = ? ORDER BY created_at, id',
        )
        .all(installationId)
        .map(requiredOperation);
    },
    putOperation(value, expectAbsent = false) {
      const existing = db.prepare('SELECT id FROM catalog_operations WHERE id = ?').get(value.id);
      if (expectAbsent && existing) {
        throw new CatalogStoreConflictError(`Catalog operation ${value.id} already exists`);
      }
      db.prepare(
        `INSERT INTO catalog_operations (
          id, installation_id, application_name, operation, status, plan, attempt, actor,
          retain_data, recovery_point_id, error, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status, plan = excluded.plan, attempt = excluded.attempt,
          retain_data = excluded.retain_data, recovery_point_id = excluded.recovery_point_id,
          error = excluded.error, updated_at = excluded.updated_at,
          completed_at = excluded.completed_at`,
      ).run(
        value.id,
        value.installationId,
        value.applicationName,
        value.operation,
        value.status,
        JSON.stringify(value.plan),
        value.attempt,
        value.actor,
        optionalBoolean(value.retainData),
        value.recoveryPointId ?? null,
        value.error ?? null,
        value.createdAt,
        value.updatedAt,
        value.completedAt ?? null,
      );
    },
    getRecoveryPoint(id) {
      return recoveryPoint(
        db.prepare('SELECT * FROM catalog_recovery_points WHERE id = ?').get(id),
      );
    },
    listRecoveryPoints(installationId) {
      return db
        .prepare(
          'SELECT * FROM catalog_recovery_points WHERE installation_id = ? ORDER BY created_at, id',
        )
        .all(installationId)
        .map(requiredRecoveryPoint);
    },
    putRecoveryPoint(value, expectAbsent = false) {
      const existing = db
        .prepare('SELECT id FROM catalog_recovery_points WHERE id = ?')
        .get(value.id);
      if (expectAbsent && existing) {
        throw new CatalogStoreConflictError(`Catalog recovery point ${value.id} already exists`);
      }
      db.prepare(
        `INSERT INTO catalog_recovery_points (
          id, installation_id, application_name, site_id, release, spec_digest, status,
          artifact_reference, artifact_digest, verification, created_by, created_at, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status, artifact_reference = excluded.artifact_reference,
          artifact_digest = excluded.artifact_digest, verification = excluded.verification,
          verified_at = excluded.verified_at`,
      ).run(
        value.id,
        value.installationId,
        value.applicationName,
        value.siteId,
        value.release,
        value.specDigest,
        value.status,
        value.artifactReference ?? null,
        value.artifactDigest ?? null,
        value.verification ?? null,
        value.createdBy,
        value.createdAt,
        value.verifiedAt ?? null,
      );
    },
  };
}

function installationValues(value: CatalogInstallation): unknown[] {
  return [
    value.id,
    value.applicationName,
    value.blueprintId,
    value.release,
    value.blueprintDigest,
    value.installedSpecDigest,
    value.currentSpecDigest,
    value.siteId,
    value.mode,
    value.status,
    value.revision,
    JSON.stringify(value.driftedAddresses),
    value.localBlueprintId ?? null,
    value.lastOperationId ?? null,
    value.failure ?? null,
    optionalBoolean(value.dataRetained),
    value.createdAt,
    value.updatedAt,
  ];
}

function installation(value: unknown): CatalogInstallation | undefined {
  return value ? requiredInstallation(value) : undefined;
}

function requiredInstallation(value: unknown): CatalogInstallation {
  const row = value as Record<string, unknown>;
  return compact({
    id: String(row.id),
    applicationName: String(row.application_name),
    blueprintId: String(row.blueprint_id),
    release: String(row.release),
    blueprintDigest: String(row.blueprint_digest),
    installedSpecDigest: String(row.installed_spec_digest),
    currentSpecDigest: String(row.current_spec_digest),
    siteId: String(row.site_id),
    mode: String(row.mode) as CatalogInstallation['mode'],
    status: String(row.status) as CatalogInstallation['status'],
    revision: Number(row.revision),
    driftedAddresses: JSON.parse(String(row.drifted_addresses)) as string[],
    localBlueprintId: optionalString(row.local_blueprint_id),
    lastOperationId: optionalString(row.last_operation_id),
    failure: optionalString(row.failure),
    dataRetained: optionalBooleanValue(row.data_retained),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
}

function catalogOperation(value: unknown): CatalogOperation | undefined {
  return value ? requiredOperation(value) : undefined;
}

function requiredOperation(value: unknown): CatalogOperation {
  const row = value as Record<string, unknown>;
  return compact({
    id: String(row.id),
    installationId: String(row.installation_id),
    applicationName: String(row.application_name),
    operation: String(row.operation) as CatalogOperation['operation'],
    status: String(row.status) as CatalogOperation['status'],
    plan: JSON.parse(String(row.plan)) as CatalogOperation['plan'],
    attempt: Number(row.attempt),
    actor: String(row.actor),
    retainData: optionalBooleanValue(row.retain_data),
    recoveryPointId: optionalString(row.recovery_point_id),
    error: optionalString(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: optionalString(row.completed_at),
  });
}

function recoveryPoint(value: unknown): CatalogRecoveryPoint | undefined {
  return value ? requiredRecoveryPoint(value) : undefined;
}

function requiredRecoveryPoint(value: unknown): CatalogRecoveryPoint {
  const row = value as Record<string, unknown>;
  return compact({
    id: String(row.id),
    installationId: String(row.installation_id),
    applicationName: String(row.application_name),
    siteId: String(row.site_id),
    release: String(row.release),
    specDigest: String(row.spec_digest),
    status: String(row.status) as CatalogRecoveryPoint['status'],
    artifactReference: optionalString(row.artifact_reference),
    artifactDigest: optionalString(row.artifact_digest),
    verification: optionalString(row.verification),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    verifiedAt: optionalString(row.verified_at),
  });
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalBoolean(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

function optionalBooleanValue(value: unknown): boolean | undefined {
  return value === null || value === undefined ? undefined : Boolean(value);
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as T;
}
