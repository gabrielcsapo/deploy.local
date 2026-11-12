export type ChipOption = { value: string; label: string };
export type ChoiceState = { open: boolean; active: number };
export type ChoiceKeyResult = ChoiceState & {
  handled: boolean;
  selected?: string;
  restoreFocus?: boolean;
};

export function choiceIndex(options: readonly ChipOption[], value: string) {
  const index = options.findIndex((option) => option.value === value);
  return index < 0 ? (options.length ? 0 : -1) : index;
}

/** Navigation changes the active option; only a selection changes the saved value. */
export function choiceKey(
  state: ChoiceState,
  key: string,
  options: readonly ChipOption[],
  value: string,
  disabled = false,
): ChoiceKeyResult {
  const result = { ...state, handled: false };
  if (disabled || !options.length) return result;
  if (!state.open) {
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(key))
      return { open: true, active: choiceIndex(options, value), handled: true };
    return result;
  }
  if (key === 'Escape' || key === 'Tab')
    return { ...state, open: false, handled: key === 'Escape', restoreFocus: true };
  if (key === 'Enter' || key === ' ')
    return {
      ...state,
      open: false,
      handled: true,
      selected: options[state.active]?.value,
      restoreFocus: true,
    };
  let active = state.active;
  if (key === 'ArrowDown') active = (active + 1) % options.length;
  else if (key === 'ArrowUp') active = (active - 1 + options.length) % options.length;
  else if (key === 'Home') active = 0;
  else if (key === 'End') active = options.length - 1;
  else if (key.length === 1) {
    // Repeating a letter cycles through all choices beginning with that letter.
    for (let step = 1; step <= options.length; step++) {
      const index = (active + step) % options.length;
      if (options[index].label.toLocaleLowerCase().startsWith(key.toLocaleLowerCase())) {
        active = index;
        break;
      }
    }
  } else return result;
  return { open: true, active, handled: true };
}

/** Fixed top-layer coordinates, clamped to the visual viewport. */
export function choicePosition(
  anchor: { left: number; top: number; bottom: number; width: number },
  menu: { width: number; height: number },
  viewport: { left: number; top: number; width: number; height: number },
) {
  const right = viewport.left + viewport.width;
  const bottom = viewport.top + viewport.height;
  const below = Math.max(0, bottom - anchor.bottom);
  const above = Math.max(0, anchor.top - viewport.top);
  const up = menu.height > below && above > below;
  const maxHeight = up ? above : below;
  const width = Math.min(Math.max(anchor.width, menu.width), viewport.width);
  return {
    left: Math.max(viewport.left, Math.min(anchor.left, right - width)),
    top: up
      ? Math.max(viewport.top, anchor.top - Math.min(menu.height, maxHeight))
      : Math.max(viewport.top, Math.min(anchor.bottom, bottom)),
    width,
    maxHeight,
  };
}
