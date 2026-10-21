import tokens from '../../design-tokens.json';

/** Device-local layout preferences never create a third Activity state. */
export function activityMode(saved: unknown): 'open' | 'closed' {
  return saved === 'open' ? 'open' : 'closed';
}

export function taskCardWidth(
  paneWidth: number,
  readingWidth = tokens.size.readingWidth,
): number | null {
  const margin = (paneWidth - readingWidth) / 2;
  return margin >= 240 ? Math.min(tokens.size.popover, margin - tokens.size.workspaceInset) : null;
}

export function composerActivityVisible(
  cardVisible: boolean,
  mode: string,
  running: number,
  failing: number,
): boolean {
  return !cardVisible && mode === 'closed' && (running > 0 || failing > 0);
}
