import { namedDatabase } from './named-store.ts';

/** Feature-owned serialization and SQL, called at the same point as the generic write. */
type RecordAdapter = {
  immediate?: boolean;
  encode?(owner: string, row: any): any;
  decode?(row: any): any;
  get?(owner: string, recordId: string): any;
  list?(owner: string): any[];
};

export function createRecordStore(name: string) {
  const adapters = new Map<string, RecordAdapter>();
  // Views subscribe at the persistence boundary so every API writer is covered.
  type RecordChange = (owner: string, kind: string, row: any, previous: any) => void;
  const recordObservers = new Map<string, Set<RecordChange>>();
  function onRecordChange(kinds: string[], listener: RecordChange) {
    for (const kind of kinds) {
      const listeners = recordObservers.get(kind) ?? new Set<RecordChange>();
      listeners.add(listener);
      recordObservers.set(kind, listeners);
    }
  }
  function previousObservedRecord(kind: string, owner: string, recordId: string) {
    if (!recordObservers.has(kind)) return undefined;
    const db = namedDatabase(name);
    const row = db
      .prepare('SELECT data FROM records WHERE kind=? AND owner=? AND id=?')
      .get(kind, owner, recordId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  function recordChanged(kind: string, owner: string, row: any, previous: any) {
    for (const listener of recordObservers.get(kind) ?? []) listener(owner, kind, row, previous);
  }

  function save(kind: string, owner: string, row: any) {
    const db = namedDatabase(name);
    const adapter = adapters.get(kind);
    const previous = previousObservedRecord(kind, owner, row.id);
    let observed = row;
    const write = () => {
      const stored = adapter?.encode ? adapter.encode(owner, row) : row;
      const data = JSON.stringify(stored);
      db.prepare(
        'INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id,owner) DO UPDATE SET data=excluded.data',
      ).run(kind, row.id, owner, data);
      // Compare persisted shapes, including fields omitted by JSON serialization.
      if (recordObservers.has(kind)) observed = JSON.parse(data);
    };
    if (adapter?.immediate) db.transaction(write).immediate();
    else write();
    recordChanged(kind, owner, observed, previous);
    return row;
  }
  function remove(kind: string, owner: string, recordId: string) {
    const db = namedDatabase(name);
    const previous = previousObservedRecord(kind, owner, recordId);
    db.prepare('DELETE FROM records WHERE kind=? AND owner=? AND id=?').run(kind, owner, recordId);
    recordChanged(kind, owner, undefined, previous);
  }
  function list(kind: string, owner: string): any[] {
    const adapter = adapters.get(kind);
    if (adapter?.list) return adapter.list(owner);
    const rows = namedDatabase(name)
      .prepare('SELECT data FROM records WHERE kind=? AND owner=? ORDER BY rowid')
      .all(kind, owner) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data));
  }
  function get(kind: string, owner: string, recordId: string): any {
    const adapter = adapters.get(kind);
    if (adapter?.get) return adapter.get(owner, recordId);
    const r = namedDatabase(name)
      .prepare('SELECT data FROM records WHERE kind=? AND owner=? AND id=?')
      .get(kind, owner, recordId) as { data: string } | undefined;
    if (!r) throw Object.assign(new Error('Not found'), { status: 404 });
    const row = JSON.parse(r.data);
    return adapter?.decode ? adapter.decode(row) : row;
  }
  return {
    save,
    get,
    list,
    remove,
    onRecordChange,
    registerAdapter(kind: string, adapter: RecordAdapter) {
      adapters.set(kind, adapter);
    },
  };
}

// Importing the store creates no connection or timer. Workspace bootstrap registers
// the handle and feature adapters before any existing caller uses these functions.
export const workspaceRecords = createRecordStore('workspace');
export const { save, get, list, remove, onRecordChange } = workspaceRecords;
