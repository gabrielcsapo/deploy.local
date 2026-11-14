import type { Database } from '../server/sqlite.ts';

/**
 * Call only after the application's existing stores have opened. This function neither opens
 * a database nor writes records. Use the same file on main and the branch: all runtime imports
 * are compatibility paths that already exist on main. Returns deterministic JSON Lines.
 *
 * // In an already initialized process (both stores open):
 * const { db } = await import('./server/workspace/store.ts');
 * const { dumpComputerRoles } = await import('./scripts/dump-computer-roles.ts');
 * console.log(await dumpComputerRoles(db));
 */
export async function dumpComputerRoles(db: Database): Promise<string> {
  const { deployRoleEnabled } = await import('../server/store/nodes.ts');
  const { workerComputerId, workerRoleEnabled, workerRole } =
    await import('../server/workspace/computer-role-policy.ts');
  const owners = db.prepare('SELECT DISTINCT owner FROM records ORDER BY owner').all() as {
    owner: string;
  }[];
  const local = !!db.prepare("SELECT id FROM worker WHERE id='local'").get();
  const rows: string[] = [];
  for (const { owner } of owners) {
    const workers = new Set<string>(local ? ['local'] : []);
    for (const { id } of db
      .prepare(
        "SELECT DISTINCT id FROM records WHERE owner=? AND kind IN ('worker','managed-worker') ORDER BY id",
      )
      .all(owner) as { id: string }[])
      workers.add(id);
    for (const workerId of [...workers].sort()) {
      rows.push(
        JSON.stringify({
          owner,
          workerId,
          computerId: workerComputerId(owner, workerId),
          deployAdmission: deployRoleEnabled(workerComputerId(owner, workerId)),
          preferences: Object.fromEntries(
            (['deploy', 'tasks', 'computer', 'browser'] as const).map((role) => [
              role,
              workerRoleEnabled(owner, workerId, role),
            ]),
          ),
          roles: Object.fromEntries(
            (['coordinator', 'take-tasks', 'run-apps', 'serve-models', 'use-screen'] as const).map(
              (role) => [role, workerRole(owner, workerId, role)],
            ),
          ),
        }),
      );
    }
  }
  return rows.join('\n');
}
