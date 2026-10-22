/** Mutations share the title bar endpoint and fetch a current revision before each operation. */
export async function setSidebarTaskClosed(
  api: (path: string, body?: Record<string, unknown>) => Promise<any>,
  id: string,
  closed: boolean,
) {
  const latest = await api(`/tasks/${id}`);
  return api(`/tasks/${id}/${closed ? 'close' : 'reopen'}`, { revision: latest.task.revision });
}
export function sidebarRecentsCollapsed(storage: Pick<Storage, 'getItem'>, key: string) {
  try {
    return storage.getItem(key) === 'true';
  } catch {
    return false;
  }
}
export function writeSidebarPreference(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  value: unknown,
) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* Session state still works. */
  }
}
export function toggleTaskPin(pinned: readonly string[], id: string) {
  return pinned.includes(id) ? pinned.filter((value) => value !== id) : [...pinned, id];
}
