export const keptPath = '/dashboard/packages/kept';
export const keptEntryPath = (kind: string, name: string) =>
  `${keptPath}/${kind}/${encodeURIComponent(name)}`;
export const count = (value: number) => value.toLocaleString('en-US');
export function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const unit = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return `${Number((value / 1024 ** unit).toFixed(1))} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}
export function kindLabel(kind: string) {
  return kind === 'npm' ? 'npm only' : kind === 'cargo' ? 'Cargo only' : 'npm and Cargo';
}
export function toggleKind(current: string, clicked: string) {
  return current === 'all'
    ? clicked === 'npm'
      ? 'cargo'
      : 'npm'
    : current === clicked
      ? current
      : 'all';
}
export function changeQuery(current: URLSearchParams, key: string, value: string) {
  const next = new URLSearchParams(current);
  if (!value || ['all', 'any', 'size'].includes(value)) next.delete(key);
  else next.set(key, value);
  if (key !== 'page') next.delete('page');
  return next;
}
export function countLine(
  data: { packages: number; versions: number; bytes: number },
  idle: boolean,
) {
  return idle
    ? `${count(data.versions)} versions of ${count(data.packages)} packages · ${bytes(data.bytes)}`
    : `${count(data.packages)} packages · ${count(data.versions)} versions · ${bytes(data.bytes)}`;
}
export function removalNotice(data: { bytes: number; keptBytes: number }) {
  return `Removed ${bytes(data.bytes)}. ${bytes(data.keptBytes)} kept.`;
}
export const removalPromise =
  'Versions locked by a project on main or in a live release stay. Anything removed is fetched again the next time something installs it.';
export function removalDescription(versions: number, packages: number, idle: boolean) {
  return `${count(versions)} versions of ${count(packages)} packages and crates ${idle ? 'that nothing has installed in 30 days' : 'that no project needs'}.`;
}

export function projectNames(names: string[]) {
  return names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names.at(-1);
}
