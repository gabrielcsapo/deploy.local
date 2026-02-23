import type { RouteMatch } from './types.js';

/**
 * Compare old and new route matches to determine which segments changed.
 * Returns segment keys that need re-rendering.
 */
export function diffSegments(
  oldMatches: RouteMatch[],
  newMatches: RouteMatch[],
): string[] {
  let divergeIndex = 0;

  for (let i = 0; i < Math.min(oldMatches.length, newMatches.length); i++) {
    if (
      oldMatches[i].route.id !== newMatches[i].route.id ||
      !paramsEqual(oldMatches[i].params, newMatches[i].params)
    ) {
      break;
    }
    divergeIndex = i + 1;
  }

  // All segments from divergeIndex onward in newMatches need re-rendering
  const changed: string[] = [];
  for (let i = divergeIndex; i < newMatches.length; i++) {
    changed.push(newMatches[i].segmentKey);
  }

  return changed;
}

function paramsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a[key] === b[key]);
}
