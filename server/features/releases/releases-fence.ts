import { AsyncLocalStorage } from 'node:async_hooks';
import { db, id, list, save } from '../../workspace/store.ts';
import { fail } from '../../kernel/errors.ts';

const operation = new AsyncLocalStorage<string>();
export const withinProjectRelease = <T>(operationId: string, work: () => T): T =>
  operation.run(operationId, work);

export function releaseReservationBusy(message: string): never {
  throw Object.assign(new Error(message), { status: 409, code: 'release-reservation-busy' });
}

export function assertApplicationReleaseIdle(owner: string, application: string) {
  if (list('v2-project-run', owner).some((run) => run.apps.includes(application)))
    releaseReservationBusy('A project release or rollback is already running');
}

export function assertReleaseMutation(application: string) {
  const rows = db.prepare("SELECT data FROM records WHERE kind='v2-project-run'").all() as {
    data: string;
  }[];
  if (
    rows.some(({ data }) => {
      const run = JSON.parse(data);
      return run.apps.includes(application) && run.operationId !== operation.getStore();
    })
  )
    releaseReservationBusy('A project release or rollback is running; try again after it finishes');
}
export function assertNoApplicationMutations(owner: string, applications: string[]) {
  if (
    list('v2-app-mutation', owner).some((mutation) => applications.includes(mutation.application))
  )
    fail('An app is being changed; try the project release again after it finishes', 409);
}
export function beginApplicationMutation(owner: string, application: string) {
  const mutation = { id: id(), application, pid: process.pid };
  db.transaction(() => {
    assertReleaseMutation(application);
    save('v2-app-mutation', owner, mutation);
  }).immediate();
  return () =>
    db
      .prepare("DELETE FROM records WHERE kind='v2-app-mutation' AND owner=? AND id=?")
      .run(owner, mutation.id);
}
export function clearInterruptedMutations() {
  const rows = db
    .prepare("SELECT owner,id,data FROM records WHERE kind='v2-app-mutation'")
    .all() as { owner: string; id: string; data: string }[];
  for (const row of rows) {
    try {
      process.kill(JSON.parse(row.data).pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH')
        db.prepare("DELETE FROM records WHERE kind='v2-app-mutation' AND owner=? AND id=?").run(
          row.owner,
          row.id,
        );
    }
  }
}
