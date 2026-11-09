export type CompareMode = 'slider' | 'onion';
export const compareModeKey = 'deploy.design.compareMode';
export const compareMode = (value: string | null): CompareMode =>
  value === 'onion' ? 'onion' : 'slider';
const changed = 'deploy:design-compare';
let memoryMode: CompareMode | undefined;

export function savedCompareMode(fallback: CompareMode = 'slider'): CompareMode {
  try {
    const saved = localStorage.getItem(compareModeKey);
    return memoryMode ?? (saved === null ? fallback : compareMode(saved));
  } catch {
    return memoryMode ?? fallback;
  }
}

export function saveCompareMode(value: CompareMode) {
  memoryMode = value;
  try {
    localStorage.setItem(compareModeKey, value);
    memoryMode = undefined;
  } catch {
    /* Keep the choice in memory if storage is unavailable. */
  }
  window.dispatchEvent(new Event(changed));
}

export function subscribeCompareMode(update: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === compareModeKey || event.key === null) {
      memoryMode = undefined;
      update();
    }
  };
  window.addEventListener('storage', storage);
  window.addEventListener(changed, update);
  return () => {
    window.removeEventListener('storage', storage);
    window.removeEventListener(changed, update);
  };
}

export const clampPercent = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
export const afterAt = (x: number, left: number, width: number) =>
  width > 0 ? clampPercent(100 * (1 - (x - left) / width)) : 50;

/** The divider moves left as the amount of After increases. */
export function compareKey(value: number, key: string): number | undefined {
  if (key === 'Home') return 0;
  if (key === 'End') return 100;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return clampPercent(value + 1);
  if (key === 'ArrowRight' || key === 'ArrowDown') return clampPercent(value - 1);
}
