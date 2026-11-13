// Raise only when the bootstrap contract or the Node runtime required by code changes.
export const LAUNCHER_PROTOCOL = 1;
export function acceptsLauncher(required, available) {
  return Number.isSafeInteger(required) && required > 0 && required === available;
}
