export type TranscriptTurn = { id: string; excerpt: string };
export function showTurnMinimap(turns: readonly TranscriptTurn[], overflowing: boolean) {
  return turns.length >= 3 && overflowing;
}
export function jumpToTurn(
  element: Pick<HTMLElement, 'scrollIntoView'> | null,
  reducedMotion: boolean,
) {
  element?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'instant' : 'smooth' });
}
export function minimapKey(key: string, active: number, count: number) {
  if (!count) return undefined;
  if (key === 'ArrowDown' || key === 'ArrowRight') return (active + 1) % count;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return (active + count - 1) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return undefined;
}
