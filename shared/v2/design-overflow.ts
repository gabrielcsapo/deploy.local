// What leaves a board sideways at 700 px, and the problem that makes. `deploy design check` measures
// on deploy.local (in the drawn page); `deploy design dev` measures in the open Design page (from
// the parent, in a hidden frame that runs no board script). Both use this one rule.

export type Overflow = { scrolls: boolean; cut: string | null };
export type CheckProblem = { file: string | null; label: string; detail: string; short: string };

/**
 * The first piece of text that leaves the page sideways, and whether the page scrolls. It runs in
 * the page (no argument) or from a parent on a same-origin frame's document, so it uses nothing
 * from outside itself.
 */
export function measureOverflow(doc: Document = document): Overflow {
  const view = doc.defaultView!;
  const width = doc.documentElement.clientWidth;
  const scrolls = doc.documentElement.scrollWidth > width + 1;
  let cut: string | null = null;
  for (const element of doc.body.querySelectorAll('*')) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || (rect.right <= width + 1 && rect.left >= -1)) continue;
    const own = [...element.childNodes]
      // 3 is a text node.
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!own) continue;
    const style = view.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    cut = own.slice(0, 40);
    break;
  }
  return { scrolls, cut };
}

/** Problems from drawing at 700: only what the branch made, not what main already had. */
export function overflowProblems(
  file: string,
  title: string,
  measured: { after: Overflow; before: Overflow | null } | undefined,
): CheckProblem[] {
  if (!measured) return [];
  const { after, before } = measured;
  if (after.cut && !(before && before.cut === after.cut))
    return [
      {
        file,
        label: `${title} is cut off at 700 px`,
        detail: `"${after.cut}" leaves the page`,
        short: 'cut off at 700 px',
      },
    ];
  if (after.scrolls && !before?.scrolls)
    return [
      {
        file,
        label: `${title} overflows at 700 px`,
        detail: 'the page scrolls sideways',
        short: 'overflows at 700 px',
      },
    ];
  return [];
}
