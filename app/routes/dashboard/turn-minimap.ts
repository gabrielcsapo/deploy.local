/** `excerpt` labels the tick; `prompt` and `reply` fill the hover preview. */
export type TranscriptTurn = { id: string; excerpt: string; prompt: string; reply: string };

/** Markdown reduced to one line of readable text for previews. */
export function plainExcerpt(text: unknown, length: number) {
  const plain = String(text ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > length ? `${plain.slice(0, length - 1).trimEnd()}…` : plain;
}

/** Ticks within this many rows of the pointer grow, the closest the most (a Dock-style lens). */
export const MAGNIFY_REACH = 2.5;
export function tickMagnification(index: number, pointer: number | null) {
  if (pointer === null) return 0;
  return Math.max(0, 1 - Math.abs(index - pointer) / MAGNIFY_REACH);
}
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
