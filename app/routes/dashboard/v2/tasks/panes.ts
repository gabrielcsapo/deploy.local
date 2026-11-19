/** What sits beside a task's chat: its details, changes, checks or browser. */
export type TaskPane = 'details' | 'changes' | 'checks' | 'browser';
/** What fills the main column: the chat, the design review, or the wide changes view. */
export type TaskMain = 'chat' | 'design' | 'full';

export function taskPaneFromPath(pathname: string): { pane: TaskPane | null; main: TaskMain } {
  const rest = pathname.split('/').slice(4).join('/').replace(/\/$/, '');
  if (rest === 'changes/full') return { pane: null, main: 'full' };
  if (rest === 'design') return { pane: null, main: 'design' };
  if (rest === 'changes' || rest === 'checks' || rest === 'browser')
    return { pane: rest, main: 'chat' };
  return { pane: null, main: 'chat' };
}

/** The first line of a pull request's description, as plain text for a one-line row. */
export function descriptionSummary(body?: string) {
  const line = (body || '')
    .split('\n')
    .map((text) =>
      text
        .replace(/^#+\s*|^[-*>]\s+|^\d+\.\s+/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`]/g, '')
        .trim(),
    )
    .find(Boolean);
  return line || '';
}
