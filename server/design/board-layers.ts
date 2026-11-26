// What became of each layer ID main's board has and the branch's does not. Comments and pins on
// deploy.local point at layer IDs, so an ID on main has to survive while its element does. An
// element the branch still draws (the same markup, or the same tag with the same words, or the
// same tag and class in the same place) kept its ID, lost it, or took a new one; only an element
// that is gone took its ID with it.
import { matchLayers } from './board-html.ts';

export type LayerFate =
  /** The element is still drawn, with no ID now. */
  | { layer: string; fate: 'lost' }
  /** The element is still drawn, under another ID. */
  | { layer: string; fate: 'renamed'; to: string }
  /** No element in the branch draws what it drew. */
  | { layer: string; fate: 'removed' };

/**
 * Each of main's IDs the branch no longer has, and what became of it. Matching goes from the
 * surest to the loosest, and a branch element answers for one of main's IDs at most.
 */
export function layerFates(main: string | null, branch: string | null): LayerFate[] {
  if (!main || !branch) return [];
  return matchLayers(main, branch).map(({ layer, at, to }) =>
    at === null
      ? { layer, fate: 'removed' }
      : to
        ? { layer, fate: 'renamed', to }
        : { layer, fate: 'lost' },
  );
}
