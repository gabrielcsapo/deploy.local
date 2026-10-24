/** Only a leading exclamation mark opts into shell execution. */
export function shellMode(draft: string) {
  return draft.startsWith('!');
}
export function shellCommandText(draft: string) {
  return shellMode(draft) ? draft.slice(1).trim() : null;
}
