import type { CatalogInstallation, CatalogOperation, CatalogRecoveryPoint } from './types.ts';

export interface CatalogStoreTransaction {
  getInstallation(id: string): CatalogInstallation | undefined;
  getInstallationByApplication(applicationName: string): CatalogInstallation | undefined;
  listInstallations(): CatalogInstallation[];
  putInstallation(installation: CatalogInstallation, expectedRevision: number | null): void;
  deleteInstallation(id: string, expectedRevision: number): void;
  getOperation(id: string): CatalogOperation | undefined;
  listOperations(installationId: string): CatalogOperation[];
  putOperation(operation: CatalogOperation, expectAbsent?: boolean): void;
  getRecoveryPoint(id: string): CatalogRecoveryPoint | undefined;
  listRecoveryPoints(installationId: string): CatalogRecoveryPoint[];
  putRecoveryPoint(recoveryPoint: CatalogRecoveryPoint, expectAbsent?: boolean): void;
}

export interface CatalogTransactionalStore {
  read<T>(operation: (transaction: CatalogStoreTransaction) => T): T;
  transaction<T>(operation: (transaction: CatalogStoreTransaction) => T): T;
}

export class CatalogStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogStoreConflictError';
  }
}

export class InMemoryCatalogStore implements CatalogTransactionalStore {
  #installations = new Map<string, CatalogInstallation>();
  #operations = new Map<string, CatalogOperation>();
  #recoveryPoints = new Map<string, CatalogRecoveryPoint>();

  read<T>(operation: (transaction: CatalogStoreTransaction) => T): T {
    return operation(
      transactionView(
        cloneMap(this.#installations),
        cloneMap(this.#operations),
        cloneMap(this.#recoveryPoints),
      ),
    );
  }

  transaction<T>(operation: (transaction: CatalogStoreTransaction) => T): T {
    const installations = cloneMap(this.#installations);
    const operations = cloneMap(this.#operations);
    const recoveryPoints = cloneMap(this.#recoveryPoints);
    const result = operation(transactionView(installations, operations, recoveryPoints));
    this.#installations = installations;
    this.#operations = operations;
    this.#recoveryPoints = recoveryPoints;
    return result;
  }
}

function transactionView(
  installations: Map<string, CatalogInstallation>,
  operations: Map<string, CatalogOperation>,
  recoveryPoints: Map<string, CatalogRecoveryPoint>,
): CatalogStoreTransaction {
  return {
    getInstallation(id) {
      const installation = installations.get(id);
      return installation ? structuredClone(installation) : undefined;
    },
    getInstallationByApplication(applicationName) {
      const installation = [...installations.values()].find(
        (candidate) => candidate.applicationName === applicationName,
      );
      return installation ? structuredClone(installation) : undefined;
    },
    listInstallations() {
      return [...installations.values()].map((installation) => structuredClone(installation));
    },
    putInstallation(installation, expectedRevision) {
      const current = installations.get(installation.id);
      if (expectedRevision === null && current) {
        throw new CatalogStoreConflictError(`Installation ${installation.id} already exists`);
      }
      if (expectedRevision !== null && current?.revision !== expectedRevision) {
        throw new CatalogStoreConflictError(
          `Installation ${installation.id} revision changed; expected ${expectedRevision}, found ${current?.revision ?? 'missing'}`,
        );
      }
      installations.set(installation.id, structuredClone(installation));
    },
    deleteInstallation(id, expectedRevision) {
      const current = installations.get(id);
      if (current?.revision !== expectedRevision) {
        throw new CatalogStoreConflictError(
          `Installation ${id} revision changed; expected ${expectedRevision}, found ${current?.revision ?? 'missing'}`,
        );
      }
      installations.delete(id);
    },
    getOperation(id) {
      const operation = operations.get(id);
      return operation ? structuredClone(operation) : undefined;
    },
    listOperations(installationId) {
      return [...operations.values()]
        .filter((operation) => operation.installationId === installationId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((operation) => structuredClone(operation));
    },
    putOperation(operation, expectAbsent = false) {
      if (expectAbsent && operations.has(operation.id)) {
        throw new CatalogStoreConflictError(`Catalog operation ${operation.id} already exists`);
      }
      operations.set(operation.id, structuredClone(operation));
    },
    getRecoveryPoint(id) {
      const recoveryPoint = recoveryPoints.get(id);
      return recoveryPoint ? structuredClone(recoveryPoint) : undefined;
    },
    listRecoveryPoints(installationId) {
      return [...recoveryPoints.values()]
        .filter((recoveryPoint) => recoveryPoint.installationId === installationId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((recoveryPoint) => structuredClone(recoveryPoint));
    },
    putRecoveryPoint(recoveryPoint, expectAbsent = false) {
      if (expectAbsent && recoveryPoints.has(recoveryPoint.id)) {
        throw new CatalogStoreConflictError(
          `Catalog recovery point ${recoveryPoint.id} already exists`,
        );
      }
      recoveryPoints.set(recoveryPoint.id, structuredClone(recoveryPoint));
    },
  };
}

function cloneMap<T>(source: Map<string, T>): Map<string, T> {
  return new Map([...source.entries()].map(([id, value]) => [id, structuredClone(value)]));
}
