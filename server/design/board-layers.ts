// What became of each layer ID main's board has and the branch's does not. Comments and pins on
// deploy.local point at layer IDs, so an ID on main has to survive while its element does. An
// element the branch still draws (the same markup, or the same tag with the same words, or the
// same tag and class in the same place) kept its ID, lost it, or took a new one; only an element
// that is gone took its ID with it.
import { boardElements } from './board-html.ts';

export type LayerFate =
  /** The element is still drawn, with no ID now. */
  | { layer: string; fate: 'lost' }
  /** The element is still drawn, under another ID. */
  | { layer: string; fate: 'renamed'; to: string }
  /** No element in the branch draws what it drew. */
  | { layer: string; fate: 'removed' };

const tagOf = (outer: string) => /^<([a-zA-Z][\w:-]*)/.exec(outer)?.[1]?.toLowerCase() ?? '';
const classOf = (outer: string) =>
  (/^<[^>]*\sclass="([^"]*)"/.exec(outer)?.[1] ?? '').trim().split(/\s+/).sort().join(' ');
const words = (outer: string) =>
  outer
    .replace(/<(svg|style|script)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
/** Markup without layer IDs or formatting: the same element gives the same text. */
const signature = (outer: string) =>
  outer
    .replace(/\sdata-layer="[^"]*"/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Each of main's IDs the branch no longer has, and what became of it. Matching goes from the
 * surest to the loosest, and a branch element answers for one of main's IDs at most.
 */
export function layerFates(main: string | null, branch: string | null): LayerFate[] {
  if (!main || !branch) return [];
  const mainElements = boardElements(main);
  const branchElements = boardElements(branch);
  const branchIds = new Set(branchElements.map((element) => element.layer).filter(Boolean));
  const mainIds = new Set(mainElements.map((element) => element.layer).filter(Boolean));
  const gone = mainElements
    .map((element, index) => ({ ...element, index }))
    .filter((element) => element.layer && !branchIds.has(element.layer));
  if (!gone.length) return [];
  // Branch elements that could be one of them: no ID, or an ID main does not have.
  const free = branchElements
    .map((element, index) => ({ ...element, index }))
    .filter((element) => !element.layer || !mainIds.has(element.layer));
  const taken = new Set<number>();
  const fates = new Map<string, LayerFate>();
  // Where an element sits: its nearest ancestor with an ID both boards share, and its place
  // among that ancestor's descendants of the same tag.
  const place = (elements: typeof mainElements, index: number) => {
    let parent = elements[index].parent;
    while (parent >= 0 && !(elements[parent].layer && branchIds.has(elements[parent].layer!)))
      parent = elements[parent].parent;
    const anchor = parent >= 0 ? elements[parent].layer : '';
    const tag = tagOf(elements[index].outer);
    let nth = 0;
    for (let at = parent + 1; at < index; at++) {
      let up = elements[at].parent;
      while (up > parent) up = elements[up].parent;
      if (up === parent && tagOf(elements[at].outer) === tag) nth++;
    }
    return `${anchor} ${tag} ${nth}`;
  };
  const passes: ((a: (typeof gone)[number], b: (typeof free)[number]) => boolean)[] = [
    (a, b) => signature(a.outer) === signature(b.outer),
    (a, b) => {
      const text = words(a.outer);
      return Boolean(text) && tagOf(a.outer) === tagOf(b.outer) && text === words(b.outer);
    },
    (a, b) =>
      tagOf(a.outer) === tagOf(b.outer) &&
      classOf(a.outer) === classOf(b.outer) &&
      place(mainElements, a.index) === place(branchElements, b.index),
  ];
  for (const same of passes)
    for (const element of gone) {
      if (fates.has(element.layer!)) continue;
      const match = free.find(
        (candidate) => !taken.has(candidate.index) && same(element, candidate),
      );
      if (!match) continue;
      taken.add(match.index);
      fates.set(
        element.layer!,
        match.layer
          ? { layer: element.layer!, fate: 'renamed', to: match.layer }
          : { layer: element.layer!, fate: 'lost' },
      );
    }
  return gone.map(
    (element) => fates.get(element.layer!) ?? { layer: element.layer!, fate: 'removed' },
  );
}
