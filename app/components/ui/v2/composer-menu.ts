/**
 * Where a composer menu goes. "start" and "end" open below the control (above it when there is
 * more room there), lined up with its left or right edge; "side" is a submenu, beside its row
 * (right when it fits, otherwise left), its foot level with the row's.
 */
export type MenuPlacement = 'start' | 'end' | 'side';
type Box = { left: number; top: number; right: number; bottom: number; width: number };

export function menuPosition(
  anchor: Box,
  menu: { width: number; height: number },
  viewport: { left: number; top: number; width: number; height: number },
  placement: MenuPlacement,
  gap = 6,
) {
  const right = viewport.left + viewport.width;
  const bottom = viewport.top + viewport.height;
  const clampLeft = (left: number) => Math.max(viewport.left, Math.min(left, right - menu.width));
  if (placement === 'side') {
    const fits = anchor.right + 4 + menu.width <= right;
    const left = clampLeft(fits ? anchor.right + 4 : anchor.left - 4 - menu.width);
    const maxHeight = viewport.height;
    const top = Math.max(
      viewport.top,
      Math.min(anchor.bottom + 5 - Math.min(menu.height, maxHeight), bottom - menu.height),
    );
    return { left, top, maxHeight };
  }
  const below = Math.max(0, bottom - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - viewport.top - gap);
  const up = menu.height > below && above > below;
  const maxHeight = up ? above : below;
  const left = clampLeft(placement === 'end' ? anchor.right - menu.width : anchor.left);
  const top = up
    ? Math.max(viewport.top, anchor.top - gap - Math.min(menu.height, maxHeight))
    : anchor.bottom + gap;
  return { left, top, maxHeight };
}
